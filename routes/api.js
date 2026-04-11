/**
 * routes/api.js - System APIs: token, config, https, storage, db, audit, devices, sync
 */

const path = require('path');
const os = require('os');

module.exports = function handleApiRoutes(req, res, pathname, query, ctx) {
  const { db, config, sendJson, authRequired, getClientIp, saveConfig, SHARE_TOKEN, TOKEN_EXPIRES_IN, DEVICE_ID, fs, ensureSslCertificates, getCertInfo, checkAndRenewCertificate, broadcastChange, execSync } = ctx;
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

  // GET /api/folder-sizes — 获取虚拟文件夹大小
  if (pathname === '/api/folder-sizes' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const folders = db.getAllFolderSizes();
    sendJson(res, { success: true, folders });
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

  // GET /api/system/stats — CPU, memory, disk, uptime
  if (pathname === '/api/system/stats' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const sysStats = db.getSystemStats();
    sendJson(res, { success: true, ...sysStats });
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

  // POST /api/db/cleanup — manual trigger cleanup (audit_log, sync_log, expired)
  if (pathname === '/api/db/cleanup' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const results = {
      audit_log: db.cleanupAuditLog(90),
      sync_log: db.cleanupSyncLog(7),
      expired_tokens: db.cleanupExpiredTokens(),
      expired_share_links: db.cleanupExpiredShareLinks()
    };
    db.addAuditLog('db_cleanup', `Cleaned: audit=${results.audit_log}, sync=${results.sync_log}`, getClientIp(req), authData.token);
    sendJson(res, { success: true, results });
    return true;
  }

  // GET /api/duplicates — find duplicate files by hash
  if (pathname === '/api/duplicates' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const duplicates = db.findDuplicates();
    sendJson(res, { success: true, count: duplicates.length, duplicates });
    return true;
  }

  // GET /api/office-preview?filename=xxx → {text, slides, sheets}
  if (pathname === '/api/office-preview' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = query.filename;
    if (!filename) {
      sendJson(res, { success: false, error: 'filename required' }, 400);
      return true;
    }
    // 路径安全检查
    const decoded = decodeURIComponent(filename);
    if (decoded.includes('..') || decoded.includes('/') || decoded.includes('\\')) {
      sendJson(res, { success: false, error: 'Invalid filename' }, 400);
      return true;
    }
    const file = db.getFileByName(decoded);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }
    const ext = (decoded.split('.').pop() || '').toLowerCase();
    const validExts = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'];
    if (!validExts.includes(ext)) {
      sendJson(res, { success: false, error: 'Not an Office file' }, 400);
      return true;
    }
    try {
      const content = Buffer.from(file.content || '', 'base64').toString('binary');
      const os = require('os');
      const tmpDir = os.tmpdir();
      const tmpFile = require('path').join(tmpDir, 'office-preview-' + Date.now() + '-' + decoded.replace(/[^a-zA-Z0-9.]/g, '_'));
      require('fs').writeFileSync(tmpFile, content);
      const script = require('path').join(__dirname, '..', 'scripts', 'office-preview.py');
      const fmt = ext === 'doc' ? 'docx' : ext === 'xls' ? 'xlsx' : ext === 'ppt' ? 'pptx' : ext;
      const stdout = execSync('python3', [script, fmt, tmpFile]);
      const result = JSON.parse(stdout.toString());
      require('fs').unlinkSync(tmpFile);
      if (result.error) {
        sendJson(res, { success: false, error: result.error }, 500);
      } else {
        sendJson(res, { success: true, ...result });
      }
    } catch (e) {
      sendJson(res, { success: false, error: e.message }, 500);
    }
    return true;
  }

  // GET /api/archive-list?filename=xxx → {files: [{name, size, dir}], total}
  if (pathname === '/api/archive-list' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = query.filename;
    if (!filename) {
      sendJson(res, { success: false, error: 'filename required' }, 400);
      return true;
    }
    const decoded = decodeURIComponent(filename);
    if (decoded.includes('..') || decoded.includes('/') || decoded.includes('\\')) {
      sendJson(res, { success: false, error: 'Invalid filename' }, 400);
      return true;
    }
    const file = db.getFileByName(decoded);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }
    const ext = (decoded.split('.').pop() || '').toLowerCase();
    const validExts = ['zip', 'tar', 'gz', 'tgz', 'bz2', 'rar', '7z'];
    if (!validExts.includes(ext)) {
      sendJson(res, { success: false, error: 'Not an archive file' }, 400);
      return true;
    }
    try {
      const content = Buffer.from(file.content || '', 'base64');
      const os = require('os');
      const path = require('path');
      const fs = require('fs');
      const tmpDir = os.tmpdir();
      const tmpFile = path.join(tmpDir, 'archive-list-' + Date.now() + '-' + decoded.replace(/[^a-zA-Z0-9.]/g, '_'));

      let files = [];
      if (ext === 'zip') {
        // Write to temp file and use unzip -l
        fs.writeFileSync(tmpFile, content);
        const stdout = execSync('unzip', ['-l', tmpFile]);
        fs.unlinkSync(tmpFile);
        const lines = stdout.toString().split('\n').slice(3, -2);
        files = lines.map(line => {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 5) return null;
          const size = parseInt(parts[0]) || 0;
          const name = parts.slice(4).join(' ');
          return { name, size, dir: name.endsWith('/') };
        }).filter(Boolean).slice(0, 500);
      } else if (['tar', 'gz', 'tgz', 'bz2'].includes(ext)) {
        fs.writeFileSync(tmpFile, content);
        const stdout = execSync('tar', ['-tf', tmpFile]);
        fs.unlinkSync(tmpFile);
        files = stdout.toString().split('\n').filter(n => n.trim()).map(name => ({ name, size: 0, dir: name.endsWith('/') })).slice(0, 500);
      } else if (ext === '7z') {
        fs.writeFileSync(tmpFile, content);
        try {
          const stdout = execSync('7z', ['l', '-slt', tmpFile]);
          const lines = stdout.toString().split('\n');
          let currentFile = null;
          for (const line of lines) {
            const pathMatch = line.match(/^Path = (.+)$/);
            const sizeMatch = line.match(/^Size = (\d+)$/);
            if (pathMatch) { currentFile = { name: pathMatch[1], size: 0, dir: false }; }
            if (sizeMatch && currentFile) { currentFile.size = parseInt(sizeMatch[1]) || 0; files.push(currentFile); currentFile = null; }
          }
        } catch (e) { /* 7z not available or failed */ }
        fs.unlinkSync(tmpFile);
        if (files.length === 0) files = [{ name: '(7z listing unavailable)', size: 0, dir: false }];
      } else if (ext === 'rar') {
        fs.writeFileSync(tmpFile, content);
        try {
          const stdout = execSync('unrar', ['l', '-v', tmpFile]);
          const lines = stdout.toString().split('\n');
          for (const line of lines) {
            const match = line.match(/^\s*(\S+)\s+(\d+)\s+\d+-\d+-\d+/);
            if (match) { files.push({ name: match[1], size: parseInt(match[2]) || 0, dir: false }); }
          }
        } catch (e) { /* unrar not available or failed */ }
        fs.unlinkSync(tmpFile);
        if (files.length === 0) files = [{ name: '(rar listing unavailable)', size: 0, dir: false }];
      }

      sendJson(res, { success: true, files, total: files.length, size: file.size });
    } catch (e) {
      sendJson(res, { success: false, error: e.message }, 500);
    }
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
          const downloadPath = path.resolve(updates.downloadDir);
          // 限制在用户目录下，防止路径遍历覆盖系统文件
          const homeDir = os.homedir();
          if (!downloadPath.startsWith(homeDir)) {
            sendJson(res, { success: false, error: 'downloadDir must be within home directory' }, 400);
            return;
          }
          config.downloadDir = downloadPath;
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
    // Refresh token sent via x-refresh-token header (not x-auth-token)
    const refreshToken = req.headers['x-refresh-token'] || req.headers['x-auth-token'];
    const result = db.refreshToken(refreshToken);
    if (result && result.success) {
      db.addAuditLog('token_refresh', 'Token 刷新成功', getClientIp(req));
      sendJson(res, { success: true, token: result.token, refreshToken: result.refreshToken, expiresAt: result.expiresAt });
    } else {
      db.addAuditLog('token_refresh_fail', result?.error || '刷新失败', getClientIp(req));
      sendJson(res, { success: false, error: result?.error || 'Invalid refresh token' }, 401);
    }
    return true;
  }

  // GET /api/devices
  if (pathname === '/api/devices') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const devices = db.listDevices();
    // 附加每设备的同步统计
    const enriched = devices.map(d => {
      // 统计该设备未同步的变更数（通过 device_id 字段）
      const pendingRow = db.prepare(
        'SELECT COUNT(*) as count FROM sync_log WHERE (device_id = ? OR device_id IS NULL) AND synced = 0'
      ).get(d.device_id);
      return {
        ...d,
        last_sync_at: d.last_sync_at || null,
        synced_files: d.synced_files || 0,
        pending_sync: pendingRow ? pendingRow.count : 0
      };
    });
    sendJson(res, { success: true, devices: enriched });
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
    const tags = db.getAllTagsWithStats();
    sendJson(res, { success: true, tags });
    return true;
  }

  // GET /api/search/suggest?q=xxx — 搜索建议（标签 + 文件名 + 搜索语法提示）
  if (pathname === '/api/search/suggest' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const q = (parsed.query.get('q') || '').toLowerCase().trim();
    if (!q) { sendJson(res, { success: true, suggestions: [] }); return true; }

    const suggestions = [];
    const maxPerType = 4;

    // 0. 搜索语法提示：content: 前缀
    if (!q.startsWith('content:') && q.length < 20) {
      suggestions.push({
        text: 'content:' + q,
        type: 'syntax',
        icon: '🔍',
        color: null
      });
    }

    // 1. 标签建议
    const allTags = db.getAllTags();
    const matchedTags = allTags.filter(t => t.toLowerCase().includes(q)).slice(0, maxPerType);
    const tagColors = db.getAllTagColors();
    const colorMap = {};
    tagColors.forEach(c => { colorMap[c.tag] = c.color; });
    matchedTags.forEach(t => suggestions.push({
      text: t,
      type: 'tag',
      icon: '🏷',
      color: colorMap[t] || null
    }));

    // 2. 文件名建议（搜索历史中的文件名前缀匹配）
    const recentFiles = db.listFiles({ limit: 100 });
    const matchedFiles = recentFiles
      .filter(f => f.filename && f.filename.toLowerCase().startsWith(q))
      .slice(0, maxPerType);
    matchedFiles.forEach(f => suggestions.push({
      text: f.filename,
      type: 'filename',
      icon: '📄',
      color: null
    }));

    sendJson(res, { success: true, suggestions });
    return true;
  }

  // GET /api/search?q=xxx&tags=xxx&tagMatch=all|any&size_min=&size_max=&date_from=&date_to=&content=&type= — 高级搜索
  if (pathname === '/api/search' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const q = (parsed.query.get('q') || '').trim();
    const tags = parsed.query.get('tags') || null;
    const tagMatch = parsed.query.get('tagMatch') || 'all';  // 'all' = AND, 'any' = OR
    const fuzzy = parsed.query.get('fuzzy') !== 'false';
    const size_min = parsed.query.get('size_min') ? parseInt(parsed.query.get('size_min')) : null;
    const size_max = parsed.query.get('size_max') ? parseInt(parsed.query.get('size_max')) : null;
    const date_from = parsed.query.get('date_from') ? parseInt(parsed.query.get('date_from')) : null;
    const date_to = parsed.query.get('date_to') ? parseInt(parsed.query.get('date_to')) : null;
    const content = parsed.query.get('content') || null;
    const type = parsed.query.get('type') || null;
    const files = db.searchFiles(q, tags, { fuzzy, limit: 200, size_min, size_max, date_from, date_to, tagMatch, content, type });
    sendJson(res, { success: true, files, query: q, count: files.length });
    return true;
  }

  // GET /api/tags/suggest-color?tag=xxx — 为新标签推荐颜色
  if (pathname === '/api/tags/suggest-color' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const tag = parsed.query.get('tag') || '';
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

  // PUT /api/tags/colors — 批量更新标签颜色
  if (pathname === '/api/tags/colors' && method === 'PUT') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { colors } = JSON.parse(body);  // [{tag, color}, ...]
        if (!Array.isArray(colors)) { sendJson(res, { success: false, error: 'colors array required' }, 400); return; }
        for (const { tag, color } of colors) {
          if (tag && color) db.setTagColor(tag, color);
        }
        sendJson(res, { success: true, updated: colors.length });
      } catch (e) { sendJson(res, { success: false, error: e.message }, 400); }
    });
    return true;
  }

  // PUT /api/tags/emoji — 更新标签图标
  if (pathname === '/api/tags/emoji' && method === 'PUT') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tag, emoji } = JSON.parse(body);
        if (!tag) { sendJson(res, { success: false, error: 'tag required' }, 400); return; }
        db.setTagEmoji(tag, emoji || null);
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
        // 批量更新所有文件的标签（使用 SQL 直接替换，避免 listFiles 100 条限制）
        const result = db.renameTagGlobally(oldTag, newTag);
        // 更新标签颜色
        const oldColor = db.getTagColor(oldTag);
        if (oldColor) { db.setTagColor(newTag, oldColor); db.deleteTagColor(oldTag); }
        db.addAuditLog('tag_rename', `old=${oldTag}, new=${newTag}, updated=${result.updated} files`, getClientIp(req), authData.token);
        sendJson(res, { success: true, updated: result.updated });
      } catch (e) { sendJson(res, { success: false, error: e.message }, 400); }
    });
    return true;
  }

  // DELETE /api/tags/delete/:tag — 删除标签（从所有文件移除）
  if (pathname.startsWith('/api/tags/delete/') && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const tag = decodeURIComponent(pathname.slice('/api/tags/delete/'.length));
    const result = db.deleteTagFromAllFiles(tag);
    db.deleteTagColor(tag);
    sendJson(res, { success: true, updated: result.updated });
    return true;
  }

  // POST /api/tags/merge — 合并多个标签到目标标签
  if (pathname === '/api/tags/merge' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { sources, target } = JSON.parse(body);
        if (!sources || !Array.isArray(sources) || sources.length === 0) {
          sendJson(res, { success: false, error: 'sources array required' }, 400);
          return;
        }
        if (!target) { sendJson(res, { success: false, error: 'target required' }, 400); return; }
        if (sources.includes(target)) { sendJson(res, { success: false, error: 'target cannot be in sources' }, 400); return; }
        const result = db.mergeTags(sources, target);
        db.addAuditLog('tag_merge', `sources=${sources.join(',')}, target=${target}, updated=${result.updated} files`, getClientIp(req), authData.token);
        sendJson(res, { success: true, updated: result.updated });
      } catch (e) { sendJson(res, { success: false, error: e.message }, 400); }
    });
    return true;
  }

  // GET /api/file-tags/:filename — 获取文件标签
  if (pathname.startsWith('/api/file-tags/') && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(pathname.slice('/api/file-tags/'.length));
    if (filename === 'batch') { sendJson(res, { success: false, error: 'Not found' }, 404); return; }
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
    if (filename === 'batch') { sendJson(res, { success: false, error: 'Not found' }, 404); return; }
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
          // 更新标签最近使用时间
          toAdd.forEach(t => db.touchTag(t));
        } else if (action === 'remove') {
          const toRemove = Array.isArray(tags) ? tags : [tags].filter(Boolean);
          newTags = currentTags.filter(t => !toRemove.includes(t)).join(',');
        } else {
          // Full replace (default)
          newTags = Array.isArray(tags) ? tags.join(',') : (tags || '');
        }
        db.updateFileByName(filename, { tags: newTags });
        db.addAuditLog('update_tags', `${filename}: ${newTags}`, getClientIp(req), authData.token);
        broadcastChange({ type: 'update', filename, tags: newTags });
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
    if (filename === 'batch') { sendJson(res, { success: false, error: 'Not found' }, 404); return; }
    const file = db.getFileByName(filename);
    if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return; }
    db.updateFileByName(filename, { tags: '' });
    db.addAuditLog('update_tags', `${filename}: (cleared)`, getClientIp(req), authData.token);
    broadcastChange({ type: 'update', filename, tags: '' });
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
        if (action === 'add') toProcess.forEach(t => db.touchTag(t)); // 更新标签最近使用时间
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
            db.updateFileByName(filename, { tags: newTags });
            updated++;
          } catch (e) { failed++; }
        }
        db.addAuditLog('batch_update_tags', `count=${files.length}, action=${action}, tags=${tags}, updated=${updated}, failed=${failed}`, getClientIp(req), authData.token);
        if (updated > 0) {
          files.slice(0, updated).forEach(f => broadcastChange({ type: 'update', filename: f.filename || f, tags: newTags }));
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
    const limit = parseInt(parsed.query.get('limit')) || 100;
    const offset = parseInt(parsed.query.get('offset')) || 0;
    const filters = {
      action: parsed.query.get('action') || null,
      ip: parsed.query.get('ip') || null,
      since: parsed.query.get('since') ? parseInt(parsed.query.get('since')) : null,
      until: parsed.query.get('until') ? parseInt(parsed.query.get('until')) : null
    };
    // date=YYYY-MM-DD maps to since/until for that day
    const dateFilter = parsed.query.get('date') || null;
    if (dateFilter) {
      const d = new Date(dateFilter);
      if (!isNaN(d)) {
        filters.since = Math.floor(d.setHours(0, 0, 0, 0) / 1000);
        filters.until = Math.floor(d.setHours(23, 59, 59, 999) / 1000);
      }
    }
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
    const format = parsed.query.get('format') || 'csv';
    const filters = {
      action: parsed.query.get('action') || null,
      ip: parsed.query.get('ip') || null,
      since: parsed.query.get('since') ? parseInt(parsed.query.get('since')) : null,
      until: parsed.query.get('until') ? parseInt(parsed.query.get('until')) : null
    };
    // date=YYYY-MM-DD maps to since/until for that day
    const dateFilter = parsed.query.get('date') || null;
    if (dateFilter) {
      const d = new Date(dateFilter);
      if (!isNaN(d)) {
        filters.since = Math.floor(d.setHours(0, 0, 0, 0) / 1000);
        filters.until = Math.floor(d.setHours(23, 59, 59, 999) / 1000);
      }
    }
    
    if (format === 'json') {
      const rows = db.listAuditLogs(10000, 0, filters);
      const exportData = rows.map(r => ({
        id: r.id,
        action: r.action,
        details: r.details,
        ip: r.ip,
        timestamp: r.timestamp,
        time: new Date(r.timestamp * 1000).toISOString()
      }));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit_log_${Date.now()}.json"`
      });
      res.end(JSON.stringify(exportData, null, 2));
      db.addAuditLog('audit_export', `JSON export, action=${filters.action || 'all'}`, getClientIp(req), authData.token);
    } else {
      // CSV 也限制行数，避免内存溢出
      const EXPORT_MAX_ROWS = 100000;
      const csv = db.exportAuditLogsCSV({ ...filters, limit: EXPORT_MAX_ROWS });
      const rowCount = (csv.match(/\n/g) || []).length - 1; // -1 for header
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit_log_${Date.now()}.csv"`
      });
      res.end(csv);
      db.addAuditLog('audit_export', `CSV export, rows=${rowCount}, action=${filters.action || 'all'}`, getClientIp(req), authData.token);
    }
    return true;
  }

  // GET /api/search/history — 获取搜索历史
  if (pathname === '/api/search/history') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const limit = parseInt(parsed.query.get('limit')) || 10;
    const history = db.getSearchHistory(authData.userId, limit);
    sendJson(res, { success: true, history: history.map(h => h.query) });
    return true;
  }

  // DELETE /api/search/history — 清空搜索历史
  if (pathname === '/api/search/history' && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    db.clearSearchHistory(authData.userId);
    sendJson(res, { success: true });
    return true;
  }

  // POST /api/search/history — 添加单条搜索记录
  if (pathname === '/api/search/history' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { query } = JSON.parse(body);
        if (query && query.trim().length >= 2) {
          db.addSearchHistory(query.trim(), authData.userId);
        }
      } catch (e) {}
      sendJson(res, { success: true });
    });
    return true;
  }

  // GET /api/search/popular — 获取热门搜索（所有用户的搜索热词）
  if (pathname === '/api/search/popular' && method === 'GET') {
    const limit = parseInt(parsed.query.get('limit')) || 5;
    const popular = db.getPopularSearches(limit);
    sendJson(res, { success: true, popular });
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

  // GET /api/admin/rate-limit — get current rate limit config
  if (pathname === '/api/admin/rate-limit' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    sendJson(res, { success: true, config: db.getRateLimitConfig() });
    return true;
  }

  // POST /api/admin/rate-limit — update rate limit config
  if (pathname === '/api/admin/rate-limit' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        if (typeof updates !== 'object' || !updates) {
          sendJson(res, { success: false, error: 'Invalid request body' }, 400);
          return;
        }
        db.setRateLimitConfig(updates);
        db.addAuditLog('rate_limit_update', JSON.stringify(updates), getClientIp(req), authData.token);
        sendJson(res, { success: true, config: db.getRateLimitConfig() });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/admin/rate-limits — list active rate limit records
  if (pathname === '/api/admin/rate-limits' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const limit = parseInt(query.limit) || 100;
    const records = db.listRateLimits(limit);
    // Parse key into readable parts (e.g. "share_verify:192.168.1.1:abc123" → {type, ip, code})
    const parsed = records.map(r => {
      const parts = r.key.split(':');
      return {
        key: r.key,
        type: parts[0] || '',
        ip: parts[1] || '',
        code: parts[2] || '',
        attempts: r.attempts,
        lockedUntil: r.locked_until,
        lastAttempt: r.last_attempt,
        status: r.status,
        remaining: r.remaining,
        secondsAgo: r.seconds_ago
      };
    });
    sendJson(res, { success: true, records: parsed, count: parsed.length });
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

  // GET /api/file-versions/:filename — list version history
  const versionsMatch = pathname.match(/^\/api\/file-versions\/(.+)$/);
  if (versionsMatch && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(versionsMatch[1]);
    const file = db.getFileByName(filename);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }
    const versions = db.listFileVersions(file.id, 20);
    sendJson(res, { success: true, filename, versions });
    return true;
  }

  // GET /api/file-version/:versionId — get specific version content
  const versionMatch = pathname.match(/^\/api\/file-version\/(\d+)$/);
  if (versionMatch && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const version = db.getFileVersion(parseInt(versionMatch[1]));
    if (!version) {
      sendJson(res, { success: false, error: 'Version not found' }, 404);
      return true;
    }
    sendJson(res, { success: true, version });
    return true;
  }

  // GET /api/file-versions/:filename/diff?v1=<timestamp>&v2=<timestamp> — diff two versions
  const diffMatch = pathname.match(/^\/api\/file-versions\/(.+)\/diff$/);
  if (diffMatch && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(diffMatch[1]);
    const file = db.getFileByName(filename);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }
    const url = new URL(req.url, 'http://localhost');
    const v1 = parseInt(url.searchParams.get('v1'));
    const v2 = parseInt(url.searchParams.get('v2'));
    if (!v1 || !v2) {
      sendJson(res, { success: false, error: 'v1 and v2 timestamps required' }, 400);
      return true;
    }
    const versions = db.listFileVersions(file.id, 100);
    const version1 = versions.find(v => v.created_at === v1);
    const version2 = versions.find(v => v.created_at === v2);
    if (!version1 || !version2) {
      sendJson(res, { success: false, error: 'Version not found' }, 404);
      return true;
    }
    // Simple line-by-line diff
    const lines1 = (version1.content || '').split('\n');
    const lines2 = (version2.content || '').split('\n');
    const diff = [];
    const maxLines = Math.max(lines1.length, lines2.length);
    for (let i = 0; i < maxLines; i++) {
      const l1 = lines1[i];
      const l2 = lines2[i];
      if (l1 === undefined) diff.push({ op: '+', line: i + 1, content: l2 });
      else if (l2 === undefined) diff.push({ op: '-', line: i + 1, content: l1 });
      else if (l1 !== l2) {
        diff.push({ op: '-', line: i + 1, content: l1 });
        diff.push({ op: '+', line: i + 1, content: l2 });
      } else {
        diff.push({ op: ' ', line: i + 1, content: l1 });
      }
    }
    sendJson(res, { success: true, filename, v1: version1.created_at, v2: version2.created_at, diff });
    return true;
  }

  // POST /api/star/:filename — toggle star/favorite status
  const starMatch = pathname.match(/^\/api\/star\/(.+)$/);
  if (starMatch && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(starMatch[1]);
    const result = db.toggleStar(filename);
    if (!result.success) {
      sendJson(res, result, 404);
      return true;
    }
    sendJson(res, result);
    return true;
  }

  // POST /api/file-version/:versionId/restore — restore a specific version
  const restoreMatch = pathname.match(/^\/api\/file-version\/(\d+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const version = db.getFileVersion(parseInt(restoreMatch[1]));
    if (!version) {
      sendJson(res, { success: false, error: 'Version not found' }, 404);
      return true;
    }
    // Save current as new version before restoring
    const current = db.getFileByName(version.filename);
    if (current) {
      db.saveFileVersion(current.id, current.filename, current.content, current.size, current.hash);
    }
    const restored = db.updateFileByName(version.filename, {
      content: version.content,
      type: current ? current.type : 'text'
    });
    if (restored) {
      db.addAuditLog('version_restore', `Restored ${version.filename} from version ${version.id}`, getClientIp(req), authData.token);
      sendJson(res, { success: true, message: 'Version restored', filename: version.filename });
    } else {
      sendJson(res, { success: false, error: 'Failed to restore version' }, 500);
    }
    return true;
  }

  // DELETE /api/file-version/:versionId — delete a specific version
  const delVersionMatch = pathname.match(/^\/api\/file-version\/(\d+)$/);
  if (delVersionMatch && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const version = db.getFileVersion(parseInt(delVersionMatch[1]));
    if (!version) {
      sendJson(res, { success: false, error: 'Version not found' }, 404);
      return true;
    }
    db.deleteFileVersion(parseInt(delVersionMatch[1]));
    sendJson(res, { success: true });
    return true;
  }

  // GET /api/trash — list trash items
  if (pathname === '/api/trash' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const trash = db.listTrash(100);
    sendJson(res, { success: true, trash });
    return true;
  }

  // POST /api/trash/:id/restore — restore from trash
  const trashRestoreMatch = pathname.match(/^\/api\/trash\/(\d+)\/restore$/);
  if (trashRestoreMatch && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const result = db.restoreFromTrash(parseInt(trashRestoreMatch[1]));
    if (result.success) {
      addAuditLog('trash_restore', `filename=${result.filename}`, getClientIp(req), authData.token);
    }
    sendJson(res, result);
    return true;
  }

  // DELETE /api/trash/:id — permanently delete a trash item
  const trashDeleteMatch = pathname.match(/^\/api\/trash\/(\d+)$/);
  if (trashDeleteMatch && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const trashId = parseInt(trashDeleteMatch[1]);
    if (!Number.isInteger(trashId) || trashId <= 0) {
      sendJson(res, { success: false, error: 'Invalid trash ID' }, 400);
      return true;
    }
    db.permanentlyDeleteTrash(trashId);
    db.addAuditLog('trash_delete', `trash_id=${trashId}`, getClientIp(req), authData.token);
    sendJson(res, { success: true });
    return true;
  }

  // DELETE /api/trash — empty all trash
  if (pathname === '/api/trash' && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const trash = db.listTrash(9999);
    const count = trash.length;
    for (const item of trash) {
      db.permanentlyDeleteTrash(item.id);
    }
    addAuditLog('trash_empty', `count=${count}`, getClientIp(req), authData.token);
    sendJson(res, { success: true, count });
    return true;
  }

  // DELETE /api/file/:filename/permanent — permanently delete (skip trash)
  const filePermanentDeleteMatch = pathname.match(/^\/api\/file\/(.+)\/permanent$/);
  if (filePermanentDeleteMatch && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const filename = decodeURIComponent(filePermanentDeleteMatch[1]);
    const existing = db.getFileByName(filename);
    if (!existing) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }
    db.permanentlyDeleteFile(filename);
    addAuditLog('file_permanent_delete', `filename=${filename}`, getClientIp(req), authData.token);
    sendJson(res, { success: true });
    return true;
  }

  // GET /api/dashboard - 全局统计 Dashboard
  if (pathname === '/api/dashboard' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const stats = db.getDashboardStats();
    sendJson(res, { success: true, ...stats });
    return true;
  }

  // GET /api/file-versions/:filename - list versions
  // GET /api/file-versions/:filename/:versionId - get specific version
  if (pathname.startsWith('/api/file-versions/') && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const rest = pathname.slice('/api/file-versions/'.length);
    const parts = rest.split('/');
    const filename = parts[0] ? decodeURIComponent(parts[0]) : null;
    if (!filename) { sendJson(res, { success: false, error: 'Missing filename' }, 400); return true; }
    const file = db.getFileByName(filename);
    if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return true; }

    if (parts.length === 1 || (parts.length === 2 && parts[1] === '')) {
      // List versions
      const versions = db.listFileVersions(file.id, 20);
      sendJson(res, { success: true, filename, currentHash: file.hash, versions });
    } else {
      // Get specific version
      const versionId = parts.length >= 2 ? parseInt(parts[1]) : null;
      if (!versionId) { sendJson(res, { success: false, error: 'Missing versionId' }, 400); return true; }
      const version = db.getFileVersion(versionId);
      if (!version) { sendJson(res, { success: false, error: 'Version not found' }, 404); return true; }
      sendJson(res, { success: true, version });
    }
    return true;
  }

  // POST /api/file-versions/:filename/:versionId/restore - restore version
  if (pathname.match(/^\/api\/file-versions\/[^/]+\/\d+\/restore$/) && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const parts = pathname.match(/^\/api\/file-versions\/([^/]+)\/(\d+)\/restore$/);
    const filename = decodeURIComponent(parts[1]);
    const versionId = parseInt(parts[2]);
    const file = db.getFileByName(filename);
    if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return true; }
    const version = db.getFileVersion(versionId);
    if (!version) { sendJson(res, { success: false, error: 'Version not found' }, 404); return true; }
    db.updateFileByName(filename, { content: version.content, type: file.type });
    db.addAuditLog('file_version_restore', `filename=${filename}, version=${versionId}`, getClientIp(req), authData.token);
    sendJson(res, { success: true, message: 'Version restored', newHash: file.hash });
    return true;
  }

  // POST /api/file/batch-move - 批量移动文件到目标文件夹
  if (pathname === '/api/file/batch-move' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filenames, destFolder } = JSON.parse(body);
        if (!Array.isArray(filenames) || filenames.length === 0) {
          sendJson(res, { success: false, error: 'filenames 必须是非空数组' }, 400);
          return;
        }
        const result = db.batchMove(filenames, destFolder || '');
        db.addAuditLog('batch_move', `count=${filenames.length}, dest=${destFolder || '/'}, success=${result.success}`, getClientIp(req), authData.token);
        sendJson(res, result);
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/file/batch-copy - 批量复制文件到目标文件夹
  if (pathname === '/api/file/batch-copy' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filenames, destFolder } = JSON.parse(body);
        if (!Array.isArray(filenames) || filenames.length === 0) {
          sendJson(res, { success: false, error: 'filenames 必须是非空数组' }, 400);
          return;
        }
        const result = db.batchCopy(filenames, destFolder || '');
        db.addAuditLog('batch_copy', `count=${filenames.length}, dest=${destFolder || '/'}, success=${result.success}`, getClientIp(req), authData.token);
        sendJson(res, result);
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/remote-upload - Download file from remote URL
  if (pathname === '/api/remote-upload' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { url, filename } = JSON.parse(body);
        if (!url || !filename) {
          sendJson(res, { success: false, error: 'url and filename required' }, 400);
          return;
        }
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          sendJson(res, { success: false, error: 'Only http/https URLs allowed' }, 400);
          return;
        }
        const response = await fetch(url, { timeout: 30000 });
        if (!response.ok) {
          sendJson(res, { success: false, error: `HTTP ${response.status} ${response.statusText}` }, 400);
          return;
        }
        const buffer = await response.arrayBuffer();
        const content = Buffer.from(buffer).toString('base64');
        const size = buffer.byteLength;
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const result = db.addFile(filename, content, 'file', size, null, { content_type: contentType });
        broadcastChange('file_create', { filename, type: 'file' });
        db.addAuditLog('remote_upload', `url=${url}, filename=${filename}, size=${size}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, filename, size, hash: result?.hash });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/search/history — 获取搜索历史
  if (pathname === '/api/search/history' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const limit = parseInt(query.get('limit') || '20', 10);
    const history = db.getSearchHistory(authData.userId, limit);
    sendJson(res, { success: true, history });
    return true;
  }

  // POST /api/search/history — 添加搜索记录
  if (pathname === '/api/search/history' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { query: q } = JSON.parse(body);
        if (q && q.trim().length > 0) {
          db.addSearchHistory(q.trim(), authData.userId);
        }
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // DELETE /api/search/history — 清除搜索历史
  if (pathname === '/api/search/history' && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    db.clearSearchHistory(authData.userId);
    sendJson(res, { success: true });
    return true;
  }

  // GET /api/export — 全量数据导出（JSON）
  if (pathname === '/api/export' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    try {
      const data = db.exportAllData();
      const json = JSON.stringify(data, null, 2);
      const filename = `sharetool-backup-${new Date().toISOString().slice(0, 10)}.json`;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': Buffer.byteLength(json)
      });
      res.end(json);
      db.addAuditLog('data_export', `files=${data.files.length}, links=${data.shareLinks.length}`, getClientIp(req), authData.token);
    } catch (e) {
      sendJson(res, { success: false, error: e.message }, 500);
    }
    return true;
  }

  // POST /api/import — 数据导入
  if (pathname === '/api/import' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { data, mode = 'merge' } = JSON.parse(body);
        if (!data || !data.files) {
          sendJson(res, { success: false, error: 'Invalid backup data' }, 400);
          return;
        }
        if (!['merge', 'replace'].includes(mode)) {
          sendJson(res, { success: false, error: 'Mode must be "merge" or "replace"' }, 400);
          return;
        }
        const result = db.importAllData(data, mode);
        db.addAuditLog('data_import', `mode=${mode}, files=${result.filesImported}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, ...result });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/notifications — 获取通知列表
  if (pathname === '/api/notifications' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const limit = parseInt(query.limit) || 50;
    const offset = parseInt(query.offset) || 0;
    const notifications = db.getNotifications(limit, offset);
    const unreadCount = db.getUnreadNotificationCount();
    sendJson(res, { success: true, notifications, unreadCount });
    return true;
  }

  // POST /api/notifications/read — 标记已读
  if (pathname === '/api/notifications/read' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { ids } = JSON.parse(body); // ids=null 表示全部已读
        db.markNotificationsRead(ids);
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/notifications — 创建通知
  if (pathname === '/api/notifications' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { type, title, message } = JSON.parse(body);
        if (!type || !title) {
          sendJson(res, { success: false, error: 'type and title required' }, 400);
          return;
        }
        const notification = db.addNotification(type, title, message || null);
        sendJson(res, { success: true, notification });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // DELETE /api/notifications — 删除通知
  if (pathname === '/api/notifications' && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { ids } = JSON.parse(body); // ids=null 表示全部删除
        db.clearNotifications(ids);
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // POST /api/star/batch — 批量收藏/取消收藏
  if (pathname === '/api/star/batch' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filenames = [], starred = true } = JSON.parse(body);
        if (!Array.isArray(filenames) || filenames.length === 0) {
          sendJson(res, { success: false, error: 'filenames array required' }, 400);
          return;
        }
        let updated = 0, failed = 0;
        for (const filename of filenames) {
          try {
            db.updateFileByName(filename, { starred: starred ? 1 : 0 });
            updated++;
          } catch (e) { failed++; }
        }
        db.addAuditLog('batch_star', `updated=${updated}, failed=${failed}, starred=${starred}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, updated, failed });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/search/history — 获取搜索历史
  if (pathname === '/api/search/history' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const history = db.getSearchHistory(authData.token, 20);
    sendJson(res, { success: true, history });
    return true;
  }

  // DELETE /api/search/history — 清除搜索历史
  if (pathname === '/api/search/history' && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    db.clearSearchHistory(authData.token);
    sendJson(res, { success: true });
    return true;
  }

  // GET /api/search/popular — 热门搜索
  if (pathname === '/api/search/popular' && method === 'GET') {
    const popular = db.getPopularSearches(10);
    sendJson(res, { success: true, popular });
    return true;
  }

  // POST /api/search/log — 记录搜索（每次搜索时调用）
  if (pathname === '/api/search/log' && method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { query } = JSON.parse(body);
        if (query && query.trim().length >= 1) {
          const authData = authRequired(req, res);
          const userId = authData ? authData.token : null;
          db.addSearchHistory(query.trim(), userId);
        }
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // ============================================================
  // 虚拟文件夹 API
  // ============================================================

  // GET /api/virtual-folders — 列出所有虚拟文件夹
  if (pathname === '/api/virtual-folders' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const folders = db.listVirtualFolders();
    sendJson(res, { success: true, folders });
    return true;
  }

  // POST /api/virtual-folders — 创建虚拟文件夹
  if (pathname === '/api/virtual-folders' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { name, description, color } = JSON.parse(body);
        if (!name || !name.trim()) {
          sendJson(res, { success: false, error: 'Folder name is required' }, 400);
          return;
        }
        const result = db.createVirtualFolder(name.trim(), description || '', color || '#667eea');
        sendJson(res, result, result.success ? 201 : 400);
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // PUT /api/virtual-folders/:id — 更新虚拟文件夹
  if (pathname.match(/^\/api\/virtual-folders\/\d+$/) && method === 'PUT') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const id = parseInt(pathname.split('/')[3]);
    if (!id) { sendJson(res, { success: false, error: 'Invalid folder ID' }, 400); return true; }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const result = db.updateVirtualFolder(id, updates);
        sendJson(res, result);
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // DELETE /api/virtual-folders/:id — 删除虚拟文件夹
  if (pathname.match(/^\/api\/virtual-folders\/\d+$/) && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const id = parseInt(pathname.split('/')[3]);
    if (!id) { sendJson(res, { success: false, error: 'Invalid folder ID' }, 400); return true; }
    db.deleteVirtualFolder(id);
    sendJson(res, { success: true });
    return true;
  }

  // GET /api/virtual-folders/:id/files — 获取虚拟文件夹中的文件
  if (pathname.match(/^\/api\/virtual-folders\/\d+\/files$/) && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const parts = pathname.split('/');
    const folderId = parseInt(parts[3]);
    const limit = parseInt(parsed.query.get('limit')) || 100;
    const files = db.getVirtualFolderFiles(folderId, limit);
    sendJson(res, { success: true, files });
    return true;
  }

  // POST /api/virtual-folders/:id/files — 添加文件到虚拟文件夹
  if (pathname.match(/^\/api\/virtual-folders\/\d+\/files$/) && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const parts = pathname.split('/');
    const folderId = parseInt(parts[3]);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { fileId, filename } = JSON.parse(body);
        let targetFileId = fileId;
        if (!targetFileId && filename) {
          const file = db.getFileByName(filename);
          if (!file) { sendJson(res, { success: false, error: 'File not found' }, 404); return; }
          targetFileId = file.id;
        }
        const result = db.addFileToVirtualFolder(folderId, targetFileId);
        sendJson(res, result, result.success ? 201 : 400);
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // DELETE /api/virtual-folders/:id/files/:fileId — 从虚拟文件夹移除文件
  if (pathname.match(/^\/api\/virtual-folders\/\d+\/files\/\d+$/) && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const parts = pathname.split('/');
    const folderId = parseInt(parts[3]);
    const fileId = parseInt(parts[5]);
    db.removeFileFromVirtualFolder(folderId, fileId);
    sendJson(res, { success: true });
    return true;
  }

  return false;
};
