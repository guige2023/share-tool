/**
 * routes/files.js - core LAN share file endpoints
 */
const sharp = require('sharp');

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
    const typeParam = query.get('type') || null;
    const tagMatch = query.get('tagMatch') || 'OR';
    // Handle 'starred' and 'recent' as special type filters; split comma-separated types for multi-select
    const typeFilterList = typeParam ? typeParam.split(',').map(t => t.trim()).filter(Boolean) : [];
    const starredOnly = typeFilterList.includes('starred');
    const recentOnly = typeFilterList.includes('recent');
    const actualTypeFilter = starredOnly || recentOnly ? null : (typeFilterList.length ? typeFilterList : null);

    // type=recent: return recently accessed files from file_access_log
    if (recentOnly) {
      const files = db.getRecentlyAccessedFiles(limit);
      sendJson(res, {
        success: true,
        total: files.length,
        files: files.map((file) => ({
          id: file.id,
          name: file.filename,
          size: file.size,
          type: file.type,
          hash: file.hash,
          tags: file.tags || '',
          createdAt: file.created_at * 1000,
          updatedAt: file.updated_at * 1000,
          content_type: file.content_type || null,
          last_accessed_at: file.last_accessed_at ? file.last_accessed_at * 1000 : null
        }))
      });
      return true;
    }

    const { files, total } = db.listFiles(limit, offset, sort, order, folder, starredOnly, tags, actualTypeFilter, tagMatch);

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
        starred: file.starred === 1,
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
    // Map UI 'OR'/'AND' to DB 'any'/'all'
    const tagMatchRaw = query.get('tagMatch') || 'all';
    const tagMatch = tagMatchRaw === 'OR' ? 'any' : 'all';
    const sizeMin = query.get('size_min') || null;
    const sizeMax = query.get('size_max') || null;
    const searchMode = query.get('mode') || 'normal'; // 'normal' | 'glob' | 'regex'
    // date_from/to are YYYY-MM-DD strings — convert to Unix seconds
    const dateFromRaw = query.get('date_from') || null;
    const dateToRaw = query.get('date_to') || null;
    const dateFrom = dateFromRaw ? Math.floor(new Date(dateFromRaw + 'T00:00:00Z').getTime() / 1000) : null;
    const dateTo = dateToRaw ? Math.floor(new Date(dateToRaw + 'T23:59:59Z').getTime() / 1000) : null;
    // size_min/max are in KB from the UI — convert to bytes for comparison with f.size
    const sizeMinBytes = sizeMin ? parseInt(sizeMin) * 1024 : null;
    const sizeMaxBytes = sizeMax ? parseInt(sizeMax) * 1024 : null;
    const typeParam = query.get('type') || null;
    // Handle 'starred' as a special type filter; split comma-separated for multi-select
    const typeFilterList = typeParam ? typeParam.split(',').map(t => t.trim()).filter(Boolean) : [];
    const starredOnly = typeFilterList.includes('starred');
    const actualTypeFilter = starredOnly ? null : (typeFilterList.length ? typeFilterList : null);
    const limit = Math.min(parseInt(query.get('limit') || '500', 10) || 500, 5000);
    const offset = Math.max(parseInt(query.get('offset') || '0', 10) || 0, 0);
    if (!q && !tags && !sizeMin && !sizeMax && !dateFrom && !dateTo && !typeParam && !starredOnly) {
      sendJson(res, { success: true, total: 0, files: [] });
      return true;
    }

    // 优先使用 FTS5 搜索（更快），fallback 到 LIKE
    let results = db.searchFilesFTS(q, tags, {
      fuzzy: true, limit, offset, tagMatch,
      size_min: sizeMinBytes,
      size_max: sizeMaxBytes,
      date_from: dateFrom,
      date_to: dateTo,
      type: actualTypeFilter,
      starred: starredOnly,
      mode: searchMode
    });
    if (!results) {
      // FTS5 不可用，fallback 到 LIKE 搜索
      results = db.searchFiles(q, tags, {
        fuzzy: true, limit: limit + offset, tagMatch,
        size_min: sizeMinBytes,
        size_max: sizeMaxBytes,
        date_from: dateFrom,
        date_to: dateTo,
        type: actualTypeFilter,
        starred: starredOnly,
        mode: searchMode
      });
    }

    const total = results.length;

    const sort = query.get('sort') || 'updated_at';
    const order = (query.get('order') || 'desc').toLowerCase();
    const dir = order === 'asc' ? 1 : -1;
    if (sort === 'filename') {
      results.sort((a, b) => dir * a.filename.localeCompare(b.filename));
    } else if (sort === 'size') {
      results.sort((a, b) => dir * (a.size - b.size));
    } else if (sort === 'updated_at') {
      results.sort((a, b) => dir * (a.updated_at - b.updated_at));
    } else if (sort === 'created_at') {
      results.sort((a, b) => dir * (a.created_at - b.created_at));
    }

    // Apply offset/limit after sorting
    results = results.slice(offset, offset + limit);

    sendJson(res, {
      success: true,
      total,
      files: results.map((file) => ({
        id: file.id,
        name: file.filename,
        highlightedName: file.highlighted_name || null, // FTS5 snippet for display; safe by design (FTS5 tokenizes escaped content)
        size: file.size,
        type: file.type,
        hash: file.hash,
        createdAt: file.created_at * 1000,
        updatedAt: file.updated_at * 1000,
        tags: file.tags || '',
        starred: file.starred === 1,
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

  // GET /api/recent-files - recently accessed files (uses file_access_log)
  if (pathname === '/api/recent-files' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const limit = Math.min(parseInt(query.get('limit') || '20', 10) || 20, 100);
    const files = db.getRecentlyAccessedFiles(limit);

    sendJson(res, {
      success: true,
      files: files.map((f) => ({
        id: f.id,
        name: f.filename,
        size: f.size,
        type: f.type,
        hash: f.hash,
        createdAt: f.created_at * 1000,
        updatedAt: f.updated_at * 1000,
        tags: f.tags || '',
        starred: f.starred === 1,
        lastAccessedAt: f.last_accessed_at * 1000,
        content_type: f.content_type || null
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
      const autoTags = body.auto_tags !== false; // default true

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

      // Auto-apply smart tag suggestions (type + name based)
      if (autoTags && result) {
        const mime = result.content_type || '';
        const suggested = db.suggestTags(filename, mime);
        if (suggested.length > 0) {
          const existing = result.tags ? result.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
          const merged = [...new Set([...existing, ...suggested])].join(',');
          db.updateFile(result.id, { tags: merged });
          result.tags = merged;
        }
      }

      db.addAuditLog('upload', filename, getClientIp(req), auth.token);
      sendJson(res, { success: true, file: result });
      global.broadcastSSE({ type: 'files_changed' });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  // GET /api/suggest-tags - get tag suggestions for a filename (for preview before upload)
  if (pathname === '/api/suggest-tags' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const filename = (query.get('filename') || '').trim();
    const mime = query.get('mime') || '';
    const suggestions = db.suggestTags(filename, mime);
    sendJson(res, { success: true, suggestions });
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
        updated_at: file.updated_at * 1000,
        created_at: file.created_at ? file.created_at * 1000 : undefined,
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

  // POST /api/upload-text - create a new text file
  if (pathname === '/api/upload-text' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    try {
      const body = await readJsonBody(req);
      const filename = (body.filename || '').trim();
      const content = body.content !== undefined ? String(body.content) : '';

      if (!filename) {
        sendJson(res, { success: false, error: 'filename required' }, 400);
        return true;
      }

      // Check if file already exists
      const existing = db.getFileByName(filename);
      if (existing) {
        sendJson(res, { success: false, error: 'File already exists, use PUT /api/content to update' }, 409);
        return true;
      }

      const file = db.addFile(filename, content, 'text');
      db.addAuditLog('upload_text', filename, getClientIp(req), auth.token);
      sendJson(res, { success: true, file: { name: file.filename, size: file.size } }, 201);
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

  // GET /api/file-info/:filename - 获取文件完整属性和访问统计
  if (pathname.startsWith('/api/file-info/') && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const filename = decodeURIComponent(pathname.slice('/api/file-info/'.length));
    const file = db.getFileByName(filename);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }

    // 获取访问统计
    const stats = db.getMostAccessedFiles(5, Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60);
    const fileStats = stats.find(s => s.filename === filename) || { access_count: 0, view_count: 0, download_count: 0, last_access: null };
    const recentAccess = db.getFileAccessLog(file.id, 10);

    // 获取版本历史数量
    const versionCount = db.prepare('SELECT COUNT(*) as count FROM file_versions WHERE file_id = ?').get(file.id).count;

    sendJson(res, {
      success: true,
      file: {
        id: file.id,
        name: file.filename,
        type: file.type,
        size: file.size,
        hash: file.hash,
        tags: file.tags,
        encrypted: !!file.encrypted,
        starred: !!file.starred,
        contentType: file.content_type || guessMimeType(file.filename),
        createdAt: file.created_at * 1000,
        updatedAt: file.updated_at * 1000,
        position: file.position
      },
      stats: {
        accessCount: fileStats.access_count || 0,
        viewCount: fileStats.view_count || 0,
        downloadCount: fileStats.download_count || 0,
        lastAccess: fileStats.last_access ? fileStats.last_access * 1000 : null,
        recentAccess: recentAccess.map(r => ({
          action: r.action,
          ip: r.ip,
          timestamp: r.timestamp * 1000
        })),
        versionCount
      }
    });
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
    db.addFileAccessLog(file.id, 'download', getClientIp(req));
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
      if (result.renamed > 0) global.broadcastSSE({ type: 'files_changed' });
      global.broadcastSSE({ type: 'batch_rename', renamed: result.renamed });
      sendJson(res, {
        success: true,
        renamed: result.renamed,
        errors: result.errors
      });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  // POST /api/file-copy-batch - 批量复制文件
  if (pathname === '/api/file-copy-batch' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    try {
      const body = await readJsonBody(req);
      if (!body || !Array.isArray(body.operations)) {
        sendJson(res, { success: false, error: 'operations array required' }, 400);
        return true;
      }
      if (body.operations.length > 500) {
        sendJson(res, { success: false, error: '最多支持 500 个文件批量复制' }, 400);
        return true;
      }

      const result = db.batchCopy(
        body.operations.map(op => op.filename),
        body.destFolder || ''
      );

      // batchCopy returns { success, results } or { success: false, results, error }
      const copied = result.results ? result.results.filter(r => r.success).length : 0;
      const errors = result.results ? result.results.filter(r => !r.success) : [];

      if (copied > 0) {
        global.broadcastSSE({ type: 'files_changed' });
        global.broadcastSSE({ type: 'batch_copy', copied });
        db.addAuditLog('batch_copy', `批量复制 ${copied} 个文件到 ${body.destFolder || '根目录'}`, getClientIp(req), auth.token);
      }

      sendJson(res, { success: true, copied, errors });
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

  // POST /api/files/batch-delete - 批量删除（进回收站）
  if (pathname === '/api/files/batch-delete' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    try {
      const body = await readJsonBody(req);
      if (!body || !Array.isArray(body.filenames)) {
        sendJson(res, { success: false, error: 'filenames array required' }, 400);
        return true;
      }
      if (body.filenames.length === 0) {
        sendJson(res, { success: false, error: 'filenames 不能为空' }, 400);
        return true;
      }
      if (body.filenames.length > 500) {
        sendJson(res, { success: false, error: '一次最多删除 500 个文件' }, 400);
        return true;
      }

      const result = db.deleteFiles(body.filenames);
      if (result.deleted > 0) {
        db.addAuditLog('batch_delete', `${result.deleted} 个文件移入回收站`, getClientIp(req), auth.token);
        // 广播变更给其他设备
        global.broadcastSSE({ type: 'batch_delete', filenames: body.filenames });
      }

      sendJson(res, {
        success: true,
        deleted: result.deleted,
        failed: result.failed,
        errors: result.errors.length > 0 ? result.errors : undefined
      });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  // POST /api/files/batch-move - 批量移动文件到目标文件夹
  if (pathname === '/api/files/batch-move' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    try {
      const body = await readJsonBody(req);
      if (!body || !Array.isArray(body.filenames)) {
        sendJson(res, { success: false, error: 'filenames array required' }, 400);
        return true;
      }
      if (body.filenames.length === 0) {
        sendJson(res, { success: false, error: 'filenames 不能为空' }, 400);
        return true;
      }
      if (body.filenames.length > 500) {
        sendJson(res, { success: false, error: '一次最多移动 500 个文件' }, 400);
        return true;
      }

      const result = db.batchMove(body.filenames, body.destFolder || '');
      if (result.error) {
        sendJson(res, { success: false, error: result.error, results: result.results }, 400);
        return true;
      }

      if (result.results.some(r => r.success)) {
        global.broadcastSSE({ type: 'files_changed' });
      }
      global.broadcastSSE({ type: 'batch_move', moved: result.results.filter(r => r.success).length });
      sendJson(res, {
        success: true,
        moved: result.results.filter(r => r.success).length,
        failed: result.results.filter(r => !r.success).length,
        results: result.results
      });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  // POST /api/files/batch-copy - 批量复制文件到目标文件夹
  if (pathname === '/api/files/batch-copy' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    try {
      const body = await readJsonBody(req);
      if (!body || !Array.isArray(body.filenames)) {
        sendJson(res, { success: false, error: 'filenames array required' }, 400);
        return true;
      }
      if (body.filenames.length === 0) {
        sendJson(res, { success: false, error: 'filenames 不能为空' }, 400);
        return true;
      }
      if (body.filenames.length > 500) {
        sendJson(res, { success: false, error: '一次最多复制 500 个文件' }, 400);
        return true;
      }

      const result = db.batchCopy(body.filenames, body.destFolder || '');
      if (result.error) {
        sendJson(res, { success: false, error: result.error, results: result.results }, 400);
        return true;
      }

      if (result.results.some(r => r.success)) {
        global.broadcastSSE({ type: 'files_changed' });
      }
      global.broadcastSSE({ type: 'batch_copy', copied: result.results.filter(r => r.success).length });
      sendJson(res, {
        success: true,
        copied: result.results.filter(r => r.success).length,
        failed: result.results.filter(r => !r.success).length,
        results: result.results
      });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }


  // POST /api/folders - 创建新文件夹
  if (pathname === '/api/folders' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1024) { body = ''; } });
    req.on('end', async () => {
      try {
        const { name, parent } = JSON.parse(body || '{}');
        if (!name || typeof name !== 'string' || !name.trim()) {
          sendJson(res, { success: false, error: '文件夹名称不能为空' }, 400);
          return;
        }
        const safeName = name.trim().replace(/\//g, '_');
        const folderPath = parent ? `${parent.trim()}/${safeName}` : safeName;
        const absolutePath = path.join(ctx.storageDir, folderPath);
        const fs2 = require('fs');
        fs2.mkdirSync(absolutePath, { recursive: true });
        sendJson(res, { success: true, path: folderPath });
      } catch (err) {
        sendJson(res, { success: false, error: err.message }, 400);
      }
    });
    return true;
  }

  // GET /api/thumbnail/:filename - serve resized image thumbnail
  if (pathname.startsWith('/api/thumbnail/') && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const filename = decodeURIComponent(pathname.slice('/api/thumbnail/'.length));
    const file = db.getFileByName(filename);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>');
      return true;
    }

    const mime = file.content_type || guessMimeType(filename);
    if (!mime.startsWith('image/') && !mime.startsWith('video/')) {
      res.writeHead(415, { 'Content-Type': 'text/plain' });
      res.end('Unsupported media type');
      return true;
    }

    try {
      const content = file.content || '';
      if (!content) throw new Error('no content');

      // ── IMAGE THUMBNAIL ───────────────────────────────────────────────────────
      if (mime.startsWith('image/')) {
        const buf = Buffer.from(content, 'base64');
        const thumb = await sharp(buf)
          .resize(128, 128, { fit: 'cover', position: 'centre' })
          .jpeg({ quality: 75 })
          .toBuffer();
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': thumb.length,
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(thumb);
        return true;
      }

      // ── VIDEO THUMBNAIL via ffmpeg ───────────────────────────────────────────
      if (mime.startsWith('video/')) {
        const { execSync } = require('child_process');
        const path = require('path');
        const fs = require('fs');
        const crypto = require('crypto');

        // Decode base64 to binary and write temp file
        const buf = Buffer.from(content, 'base64');
        const ext = path.extname(filename) || '.mp4';
        const tmpIn = '/tmp/video_thumb_in_' + crypto.randomUUID() + ext;
        const tmpOut = '/tmp/video_thumb_out_' + crypto.randomUUID() + '.jpg';
        fs.writeFileSync(tmpIn, buf);

        try {
          // Extract frame at 10% of video duration using ffmpeg
          execSync(
            'ffmpeg -y -ss 00:00:01 -i "' + tmpIn + '" -vframes 1 -vf "scale=128:128:force_original_aspect_ratio=decrease,pad=128:128:(ow-iw)/2:(oh-ih)/2" -q:v 2 "' + tmpOut + '" 2>/dev/null',
            { timeout: 15000, stdio: 'ignore' }
          );

          if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size === 0) {
            throw new Error('ffmpeg produced no output');
          }

          // Resize to ensure consistent 128x128 output with sharp
          const thumb = await sharp(tmpOut)
            .resize(128, 128, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 75 })
            .toBuffer();

          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': thumb.length,
            'Cache-Control': 'public, max-age=86400'
          });
          res.end(thumb);
        } finally {
          try { fs.unlinkSync(tmpIn); } catch (_) {}
          try { fs.unlinkSync(tmpOut); } catch (_) {}
        }
        return true;
      }
    } catch (err) {
      console.error('Thumbnail generation failed for', filename, err.message);
      const content = file.content || '';
      if (content && mime.startsWith('image/')) {
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=3600'
        });
        res.end(Buffer.from(content, 'base64'));
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Thumbnail generation failed');
      }
    }
    return true;
  }

  // GET /api/file-path/:filename - get full file path + open in Finder (macOS)
  if (pathname.startsWith('/api/file-path/') && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const filename = decodeURIComponent(pathname.slice('/api/file-path/'.length));
    const file = db.getFileByName(filename);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }
    const fullPath = path.join(ctx.storageDir, file.virtual_folder || '', file.filename);
    // Open containing folder in Finder (macOS only)
    const { execSync } = require('child_process');
    try {
      execSync('open -R ' + JSON.stringify(fullPath), { stdio: 'ignore' });
    } catch (e) { /* non-fatal */ }
    sendJson(res, { success: true, path: fullPath });
    return true;
  }

  return false;
};
