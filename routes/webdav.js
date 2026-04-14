// WebDAV server implementation for ShareTool
// Supports: PROPFIND, GET, PUT, DELETE, MKCOL, MOVE, COPY, OPTIONS
const path = require('path');
const fs = require('fs');
const { authRequired, sendJson } = require('./api');

const BASE_DIR = process.env.SHARE_TOOL_ROOT || '/Users/guige/share-tool-storage';

function xmlEscape(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getDavPath(reqPath) {
  // reqPath: /dav/ or /dav/folder/file.txt
  if (!reqPath.startsWith('/dav')) return null;
  let fp = reqPath.slice(4); // strip /dav
  if (!fp.startsWith('/')) fp = '/' + fp;
  if (fp === '/') return BASE_DIR;
  return path.join(BASE_DIR, fp);
}

function sendDav(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body) res.end(body);
  else res.end();
}

function sendXml(res, status, xml) {
  sendDav(res, status, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'no-cache',
    'DAV': '1'
  }, xml);
}

function formatDirListing(files, subPath) {
  // subPath: the path being listed, e.g. /dav/folder/
  const items = [];
  const now = Math.floor(Date.now() / 1000);

  for (const f of files) {
    // f: { filename, size, content_type, created_at, updated_at }
    const relPath = f.filename.startsWith('/') ? f.filename : '/' + f.filename;
    const href = '/dav' + relPath;
    const isDir = f.content_type === 'folder';
    const displayName = relPath.split('/').pop();

    items.push(`<d:response>
<d:href>${xmlEscape(href)}</d:href>
<d:propstat>
<d:prop>
<d:displayname>${xmlEscape(displayName)}</d:displayname>
<d:getcontentlength>${isDir ? 0 : (f.size || 0)}</d:getcontentlength>
<d:getcontenttype>${isDir ? 'httpd/unix-directory' : xmlEscape(f.content_type || 'application/octet-stream')}</d:getcontenttype>
<d:creationdate>${new Date((f.created_at || now) * 1000).toISOString()}</d:creationdate>
<d:getlastmodified>${new Date((f.updated_at || now) * 1000).toGMTString()}</d:getlastmodified>
<d:resourcetype>${isDir ? '<d:collection/>' : ''}</d:resourcetype>
</d:prop>
<d:status>HTTP/1.1 200 OK</d:status>
</d:propstat>
</d:response>`);
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:cs="http://calendarserver.org/ns">
${items.join('\n')}
</d:multistatus>`;
  return body;
}

function parseDepth(header) {
  if (!header) return 1;
  if (header === '0') return 0;
  if (header === 'infinity') return 99;
  return 1;
}

async function handleWebDAV(req, res, pathname) {
  // Only handle /dav/* paths
  if (!pathname.startsWith('/dav')) return false;

  // OPTIONS — advertise WebDAV support
  if (req.method === 'OPTIONS') {
    sendDav(res, 200, {
      'Allow': 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MOVE, COPY, MKCOL',
      'DAV': '1',
      'MS-Author-Via': 'DAV',
      'Content-Length': '0'
    }, null);
    return true;
  }

  // All WebDAV methods require auth
  const authUser = authRequired(req, res, true); // skipJson=true for WebDAV
  if (!authUser) return true;

  const method = req.method;
  const fp = getDavPath(pathname);
  if (!fp) return false;

  const db = require('../db');

  // PROPFIND — list directory
  if (method === 'PROPFIND' || method === 'PROPFIND') {
    // Read Depth header
    const depth = parseDepth(req.headers['depth'] || '1');
    // Read request body for props
    let body = '';
    try {
      body = await new Promise((resolve, reject) => {
        req.on('data', d => { body += d; });
        req.on('end', resolve);
        req.on('error', reject);
      });
    } catch (e) {}

    // Determine what path to list
    const isRoot = fp === BASE_DIR;
    let files = [];
    let virtualFolders = [];

    if (isRoot) {
      // List top-level files and folders
      files = db.prepare(`
        SELECT filename, size, content_type, created_at, updated_at
        FROM files WHERE deleted = 0 AND filename NOT LIKE '%/%'
        ORDER BY filename
      `).all();
      virtualFolders = db.prepare(`SELECT name as filename, 'folder' as content_type, created_at, updated_at FROM virtual_folders ORDER BY name`).all();
    } else {
      // List files within a virtual folder prefix
      const prefix = fp.slice(BASE_DIR.length);
      const folderPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
      files = db.prepare(`
        SELECT filename, size, content_type, created_at, updated_at
        FROM files WHERE deleted = 0 AND filename LIKE ? AND filename NOT LIKE ?
        ORDER BY filename
      `).all(folderPrefix + '%', folderPrefix + '%/%');
      // Also list sub-folders
      const subFolders = db.prepare(`SELECT name as filename, 'folder' as content_type, created_at, updated_at FROM virtual_folders WHERE name LIKE ? AND name NOT LIKE ? ORDER BY name`).all(folderPrefix + '%', folderPrefix + '%/%');
      virtualFolders = subFolders;
    }

    const allItems = [...virtualFolders.map(vf => ({
      ...vf,
      content_type: 'folder',
      filename: vf.filename
    })), ...files];

    // For depth=0, only return the requested resource itself
    let toShow = allItems;
    if (depth === 0) {
      // Check if requesting a single file
      const existing = allItems.find(f => {
        const itemPath = '/' + f.filename;
        return itemPath === pathname.replace('/dav', '') || '/' + f.filename === pathname.replace('/dav', '');
      });
      toShow = existing ? [existing] : [];
    }

    const xml = formatDirListing(toShow, pathname);
    sendXml(res, 207, xml);
    return true;
  }

  // GET — download file
  if (method === 'GET' || method === 'HEAD') {
    const relPath = pathname.replace('/dav', '');
    const file = db.getFileByName(relPath);
    if (!file || file.deleted) {
      sendDav(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
      return true;
    }
    const fullPath = path.join(BASE_DIR, relPath);
    if (!fs.existsSync(fullPath)) {
      sendDav(res, 404, { 'Content-Type': 'text/plain' }, 'File not on disk');
      return true;
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      // Return directory listing as HTML
      const files = fs.readdirSync(fullPath);
      const html = `<html><body><h1>Directory: ${xmlEscape(relPath)}</h1><ul>${files.map(f => `<li><a href="${xmlEscape(f)}">${xmlEscape(f)}</a></li>`).join('')}</ul></body></html>`;
      sendDav(res, 200, { 'Content-Type': 'text/html' }, html);
      return true;
    }
    const stream = fs.createReadStream(fullPath);
    res.writeHead(200, {
      'Content-Type': file.content_type || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': 'attachment; filename="' + path.basename(relPath) + '"'
    });
    stream.pipe(res);
    return true;
  }

  // PUT — upload/replace file
  if (method === 'PUT') {
    const relPath = pathname.replace('/dav', '');
    const fullPath = path.join(BASE_DIR, relPath);

    // Ensure parent directory exists
    const parent = path.dirname(fullPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }

    const chunks = [];
    let totalSize = 0;
    await new Promise((resolve, reject) => {
      req.on('data', chunk => {
        totalSize += chunk.length;
        chunks.push(chunk);
        if (totalSize > 200 * 1024 * 1024 * 1024) { // 200GB limit
          reject(new Error('File too large'));
        }
      });
      req.on('end', resolve);
      req.on('error', reject);
    });

    const content = Buffer.concat(chunks);
    const contentHash = require('crypto').createHash('sha256').update(content).digest('hex');

    const existing = db.getFileByName(relPath);
    if (existing) {
      db.updateFileByName(relPath, { content: content.toString('base64'), size: content.length, hash: contentHash });
    } else {
      db.addFile(relPath, content.toString('base64'), 'text', contentHash);
    }

    // Write to disk
    fs.writeFileSync(fullPath, content);
    sendDav(res, 201, { 'Location': pathname }, 'Created');
    return true;
  }

  // DELETE — delete file
  if (method === 'DELETE') {
    const relPath = pathname.replace('/dav', '');
    const fullPath = path.join(BASE_DIR, relPath);
    const existing = db.getFileByName(relPath);
    if (existing) {
      db.deleteFileByName(relPath);
    }
    if (fs.existsSync(fullPath)) {
      try { fs.unlinkSync(fullPath); } catch (e) {}
    }
    sendDav(res, 204, {}, null);
    return true;
  }

  // MKCOL — create folder
  if (method === 'MKCOL') {
    const relPath = pathname.replace('/dav', '');
    const fullPath = path.join(BASE_DIR, relPath);
    if (fs.existsSync(fullPath)) {
      sendDav(res, 405, { 'Content-Type': 'text/plain' }, 'Method Not Allowed');
      return true;
    }
    fs.mkdirSync(fullPath, { recursive: true });
    // Create virtual folder in DB
    const folderName = path.basename(relPath);
    db.createVirtualFolder(folderName);
    sendDav(res, 201, { 'Location': pathname }, 'Created');
    return true;
  }

  // MOVE — move/rename file
  if (method === 'MOVE') {
    const relPath = pathname.replace('/dav', '');
    const dest = req.headers['destination'];
    if (!dest) {
      sendDav(res, 400, { 'Content-Type': 'text/plain' }, 'Destination required');
      return true;
    }
    const destPath = dest.replace(/^\//, '').replace(/^dav\//, '');
    const fullSrc = path.join(BASE_DIR, relPath);
    const fullDest = path.join(BASE_DIR, destPath);

    const overwrite = req.headers['overwrite'] !== 'F';
    if (fs.existsSync(fullDest) && !overwrite) {
      sendDav(res, 412, { 'Content-Type': 'text/plain' }, 'Precondition Failed');
      return true;
    }

    if (fs.existsSync(fullSrc)) {
      fs.renameSync(fullSrc, fullDest);
    }
    db.renameFile(relPath, destPath);

    sendDav(res, 201, { 'Location': '/' + destPath }, 'Moved');
    return true;
  }

  // COPY — copy file
  if (method === 'COPY') {
    const relPath = pathname.replace('/dav', '');
    const dest = req.headers['destination'];
    if (!dest) {
      sendDav(res, 400, { 'Content-Type': 'text/plain' }, 'Destination required');
      return true;
    }
    const destPath = dest.replace(/^\//, '').replace(/^dav\//, '');
    const fullSrc = path.join(BASE_DIR, relPath);
    const fullDest = path.join(BASE_DIR, destPath);

    if (fs.existsSync(fullSrc)) {
      fs.copyFileSync(fullSrc, fullDest);
    }
    // Copy in DB
    const existing = db.getFileByName(relPath);
    if (existing) {
      const content = fs.existsSync(fullSrc) ? fs.readFileSync(fullSrc) : null;
      if (content) db.addFile(destPath, content.toString('base64'), existing.content_type, existing.hash);
    }

    sendDav(res, 201, { 'Location': '/' + destPath }, 'Copied');
    return true;
  }

  return false;
}

module.exports = { handleWebDAV };
