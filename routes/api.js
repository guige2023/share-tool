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
    const body = await readJsonBody(req);
    const { password } = body || {};
    if (password !== SHARE_TOKEN) {
      sendJson(res, { success: false, error: 'Invalid credentials' }, 401);
      return true;
    }
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
