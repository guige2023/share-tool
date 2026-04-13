/**
 * routes/share.js - public LAN share links
 */

module.exports = async function handleShareRoutes(req, res, pathname, query, ctx) {
  const {
    db,
    sendJson,
    sendHtml,
    authRequired,
    getClientIp,
    readJsonBody,
    createShareLink,
    validateShareCode,
    QRCode,
    escapeHtml,
    BASE_URL,
    decodeStoredFile,
    guessMimeType
  } = ctx;

  const { method } = req;

  if (pathname === '/api/share/create' && method === 'POST') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    try {
      const body = await readJsonBody(req);
      const filename = (body.filename || '').trim();
      if (!filename) {
        sendJson(res, { success: false, error: 'filename required' }, 400);
        return true;
      }

      const file = db.getFileByName(filename);
      if (!file) {
        sendJson(res, { success: false, error: 'File not found' }, 404);
        return true;
      }

      const share = createShareLink(filename, {
        expiryHours: body.expiryHours,
        maxDownloads: body.maxDownloads,
        password: body.password,
        isText: file.type === 'text',
        description: body.description || ''
      });

      const url = `${BASE_URL}/s/${share.code}`;
      db.addAuditLog('share_create', filename, getClientIp(req), auth.token);
      sendJson(res, { success: true, share: { ...share, url } });
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 400);
    }
    return true;
  }

  if (pathname === '/api/share/list' && method === 'GET') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const shares = db.listShareLinks().map((item) => ({
      code: item.code,
      filename: item.filename,
      hasPassword: item.hasPassword,
      expiresAt: item.expiresAt,
      maxDownloads: item.maxDownloads,
      downloadCount: item.downloadCount,
      description: item.description,
      url: `${BASE_URL}/s/${item.code}`
    }));
    sendJson(res, { success: true, shares });
    return true;
  }

  if (pathname.startsWith('/api/share/delete/') && method === 'DELETE') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const code = pathname.slice('/api/share/delete/'.length);
    db.deleteShareLink(code);
    db.addAuditLog('share_delete', code, getClientIp(req), auth.token);
    sendJson(res, { success: true });
    return true;
  }

  // PUT /api/share/update/:code — update share link (expires, password, maxDownloads)
  if (pathname.startsWith('/api/share/update/') && method === 'PUT') {
    const auth = authRequired(req, res);
    if (!auth) return true;

    const code = pathname.slice('/api/share/update/'.length);
    let body = '';
    req.on('data', chunk => body += chunk);
    await new Promise(resolve => req.on('end', resolve));
    let updates;
    try {
      updates = JSON.parse(body);
    } catch {
      sendJson(res, { success: false, error: 'Invalid JSON' }, 400);
      return true;
    }

    // Validate: expiresAt must be a number (ms timestamp), null/0 for never, or existing value
    if (updates.expiresAt !== undefined && updates.expiresAt !== null && updates.expiresAt !== 0 && typeof updates.expiresAt !== 'number') {
      sendJson(res, { success: false, error: 'expiresAt must be a number, null, or 0' }, 400);
      return true;
    }
    if (updates.maxDownloads !== undefined && updates.maxDownloads !== null && updates.maxDownloads !== 0 && typeof updates.maxDownloads !== 'number') {
      sendJson(res, { success: false, error: 'maxDownloads must be a number, null, or 0' }, 400);
      return true;
    }

    const result = db.updateShareLink(code, updates);
    if (!result.success) {
      sendJson(res, result, 404);
      return true;
    }
    db.addAuditLog('share_update', code, getClientIp(req), auth.token);
    sendJson(res, { success: true });
    return true;
  }

  if (pathname.startsWith('/api/share/qr/') && method === 'GET') {
    const code = pathname.slice('/api/share/qr/'.length);
    const share = db.getShareLink(code);
    if (!share) {
      sendJson(res, { success: false, error: 'Share not found' }, 404);
      return true;
    }

    const url = `${BASE_URL}/s/${code}`;
    try {
      const png = await QRCode.toBuffer(url, { width: 320, margin: 2 });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      res.end(png);
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 500);
    }
    return true;
  }

  // GET /api/request-link/qr/:code — QR code for a request link
  if (pathname.startsWith('/api/request-link/qr/') && method === 'GET') {
    const code = pathname.slice('/api/request-link/qr/'.length);
    const row = db.getRequestLink(code);
    if (!row) {
      sendJson(res, { success: false, error: 'Link not found' }, 404);
      return true;
    }
    const url = `${BASE_URL}/r/${code}`;
    try {
      const png = await QRCode.toBuffer(url, { width: 320, margin: 2 });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      res.end(png);
    } catch (error) {
      sendJson(res, { success: false, error: error.message }, 500);
    }
    return true;
  }

  // Serve file content for preview (without triggering download)
  if (pathname.startsWith('/api/share/content/') && method === 'GET') {
    const code = pathname.slice('/api/share/content/'.length);
    const share = validateShareCode(code);
    if (!share) {
      sendJson(res, { success: false, error: 'Share not found' }, 404);
      return true;
    }
    const file = db.getFileByName(share.filename);
    if (!file) {
      sendJson(res, { success: false, error: 'File not found' }, 404);
      return true;
    }
    const payload = decodeStoredFile(file);
    res.writeHead(200, {
      'Content-Type': guessMimeType(file.filename),
      'Content-Length': payload.length,
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(payload);
    return true;
  }

  if (pathname.startsWith('/s/')) {
    const code = pathname.slice('/s/'.length);
    const share = validateShareCode(code);
    if (!share) {
      sendHtml(res, '<!doctype html><html><body style="font-family:sans-serif;padding:40px;"><h2>分享链接无效或已过期</h2></body></html>', 404);
      return true;
    }

    // Track share link view (non-blocking)
    db.incrementShareLinkViewCount(code);

    const file = db.getFileByName(share.filename);
    if (!file) {
      sendHtml(res, '<!doctype html><html><body style="font-family:sans-serif;padding:40px;"><h2>文件不存在</h2></body></html>', 404);
      return true;
    }

    if (share.hasPassword) {
      if (method === 'GET') {
        const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>访问分享</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{width:min(420px,92vw);background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:28px;box-shadow:0 20px 50px rgba(0,0,0,.08)}
    h1{margin:0 0 10px;font-size:24px}
    p{color:#6b7280;line-height:1.5}
    input,button{width:100%;box-sizing:border-box;border-radius:12px;padding:14px 16px;font-size:16px}
    input{border:1px solid #d1d5db;margin:18px 0 12px}
    button{border:none;background:#111827;color:#fff;cursor:pointer}
  </style>
</head>
<body>
  <form class="card" method="post" action="/s/${escapeHtml(code)}">
    <h1>输入访问密码</h1>
    <p>${escapeHtml(file.filename)}</p>
    <input type="password" name="password" placeholder="Password" autofocus>
    <button type="submit">打开分享</button>
  </form>
</body>
</html>`;
        sendHtml(res, page);
        return true;
      }

      if (method === 'POST') {
        const body = await new Promise((resolve, reject) => {
          let raw = '';
          let size = 0;
          const limit = 1024; // 1KB max for form body
          req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) { reject(new Error('Body too large')); return; }
            raw += chunk;
          });
          req.on('end', () => resolve(raw));
          req.on('error', reject);
        });
        const form = new URLSearchParams(body);
        const password = form.get('password') || '';
        const clientIp = getClientIp(req);
        const rateKey = `share_verify:${clientIp}:${code}`;
        const rate = db.checkRateLimit(rateKey);
        if (!rate.allowed) {
          sendHtml(res, `<!doctype html><html><body style="font-family:sans-serif;padding:40px;"><h2>密码错误次数过多</h2><p>请 ${Math.ceil((rate.retryAfter || 300) / 60)} 分钟后重试</p><p><a href="javascript:history.back()">返回</a></p></body></html>`, 429);
          return true;
        }
        if (!db.verifyPassword(password, share._passwordHash)) {
          db.recordRateLimitAttempt(rateKey);
          sendHtml(res, '<!doctype html><html><body style="font-family:sans-serif;padding:40px;"><h2>密码错误</h2><p><a href="javascript:history.back()">返回重试</a></p></body></html>', 403);
          return true;
        }
        // Password correct — clear rate limit
        db.recordRateLimitAttempt(rateKey, true);
      }
    } else if (method !== 'GET') {
      sendJson(res, { success: false, error: 'Method not allowed' }, 405);
      return true;
    }

    // Show landing page for all share links (GET or POST after password)
    const isTextFile = file.type === 'text' || share.isText;
    const ext = file.filename.includes('.') ? file.filename.split('.').pop().toLowerCase() : '';
    const isImage = ['jpg','jpeg','png','gif','webp','svg','bmp','ico'].includes(ext);
    const isVideo = ['mp4','webm','mov','avi','mkv','wmv'].includes(ext);
    const isAudio = ['mp3','wav','ogg','aac','flac','m4a'].includes(ext);
    const fileSize = file.size ? (file.size > 1024*1024 ? (file.size/1024/1024).toFixed(1)+' MB' : (file.size/1024).toFixed(1)+' KB') : '未知大小';
    const createdAt = file.created_at ? new Date(file.created_at * 1000).toLocaleDateString('zh-CN') : '';

    // Text file: show content preview
    if (isTextFile) {
      const preview = file.content
        ? (file.content.length > 2000 ? file.content.slice(0, 2000) + '\n\n... (内容已截断)' : file.content)
        : '(空文件)';
      const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(file.filename)} - ShareTool</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;margin:0;padding:0}
    .wrap{max-width:860px;margin:0 auto;padding:32px 16px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.06);margin-bottom:16px}
    h1{font-size:20px;margin:0 0 8px;font-weight:600}
    .meta{color:#6b7280;font-size:13px;margin-bottom:20px}
    .meta span{margin-right:16px}
    pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f8f9fa;border:1px solid #e5e7eb;border-radius:12px;padding:20px;white-space:pre-wrap;word-break:break-word;line-height:1.7;max-height:60vh;overflow-y:auto;color:#374151}
    .dl-btn{display:inline-block;width:100%;box-sizing:border-box;background:#111827;color:#fff;border:none;border-radius:14px;padding:16px;font-size:16px;cursor:pointer;text-decoration:none;text-align:center;font-weight:500}
    .dl-btn:hover{background:#1f2937}
    .icon{font-size:40px;margin-bottom:12px}
    @media(max-width:480px){.wrap{padding:16px 12px}.card{padding:20px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="icon">📄</div>
      <h1>${escapeHtml(file.filename)}</h1>
      <div class="meta"><span>📝 文本</span><span>${fileSize}</span>${createdAt ? '<span>🗓 '+createdAt+'</span>' : ''}</div>
      ${share.description ? `<div style="background:#f0f9ff;border-radius:10px;padding:14px;margin-bottom:20px;font-size:14px;color:#1e6091;">💬 ${escapeHtml(share.description)}</div>` : ''}
      <pre>${escapeHtml(preview)}</pre>
    </div>
    <form method="post" action="/s/${escapeHtml(code)}">
      <input type="hidden" name="action" value="download">
      <button type="submit" class="dl-btn">⬇ 下载文件</button>
    </form>
  </div>
</body>
</html>`;
      sendHtml(res, page);
      return true;
    }

    // Image file: show preview + download
    if (isImage) {
      const imgSrc = `/api/share/content/${code}`;
      const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(file.filename)} - ShareTool</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;margin:0;padding:0}
    .wrap{max-width:900px;margin:0 auto;padding:32px 16px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.06);margin-bottom:16px;text-align:center}
    h1{font-size:20px;margin:0 0 8px;font-weight:600;text-align:left}
    .meta{color:#6b7280;font-size:13px;margin-bottom:20px;text-align:left}
    .meta span{margin-right:16px}
    img{max-width:100%;max-height:70vh;border-radius:12px;border:1px solid #e5e7eb;display:block;margin:0 auto}
    .dl-btn{display:inline-block;width:100%;box-sizing:border-box;background:#111827;color:#fff;border:none;border-radius:14px;padding:16px;font-size:16px;cursor:pointer;text-decoration:none;text-align:center;font-weight:500}
    .dl-btn:hover{background:#1f2937}
    @media(max-width:480px){.wrap{padding:16px 12px}.card{padding:20px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${escapeHtml(file.filename)}</h1>
      <div class="meta"><span>🖼 图片</span><span>${fileSize}</span>${createdAt ? '<span>🗓 '+createdAt+'</span>' : ''}</div>
      ${share.description ? `<div style="background:#f0f9ff;border-radius:10px;padding:14px;margin-bottom:20px;font-size:14px;color:#1e6091;text-align:left;">💬 ${escapeHtml(share.description)}</div>` : ''}
      <img src="${imgSrc}" alt="${escapeHtml(file.filename)}" loading="lazy">
    </div>
    <form method="post" action="/s/${escapeHtml(code)}">
      <input type="hidden" name="action" value="download">
      <button type="submit" class="dl-btn">⬇ 下载文件</button>
    </form>
  </div>
</body>
</html>`;
      sendHtml(res, page);
      return true;
    }

    // Video/audio: show player + download
    if (isVideo || isAudio) {
      const tag = isVideo ? 'video' : 'audio';
      const playerAttrs = isVideo ? 'controls playsinline style="max-width:100%;border-radius:12px"' : 'controls style="width:100%"';
      const mediaSrc = `/api/share/content/${code}`;
      const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(file.filename)} - ShareTool</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;margin:0;padding:0}
    .wrap{max-width:860px;margin:0 auto;padding:32px 16px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.06);margin-bottom:16px}
    h1{font-size:20px;margin:0 0 8px;font-weight:600}
    .meta{color:#6b7280;font-size:13px;margin-bottom:20px}
    .meta span{margin-right:16px}
    ${tag}{display:block;width:100%;margin:0 auto 20px;background:#000;border-radius:12px;max-height:60vh}
    .dl-btn{display:inline-block;width:100%;box-sizing:border-box;background:#111827;color:#fff;border:none;border-radius:14px;padding:16px;font-size:16px;cursor:pointer;text-decoration:none;text-align:center;font-weight:500}
    .dl-btn:hover{background:#1f2937}
    @media(max-width:480px){.wrap{padding:16px 12px}.card{padding:20px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${escapeHtml(file.filename)}</h1>
      <div class="meta"><span>${isVideo ? '🎬' : '🎵'} ${isVideo ? '视频' : '音频'}</span><span>${fileSize}</span>${createdAt ? '<span>🗓 '+createdAt+'</span>' : ''}</div>
      ${share.description ? `<div style="background:#f0f9ff;border-radius:10px;padding:14px;margin-bottom:20px;font-size:14px;color:#1e6091;">💬 ${escapeHtml(share.description)}</div>` : ''}
      <${tag} ${playerAttrs}><source src="${mediaSrc}" ></${tag}>
    </div>
    <form method="post" action="/s/${escapeHtml(code)}">
      <input type="hidden" name="action" value="download">
      <button type="submit" class="dl-btn">⬇ 下载文件</button>
    </form>
  </div>
</body>
</html>`;
      sendHtml(res, page);
      return true;
    }

    // Generic file: icon + info + download
    const iconMap = { pdf:'📕', doc:'📘', docx:'📘', xls:'📗', xlsx:'📗', ppt:'📙', pptx:'📙', zip:'🗜', rar:'🗜', '7z':'🗜', tar:'🗜', gz:'🗜', txt:'📄', md:'📝', json:'📋', xml:'📋', csv:'📊', html:'🌐', css:'🎨', js:'⚡', py:'🐍', go:'🐹', rs:'🦀', java:'☕', png:'🖼', jpg:'🖼', jpeg:'🖼', gif:'🖼', svg:'🖼', mp4:'🎬', mp3:'🎵', wav:'🎵', exe:'⚙', apk:'📱', dll:'⚙', so:'⚙', dylib:'⚙' };
    const icon = iconMap[ext] || '📎';

    const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(file.filename)} - ShareTool</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;margin:0;padding:0}
    .wrap{max-width:520px;margin:0 auto;padding:48px 16px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:36px;box-shadow:0 4px 24px rgba(0,0,0,.06);text-align:center;margin-bottom:16px}
    .icon{font-size:56px;margin-bottom:16px}
    h1{font-size:20px;margin:0 0 8px;font-weight:600;word-break:break-all}
    .meta{color:#6b7280;font-size:13px;margin-bottom:20px}
    .ext-tag{display:inline-block;background:#f3f4f6;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:500;color:#374151;text-transform:uppercase;margin-bottom:16px}
    .dl-btn{display:inline-block;width:100%;box-sizing:border-box;background:#111827;color:#fff;border:none;border-radius:14px;padding:16px;font-size:16px;cursor:pointer;text-decoration:none;text-align:center;font-weight:500}
    .dl-btn:hover{background:#1f2937}
    @media(max-width:480px){.wrap{padding:32px 12px}.card{padding:28px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="icon">${icon}</div>
      <div class="ext-tag">${escapeHtml(ext || '文件')}</div>
      <h1>${escapeHtml(file.filename)}</h1>
      <div class="meta"><span>${fileSize}</span>${createdAt ? '<span>🗓 '+createdAt+'</span>' : ''}</div>
      ${share.description ? `<div style="background:#f0f9ff;border-radius:10px;padding:14px;margin-bottom:20px;font-size:14px;color:#1e6091;text-align:left;">💬 ${escapeHtml(share.description)}</div>` : ''}
    </div>
    <form method="post" action="/s/${escapeHtml(code)}">
      <input type="hidden" name="action" value="download">
      <button type="submit" class="dl-btn">⬇ 下载文件</button>
    </form>
  </div>
</body>
</html>`;
    sendHtml(res, page);
    return true;
  }

  // POST with action=download: perform actual download
  if (pathname.startsWith('/s/') && method === 'POST') {
    const code = pathname.slice('/s/'.length);
    const share = validateShareCode(code);
    if (!share) {
      sendHtml(res, '<!doctype html><html><body style="font-family:sans-serif;padding:40px;"><h2>分享链接无效或已过期</h2></body></html>', 404);
      return true;
    }

    // Password check for password-protected shares
    if (share.hasPassword) {
      // Read body to check action
      const body = await new Promise((resolve, reject) => {
        let raw = '';
        let size = 0;
        const limit = 1024;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > limit) { reject(new Error('Body too large')); return; }
          raw += chunk;
        });
        req.on('end', () => resolve(raw));
        req.on('error', reject);
      });
      const params = new URLSearchParams(body);
      const password = params.get('password') || '';
      const action = params.get('action') || '';
      const clientIp = getClientIp(req);
      const rateKey = `share_verify:${clientIp}:${code}`;

      if (action !== 'download') {
        // Password form submission
        const rate = db.checkRateLimit(rateKey);
        if (!rate.allowed) {
          sendHtml(res, `<!doctype html><html><body style="font-family:sans-serif;padding:40px;"><h2>密码错误次数过多</h2><p>请 ${Math.ceil((rate.retryAfter || 300) / 60)} 分钟后重试</p><p><a href="javascript:history.back()">返回</a></p></body></html>`, 429);
          return true;
        }
        if (!db.verifyPassword(password, share._passwordHash)) {
          db.recordRateLimitAttempt(rateKey);
          sendHtml(res, '<!doctype html><html><body style="font-family:sans-serif;padding:40px;"><h2>密码错误</h2><p><a href="javascript:history.back()">返回重试</a></p></body></html>', 403);
          return true;
        }
        db.recordRateLimitAttempt(rateKey, true);
        // fall through to download
      } else if (!db.verifyPassword(password, share._passwordHash)) {
        sendHtml(res, '<!doctype html><html><body style="font-family:sans-serif;padding:40px;"><h2>请先输入密码</h2><p><a href="javascript:history.back()">返回</a></p></body></html>', 403);
        return true;
      }
    }

    const file = db.getFileByName(share.filename);
    if (!file) {
      sendHtml(res, '<!doctype html><html><body style="font-family:sans-serif;padding:40px;"><h2>文件不存在</h2></body></html>', 404);
      return true;
    }

    const result = db.incrementShareLinkDownload(code);
    if (!result.allowed) {
      sendHtml(res, '<!doctype html><html><body style="font-family:sans-serif;padding:40px;"><h2>分享次数已用尽</h2></body></html>', 410);
      return true;
    }
    db.addAuditLog('share_access', `${code}:${file.filename}`, getClientIp(req));

    const payload = decodeStoredFile(file);
    res.writeHead(200, {
      'Content-Type': guessMimeType(file.filename),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': payload.length
    });
    res.end(payload);
    return true;
  }

  // ── Request Links: Public Upload Page ────────────────────────────────
  // GET /r/:code - public upload page for file collection links
  if (pathname.startsWith('/r/') && method === 'GET') {
    const code = pathname.slice('/r/'.length);
    const row = db.getRequestLink(code);

    if (!row) {
      sendHtml(res, '<!doctype html><html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>链接不存在</h2><p>该文件收集链接无效或已失效</p></body></html>', 404);
      return true;
    }
    if (!row.active) {
      sendHtml(res, '<!doctype html><html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>链接已关闭</h2><p>该文件收集链接已停止收集</p></body></html>', 410);
      return true;
    }
    const now = Math.floor(Date.now() / 1000);
    if (row.expires_at && row.expires_at < now) {
      sendHtml(res, '<!doctype html><html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>链接已过期</h2><p>该文件收集链接已过期失效</p></body></html>', 410);
      return true;
    }

    // Password-protected: show password prompt
    if (row.has_password) {
      if (method === 'GET') {
        const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>文件收集 - ${escapeHtml(row.name)}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{width:min(420px,92vw);background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:28px;box-shadow:0 20px 50px rgba(0,0,0,.08)}
    h1{margin:0 0 10px;font-size:24px}
    p{color:#6b7280;line-height:1.5;margin:0 0 8px}
    input,button{width:100%;box-sizing:border-box;border-radius:12px;padding:14px 16px;font-size:16px}
    input{border:1px solid #d1d5db;margin:18px 0 12px}
    button{border:none;background:#111827;color:#fff;cursor:pointer}
    .hint{font-size:13px;color:#9ca3af;margin-top:12px}
  </style>
</head>
<body>
  <form class="card" method="post" action="/r/${escapeHtml(code)}">
    <h1>🔒 输入访问密码</h1>
    <p>${escapeHtml(row.name)}</p>
    <input type="password" name="password" placeholder="请输入密码" autofocus>
    <button type="submit">验证</button>
    <p class="hint">联系创建者获取访问密码</p>
  </form>
</body>
</html>`;
        sendHtml(res, page);
        return true;
      }
      // POST: verify password
      const body = await new Promise((resolve) => {
        let raw = '', size = 0;
        req.on('data', c => { size += c.length; if (size > 1024) return; raw += c; });
        req.on('end', () => resolve(raw));
      });
      const form = new URLSearchParams(body);
      const pwd = form.get('password') || '';
      const clientIp = getClientIp(req);
      const rateKey = `reqlink_verify:${clientIp}:${code}`;
      const rate = db.checkRateLimit(rateKey);
      if (!rate.allowed) {
        sendHtml(res, `<!doctype html><html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>尝试次数过多</h2><p>请 ${Math.ceil((rate.retryAfter || 300) / 60)} 分钟后重试</p></body></html>`, 429);
        return true;
      }
      if (!db.verifyRequestLinkPassword(code, pwd)) {
        db.recordRateLimitAttempt(rateKey);
        // Show retry page
        const retryPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>文件收集 - ${escapeHtml(row.name)}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{width:min(420px,92vw);background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:28px;box-shadow:0 20px 50px rgba(0,0,0,.08)}
    h1{margin:0 0 10px;font-size:24px;color:#dc2626}
    p{color:#6b7280;line-height:1.5;margin:0 0 8px}
    input,button{width:100%;box-sizing:border-box;border-radius:12px;padding:14px 16px;font-size:16px}
    input{border:1px solid #d1d5db;margin:18px 0 12px}
    button{border:none;background:#111827;color:#fff;cursor:pointer}
    .hint{font-size:13px;color:#9ca3af;margin-top:12px}
  </style>
</head>
<body>
  <form class="card" method="post" action="/r/${escapeHtml(code)}">
    <h1>🔒 输入访问密码</h1>
    <p>${escapeHtml(row.name)}</p>
    <p style="color:#dc2626;font-size:14px">密码错误，请重试</p>
    <input type="password" name="password" placeholder="请输入密码" autofocus>
    <button type="submit">验证</button>
    <p class="hint">联系创建者获取访问密码</p>
  </form>
</body>
</html>`;
        sendHtml(res, retryPage, 403);
        return true;
      }
      // Password correct — clear rate limit
      db.recordRateLimitAttempt(rateKey, true);
    }

    // Build upload page
    const maxUploadMb = Math.floor((5 * 1024 * 1024) / 1024 / 1024); // 5MB JSON limit
    const uploadCountInfo = row.max_uploads
      ? `<p style="color:#6b7280;font-size:14px;margin-top:4px">已收集 ${row.upload_count}/${row.max_uploads} 个文件</p>`
      : `<p style="color:#6b7280;font-size:14px;margin-top:4px">已收集 ${row.upload_count} 个文件</p>`;
    const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>文件收集 - ${escapeHtml(row.name)}</title>
  <style>
   *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;margin:0;min-height:100vh}
    .wrap{max-width:560px;margin:0 auto;padding:32px 16px}
    .header{text-align:center;margin-bottom:28px}
    .header h1{font-size:22px;margin:0 0 6px}
    .header p{color:#6b7280;font-size:14px;margin:0}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:24px;box-shadow:0 4px 16px rgba(0,0,0,.05);margin-bottom:16px}
    .drop-zone{border:2px dashed #d1d5db;border-radius:16px;padding:40px 20px;text-align:center;cursor:pointer;transition:border-color .2s,background .2s}
    .drop-zone.dragover{border-color:#667eea;background:#f5f3ff}
    .drop-zone:hover{border-color:#667eea}
    .drop-icon{font-size:48px;margin-bottom:12px}
    .drop-text{font-size:15px;color:#374151;margin-bottom:4px}
    .drop-hint{font-size:12px;color:#9ca3af}
    #fileInput{display:none}
    .file-list{margin-top:16px}
    .file-item{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#f9fafb;border-radius:10px;margin-bottom:8px;font-size:14px}
    .file-item .name{flex:1;word-break:break-all;color:#111827}
    .file-item .size{color:#9ca3af;font-size:12px;white-space:nowrap}
    .file-item .remove{color:#9ca3af;cursor:pointer;font-size:16px;line-height:1;padding:2px}
    .file-item .remove:hover{color:#dc2626}
    .file-item.success{background:#f0fdf4;border:1px solid #bbf7d0}
    .file-item.error{background:#fef2f2;border:1px solid #fecaca}
    .file-item .status{font-size:12px;white-space:nowrap}
    .file-item .status.ok{color:#16a34a}
    .file-item .status.err{color:#dc2626}
    .submit-btn{width:100%;padding:15px;border:none;border-radius:14px;background:#111827;color:#fff;font-size:16px;cursor:pointer;margin-top:8px}
    .submit-btn:hover{background:#1f2937}
    .submit-btn:disabled{background:#9ca3af;cursor:not-allowed}
    .progress-wrap{margin-top:12px;display:none}
    .progress-bar{height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden}
    .progress-fill{height:100%;background:#667eea;border-radius:3px;transition:width .3s;width:0%}
    .progress-text{font-size:12px;color:#6b7280;margin-top:4px;text-align:center}
    .msg{padding:12px 16px;border-radius:10px;font-size:14px;margin-bottom:12px;display:none}
    .msg.error{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
    .msg.success{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0}
    @media(max-width:480px){.wrap{padding:20px 12px}.card{padding:20px}}
  </style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1>📁 ${escapeHtml(row.name)}</h1>
    ${row.target_folder ? `<p>收集到文件夹: ${escapeHtml(row.target_folder)}</p>` : ''}
    ${uploadCountInfo}
  </div>
  <div class="card">
    <div id="msg" class="msg"></div>
    <div class="drop-zone" id="dropZone">
      <div class="drop-icon">📤</div>
      <div class="drop-text">拖拽文件到这里，或点击选择</div>
      <div class="drop-hint">支持任意文件类型，单个文件不超过 ${maxUploadMb}MB</div>
    </div>
    <input type="file" id="fileInput" multiple>
    <div class="file-list" id="fileList"></div>
    <div class="progress-wrap" id="progressWrap">
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      <div class="progress-text" id="progressText">上传中...</div>
    </div>
    <button class="submit-btn" id="submitBtn" disabled onclick="uploadAll()">上传文件</button>
  </div>
</div>
<script>
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const submitBtn = document.getElementById('submitBtn');
const msg = document.getElementById('msg');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const MAX_BYTES = ${5 * 1024 * 1024};
let files = [];

function showMsg(text, type) {
  msg.textContent = text;
  msg.className = 'msg ' + type;
  msg.style.display = 'block';
}

function formatSize(b) {
  if (b > 1024*1024) return (b/1024/1024).toFixed(1)+' MB';
  if (b > 1024) return (b/1024).toFixed(1)+' KB';
  return b+' B';
}

function addFiles(newFiles) {
  for (const f of newFiles) {
    if (f.size > MAX_BYTES) {
      showMsg('文件太大: '+f.name+' (最大 '+formatSize(MAX_BYTES)+')', 'error');
      continue;
    }
    const idx = files.length;
    files.push(f);
    const el = document.createElement('div');
    el.className = 'file-item';
    el.dataset.name = f.name;
    el.innerHTML = '<span class="name">'+f.name.replace(/</g,'&lt;')+'</span><span class="size">'+formatSize(f.size)+'</span><span class="remove" onclick="removeFile('+idx+')">✕</span><span class="status" id="status_'+idx+'"></span><div class="file-progress" id="fp_'+idx+'" style="display:none;margin-top:4px"><div style="height:3px;background:#e5e7eb;border-radius:2px;overflow:hidden"><div id="fpbar_'+idx+'" style="height:100%;background:#667eea;width:0%;transition:width .2s"></div></div></div>';
    fileList.appendChild(el);
  }
  submitBtn.disabled = files.length === 0;
}

function removeFile(idx) {
  files.splice(idx, 1);
  fileList.innerHTML = '';
  files.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'file-item';
    el.dataset.name = f.name;
    el.innerHTML = '<span class="name">'+f.name.replace(/</g,'&lt;')+'</span><span class="size">'+formatSize(f.size)+'</span><span class="remove" onclick="removeFile('+i+')">✕</span><span class="status" id="status_'+i+'"></span>';
    fileList.appendChild(el);
  });
  submitBtn.disabled = files.length === 0;
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('dragover'); addFiles(e.dataTransfer.files); });
fileInput.addEventListener('change', () => addFiles(fileInput.files));

async function uploadFile(f, index) {
  const statusEl = document.getElementById('status_'+index);
  const fpEl = document.getElementById('fp_'+index);
  const fpbarEl = document.getElementById('fpbar_'+index);
  const itemEl = statusEl ? statusEl.closest('.file-item') : null;
  try {
    if (fpEl) fpEl.style.display = 'block';
    const buffer = await f.arrayBuffer();
    const base64 = btoa(new Uint8Array(buffer).reduce((s,b)=>s+String.fromCharCode(b),''));
    // Fake progress: 0->70% while waiting for server
    let prog = 0;
    const progTimer = setInterval(() => {
      prog = Math.min(prog + 10, 70);
      if (fpbarEl) fpbarEl.style.width = prog+'%';
    }, 200);
    const res = await fetch('/r/${escapeHtml(code)}', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ filename: f.name, content: base64, type: 'base64' })
    });
    clearInterval(progTimer);
    const data = await res.json();
    if (fpbarEl) fpbarEl.style.width = '100%';
    if (data.success) {
      if (statusEl) { statusEl.textContent = '✓'; statusEl.className = 'status ok'; }
      if (itemEl) itemEl.classList.add('success');
    } else {
      if (statusEl) { statusEl.textContent = '✕ '+ (data.error||''); statusEl.className = 'status err'; }
      if (itemEl) itemEl.classList.add('error');
    }
  } catch(e) {
    if (fpEl) fpEl.style.display = 'none';
    if (statusEl) { statusEl.textContent = '✕ '+e.message; statusEl.className = 'status err'; }
    if (itemEl) itemEl.classList.add('error');
  }
}

async function uploadAll() {
  if (files.length === 0) return;
  submitBtn.disabled = true;
  progressWrap.style.display = 'block';
  let done = 0;
  for (let i = 0; i < files.length; i++) {
    progressText.textContent = (i+1)+' / '+files.length;
    progressFill.style.width = ((i/files.length)*100)+'%';
    await uploadFile(files[i], i);
    done++;
    progressFill.style.width = ((done/files.length)*100)+'%';
  }
  progressText.textContent = '上传完成！';
  const remaining = files.filter((f,i) => {
    const el = document.getElementById('status_'+i);
    return el && !el.classList.contains('ok');
  }).length;
  if (remaining === 0) {
    showMsg('所有文件上传成功！', 'success');
    setTimeout(() => { files = []; fileList.innerHTML = ''; submitBtn.disabled = false; progressWrap.style.display = 'none'; }, 2000);
  } else {
    showMsg(remaining+' 个文件上传失败', 'error');
    submitBtn.disabled = false;
  }
}
</script>
</body>
</html>`;
    sendHtml(res, page);
    return true;
  }

  // POST /r/:code - handle file upload from public upload page
  if (pathname.startsWith('/r/') && method === 'POST') {
    // Only handle JSON uploads from the upload page (not form-action downloads)
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      const code = pathname.slice('/r/'.length);
      const row = db.getRequestLink(code);
      if (!row || !row.active) {
        sendJson(res, { success: false, error: 'Link not available' }, 410);
        return true;
      }
      const now = Math.floor(Date.now() / 1000);
      if (row.expires_at && row.expires_at < now) {
        sendJson(res, { success: false, error: 'Link expired' }, 410);
        return true;
      }
      // Check max uploads
      if (row.max_uploads && row.upload_count >= row.max_uploads) {
        sendJson(res, { success: false, error: 'Upload limit reached' }, 410);
        return true;
      }
      // Password-protected: verify via session cookie or body token
      if (row.has_password) {
        sendJson(res, { success: false, error: 'Password required' }, 403);
        return true;
      }

      try {
        const body = await readJsonBody(req);
        const { filename, content, type } = body;
        if (!filename || !content) {
          sendJson(res, { success: false, error: 'filename and content required' }, 400);
          return true;
        }
        if (!db.validateFilename(filename)) {
          sendJson(res, { success: false, error: 'Invalid filename' }, 400);
          return true;
        }
        const decoded = type === 'base64' ? Buffer.from(content, 'base64') : content;
        const byteLen = Buffer.byteLength(decoded, 'utf8');
        if (byteLen > 5 * 1024 * 1024) {
          sendJson(res, { success: false, error: 'File too large (max 5MB)' }, 413);
          return true;
        }
        // Target folder support
        let targetName = filename;
        if (row.target_folder) {
          targetName = (row.target_folder + '/' + filename).replace(/\/+/g, '/');
        }
        // content may be a Buffer (from base64 decode) — keep as binary
        db.addFile(targetName, decoded, 'file');
        const uploadCount = db.incrementRequestLinkUpload(code);
        db.addAuditLog('request_link_upload', targetName, getClientIp(req));
        sendJson(res, { success: true, filename: targetName, upload_count: uploadCount });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
      return true;
    }

    // Otherwise fall through to share link download handler
  }

  return false;
};
