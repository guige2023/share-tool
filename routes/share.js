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
        const shareUrl = `${req.headers.origin}/s/${shareData.code}?utm_source=sharetool&utm_medium=api_create&utm_campaign=sharetool`;
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
    const shareUrl = `${req.headers.origin}/s/${code}?utm_source=sharetool&utm_medium=qr_code&utm_campaign=sharetool`;
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
    const origin = req.headers.origin || '';
    const baseUrl = origin.replace(/\/+$/, '');
    const linksWithUrl = links.map(l => ({
      ...l,
      url: `${baseUrl}/s/${l.code}`
    }));
    sendJson(res, { success: true, links: linksWithUrl });
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
        const { expiryHours, maxDownloads, password, description } = JSON.parse(body);
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
        if (description !== undefined) {
          updates.description = description || '';
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
          const dlResult = db.incrementShareLinkDownload(code);
          if (!dlResult.allowed) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, error: '下载次数已达上限（' + dlResult.downloadCount + '/' + dlResult.maxDownloads + '）' }));
            return;
          }
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
    const dlResult = db.incrementShareLinkDownload(code);
    if (!dlResult.allowed) {
      sendJson(res, { success: false, error: '下载次数已达上限（' + dlResult.downloadCount + '/' + dlResult.maxDownloads + '）' }, 403);
      return true;
    }
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

  // ============================================================
  // 文件收集链接（公开上传页面）
  // ============================================================

  // POST /api/request/create - 创建收集链接（需认证）
  if (pathname === '/api/request/create' && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { name, targetFolder, expiresInDays, maxUploads, password } = JSON.parse(body);
        const result = db.createRequestLink({
          name: name || '文件收集',
          targetFolder: targetFolder || '',
          expiresInDays: expiresInDays || 30,
          maxUploads: maxUploads || null,
          password: password || null,
          createdBy: authData.token
        });
        const linkUrl = `${req.headers.origin}/r/${result.code}`;
        db.addAuditLog('request_link_create', `code=${result.code}, name=${name}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, code: result.code, url: linkUrl });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /api/request/list - 列出收集链接（需认证）
  if (pathname === '/api/request/list' && method === 'GET') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const links = db.listRequestLinks(authData.token);
    sendJson(res, { success: true, links });
    return true;
  }

  // DELETE /api/request/:code - 删除收集链接（需认证）
  if (pathname.match(/^\/api\/request\/[a-zA-Z0-9]+$/) && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const code = pathname.slice('/api/request/'.length);
    db.deleteRequestLink(code);
    db.addAuditLog('request_link_delete', `code=${code}`, getClientIp(req), authData.token);
    sendJson(res, { success: true });
    return true;
  }

  // POST /api/request/:code/toggle - 启用/停用收集链接（需认证）
  if (pathname.match(/^\/api\/request\/[a-zA-Z0-9]+\/toggle$/) && method === 'POST') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    const code = pathname.slice('/api/request/'.length).replace('/toggle', '');
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { active } = JSON.parse(body);
        db.toggleRequestLinkActive(code, active);
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // GET /r/:code - 公开收集页面上传页面（无需认证）
  if (pathname.startsWith('/r/') && method === 'GET' && !pathname.includes('/upload')) {
    const code = pathname.slice(3);
    const link = db.getRequestLink(code);
    if (!link) {
      sendHtml(res, '<html><body style="font-family:sans-serif;text-align:center;padding:40px;"><h2>收集链接不存在或已失效</h2></body></html>', 404);
      return true;
    }
    if (!link.active) {
      sendHtml(res, '<html><body style="font-family:sans-serif;text-align:center;padding:40px;"><h2>此收集链接已停用</h2></body></html>', 410);
      return true;
    }
    // 检查过期
    if (link.expires_at && Date.now() / 1000 > link.expires_at) {
      sendHtml(res, '<html><body style="font-family:sans-serif;text-align:center;padding:40px;"><h2>此收集链接已过期</h2></body></html>', 410);
      return true;
    }
    // 检查上传次数上限
    if (link.max_uploads && link.upload_count >= link.max_uploads) {
      sendHtml(res, '<html><body style="font-family:sans-serif;text-align:center;padding:40px;"><h2>已达到最大上传次数</h2></body></html>', 410);
      return true;
    }
    // 密码验证
    if (link.password) {
      const token = query && query.token;
      if (!token || !ctx._requestLinkTokens || !ctx._requestLinkTokens[token] || ctx._requestLinkTokens[token] !== code) {
        // 显示密码输入页
        const page = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(link.name)} - 密码验证</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#fff;border-radius:16px;padding:40px;max-width:360px;width:90%;box-shadow:0 4px 24px rgba(0,0,0,.1)}
h1{font-size:20px;margin-bottom:8px;color:#1a1a1a}
p{color:#666;font-size:14px;margin-bottom:24px}
input{width:100%;padding:12px 16px;border:2px solid #e5e5e5;border-radius:10px;font-size:16px;outline:none;transition:border-color .2s}
input:focus{border-color:#3b82f6}
.btn{width:100%;padding:14px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:16px;cursor:pointer;margin-top:16px}
.btn:hover{background:#2563eb}
.error{color:#ef4444;font-size:13px;margin-top:10px;display:none}
@media(prefers-color-scheme:dark){
body{background:#1a1a2e}
.card{background:#16213e}
h1{color:#e0e0e0}
p{color:#a0a0a0}
input{background:#0f3460;border-color:#0f3460;color:#e0e0e0}
}
</style>
</head>
<body>
<div class="card">
<h1>🔐 ${escapeHtml(link.name)}</h1>
<p>请输入访问密码</p>
<form id="f">
<input type="password" id="pwd" placeholder="输入密码" autofocus required>
<div class="error" id="e"></div>
<button type="submit" class="btn">验证</button>
</form>
</div>
<script>
document.getElementById('f').onsubmit=function(e){
e.preventDefault();
fetch('/r/${code}/verify?pwd='+encodeURIComponent(document.getElementById('pwd').value))
.then(r=>r.json())
.then(d=>{if(d.success)location.reload();else{document.getElementById('e').style.display='block';document.getElementById('e').textContent=d.error||'密码错误';}});
};
</script>
</body>
</html>`;
        sendHtml(res, page);
        return true;
      }
    }
    // 渲染上传页面
    const uploadPage = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(link.name)} - 文件收集</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;min-height:100vh;padding:20px}
