/**
 * routes/api.js - System APIs: token, config, https, storage, db, audit, devices, sync
 */

module.exports = function handleApiRoutes(req, res, pathname, query, ctx) {
  const { db, config, sendJson, authRequired, getClientIp, saveConfig, SHARE_TOKEN, TOKEN_EXPIRES_IN, DEVICE_ID, fs, path, ensureSslCertificates, getCertInfo } = ctx;
  const { method } = req;
  const parsed = { query };

  // GET /api/storage
  if (pathname === '/api/storage' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const count = db.getFileCount();
    const totalSize = db.getTotalStorageSize();
    sendJson(res, { count, totalSize, maxSize: 10 * 1024 * 1024 * 1024 });
    return true;
  }

  // GET /api/db/stats
  if (pathname === '/api/db/stats' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const stats = db.getDbStats();
    const integrity = db.checkDbIntegrity();
    sendJson(res, { ...stats, integrity });
    return true;
  }

  // POST /api/db/vacuum
  if (pathname === '/api/db/vacuum' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    db.runVacuum();
    db.addAuditLog('db_vacuum', 'Manual VACUUM executed', getClientIp(req), authData.token);
    sendJson(res, { success: true, message: 'VACUUM completed' });
    return true;
  }

  // DELETE /api/delete-all
  if (pathname === '/api/delete-all' && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const result = db.deleteAllFiles();
    const { broadcastChange } = ctx;
    if (broadcastChange) broadcastChange({ type: 'bulk_delete', count: result.deleted });
    db.addAuditLog('delete_all', `Deleted ${result.deleted} files`, getClientIp(req), authData.token);
    sendJson(res, { success: true, deleted: result.deleted });
    return true;
  }

  // POST /api/config
  if (pathname === '/api/config' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        if (updates.downloadDir) {
          config.downloadDir = updates.downloadDir;
          if (!fs.existsSync(config.downloadDir)) {
            fs.mkdirSync(config.downloadDir, { recursive: true });
          }
        }
        saveConfig();
        db.addAuditLog('update_config', JSON.stringify(updates), getClientIp(req), authData.token);
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/token/current
  if (pathname === '/api/token/current') {
    if (!SHARE_TOKEN) return sendJson(res, { success: true, token: null });
    sendJson(res, { success: true, token: SHARE_TOKEN });
    return true;
  }

  // POST /api/token/set
  if (pathname === '/api/token/set' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { token } = JSON.parse(body);
        if (!token || token.length < 16) {
          sendJson(res, { success: false, error: 'Token 长度至少 16 字符' }, 400);
          return;
        }
        ctx.SHARE_TOKEN = token;
        config.shareToken = token;
        saveConfig();
        db.addAuditLog('set_token', 'Token 已更新', getClientIp(req), authData.token);
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/token/generate
  if (pathname === '/api/token/generate' && method === 'POST') {
    const deviceId = req.headers['x-device-id'] || DEVICE_ID;
    const { token, refreshToken, expiresAt } = db.generateToken(deviceId, TOKEN_EXPIRES_IN);
    db.addAuditLog('generate_token', `deviceId: ${deviceId}`, getClientIp(req), token);
    sendJson(res, { success: true, token, refreshToken, expiresAt });
    return true;
  }

  // POST /api/token/refresh
  if (pathname === '/api/token/refresh' && method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { refreshToken } = JSON.parse(body);
        const result = db.refreshToken(refreshToken);
        if (result && result.success) {
          db.addAuditLog('token_refresh', 'Token 刷新成功', getClientIp(req));
          sendJson(res, { success: true, token: result.token, refreshToken: result.refreshToken, expiresAt: result.expiresAt });
        } else {
          db.addAuditLog('token_refresh_fail', result?.error || '刷新失败', getClientIp(req));
          sendJson(res, { success: false, error: result?.error || 'Invalid refresh token' }, 401);
        }
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/devices
  if (pathname === '/api/devices') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const devices = db.listDevices();
    sendJson(res, { success: true, devices });
    return true;
  }

  // GET /api/sync/status
  if (pathname === '/api/sync/status') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const status = db.getSyncStatus();
    sendJson(res, { success: true, ...status });
    return true;
  }

  // POST /api/sync/changes
  if (pathname === '/api/sync/changes' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { since = 0 } = JSON.parse(body);
        const changes = db.getUnsyncedLogs(since);
        sendJson(res, { success: true, changes });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/tags/colors
  if (pathname === '/api/tags/colors' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const allColors = db.getAllTagColors();
    sendJson(res, { success: true, colors: allColors });
    return true;
  }

  // GET /api/audit/logs
  if (pathname === '/api/audit/logs') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const limit = parseInt(parsed.query.limit) || 100;
    const offset = parseInt(parsed.query.offset) || 0;
    const filters = {
      action: parsed.query.action || null,
      ip: parsed.query.ip || null,
      since: parsed.query.since ? parseInt(parsed.query.since) : null,
      until: parsed.query.until ? parseInt(parsed.query.until) : null
    };
    const result = db.listAuditLogs(limit, offset, filters);
    const stats = db.getAuditStats();
    sendJson(res, { success: true, ...result, stats });
    db.addAuditLog('audit_query', `limit=${limit}, offset=${offset}, action=${filters.action || 'all'}`, getClientIp(req), authData.token);
    return true;
  }

  // GET /api/audit/export
  if (pathname === '/api/audit/export') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filters = {
      action: parsed.query.action || null,
      ip: parsed.query.ip || null,
      since: parsed.query.since ? parseInt(parsed.query.since) : null,
      until: parsed.query.until ? parseInt(parsed.query.until) : null
    };
    const csv = db.exportAuditLogsCSV(filters);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit_log_${Date.now()}.csv"`
    });
    res.end(csv);
    db.addAuditLog('audit_export', `CSV export, action=${filters.action || 'all'}`, getClientIp(req), authData.token);
    return true;
  }

  // GET /api/https/cert
  if (pathname === '/api/https/cert') {
    const certInfo = getCertInfo();
    if (certInfo) {
      sendJson(res, { success: true, https: true, ...certInfo });
    } else {
      sendJson(res, { success: true, https: false });
    }
    return true;
  }

  // POST /api/https/regenerate
  if (pathname === '/api/https/regenerate' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    ensureSslCertificates().then(result => {
      if (result) {
        const info = getCertInfo();
        db.addAuditLog('https_regenerate', `Certificate regenerated, daysRemaining: ${info?.daysRemaining}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, message: 'Certificate regenerated', ...info });
      } else {
        db.addAuditLog('https_regenerate_fail', 'Certificate regeneration failed', getClientIp(req), authData.token);
        sendJson(res, { success: false, error: 'Failed to regenerate certificate' }, 500);
      }
    }).catch(e => {
      db.addAuditLog('https_regenerate_error', e.message, getClientIp(req), authData.token);
      sendJson(res, { success: false, error: e.message }, 500);
    });
    return true;
  }

  // POST /api/encrypt
  if (pathname === '/api/encrypt' && method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { content, password } = JSON.parse(body);
        if (!content || !password) {
          sendJson(res, { success: false, error: '需要 content 和 password' }, 400);
          return;
        }
        const { cryptoModule } = ctx;
        const encrypted = cryptoModule.encrypt(content, password);
        sendJson(res, { success: true, encrypted: encrypted.toString('base64') });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return true;
  }

  // POST /api/decrypt
  if (pathname === '/api/decrypt' && method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { encrypted, password } = JSON.parse(body);
        if (!encrypted || !password) {
          sendJson(res, { success: false, error: '需要 encrypted 和 password' }, 400);
          return;
        }
        const encryptedBuffer = Buffer.from(encrypted, 'base64');
        const { cryptoModule } = ctx;
        const decrypted = cryptoModule.decrypt(encryptedBuffer, password);
        if (!decrypted) {
          sendJson(res, { success: false, error: '密码错误或数据损坏' }, 401);
          return;
        }
        sendJson(res, { success: true, content: decrypted.toString('utf8') });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return true;
  }

  return false;
};
