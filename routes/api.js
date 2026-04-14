/**
 * routes/api.js - minimal system APIs
 */

module.exports = async function handleApiRoutes(req, res, pathname, query, ctx) {
  const { db, sendJson, authRequired, VERSION, getClientIp, SHARE_TOKEN, addAuditLog, I18N, t, getShareToken } = ctx;
  const { method } = req;

  // ── i18n: Get translations ────────────────────────────────────────
  if (pathname === '/api/i18n' && method === 'GET') {
    const lang = (query.get('lang') || 'zh').toLowerCase();
    const supported = ['en', 'zh'];
    const targetLang = supported.includes(lang) ? lang : 'zh';
    const dict = I18N[targetLang] || I18N.zh;
    sendJson(res, { success: true, lang: targetLang, dict });
    return true;
  }

  if (pathname === '/api/health' && method === 'GET') {
    const uptime = Math.floor(process.uptime());
    const mem = process.memoryUsage();
    sendJson(res, {
      status: 'ok',
      version: VERSION,
      token: getShareToken(),
      uptime,
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024)
      }
    });
    return true;
  }

  // ── Settings: Rotate Token ────────────────────────────────────────
  if (pathname === '/api/settings/rotate-token' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const newToken = rotateShareToken();
    addAuditLog('token_rotate', null, getClientIp(req));
    sendJson(res, { success: true, token: newToken });
    return true;
  }

  // ── WebSocket Token ──────────────────────────────────────────────
  // GET /api/ws-token - get a short-lived WebSocket connection token
  if (pathname === '/api/ws-token' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    // Short-lived token bound to current SHARE_TOKEN
    const { generateToken } = require('../db');
    const token = generateToken('ws-session', 300);
    sendJson(res, { success: true, token });
    return true;
  }

  if (pathname === '/api/storage' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const count = db.getFileCount();
    const totalSize = db.getTotalStorageSize();
    const stats = db.getStorageStats();
    sendJson(res, { count, totalSize, maxSize: 10 * 1024 * 1024 * 1024, ...stats });
    return true;
  }

  // GET /api/duplicates - find duplicate files (same hash)
  if (pathname === '/api/duplicates' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const groups = db.findDuplicates();
    sendJson(res, { success: true, groups });
    return true;
  }

  // DELETE /api/files/:id - delete a file by id (used by duplicate finder)
  if (pathname.match(/^\/api\/files\/(\d+)$/) && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const fileId = parseInt(pathname.match(/^\/api\/files\/(\d+)$/)[1], 10);
    const file = db.prepare('SELECT filename FROM files WHERE id = ?').get(fileId);
    if (!file) { sendJson(res, { success: false, error: '文件不存在' }, 404); return true; }
    db.deleteFile(file.filename);
    global.broadcastSSE({ type: 'files_changed' });
    sendJson(res, { success: true });
    return true;
  }

  // ── Device Management ──────────────────────────────────────────────
  if (pathname === '/api/devices' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const devices = db.listDevices();
    sendJson(res, { success: true, devices });
    return true;
  }

  if (pathname === '/api/devices/online' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const devices = db.getOnlineDevices();
    sendJson(res, { success: true, devices });
    return true;
  }

  if (pathname.startsWith('/api/devices/') && pathname.endsWith('/ping') && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const deviceId = pathname.slice('/api/devices/'.length, -'/ping'.length);
    const { deviceName } = (await readJsonBody(req)) || {};
    if (deviceName) {
      db.touchDevice(deviceId);
      db.setDeviceOnline(deviceId);
    }
    sendJson(res, { success: true });
    return true;
  }

  if (pathname.startsWith('/api/devices/') && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const id = pathname.slice('/api/devices/'.length);
    // Exclude sub-paths
    if (id.includes('/')) { sendJson(res, { success: false, error: 'Invalid device id' }, 400); return true; }
    db.deleteDevice(id);
    sendJson(res, { success: true });
    return true;
  }

  if (pathname.startsWith('/api/devices/') && pathname.endsWith('/offline') && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const deviceId = pathname.slice('/api/devices/'.length, -'/offline'.length);
    db.setDeviceOffline(deviceId);
    sendJson(res, { success: true });
    return true;
  }

  // ── Sync Status ─────────────────────────────────────────────────────
  if (pathname === '/api/sync/status' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const status = db.getSyncStatus();
    sendJson(res, { success: true, ...status });
    return true;
  }

  if (pathname === '/api/sync/logs' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const since = parseInt(query.get('since') || '0', 10);
    const logs = db.getUnsyncedLogs(since);
    sendJson(res, { success: true, logs });
    return true;
  }

  // GET /api/sync/delta — incremental sync delta since a given timestamp
  // Returns creates/updates/deletes with full file metadata, plus total count
  if (pathname === '/api/sync/delta' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const since = Math.max(0, parseInt(query.get('since') || '0', 10));
    const limit = Math.min(Math.max(1, parseInt(query.get('limit') || '500', 10) || 500), 2000);
    const offset = Math.max(0, parseInt(query.get('offset') || '0', 10) || 0);

    const logs = db.getUnsyncedLogs(since);
    const total = logs.length;
    const page = logs.slice(offset, offset + limit);

    const creates = [], updates = [], deletes = [];
    for (const log of page) {
      const entry = {
        id: log.file_id,
        filename: log.filename,
        action: log.action,
        timestamp: log.timestamp * 1000,
        hash: log.current_hash || log.hash,
        size: log.size_bytes || 0
      };
      if (log.action === 'create') {
        creates.push(entry);
      } else if (log.action === 'update' || log.action === 'rename') {
        updates.push(entry);
      } else if (log.action === 'delete') {
        deletes.push(entry);
      }
    }

    sendJson(res, { success: true, since, total, offset, limit, creates, updates, deletes });
    return true;
  }

  if (pathname === '/api/sync/mark' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    let body = '', size = 0;
    const limit = 1024 * 1024; // 1MB max for sync mark payload
    req.on('data', d => {
      size += d.length;
      if (size > limit) { req.destroy(); return; }
      body += d;
    });
    req.on('end', () => {
      try {
        const { ids = [] } = JSON.parse(body);
        db.markLogsSynced(ids);
        sendJson(res, { success: true, marked: ids.length });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // ── Sync Conflicts ─────────────────────────────────────────────────
  // GET /api/sync/conflicts — list unresolved conflicts
  if (pathname === '/api/sync/conflicts' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const conflicts = db.getUnresolvedConflicts();
    sendJson(res, { success: true, conflicts });
    return true;
  }

  // GET /api/sync/conflicts/:id — get single conflict with content
  if (pathname.match(/^\/api\/sync\/conflicts\/\d+$/) && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const conflictId = parseInt(pathname.split('/')[3], 10);
    const db = require('../db');
    const conflict = db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(conflictId);
    if (!conflict) { sendJson(res, { success: false, error: 'Not found' }, 404); return true; }
    sendJson(res, { success: true, conflict });
    return true;
  }

  // POST /api/sync/conflicts/:id/resolve — resolve a conflict
  // body: { resolution: 'keep_local' | 'keep_remote' | 'keep_both' }
  if (pathname.match(/^\/api\/sync\/conflicts\/\d+\/resolve$/) && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const conflictId = parseInt(pathname.split('/')[3], 10);
    const db = require('../db');
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { resolution } = JSON.parse(body);
        if (!['keep_local', 'keep_remote', 'keep_both'].includes(resolution)) {
          sendJson(res, { success: false, error: 'Invalid resolution' }, 400);
          return;
        }
        const conflict = db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(conflictId);
        if (!conflict) { sendJson(res, { success: false, error: 'Not found' }, 404); return true; }

        let winningContent = null;
        if (resolution === 'keep_local') {
          winningContent = conflict.local_content;
        } else if (resolution === 'keep_remote') {
          winningContent = conflict.remote_content;
        } else if (resolution === 'keep_both') {
          // Keep remote as current, save local as a backup file
          winningContent = conflict.remote_content;
          const backupName = conflict.filename + '.conflict-backup-' + Date.now();
          if (conflict.local_content !== null) {
            db.addFile(backupName, conflict.local_content, 'text');
            db.addSyncLog(null, backupName, 'create', conflict.local_hash, conflict.local_device_id, 0);
          }
        }
        db.resolveConflict(conflictId, resolution, winningContent);
        if (global.broadcastSSE) global.broadcastSSE({ type: 'files_changed' });
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // DELETE /api/sync/conflicts/:id — dismiss/delete a conflict
  if (pathname.match(/^\/api\/sync\/conflicts\/\d+$/) && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const conflictId = parseInt(pathname.split('/')[3], 10);
    const db = require('../db');
    db.dismissConflict(conflictId);
    sendJson(res, { success: true });
    return true;
  }

  // ── Audit Logs ──────────────────────────────────────────────────────
  if (pathname === '/api/audit/logs' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const limit = Math.min(parseInt(query.get('limit') || '100', 10), 1000);
    const offset = parseInt(query.get('offset') || '0', 10);
    const action = query.get('action') || null;
    const logs = db.listAuditLogs(limit, offset, action ? { action } : {});
    const stats = db.getAuditStats();
    sendJson(res, { success: true, logs, stats });
    return true;
  }

  // ── Audit Logs CSV Export ────────────────────────────────────────────
  if (pathname === '/api/audit/export' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const action = query.get('action') || null;
    const filters = action ? { action } : {};
    const csv = db.exportAuditLogsCSV(filters);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log-' + Date.now() + '.csv"');
    res.end(csv);
    return true;
  }

  // POST /api/audit/logs - add manual note
  if (pathname === '/api/audit/logs' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const note = body && body.note ? String(body.note).slice(0, 500) : '';
    if (!note) { sendJson(res, { success: false, error: 'Note required' }, 400); return true; }
    db.addAuditLog('note', note, getClientIp(req), auth.token);
    sendJson(res, { success: true });
    return true;
  }

  // DELETE /api/audit/logs - clear old logs (requires confirm: { confirm: true, olderThanDays: 30 })
  if (pathname === '/api/audit/clear' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    if (!body || body.confirm !== true) { sendJson(res, { success: false, error: 'Confirmation required' }, 400); return true; }
    const days = Math.max(1, Math.min(parseInt(body.olderThanDays || '90', 10), 365));
    const deleted = db.clearAuditLogs(days);
    db.addAuditLog('audit_clear', `Cleared logs older than ${days} days (${deleted} entries)`, getClientIp(req), auth.token);
    sendJson(res, { success: true, deleted });
    return true;
  }

  // ── Rate Limit Status ───────────────────────────────────────────────
  if (pathname === '/api/rate-limit/check' && method === 'GET') {
    const ip = getClientIp(req);
    const key = query.get('key') || `share_verify:${ip}:default`;
    const status = db.checkRateLimit(key);
    sendJson(res, { success: true, ...status });
    return true;
  }

  // ── Rate Limit Admin: List all rate limits ──────────────────────────
  if (pathname === '/api/rate-limits' && method === 'GET') {
    const limits = db.listRateLimits(200);
    sendJson(res, { success: true, limits });
    return true;
  }

  // ── Rate Limit Admin: Delete specific rate limit ─────────────────────
  if (pathname.startsWith('/api/rate-limits/') && method === 'DELETE') {
    const key = pathname.replace('/api/rate-limits/', '');
    const deleted = db.deleteRateLimit(key);
    if (deleted) {
      db.addAuditLog('rate_limit_unblock', `key=${key}`, getClientIp(req));
      sendJson(res, { success: true, message: 'Rate limit removed' });
    } else {
      sendJson(res, { success: false, error: 'Not found' }, 404);
    }
    return true;
  }

  // ── Auth: Login (exchange static token for dynamic db tokens) ──────
  if (pathname === '/api/auth/login' && method === 'POST') {
    const clientIp = getClientIp(req);
    const rateKey = `login:${clientIp}`;
    const rate = db.checkRateLimit(rateKey);
    if (!rate.allowed) {
      res.setHeader('Retry-After', rate.retryAfter);
      sendJson(res, { success: false, error: `登录尝试次数过多，请 ${Math.ceil(rate.retryAfter / 60)} 分钟后重试`, retryAfter: rate.retryAfter }, 429);
      return true;
    }
    const body = await readJsonBody(req);
    const { password } = body || {};
    if (password !== SHARE_TOKEN) {
      db.recordRateLimitAttempt(rateKey);
      sendJson(res, { success: false, error: 'Invalid credentials' }, 401);
      return true;
    }
    db.recordRateLimitAttempt(rateKey, true);
    const result = db.generateToken(null, 86400 * 7);
    sendJson(res, {
      success: true,
      token: result.token,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt
    });
    return true;
  }

  // ── Auth: Refresh token ─────────────────────────────────────────────
  if (pathname === '/api/auth/refresh' && method === 'POST') {
    const body = await readJsonBody(req);
    const { refreshToken: rt } = body || {};
    if (!rt) {
      sendJson(res, { success: false, error: 'refreshToken required' }, 400);
      return true;
    }
    const result = db.refreshToken(rt);
    if (!result.success) {
      sendJson(res, { success: false, error: result.error }, 401);
      return true;
    }
    sendJson(res, {
      success: true,
      token: result.token,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt
    });
    return true;
  }

  // ── Tags ─────────────────────────────────────────────────────────────────
  if (pathname === '/api/tags' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    db.ensureTagStats();
    const tags = db.getAllTagsWithStats();
    sendJson(res, { success: true, tags });
    return true;
  }

  if (pathname === '/api/tags/list' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    db.ensureTagStats();
    const tags = db.getAllTagsWithStats();
    sendJson(res, { success: true, tags });
    return true;
  }

  if (pathname === '/api/file-tags/batch' && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { files = [], action, tags: tagStr } = body;
    if (!Array.isArray(files) || !action || !tagStr) {
      sendJson(res, { success: false, error: 'files, action, tags required' }, 400);
      return true;
    }
    if (files.length === 0) {
      sendJson(res, { success: true, updated: 0, failed: 0, total: 0 });
      return true;
    }
    const tagList = tagStr.split(',').map(t => t.trim()).filter(Boolean);
    const db2 = require('../db').getDb();

    // Batch fetch all files in one query (avoid N getFileByName calls)
    const placeholders = files.map(() => '?').join(',');
    const allFiles = db2.prepare(`SELECT id, filename, tags FROM files WHERE filename IN (${placeholders})`).all(...files);
    const fileMap = new Map(allFiles.map(f => [f.filename, f]));

    let updated = 0, failed = 0;
    for (const filename of files) {
      try {
        const file = fileMap.get(filename);
        if (!file) { failed++; continue; }
        const current = file.tags ? file.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
        let next;
        if (action === 'add') {
          const merged = new Set([...current, ...tagList]);
          next = Array.from(merged).join(',');
        } else if (action === 'remove') {
          const removeSet = new Set(tagList);
          next = current.filter(t => !removeSet.has(t)).join(',');
        } else {
          failed++; continue;
        }
        db2.prepare('UPDATE files SET tags = ?, updated_at = unixepoch() WHERE id = ?').run(next, file.id);
        // FTS5 trigger fires automatically on UPDATE — no manual index update needed
        updated++;
      } catch (e) {
        failed++;
      }
    }

    // Update tag stats for new tags
    if (tagList.length > 0 && updated > 0) {
      for (const t of tagList) {
        db2.prepare(`INSERT OR IGNORE INTO tag_stats(tag, count) VALUES(?, 0)`).run(t);
        db2.prepare(`UPDATE tag_stats SET count = (SELECT COUNT(*) FROM files WHERE LOWER(tags) LIKE ?) WHERE tag = ?`).run(`%${t.toLowerCase()}%`, t);
      }
    }

    if (updated > 0) {
      global.broadcastSSE({ type: 'files_changed' });
    }
    sendJson(res, { success: true, updated, failed, total: files.length });
    return true;
  }

  if (pathname === '/api/tags' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { tag } = body || {};
    if (!tag) {
      sendJson(res, { success: false, error: 'tag name required' }, 400);
      return true;
    }
    const color = db.getSuggestedColor(tag);
    db.setTagColor(tag, color);
    sendJson(res, { success: true, tag, color });
    return true;
  }

  if (pathname === '/api/tags/colors' && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { tag, color } = body || {};
    if (!tag || !color) {
      sendJson(res, { success: false, error: 'tag and color required' }, 400);
      return true;
    }
    db.setTagColor(tag, color);
    sendJson(res, { success: true, tag, color });
    return true;
  }

  if (pathname.startsWith('/api/tags/') && pathname.endsWith('/delete') && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const tag = decodeURIComponent(pathname.slice('/api/tags/'.length, -'/delete'.length));
    if (!tag) {
      sendJson(res, { success: false, error: 'tag name required' }, 400);
      return true;
    }
    const count = db.deleteTagFromAllFiles(tag);
    db.deleteTagColor(tag);
    sendJson(res, { success: true, tag, removed: count });
    global.broadcastSSE({ type: 'files_changed' });
    return true;
  }

  if (pathname === '/api/tags/rename' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { oldTag, newTag } = body || {};
    if (!oldTag || !newTag) {
      sendJson(res, { success: false, error: 'oldTag and newTag required' }, 400);
      return true;
    }
    const result2 = db.renameTagGlobally(oldTag, newTag);
    if (result2.error) {
      sendJson(res, { success: false, error: result2.error }, 400);
      return true;
    }
    sendJson(res, { success: true, oldTag, newTag, updated: result2.updated });
    global.broadcastSSE({ type: 'files_changed' });
    return true;
  }

  // POST /api/tags/merge - 合并多个标签到目标标签
  if (pathname === '/api/tags/merge' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { sources = [], target } = body || {};
    if (!Array.isArray(sources) || !target || sources.length === 0) {
      sendJson(res, { success: false, error: 'sources (array) and target required' }, 400);
      return true;
    }
    const result = db.mergeTags(sources, target);
    if (result.error) {
      sendJson(res, { success: false, error: result.error }, 400);
      return true;
    }
    sendJson(res, { success: true, target, updated: result.updated, deletedSources: sources.length });
    global.broadcastSSE({ type: 'files_changed' });
    return true;
  }

  // POST /api/file-tags/search-batch - batch tag all search results (bypasses 30-file limit)
  if (pathname === '/api/file-tags/search-batch' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { q, mode = 'normal', action, tags: tagStr } = body;
    if (!q || !action || !tagStr) {
      sendJson(res, { success: false, error: 'q, action, tags required' }, 400);
      return true;
    }
    const tagList = tagStr.split(',').map(t => t.trim()).filter(Boolean);
    const matched = db.searchFiles(q, null, { limit: 10000, mode: mode });
    if (!matched.length) { sendJson(res, { success: true, updated: 0, failed: 0, total: 0 }); return true; }
    const filenames = matched.map(f => f.filename);
    const placeholders = filenames.map(() => '?').join(',');
    const allFiles = db.getDb().prepare(`SELECT id, filename, tags FROM files WHERE filename IN (${placeholders})`).all(...filenames);
    const fileMap = new Map(allFiles.map(f => [f.filename, f]));
    let updated = 0, failed = 0;
    for (const filename of filenames) {
      try {
        const file = fileMap.get(filename);
        if (!file) { failed++; continue; }
        const current = file.tags ? file.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
        let next;
        if (action === 'add') {
          const merged = new Set([...current, ...tagList]);
          next = Array.from(merged).join(',');
        } else if (action === 'remove') {
          const removeSet = new Set(tagList);
          next = current.filter(t => !removeSet.has(t)).join(',');
        } else { failed++; continue; }
        db.getDb().prepare('UPDATE files SET tags = ?, updated_at = unixepoch() WHERE id = ?').run(next, file.id);
        updated++;
      } catch (e) { failed++; }
    }
    if (tagList.length > 0 && updated > 0) {
      for (const t of tagList) {
        db.getDb().prepare(`INSERT OR IGNORE INTO tag_stats(tag, count) VALUES(?, 0)`).run(t);
        db.getDb().prepare(`UPDATE tag_stats SET count = (SELECT COUNT(*) FROM files WHERE LOWER(tags) LIKE ?) WHERE tag = ?`).run(`%${t.toLowerCase()}%`, t);
      }
    }
    if (updated > 0) global.broadcastSSE({ type: 'files_changed' });
    sendJson(res, { success: true, updated, failed, total: filenames.length });
    return true;
  }

  // DELETE /api/tags/orphans - 清理所有孤立标签（count=0）
  if (pathname === '/api/tags/orphans' && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const result = db.cleanupOrphanTags();
    sendJson(res, { success: true, deleted: result.deleted });
    return true;
  }

  // GET /api/cleanup/suggestions - get storage cleanup suggestions
  if (pathname === '/api/cleanup/suggestions' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const suggestions = db.getCleanupSuggestions();
    sendJson(res, { success: true, suggestions });
    return true;
  }

  // ── Folder Tags ───────────────────────────────────────────────────────────────

  // GET /api/folder-tags - list all tag definitions with folder counts
  if (pathname === '/api/folder-tags' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const tags = db.getAllTagDefinitions();
    sendJson(res, { success: true, tags });
    return true;
  }

  // POST /api/folder-tags - create a new tag definition
  if (pathname === '/api/folder-tags' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { name, color, icon } = body || {};
    if (!name) {
      sendJson(res, { success: false, error: 'name required' }, 400);
      return true;
    }
    const result = db.createTagDefinition(name, color || '#e0e7ff', icon || '');
    sendJson(res, { success: true, tag: result });
    return true;
  }

  // PUT /api/folder-tags/:id - update a tag definition
  if (pathname.match(/^\/api\/folder-tags\/(\d+)$/) && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const id = parseInt(pathname.match(/^\/api\/folder-tags\/(\d+)$/)[1]);
    const body = await readJsonBody(req);
    const { name, color, icon } = body || {};
    if (!name && !color && !icon) {
      sendJson(res, { success: false, error: 'name, color or icon required' }, 400);
      return true;
    }
    db.updateTagDefinition(id, { name, color, icon });
    sendJson(res, { success: true });
    return true;
  }

  // DELETE /api/folder-tags/:id - delete a tag definition
  if (pathname.match(/^\/api\/folder-tags\/(\d+)$/) && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const id = parseInt(pathname.match(/^\/api\/folder-tags\/(\d+)$/)[1]);
    db.deleteTagDefinition(id);
    sendJson(res, { success: true });
    return true;
  }

  // GET /api/folders/:path/tags - get tags for a folder
  if (pathname.match(/^\/api\/folders\/[^/]+\/tags$/) && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const parts = pathname.split('/');
    const folderPath = decodeURIComponent(parts[3]);
    const tags = db.getFolderTags(folderPath);
    sendJson(res, { success: true, tags });
    return true;
  }

  // PUT /api/folders/:path/tags - set tags for a folder
  if (pathname.match(/^\/api\/folders\/[^/]+\/tags$/) && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const parts = pathname.split('/');
    const folderPath = decodeURIComponent(parts[3]);
    const body = await readJsonBody(req);
    const { tagIds } = body || {};
    if (!Array.isArray(tagIds)) {
      sendJson(res, { success: false, error: 'tagIds array required' }, 400);
      return true;
    }
    db.setFolderTags(folderPath, tagIds);
    sendJson(res, { success: true });
    return true;
  }

  // POST /api/folders/:path/tags/:tagId - add a tag to a folder
  if (pathname.match(/^\/api\/folders\/[^/]+\/tags\/\d+$/) && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const parts = pathname.split('/');
    const folderPath = decodeURIComponent(parts[3]);
    const tagId = parseInt(parts[5]);
    db.addFolderTag(folderPath, tagId);
    sendJson(res, { success: true });
    return true;
  }

  // DELETE /api/folders/:path/tags/:tagId - remove a tag from a folder
  if (pathname.match(/^\/api\/folders\/[^/]+\/tags\/\d+$/) && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const parts = pathname.split('/');
    const folderPath = decodeURIComponent(parts[3]);
    const tagId = parseInt(parts[5]);
    db.removeFolderTag(folderPath, tagId);
    sendJson(res, { success: true });
    return true;
  }

  // GET /api/folder-tags/:tagId/virtual-folders - get VFs with a given tag
  if (pathname.match(/^\/api\/folder-tags\/(\d+)\/virtual-folders$/) && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const tagId = parseInt(pathname.match(/^\/api\/folder-tags\/(\d+)\/virtual-folders$/)[1]);
    const vfs = db.getVirtualFoldersByTag(tagId);
    sendJson(res, { success: true, virtualFolders: vfs });
    return true;
  }

  // GET /api/search/history - 获取搜索历史
  if (pathname === '/api/search/history' && method === 'GET') {
    const limit = parseInt(query.get('limit') || '20', 10);
    const history = db.getSearchHistory(null, limit);
    sendJson(res, { success: true, history });
    return true;
  }

  // POST /api/search/history - 保存搜索记录
  if (pathname === '/api/search/history' && method === 'POST') {
    const body = await readJsonBody(req);
    const { query: searchQuery } = body || {};
    if (searchQuery && searchQuery.trim().length >= 1) {
      db.addSearchHistory(searchQuery.trim());
    }
    sendJson(res, { success: true });
    return true;
  }

  // DELETE /api/search/history - 清除搜索历史（?query=xxx 单项删除）
  if (pathname === '/api/search/history' && method === 'DELETE') {
    const q = query.get('query');
    if (q) {
      db.deleteSearchHistoryItem(q);
    } else {
      db.clearSearchHistory();
    }
    sendJson(res, { success: true });
    return true;
  }

  // GET /api/search/suggest - 搜索自动补全建议
  if (pathname === '/api/search/suggest' && method === 'GET') {
    const q = (query.get('q') || '').trim().toLowerCase();
    if (!q || q.length < 1) {
      sendJson(res, { success: true, suggestions: [] });
      return true;
    }
    const limit = 8;
    const suggestions = [];

    // 1. 匹配文件名
    const filesResult = db.listFiles(200, 0);
    const matchedFiles = (Array.isArray(filesResult) ? filesResult : (filesResult.files || [])).filter(f => (f.filename || '').toLowerCase().includes(q)).slice(0, 5);
    for (const f of matchedFiles) {
      suggestions.push({ text: f.filename, type: 'file' });
    }

    // 2. 匹配标签
    const allTags = db.getAllTagColors ? db.getAllTagColors() : [];
    const matchedTags = allTags.filter(t => t.tag.toLowerCase().includes(q)).slice(0, 3);
    for (const t of matchedTags) {
      suggestions.push({ text: t.tag, type: 'tag' });
    }

    // 3. 匹配搜索历史
    const history = db.getSearchHistory(20);
    const matchedHistory = (Array.isArray(history) ? history : []).filter(h => (h.query || '').toLowerCase().includes(q)).slice(0, 3);
    for (const h of matchedHistory) {
      suggestions.push({ text: h.query, type: 'history' });
    }

    sendJson(res, { success: true, suggestions: suggestions.slice(0, limit) });
    return true;
  }

  // GET /api/search - unified search across files, shares, request links
  if (pathname === '/api/search' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const q = (query.get('q') || '').trim();
    const type = query.get('type') || 'all'; // 'all' | 'files' | 'shares' | 'request-links'
    const limit = Math.min(parseInt(query.get('limit') || '50', 10), 200);
    if (!q || q.length < 1) {
      sendJson(res, { success: true, files: [], shares: [], requestLinks: [] });
      return true;
    }
    const ql = q.toLowerCase();
    const results = { files: [], shares: [], requestLinks: [] };

    if (type === 'all' || type === 'files') {
      // Use proper fuzzy search with FTS5 + BM25 scoring (falls back to in-memory if FTS5 unavailable)
      const matched = db.searchFiles(q, null, { limit: limit, mode: 'normal' });
      results.files = matched.map(function(f) {
        return { id: f.id, filename: f.filename, size: f.size, type: f.type, created_at: f.created_at, updated_at: f.updated_at };
      });
    }

    if (type === 'all' || type === 'shares') {
      const allShares = db.listShares ? (db.listShares() || []) : [];
      const matched = allShares.filter(function(s) {
        return (s.filename || '').toLowerCase().includes(ql) ||
               (s.code || '').toLowerCase().includes(ql) ||
               (s.url || '').toLowerCase().includes(ql);
      }).slice(0, limit);
      results.shares = matched.map(function(s) {
        return { id: s.id, filename: s.filename, code: s.code, url: s.url, expiresAt: s.expiresAt, password: !!s.password };
      });
    }

    if (type === 'all' || type === 'request-links') {
      const allRL = db.listRequestLinks ? (db.listRequestLinks() || []) : [];
      const matched = allRL.filter(function(rl) {
        return (rl.name || '').toLowerCase().includes(ql) ||
               (rl.code || '').toLowerCase().includes(ql);
      }).slice(0, limit);
      results.requestLinks = matched.map(function(rl) {
        return { id: rl.id, name: rl.name, code: rl.code, active: !!rl.active, uploadCount: rl.upload_count };
      });
    }

    sendJson(res, { success: true, q: q, type: type, results: results });
    return true;
  }

  // ── Server-Sent Events: real-time file change notifications ──────────
  if (pathname === '/api/events' && method === 'GET') {
    // Support token via query param (EventSource can't send headers)
    const token = query && query.token;
    if (token) {
      req.headers['authorization'] = 'Bearer ' + token;
    }
    const auth = authRequired(req, res);
    if (!auth) return true;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Send current file count as initial heartbeat
    const fileCount = db.getFileCount();
    res.write('data: ' + JSON.stringify({ type: 'connected', fileCount }) + '\n\n');

    // Register this response as an active SSE client
    if (!global._sseClients) global._sseClients = new Set();
    global._sseClients.add(res);

    req.on('close', () => {
      global._sseClients.delete(res);
    });
    return true;
  }

  // ── Trash: List ────────────────────────────────────────────────────
  if (pathname === '/api/trash' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const limit = Math.min(parseInt(query.get('limit') || '100', 10), 500);
    const items = db.listTrash(limit);
    sendJson(res, { success: true, items });
    return true;
  }

  // ── Trash: Restore ─────────────────────────────────────────────────
  if (pathname === '/api/trash/restore' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { trashId } = body;
    if (!trashId) { sendJson(res, { success: false, error: 'trashId required' }, 400); return true; }
    const result = db.restoreFromTrash(trashId);
    sendJson(res, result);
    return true;
  }

  // ── Trash: Permanent Delete ─────────────────────────────────────────
  if (pathname === '/api/trash/delete' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { trashId } = body;
    if (!trashId) { sendJson(res, { success: false, error: 'trashId required' }, 400); return true; }
    const result = db.permanentlyDeleteTrash(trashId);
    sendJson(res, result);
    return true;
  }

  // ── Trash: Batch Restore ──────────────────────────────────────────
  if (pathname === '/api/trash/restore-batch' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { trashIds } = body;
    if (!Array.isArray(trashIds) || trashIds.length === 0) {
      sendJson(res, { success: false, error: 'trashIds array required' }, 400);
      return true;
    }
    const restored = [];
    const failed = [];
    for (const trashId of trashIds) {
      const result = db.restoreFromTrash(trashId);
      if (result.success) restored.push(trashId);
      else failed.push({ trashId, error: result.error });
    }
    sendJson(res, { success: true, restored: restored.length, failed });
    return true;
  }

  // ── Trash: Batch Permanent Delete ─────────────────────────────────
  if (pathname === '/api/trash/delete-batch' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { trashIds } = body;
    if (!Array.isArray(trashIds) || trashIds.length === 0) {
      sendJson(res, { success: false, error: 'trashIds array required' }, 400);
      return true;
    }
    const deleted = [];
    const failed = [];
    for (const trashId of trashIds) {
      const result = db.permanentlyDeleteTrash(trashId);
      if (result.success) deleted.push(trashId);
      else failed.push({ trashId, error: result.error });
    }
    sendJson(res, { success: true, deleted: deleted.length, failed });
    return true;
  }

  // ── Trash: Empty ───────────────────────────────────────────────────
  if (pathname === '/api/trash/empty' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const result = db.emptyTrash();
    sendJson(res, result);
    return true;
  }

  // POST /api/trash/cleanup-old — permanently delete trash items older than 30 days
  if (pathname === '/api/trash/cleanup-old' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
    const result = db.emptyTrash(cutoff);
    sendJson(res, { success: true, deleted: result.deleted, freedBytes: result.freedBytes });
    global.broadcastSSE({ type: 'files_changed' });
    return true;
  }

  // GET /api/trash/auto-clean?days=N — delete trash items older than N days
  if (pathname === '/api/trash/auto-clean' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const query = new URLSearchParams(pathname.split('?')[1] || '');
    const days = parseInt(query.get('days') || '0', 10);
    if (!days) { sendJson(res, { success: true, deleted: 0 }); return true; }
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const result = db.emptyTrash(cutoff);
    sendJson(res, result);
    return true;
  }

  // ── File Versions: List ────────────────────────────────────────────
  if (pathname === '/api/versions' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const query = new URLSearchParams(pathname.split('?')[1] || '');
    const filename = query.get('filename');
    if (!filename) { sendJson(res, { success: false, error: 'filename required' }, 400); return true; }
    const file = db.getFileByName(filename);
    if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return true; }
    const versions = db.listFileVersions(file.id, 20);
    const count = db.getFileVersionCount(file.id);
    sendJson(res, { success: true, versions, total: count, currentHash: file.hash });
    return true;
  }

  // ── File Versions: Get content ─────────────────────────────────────
  if (pathname.startsWith('/api/versions/') && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const versionId = parseInt(pathname.split('/')[3], 10);
    if (!versionId) { sendJson(res, { success: false, error: 'versionId required' }, 400); return true; }
    const version = db.getFileVersion(versionId);
    if (!version) { sendJson(res, { success: false, error: 'Version not found' }, 404); return true; }
    sendJson(res, { success: true, version });
    return true;
  }

  // ── File Versions: Restore ──────────────────────────────────────────
  if (pathname.match(/^\/api\/versions\/\d+\/restore$/) && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const parts = pathname.split('/');
    const versionId = parseInt(parts[3], 10);
    if (!versionId) { sendJson(res, { success: false, error: 'versionId required' }, 400); return true; }
    const version = db.getFileVersion(versionId);
    if (!version) { sendJson(res, { success: false, error: 'Version not found' }, 404); return true; }
    const file = db.getFileByName(version.filename);
    if (!file) { sendJson(res, { success: false, error: 'Original file not found' }, 404); return true; }
    db.updateFile(file.id, { content: version.content });
    db.addAuditLog('version_restore', `filename=${version.filename}, versionId=${versionId}`, getClientIp(req));
    sendJson(res, { success: true });
    return true;
  }

  // Virtual folder routes
  if (pathname === '/api/virtual-folders' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const folders = db.listVirtualFolders();
    sendJson(res, { success: true, folders });
    return true;
  }

  if (pathname === '/api/virtual-folders' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { name, description, color } = body;
    if (!name) { sendJson(res, { success: false, error: 'name required' }, 400); return true; }
    const folder = db.createVirtualFolder(name, description, color);
    sendJson(res, { success: true, folder });
    return true;
  }

  if (pathname.startsWith('/api/virtual-folders/') && pathname.endsWith('/files') && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const folderId = parseInt(pathname.split('/')[3], 10);
    const folder = db.getVirtualFolder(folderId);
    const files = db.getVirtualFolderFiles(folderId);
    const stats = folder ? db.getVirtualFolderSize(folderId) : null;
    sendJson(res, { success: true, files, folder: folder ? { ...folder, ...stats } : null });
    return true;
  }

// GET /api/virtual-folders/:id - get single VF with stats
  if (pathname.match(/^\/api\/virtual-folders\/\d+$/) && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const folderId = parseInt(pathname.split('/')[3], 10);
    const folder = db.getVirtualFolder(folderId);
    if (!folder) { sendJson(res, { success: false, error: 'Folder not found' }, 404); return true; }
    const stats = db.getVirtualFolderSize(folderId);
    sendJson(res, { success: true, folder: { ...folder, ...stats } });
    return true;
  }

  // GET /api/virtual-folders/:id/size-analysis - type breakdown + top files
  if (pathname.match(/^\/api\/virtual-folders\/\d+\/size-analysis$/) && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const folderId = parseInt(pathname.split('/')[3], 10);
    const folder = db.getVirtualFolder(folderId);
    if (!folder) { sendJson(res, { success: false, error: 'Folder not found' }, 404); return true; }
    const data = db.getVirtualFolderSizeAnalysis(folderId);
    sendJson(res, { success: true, ...data });
    return true;
  }

  if (pathname.startsWith('/api/virtual-folders/') && !pathname.includes('/files') && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const folderId = parseInt(pathname.split('/')[3], 10);
    const body = await readJsonBody(req);
    const updated = db.updateVirtualFolder(folderId, body);
    sendJson(res, { success: true, folder: updated });
    return true;
  }

  if (pathname.startsWith('/api/virtual-folders/') && !pathname.includes('/files') && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const folderId = parseInt(pathname.split('/')[3], 10);
    db.deleteVirtualFolder(folderId);
    sendJson(res, { success: true });
    global.broadcastSSE({ type: 'files_changed' });
    return true;
  }

  // PUT /api/virtual-folders/:id/password - set or update VF password
  if (pathname.match(/^\/api\/virtual-folders\/\d+\/password$/) && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const folderId = parseInt(pathname.split('/')[3], 10);
    const body = await readJsonBody(req);
    const { password } = body;
    db.setVirtualFolderPassword(folderId, password || null);
    sendJson(res, { success: true });
    global.broadcastSSE({ type: 'files_changed' });
    return true;
  }

  // DELETE /api/virtual-folders/:id/password - remove VF password
  if (pathname.match(/^\/api\/virtual-folders\/\d+\/password$/) && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const folderId = parseInt(pathname.split('/')[3], 10);
    db.setVirtualFolderPassword(folderId, null);
    sendJson(res, { success: true });
    global.broadcastSSE({ type: 'files_changed' });
    return true;
  }

  // POST /api/virtual-folders/:id/verify - verify VF password (public, for client-side unlock)
  if (pathname.match(/^\/api\/virtual-folders\/\d+\/verify$/) && method === 'POST') {
    const folderId = parseInt(pathname.split('/')[3], 10);
    const body = await readJsonBody(req);
    const valid = db.verifyVirtualFolderPassword(folderId, body.password || '');
    if (valid) {
      sendJson(res, { success: true });
    } else {
      sendJson(res, { success: false, error: 'Invalid password' }, 401);
    }
    return true;
  }

  // Add/remove file from virtual folder
  if (pathname.startsWith('/api/virtual-folders/') && pathname.endsWith('/files') && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const folderId = parseInt(pathname.split('/')[3], 10);
    const body = await readJsonBody(req);
    const { fileId } = body;
    if (!fileId) { sendJson(res, { success: false, error: 'fileId required' }, 400); return true; }
    // Quota enforcement: block if VF has quota and adding this file would exceed it
    const vf = db.getVirtualFolder(folderId);
    if (vf && vf.quota_bytes > 0) {
      const file = db.getFile(fileId);
      if (file) {
        const stats = db.getVirtualFolderSize(folderId);
        const effectiveSize = stats.totalSize || 0;
        if (effectiveSize + (file.size || 0) > vf.quota_bytes) {
          sendJson(res, { success: false, error: '配额已满 (' + Math.round(effectiveSize / vf.quota_bytes * 100) + '%) — 请先清理或扩容' }, 403);
          return true;
        }
      }
    }
    db.addFileToVirtualFolder(folderId, fileId);
    sendJson(res, { success: true });
    global.broadcastSSE({ type: 'files_changed' });
    return true;
  }

  if (pathname.startsWith('/api/virtual-folders/') && pathname.endsWith('/files') && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const parts = pathname.split('/');
    const folderId = parseInt(parts[3], 10);
    const fileId = parseInt(query.get('fileId'), 10);
    if (!fileId) { sendJson(res, { success: false, error: 'fileId required' }, 400); return true; }
    db.removeFileFromVirtualFolder(folderId, fileId);
    global.broadcastSSE({ type: 'files_changed' });
    sendJson(res, { success: true });
    return true;
  }

  // PATCH /api/virtual-folders/:id - update VF (including quota_bytes)
  if (pathname.match(/^\/api\/virtual-folders\/\d+$/) && method === 'PATCH') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const folderId = parseInt(pathname.split('/')[3], 10);
    const body = await readJsonBody(req);
    const updated = db.updateVirtualFolder(folderId, body);
    if (!updated.success) { sendJson(res, updated, 400); return true; }
    sendJson(res, { success: true });
    global.broadcastSSE({ type: 'files_changed' });
    return true;
  }

  // GET /api/virtual-folders/:id/download - Download all files in a virtual folder as streaming zip
  if (pathname.startsWith('/api/virtual-folders/') && pathname.endsWith('/download') && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const id = parseInt(pathname.split('/')[3], 10);
    if (!id) { sendJson(res, { success: false, error: 'Invalid folder id' }, 400); return true; }

    const folder = db.getVirtualFolder(id);
    if (!folder) { sendJson(res, { success: false, error: 'Folder not found' }, 404); return true; }

    const files = db.getVirtualFolderFiles(id);
    if (!files.length) { sendJson(res, { success: false, error: '文件夹为空' }, 400); return true; }

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(folder.name + '.zip'),
      'Transfer-Encoding': 'chunked',
    });

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', function(err) { console.error('[zip error]', err.message); });
    archive.pipe(res);

    for (const file of files) {
      try {
        const fullFile = db.getFileById(file.id);
        if (!fullFile || !fullFile.content) continue;
        archive.append(fullFile.content, { name: fullFile.filename });
      } catch (e) {
        console.error('[zip file error]', e.message);
      }
    }
    archive.finalize();
    return true;
  }

  // POST /api/file-access-log - 记录文件访问日志
  if (pathname === '/api/file-access-log' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    if (!body || !body.filename || !body.action) {
      sendJson(res, { success: false, error: 'filename and action required' }, 400);
      return true;
    }
    const file = db.getFileByName(body.filename);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }
    db.addFileAccessLog(file.id, body.action, getClientIp(req));
    sendJson(res, { success: true });
    return true;
  }

  // GET /api/file-access-log/:filename - 获取文件访问历史
  if (pathname.startsWith('/api/file-access-log/') && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const filename = decodeURIComponent(pathname.slice('/api/file-access-log/'.length));
    const file = db.getFileByName(filename);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }
    const limit = parseInt(query.get('limit') || '50', 10);
    const rows = db.getFileAccessLog(file.id, limit);
    sendJson(res, { success: true, logs: rows });
    return true;
  }

  // GET /api/file-access-log/stats/most-accessed - 获取热门文件
  if (pathname === '/api/file-access-log/stats/most-accessed' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const limit = parseInt(query.get('limit') || '20', 10);
    const since = query.get('since');
    const rows = db.getMostAccessedFiles(limit, since ? parseInt(since, 10) : null);
    sendJson(res, { success: true, files: rows });
    return true;
  }

  // GET /api/activity-log - global activity log across all files
  if (pathname === '/api/activity-log' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const limit = parseInt(query.get('limit') || '200', 10);
    const action = query.get('action') || null;
    const since = query.get('since') ? parseInt(query.get('since'), 10) : null;
    const logs = db.getActivityLog(limit, action, since);
    sendJson(res, { success: true, logs });
    return true;
  }

  // GET /api/file-access-stats/:filename - get access stats for a file
  if (pathname.startsWith('/api/file-access-stats/') && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const filename = decodeURIComponent(pathname.slice('/api/file-access-stats/'.length));
    const stats = db.getFileAccessStats(filename);
    if (!stats) { sendJson(res, { success: false, error: 'File not found' }, 404); return true; }
    sendJson(res, { success: true, stats });
    return true;
  }

  // GET /api/dashboard - 存储分析 Dashboard 数据
  if (pathname === '/api/dashboard' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const stats = db.getDashboardStats();
    sendJson(res, { success: true, ...stats });
    return true;
  }

  // ── File Version History ─────────────────────────────────────────────────
  // GET /api/file-versions/:filename - list versions for a file
  if (pathname.startsWith('/api/file-versions/') && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const parts = pathname.slice('/api/file-versions/'.length).split('/');
    const filename = decodeURIComponent(parts[0]);
    const file = db.getFileByName(filename);
    if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return true; }
    const limit = parseInt(query.get('limit') || '20', 10);
    const versions = db.listFileVersions(file.id, limit);
    const count = db.getFileVersionCount(file.id);
    sendJson(res, { success: true, versions, count, currentHash: file.hash, currentSize: file.size });
    return true;
  }

  // GET /api/file-versions/:filename/version/:versionId - get version content
  if (pathname.match(/^\/api\/file-versions\/[^/]+\/version\/\d+$/) && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const match = pathname.match(/^\/api\/file-versions\/([^/]+)\/version\/(\d+)$/);
    const filename = decodeURIComponent(match[1]);
    const versionId = parseInt(match[2], 10);
    const file = db.getFileByName(filename);
    if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return true; }
    const version = db.getFileVersion(versionId);
    if (!version || version.file_id !== file.id) { sendJson(res, { success: false, error: 'Version not found' }, 404); return true; }
    sendJson(res, { success: true, version });
    return true;
  }

  // POST /api/file-versions/:filename/restore/:versionId - restore a version
  if (pathname.match(/^\/api\/file-versions\/[^/]+\/restore\/\d+$/) && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const match = pathname.match(/^\/api\/file-versions\/([^/]+)\/restore\/(\d+)$/);
    const filename = decodeURIComponent(match[1]);
    const versionId = parseInt(match[2], 10);
    const file = db.getFileByName(filename);
    if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return true; }
    const version = db.getFileVersion(versionId);
    if (!version || version.file_id !== file.id) { sendJson(res, { success: false, error: 'Version not found' }, 404); return true; }
    // Save current content as a new version before restoring
    db.saveFileVersion(file.id, file.filename, file.content || '', file.size, file.hash);
    // Restore the old content
    const updated = db.updateFile(filename, { content: version.content });
    sendJson(res, { success: true, file: updated });
    return true;
  }

  // DELETE /api/file-versions/:filename/version/:versionId - delete a version
  if (pathname.match(/^\/api\/file-versions\/[^/]+\/version\/\d+$/) && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const match = pathname.match(/^\/api\/file-versions\/([^/]+)\/version\/(\d+)$/);
    const filename = decodeURIComponent(match[1]);
    const versionId = parseInt(match[2], 10);
    const file = db.getFileByName(filename);
    if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return true; }
    const version = db.getFileVersion(versionId);
    if (!version || version.file_id !== file.id) { sendJson(res, { success: false, error: 'Version not found' }, 404); return true; }
    db.deleteFileVersion(versionId);
    sendJson(res, { success: true });
    return true;
  }

  // ── Starred Files ────────────────────────────────────────────────────────
  // GET /api/files/starred - list all starred files
  if (pathname === '/api/files/starred' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const db = require('./db');
    const files = db.getStarredFiles ? db.getStarredFiles() : [];
    sendJson(res, { success: true, files });
    return true;
  }

  // POST /api/files/starred - toggle star for a file (body: { filename })
  if (pathname === '/api/files/starred' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { filename } = body;
    if (!filename) { sendJson(res, { success: false, error: 'filename required' }, 400); return true; }
    const db = require('./db');
    const result = db.toggleStar(filename);
    if (!result.success) { sendJson(res, { success: false, error: result.error }, 404); return true; }
    global.broadcastSSE({ type: 'file_starred', filename, starred: result.starred === 1 });
    sendJson(res, { success: true, starred: result.starred === 1 });
    return true;
  }

  // ── Batch Rename ──────────────────────────────────────────────────────────
  // POST /api/file-rename-batch - batch rename files (body: { operations: [{oldFilename, newFilename}] })
  if (pathname === '/api/file-rename-batch' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { operations } = body;
    if (!Array.isArray(operations) || operations.length === 0) {
      sendJson(res, { success: false, error: 'operations array required' }, 400);
      return true;
    }
    const db = require('./db');
    const result = db.batchRenameFiles(operations);
    if (result.renamed > 0) {
      global.broadcastSSE({ type: 'files_renamed', operations });
    }
    sendJson(res, { success: true, renamed: result.renamed, errors: result.errors });
    return true;
  }

  // ── Share Links Management ───────────────────────────────────────────────
  // GET /api/share-links - list all share links
  if (pathname === '/api/share-links' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const db = require('./db');
    const links = db.listShareLinks();
    sendJson(res, { success: true, links });
    return true;
  }

  // ── Notifications ────────────────────────────────────────────────────────
  // GET /api/notifications - list notifications
  if (pathname === '/api/notifications' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const limit = parseInt(query.get('limit') || '50', 10);
    const offset = parseInt(query.get('offset') || '0', 10);
    const rows = db.getNotifications(limit, offset);
    sendJson(res, { success: true, notifications: rows });
    return true;
  }

  // GET /api/notifications/unread-count
  if (pathname === '/api/notifications/unread-count' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const count = db.getUnreadNotificationCount();
    sendJson(res, { success: true, count });
    return true;
  }

  // POST /api/notifications - create a new notification
  if (pathname === '/api/notifications' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    if (!body.type || !body.title) {
      sendJson(res, { success: false, error: 'type and title are required' }, 400);
      return true;
    }
    const notif = db.addNotification(body.type, body.title, body.message || null);
    sendJson(res, { success: true, notification: notif });
    return true;
  }

  // POST /api/notifications/mark-read - mark notifications as read
  if (pathname === '/api/notifications/mark-read' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    if (body.all) {
      db.markNotificationsRead(null); // mark all as read
    } else if (Array.isArray(body.ids) && body.ids.length > 0) {
      db.markNotificationsRead(body.ids);
    } else {
      sendJson(res, { success: false, error: 'ids array or {all: true} required' }, 400);
      return true;
    }
    sendJson(res, { success: true });
    return true;
  }

  // DELETE /api/notifications - delete notifications
  if (pathname === '/api/notifications' && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    if (body.all) {
      db.clearNotifications(null); // clear all
    } else if (Array.isArray(body.ids) && body.ids.length > 0) {
      db.clearNotifications(body.ids);
    } else {
      sendJson(res, { success: false, error: 'ids array or {all: true} required' }, 400);
      return true;
    }
    sendJson(res, { success: true });
    return true;
  }

  // GET /api/db/stats - database statistics
  if (pathname === '/api/db/stats' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const stats = db.getDbStats();
    sendJson(res, { success: true, ...stats });
    return true;
  }

  // GET /api/db/backup - create a SQLite backup and return it as downloadable file
  if (pathname === '/api/db/backup' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const fs = require('fs');
    const pathModule = require('path');
    const { DB_PATH } = require('../db');
    // WAL checkpoint — flush WAL to main DB for consistent copy
    db.getDb().pragma('wal_checkpoint(TRUNCATE)');
    const backupDir = pathModule.join(pathModule.dirname(DB_PATH), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `share-tool-${timestamp}.db`;
    const backupPath = pathModule.join(backupDir, backupName);
    fs.copyFileSync(DB_PATH, backupPath);
    // Also copy WAL and SHM as -wal and -shm (vacuum may leave them)
    try {
      if (fs.existsSync(DB_PATH + '-wal')) fs.copyFileSync(DB_PATH + '-wal', backupPath + '-wal');
      if (fs.existsSync(DB_PATH + '-shm')) fs.copyFileSync(DB_PATH + '-shm', backupPath + '-shm');
    } catch (e) { /* WAL/SHM may not exist */ }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Disposition': `attachment; filename="${backupName}"`,
      'Content-Length': String(fs.statSync(backupPath).size)
    });
    fs.createReadStream(backupPath).pipe(res);
    return true;
  }

  // GET /api/system/stats - system resource stats (CPU, memory, disk)
  if (pathname === '/api/system/stats' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const stats = db.getSystemStats();
    sendJson(res, { success: true, ...stats });
    return true;
  }

  // GET /api/duplicates - find duplicate files by hash
  if (pathname === '/api/duplicates' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const duplicates = db.findDuplicates();
    sendJson(res, { success: true, duplicates });
    return true;
  }

  // GET /api/recent-files - list recently accessed files (via file_access_log)
  if (pathname === '/api/recent-files' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const limit = parseInt(query.get('limit')) || 100;
    const files = db.getRecentlyAccessedFiles(limit);
    sendJson(res, { success: true, files });
    return true;
  }

  // ── Request Links (文件收集链接) ───────────────────────────────────────────
  // POST /api/request-links - create a new request link
  if (pathname === '/api/request-links' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    if (!body.name) {
      sendJson(res, { success: false, error: 'name is required' }, 400);
      return true;
    }
    const opts = {
      name: body.name,
      targetFolder: body.target_folder || '',
      password: body.password || null,
      maxUploads: body.max_uploads || null,
      expiresInDays: body.expires_in_days || null,
      createdBy: body.created_by || null,
    };
    const row = db.createRequestLink(opts);
    sendJson(res, { success: true, request_link: row }, 201);
    return true;
  }

  // GET /api/request-links - list request links
  if (pathname === '/api/request-links' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const createdBy = query.get('created_by') || null;
    const rows = db.listRequestLinks(createdBy);
    sendJson(res, { success: true, request_links: rows });
    return true;
  }

  // GET /api/request-links/:code - get a request link by code (public, no auth)
  if (pathname.startsWith('/api/request-links/') && method === 'GET' && pathname.split('/').length === 4) {
    const code = pathname.split('/')[3];
    // No auth required for public request links
    const row = db.getRequestLink(code);
    if (!row) {
      sendJson(res, { success: false, error: 'Not found' }, 404);
      return true;
    }
    sendJson(res, { success: true, request_link: row });
    return true;
  }

  // PUT /api/request-links/:code - update a request link (auth required)
  if (pathname.match(/^\/api\/request-links\/[^/]+$/) && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const code = pathname.split('/')[3];
    const body = await readJsonBody(req);
    const updates = [];
    const values = [];

    if (body.name !== undefined) { updates.push('name = ?'); values.push(body.name); }
    if (body.target_folder !== undefined) { updates.push('target_folder = ?'); values.push(body.target_folder); }
    if (body.max_uploads !== undefined) { updates.push('max_uploads = ?'); values.push(body.max_uploads); }
    if (body.expires_in_days !== undefined) {
      updates.push('expires_at = ?');
      values.push(body.expires_in_days ? Math.floor(Date.now() / 1000) + body.expires_in_days * 86400 : null);
    }
    if (body.active !== undefined) { updates.push('active = ?'); values.push(body.active ? 1 : 0); }
    if (body.password !== undefined) {
      updates.push('password = ?');
      values.push(body.password ? hashPassword(body.password) : null);
    }

    if (updates.length === 0) {
      sendJson(res, { success: false, error: 'No fields to update' }, 400);
      return true;
    }

    values.push(code);
    db.prepare(`UPDATE request_links SET ${updates.join(', ')} WHERE code = ?`).run(...values);
    const updated = db.getRequestLink(code);
    sendJson(res, { success: true, request_link: updated });
    return true;
  }

  // POST /api/request-links/:code/verify - verify password (public)
  if (pathname.match(/^\/api\/request-links\/[^/]+\/verify$/) && method === 'POST') {
    const code = pathname.split('/')[3];
    const body = await readJsonBody(req);
    const valid = db.verifyRequestLinkPassword(code, body.password || '');
    if (!valid) {
      sendJson(res, { success: false, error: 'Invalid password' }, 401);
      return true;
    }
    sendJson(res, { success: true });
    return true;
  }

  // POST /api/request-links/:code/upload - record an upload (public)
  if (pathname.match(/^\/api\/request-links\/[^/]+\/upload$/) && method === 'POST') {
    const code = pathname.split('/')[3];
    const uploadCount = db.incrementRequestLinkUpload(code);
    sendJson(res, { success: true, upload_count: uploadCount });
    return true;
  }

  // PUT /api/request-links/:code/active - toggle active status
  if (pathname.match(/^\/api\/request-links\/[^/]+\/active$/) && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const code = pathname.split('/')[3];
    const body = await readJsonBody(req);
    if (typeof body.active !== 'boolean') {
      sendJson(res, { success: false, error: 'active (boolean) is required' }, 400);
      return true;
    }
    db.toggleRequestLinkActive(code, body.active);
    sendJson(res, { success: true });
    return true;
  }

  // DELETE /api/request-links/:code - delete a request link
  if (pathname.match(/^\/api\/request-links\/[^/]+$/) && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const code = pathname.split('/')[3];
    db.deleteRequestLink(code);
    sendJson(res, { success: true });
    return true;
  }

  // GET /api/request-links/:code/files - list files uploaded to a request link
  if (pathname.match(/^\/api\/request-links\/[^/]+\/files$/) && method === 'GET') {
    const match = pathname.match(/^\/api\/request-links\/([^/]+)\/files$/);
    if (match) {
      const code = match[1];
      const auth = authRequired(req, res);
      if (!auth) return true;
      const rl = db.getRequestLink(code);
      if (!rl) { sendJson(res, { success: false, error: 'Request link not found' }, 404); return true; }
      const files = db.getRequestLinkFiles(rl.id);
      sendJson(res, { success: true, files });
      return true;
    }
  }

  // DELETE /api/request-links/:code/files/:fileId - delete a file from a request link
  if (pathname.match(/^\/api\/request-links\/[^/]+\/files\/[0-9]+$/) && method === 'DELETE') {
    const match = pathname.match(/^\/api\/request-links\/([^/]+)\/files\/([0-9]+)$/);
    if (match) {
      const code = match[1], fileId = parseInt(match[2], 10);
      const auth = authRequired(req, res);
      if (!auth) return true;
      const rl = db.getRequestLink(code);
      if (!rl) { sendJson(res, { success: false, error: 'Request link not found' }, 404); return true; }
      const ok = db.deleteRequestLinkFile(rl.id, fileId);
      sendJson(res, { success: ok });
      return true;
    }
  }

  // GET /api/request-links/:code/files/zip - download all files as zip
  if (pathname.match(/^\/api\/request-links\/[^/]+\/files\/zip$/) && method === 'GET') {
    const match = pathname.match(/^\/api\/request-links\/([^/]+)\/files\/zip$/);
    if (match) {
      const code = match[1];
      const auth = authRequired(req, res);
      if (!auth) return true;
      const rl = db.getRequestLink(code);
      if (!rl) { sendJson(res, { error: 'Request link not found' }, 404); return true; }
      const files = db.getRequestLinkFiles(rl.id);
      if (!files.length) { sendJson(res, { error: 'No files' }, 400); return true; }

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="request_link_' + code + '.zip"'
      });

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (err) => { try { res.destroy(err); } catch (_) {} });
      archive.pipe(res);

      const { decodeStoredFile } = ctx;
      files.forEach((f) => {
        try {
          const content = decodeStoredFile(f);
          archive.append(content || '', { name: f.filename });
        } catch (_) {}
      });

      archive.finalize();
      db.addAuditLog('request_link_zip', code + ': ' + files.length + ' files', getClientIp(req), auth.token);
      return true;
    }
  }

  // ── Tag Emoji ───────────────────────────────────────────────────────────
  // GET /api/tags/emojis - get all tag→emoji mappings (bulk)
  if (pathname === '/api/tags/emojis' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const rows = db.getAllTagColors(); // returns {tag, color, emoji}
    const emojis = {};
    for (const row of rows) { emojis[row.tag] = row.emoji || null; }
    sendJson(res, { success: true, emojis });
    return true;
  }

  // GET /api/tags/emoji/:tag - get emoji for one tag
  if (pathname.match(/^\/api\/tags\/emoji\/[^/]+$/) && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const tag = decodeURIComponent(pathname.split('/')[4]);
    const emoji = db.getTagEmoji(tag);
    sendJson(res, { success: true, tag, emoji });
    return true;
  }

  // PUT /api/tags/emoji/:tag - set emoji for a tag
  if (pathname.match(/^\/api\/tags\/emoji\/[^/]+$/) && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const tag = decodeURIComponent(pathname.split('/')[4]);
    const body = await readJsonBody(req);
    if (typeof body.emoji !== 'string') {
      sendJson(res, { success: false, error: 'emoji string required' }, 400);
      return true;
    }
    const result = db.setTagEmoji(tag, body.emoji);
    sendJson(res, { success: true, ...result });
    return true;
  }

  // ── Popular Searches ────────────────────────────────────────────────────
  // GET /api/search/popular - trending/popular search queries
  if (pathname === '/api/search/popular' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const limit = parseInt(query.get('limit') || '10', 10);
    const rows = db.getPopularSearches(limit);
    sendJson(res, { success: true, popular: rows });
    return true;
  }

  // ── File Versions ───────────────────────────────────────────────────────
  // POST /api/files/:filename/version - manually save a file version checkpoint
  if (pathname.match(/^\/api\/files\/[^/]+\/version$/) && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const filename = decodeURIComponent(pathname.split('/')[3]);
    const file = db.getFileByName(filename);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }
    const row = db.saveFileVersion(file.id, filename, file.content || '', file.size, file.hash);
    sendJson(res, { success: true, version: row }, 201);
    return true;
  }

  // DELETE /api/files/:filename/versions/prune - prune old versions, keep N newest
  if (pathname.match(/^\/api\/files\/[^/]+\/versions\/prune$/) && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const filename = decodeURIComponent(pathname.split('/')[3]);
    const file = db.getFileByName(filename);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }
    const body = await readJsonBody(req);
    const keepCount = parseInt(body.keep_count || '10', 10);
    const pruned = db.pruneFileVersions(file.id, keepCount);
    sendJson(res, { success: true, pruned });
    return true;
  }

  // DELETE /api/versions/prune-all - prune all versions across all files
  if (pathname === '/api/versions/prune-all' && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const keepCount = parseInt(body.keep_count || '10', 10);
    const totalPruned = db.pruneAllFileVersions(keepCount);
    sendJson(res, { success: true, total_pruned: totalPruned });
    return true;
  }

  // ── File Starred ─────────────────────────────────────────────────────────
  // POST /api/files/:filename/star - toggle starred status
  if (pathname.match(/^\/api\/files\/[^/]+\/star$/) && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const filename = decodeURIComponent(pathname.split('/')[3]);
    const result = db.toggleStar(filename);
    if (!result.success) {
      sendJson(res, { success: false, error: result.error }, 404);
      return true;
    }
    sendJson(res, { success: true, starred: result.starred === 1 });
    global.broadcastSSE({ type: 'files_changed' });
    return true;
  }

  // ── Permanent Delete ─────────────────────────────────────────────────────
  // DELETE /api/files/permanent/:filename - permanently delete without trash
  if (pathname.match(/^\/api\/files\/permanent\/[^/]+$/) && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const filename = decodeURIComponent(pathname.split('/')[3]);
    const ok = db.permanentlyDeleteFile(filename);
    if (!ok) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }
    sendJson(res, { success: true });
    return true;
  }

  // ── Admin / Maintenance ──────────────────────────────────────────────────
  // POST /api/admin/vacuum - run SQLite VACUUM to reclaim disk space
  if (pathname === '/api/admin/vacuum' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    db.runVacuum();
    sendJson(res, { success: true, message: 'VACUUM completed' });
    return true;
  }

  // DELETE /api/admin/search-history - clear all search history
  if (pathname === '/api/admin/search-history' && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    db.clearSearchHistory();
    sendJson(res, { success: true });
    return true;
  }

  // POST /api/settings/rotate-token - rotate the static share token
  if (pathname === '/api/settings/rotate-token' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const newToken = rotateShareToken();
    addAuditLog('token_rotate', null, getClientIp(req));
    sendJson(res, { success: true, token: newToken });
    return true;
  }

  // GET /api/file-notes/:encodedPath - get notes for a file
  const notesMatch = pathname.match(/^\/api\/file-notes\/(.+)$/);
  if (notesMatch && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const filename = decodeURIComponent(notesMatch[1]);
    const notes = db.getFileNotes(filename);
    sendJson(res, { success: true, notes });
    return true;
  }

  // PUT /api/file-notes/:encodedPath - update notes for a file
  if (notesMatch && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const filename = decodeURIComponent(notesMatch[1]);
    const body = await readJsonBody(req);
    const result = db.updateFileNotes(filename, body.notes);
    sendJson(res, result);
    return true;
  }

  // GET /api/expiring-links - get share/request links expiring within 7 days
  if (pathname === '/api/expiring-links' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const now = Date.now();
    const weekFromNow = now + (7 * 24 * 60 * 60 * 1000);
    const items = [];

    // Check share links expiring within 7 days
    const shares = db.listShareLinks();
    shares.forEach(share => {
      if (share.expiresAt && share.expiresAt > now && share.expiresAt <= weekFromNow) {
        const hoursLeft = Math.round((share.expiresAt - now) / (1000 * 60 * 60));
        const type = hoursLeft <= 24 ? '紧急' : '提醒';
        items.push({
          type: 'share',
          code: share.code,
          filename: share.filename,
          expiresAt: share.expiresAt,
          hoursLeft,
          message: `分享 "${share.filename}" 将于${hoursLeft <= 24 ? '24小时内' : hoursLeft + '小时后'}过期`
        });
      }
    });

    // Check request links expiring within 7 days
    const reqLinks = db.listRequestLinks();
    reqLinks.forEach(link => {
      if (link.expiresAt && link.expiresAt > now && link.expiresAt <= weekFromNow) {
        const hoursLeft = Math.round((link.expiresAt - now) / (1000 * 60 * 60));
        items.push({
          type: 'request',
          code: link.code,
          name: link.name,
          expiresAt: link.expiresAt,
          hoursLeft,
          message: `收集链接 "${link.name}" 将于${hoursLeft <= 24 ? '24小时内' : hoursLeft + '小时后'}过期`
        });
      }
    });

    sendJson(res, { success: true, items });
    return true;
  }

  // GET /api/config/custom-css - get current custom CSS
  if (pathname === '/api/config/custom-css' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const { config } = ctx;
    sendJson(res, { success: true, customCSS: config.customCSS || '' });
    return true;
  }

  // PUT /api/config/custom-css - save custom CSS
  if (pathname === '/api/config/custom-css' && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    const body = await readJsonBody(req);
    const { config } = ctx;
    config.customCSS = (body.customCSS || '').slice(0, 10000); // max 10KB
    ctx.saveConfig();
    sendJson(res, { success: true });
    return true;
  }

  return false;
};

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '', size = 0;
    const limit = 1024 * 1024; // 1MB max for JSON body
    req.on('data', d => {
      size += d.length;
      if (size > limit) { req.destroy(); resolve({}); return; }
      body += d;
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
