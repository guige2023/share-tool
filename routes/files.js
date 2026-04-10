/**
 * routes/files.js - File CRUD, upload, download, search, batch operations
 */

module.exports = function handleFileRoutes(req, res, pathname, query, ctx) {
  const { db, config, sendJson, authRequired, getClientIp, broadcastChange, getUploadMaxSize, getFileIcon, archiver, crypto } = ctx;
  const { method } = req;

  // GET /api/list
  if (pathname === '/api/list') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const limit = parseInt(query.limit) || 100;
    const offset = parseInt(query.offset) || 0;
    const sort = ['name', 'size', 'created_at', 'updated_at'].includes(query.sort) ? query.sort : 'created_at';
    const order = query.order === 'asc' ? 'ASC' : 'DESC';
    const folder = query.folder || null;
    const starred = query.starred === '1' || query.starred === 'true';
    const { files, total } = db.listFiles(limit, offset, sort, order, folder, starred);
    db.addAuditLog('list_files', `Total: ${total}, sort: ${sort} ${order}${folder ? ', folder: ' + folder : ''}${starred ? ', starred: true' : ''}`, getClientIp(req), authData.token);
    sendJson(res, { success: true, files: files.map(f => ({
      id: f.id, name: f.filename, size: f.size, time: f.created_at * 1000,
      updatedAt: f.updated_at * 1000,
      type: f.type, hash: f.hash, tags: f.tags, starred: f.starred
    }))});
    return true;
  }

  // POST /api/upload
  if (pathname === '/api/upload' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;

    const contentLength = parseInt(req.headers['content-length']) || 0;
    const maxSize = getUploadMaxSize();
    if (contentLength > maxSize) {
      sendJson(res, { success: false, error: `文件大小超过限制（最大 ${config.uploadMaxSizeMB || 100}MB）` }, 413);
      return true;
    }

    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filename, content, type, tags } = JSON.parse(body);
        if (content) {
          const actualSize = Buffer.byteLength(content, 'base64');
          if (actualSize > maxSize) {
            sendJson(res, { success: false, error: `文件大小超过限制（最大 ${config.uploadMaxSizeMB || 100}MB）` }, 413);
            return;
          }
        }
        const result = db.addFile(filename, content, type || 'file');
        if (result) {
          broadcastChange({ type: 'create', filename, hash: result.hash });
          db.addAuditLog('upload', filename, getClientIp(req), authData.token);
          sendJson(res, { success: true, filename, hash: result.hash });
        } else {
          sendJson(res, { success: false, error: 'Upload failed' }, 500);
        }
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/upload/init - 初始化分片上传
  if (pathname === '/api/upload/init' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filename, totalChunks, fileHash, size } = JSON.parse(body);
        if (!filename || !totalChunks) {
          sendJson(res, { success: false, error: 'filename and totalChunks required' }, 400);
          return;
        }
        const uploadId = crypto.randomBytes(8).toString('hex');
        db.initChunkUpload(uploadId, filename, totalChunks, fileHash || null, size || 0);
        db.addAuditLog('upload_init', `${filename} (${totalChunks} chunks)`, getClientIp(req), authData.token);
        sendJson(res, { success: true, uploadId });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/upload/chunk - 上传单个分片
  if (pathname === '/api/upload/chunk' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { uploadId, chunkIndex, content } = JSON.parse(body);
        if (!uploadId || chunkIndex === undefined || !content) {
          sendJson(res, { success: false, error: 'uploadId, chunkIndex, content required' }, 400);
          return;
        }
        const row = db.getChunkUpload(uploadId);
        if (!row) {
          sendJson(res, { success: false, error: 'Upload session not found' }, 404);
          return;
        }
        // 保存分片到临时文件
        const chunkDir = require('path').join(process.env.TMPDIR || '/tmp', 'sharetool-chunks', uploadId);
        require('fs').mkdirSync(chunkDir, { recursive: true });
        const chunkPath = require('path').join(chunkDir, `chunk_${chunkIndex}`);
        const chunkData = Buffer.from(content, 'base64');
        require('fs').writeFileSync(chunkPath, chunkData);
        // 更新已接收分片列表
        const received = db.addChunkReceived(uploadId, chunkIndex);
        sendJson(res, { success: true, received: received.length, total: row.total_chunks });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/upload/complete - 完成分片上传
  if (pathname === '/api/upload/complete' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { uploadId } = JSON.parse(body);
        if (!uploadId) {
          sendJson(res, { success: false, error: 'uploadId required' }, 400);
          return;
        }
        const row = db.getChunkUpload(uploadId);
        if (!row) {
          sendJson(res, { success: false, error: 'Upload session not found' }, 404);
          return;
        }
        const status = db.getChunkUploadStatus(uploadId);
        if (status.receivedChunks.length !== row.total_chunks) {
          sendJson(res, { success: false, error: `Missing chunks: ${status.receivedChunks.length}/${row.total_chunks}` }, 400);
          return;
        }
        // 合并所有分片
        const chunkDir = require('path').join(process.env.TMPDIR || '/tmp', 'sharetool-chunks', uploadId);
        let fullContent = '';
        for (let i = 0; i < row.total_chunks; i++) {
          const chunkPath = require('path').join(chunkDir, `chunk_${i}`);
          fullContent += require('fs').readFileSync(chunkPath, 'utf8');
        }
        // 添加到数据库
        const result = db.addFile(row.filename, fullContent, 'file');
        if (result) {
          broadcastChange({ type: 'create', filename: row.filename, hash: result.hash });
          db.addAuditLog('upload_complete', `${row.filename} (${row.total_chunks} chunks)`, getClientIp(req), authData.token);
        }
        // 清理
        for (let i = 0; i < row.total_chunks; i++) {
          try { require('fs').unlinkSync(require('path').join(chunkDir, `chunk_${i}`)); } catch (e) {}
        }
        try { require('fs').rmSync(chunkDir, { recursive: true, force: true }); } catch (e) {}
        db.deleteChunkUpload(uploadId);
        sendJson(res, { success: true, filename: row.filename, hash: result ? result.hash : null });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return true;
  }

  // GET /api/upload/status/:uploadId - 查询分片上传状态
  if (pathname.startsWith('/api/upload/status/') && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const uploadId = pathname.slice('/api/upload/status/'.length);
    const status = db.getChunkUploadStatus(uploadId);
    if (!status) {
      sendJson(res, { success: false, error: 'Upload session not found' }, 404);
      return true;
    }
    sendJson(res, { success: true, uploadId, filename: status.filename, totalChunks: status.totalChunks, receivedChunks: status.receivedChunks.length });
    return true;
  }

  // GET /api/upload/check/:filename - 查询是否有未完成上传（断点续传用）
  if (pathname.startsWith('/api/upload/check/') && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/api/upload/check/'.length));
    const incomplete = db.getIncompleteUpload(filename);
    if (!incomplete) {
      sendJson(res, { success: true, hasIncomplete: false });
      return true;
    }
    sendJson(res, {
      success: true,
      hasIncomplete: true,
      uploadId: incomplete.upload_id,
      filename: incomplete.filename,
      totalChunks: incomplete.total_chunks,
      receivedChunks: incomplete.receivedChunks
    });
    return true;
  }

  // PUT /api/content/:filename - Update file content (edit & save)
  if (pathname.startsWith('/api/content/') && method === 'PUT') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/api/content/'.length));
    const file = db.getFileByName(filename);
    if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return true; }

    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch (_) { sendJson(res, { success: false, error: 'Invalid JSON' }, 400); return; }
      const { content } = parsed;
      if (typeof content !== 'string') { sendJson(res, { success: false, error: 'content required' }, 400); return; }

      const updated = db.updateFileByName(filename, { content });
      if (updated) {
        db.addAuditLog('edit_file', filename + ' (' + file.size + ' -> ' + updated.size + ' bytes)', getClientIp(req), authData.token);
        broadcastChange({ type: 'update', filename, hash: updated.hash, size: updated.size });
        sendJson(res, { success: true, hash: updated.hash, size: updated.size });
      } else {
        sendJson(res, { success: false, error: 'Update failed' }, 500);
      }
    });
    return true;
  }

  // GET /api/content/:filename
  if (pathname.startsWith('/api/content/') && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/api/content/'.length));
    const file = db.getFileByName(filename);
    if (file) {
      db.addAuditLog('read_content', filename, getClientIp(req), authData.token);
      // Infer MIME type from extension for non-text files
      const ext = (file.filename || '').split('.').pop().toLowerCase();
      const mimeFromExt = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo', mov: 'video/quicktime', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4', pdf: 'application/pdf' }[ext];
      const resolvedType = (file.type === 'text' || file.type === 'file') && mimeFromExt ? mimeFromExt : file.type;
      // SVG is stored as raw text; encode to base64 for data URL use
      const content = (ext === 'svg' && file.type === 'text')
        ? Buffer.from(file.content, 'utf8').toString('base64')
        : file.content;
      sendJson(res, { success: true, content, type: resolvedType, size: file.size });
    } else {
      sendJson(res, { success: false, error: 'File not found' }, 404);
    }
    return true;
  }

  // GET /api/latest/text
  if (pathname === '/api/latest/text') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const { files } = db.listFiles(10);
    const textFile = files.find(f => f.type === 'text');
    if (textFile) {
      sendJson(res, { success: true, content: textFile.content, filename: textFile.filename });
    } else {
      sendJson(res, { success: false, error: 'No text file found' }, 404);
    }
    return true;
  }

  // DELETE /api/file/
  if (pathname === '/api/file/' && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(query.filename || '');
    if (db.deleteFileByName(filename)) {
      broadcastChange({ type: 'delete', filename });
      db.addAuditLog('delete_file', filename, getClientIp(req), authData.token);
      sendJson(res, { success: true });
    } else {
      sendJson(res, { success: false, error: 'File not found' }, 404);
    }
    return true;
  }

  // DELETE /api/delete-old
  if (pathname === '/api/delete-old' && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const days = parseInt(query.days) || 7;
    const result = db.deleteOldFiles(days);
    broadcastChange({ type: 'bulk_delete', count: result.deleted });
    db.addAuditLog('delete_old', `Deleted ${result.deleted} files older than ${days} days`, getClientIp(req), authData.token);
    sendJson(res, { success: true, deleted: result.deleted });
    return true;
  }

  // DELETE /api/folder/ - delete all files in a virtual folder (prefix)
  if (pathname.startsWith('/api/folder/') && pathname.endsWith('/delete') && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const folderPath = decodeURIComponent(pathname.slice(12, -7)); // /api/folder/{path}/delete
    if (!folderPath || folderPath === 'undefined') {
      sendJson(res, { success: false, error: 'Invalid folder path' }, 400);
      return true;
    }
    const result = db.deleteFilesByPrefix(folderPath);
    broadcastChange({ type: 'bulk_delete', count: result.deleted, folder: folderPath });
    db.addAuditLog('delete_folder', `Deleted ${result.deleted} files in folder: ${folderPath}`, getClientIp(req), authData.token);
    sendJson(res, { success: true, deleted: result.deleted });
    return true;
  }

  // POST /api/folder/rename - rename virtual folder (all files with prefix)
  if (pathname.startsWith('/api/folder/rename') && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { oldPath, newPath } = JSON.parse(body);
        if (!oldPath || !newPath) {
          sendJson(res, { success: false, error: 'oldPath and newPath required' }, 400);
          return;
        }
        const result = db.renameFilesByPrefix(oldPath, newPath);
        broadcastChange({ type: 'bulk_rename', oldPath, newPath, count: result.renamed });
        db.addAuditLog('rename_folder', `Renamed ${result.renamed} files from ${oldPath} to ${newPath}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, renamed: result.renamed });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/download-one
  if (pathname === '/api/download-one' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filename, downloadDir } = JSON.parse(body);
        const targetDir = downloadDir || config.downloadDir;
        const file = db.getFileByName(filename);
        if (!file) {
          sendJson(res, { success: false, error: 'File not found' }, 404);
          return;
        }
        const targetPath = require('path').join(targetDir, filename);
        require('fs').writeFileSync(targetPath, file.content || '', 'utf8');
        db.addAuditLog('download_one', `${filename} -> ${targetDir}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, path: targetPath });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return true;
  }

