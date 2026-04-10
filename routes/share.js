/**
 * routes/share.js - Share link creation, validation, access, QR code generation
 */

module.exports = function handleShareRoutes(req, res, pathname, query, ctx) {
  const { db, config, sendJson, sendHtml, authRequired, getClientIp, createShareLink, validateShareCode, LOCAL_IP, PORT, QRCode, escapeHtml } = ctx;
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

  // PUT /api/share/update/:code
  if (pathname.startsWith('/api/share/update/') && method === 'PUT') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const code = pathname.slice('/api/share/update/'.length);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { expiryHours, maxDownloads, password } = JSON.parse(body);
        // expiryHours: null=unchanged, 0=never expire, >0=hours
        const MAX_TS_MS = 32503680000000;
        const updates = {};
        if (expiryHours !== undefined) {
          updates.expiresAt = expiryHours === 0 ? MAX_TS_MS : (expiryHours ? Date.now() + expiryHours * 3600000 : MAX_TS_MS);
        }
        if (maxDownloads !== undefined) {
          updates.maxDownloads = maxDownloads || null;
        }
        if (password !== undefined) {
          updates.password = password || null;
        }
        const result = db.updateShareLink(code, updates);
        if (!result.success) {
          sendJson(res, { success: false, error: result.error }, 400);
          return;
        }
        db.addAuditLog('share_update', `code=${code}`, getClientIp(req), authData.token);
        const updated = db.getShareLink(code);
        sendJson(res, {
          success: true,
          link: {
            code: updated.code,
            filename: updated.filename,
            hasPassword: updated.hasPassword,
            expiresAt: updated.expiresAt,
            maxDownloads: updated.maxDownloads,
            downloadCount: updated.downloadCount
          }
        });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /s/:code - Access share link (no auth required)
  if (pathname.startsWith('/s/')) {
    const code = pathname.slice(3);
    const shareData = validateShareCode(code);
    if (!shareData) {
      sendHtml(res, '<html><body style="font-family:sans-serif;padding:40px;text-align:center;color:#666;"><h2>分享链接已过期或不存在</h2></body></html>', 404);
      return true;
    }

    const file = db.getFileByName(shareData.filename);
    if (!file) {
      sendHtml(res, '<html><body style="font-family:sans-serif;padding:40px;text-align:center;color:#666;"><h2>文件已被删除</h2></body></html>', 404);
      return true;
    }

    // Password-protected: show password form (GET) or verify (POST)
    if (shareData.hasPassword) {
      if (method === 'GET') {
        // Show password entry form - password NOT in URL
        const isDark = query && query.dark === '1';
        const bg = isDark ? '#1a1a1a' : '#f5f5f5';
        const text = isDark ? '#e0e0e0' : '#333';
        const cardBg = isDark ? '#2a2a2a' : '#fff';
        const border = isDark ? '#444' : '#ddd';
        const accent = '#007AFF';
        sendHtml(res, `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>密码验证 - ${escapeHtml(file.filename)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:${bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:${cardBg};border:1px solid ${border};border-radius:16px;padding:40px;max-width:400px;width:90%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1)}
.icon{font-size:48px;margin-bottom:16px}
.filename{font-size:14px;color:${text};opacity:.6;margin-bottom:24px;word-break:break-all}
input{width:100%;padding:14px 16px;border:2px solid ${border};border-radius:10px;font-size:16px;background:${cardBg};color:${text};outline:none;transition:border-color .2s}
input:focus{border-color:${accent}}
button{width:100%;padding:14px;background:${accent};color:#fff;border:none;border-radius:10px;font-size:16px;cursor:pointer;margin-top:16px;font-weight:600}
button:hover{opacity:.85}
.error{color:#e53935;font-size:14px;margin-top:12px;display:none}
@media(prefers-color-scheme:dark){body{background:#1a1a1a}card{background:#2a2a2a;border-color:#444;color:#e0e0e0}}
</style>
</head>
<body>
<div class="card">
<div class="icon">🔒</div>
<div class="filename">${escapeHtml(file.filename)}</div>
<form method="POST" action="/s/${code}" id="pwdForm">
<input type="password" name="password" id="pwdInput" placeholder="请输入访问密码" autofocus required>
<button type="submit" id="submitBtn">验证并访问</button>
</form>
<div class="error" id="errorMsg"></div>
</div>
<script>
const form=document.getElementById('pwdForm');
const err=document.getElementById('errorMsg');
const btn=document.getElementById('submitBtn');
form.addEventListener('submit',async function(e){
e.preventDefault();
const pwd=document.getElementById('pwdInput').value;
btn.disabled=true;
btn.textContent='验证中...';
err.style.display='none';
try{
const fd=new FormData();
fd.append('password',pwd);
const r=await fetch('/s/${code}',{method:'POST',body:fd});
const d=await r.json();
if(d.success){
if(d.type==='text'){
document.getElementById('pwdForm').innerHTML='<div style="max-height:60vh;overflow:auto;background:#f5f5f5;padding:16px;border-radius:8px;text-align:left;white-space:pre-wrap;font-size:14px;">'+d.content.replace(/</g,'&lt;')+'</div>';
}else{window.location.href='/s/${code}?download=1&token='+encodeURIComponent(d.token||'');}
}else{
err.textContent=d.error||'密码错误';
err.style.display='block';
btn.disabled=false;
btn.textContent='验证并访问';
}
}catch(ex){
err.textContent='请求失败，请重试';
err.style.display='block';
btn.disabled=false;
btn.textContent='验证并访问';
}
});
</script>
</body>
</html>`);
        return true;
      }

      if (method === 'POST') {
        // Verify password from POST body
        let postData = '';
        req.on('data', d => postData += d);
        req.on('end', () => {
          const params = new URLSearchParams(postData);
          const inputPwd = params.get('password') || '';

          const clientIp = getClientIp(req);
          const rateKey = `share_verify:${clientIp}:${code}`;
          const rate = db.checkRateLimit(rateKey);
          if (!rate.allowed) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, error: `密码错误次数过多，请 ${Math.ceil(rate.retryAfter / 60)} 分钟后重试`, retryAfter: rate.retryAfter, locked: true }));
            return;
          }
          if (!inputPwd || !db.verifyPassword(inputPwd, shareData._passwordHash)) {
            db.recordRateLimitAttempt(rateKey);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, error: '密码错误', remaining: rate.remaining - 1 }));
            return;
          }
          db.recordRateLimitAttempt(rateKey, true);
          db.incrementShareLinkDownload(code);
          db.addAuditLog('share_access', `code=${code}, filename=${shareData.filename}`, clientIp);

          if (file.encrypted) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, error: '加密文件无法通过分享链接访问，请在 App 中打开' }));
            return;
          }
          if (file.type === 'text') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, type: 'text', filename: file.filename, content: file.content }));
          } else {
            // For binary files, redirect to download (no password in URL)
            const downloadToken = require('crypto').randomBytes(16).toString('hex');
            // Store token temporarily in memory (10 min expiry)
            ctx._downloadTokens = ctx._downloadTokens || {};
            ctx._downloadTokens[downloadToken] = { code, filename: file.filename, expiresAt: Date.now() + 600000 };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, downloadUrl: `/s/${code}/download?token=${downloadToken}`, filename: file.filename, size: file.size }));
          }
        });
        return true;
      }
      return true;
    }

    // No password: directly serve file
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

  // GET /s/:code/download?token=xxx - Download binary file (after password verify)
  if (pathname.startsWith('/s/') && pathname.endsWith('/download') && method === 'GET') {
    const parts = pathname.slice(3).split('/download');
    const code = parts[0];
    const token = query && query.token;
    if (!token || !ctx._downloadTokens || !ctx._downloadTokens[token]) {
      res.writeHead(403);
      res.end('Invalid or expired download token');
      return true;
    }
    const t = ctx._downloadTokens[token];
    if (t.code !== code || Date.now() > t.expiresAt) {
      delete ctx._downloadTokens[token];
      res.writeHead(403);
      res.end('Download token expired');
      return true;
    }
    delete ctx._downloadTokens[token];
    const file = db.getFileByName(t.filename);
    if (!file) {
      res.writeHead(404);
      res.end('File not found');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.filename)}"`,
      'Content-Length': file.size
    });
    res.end(file.content || '');
    return true;
  }

  return false;
};
