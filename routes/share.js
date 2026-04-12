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
          req.on('data', (chunk) => { raw += chunk; });
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

    const result = db.incrementShareLinkDownload(code);
    if (!result.allowed) {
      sendHtml(res, '<!doctype html><html><body style="font-family:sans-serif;padding:40px;"><h2>分享次数已用尽</h2></body></html>', 410);
      return true;
    }

    db.addAuditLog('share_access', `${code}:${file.filename}`, getClientIp(req));

    if (file.type === 'text' || share.isText) {
      const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(file.filename)}</title>
  <style>
    body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b1020;color:#e5e7eb;margin:0;padding:24px}
    .wrap{max-width:980px;margin:0 auto}
    h1{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:20px;margin:0 0 16px}
    pre{white-space:pre-wrap;word-break:break-word;background:#111827;border:1px solid #1f2937;border-radius:16px;padding:20px;line-height:1.6}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(file.filename)}</h1>
    <pre>${escapeHtml(file.content || '')}</pre>
  </div>
</body>
</html>`;
      sendHtml(res, page);
      return true;
    }

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
