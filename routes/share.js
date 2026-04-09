/**
 * routes/share.js - Share link creation, validation, access, QR code generation
 */

module.exports = function handleShareRoutes(req, res, pathname, query, ctx) {
  const { db, config, sendJson, authRequired, getClientIp, createShareLink, validateShareCode, LOCAL_IP, PORT, QRCode } = ctx;
  const { method } = req;

  // POST /api/share/create
  if (pathname === '/api/share/create' && method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filename, expiryHours, maxDownloads, password, description } = JSON.parse(body);
        if (!filename) {
          sendJson(res, { success: false, error: '需要提供 filename' }, 400);
          return;
        }
        const file = db.getFileByName(filename);
        if (!file) {
          sendJson(res, { success: false, error: '文件不存在' }, 404);
          return;
        }
        const shareData = createShareLink(filename, {
          expiryHours: expiryHours || 168,
          maxDownloads: maxDownloads || null,
          password: password || null,
          isText: file.type === 'text',
          description: description || ''
        });
        const shareUrl = `http://${LOCAL_IP}:${PORT}/s/${shareData.code}`;
        db.addAuditLog('share_create', `code=${shareData.code}, filename=${filename}`, getClientIp(req));
        sendJson(res, { success: true, code: shareData.code, url: shareUrl, expiresAt: shareData.expiresAt, description: shareData.description });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/share/qr/:code
  if (pathname.startsWith('/api/share/qr/') && method === 'GET') {
    const code = pathname.slice('/api/share/qr/'.length);
    const shareData = db.getShareLink(code);
    if (!shareData) {
      res.writeHead(400);
      res.end('Share link not found');
      return true;
    }
    const shareUrl = `http://${LOCAL_IP}:${PORT}/s/${code}`;
    try {
      const dataUrl = QRCode.toDataURL(shareUrl, { margin: 2, width: 256, errorCorrectionLevel: 'M' });
      // QRCode.toDataURL is async but may return promise or string
      if (dataUrl && typeof dataUrl.then === 'function') {
        dataUrl.then(d => sendJson(res, { success: true, dataUrl: d })).catch(e => sendJson(res, { success: false, error: e.message }, 500));
      } else {
        sendJson(res, { success: true, dataUrl });
      }
    } catch (e) {
      sendJson(res, { success: false, error: e.message }, 500);
    }
    return true;
  }

  // GET /api/share/list
  if (pathname === '/api/share/list') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const links = db.listShareLinks();
    sendJson(res, { success: true, links });
    return true;
  }

  // DELETE /api/share/delete/:code
  if (pathname.startsWith('/api/share/delete/') && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const code = pathname.slice('/api/share/delete/'.length);
    db.deleteShareLink(code);
    db.addAuditLog('share_delete', `code=${code}`, getClientIp(req), authData.token);
    sendJson(res, { success: true });
    return true;
  }

  // GET /s/:code - Access share link (no auth required)
  if (pathname.startsWith('/s/')) {
    const code = pathname.slice(3);
    const inputPwd = (query && query.pwd) ? decodeURIComponent(query.pwd) : '';
    const shareData = validateShareCode(code);
    if (!shareData) {
      sendJson(res, { success: false, error: '分享链接已过期或不存在' }, 404);
      return true;
    }
    // Password verification
    if (shareData.hasPassword) {
      const clientIp = getClientIp(req);
      const rateKey = `share_verify:${clientIp}:${code}`;
      const rate = db.checkRateLimit(rateKey);
      if (!rate.allowed) {
        res.setHeader('Retry-After', rate.retryAfter);
        sendJson(res, { success: false, error: `密码错误次数过多，请 ${Math.ceil(rate.retryAfter / 60)} 分钟后重试`, retryAfter: rate.retryAfter }, 429);
        return true;
      }
      if (!inputPwd || !db.verifyPassword(inputPwd, shareData._passwordHash)) {
        db.recordRateLimitAttempt(rateKey);
        sendJson(res, { success: false, error: '此链接需要密码访问', requiresPassword: true }, 401);
        return true;
      }
      db.recordRateLimitAttempt(rateKey, true);
    }
    const file = db.getFileByName(shareData.filename);
    if (!file) {
      sendJson(res, { success: false, error: '文件已被删除' }, 404);
      return true;
    }
    db.incrementShareLinkDownload(code);
    db.addAuditLog('share_access', `code=${code}, filename=${shareData.filename}`, getClientIp(req));
    if (file.encrypted) {
      sendJson(res, { success: false, error: '加密文件无法通过分享链接访问，请在 App 中打开' }, 403);
      return true;
    }
    if (file.type === 'text') {
      sendJson(res, { success: true, type: 'text', filename: file.filename, content: file.content });
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(file.filename)}"`,
        'Content-Length': file.size
      });
      res.end(file.content || '');
    }
    return true;
  }

  return false;
};
