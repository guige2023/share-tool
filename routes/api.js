/**
 * routes/api.js - minimal system APIs
 */

module.exports = async function handleApiRoutes(req, res, pathname, query, ctx) {
  const { db, sendJson, authRequired, VERSION, getClientIp, SHARE_TOKEN } = ctx;
  const { method } = req;

  if (pathname === '/api/health' && method === 'GET') {
    const uptime = Math.floor(process.uptime());
    const mem = process.memoryUsage();
    sendJson(res, {
      status: 'ok',
      version: VERSION,
      uptime,
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024)
      }
    });
    return true;
  }

  if (pathname === '/api/storage' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const count = db.getFileCount();
    const totalSize = db.getTotalStorageSize();
    sendJson(res, { count, totalSize, maxSize: 10 * 1024 * 1024 * 1024 });
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

  if (pathname === '/api/sync/mark' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;
    let body = '';
    req.on('data', d => body += d);
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

  // ── Rate Limit Status ───────────────────────────────────────────────
  if (pathname === '/api/rate-limit/check' && method === 'GET') {
    const ip = getClientIp(req);
    const key = query.get('key') || `share_verify:${ip}:default`;
    const status = db.checkRateLimit(key);
    sendJson(res, { success: true, ...status });
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
    const tagList = tagStr.split(',').map(t => t.trim()).filter(Boolean);
    let updated = 0, failed = 0;
    for (const filename of files) {
      try {
        const file = db.getFileByName(filename);
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
        db.updateFileByName(filename, { tags: next });
        tagList.forEach(t => db.touchTag(t));
        updated++;
      } catch (e) {
        failed++;
      }
    }
    sendJson(res, { success: true, updated, failed, total: files.length });
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

  // DELETE /api/search/history - 清除搜索历史
  if (pathname === '/api/search/history' && method === 'DELETE') {
    db.clearSearchHistory();
    sendJson(res, { success: true });
    return true;
  }

  return false;
};
function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
