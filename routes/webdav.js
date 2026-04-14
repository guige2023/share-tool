// WebDAV server — ShareTool storage via WebDAV protocol
// Supports: OPTIONS, PROPFIND, GET, PUT, DELETE, MKCOL
// Files are stored in SQLite (ShareTool's native model), served via WebDAV

function xmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendDav(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body) res.end(body);
  else res.end();
}

function sendXml(res, status, xml) {
  res.writeHead(status, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'no-cache',
    'DAV': '1'
  });
  res.end(xml);
}

function formatMultistatus(items, basePath) {
  const responses = items.map(item => {
    const href = '/dav' + (basePath === '/' ? '' : basePath) + '/' + xmlEscape(item.filename);
    const isDir = item.content_type === 'folder' || item.isFolder;
    const size = item.size || 0;
    const ct = item.content_type || 'application/octet-stream';
    const created = new Date((item.created_at || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const modified = new Date((item.updated_at || Math.floor(Date.now() / 1000)) * 1000).toGMTString();

    return `<d:response>
<d:href>${href}</d:href>
<d:propstat>
<d:prop>
<d:displayname>${xmlEscape(item.filename)}</d:displayname>
<d:getcontentlength>${isDir ? 0 : size}</d:getcontentlength>
<d:getcontenttype>${isDir ? 'httpd/unix-directory' : xmlEscape(ct)}</d:getcontenttype>
<d:creationdate>${created}</d:creationdate>
<d:getlastmodified>${modified}</d:getlastmodified>
<d:resourcetype>${isDir ? '<d:collection/>' : ''}</d:resourcetype>
</d:prop>
<d:status>HTTP/1.1 200 OK</d:status>
</d:propstat>
</d:response>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
${responses}
</d:multistatus>`;
}

function parseDepth(header) {
  if (!header) return 1;
  if (header === '0') return 0;
  if (header === 'infinity') return 99;
  return 1;
}

async function readBody(req, maxBytes = 500 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) { reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleWebDAV(req, res, pathname, query, ctx) {
  if (!pathname.startsWith('/dav')) return false;
  const method = req.method;

  // OPTIONS — advertise WebDAV capabilities
  if (method === 'OPTIONS') {
    sendDav(res, 200, {
      'Allow': 'OPTIONS, PROPFIND, GET, PUT, DELETE, MKCOL, MOVE, COPY',
      'DAV': '1',
      'MS-Author-Via': 'DAV',
      'Content-Length': '0'
    }, null);
    return true;
  }

  // Auth check — WebDAV uses Basic Auth header
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ShareTool WebDAV"' });
    res.end();
    return true;
  }

  const db = require('../db');

  // Strip /dav prefix to get ShareTool path
  let relPath = pathname.replace(/^\/dav/, '') || '/';
  if (!relPath.startsWith('/')) relPath = '/' + relPath;

  // Normalize: / → root listing
  const isRoot = relPath === '/' || relPath === '';

  // PROPFIND — list directory
  if (method === 'PROPFIND') {
    const depth = parseDepth(req.headers['depth'] || '1');

    let items = [];

    if (isRoot) {
      // Root: list top-level files (no slash in filename) and virtual folders
      const files = db.prepare(`
        SELECT id, filename, size, content_type, created_at, updated_at
        FROM files WHERE deleted = 0 AND filename NOT LIKE '%/%'
        ORDER BY filename
      `).all();
      const folders = db.prepare(`
        SELECT name as filename, 'folder' as content_type, created_at, updated_at
        FROM virtual_folders ORDER BY name
      `).all();
      items = [...folders.map(f => ({ ...f, isFolder: true })), ...files];
    } else {
      // Strip trailing slash for prefix matching
      const prefix = relPath.endsWith('/') ? relPath.slice(0, -1) : relPath;
      // List immediate children
      const childPrefix = prefix + '/';
      const files = db.prepare(`
        SELECT id, filename, size, content_type, created_at, updated_at
        FROM files WHERE deleted = 0 AND filename LIKE ? AND filename NOT LIKE ?
        ORDER BY filename
      `).all(childPrefix + '%', childPrefix + '%/%');

      // Sub-folders at this level
      const folderPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
      const folders = db.prepare(`
        SELECT name as filename, 'folder' as content_type, created_at, updated_at
        FROM virtual_folders
        WHERE name LIKE ? AND name NOT LIKE ?
        ORDER BY name
      `).all(folderPrefix + '%', folderPrefix + '%/%');

      items = [...folders.map(f => ({ ...f, isFolder: true })), ...files];
    }

    // Depth 0: only return the requested resource itself
    if (depth === 0) {
      const self = db.prepare(`SELECT id, filename, size, content_type, created_at, updated_at FROM files WHERE filename = ? AND deleted = 0`).get(relPath);
      if (self) {
        items = [self];
      } else {
        const vf = db.prepare(`SELECT name as filename, 'folder' as content_type, created_at, updated_at FROM virtual_folders WHERE name = ?`).get(relPath);
        items = vf ? [{ ...vf, isFolder: true }] : [];
      }
    }

    sendXml(res, 207, formatMultistatus(items, relPath === '/' ? '/' : '/' + relPath));
    return true;
  }

  // GET — download file
  if (method === 'GET' || method === 'HEAD') {
    const file = db.prepare(`SELECT * FROM files WHERE filename = ? AND deleted = 0`).get(relPath);
    if (!file) {
      sendDav(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
      return true;
    }

    // Check if it's a virtual folder
    const vf = db.prepare(`SELECT name FROM virtual_folders WHERE name = ?`).get(relPath);
    if (vf) {
      // Directory listing as HTML
      const children = db.prepare(`
        SELECT filename, size, content_type FROM files
        WHERE filename LIKE ? AND filename NOT LIKE ? AND deleted = 0
        ORDER BY filename
      `).all(relPath + '/%', relPath + '/%/%');
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${xmlEscape(relPath)}</title></head>
<body><h1>Index of ${xmlEscape(relPath)}</h1><ul>${children.map(f =>
        `<li><a href="${xmlEscape(f.filename.replace(relPath + '/', ''))}">${xmlEscape(f.filename.replace(relPath + '/', ''))}</a> (${f.size} bytes)</li>`
      ).join('')}</ul></body></html>`;
      sendDav(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, html);
      return true;
    }

    // Serve file content
    const content = file.content ? Buffer.from(file.content, 'base64') : null;
    if (!content) {
      sendDav(res, 204, { 'Content-Type': 'text/plain' }, '');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': file.content_type || 'application/octet-stream',
      'Content-Length': content.length,
      'Content-Disposition': 'attachment; filename="' + xmlEscape(relPath.split('/').pop()) + '"',
      'ETag': '"' + file.hash + '"'
    });
    if (method === 'GET') res.end(content);
    else res.end();
    return true;
  }

  // PUT — upload / replace file
  if (method === 'PUT') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendDav(res, 413, { 'Content-Type': 'text/plain' }, 'Payload too large');
      return true;
    }

    const base64 = body.toString('base64');
    const hash = require('crypto').createHash('md5').update(body).digest('hex');
    const existing = db.prepare(`SELECT id FROM files WHERE filename = ? AND deleted = 0`).get(relPath);

    if (existing) {
      db.prepare(`UPDATE files SET content = ?, size = ?, hash = ?, updated_at = unixepoch() WHERE id = ?`)
        .run(base64, body.length, hash, existing.id);
    } else {
      // Create new file — need to determine position
      const maxPos = db.prepare(`SELECT COALESCE(MAX(position), -1) as m FROM files`).get().m;
      const contentType = detectMimeType(relPath);
      db.prepare(`INSERT INTO files (filename, content, size, hash, content_type, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`)
        .run(relPath, base64, body.length, hash, contentType, maxPos + 1);
    }

    sendDav(res, existing ? 204 : 201, {
      'Location': '/dav' + relPath,
      'Content-Length': '0'
    }, null);
    return true;
  }

  // DELETE — delete file
  if (method === 'DELETE') {
    const file = db.prepare(`SELECT id FROM files WHERE filename = ? AND deleted = 0`).get(relPath);
    if (file) {
      db.prepare(`UPDATE files SET deleted = 1, updated_at = unixepoch() WHERE id = ?`).run(file.id);
    }
    sendDav(res, 204, { 'Content-Length': '0' }, null);
    return true;
  }

  // MKCOL — create virtual folder
  if (method === 'MKCOL') {
    // Check if already exists
    const existing = db.prepare(`SELECT id FROM virtual_folders WHERE name = ?`).get(relPath);
    if (existing) {
      sendDav(res, 405, { 'Content-Type': 'text/plain' }, 'Folder already exists');
      return true;
    }
    // Ensure parent folder exists
    const parts = relPath.split('/').filter(Boolean);
    if (parts.length > 1) {
      const parent = '/' + parts.slice(0, -1).join('/');
      const parentVF = db.prepare(`SELECT id FROM virtual_folders WHERE name = ?`).get(parent);
      if (!parentVF) {
        sendDav(res, 409, { 'Content-Type': 'text/plain' }, 'Parent folder does not exist');
        return true;
      }
    }
    db.prepare(`INSERT INTO virtual_folders (name, created_at) VALUES (?, unixepoch())`).run(relPath);
    sendDav(res, 201, { 'Location': '/dav' + relPath, 'Content-Length': '0' }, null);
    return true;
  }

  return false;
}

function detectMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = {
    'html': 'text/html', 'htm': 'text/html', 'css': 'text/css', 'js': 'application/javascript',
    'json': 'application/json', 'xml': 'application/xml', 'txt': 'text/plain',
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif',
    'svg': 'image/svg+xml', 'webp': 'image/webp', 'ico': 'image/x-icon',
    'mp4': 'video/mp4', 'webm': 'video/webm', 'avi': 'video/x-msvideo',
    'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg', 'm4a': 'audio/mp4',
    'pdf': 'application/pdf', 'zip': 'application/zip', 'tar': 'application/x-tar',
    'gz': 'application/gzip', 'doc': 'application/msword', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint', 'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'woff': 'font/woff', 'woff2': 'font/woff2', 'ttf': 'font/ttf', 'eot': 'application/vnd.ms-fontobject',
    'csv': 'text/csv', 'md': 'text/markdown'
  };
  return types[ext] || 'application/octet-stream';
}

module.exports = { handleWebDAV };