.header{text-align:center;margin-bottom:32px}
.header h1{font-size:24px;color:#1a1a1a;margin-bottom:4px}
.header p{color:#666;font-size:14px}
.drop-zone{border:3px dashed #e5e5e5;border-radius:20px;padding:60px 20px;text-align:center;cursor:pointer;transition:all .2s;background:#fff}
.drop-zone.dragover{border-color:#3b82f6;background:#eff6ff}
.drop-zone:hover{border-color:#3b82f6}
.drop-icon{font-size:48px;margin-bottom:12px}
.drop-text{font-size:16px;color:#666}
.drop-hint{font-size:12px;color:#999;margin-top:8px}
input[type="file"]{display:none}
.btn{background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:12px 24px;font-size:15px;cursor:pointer;margin-top:16px}
.btn:hover{background:#2563eb}
.progress{margin-top:16px}
.progress-bar{height:6px;background:#e5e5e5;border-radius:3px;overflow:hidden}
.progress-fill{height:100%;background:#3b82f6;transition:width .3s}
.progress-text{font-size:13px;color:#666;margin-top:6px;text-align:center}
.file-list{margin-top:24px;max-width:500px;margin-left:auto;margin-right:auto;text-align:left}
.file-item{background:#fff;border-radius:10px;padding:12px 16px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.file-name{font-size:14px;color:#1a1a1a;word-break:break-all;flex:1}
.file-size{font-size:12px;color:#999;margin-left:12px;flex-shrink:0}
.msg{margin-top:16px;text-align:center;font-size:14px;padding:12px;border-radius:8px}
.msg.ok{background:#dcfce7;color:#166534}
.msg.err{background:#fee2e2;color:#991b1b}
@media(prefers-color-scheme:dark){
body{background:#1a1a2e}
.drop-zone{background:#16213e;border-color:#0f3460}
.drop-zone:hover,.drop-zone.dragover{border-color:#3b82f6;background:#1e3a5f}
.drop-text{color:#a0a0a0}
h1{color:#e0e0e0}
.file-item{background:#16213e}
.file-name{color:#e0e0e0}
}
</style>
</head>
<body>
<div class="header">
<h1>📤 ${escapeHtml(link.name)}</h1>
<p>已上传 ${link.upload_count}${link.max_uploads ? ' / ' + link.max_uploads : ''} 个文件</p>
</div>
<div class="drop-zone" id="dz">
<div class="drop-icon">📁</div>
<div class="drop-text">拖拽文件到此处或点击选择</div>
<div class="drop-hint">支持所有文件类型，单个文件不超过 200MB</div>
</div>
<input type="file" id="fi" multiple>
<div class="progress" id="pr" style="display:none">
<div class="progress-bar"><div class="progress-fill" id="pf" style="width:0%"></div></div>
<div class="progress-text" id="pt">0%</div>
</div>
<div class="file-list" id="fl"></div>
<div id="msg"></div>
<script>
const dz=document.getElementById('dz'),fi=document.getElementById('fi'),pr=document.getElementById('pr'),pf=document.getElementById('pf'),pt=document.getElementById('pt'),fl=document.getElementById('fl'),msg=document.getElementById('msg');
dz.onclick=()=>fi.click();
dz.ondragover=e=>{e.preventDefault();dz.classList.add('dragover')};
dz.ondragleave=()=>dz.classList.remove('dragover');
dz.ondrop=e=>{e.preventDefault();dz.classList.remove('dragover');handleFiles(e.dataTransfer.files)};
fi.onchange=()=>handleFiles(fi.files);
function fmt(n){if(n<1024)return n+'B';if(n<1048576)return(n/1024).toFixed(1)+'KB';return(n/1048576).toFixed(1)+'MB'}
function handleFiles(files){
  Array.from(files).forEach(f=>upload(f));
}
function upload(file){
  pr.style.display='block';
  pf.style.width='0%';
  pt.textContent='0%';
  const x=new XMLHttpRequest(),fd=new FormData();
  fd.append('file',file);
  x.upload.onprogress=e=>{
    if(e.lengthComputable){
      const pct=Math.round(e.loaded/e.total*100);
      pf.style.width=pct+'%';
      pt.textContent=file.name+': '+pct+'% ('+fmt(e.loaded)+'/'+fmt(e.total)+')';
    }
  };
  x.onload=()=>{
    if(x.status===200){
      const r=JSON.parse(x.responseText);
      if(r.success){
        fl.innerHTML+='<div class="file-item"><span class="file-name">'+(''+file.name).replace(/</g,'&lt;')+'</span><span class="file-size">'+fmt(file.size)+' \u2713</span></div>';
        msg.innerHTML='<div class="msg ok">文件上传成功！可以继续上传更多文件。</div>';
        msg.scrollIntoView({behavior:'smooth'});
        setTimeout(()=>msg.innerHTML='',3000);
      } else {
        msg.innerHTML='<div class="msg err">上传失败: '+(r.error||'未知错误')+'</div>';
      }
    } else {
      msg.innerHTML='<div class="msg err">上传失败 (HTTP '+x.status+')</div>';
    }
    pf.style.width='100%';
    pt.textContent='完成';
    setTimeout(()=>pr.style.display='none',2000);
  };
  x.onerror=()=>{msg.innerHTML='<div class="msg err">网络错误</div>';pr.style.display='none'};
  x.open('POST','/r/${code}/upload');
  x.send(fd);
}
</script>
</body>
</html>`;
    sendHtml(res, uploadPage);
    return true;
  }

  // GET /r/:code/verify - 验证收集链接密码
  if (pathname.match(/^\/r\/[a-zA-Z0-9]+\/verify$/) && method === 'GET') {
    const code = pathname.match(/^\/r\/([a-zA-Z0-9]+)\/verify$/)[1];
    const pwd = query && query.pwd;
    if (!pwd) {
      sendJson(res, { success: false, error: '需要密码' }, 400);
      return true;
    }
    if (!ctx._requestLinkTokens) ctx._requestLinkTokens = {};
    const valid = db.verifyRequestLinkPassword(code, pwd);
    if (valid) {
      const token = Math.random().toString(36).slice(2);
      ctx._requestLinkTokens[token] = code;
      setTimeout(() => { if (ctx._requestLinkTokens) delete ctx._requestLinkTokens[token]; }, 3600000);
      sendJson(res, { success: true, token });
    } else {
      sendJson(res, { success: false, error: '密码错误' }, 401);
    }
    return true;
  }

  // POST /r/:code/upload - 收集链接文件上传（公开）
  if (pathname.match(/^\/r\/[a-zA-Z0-9]+\/upload$/) && method === 'POST') {
    const code = pathname.match(/^\/r\/([a-zA-Z0-9]+)\/upload$/)[1];
    const link = db.getRequestLink(code);
    if (!link || !link.active) {
      sendJson(res, { success: false, error: '收集链接不存在或已停用' }, 404);
      return true;
    }
    if (link.expires_at && Date.now() / 1000 > link.expires_at) {
      sendJson(res, { success: false, error: '收集链接已过期' }, 410);
      return true;
    }
    if (link.max_uploads && link.upload_count >= link.max_uploads) {
      sendJson(res, { success: false, error: '已达到最大上传次数' }, 410);
      return true;
    }
    if (link.password) {
      const token = query && query.token;
      if (!token || !ctx._requestLinkTokens || ctx._requestLinkTokens[token] !== code) {
        sendJson(res, { success: false, error: '请先验证密码' }, 403);
        return true;
      }
    }
    // 处理文件上传
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      sendJson(res, { success: false, error: '需要 multipart/form-data' }, 400);
      return true;
    }
    // 简单解析：读取全部内容
    let body = Buffer.alloc(0);
    req.on('data', d => { body = Buffer.concat([body, d]); });
    req.on('end', () => {
      try {
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) {
          sendJson(res, { success: false, error: 'Missing boundary' }, 400);
          return;
        }
        // 解析 multipart
        const parts = body.toString('binary').split('--' + boundary);
        let filename = null, fileContent = null;
        for (const part of parts) {
          if (part.includes('filename=')) {
            const fnMatch = part.match(/filename="([^"]+)"/);
            const match = part.match(/Content-Type:[^\r\n]+\r\n\r\n([\s\S]+?)\r\n--/);
            if (fnMatch) filename = fnMatch[1];
            if (match) {
              // Remove trailing \r\n before boundary end
              let content = match[1];
              if (content.endsWith('\r\n--')) content = content.slice(0, -3);
              fileContent = Buffer.from(content, 'binary');
            }
          }
        }
        if (!filename || !fileContent) {
          sendJson(res, { success: false, error: '无法解析上传文件' }, 400);
          return;
        }
        // 清理文件名
        filename = filename.replace(/[/\\:*?"<>|]/g, '_').slice(0, 255);
        // 保存到目标文件夹
        const targetName = link.target_folder ? link.target_folder + '/' + filename : filename;
        db.addFile(targetName, fileContent.toString('base64'), 'file', null);
        db.incrementRequestLinkUpload(code);
        db.addAuditLog('request_link_upload', `code=${code}, filename=${targetName}`, getClientIp(req));
        sendJson(res, { success: true, filename: targetName, size: fileContent.length });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
    });
    return true;
  }

  // POST /api/share/batch — 批量创建分享链接
  if (pathname === '/api/share/batch' && method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filenames = [], expiryHours = 168, maxDownloads = null, password = null } = JSON.parse(body);
        if (!Array.isArray(filenames) || filenames.length === 0) {
          sendJson(res, { success: false, error: 'filenames array required' }, 400);
          return;
        }
        const results = [];
        for (const filename of filenames) {
          try {
            const file = db.getFileByName(filename);
            if (!file) { results.push({ filename, success: false, error: 'File not found' }); continue; }
            const shareData = createShareLink(filename, {
              expiryHours, maxDownloads, password,
              isText: file.type === 'text', description: ''
            });
            const shareUrl = `${req.headers.origin}/s/${shareData.code}`;
            results.push({ filename, success: true, code: shareData.code, url: shareUrl, expiresAt: shareData.expiresAt });
          } catch (e) { results.push({ filename, success: false, error: e.message }); }
        }
        const successCount = results.filter(r => r.success).length;
        const failedCount = results.filter(r => !r.success).length;
        db.addAuditLog('batch_share_create', `success=${successCount}, failed=${failedCount}`, getClientIp(req));
        sendJson(res, { success: true, results, successCount, failedCount });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });
    return true;
  }

  // DELETE /api/share/batch — 批量删除分享链接
  if (pathname === '/api/share/batch' && method === 'DELETE') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { codes = [] } = JSON.parse(body);
        if (!Array.isArray(codes) || codes.length === 0) {
          sendJson(res, { success: false, error: 'codes array required' }, 400);
          return;
        }
        let deleted = 0, failed = 0;
        for (const code of codes) {
          try { db.deleteShareLink(code); deleted++; } catch (e) { failed++; }
        }
        db.addAuditLog('batch_share_delete', `deleted=${deleted}, failed=${failed}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, deleted, failed });
      } catch (e) { sendJson(res, { success: false, error: e.message }, 400); }
    });
    return true;
  }

  // PUT /api/share/batch — 批量更新分享链接（续期/修改密码等）
  if (pathname === '/api/share/batch' && method === 'PUT') {
    const authData = authRequired(req, res);
    if (!authData) return true;
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { codes = [], expiryHours, maxDownloads, password } = JSON.parse(body);
        if (!Array.isArray(codes) || codes.length === 0) {
          sendJson(res, { success: false, error: 'codes array required' }, 400);
          return;
        }
        const MAX_TS_MS = 32503680000000;
        const updates = {};
        if (expiryHours !== undefined) {
          updates.expiresAt = expiryHours === 0 ? MAX_TS_MS : (expiryHours ? Date.now() + expiryHours * 3600000 : MAX_TS_MS);
        }
        if (maxDownloads !== undefined) updates.maxDownloads = maxDownloads || null;
        if (password !== undefined) updates.password = password || null;
        if (Object.keys(updates).length === 0) {
          sendJson(res, { success: false, error: 'No updates provided' }, 400);
          return;
        }
        let updated = 0, failed = 0;
        for (const code of codes) {
          try {
            const result = db.updateShareLink(code, updates);
            if (result.success) updated++; else failed++;
          } catch (e) { failed++; }
        }
        db.addAuditLog('batch_share_update', `updated=${updated}, failed=${failed}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, updated, failed });
      } catch (e) { sendJson(res, { success: false, error: e.message }, 400); }
    });
    return true;
  }

  return false;
};
