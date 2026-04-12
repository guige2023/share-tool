/**
 * routes/files.js - core LAN share file endpoints
 */

module.exports = async function handleFileRoutes(req, res, pathname, query, ctx) {
  const {
    db,
    sendJson,
    authRequired,
    getClientIp,
    readJsonBody,
    maxUploadBytes,
    decodeStoredFile,
    guessMimeType,
    archiver
  } = ctx;

  const { method } = req;

  if (pathname === '/api/list' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const limit = Math.min(parseInt(query.get('limit') || '500', 10) || 500, 5000);
    const offset = Math.max(parseInt(query.get('offset') || '0', 10) || 0, 0);
    const sort = query.get('sort') || 'updated_at';
    const order = query.get('order') || 'desc';
    const folder = query.get('folder') || null;
    const tags = query.get('tags') || null;
    const { files, total } = db.listFiles(limit, offset, sort, order, folder, false, tags);

    sendJson(res, {
      success: true,
      total,
      files: files.map((file) => ({
        id: file.id,
        name: file.filename,
        size: file.size,
        type: file.type,
        hash: file.hash,
        createdAt: file.created_at * 1000,
        updatedAt: file.updated_at * 1000
      }))
    });
    return true;
  }

  if (pathname === '/api/search' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const q = (query.get('q') || '').trim();
    const tags = query.get('tags') || null;
    if (!q && !tags) {
      sendJson(res, { success: true, files: [] });
      return true;
    }

    const results = db.searchFiles(q, tags, { fuzzy: true, limit: 100 });
    const sort = query.get('sort') || 'updated_at';
    const order = (query.get('order') || 'desc').toLowerCase();
    const dir = order === 'asc' ? 1 : -1;
    if (sort === 'filename') {
      results.sort((a, b) => dir * a.filename.localeCompare(b.filename));
    } else if (sort === 'size') {
      results.sort((a, b) => dir * (a.size - b.size));
    } else if (sort === 'updated_at') {
      results.sort((a, b) => dir * (a.updated_at - b.updated_at));
    }
    sendJson(res, {
      success: true,
      files: results.map((file) => ({
        id: file.id,
        name: file.filename,
        size: file.size,
        type: file.type,
        hash: file.hash,
        createdAt: file.created_at * 1000,
        updatedAt: file.updated_at * 1000,
        tags: file.tags || '',
        score: file.score || 0
      }))
    });
    return true;
  }

  if (pathname === '/api/upload' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    try {
      const body = await readJsonBody(req);
      const filename = (body.filename || '').trim();
      const type = body.type === 'text' ? 'text' : 'file';
      const content = typeof body.content === 'string' ? body.content : '';

      if (!filename) {
        sendJson(res, { success: false, error: 'filename required' }, 400);
        return true;
      }

      const byteLength = Buffer.byteLength(content, type === 'text' ? 'utf8' : 'base64');
      if (byteLength > maxUploadBytes()) {
        sendJson(res, { success: false, error: 'file too large' }, 413);
        return true;
      }

      const result = db.addFile(filename, content, type);
      db.addAuditLog('upload', filename, getClientIp(req), auth.token);
      sendJson(res, { success: true, file: result });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  if (pathname === '/api/latest/text' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const { files } = db.listFiles(200, 0, 'updated_at', 'DESC');
    const latest = files.find((file) => file.type === 'text');
    if (!latest) {
      sendJson(res, { success: false, error: 'No text found' }, 404);
      return true;
    }

    const full = db.getFileByName(latest.filename);
    sendJson(res, {
      success: true,
      filename: full.filename,
      content: full.content,
      updatedAt: full.updated_at * 1000
    });
    return true;
  }

  if (pathname.startsWith('/api/content/') && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const filename = decodeURIComponent(pathname.slice('/api/content/'.length));
    const file = db.getFileByName(filename);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }

    sendJson(res, {
      success: true,
      file: {
        name: file.filename,
        type: file.type,
        size: file.size,
        updatedAt: file.updated_at * 1000,
        mime: guessMimeType(file.filename),
        content: file.content || ''
      }
    });
    return true;
  }

  if (pathname.startsWith('/api/content/') && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const filename = decodeURIComponent(pathname.slice('/api/content/'.length));
    try {
      const body = await readJsonBody(req);
      if (typeof body.content !== 'string') {
        sendJson(res, { success: false, error: 'content required' }, 400);
        return true;
      }

      const updated = db.updateFileByName(filename, { content: body.content, type: 'text' });
      if (!updated) {
        sendJson(res, { success: false, error: 'File not found' }, 404);
        return true;
      }

      db.addAuditLog('text_update', filename, getClientIp(req), auth.token);
      sendJson(res, { success: true, file: updated });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  if (pathname.startsWith('/api/file-rename/') && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const oldFilename = decodeURIComponent(pathname.slice('/api/file-rename/'.length));
    try {
      const body = await readJsonBody(req);
      const newFilename = (body.newFilename || '').trim();
      if (!newFilename) {
        sendJson(res, { success: false, error: 'newFilename required' }, 400);
        return true;
      }

      const result = db.renameFile(oldFilename, newFilename);
      if (!result.success) {
        sendJson(res, { success: false, error: result.error || 'Rename failed' }, 400);
        return true;
      }

      db.addAuditLog('rename', `${oldFilename} -> ${newFilename}`, getClientIp(req), auth.token);
      sendJson(res, { success: true, oldFilename, newFilename });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  // PATCH /api/files/:filename - 更新文件标签/星标等元数据
  if (pathname.startsWith('/api/files/') && method === 'PATCH') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const filename = decodeURIComponent(pathname.slice('/api/files/'.length));
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        sendJson(res, { success: false, error: 'Request body required' }, 400);
        return true;
      }

      const updates = {};
      if (body.tags !== undefined) {
        // 解析逗号分隔的标签字符串
        updates.tags = typeof body.tags === 'string'
          ? body.tags.split(',').map(t => t.trim()).filter(Boolean).join(',')
          : body.tags;
      }
      if (body.starred !== undefined) updates.starred = body.starred ? 1 : 0;

      if (Object.keys(updates).length === 0) {
        sendJson(res, { success: false, error: 'No valid fields to update' }, 400);
        return true;
      }

      const updated = db.updateFileByName(filename, updates);
      if (!updated) {
        sendJson(res, { success: false, error: 'File not found' }, 404);
        return true;
      }

      db.addAuditLog('file_update', `${filename} tags=${updates.tags || '(unchanged)'}`, getClientIp(req), auth.token);
      sendJson(res, { success: true, file: { name: updated.filename, tags: updated.tags, starred: updated.starred } });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  if (pathname.startsWith('/api/files/') && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const filename = decodeURIComponent(pathname.slice('/api/files/'.length));
    if (!db.deleteFileByName(filename)) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }

    db.addAuditLog('delete', filename, getClientIp(req), auth.token);
    sendJson(res, { success: true });
    return true;
  }

  if (pathname === '/api/delete-all' && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const result = db.deleteAllFiles();
    db.addAuditLog('delete_all', String(result.deleted), getClientIp(req), auth.token);
    sendJson(res, { success: true, deleted: result.deleted });
    return true;
  }

  if (pathname === '/api/delete-old' && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const days = Math.max(parseInt(query.get('days') || '7', 10) || 7, 1);
    const result = db.deleteOldFiles(days);
    db.addAuditLog('delete_old', String(days), getClientIp(req), auth.token);
    sendJson(res, { success: true, deleted: result.deleted, days });
    return true;
  }

  if (pathname === '/api/batch-download' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    try {
      const body = await readJsonBody(req);
      const filenames = Array.isArray(body.filenames) ? body.filenames : [];
      if (!filenames.length) {
        sendJson(res, { success: false, error: 'filenames required' }, 400);
        return true;
      }

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="sharetool_batch.zip"'
      });

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (error) => {
        try {
          res.destroy(error);
        } catch (_) {
          // ignore socket shutdown errors
        }
      });
      archive.pipe(res);

      filenames.forEach((name) => {
        const file = db.getFileByName(name);
        if (!file) return;
        archive.append(decodeStoredFile(file), { name: file.filename });
      });

      await archive.finalize();
      db.addAuditLog('batch_download', `${filenames.length} files`, getClientIp(req), auth.token);
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  if (pathname.startsWith('/download/') && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const filename = decodeURIComponent(pathname.slice('/download/'.length));
    const file = db.getFileByName(filename);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }

    const body = decodeStoredFile(file);
    res.writeHead(200, {
      'Content-Type': guessMimeType(file.filename),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': body.length
    });
    res.end(body);
    return true;
  }

  return false;
};
