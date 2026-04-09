/**
 * routes/api.js - System APIs: token, config, https, storage, db, audit, devices, sync
 */

module.exports = function handleApiRoutes(req, res, pathname, query, ctx) {
  const { db, config, sendJson, authRequired, getClientIp, saveConfig, SHARE_TOKEN, TOKEN_EXPIRES_IN, DEVICE_ID, fs, path, ensureSslCertificates, getCertInfo, checkAndRenewCertificate } = ctx;
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
    // 检查是否是设备 token（有过期时间）
    let expiresAt = null;
    try {
      const rawDb = db.getDb();
      const tokenRow = rawDb.prepare('SELECT expires_at FROM tokens WHERE token = ?').get(SHARE_TOKEN);
      if (tokenRow) expiresAt = tokenRow.expires_at;
    } catch (_) {}
    sendJson(res, { success: true, token: SHARE_TOKEN, expiresAt });
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

  // GET /api/tags — 返回所有标签名（纯列表，供 CLI 使用）
  if (pathname === '/api/tags' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const tags = db.getAllTags();
    sendJson(res, { success: true, tags });
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

  // ============================================================
  // 标签 API
  // ============================================================

  // GET /api/tags/list — 列出所有标签及使用次数
  if (pathname === '/api/tags/list' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const files = db.listFiles();
    // 统计每个标签的使用次数
    const tagCounts = {};
    for (const f of files) {
      if (f.tags) {
        for (const t of f.tags.split(',').map(s => s.trim()).filter(Boolean)) {
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        }
      }
    }
    const colors = db.getAllTagColors();
    const tags = Object.keys(tagCounts).map(tag => ({
      tag,
      count: tagCounts[tag],
      color: colors[tag] || null
    })).sort((a, b) => b.count - a.count);
    sendJson(res, { success: true, tags });
    return true;
  }

  // GET /api/tags/suggest-color?tag=xxx — 为新标签推荐颜色
  if (pathname === '/api/tags/suggest-color' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const tag = parsed.query.tag || '';
    const color = db.getSuggestedColor(tag);
    sendJson(res, { success: true, color });
    return true;
  }

  // PUT /api/tags/color — 更新标签颜色
  if (pathname === '/api/tags/color' && method === 'PUT') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tag, color } = JSON.parse(body);
        if (!tag || !color) { sendJson(res, { success: false, error: 'tag and color required' }, 400); return; }
        db.setTagColor(tag, color);
        sendJson(res, { success: true });
      } catch (e) { sendJson(res, { success: false, error: e.message }, 400); }
    });
    return true;
  }

  // POST /api/tags/rename/:oldTag — 重命名标签（同时更新所有文件的 tags 字段）
  if (pathname.startsWith('/api/tags/rename/') && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const oldTag = decodeURIComponent(pathname.slice('/api/tags/rename/'.length));
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { newTag } = JSON.parse(body);
        if (!newTag) { sendJson(res, { success: false, error: 'newTag required' }, 400); return; }
        if (oldTag === newTag) { sendJson(res, { success: false, error: 'same as old' }, 400); return; }
        const files = db.listFiles();
        let updated = 0;
        for (const f of files) {
          if (f.tags) {
            const tags = f.tags.split(',').map(s => s.trim());
            const idx = tags.indexOf(oldTag);
            if (idx !== -1) {
              tags[idx] = newTag;
              db.updateFile(f.filename, null, { tags: tags.join(',') });
              updated++;
            }
          }
        }
        // 更新标签颜色
        const oldColor = db.getTagColor(oldTag);
        if (oldColor) { db.setTagColor(newTag, oldColor); db.deleteTagColor(oldTag); }
        sendJson(res, { success: true, updated });
      } catch (e) { sendJson(res, { success: false, error: e.message }, 400); }
    });
    return true;
  }

  // DELETE /api/tags/delete/:tag — 删除标签（从所有文件移除）
  if (pathname.startsWith('/api/tags/delete/') && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const tag = decodeURIComponent(pathname.slice('/api/tags/delete/'.length));
    const files = db.listFiles();
    let updated = 0;
    for (const f of files) {
      if (f.tags) {
        const tags = f.tags.split(',').map(s => s.trim()).filter(s => s !== tag);
        if (tags.length !== f.tags.split(',').map(s => s.trim()).filter(Boolean).length) {
          db.updateFile(f.filename, null, { tags: tags.join(',') });
          updated++;
        }
      }
    }
    db.deleteTagColor(tag);
    sendJson(res, { success: true, updated });
    return true;
  }

  // GET /api/file-tags/:filename — 获取文件标签
  if (pathname.startsWith('/api/file-tags/') && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/api/file-tags/'.length));
    const file = db.getFileByName(filename);
    if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return; }
    const tags = file.tags ? file.tags.split(',').map(s => s.trim()).filter(Boolean) : [];
    sendJson(res, { success: true, filename, tags });
    return true;
  }

  // PUT /api/file-tags/:filename — 更新文件标签（支持 add/remove 批量操作）
  if (pathname.startsWith('/api/file-tags/') && method === 'PUT') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/api/file-tags/'.length));
    const file = db.getFileByName(filename);
    if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return; }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tags } = JSON.parse(body);
        const action = new URL(req.url, 'http://x').searchParams.get('action');
        const currentTags = file.tags ? file.tags.split(',').map(s => s.trim()).filter(Boolean) : [];
        let newTags;
        if (action === 'add') {
          const toAdd = Array.isArray(tags) ? tags : [tags].filter(Boolean);
          const merged = new Set([...currentTags, ...toAdd]);
          newTags = [...merged].join(',');
        } else if (action === 'remove') {
          const toRemove = Array.isArray(tags) ? tags : [tags].filter(Boolean);
          newTags = currentTags.filter(t => !toRemove.includes(t)).join(',');
        } else {
          // Full replace (default)
          newTags = Array.isArray(tags) ? tags.join(',') : (tags || '');
        }
        db.updateFile(filename, null, { tags: newTags });
        sendJson(res, { success: true, tags: newTags });
      } catch (e) { sendJson(res, { success: false, error: e.message }, 400); }
    });
    return true;
  }

  // DELETE /api/file-tags/:filename — 清除文件标签
  if (pathname.startsWith('/api/file-tags/') && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/api/file-tags/'.length));
    const file = db.getFileByName(filename);
    if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return; }
    db.updateFile(filename, null, { tags: '' });
    sendJson(res, { success: true });
    return true;
  }

  // PUT /api/file-tags/batch — 批量更新多个文件的标签
  if (pathname === '/api/file-tags/batch' && method === 'PUT') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { files = [], action = 'add', tags } = JSON.parse(body);
        if (!Array.isArray(files) || files.length === 0) {
          sendJson(res, { success: false, error: 'files array required' }, 400);
          return;
        }
        if (!tags) {
          sendJson(res, { success: false, error: 'tags required' }, 400);
          return;
        }
        const toProcess = Array.isArray(tags) ? tags : [tags];
        let updated = 0, failed = 0;
        for (const filename of files) {
          try {
            const file = db.getFileByName(filename);
            if (!file) { failed++; continue; }
            const currentTags = file.tags ? file.tags.split(',').map(s => s.trim()).filter(Boolean) : [];
            let newTags;
            if (action === 'add') {
              const merged = new Set([...currentTags, ...toProcess]);
              newTags = [...merged].join(',');
            } else if (action === 'remove') {
              newTags = currentTags.filter(t => !toProcess.includes(t)).join(',');
            } else {
              newTags = toProcess.join(',');
            }
            db.updateFile(filename, null, { tags: newTags });
            updated++;
          } catch (e) { failed++; }
        }
        sendJson(res, { success: true, updated, failed, total: files.length });
      } catch (e) { sendJson(res, { success: false, error: e.message }, 400); }
    });
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

  // POST /api/admin/renew-cert — force renew HTTPS certificate
  if (pathname === '/api/admin/renew-cert' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    Promise.resolve(checkAndRenewCertificate(true)).then(renewed => {
      if (renewed) {
        db.addAuditLog('cert_renew', 'HTTPS certificate renewed', getClientIp(req), authData.token);
        sendJson(res, { success: true, message: 'Certificate renewed successfully' });
      } else {
        sendJson(res, { success: true, message: 'Certificate still valid, no renewal needed' });
      }
    }).catch(e => {
      sendJson(res, { success: false, error: e.message }, 500);
    });
    return true;
  }

  return false;
};
