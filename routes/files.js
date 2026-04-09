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
    const { files, total } = db.listFiles();
    db.addAuditLog('list_files', `Total: ${total}`, getClientIp(req), authData.token);
    sendJson(res, { success: true, files: files.map(f => ({
      id: f.id, name: f.filename, size: f.size, time: f.created_at * 1000,
      type: f.type, hash: f.hash, tags: f.tags
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

  // GET /api/content/:filename
  if (pathname.startsWith('/api/content/')) {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/api/content/'.length));
    const file = db.getFileByName(filename);
    if (file) {
      db.addAuditLog('read_content', filename, getClientIp(req), authData.token);
      sendJson(res, { success: true, content: file.content, type: file.type, size: file.size });
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

  // POST /api/batch-download
  if (pathname === '/api/batch-download' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filenames } = JSON.parse(body);
        if (!Array.isArray(filenames) || filenames.length === 0) {
          sendJson(res, { success: false, error: '需要提供文件名数组' }, 400);
          return;
        }
        if (filenames.length > 100) {
          sendJson(res, { success: false, error: '最多同时下载 100 个文件' }, 400);
          return;
        }

        const files = [];
        for (const fn of filenames) {
          const file = db.getFileByName(fn);
          if (file) {
            files.push({ filename: fn, content: file.content || '' });
          }
        }

        if (files.length === 0) {
          sendJson(res, { success: false, error: '没有找到任何文件' }, 404);
          return;
        }

        let zipBuffer = null;
        try {
          const archive = archiver('zip', { zlib: { level: 9 } });
          const chunks = [];
          archive.on('data', chunk => chunks.push(chunk));
          for (const f of files) {
            archive.append(f.content, { name: f.filename });
          }
          archive.finalize();
          zipBuffer = Buffer.concat(chunks);
        } catch (archiverErr) {
          try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip();
            for (const f of files) {
              zip.addFile(f.filename, Buffer.from(f.content, 'utf8'));
            }
            zipBuffer = zip.toBuffer();
          } catch (admZipErr) {
            sendJson(res, {
              success: true,
              mode: 'multiple',
              files: files.map(f => ({
                name: f.filename,
                size: f.content ? Buffer.byteLength(f.content, 'utf8') : 0
              })),
              message: '批量打包不可用，请使用多标签页下载'
            });
            return;
          }
        }

        if (zipBuffer) {
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="sharetool_batch.zip"',
            'Content-Length': zipBuffer.length
          });
          res.end(zipBuffer);
          db.addAuditLog('batch_download', `${files.length} files`, getClientIp(req), authData.token);
          return;
        }
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
    const q = query.q || '';
    const tags = query.tags || null;
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
    const q = (query.q || '').trim();
    if (q.length < 1) { sendJson(res, { success: true, suggestions: [] }); return true; }
    const suggestions = [];
    // Use search engine instead of loading all files
    const results = db.searchFiles(q, null, { limit: 5, fuzzy: true });
    results.forEach(f => {
      suggestions.push({ type: 'file', text: f.filename, icon: getFileIcon(f.filename), tag: null });
    });
    // Tag matches from suggestion keywords
    const allTags = new Set();
    results.forEach(f => { if (f.tags) f.tags.split(',').forEach(t => allTags.add(t.trim())); });
    const tagMatches = Array.from(allTags).filter(t => t.toLowerCase().includes(q.toLowerCase())).slice(0, 3);
    tagMatches.forEach(t => {
      const color = db.getTagColor ? db.getTagColor(t) : null;
      suggestions.push({ type: 'tag', text: t, icon: '🏷', color });
    });
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

  // PUT /api/file-tags/:filename
  if (pathname.startsWith('/api/file-tags/') && method === 'PUT') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/api/file-tags/'.length));
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tags } = JSON.parse(body);
        const updated = db.updateFileByName(filename, { tags });
        if (updated) {
          broadcastChange({ type: 'update', filename, tags });
          db.addAuditLog('update_tags', `${filename}: ${tags}`, getClientIp(req), authData.token);
          sendJson(res, { success: true, tags });
        } else {
          sendJson(res, { success: false, error: 'File not found' }, 404);
        }
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
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
    const files = db.listFiles();
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

  return false;
};
