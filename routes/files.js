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
        tags: file.tags || '',
        createdAt: file.created_at * 1000,
        updatedAt: file.updated_at * 1000,
        content_type: file.content_type || null
      }))
    });
    return true;
  }

  if (pathname === '/api/search' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const q = (query.get('q') || '').trim();
    const tags = query.get('tags') || null;
    const tagMatch = query.get('tagMatch') || 'all';
    const sizeMin = query.get('size_min') || null;
    const sizeMax = query.get('size_max') || null;
    const dateFrom = query.get('date_from') || null;
    const dateTo = query.get('date_to') || null;
    const typeFilter = query.get('type') || null;
    if (!q && !tags && !sizeMin && !sizeMax && !dateFrom && !dateTo && !typeFilter) {
      sendJson(res, { success: true, files: [] });
      return true;
    }

    // 优先使用 FTS5 搜索（更快），fallback 到 LIKE
    let results = db.searchFilesFTS(q, tags, {
      fuzzy: true, limit: 100, tagMatch,
      size_min: sizeMin ? parseInt(sizeMin) : null,
      size_max: sizeMax ? parseInt(sizeMax) : null,
      date_from: dateFrom ? parseInt(dateFrom) : null,
      date_to: dateTo ? parseInt(dateTo) : null,
      type: typeFilter
    });
    if (!results) {
      // FTS5 不可用，fallback 到 LIKE 搜索
      results = db.searchFiles(q, tags, {
        fuzzy: true, limit: 100, tagMatch,
        size_min: sizeMin ? parseInt(sizeMin) : null,
        size_max: sizeMax ? parseInt(sizeMax) : null,
        date_from: dateFrom ? parseInt(dateFrom) : null,
        date_to: dateTo ? parseInt(dateTo) : null,
        type: typeFilter
      });
    }

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
        // FTS5: use fts_rank (bm25, lower is better); LIKE: use computed score
        score: file.fts_rank !== undefined ? -file.fts_rank : (file.score || 0),
        content_type: file.content_type || null
      }))
    });
    return true;
  }

  // GET /api/search/suggest - search autocomplete suggestions
  if (pathname === '/api/search/suggest' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const q = (query.get('q') || '').trim().toLowerCase();
    if (!q || q.length < 1) {
      sendJson(res, { success: true, suggestions: [] });
      return true;
    }

    // Get top 8 matching filenames for suggestions
    const results = db.searchFiles(q, null, { fuzzy: true, limit: 8 });
    const suggestions = results.map(file => ({
      text: file.filename,
      type: '文件'
    }));

    sendJson(res, { success: true, suggestions });
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
      global.broadcastSSE({ type: 'files_changed' });
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

  // Preview/read file content - supports streaming for large text files
  if (pathname.startsWith('/api/content/') && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const filename = decodeURIComponent(pathname.slice('/api/content/'.length));
    const file = db.getFileByName(filename);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }

    const MAX_PREVIEW_BYTES = 500 * 1024; // 500KB limit for inline preview
    const isTextFile = (file.content_type || '').startsWith('text/') ||
                       ['text', 'js', 'py', 'json', 'md', 'html', 'css', 'xml', 'yaml', 'yml', 'sh', 'sql', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'toml', 'ini', 'cfg', 'conf'].some(ext => file.filename.endsWith('.' + ext));

    // For large text files, serve as plain text stream (no base64, no JSON overhead)
    if (isTextFile && file.size > MAX_PREVIEW_BYTES) {
      const content = file.content || '';
      const truncated = content.slice(0, MAX_PREVIEW_BYTES);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(truncated),
        'X-Preview-Truncated': 'true',
        'X-Preview-Original-Size': file.size
      });
      res.end(truncated);
      return true;
    }

    sendJson(res, {
      success: true,
      file: {
        name: file.filename,
        type: file.type,
        size: file.size,
        updatedAt: file.updated_at * 1000,
        mime: file.content_type || guessMimeType(file.filename),
        content_type: file.content_type || guessMimeType(file.filename),
        content: file.content || '',
        previewTruncated: isTextFile && file.size > MAX_PREVIEW_BYTES ? true : undefined,
        previewOriginalSize: isTextFile && file.size > MAX_PREVIEW_BYTES ? file.size : undefined
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
      global.broadcastSSE({ type: 'files_changed' });
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
      global.broadcastSSE({ type: 'files_changed' });
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
      global.broadcastSSE({ type: 'files_changed' });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  if (pathname.startsWith('/api/files/') && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const filename = decodeURIComponent(pathname.slice('/api/files/'.length));
    const trashId = db.deleteFileByName(filename);
    if (!trashId) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }

    db.addAuditLog('delete', filename, getClientIp(req), auth.token);
    sendJson(res, { success: true, trash_id: trashId });
    global.broadcastSSE({ type: 'files_changed' });
    return true;
  }

  if (pathname === '/api/delete-all' && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const result = db.deleteAllFiles();
    db.addAuditLog('delete_all', String(result.deleted), getClientIp(req), auth.token);
    sendJson(res, { success: true, deleted: result.deleted });
    global.broadcastSSE({ type: 'files_changed' });
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

  // POST /api/file-rename-batch - 批量重命名
  if (pathname === '/api/file-rename-batch' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    try {
      const body = await readJsonBody(req);
      if (!body || !Array.isArray(body.operations)) {
        sendJson(res, { success: false, error: 'operations array required' }, 400);
        return true;
      }
      if (body.operations.length > 500) {
        sendJson(res, { success: false, error: '最多支持 500 个文件批量重命名' }, 400);
        return true;
      }

      const result = db.batchRenameFiles(body.operations);
      if (result.errors.length > 0 && result.renamed === 0) {
        sendJson(res, { success: false, error: '所有重命名均失败', errors: result.errors }, 400);
        return true;
      }

      // 记录审计日志
      db.addAuditLog('batch_rename', `${result.renamed} 个文件重命名`, getClientIp(req), auth.token);
      sendJson(res, {
        success: true,
        renamed: result.renamed,
        errors: result.errors.length > 0 ? result.errors : undefined
      });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  // POST /api/file-positions - 批量更新文件位置（拖拽排序）
  if (pathname === '/api/file-positions' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const { positions } = body; // [{id: fileId, position: newPosition}, ...]
      if (!Array.isArray(positions) || positions.length === 0) {
        sendJson(res, { success: false, error: 'positions 必须是数组且不能为空' }, 400);
        return true;
      }
      if (positions.length > 1000) {
        sendJson(res, { success: false, error: '一次最多更新 1000 个文件位置' }, 400);
        return true;
      }
      db.setFilePositions(positions);
      sendJson(res, { success: true, updated: positions.length });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  return false;
};