// POST /api/batch-download - 流式 ZIP 打包（避免大文件内存溢出）
  if (pathname === '/api/batch-download' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filenames, folder } = JSON.parse(body);
        let fileMetas = [];
        let zipName = 'sharetool_batch.zip';

        // 模式1：文件夹打包
        if (folder) {
          const files = db.getFilesByPrefix(folder);
          if (files.length === 0) {
            sendJson(res, { success: false, error: '文件夹为空或不存在' }, 404);
            return;
          }
          fileMetas = files.map(f => ({ filename: f.filename, content: f.content || '' }));
          zipName = folder.replace(/\/$/, '').replace(/\//g, '_') + '_folder.zip';
        }
        // 模式2：指定文件列表
        else {
          if (!Array.isArray(filenames) || filenames.length === 0) {
            sendJson(res, { success: false, error: '需要提供文件名数组或 folder 参数' }, 400);
            return;
          }
          if (filenames.length > 100) {
            sendJson(res, { success: false, error: '最多同时下载 100 个文件' }, 400);
            return;
          }
          for (const fn of filenames) {
            const file = db.getFileByName(fn);
            if (file) {
              fileMetas.push({ filename: fn, content: file.content || '' });
            }
          }
          if (fileMetas.length === 0) {
            sendJson(res, { success: false, error: '没有找到任何文件' }, 404);
            return;
          }
        }

        // 流式打包：直接 pipe 到 HTTP 响应，避免内存缓冲区
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="' + zipName + '"',
          'Transfer-Encoding': 'chunked'
        });

        const archive = archiver('zip', { zlib: { level: 5 } }); // level 5 平衡速度与压缩率
        archive.on('error', err => {
          if (!res.headersSent) {
            sendJson(res, { success: false, error: '打包失败' }, 500);
          }
          res.end();
        });

        archive.pipe(res);
        for (const f of fileMetas) {
          archive.append(f.content, { name: f.filename });
        }
        archive.finalize();

        const logMsg = folder ? `folder: ${folder} (${fileMetas.length} files)` : `${fileMetas.length} files`;
        db.addAuditLog('batch_download', logMsg, getClientIp(req), authData.token);
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/search
  if (pathname === '/api/search') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let q = query.q || '';
    let tags = query.tags || null;
    // Parse tag: prefix from query string (e.g. "report tag:work" → q="report" tags="work")
    const tagMatch = q.match(/(?:^|\s)tag:(\S+)/);
    if (tagMatch) {
      tags = tagMatch[1];
      q = q.replace(tagMatch[0], '').replace(/\s+/g, ' ').trim();
    }
    const results = db.searchFiles(q, tags, { fuzzy: true });
    db.addAuditLog('search', `q=${q}, tags=${tags}`, getClientIp(req), authData.token);
    sendJson(res, { success: true, files: results.map(f => ({
      id: f.id, name: f.filename, size: f.size, time: f.created_at * 1000,
      type: f.type, hash: f.hash, tags: f.tags,
      relevance: f.score || 0
    }))});
    return true;
  }

  // GET /api/search/suggest
  if (pathname === '/api/search/suggest' && method === 'GET') {
    let q = (query.q || '').trim();
    // Strip tag: prefix for display purposes
    const tagMatch = q.match(/^tag:(\S+)$/);
    if (tagMatch) {
      const tagPrefix = tagMatch[1];
      const allTagRows = db.getAllTagColors ? db.getAllTagColors() : [];
      const filtered = allTagRows
        .filter(t => t.tag.toLowerCase().includes(tagPrefix.toLowerCase()))
        .slice(0, 8);
      sendJson(res, {
        success: true,
        suggestions: filtered.map(t => ({ type: 'tag', text: t.tag, icon: '🏷', color: t.color || null }))
      });
      return true;
    }
    if (q.length < 1) { sendJson(res, { success: true, suggestions: [] }); return true; }
    const suggestions = [];
    // Use search engine instead of loading all files
    const results = db.searchFiles(q, null, { limit: 5, fuzzy: true });
    results.forEach(f => {
      suggestions.push({ type: 'file', text: f.filename, icon: getFileIcon(f.filename), tag: null });
    });
    // Tag matches from suggestion keywords (from matched files)
    const allTags = new Set();
    results.forEach(f => { if (f.tags) f.tags.split(',').forEach(t => allTags.add(t.trim())); });
    const tagMatches = Array.from(allTags).filter(t => t.toLowerCase().includes(q.toLowerCase())).slice(0, 3);
    tagMatches.forEach(t => {
      const color = db.getTagColor ? db.getTagColor(t) : null;
      suggestions.push({ type: 'tag', text: t, icon: '🏷', color });
    });
    // Direct tag search: also search tags directly if query looks like a tag search
    // (no "tag:" prefix needed — if no file results but tags match, show tag suggestions)
    if (results.length === 0 || !tagMatches.length) {
      const allTagRows = db.getAllTagColors ? db.getAllTagColors() : [];
      const directTagMatches = allTagRows
        .filter(t => t.tag.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 3);
      directTagMatches.forEach(t => {
        if (!suggestions.find(s => s.type === 'tag' && s.text === t.tag)) {
          suggestions.push({ type: 'tag', text: t.tag, icon: '🏷', color: t.color });
        }
      });
    }
    sendJson(res, { success: true, suggestions });
    return true;
  }

  // POST /api/file-rename/:oldFilename
  if (pathname.startsWith('/api/file-rename/') && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const oldFilename = decodeURIComponent(pathname.slice('/api/file-rename/'.length));
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { newFilename } = JSON.parse(body);
        if (!newFilename || !newFilename.trim()) {
          sendJson(res, { success: false, error: '新文件名不能为空' }, 400);
          return;
        }
        const newName = newFilename.trim();
        const result = db.renameFile(oldFilename, newName);
        if (result.success) {
          broadcastChange({ type: 'rename', oldFilename, newFilename: newName, hash: result.hash });
          db.addAuditLog('rename', `${oldFilename} → ${newName}`, getClientIp(req), authData.token);
          sendJson(res, { success: true, oldFilename, newFilename: newName });
        } else {
          sendJson(res, { success: false, error: result.error }, 400);
        }
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/files
  if (pathname === '/api/files') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const { files, total } = db.listFiles(100, 0);
    sendJson(res, { success: true, files, total });
    return true;
  }

  // GET /api/files/list
  if (pathname === '/api/files/list') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const limit = parseInt(query.limit) || 100;
    const offset = parseInt(query.offset) || 0;
    const { files, total } = db.listFiles(limit, offset);
    sendJson(res, { success: true, files, total });
    return true;
  }

  // POST /api/files/upload-encrypted
  if (pathname === '/api/files/upload-encrypted' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filename, encryptedContent, size } = JSON.parse(body);
        if (!filename || !encryptedContent) {
          sendJson(res, { success: false, error: '需要 filename 和 encryptedContent' }, 400);
          return;
        }
        const content = Buffer.from(encryptedContent, 'base64').toString('utf8');
        const hash = crypto.createHash('md5').update(content).digest('hex');
        const result = db.addFile(filename, content, 'file', hash, true);
        db.addAuditLog('file_upload_encrypted', `filename=${filename}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, ...result });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return true;
  }

  // GET /api/files/:filename
  if (pathname.match(/^\/api\/files\/[^/]+$/) && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/api/files/'.length));
    const file = db.getFileByName(filename);
    if (!file) {
      sendJson(res, { success: false, error: '文件不存在' }, 404);
      return;
    }
    sendJson(res, { success: true, file });
    return true;
  }

  // POST /api/files/:filename/encrypt
  if (pathname.match(/^\/api\/files\/[^/]+\/encrypt$/) && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const parts = pathname.split('/');
    const filename = decodeURIComponent(parts[parts.length - 2]);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { encrypted } = JSON.parse(body);
        const file = db.updateFileByName(filename, { encrypted: !!encrypted });
        if (!file) {
          sendJson(res, { success: false, error: '文件不存在' }, 404);
          return;
        }
        db.addAuditLog('file_encrypt', `filename=${filename}, encrypted=${encrypted}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, file });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return true;
  }

  // DELETE /api/files/:filename
  if (pathname.startsWith('/api/files/') && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/api/files/'.length));
    if (db.deleteFileByName(filename)) {
      broadcastChange({ type: 'delete', filename });
      db.addAuditLog('delete_file', filename, getClientIp(req), authData.token);
      sendJson(res, { success: true });
    } else {
      sendJson(res, { success: false, error: 'File not found' }, 404);
    }
    return true;
  }

  // GET /download/:filename
  if (pathname.startsWith('/download/')) {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/download/'.length));
    const file = db.getFileByName(filename);
    if (file) {
      db.addAuditLog('download', filename, getClientIp(req), authData.token);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Content-Length': file.size
      });
      res.end(file.content || '');
      return true;
    }
    sendJson(res, { success: false, error: 'File not found' }, 404);
    return true;
  }

  // PUT /api/tags/color
  if (pathname === '/api/tags/color' && method === 'PUT') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tag, color } = JSON.parse(body);
        if (!tag || !color) { sendJson(res, { success: false, error: 'tag and color required' }, 400); return; }
        const result = db.setTagColor(tag, color);
        sendJson(res, { success: true, ...result });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/tags/suggest-color
  if (pathname === '/api/tags/suggest-color' && method === 'GET') {
    const tag = query.tag;
    if (!tag) { sendJson(res, { success: false, error: 'tag required' }, 400); return true; }
    const color = db.getSuggestedColor(tag);
    sendJson(res, { success: true, color });
    return true;
  }

  // GET /api/tags/list
  if (pathname === '/api/tags/list' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const { files } = db.listFiles();
    const tagCount = {};
    files.forEach(f => {
      if (f.tags) {
        f.tags.split(',').map(t => t.trim()).filter(t => t).forEach(t => {
          tagCount[t] = (tagCount[t] || 0) + 1;
        });
      }
    });
    const list = Object.entries(tagCount).map(([tag, count]) => {
      const color = db.getTagColor(tag);
      return { tag, count, color };
    }).sort((a, b) => b.count - a.count);
    sendJson(res, { success: true, tags: list });
    return true;
  }

  // POST /api/file-rename-batch
  if (pathname === '/api/file-rename-batch' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { renames } = JSON.parse(body);
        if (!Array.isArray(renames) || renames.length === 0) {
          sendJson(res, { success: false, error: 'renames 必须是非空数组' }, 400);
          return;
        }
        if (renames.length > 100) {
          sendJson(res, { success: false, error: '单次最多支持 100 个文件重命名' }, 400);
          return;
        }
        const results = [];
        const errors = [];
        for (const { oldFilename, newFilename } of renames) {
          if (!newFilename || !newFilename.trim()) {
            errors.push({ oldFilename, error: '新文件名不能为空' });
            continue;
          }
          const newName = newFilename.trim();
          const result = db.renameFile(oldFilename, newName);
          if (result.success) {
            broadcastChange({ type: 'rename', oldFilename, newFilename: newName, hash: result.hash });
            results.push({ oldFilename, newFilename: newName });
          } else {
            errors.push({ oldFilename, error: result.error });
          }
        }
        if (results.length > 0) {
          db.addAuditLog('batch_rename', `${results.length} files renamed`, getClientIp(req), authData.token);
        }
        sendJson(res, { success: results.length > 0, renamed: results, errors, total: renames.length });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/tags/rename/:oldTag
  if (pathname.startsWith('/api/tags/rename/') && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const parts = pathname.split('/');
    const oldTag = decodeURIComponent(parts[parts.length - 1]);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { newTag } = JSON.parse(body);
        if (!newTag || !newTag.trim()) { sendJson(res, { success: false, error: 'newTag required' }, 400); return; }
        const files = db.listFiles();
        let updated = 0;
        files.forEach(f => {
          if (f.tags) {
            const tags = f.tags.split(',').map(t => t.trim());
            const idx = tags.findIndex(t => t === oldTag);
            if (idx >= 0) {
              tags[idx] = newTag.trim();
              db.updateFile(f.id, { tags: tags.join(',') });
              updated++;
            }
          }
        });
        sendJson(res, { success: true, updated });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // DELETE /api/tags/delete/:tag
  if (pathname.startsWith('/api/tags/delete/') && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const tag = decodeURIComponent(pathname.slice('/api/tags/delete/'.length));
    const files = db.listFiles();
    let updated = 0;
    files.forEach(f => {
      if (f.tags) {
        const tags = f.tags.split(',').map(t => t.trim()).filter(t => t !== tag);
        if (tags.length !== f.tags.split(',').map(t => t.trim()).filter(t => t).length) {
          db.updateFile(f.id, { tags: tags.join(',') });
          updated++;
        }
      }
    });
    sendJson(res, { success: true, updated });
    return true;
  }

  // POST /api/file-copy - 复制单个文件
  if (pathname === '/api/file-copy' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { sourceFilename, newFilename } = JSON.parse(body);
        if (!sourceFilename || !newFilename) {
          sendJson(res, { success: false, error: 'sourceFilename 和 newFilename 必填' }, 400);
          return;
        }
        const result = db.copyFile(sourceFilename, newFilename);
        if (!result.success) {
          sendJson(res, { success: false, error: result.error }, 400);
          return;
        }
        broadcastChange({ type: 'file_copy', filename: newFilename, hash: result.hash, size: result.size });
        db.addAuditLog('copy', `${sourceFilename} → ${newFilename}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, filename: newFilename, hash: result.hash, size: result.size });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/file-move - 移动单个文件
  if (pathname === '/api/file-move' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { sourceFilename, destFilename } = JSON.parse(body);
        if (!sourceFilename || !destFilename) {
          sendJson(res, { success: false, error: 'sourceFilename 和 destFilename 必填' }, 400);
          return;
        }
        if (sourceFilename === destFilename) {
          sendJson(res, { success: false, error: '源路径和目标路径相同' }, 400);
          return;
        }
        const result = db.moveFile(sourceFilename, destFilename);
        if (!result.success) {
          sendJson(res, { success: false, error: result.error }, 400);
          return;
        }
        broadcastChange({ type: 'file_move', oldFilename: sourceFilename, newFilename: destFilename, hash: result.hash, size: result.size });
        db.addAuditLog('move', `${sourceFilename} → ${destFilename}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, oldFilename: sourceFilename, newFilename: destFilename, hash: result.hash, size: result.size });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/folder/move - 移动虚拟文件夹（所有匹配前缀的文件）
  if (pathname === '/api/folder/move' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { sourcePrefix, destPrefix } = JSON.parse(body);
        if (!sourcePrefix || !destPrefix) {
          sendJson(res, { success: false, error: 'sourcePrefix 和 destPrefix 必填' }, 400);
          return;
        }
        if (sourcePrefix === destPrefix) {
          sendJson(res, { success: false, error: '目标路径不能与源路径相同' }, 400);
          return;
        }
        const result = db.moveFilesByPrefix(sourcePrefix, destPrefix);
        broadcastChange({ type: 'bulk_move', sourcePrefix, destPrefix, count: result.moved });
        db.addAuditLog('move_folder', `Moved ${result.moved} files from ${sourcePrefix} to ${destPrefix}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, moved: result.moved });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/folder/copy - 复制虚拟文件夹（所有匹配前缀的文件）
  if (pathname === '/api/folder/copy' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { sourcePrefix, destPrefix } = JSON.parse(body);
        if (!sourcePrefix || !destPrefix) {
          sendJson(res, { success: false, error: 'sourcePrefix 和 destPrefix 必填' }, 400);
          return;
        }
        if (sourcePrefix === destPrefix) {
          sendJson(res, { success: false, error: '目标路径不能与源路径相同' }, 400);
          return;
        }
        const result = db.copyFilesByPrefix(sourcePrefix, destPrefix);
        broadcastChange({ type: 'bulk_copy', sourcePrefix, destPrefix, count: result.copied });
        db.addAuditLog('copy_folder', `Copied ${result.copied} files from ${sourcePrefix} to ${destPrefix}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, copied: result.copied });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/file-meta/:filename - 获取文件完整元数据
  if (pathname.match(/^\/api\/file-meta\/[^/]+$/) && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/api/file-meta/'.length));
    const file = db.getFileByName(filename);
    if (!file) {
      sendJson(res, { success: false, error: '文件不存在' }, 404);
      return true;
    }
    const versionCount = db.getFileVersionCount(file.id);
    // 检查是否有活跃的分享链接
    const shareLinks = db.listShareLinks(file.filename);
    const activeShare = shareLinks.filter(l => !l.expired);
    sendJson(res, {
      success: true,
      meta: {
        id: file.id,
        filename: file.filename,
        size: file.size,
        hash: file.hash,
        type: file.type,
        tags: file.tags,
        encrypted: file.encrypted,
        createdAt: file.created_at * 1000,
        updatedAt: file.updated_at * 1000,
        versionCount,
        shareCount: activeShare.length,
        shareLinks: activeShare.map(l => ({
          code: l.code,
          expiresAt: l.expires_at,
          hasPassword: l.hasPassword
        }))
      }
    });
    return true;
  }

  // POST /api/file-version/:versionId/restore
  if (pathname.match(/^\/api\/file-version\/\d+\/restore$/) && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const parts = pathname.match(/^\/api\/file-version\/(\d+)\/restore$/);
    const versionId = parseInt(parts[1]);
    const version = db.getFileVersion(versionId);
    if (!version) { sendJson(res, { success: false, error: 'Version not found' }, 404); return true; }
    const file = db.getFileByName(version.filename);
    if (!file) { sendJson(res, { success: false, error: 'Original file not found' }, 404); return true; }
    db.updateFileByName(version.filename, { content: version.content, type: file.type });
    db.addAuditLog('file_version_restore', `filename=${version.filename}, version=${versionId}`, getClientIp(req), authData.token);
    sendJson(res, { success: true, message: 'Version restored' });
    return true;
  }

  // DELETE /api/file-version/:versionId
  if (pathname.match(/^\/api\/file-version\/\d+$/) && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const versionId = parseInt(pathname.match(/^\/api\/file-version\/(\d+)$/)[1]);
    const version = db.getFileVersion(versionId);
    if (!version) { sendJson(res, { success: false, error: 'Version not found' }, 404); return true; }
    db.deleteFileVersion(versionId);
    db.addAuditLog('file_version_delete', `filename=${version.filename}, version=${versionId}`, getClientIp(req), authData.token);
    sendJson(res, { success: true });
    return true;
  }

  // GET /api/file-version/:versionId - get version content for preview
  if (pathname.match(/^\/api\/file-version\/\d+$/) && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const versionId = parseInt(pathname.match(/^\/api\/file-version\/(\d+)$/)[1]);
    const version = db.getFileVersion(versionId);
    if (!version) { sendJson(res, { success: false, error: 'Version not found' }, 404); return true; }
    sendJson(res, { success: true, version });
    return true;
  }

  // POST /api/file/reorder - 批量设置文件排序位置
  if (pathname === '/api/file/reorder' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { positions } = JSON.parse(body); // [{id, position}, ...]
        if (!Array.isArray(positions)) {
          sendJson(res, { success: false, error: 'positions must be an array' }, 400);
          return;
        }
        db.setFilePositions(positions);
        db.addAuditLog('file_reorder', `count=${positions.length}`, getClientIp(req), authData.token);
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  return false;
};
