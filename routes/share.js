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

  return false;
};
