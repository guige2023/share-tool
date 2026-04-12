#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const QRCode = require('qrcode');
const selfsigned = require('selfsigned');

const db = require('./db');
const handleApiRoutes = require('./routes/api');
const handleFileRoutes = require('./routes/files');
const handleShareRoutes = require('./routes/share');
const { initWebSocketServer } = require('./routes/sync');

const VERSION = require('./package.json').version;
const PORT = parseInt(process.env.SHARE_TOOL_PORT || '18790', 10);
const HTTPS_PORT = parseInt(process.env.SHARE_TOOL_HTTPS_PORT || '18793', 10);
const CONFIG_DIR = path.join(os.homedir(), '.share-tool');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SSL_DIR = path.join(CONFIG_DIR, 'ssl');
const DEFAULT_TOKEN='35e7438f1e72356ebc6d4e839881cc35233ee01ec81d5af6';
const LOCAL_IP = getLocalIp();
const BASE_URL = `https://${LOCAL_IP}:${HTTPS_PORT}`;

let config = loadConfig();
const SHARE_TOKEN=process.env.SHARE_TOKEN || config.shareToken || DEFAULT_TOKEN;

db.initDatabase();
db.cleanupExpiredShareLinks();

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function loadConfig() {
  const defaults = {
    uploadMaxSizeMB: 100
  };

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch (error) {
    console.error('[ShareTool] Failed to load config:', error.message);
  }
  return defaults;
}

function saveConfig() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function maxUploadBytes() {
  return Math.max(1, parseInt(config.uploadMaxSizeMB || '100', 10)) * 1024 * 1024;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
}

function sendJson(res, data, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req);
  if (!body) return {};
  return JSON.parse(body);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function authRequired(req, res) {
  const token = req.headers['x-auth-token'];
  // Static token always valid
  if (token === SHARE_TOKEN) {
    return { token: SHARE_TOKEN, type: 'static' };
  }
  // Dynamic token from tokens table
  if (token) {
    const valid = db.validateToken(token);
    if (valid) {
      return { token, type: 'dynamic', deviceId: valid.device_id };
    }
  }
  sendJson(res, { success: false, error: 'Unauthorized' }, 401);
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isProbablyBase64(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

function decodeStoredFile(file) {
  const content = file && typeof file.content === 'string' ? file.content : '';
  if (!content) return Buffer.alloc(0);
  if (file.type === 'text') return Buffer.from(content, 'utf8');
  if (isProbablyBase64(content)) return Buffer.from(content, 'base64');
  return Buffer.from(content, 'utf8');
}

function guessMimeType(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map = {
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    json: 'application/json; charset=utf-8',
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    zip: 'application/zip'
  };
  return map[ext] || 'application/octet-stream';
}

function generateShareCode() {
  return crypto.randomBytes(4).toString('hex');
}

async function generateSelfSignedCert() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, value: '127.0.0.1' }
  ];
  for (const ip of ips) {
    if (ip !== '127.0.0.1') {
      altNames.push({ type: 7, value: ip });
    }
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const attrs = [{ name: 'commonName', value: 'ShareTool' }];
  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 1);
  const pems = await selfsigned.generate(attrs, {
    algorithm: 'sha256',
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }],
    primaryKey: privateKey,
    publicKey: publicKey
  });
  return { key: pems.private, cert: pems.cert };
}

async function getOrCreateCertificate() {
  const certPath = path.join(SSL_DIR, 'cert.pem');
  const keyPath = path.join(SSL_DIR, 'key.pem');
  try {
    if (!fs.existsSync(SSL_DIR)) {
      fs.mkdirSync(SSL_DIR, { recursive: true });
    }
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const certPem = fs.readFileSync(certPath, 'utf8');
      const cert = new crypto.X509Certificate(certPem);
      const daysRemaining = Math.ceil((new Date(cert.validTo) - new Date()) / 86400000);
      if (daysRemaining > 7) {
        console.log(`[ShareTool] Using existing certificate (expires in ${daysRemaining} days)`);
        return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
      }
      console.log('[ShareTool] Certificate expires soon, regenerating...');
    }
  } catch (e) {
    console.log('[ShareTool] Certificate check failed, regenerating...');
  }
  const pems = await generateSelfSignedCert();
  fs.writeFileSync(keyPath, pems.key, { mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert, { mode: 0o644 });
  console.log('[ShareTool] Self-signed certificate generated');
  console.log(`[ShareTool] Certificate: ${path.join(SSL_DIR, 'cert.pem')}`);
  return { key: pems.key, cert: pems.cert };
}

function createShareLink(filename, options = {}) {
  const now = Date.now();
  const hours = options.expiryHours === undefined || options.expiryHours === null || options.expiryHours === ''
    ? 168
    : parseInt(options.expiryHours, 10);
  const expiresAt = hours > 0 ? now + hours * 60 * 60 * 1000 : 0;
  const share = db.saveShareLink({
    code: generateShareCode(),
    filename,
    isText: !!options.isText,
    password: options.password || null,
    expiresAt,
    maxDownloads: options.maxDownloads ? parseInt(options.maxDownloads, 10) : null,
    description: options.description || ''
  });
  return share;
}

function validateShareCode(code) {
  const share = db.getShareLink(code);
  if (!share) return null;
  if (share.expiresAt && Date.now() > share.expiresAt) {
    db.deleteShareLink(code);
    return null;
  }
  if (share.maxDownloads && share.downloadCount >= share.maxDownloads) {
    return null;
  }
  return share;
}

function renderPage() {
  const pageInfo = {
    version: VERSION,
    token: SHARE_TOKEN,
    localIp: LOCAL_IP,
    port: HTTPS_PORT,
    maxUploadSizeMB: config.uploadMaxSizeMB
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ShareTool</title>
  <style>
    :root{
      --bg:#f4f7fb;
      --panel:#ffffff;
      --line:#dbe4f0;
      --text:#0f172a;
      --muted:#64748b;
      --accent:#0f766e;
      --accent-weak:#dff7f1;
      --danger:#b91c1c;
      --shadow:0 24px 60px rgba(15,23,42,.08);
    }
    @media (prefers-color-scheme: dark) {
      :root{
        --bg:#0f172a;
        --panel:#1e293b;
        --line:#334155;
        --text:#f1f5f9;
        --muted:#94a3b8;
        --accent:#2dd4bf;
        --accent-weak:#134e4a;
        --danger:#f87171;
        --shadow:0 24px 60px rgba(0,0,0,.3);
      }
      body{background:var(--bg);color:var(--text)}
      .hero{background:rgba(30,41,59,.86)}
      input[type="text"],input[type="password"],input[type="number"],textarea{background:#0f172a;color:#f1f5f9;border-color:#334155}
      pre{background:#0f172a!important;color:#e2e8f0!important}
      .modal-card{background:#1e293b}
      .panel{background:#1e293b;border-color:#334155}
      .toast{background:#1e293b;color:#f1f5f9}
      #toast{background:#1e293b;color:#f1f5f9}
      .chip{color:#2dd4bf}
      .tag-badge{color:#c7d2fe}
      .fab{background:#0f766e}
    }
    [data-theme="dark"]{
      --bg:#0f172a;
      --panel:#1e293b;
      --line:#334155;
      --text:#f1f5f9;
      --muted:#94a3b8;
      --accent:#2dd4bf;
      --accent-weak:#134e4a;
      --danger:#f87171;
      --shadow:0 24px 60px rgba(0,0,0,.3);
    }
    [data-theme="dark"] body{background:var(--bg);color:var(--text)}
    [data-theme="dark"] .hero{background:rgba(30,41,59,.86)}
    [data-theme="dark"] input[type="text"],
    [data-theme="dark"] input[type="password"],
    [data-theme="dark"] input[type="number"],
    [data-theme="dark"] textarea{background:#0f172a;color:#f1f5f9;border-color:#334155}
    [data-theme="dark"] pre{background:#0f172a!important;color:#e2e8f0!important}
    [data-theme="dark"] .modal-card{background:#1e293b}
    [data-theme="dark"] .panel{background:#1e293b;border-color:#334155}
    [data-theme="dark"] #toast{background:#1e293b;color:#f1f5f9}
    [data-theme="dark"] .chip{color:#2dd4bf}
    [data-theme="dark"] .tag-badge{color:#c7d2fe}
    [data-theme="dark"] .fab{background:#0f766e}
    *{box-sizing:border-box}
    [data-theme="dark"] body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    [data-theme="dark"] .hero{border-color:var(--line);background:rgba(30,41,59,.86)}
    [data-theme="dark"] .modal-card pre{background:#0f172a!important;color:#e2e8f0!important}
    [data-theme="dark"] button.secondary{background:#334155;color:#f1f5f9}
    [data-theme="dark"] .tag-badge{color:#c7d2fe}
    [data-theme="dark"] .progress-bar-wrap{background:#1e293b}
    [data-theme="dark"] .shares img{background:#0f172a}
    [data-theme="dark"] .shares .empty-state span{color:#94a3b8}
    [data-theme="dark"] input[type="text"], [data-theme="dark"] input[type="password"], [data-theme="dark"] input[type="number"], [data-theme="dark"] textarea{background:#0f172a;color:#f1f5f9;border-color:#334155}
    [data-theme="dark"] button{background:#334155;color:#f1f5f9}
    [data-theme="dark"] button.secondary{background:#334155}
    body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .wrap{max-width:1200px;margin:0 auto;padding:24px}
    .hero{display:grid;gap:18px;padding:28px;border:1px solid var(--line);border-radius:28px;background:rgba(255,255,255,.86);backdrop-filter:blur(10px);box-shadow:var(--shadow)}
    .hero h1{margin:0;font-size:34px}
    .hero p{margin:0;color:var(--muted);line-height:1.6}
    .meta{display:flex;flex-wrap:wrap;gap:10px}
    .chip{display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;background:var(--accent-weak);color:#0f513f;font-size:14px}
    .grid{display:grid;grid-template-columns:1.2fr .8fr;gap:18px;margin-top:18px}
    .panel{background:var(--panel);border:1px solid var(--line);border-radius:24px;padding:20px;box-shadow:var(--shadow)}
    .panel h2{margin:0 0 14px;font-size:20px}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    input,textarea,button{font:inherit}
    input[type="text"],input[type="password"],input[type="number"],textarea{
      width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:#fff;color:var(--text)
    }
    textarea{min-height:140px;resize:vertical}
    button{
      border:none;border-radius:14px;padding:11px 16px;background:#111827;color:#fff;cursor:pointer
    }
    button.secondary{background:#e2e8f0;color:#0f172a}
    button.danger{background:var(--danger)}
    button.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
    .drop-zone{border:2px dashed var(--line);border-radius:16px;padding:28px;text-align:center;cursor:pointer;transition:border-color .2s,background .2s;background:rgba(255,255,255,.4)}
    .drop-zone:hover,.drop-zone.dragover{border-color:var(--accent);background:rgba(16,185,129,.06)}
    .drop-zone.dragover{border-style:solid}
    .drop-zone-inner{pointer-events:none}
    .drop-icon{font-size:32px;margin-bottom:8px}
    .toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
    .toolbar input{flex:1 1 260px}
    .batch-bar{display:flex;gap:8px;align-items:center;padding:10px 14px;background:var(--bg-secondary);border-radius:12px;margin-bottom:12px;font-size:13px}
    .batch-bar button{min-height:36px;padding:6px 12px;font-size:13px;border-radius:8px;flex-shrink:0}
    .recent-search-tag{display:inline-block;padding:4px 12px;background:var(--accent-weak);color:var(--accent);border-radius:999px;font-size:12px;margin-right:6px;cursor:pointer}
    .recent-search-tag:hover{opacity:.8}
    table{width:100%;border-collapse:collapse}
    th,td{padding:12px 8px;border-bottom:1px solid #edf2f7;text-align:left;vertical-align:top;font-size:14px}
    .sort-arrow{font-size:10px;color:var(--muted);margin-left:2px}
    th{color:var(--muted);font-weight:600}
    td.actions{display:flex;gap:8px;flex-wrap:wrap}
    td.actions button{padding:8px 10px;border-radius:10px;font-size:13px}
    .muted{color:var(--muted)}
    .status{margin-top:12px;min-height:22px;color:var(--muted)}
    .progress-bar-wrap{display:none;margin-top:10px;background:#edf2f7;border-radius:999px;height:10px;overflow:hidden}
    .progress-bar-wrap.active{display:block}
    .progress-bar{height:100%;background:var(--accent);border-radius:999px;transition:width .15s;min-width:2px}
    .list-scroll{max-height:620px;overflow:auto}
    .empty{padding:30px 10px;color:var(--muted);text-align:center}
    .modal{position:fixed;inset:0;background:rgba(15,23,42,.58);display:none;align-items:center;justify-content:center;padding:20px}
    .modal.open{display:flex}
    .modal-card{width:min(900px,96vw);max-height:88vh;overflow:auto;background:#fff;border-radius:24px;padding:20px;border:1px solid var(--line)}
    .modal-card pre{white-space:pre-wrap;word-break:break-word;background:#0f172a;color:#e2e8f0;padding:18px;border-radius:16px;overflow:auto}
    .modal-card img{max-width:100%;border-radius:16px}
    .shares img{width:84px;height:84px;border:1px solid var(--line);border-radius:12px;background:#fff}
    @media (max-width: 960px){
      .grid{grid-template-columns:1fr}
      .toolbar{flex-wrap:wrap}
      .toolbar input,.toolbar button{min-width:0}
      .toolbar button{padding:9px 12px;font-size:13px}
      table,thead,tbody,tr,th,td{display:block;width:100%;box-sizing:border-box}
      thead tr{position:absolute;top:-9999px;left:-9999px}
      tbody tr{border-bottom:1px solid var(--line);padding:10px 0}
      td{padding:4px 0 4px 38%;position:relative;border:none!important}
      td:before{position:absolute;left:0;width:35%;padding-right:8px;white-space:nowrap;font-weight:600;color:var(--muted);content:attr(data-label)}
      td:first-child{padding-left:0}
      td:first-child:before{content:none}
      .actions-cell{display:flex;gap:6px;flex-wrap:wrap}
      .file-tags{max-width:none}
    }
    @media (max-width: 480px){
      /* iOS auto-zoom fix: all inputs must be >=16px */
      input,select,textarea{font-size:16px!important}
      /* Prevent iOS from auto-zooming on inputs inside toolbar/search */
      .toolbar input{font-size:16px!important}
      .search-input-wrap input{font-size:16px!important}
      .meta .chip{font-size:11px;padding:7px 10px}
      .hero h1{font-size:24px}
      .panel{padding:14px}
      .toolbar button{width:100%}
      /* Touch targets: min 44px height for buttons */
      button,.btn{min-height:44px;font-size:15px}
      /* Card-mode table: readable labels */
      td{padding:6px 0 6px 40%;font-size:13px}
      td:first-child{font-size:15px;font-weight:500}
      td.actions-cell a,td.actions-cell button{padding:8px 10px;font-size:13px}
      /* Prevent horizontal overflow */
      body{overflow-x:hidden}
    }
    /* Toast notification */
    #toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:#111827;color:#fff;padding:12px 20px;border-radius:10px;font-size:14px;opacity:0;transition:transform .3s,opacity .3s;pointer-events:none;z-index:9999;max-width:90vw;text-align:center;word-break:break-all}
    @keyframes spin{to{transform:rotate(360deg)}}
    #toast.show{transform:translateX(-50%) translateY(0);opacity:1}
    #toast.success{background:#059669}
    #toast.error{background:#dc2626}
    .file-tags{display:flex;flex-wrap:wrap;gap:3px;max-width:110px}
    .tag-badge{background:#e0e7ff;color:#3730a3;font-size:10px;padding:1px 6px;border-radius:10px;font-weight:500}
    .tag-edit-btn{background:none;border:none;color:var(--muted);cursor:pointer;font-size:10px;padding:2px 4px;border-radius:4px;transition:color .2s,background .2s}
    .tag-edit-btn:hover{color:var(--primary);background:rgba(99,102,241,.1)}
    /* Context menu */
    .ctx-item{padding:10px 16px;cursor:pointer;transition:background .15s}
    .ctx-item:hover{background:var(--bg-tertiary)}
    .ctx-sep{height:1px;background:var(--border);margin:4px 0}
    /* View toggle */
    .view-toggle{display:flex;gap:2px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:8px;padding:2px;margin-left:auto}
    .view-toggle button{background:none;border:none;color:var(--muted);cursor:pointer;padding:4px 8px;border-radius:6px;font-size:13px;line-height:1;transition:all .15s}
    .view-toggle button:hover{color:var(--text-primary)}
    .view-toggle button.active{background:var(--primary);color:#fff}
    /* Grid view */
    #fileTable,#fileTableGrid{display:table;width:100%;table-layout:fixed}
    #fileTableGrid tbody{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
    #fileTable .file-item,#fileTableGrid .file-item{display:flex;flex-direction:column;padding:14px;background:var(--bg-secondary);border:1px solid var(--line);border-radius:12px;transition:box-shadow .2s,border-color .2s;min-height:140px}
    #fileTable .file-item:hover,#fileTableGrid .file-item:hover{box-shadow:var(--shadow);border-color:var(--primary)}
    #fileTable .file-content,#fileTableGrid .file-content{flex:1}
    #fileTable .file-name,#fileTableGrid .file-name{font-size:13px;font-weight:500;word-break:break-all;margin-bottom:4px}
    #fileTable .file-meta,#fileTableGrid .file-meta{font-size:11px;color:var(--muted);margin-top:4px}
    #fileTable .file-tags,#fileTableGrid .file-tags{margin-top:6px;flex-wrap:wrap}
    #fileTable .file-tag,#fileTableGrid .file-tag{font-size:10px;padding:2px 6px}
    #fileTable .file-actions,#fileTableGrid .file-actions{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
    #fileTable .file-actions .btn,#fileTableGrid .file-actions .btn{font-size:11px;padding:5px 8px;min-height:30px}
    #fileTable .file-check-row,#fileTableGrid .file-check-row{position:absolute;top:6px;left:6px}
    #fileTable .file-item,#fileTableGrid .file-item{position:relative}
    #fileTable tbody tr,#fileTableGrid tbody tr{display:contents}
    @media (max-width: 960px) {
      #fileTable tbody tr,#fileTableGrid tbody tr{display:contents}
      #fileTableGrid tbody{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
    }
  </style>
</head>
<body>
  <div id="toast"></div>
  <div id="ctxMenu" style="display:none;position:fixed;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10000;min-width:160px;overflow:hidden;font-size:14px">
    <div class="ctx-item" onclick="ctxAction('open')">👁 查看</div>
    <div class="ctx-item" onclick="ctxAction('download')">⬇ 下载</div>
    <div class="ctx-item" onclick="ctxAction('share')">🔗 分享</div>
    <div class="ctx-item" onclick="ctxAction('copyLink')">📋 复制链接</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" onclick="ctxAction('rename')">✎ 重命名</div>
    <div class="ctx-item" onclick="ctxAction('delete')" style="color:var(--danger)">🗑 删除</div>
  </div>
  <div class="wrap">
    <section class="hero">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div>
          <h1>ShareTool</h1>
          <p>精简后的局域网分享工具，只保留局域网传文件、传文字、分享链接、搜索和下载能力。</p>
        </div>
        <select id="themeSelect" onchange="setThemeMode(this.value)" title="主题" style="background:var(--bg-secondary);border:1px solid var(--line);border-radius:12px;padding:6px 10px;cursor:pointer;font-size:13px;color:var(--text)">
          <option value="system">◐ 跟随系统</option>
          <option value="light">☀ 浅色</option>
          <option value="dark">☾ 深色</option>
        </select>
      </div>
      <div class="meta">
        <div class="chip">局域网地址 https://${escapeHtml(pageInfo.localIp)}:${pageInfo.port}</div>
        <div class="chip">Token ${escapeHtml(pageInfo.token)}</div>
        <div class="chip">最大上传 ${pageInfo.maxUploadSizeMB} MB</div>
        <div class="chip">版本 v${escapeHtml(pageInfo.version)}</div>
      </div>
    </section>

    <div class="grid">
      <section class="panel">
        <h2>分享文字</h2>
        <div class="row">
          <input id="textFilename" type="text" placeholder="文件名，可留空自动生成 note-时间.txt">
        </div>
        <div class="row" style="margin-top:10px">
          <textarea id="textContent" placeholder="输入要分享的文字、代码或备忘"></textarea>
        </div>
        <div class="row" style="margin-top:12px">
          <button onclick="uploadText()">保存文字</button>
          <button class="secondary" onclick="loadLatestText()">读取最新文字</button>
        </div>
      </section>

      <section class="panel" id="uploadSection">
        <h2>上传文件</h2>
        <p class="muted">支持同时选择多个文件上传，也可拖拽文件到此处。</p>
        <div id="dropZone" class="drop-zone" onclick="document.getElementById('fileInput').click()">
          <input id="fileInput" type="file" multiple style="display:none" onchange="handleFileSelect(this.files)">
          <div class="drop-zone-inner">
            <div class="drop-icon">📁</div>
            <div>拖拽文件到此处，或点击选择文件</div>
          </div>
        </div>
        <div id="fileList" style="margin-top:10px;font-size:13px;color:var(--muted)"></div>
        <div class="row" style="margin-top:12px">
          <button onclick="uploadFiles()">上传文件</button>
          <button class="secondary" onclick="clearFileInput()">清空选择</button>
        </div>
        <div class="progress-bar-wrap" id="progressBarWrap">
          <div class="progress-bar" id="progressBar" style="width:0%"></div>
        </div>
        <div class="status" id="uploadStatus"></div>
      </section>
    </div>

    <section class="panel" style="margin-top:18px">
      <div class="toolbar">
        <input id="searchInput" type="text" placeholder="按文件名搜索">
        <button onclick="loadFiles()">刷新</button>
        <button class="secondary" onclick="searchFiles()">搜索</button>
        <button class="ghost" onclick="downloadSelected()">打包下载选中项</button>
        <button class="secondary" onclick="openTagManager()">标签管理</button>
        <button class="danger" onclick="deleteAllFiles()">删除全部</button>
        <div class="view-toggle">
          <input type="checkbox" id="gridSelectAll" onchange="toggleAll(this.checked)" style="display:none;margin-right:6px;cursor:pointer" title="全选">
          <button id="viewListBtn" class="active" onclick="setView('list')" title="列表视图">☰</button>
          <button id="viewGridBtn" onclick="setView('grid')" title="网格视图">⊞</button>
        </div>
      </div>
      <div id="recentSearches" style="display:none;margin-bottom:10px"></div>
      <div id="batchBar" class="batch-bar" style="display:none">
        <span id="batchCount" style="font-size:13px;color:var(--muted)"></span>
        <button class="ghost" onclick="toggleInvertSelection()">反选</button>
        <button class="ghost" onclick="openBatchTagModal()">添加标签</button>
        <button class="ghost" onclick="openBatchRemoveTagModal()">移除标签</button>
        <button class="ghost" onclick="batchDeleteSelected()">删除</button>
        <button class="ghost" onclick="clearSelection()">取消选择</button>
      </div>
      <div class="list-scroll">
        <table id="fileTable">
          <thead>
            <tr>
              <th style="width:42px"><input type="checkbox" id="selectAll" onchange="toggleAll(this.checked)"></th>
              <th style="cursor:pointer;user-select:none" onclick="setSort('filename')">文件 <span class="sort-arrow" id="arrow-filename"></span></th>
              <th style="width:140px">标签</th>
              <th style="width:100px;cursor:pointer;user-select:none" onclick="setSort('size')">大小 <span class="sort-arrow" id="arrow-size"></span></th>
              <th style="width:170px;cursor:pointer;user-select:none" onclick="setSort('updated_at')">更新时间 <span class="sort-arrow" id="arrow-updated_at"></span></th>
              <th style="width:320px">操作</th>
            </tr>
          </thead>
          <tbody id="fileTableBody"></tbody>
        </table>
        <div id="fileTableGrid" style="display:none"></div>
        <div id="fileEmpty" class="empty" style="display:none">还没有内容</div>
      </div>
    </section>

    <section class="panel shares" style="margin-top:18px">
      <h2>分享链接</h2>
      <div class="toolbar" style="margin-bottom:12px;flex-wrap:wrap;gap:6px">
        <input id="shareSearchInput" type="text" placeholder="搜索分享链接" style="flex:1 1 180px">
        <select id="shareStatusFilter" onchange="filterShares()" style="padding:4px 8px;border-radius:6px;border:1px solid var(--border)">
          <option value="">全部状态</option>
          <option value="active">有效</option>
          <option value="expired">已过期</option>
          <option value="password">有密码</option>
        </select>
        <button class="secondary" onclick="filterShares()">过滤</button>
        <button class="ghost" onclick="copyAllShares()">复制全部</button>
        <button class="danger" onclick="batchDeleteExpiredShares()">删除过期</button>
      </div>
      <div id="shareBatchBar" class="batch-bar" style="display:none">
        <input type="checkbox" id="shareSelectAll" onchange="toggleShareSelectAll(this.checked)" style="margin-right:4px">
        <span id="shareBatchCount" style="font-size:13px;color:var(--muted)"></span>
        <button class="ghost" onclick="batchDeleteSelectedShares()">删除选中</button>
        <button class="ghost" onclick="clearShareSelection()">取消选择</button>
      </div>
      <div class="list-scroll">
        <table>
          <thead>
            <tr>
              <th style="width:36px"><input type="checkbox" id="shareListSelectAll" onchange="toggleShareSelectAll(this.checked)"></th>
              <th>文件</th>
              <th>链接</th>
              <th style="width:110px">二维码</th>
              <th style="width:220px">状态</th>
              <th style="width:100px">操作</th>
            </tr>
          </thead>
          <tbody id="shareTable"></tbody>
        </table>
        <div id="shareEmpty" class="empty" style="display:none">还没有创建分享链接</div>
      </div>
    </section>

    <section class="panel" style="margin-top:18px">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h2>操作日志</h2>
        <button class="ghost" onclick="toggleAudit()" id="auditToggleBtn">展开</button>
      </div>
      <div id="auditSection" style="display:none">
        <div class="toolbar" style="margin:12px 0">
          <select id="auditActionFilter" style="padding:10px 12px;border-radius:14px;border:1px solid var(--line)">
            <option value="">全部操作</option>
            <option value="upload">上传</option>
            <option value="delete">删除</option>
            <option value="share_create">分享创建</option>
            <option value="share_access">分享访问</option>
            <option value="share_delete">分享删除</option>
            <option value="rename">重命名</option>
            <option value="batch_download">批量下载</option>
            <option value="delete_all">删除全部</option>
          </select>
          <button class="secondary" onclick="loadAuditLogs()">刷新</button>
        </div>
        <div class="list-scroll" style="max-height:400px">
          <table>
            <thead>
              <tr>
                <th style="width:180px">时间</th>
                <th style="width:100px">操作</th>
                <th>详情</th>
                <th style="width:120px">IP</th>
              </tr>
            </thead>
            <tbody id="auditTable"></tbody>
          </table>
          <div id="auditEmpty" class="empty" style="display:none">暂无日志</div>
        </div>
        <div id="auditStats" style="margin-top:12px;font-size:13px;color:var(--muted)"></div>
        <button class="ghost" style="margin-top:10px;font-size:13px" onclick="exportAuditCSV()">📥 导出 CSV</button>
      </div>
    </section>
  </div>

  <div id="modal" class="modal" onclick="closeModal(event)">
    <div class="modal-card">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
        <strong id="modalTitle">预览</strong>
        <button class="secondary" onclick="forceCloseModal()">关闭</button>
      </div>
      <div id="modalBody"></div>
    </div>
  </div>

  <script>
    // Dynamic token state
    let _authToken = null;
    let _refreshToken = null;
    let _tokenExpiresAt = null;
    let _refreshTimer = null;
    let _refreshing = false;

    // STATIC_TOKEN is the server-side SHARE_TOKEN, used only for initial login
    const STATIC_TOKEN=${JSON.stringify(pageInfo.staticToken || '')};

    // Theme management
    const STORAGE_KEY_THEME = 'st_theme_mode'; // 'light' | 'dark' | 'system'
    const STORAGE_KEY_THEME_RESOLVED = 'st_theme'; // 'light' | 'dark' (resolved value)

    function getSystemTheme() {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function resolveTheme(mode) {
      return mode === 'system' ? getSystemTheme() : mode;
    }

    function applyTheme(theme) {
      // theme is already resolved: 'dark' or 'light'
      if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
      localStorage.setItem(STORAGE_KEY_THEME_RESOLVED, theme);
    }

    function setThemeMode(mode) {
      // mode: 'light' | 'dark' | 'system'
      localStorage.setItem(STORAGE_KEY_THEME_MODE, mode);
      const resolved = resolveTheme(mode);
      applyTheme(resolved);
    }

    function initTheme() {
      // Restore saved mode, default to 'system'
      const savedMode = localStorage.getItem(STORAGE_KEY_THEME_MODE) || 'system';
      const themeSelect = document.getElementById('themeSelect');
      if (themeSelect) themeSelect.value = savedMode;
      applyTheme(resolveTheme(savedMode));

      // Listen for system preference changes
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const currentMode = localStorage.getItem(STORAGE_KEY_THEME_MODE) || 'system';
        if (currentMode === 'system') {
          applyTheme(getSystemTheme());
        }
      });
    }

    // Apply saved theme on load
    initTheme();

    function getToken() {
      return _authToken || localStorage.getItem('st_auth_token') || STATIC_TOKEN;
    }

    function saveToken(token, refreshToken, expiresAt) {
      _authToken = token;
      _refreshToken = refreshToken;
      _tokenExpiresAt = expiresAt;
      localStorage.setItem('st_auth_token', token);
      localStorage.setItem('st_refresh_token', refreshToken);
      localStorage.setItem('st_token_expires_at', String(expiresAt));
      scheduleRefresh(expiresAt);
    }

    function clearToken() {
      _authToken = null;
      _refreshToken = null;
      _tokenExpiresAt = null;
      localStorage.removeItem('st_auth_token');
      localStorage.removeItem('st_refresh_token');
      localStorage.removeItem('st_token_expires_at');
      if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
    }

    function scheduleRefresh(expiresAt) {
      if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
      const now = Math.floor(Date.now() / 1000);
      const ttl = expiresAt - now;
      // Refresh 5 minutes before expiry, min 10s
      const delay = Math.max((ttl - 300) * 1000, 10000);
      _refreshTimer = setTimeout(() => doRefresh(true), delay);
    }

    async function doRefresh(silent) {
      if (_refreshing) return;
      _refreshing = true;
      try {
        const rt = _refreshToken || localStorage.getItem('st_refresh_token');
        if (!rt) {
          if (!silent) console.warn('[Auth] No refresh token, re-logging in');
          return await doLogin();
        }
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt })
        });
        const data = await res.json();
        if (data.success) {
          saveToken(data.token, data.refreshToken, data.expiresAt);
          if (!silent) console.log('[Auth] Token refreshed');
        } else {
          if (!silent) console.warn('[Auth] Refresh failed:', data.error);
          clearToken();
          await doLogin();
        }
      } catch (e) {
        if (!silent) console.warn('[Auth] Refresh error:', e.message);
        clearToken();
        await doLogin();
      } finally {
        _refreshing = false;
      }
    }

    async function doLogin() {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: STATIC_TOKEN })
        });
        const data = await res.json();
        if (data.success) {
          saveToken(data.token, data.refreshToken, data.expiresAt);
          console.log('[Auth] Logged in, token expires in', Math.floor((data.expiresAt - Math.floor(Date.now() / 1000)) / 86400), 'days');
        } else {
          console.error('[Auth] Login failed:', data.error);
        }
      } catch (e) {
        console.error('[Auth] Login error:', e.message);
      }
    }

    async function initAuth() {
      // Restore token from localStorage
      const storedToken = localStorage.getItem('st_auth_token');
      const storedRefresh = localStorage.getItem('st_refresh_token');
      const storedExpiry = parseInt(localStorage.getItem('st_token_expires_at') || '0', 10);
      const now = Math.floor(Date.now() / 1000);

      if (storedToken && storedExpiry > now) {
        // Token still valid, restore and schedule refresh
        _authToken = storedToken;
        _refreshToken = storedRefresh;
        _tokenExpiresAt = storedExpiry;
        scheduleRefresh(storedExpiry);
        console.log('[Auth] Token restored, expires in', Math.floor((storedExpiry - now) / 86400), 'days');
      } else if (storedRefresh) {
        // Try to refresh
        _refreshToken = storedRefresh;
        await doRefresh(true);
      } else {
        // No stored tokens, do full login
        await doLogin();
      }
    }

    let currentFiles = [];

    function headers(extra) {
      return Object.assign({ 'x-auth-token': getToken() }, extra || {});
    }

    async function request(url, options) {
      const response = await fetch(url, Object.assign({}, options || {}, {
        headers: headers((options && options.headers) || {})
      }));
      if (!response.ok) {
        // 401: try refreshing token once, then retry
        if (response.status === 401 && !options._authRetried) {
          await doRefresh(true);
          const retryOpts = Object.assign({}, options || {}, { _authRetried: true });
          retryOpts.headers = headers((options && options.headers) || {});
          return request(url, retryOpts);
        }
        let message = 'Request failed';
        try {
          const data = await response.json();
          message = data.error || message;
        } catch (e) {}
        throw new Error(message);
      }
      const type = response.headers.get('content-type') || '';
      if (type.includes('application/json')) return response.json();
      return response;
    }

    // Init auth on page load
    initAuth();

    function status(text) {
      document.getElementById('uploadStatus').textContent = text || '';
    }

    function showProgress(current, total) {
      var wrap = document.getElementById('progressBarWrap');
      var bar = document.getElementById('progressBar');
      if (!wrap || !bar) return;
      var pct = total > 0 ? Math.round((current / total) * 100) : 0;
      wrap.classList.add('active');
      bar.style.width = pct + '%';
    }

    function clearProgress() {
      var wrap = document.getElementById('progressBarWrap');
      var bar = document.getElementById('progressBar');
      if (wrap) wrap.classList.remove('active');
      if (bar) bar.style.width = '0%';
    }

    function showToast(message, type = '') {
      const el = document.getElementById('toast');
      el.textContent = message;
      el.className = 'show' + (type ? ' ' + type : '');
      clearTimeout(el._timer);
      el._timer = setTimeout(() => { el.className = ''; }, 3000);
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let value = bytes;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      return value.toFixed(value >= 10 || index === 0 ? 0 : 1) + ' ' + units[index];
    }

    function formatTime(ts) {
      return new Date(ts).toLocaleString();
    }

    function escapeHtmlClient(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function checkedNames() {
      return Array.from(document.querySelectorAll('.file-check:checked')).map(function (el) {
        return el.value;
      });
    }

    function toggleAll(checked) {
      document.querySelectorAll('.file-check').forEach(function (el) {
        el.checked = checked;
      });
      if (currentView === 'grid') document.getElementById('gridSelectAll').checked = checked;
      if (currentView === 'list') document.getElementById('selectAll').checked = checked;
      updateBatchBar();
    }

    function toggleInvertSelection() {
      var allChecks = document.querySelectorAll('.file-check');
      allChecks.forEach(function (el) {
        el.checked = !el.checked;
      });
      updateBatchBar();
    }

    function updateBatchBar() {
      var names = checkedNames();
      var bar = document.getElementById('batchBar');
      var count = document.getElementById('batchCount');
      var selectAll = document.getElementById('selectAll');
      if (!bar || !count) return;
      if (names.length > 0) {
        bar.style.display = 'flex';
        count.textContent = '已选择 ' + names.length + ' 个文件';
        var total = document.querySelectorAll('.file-check').length;
        if (selectAll) selectAll.checked = names.length === total;
      } else {
        bar.style.display = 'none';
        if (selectAll) selectAll.checked = false;
      }
    }

    function clearSelection() {
      document.querySelectorAll('.file-check').forEach(function (el) { el.checked = false; });
      document.getElementById('selectAll').checked = false;
      document.getElementById('gridSelectAll').checked = false;
      updateBatchBar();
    }

    function batchDeleteSelected() {
      const names = checkedNames().map(function (n) { return decodeURIComponent(n); });
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      if (!confirm('确定删除 ' + names.length + ' 个文件？此操作不可恢复。')) return;
      Promise.all(names.map(function (name) {
        return fetch('/api/files/' + encodeURIComponent(name), { method: 'DELETE', headers: headers() });
      })).then(function () {
        showToast('已删除 ' + names.length + ' 个文件', 'success');
        clearSelection();
        loadFiles();
        document.getElementById('viewListBtn').classList.toggle('active', currentView === 'list');
        document.getElementById('viewGridBtn').classList.toggle('active', currentView === 'grid');
      }).catch(function () { showToast('删除失败', 'error'); });
    }

    function openBatchTagModal() {
      const names = checkedNames();
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      openTagInputModal('add', names.length);
    }

    function openBatchRemoveTagModal() {
      const names = checkedNames();
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      openTagInputModal('remove', names.length);
    }

    function openTagInputModal(action, fileCount) {
      const existingModal = document.getElementById('tagInputModal');
      if (existingModal) existingModal.remove();
      const modal = document.createElement('div');
      modal.id = 'tagInputModal';
      modal.className = 'modal';
      modal.innerHTML = '\
        <div class="modal-content" style="max-width:400px">\
          <h3 id="tagInputTitle">' + (action === 'add' ? '添加标签' : '移除标签') + '</h3>\
          <p style="color:var(--muted);font-size:13px;margin-bottom:12px">为 ' + fileCount + ' 个文件' + (action === 'add' ? '添加' : '移除') + '标签</p>\
          <div id="tagChipInput" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;padding:8px;border:1px solid var(--line);border-radius:8px;min-height:44px;cursor:text" onclick="document.getElementById(\'tagInputField\').focus()"></div>\
          <input id="tagInputField" type="text" placeholder="输入标签后按 Enter 添加" \
            style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;margin-bottom:14px;font-size:14px" \
            onkeydown="handleTagInputKeydown(event, \'' + action + '\')">\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'tagInputModal\').remove()">取消</button>\
            <button onclick="confirmBatchTagInput(\'' + action + '\')">确定</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      document.getElementById('tagInputField').focus();
    }

    var _batchTagChips = [];

    function handleTagInputKeydown(e, action) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const val = e.target.value.trim().replace(/,$/, '');
        if (val && !_batchTagChips.includes(val)) {
          _batchTagChips.push(val);
          renderBatchTagChips();
        }
        e.target.value = '';
      } else if (e.key === 'Backspace' && !e.target.value && _batchTagChips.length) {
        _batchTagChips.pop();
        renderBatchTagChips();
      }
    }

    function renderBatchTagChips() {
      const container = document.getElementById('tagChipInput');
      if (!container) return;
      container.innerHTML = _batchTagChips.map(function (t) {
        return '<span style="display:inline-flex;align-items:center;gap:4px;background:var(--accent-weak);color:var(--accent);padding:3px 10px;border-radius:999px;font-size:13px">' + escapeHtmlClient(t) + '<span onclick="removeBatchChip(\'' + escapeHtmlClient(t) + '\');event.stopPropagation()" style="cursor:pointer;font-size:12px">✕</span></span>';
      }).join('');
    }

    function removeBatchChip(tag) {
      _batchTagChips = _batchTagChips.filter(function (t) { return t !== tag; });
      renderBatchTagChips();
    }

    function confirmBatchTagInput(action) {
      const names = checkedNames().map(function (n) { return decodeURIComponent(n); });
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      if (!_batchTagChips.length) { showToast('请至少输入一个标签', 'error'); return; }
      const tagStr = _batchTagChips.join(',');
      fetch('/api/file-tags/batch', {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ files: names, action: action, tags: tagStr })
      }).then(function (r) { return r.json(); }).then(function (data) {
        document.getElementById('tagInputModal').remove();
        _batchTagChips = [];
        showToast(action === 'add' ? '已添加标签' : '已移除标签', 'success');
        clearSelection();
        loadFiles();
      }).catch(function () { showToast('操作失败', 'error'); });
    }

    function defaultTextFilename() {
      const now = new Date();
      const pad = function (n) { return String(n).padStart(2, '0'); };
      return 'note-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '.txt';
    }

    async function uploadText() {
      const content = document.getElementById('textContent').value;
      const filename = document.getElementById('textFilename').value.trim() || defaultTextFilename();
      if (!content.trim()) {
        showToast('请输入内容', 'error');
        return;
      }
      status('正在保存文字...');
      try {
        await request('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: filename, content: content, type: 'text' })
        });
        document.getElementById('textContent').value = '';
        status('文字已保存');
        await loadFiles();
      } catch (error) {
        status(error.message);
      }
    }

    function readFileAsBase64(file) {
      return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function () {
          const result = reader.result || '';
          const comma = result.indexOf(',');
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    // Drag and drop handlers
    function handleFileSelect(files) {
      var list = document.getElementById('fileList');
      if (!files.length) {
        list.innerHTML = '';
        return;
      }
      list.innerHTML = '已选 ' + files.length + ' 个文件: ' +
        Array.from(files).map(function (f) { return escapeHtmlClient(f.name); }).join(', ');
    }

    function clearFileInput() {
      document.getElementById('fileInput').value = '';
      document.getElementById('fileList').innerHTML = '';
    }

    function setupDragDrop() {
      var dropZone = document.getElementById('dropZone');
      if (!dropZone) return;
      ['dragenter', 'dragover'].forEach(function (evt) {
        dropZone.addEventListener(evt, function (e) {
          e.preventDefault();
          dropZone.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        dropZone.addEventListener(evt, function (e) {
          e.preventDefault();
          dropZone.classList.remove('dragover');
        });
      });
      dropZone.addEventListener('drop', function (e) {
        var files = e.dataTransfer.files;
        if (files.length) {
          document.getElementById('fileInput').files = files;
          handleFileSelect(files);
        }
      });
    }

    async function uploadFiles() {
      const input = document.getElementById('fileInput');
      const files = Array.from(input.files || []);
      if (!files.length) {
        showToast('请先选择文件', 'error');
        return;
      }
      let completed = 0;
      status('开始上传 ' + files.length + ' 个文件...');
      showProgress(0, files.length);
      for (const file of files) {
        const name = file.name;
        const content = await readFileAsBase64(file);
        await request('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: name, content: content, type: 'file' })
        });
        completed += 1;
        status('已上传 ' + completed + ' / ' + files.length);
        showProgress(completed, files.length);
      }
      input.value = '';
      clearFileInput();
      clearProgress();
      await loadFiles();
      status('上传完成');
    }

    async function loadFiles() {
      const q = document.getElementById('searchInput').value.trim();
      const sortParam = 'sort=' + encodeURIComponent(currentSort) + '&order=' + encodeURIComponent(currentOrder);
      const url = q ? '/api/search?q=' + encodeURIComponent(q) + '&' + sortParam : '/api/list?' + sortParam;
      const [data, tagData] = await Promise.all([request(url), request('/api/tags')]);
      currentFiles = data.files || [];
      const tagColorMap = {};
      (tagData.tags || []).forEach(function(t) { tagColorMap[t.tag] = t.color || '#e0e7ff'; });
      const empty = document.getElementById('fileEmpty');
      const listBody = document.getElementById('fileTableBody');
      const gridBody = document.getElementById('fileTableGrid');
      if (!currentFiles.length) {
        listBody.innerHTML = '';
        gridBody.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';

      if (currentView === 'grid') {
        document.getElementById('fileTable').style.display = 'none';
        gridBody.style.display = 'block';
        gridBody.innerHTML = currentFiles.map(function (file) {
          return renderFileItem(file, tagColorMap, 'grid');
        }).join('');
      } else {
        document.getElementById('fileTable').style.display = 'table';
        gridBody.style.display = 'none';
        listBody.innerHTML = currentFiles.map(function (file) {
          return renderFileRow(file, tagColorMap);
        }).join('');
      }
    }

    function renderFileRow(file, tagColorMap) {
      var tags = file.tags || '';
      var tagHtml = tags
        ? '<div class="file-tags">' + tags.split(',').filter(Boolean).map(function(t) {
            var tc = tagColorMap[t.trim()] || '#e0e7ff';
            return '<span class="tag-badge" style="background:' + tc + ';color:#3730a3;font-size:10px;padding:1px 6px;border-radius:10px;font-weight:500;margin-right:3px;display:inline-block">' + escapeHtmlClient(t.trim()) + '</span>';
          }).join('') + '</div>'
        : '<span class="muted" style="font-size:11px">—</span>';
      return '<tr>' +
        '<td data-label=""><input class="file-check" type="checkbox" value="' + encodeURIComponent(file.name) + '" onchange="updateBatchBar()"></td>' +
        '<td data-label="文件"><strong>' + escapeHtmlClient(file.name) + '</strong><div class="muted">' + escapeHtmlClient(file.type) + '</div></td>' +
        '<td data-label="标签">' + tagHtml + '<button class="tag-edit-btn" onclick="editFileTags(' + JSON.stringify(file.name) + ',' + JSON.stringify(tags) + ')">✎</button></td>' +
        '<td data-label="大小">' + formatBytes(file.size) + '</td>' +
        '<td data-label="更新时间">' + formatTime(file.updatedAt || file.createdAt) + '</td>' +
        '<td class="actions-cell" data-label="操作">' +
          '<button onclick=' + "'" + 'previewFile(' + JSON.stringify(file.name) + ')' + "'" + '>查看</button>' +
          '<button class="secondary" onclick=' + "'" + 'downloadFile(' + JSON.stringify(file.name) + ')' + "'" + '>下载</button>' +
          '<button class="secondary" onclick=' + "'" + 'createShare(' + JSON.stringify(file.name) + ')' + "'" + '>分享</button>' +
          '<button class="secondary" onclick=' + "'" + 'renameFile(' + JSON.stringify(file.name) + ')' + "'" + '>重命名</button>' +
          '<button class="danger" onclick=' + "'" + 'deleteFile(' + JSON.stringify(file.name) + ')' + "'" + '>删除</button>' +
        '</td>' +
      '</tr>';
    }

    function renderFileItem(file, tagColorMap, mode) {
      var tags = file.tags || '';
      var tagHtml = tags
        ? '<div class="file-tags">' + tags.split(',').filter(Boolean).map(function(t) {
            var tc = tagColorMap[t.trim()] || '#e0e7ff';
            return '<span class="tag-badge" style="background:' + tc + ';color:#3730a3;font-size:10px;padding:1px 6px;border-radius:10px;font-weight:500;margin-right:3px;display:inline-block">' + escapeHtmlClient(t.trim()) + '</span>';
          }).join('') + '</div>'
        : '<span class="muted" style="font-size:11px">—</span>';

      // File type icon / thumbnail for grid view
      var gridIcon = '';
      if (mode === 'grid') {
        var mime = file.content_type || file.mime || '';
        var iconSvg;
        var thumbWrapper = '';
        if (mime.startsWith('image/')) {
          // Lazy thumbnail: show placeholder icon initially, load image when in viewport
          thumbWrapper = '<div class="img-thumb-wrap" style="display:flex;align-items:center;justify-content:center;height:64px;margin-bottom:8px;position:relative" data-filename="' + encodeURIComponent(file.name) + '">' +
            '<svg class="img-placeholder" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>' +
            '<div class="img-overlay" style="display:none;position:absolute;inset:0;background:rgba(0,0,0,0.3);border-radius:4px;align-items:center;justify-content:center">' +
            '<div style="width:28px;height:28px;border:3px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite"></div></div></div>';
          iconSvg = thumbWrapper;
        } else if (mime === 'application/pdf') {
          iconSvg = '<div style="display:flex;align-items:center;justify-content:center;height:64px;margin-bottom:8px;position:relative"><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10,9 9,9 8,9"/></svg><div style="position:absolute;bottom:6px;right:4px;font-size:9px;background:#ef4444;color:#fff;padding:1px 4px;border-radius:3px;font-weight:600">PDF</div></div>';
        } else if (mime.startsWith('video/')) {
          iconSvg = '<div style="display:flex;align-items:center;justify-content:center;height:64px;margin-bottom:8px;position:relative"><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="1.5"><polygon points="23,7 16,12 23,17"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"><div style="width:28px;height:28px;background:rgba(139,92,246,0.85);border-radius:50%;display:flex;align-items:center;justify-content:center"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="#fff"><polygon points="5,3 19,12 5,21"/></svg></div></div></div>';
        } else if (mime.startsWith('audio/')) {
          iconSvg = '<div style="display:flex;align-items:center;justify-content:center;height:64px;margin-bottom:8px;position:relative"><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"><div style="width:28px;height:28px;background:rgba(245,158,11,0.85);border-radius:50%;display:flex;align-items:center;justify-content:center"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="#fff"><polygon points="5,3 19,12 5,21"/></svg></div></div></div>';
        } else if (mime.startsWith('text/')) {
          iconSvg = '<div style="display:flex;align-items:center;justify-content:center;height:64px;margin-bottom:8px"><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></div>';
        } else {
          iconSvg = '<div style="display:flex;align-items:center;justify-content:center;height:64px;margin-bottom:8px"><svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg></div>';
        }
        gridIcon = iconSvg;
      }

      return '<div class="file-item">' +
        '<input class="file-check file-check-row" type="checkbox" value="' + encodeURIComponent(file.name) + '" onchange="updateBatchBar()">' +
        '<div class="file-content">' +
          gridIcon +
          '<div class="file-name">' + escapeHtmlClient(file.name) + '</div>' +
          '<div class="file-meta">' + formatBytes(file.size) + ' · ' + formatTime(file.updatedAt || file.createdAt) + '</div>' +
          tagHtml +
        '</div>' +
        '<div class="file-actions">' +
          '<button class="btn secondary" onclick=' + "'" + 'previewFile(' + JSON.stringify(file.name) + ')' + "'" + '>查看</button>' +
          '<button class="btn secondary" onclick=' + "'" + 'downloadFile(' + JSON.stringify(file.name) + ')' + "'" + '>下载</button>' +
          '<button class="btn secondary" onclick=' + "'" + 'createShare(' + JSON.stringify(file.name) + ')' + "'" + '>分享</button>' +
          '<button class="btn danger" onclick=' + "'" + 'deleteFile(' + JSON.stringify(file.name) + ')' + "'" + '>删除</button>' +
        '</div>' +
      '</div>';
    }

    var currentView = localStorage.getItem('viewMode') || 'list';

    function setView(view) {
      currentView = view;
      localStorage.setItem('viewMode', view);
      document.getElementById('viewListBtn').classList.toggle('active', view === 'list');
      document.getElementById('viewGridBtn').classList.toggle('active', view === 'grid');
      document.getElementById('gridSelectAll').style.display = (view === 'grid') ? 'inline-block' : 'none';
      document.getElementById('selectAll').style.display = (view === 'list') ? '' : 'none';
      loadFiles();
    }

    // Init view toggle button state on page load
    document.getElementById('viewListBtn').classList.toggle('active', currentView === 'list');
    document.getElementById('viewGridBtn').classList.toggle('active', currentView === 'grid');
    document.getElementById('gridSelectAll').style.display = currentView === 'grid' ? 'inline-block' : 'none';
    document.getElementById('selectAll').style.display = currentView === 'list' ? '' : 'none';

    async function searchFiles() {
      const q = document.getElementById('searchInput').value.trim();
      if (q) {
        saveRecentSearch(q);
        renderRecentSearches();
      }
      await loadFiles();
    }

    // --- Context Menu ---
    var ctxTarget = null;

    document.addEventListener('contextmenu', function(e) {
      // Only show for file rows
      var row = e.target.closest('tr');
      if (!row) return;
      var checkbox = row.querySelector('.file-check');
      if (!checkbox) return;
      e.preventDefault();
      ctxTarget = checkbox.value;
      var menu = document.getElementById('ctxMenu');
      var x = Math.min(e.clientX, window.innerWidth - 170);
      var y = Math.min(e.clientY, window.innerHeight - 220);
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      menu.style.display = 'block';
    });

    document.addEventListener('click', function(e) {
      var menu = document.getElementById('ctxMenu');
      if (!menu.contains(e.target)) menu.style.display = 'none';
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') document.getElementById('ctxMenu').style.display = 'none';
    });

    async function ctxAction(action) {
      document.getElementById('ctxMenu').style.display = 'none';
      if (!ctxTarget) return;
      var filename = decodeURIComponent(ctxTarget);
      switch (action) {
        case 'open': previewFile(filename); break;
        case 'download': downloadFile(filename); break;
        case 'share': createShare(filename); break;
        case 'copyLink': await copyShareLink(filename); break;
        case 'rename': renameFile(filename); break;
        case 'delete': if (confirm('确认删除 ' + filename + '？')) deleteFile(filename); break;
      }
    }

    async function copyShareLink(filename) {
      const data = await request('/api/share/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, expiryHours: 168, password: '' })
      });
      if (!data || !data.success || !data.share || !data.share.url) {
        showToast('复制链接失败', 'error');
        return;
      }
      await copyToClipboard(data.share.url);
      showToast('分享链接已复制', 'success');
    }

    var recentSearchesCache = [];
    var MAX_RECENT_SEARCHES = 8;

    async function loadRecentSearches() {
      try {
        const res = await fetch('/api/search/history?limit=' + MAX_RECENT_SEARCHES);
        const data = await res.json();
        recentSearchesCache = (data.history || []).map(function (h) { return h.query; });
        renderRecentSearches();
      } catch (e) { recentSearchesCache = []; }
    }

    function getRecentSearches() {
      return recentSearchesCache;
    }

    async function saveRecentSearch(query) {
      var q = query.trim();
      if (!q) return;
      recentSearchesCache = recentSearchesCache.filter(function (s) { return s !== q; });
      recentSearchesCache.unshift(q);
      if (recentSearchesCache.length > MAX_RECENT_SEARCHES) recentSearchesCache = recentSearchesCache.slice(0, MAX_RECENT_SEARCHES);
      try {
        await fetch('/api/search/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
      } catch (e) { /* non-critical */ }
      renderRecentSearches();
    }

    function renderRecentSearches() {
      var searches = getRecentSearches();
      var container = document.getElementById('recentSearches');
      if (!container) return;
      if (!searches.length) {
        container.style.display = 'none';
        return;
      }
      container.style.display = 'block';
      container.innerHTML = searches.map(function (s) {
        return '<span class="recent-search-tag" onclick="applyRecentSearch(' + JSON.stringify(s) + ')">' + escapeHtmlClient(s) + '</span>';
      }).join('') + '<span class="recent-search-tag" style="color:var(--muted)" onclick="clearRecentSearches()">✕清除</span>';
    }

    function applyRecentSearch(query) {
      document.getElementById('searchInput').value = query;
      searchFiles();
    }

    async function clearRecentSearches() {
      recentSearchesCache = [];
      try {
        await fetch('/api/search/history', { method: 'DELETE' });
      } catch (e) { /* non-critical */ }
      renderRecentSearches();
    }

    async function previewFile(filename) {
      const data = await request('/api/content/' + encodeURIComponent(filename));
      const file = data.file;
      const modalBody = document.getElementById('modalBody');
      document.getElementById('modalTitle').textContent = file.name;
      if (file.type === 'text') {
        modalBody.innerHTML = '<pre>' + escapeHtmlClient(file.content || '') + '</pre>';
      } else if ((file.mime || '').startsWith('image/')) {
        modalBody.innerHTML = '<img alt="" src="data:' + file.mime + ';base64,' + file.content + '" style="max-width:100%;max-height:70vh;display:block;margin:0 auto;border-radius:8px">';
      } else if (file.mime === 'application/pdf') {
        modalBody.innerHTML = '<iframe src="data:application/pdf;base64,' + file.content + '" style="width:100%;height:70vh;border:none;border-radius:8px" title="PDF预览"></iframe>';
      } else if ((file.mime || '').startsWith('video/')) {
        modalBody.innerHTML = '<video controls style="width:100%;max-height:70vh;border-radius:8px;background:#000"><source src="data:' + file.mime + ';base64,' + file.content + '">您的浏览器不支持视频预览</video>';
      } else if ((file.mime || '').startsWith('audio/')) {
        modalBody.innerHTML = '<audio controls style="width:100%;margin-top:20px"><source src="data:' + file.mime + ';base64,' + file.content + '">您的浏览器不支持音频预览</audio>';
      } else {
        modalBody.innerHTML = '<p class="muted">此文件类型不做内嵌预览，请直接下载。</p><button onclick=' + "'" + 'downloadFile(' + JSON.stringify(filename) + ')' + "'" + '>下载文件</button>';
      }
      document.getElementById('modal').classList.add('open');
    }

    function forceCloseModal() {
      document.getElementById('modal').classList.remove('open');
      document.getElementById('modalBody').innerHTML = '';
    }

    function closeModal(event) {
      if (event.target.id === 'modal') forceCloseModal();
    }

    async function loadLatestText() {
      const data = await request('/api/latest/text');
      document.getElementById('textFilename').value = data.filename || '';
      document.getElementById('textContent').value = data.content || '';
    }

    async function downloadFile(filename) {
      try {
        const response = await request('/download/' + encodeURIComponent(filename));
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) {
        showToast('下载失败: ' + e.message, 'error');
      }
    }

    var auditVisible = false;

    function toggleAudit() {
      auditVisible = !auditVisible;
      var section = document.getElementById('auditSection');
      var btn = document.getElementById('auditToggleBtn');
      if (auditVisible) {
        section.style.display = 'block';
        btn.textContent = '收起';
        loadAuditLogs();
      } else {
        section.style.display = 'none';
        btn.textContent = '展开';
      }
    }

    async function loadAuditLogs() {
      var action = document.getElementById('auditActionFilter').value;
      var url = '/api/audit/logs?limit=100' + (action ? '&action=' + encodeURIComponent(action) : '');
      var data = await request(url);
      var logs = data.logs || [];
      var stats = data.stats || {};
      var body = document.getElementById('auditTable');
      var empty = document.getElementById('auditEmpty');
      if (!logs.length) {
        body.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      body.innerHTML = logs.map(function (log) {
        var actionLabel = {
          upload: '上传', delete: '删除', share_create: '分享创建',
          share_access: '分享访问', share_delete: '分享删除',
          rename: '重命名', batch_download: '批量下载',
          delete_all: '删除全部', text_update: '文字更新',
          delete_old: '清理旧文件'
        }[log.action] || log.action;
        return '<tr>' +
          '<td data-label="时间">' + formatTime(log.created_at * 1000) + '</td>' +
          '<td data-label="操作"><span style="font-weight:600">' + actionLabel + '</span></td>' +
          '<td data-label="详情" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            escapeHtmlClient(String(log.detail || '')) + '</td>' +
          '<td data-label="IP" style="color:var(--muted);font-size:12px">' + escapeHtmlClient(log.ip || '') + '</td>' +
        '</tr>';
      }).join('');
      var statsEl = document.getElementById('auditStats');
      statsEl.textContent = '共 ' + stats.total + ' 条记录';
    }

    async function exportAuditCSV() {
      var action = document.getElementById('auditActionFilter').value;
      var url = '/api/audit/export' + (action ? '?action=' + encodeURIComponent(action) : '');
      window.location.href = url;
    }

    async function copyToClipboard(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) {}
      const input = document.createElement('textarea');
      input.value = text;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(input);
      return ok;
    }

    async function renameFile(filename) {
      const next = prompt('新文件名', filename);
      if (!next || next === filename) return;
      await request('/api/file-rename/' + encodeURIComponent(filename), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newFilename: next })
      });
      await loadFiles();
      await loadShares();
    }

    async function deleteFile(filename) {
      if (!confirm('删除 ' + filename + ' ?')) return;
      await request('/api/files/' + encodeURIComponent(filename), { method: 'DELETE' });
      await loadFiles();
      await loadShares();
    }

    async function deleteAllFiles() {
      if (!confirm('确定删除所有文件?')) return;
      await request('/api/delete-all', { method: 'DELETE' });
      await loadFiles();
      await loadShares();
    }

    async function editFileTags(filename, currentTags) {
      const modal = document.getElementById('modal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');
      title.textContent = '编辑标签';
      body.innerHTML = '<div style="padding:8px 0">' +
        '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">文件名: ' + escapeHtmlClient(filename) + '</div>' +
        '<input id="tagInput" type="text" placeholder="标签（逗号分隔，如：工作,重要）" value="' + escapeHtmlClient(currentTags || '') + '" ' +
        'style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box"' +
        ' onkeydown="if(event.key===\'Enter\'){saveFileTags(\'' + filename.replace(/'/g, "\\'") + '\')}">' +
        '<div style="font-size:11px;color:var(--muted);margin-top:6px">多个标签用逗号分隔，如：工作,项目A,重要</div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">' +
        '<button onclick="closeModal()">取消</button>' +
        '<button class="primary" onclick="saveFileTags(\'' + filename.replace(/'/g, "\\'") + '\')">保存</button>' +
        '</div>';
      modal.classList.add('show');
      setTimeout(function() { document.getElementById('tagInput').focus(); }, 50);
    }

    async function saveFileTags(filename) {
      const input = document.getElementById('tagInput');
      const tags = (input.value || '').trim();
      closeModal();
      showToast('保存中…');
      try {
        const res = await fetch('/api/files/' + encodeURIComponent(filename), {
          method: 'PATCH',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ tags: tags })
        });
        const data = await res.json();
        if (data.success) {
          showToast('标签已保存', 'success');
          await loadFiles();
        } else {
          showToast('保存失败: ' + data.error, 'error');
        }
      } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
      }
    }

    async function openTagManager() {
      const modal = document.getElementById('modal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');
      title.textContent = '标签管理';
      body.innerHTML = '<div id="tagManagerContent" style="padding:8px 0"><div style="text-align:center;color:var(--muted);padding:20px">加载中…</div></div>';
      modal.classList.add('show');

      try {
        const res = await fetch('/api/tags', { headers: headers() });
        const data = await res.json();
        if (!data.success) { throw new Error(data.error); }

        const tags = data.tags || [];
        const colorPresets = ['#e0e7ff','#fce7f3','#dcfce7','#fef9c3','#ffedd5','#f3e8ff','#ecfeff','#ffe4e6','#f0fdf4'];

        // Tag statistics
        const totalTags = tags.length;
        const totalTaggedFiles = tags.reduce(function (s, t) { return s + (t.count || 0); }, 0);
        const topTag = tags.length > 0 ? tags[0] : null;
        const maxCount = tags.length > 0 ? tags[0].count : 0;

        let statsHtml = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">';
        statsHtml += '<div style="background:var(--bg-secondary);padding:12px;border-radius:10px;text-align:center">';
        statsHtml += '<div style="font-size:22px;font-weight:700;color:var(--primary)">' + totalTags + '</div>';
        statsHtml += '<div style="font-size:11px;color:var(--muted);margin-top:2px">标签总数</div></div>';
        statsHtml += '<div style="background:var(--bg-secondary);padding:12px;border-radius:10px;text-align:center">';
        statsHtml += '<div style="font-size:22px;font-weight:700;color:var(--accent)">' + totalTaggedFiles + '</div>';
        statsHtml += '<div style="font-size:11px;color:var(--muted);margin-top:2px">已标记文件</div></div>';
        statsHtml += '<div style="background:var(--bg-secondary);padding:12px;border-radius:10px;text-align:center">';
        statsHtml += '<div style="font-size:22px;font-weight:700;color:var(--warning)">' + (topTag ? escapeHtmlClient(topTag.tag) : '--') + '</div>';
        statsHtml += '<div style="font-size:11px;color:var(--muted);margin-top:2px">最常用标签</div></div>';
        statsHtml += '</div>';

        // Tag distribution bars (top 8)
        if (tags.length > 0) {
          statsHtml += '<div style="margin-bottom:16px">';
          statsHtml += '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">标签分布</div>';
          tags.slice(0, 8).forEach(function (t) {
            const pct = maxCount > 0 ? Math.round((t.count / maxCount) * 100) : 0;
            const barColor = t.color || '#e0e7ff';
            statsHtml += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">';
            statsHtml += '<span style="font-size:12px;min-width:60px;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtmlClient(t.tag) + '</span>';
            statsHtml += '<div style="flex:1;height:8px;background:var(--bg-secondary);border-radius:999px;overflow:hidden">';
            statsHtml += '<div style="height:100%;width:' + pct + '%;background:' + barColor + ';border-radius:999px"></div>';
            statsHtml += '</div>';
            statsHtml += '<span style="font-size:11px;color:var(--muted);min-width:28px;text-align:right">' + t.count + '</span>';
            statsHtml += '</div>';
          });
          statsHtml += '</div>';
        }

        let html = statsHtml + '<div style="margin-bottom:12px">';
        html += '<div style="display:flex;gap:8px;margin-bottom:12px">';
        html += '<input id="newTagInput" type="text" placeholder="新标签名称" style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text);font-size:14px">';
        html += '<button class="primary" onclick="createNewTag()" style="padding:8px 16px">添加</button>';
        html += '</div>';
        html += '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">点击颜色圆点切换，点击 ✕ 删除</div>';
        html += '</div>';

        if (tags.length === 0) {
          html += '<div style="text-align:center;color:var(--muted);padding:20px">暂无标签，添加文件标签后会自动创建</div>';
        } else {
          html += '<div style="max-height:400px;overflow-y:auto">';
          tags.forEach(function(t) {
            const colorDot = colorPresets.map(function(c) {
              return '<span onclick="setTagColor(\'' + escapeHtmlClient(t.tag) + '\',\'' + c + '\')" style="display:inline-block;width:20px;height:20px;border-radius:50%;background:' + c + ';cursor:pointer;margin-right:4px;border:' + (t.color === c ? '2px solid var(--primary)' : '2px solid transparent') + ';box-sizing:border-box"></span>';
            }).join('');
            html += '<div style="display:flex;align-items:center;padding:8px 4px;border-bottom:1px solid var(--border);gap:8px">';
            html += '<div style="flex:1;min-width:0">';
            html += '<span style="font-size:14px">' + escapeHtmlClient(t.tag) + '</span>';
            html += '<span style="font-size:11px;color:var(--muted);margin-left:6px">' + t.count + ' 个文件</span>';
            html += '</div>';
            html += '<div style="display:flex;gap:2px;align-items:center;flex-shrink:0">' + colorDot + '</div>';
            html += '<button onclick="deleteTag(\'' + escapeHtmlClient(t.tag) + '\')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:4px">✕</button>';
            html += '</div>';
          });
          html += '</div>';
        }

        document.getElementById('tagManagerContent').innerHTML = html;
      } catch (e) {
        document.getElementById('tagManagerContent').innerHTML = '<div style="color:var(--error);padding:12px">加载失败: ' + escapeHtmlClient(e.message) + '</div>';
      }
    }

    async function createNewTag() {
      const input = document.getElementById('newTagInput');
      const tag = (input.value || '').trim();
      if (!tag) { showToast('请输入标签名称', 'error'); return; }
      const res = await fetch('/api/tags/colors', {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ tag: tag, color: '#e0e7ff' })
      });
      const data = await res.json();
      if (data.success) {
        showToast('标签已添加', 'success');
        openTagManager();
      } else {
        showToast('添加失败: ' + (data.error || '未知错误'), 'error');
      }
    }

    async function setTagColor(tag, color) {
      const res = await fetch('/api/tags/colors', {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ tag: tag, color: color })
      });
      const data = await res.json();
      if (data.success) {
        openTagManager();
      }
    }

    async function deleteTag(tag) {
      if (!confirm('确定删除标签「' + tag + '」？该标签将从所有文件中移除。')) return;
      const res = await fetch('/api/tags/' + encodeURIComponent(tag) + '/delete', {
        method: 'DELETE',
        headers: headers()
      });
      const data = await res.json();
      if (data.success) {
        showToast('标签已删除（移除自 ' + data.removed + ' 个文件）', 'success');
        openTagManager();
      } else {
        showToast('删除失败: ' + (data.error || '未知错误'), 'error');
      }
    }

    async function downloadSelected() {
      const names = checkedNames().map(function (name) { return decodeURIComponent(name); });
      if (!names.length) {
        showToast('请先选择文件', 'error');
        return;
      }
      const response = await fetch('/api/batch-download', {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ filenames: names })
      });
      if (!response.ok) {
        const data = await response.json();
        showToast(data.error || '下载失败', 'error');
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sharetool_batch.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    async function createShare(filename) {
      const expiryRaw = prompt('分享有效期（小时，留空默认 168）', '168');
      if (expiryRaw === null) return;
      const password = prompt('访问密码（可留空）', '') || '';
      const data = await request('/api/share/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: filename,
          expiryHours: expiryRaw.trim() ? parseInt(expiryRaw, 10) : 168,
          password: password
        })
      });
      if (!data || !data.success || !data.share || !data.share.url) {
        showToast('创建分享链接失败', 'error');
        return;
      }
      await copyToClipboard(data.share.url);
      showToast('分享链接已复制', 'success');
      await loadShares();
    }

    async function loadShares() {
      const data = await request('/api/share/list');
      const shares = data.shares || [];
      currentShares = shares;
      const body = document.getElementById('shareTable');
      const empty = document.getElementById('shareEmpty');
      if (!shares.length) {
        body.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      body.innerHTML = shares.map(function (share) {
        const expireText = share.expiresAt ? formatTime(share.expiresAt) : '永不过期';
        return '<tr>' +
          '<td data-label=""><strong>' + escapeHtmlClient(share.filename) + '</strong></td>' +
          '<td data-label="链接"><a href="' + share.url + '" target="_blank">' + share.url + '</a></td>' +
          '<td data-label=""><img alt="QR" src="/api/share/qr/' + encodeURIComponent(share.code) + '"></td>' +
          '<td data-label="信息">' +
            '<div>到期: ' + expireText + '</div>' +
            '<div>下载: ' + (share.downloadCount || 0) + (share.maxDownloads ? ' / ' + share.maxDownloads : '') + '</div>' +
            '<div>' + (share.hasPassword ? '有密码' : '无密码') + '</div>' +
          '</td>' +
          '<td class="actions-cell" data-label="操作">' +
            '<button class="secondary" onclick=' + "'" + 'copyShare(' + JSON.stringify(share.url) + ')' + "'" + '>复制</button>' +
            '<button class="danger" onclick=' + "'" + 'deleteShare(' + JSON.stringify(share.code) + ')' + "'" + '>删除</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    var currentShares = [];

    function filterShares() {
      var q = document.getElementById('shareSearchInput').value.trim().toLowerCase();
      var status = document.getElementById('shareStatusFilter').value;
      var body = document.getElementById('shareTable');
      var empty = document.getElementById('shareEmpty');
      var now = Date.now();
      var filtered = currentShares.filter(function (s) {
        if (q && !s.filename.toLowerCase().includes(q) && !(s.url || '').toLowerCase().includes(q)) return false;
        if (status === 'expired') return s.expiresAt && new Date(s.expiresAt).getTime() < now;
        if (status === 'active') return !s.expiresAt || new Date(s.expiresAt).getTime() >= now;
        if (status === 'password') return s.hasPassword;
        return true;
      });
      if (!filtered.length) {
        body.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      body.innerHTML = filtered.map(function (share) {
        var expireText = share.expiresAt ? formatTime(share.expiresAt) : '永不过期';
        return '<tr>' +
          '<td><input type="checkbox" class="share-check" value="' + encodeURIComponent(share.code) + '" onchange="updateShareBatchBar()"></td>' +
          '<td data-label=""><strong>' + escapeHtmlClient(share.filename) + '</strong></td>' +
          '<td data-label="链接"><a href="' + share.url + '" target="_blank">' + share.url + '</a></td>' +
          '<td data-label=""><img alt="QR" src="/api/share/qr/' + encodeURIComponent(share.code) + '"></td>' +
          '<td data-label="信息">' +
            '<div>到期: ' + expireText + '</div>' +
            '<div>下载: ' + (share.downloadCount || 0) + (share.maxDownloads ? ' / ' + share.maxDownloads : '') + '</div>' +
            '<div>' + (share.hasPassword ? '有密码' : '无密码') + '</div>' +
          '</td>' +
          '<td class="actions-cell" data-label="操作">' +
            '<button class="secondary" onclick=' + "'" + 'copyShare(' + JSON.stringify(share.url) + ')' + "'" + '>复制</button>' +
            '<button class="danger" onclick=' + "'" + 'deleteShare(' + JSON.stringify(share.code) + ')' + "'" + '>删除</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    async function copyAllShares() {
      if (!currentShares.length) return;
      var urls = currentShares.map(function (s) { return s.url; }).join('\n');
      await copyToClipboard(urls);
      showToast('已复制 ' + currentShares.length + ' 个链接', 'success');
    }

    async function copyShare(url) {
      await copyToClipboard(url);
      showToast('已复制', 'success');
    }

    async function deleteShare(code) {
      if (!confirm('删除这个分享链接?')) return;
      await request('/api/share/delete/' + encodeURIComponent(code), { method: 'DELETE' });
      await loadShares();
    }

    function toggleShareSelectAll(checked) {
      document.querySelectorAll('.share-check').forEach(function(el) { el.checked = checked; });
      updateShareBatchBar();
    }

    function updateShareBatchBar() {
      var checked = document.querySelectorAll('.share-check:checked');
      var bar = document.getElementById('shareBatchBar');
      var count = document.getElementById('shareBatchCount');
      var listAll = document.getElementById('shareListSelectAll');
      if (!bar || !count) return;
      if (checked.length > 0) {
        bar.style.display = 'flex';
        count.textContent = '已选择 ' + checked.length + ' 个链接';
        listAll.checked = checked.length === document.querySelectorAll('.share-check').length;
      } else {
        bar.style.display = 'none';
        listAll.checked = false;
      }
    }

    function clearShareSelection() {
      document.querySelectorAll('.share-check').forEach(function(el) { el.checked = false; });
      document.getElementById('shareListSelectAll').checked = false;
      updateShareBatchBar();
    }

    async function batchDeleteSelectedShares() {
      var checked = document.querySelectorAll('.share-check:checked');
      var codes = Array.from(checked).map(function(el) { return decodeURIComponent(el.value); });
      if (!codes.length) { showToast('请先选择链接', 'error'); return; }
      if (!confirm('删除 ' + codes.length + ' 个分享链接?')) return;
      var count = 0;
      for (var i = 0; i < codes.length; i++) {
        try {
          await request('/api/share/delete/' + encodeURIComponent(codes[i]), { method: 'DELETE' });
          count++;
        } catch (e) {}
      }
      showToast('已删除 ' + count + ' 个链接', 'success');
      clearShareSelection();
      await loadShares();
    }

    async function batchDeleteExpiredShares() {
      var now = Date.now();
      var expired = currentShares.filter(function (s) {
        return s.expiresAt && new Date(s.expiresAt).getTime() < now;
      });
      if (!expired.length) { showToast('没有已过期的分享链接', 'info'); return; }
      if (!confirm('删除 ' + expired.length + ' 个已过期分享链接?')) return;
      var count = 0;
      for (var i = 0; i < expired.length; i++) {
        try {
          await request('/api/share/delete/' + encodeURIComponent(expired[i].code), { method: 'DELETE' });
          count++;
        } catch (e) {}
      }
      showToast('已删除 ' + count + ' 个过期链接', 'success');
      await loadShares();
    }

    document.getElementById('searchInput').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') searchFiles();
    });

    document.getElementById('shareSearchInput').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') filterShares();
    });

    // Sort state
    var currentSort = 'updated_at';
    var currentOrder = 'desc';

    // Show initial sort arrow
    (function initArrows() {
      ['filename', 'size', 'updated_at'].forEach(function (c) {
        var arrow = document.getElementById('arrow-' + c);
        if (arrow) arrow.textContent = c === currentSort ? (currentOrder === 'asc' ? '↑' : '↓') : '';
      });
    })();

    function setSort(col) {
      if (currentSort === col) {
        currentOrder = currentOrder === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort = col;
        currentOrder = col === 'updated_at' ? 'desc' : 'asc';
      }
      // Update arrow indicators
      ['filename', 'size', 'updated_at'].forEach(function (c) {
        var arrow = document.getElementById('arrow-' + c);
        if (arrow) arrow.textContent = c === currentSort ? (currentOrder === 'asc' ? '↑' : '↓') : '';
      });
      loadFiles();
    }

    setupDragDrop();
    loadFiles();
    loadRecentSearches();

    // Lazy-load image thumbnails via IntersectionObserver
    (function initThumbnails() {
      if (!('IntersectionObserver' in window)) return;
      var loaded = new Set();
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var wrap = entry.target;
          var filename = wrap.dataset.filename;
          if (loaded.has(filename)) { observer.unobserve(wrap); return; }
          loaded.add(filename);
          var overlay = wrap.querySelector('.img-overlay');
          if (overlay) overlay.style.display = 'flex';
          fetch('/api/content/' + encodeURIComponent(filename), { headers: headers() })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              var file = d.file;
              if (!file || !file.content) throw new Error('no content');
              var isImg = (file.mime || '').startsWith('image/');
              if (!isImg) throw new Error('not image');
              var img = document.createElement('img');
              img.src = 'data:' + file.mime + ';base64,' + file.content;
              img.alt = file.name;
              img.style = 'width:100%;height:64px;object-fit:cover;border-radius:4px;display:block';
              img.onload = function () {
                wrap.innerHTML = '';
                wrap.appendChild(img);
                observer.unobserve(wrap);
              };
              img.onerror = function () { wrap.innerHTML = wrap.dataset.origIcon || ''; observer.unobserve(wrap); };
              wrap.dataset.origIcon = wrap.querySelector('.img-placeholder').outerHTML;
              wrap.innerHTML = '';
              wrap.appendChild(img);
            })
            .catch(function () {
              if (overlay) overlay.style.display = 'none';
            });
        });
      }, { rootMargin: '200px' });
      document.querySelectorAll('.img-thumb-wrap').forEach(function (el) { observer.observe(el); });
      // Re-observe after view toggle
      window._thumbObserver = observer;
      window._thumbLoaded = loaded;
    })();
    // Re-init thumbnails after DOM update (setView → loadFiles)
    (function patchSetView() {
      var orig = window.setView;
      if (!orig) return;
      window.setView = function (view) {
        orig.apply(null, arguments);
        setTimeout(function () {
          var io = window._thumbObserver;
          var ld = window._thumbLoaded;
          if (!io) return;
          document.querySelectorAll('.img-thumb-wrap').forEach(function (el) {
            if (!ld.has(el.dataset.filename)) io.observe(el);
          });
        }, 100);
      };
    })();

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
      // Ctrl/Cmd + Enter: upload files (or save text if textarea focused)
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        var fi = document.getElementById('fileInput');
        if (fi && fi.files && fi.files.length) {
          e.preventDefault();
          uploadFiles();
        } else {
          var tc = document.getElementById('textContent');
          if (tc && document.activeElement === tc) {
            e.preventDefault();
            uploadText();
          }
        }
      }
      // Ctrl/Cmd + F: focus search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        document.getElementById('searchInput').focus();
        document.getElementById('searchInput').select();
      }
      // Escape: close modal
      if (e.key === 'Escape') {
        forceCloseModal();
      }
    });

    Promise.all([loadFiles(), loadShares()]).catch(function (error) {
      status(error.message);
    });
  </script>
  <script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function() {});

      // Listen for SW sync events
      navigator.serviceWorker.addEventListener('message', function (event) {
        var data = event.data || {};
        if (data.type === 'UPLOAD_SYNC_STARTED') {
          showToast('\u4E0A\u4F20\u961F\u5217\u540C\u6B65\u4E2D\u2026 (' + data.count + ')', 'info', 4000);
        }
        if (data.type === 'UPLOAD_SYNC_COMPLETE') {
          if (data.failed === 0) {
            showToast('\u4E0A\u4F20\u961F\u5217\u5DF2\u5168\u90E8\u5B8C\u6210 (' + data.success + ')', 'success');
          } else {
            showToast('\u4E0A\u4F20\u961F\u5217\u5B8C\u6210 ' + data.success + '\uFF0C\u5931\u8D25 ' + data.failed, 'warn', 6000);
          }
          if (typeof loadFiles === 'function') loadFiles();
        }
      });
    }

    // Queue upload when offline
    window.queueUpload = function(endpoint, body, headers) {
      if (!navigator.serviceWorker.controller) return false;
      var mc = new MessageChannel();
      navigator.serviceWorker.controller.postMessage(
        { type: 'QUEUE_UPLOAD', payload: { endpoint: endpoint, body: body, headers: headers } },
        [mc.port2]
      );
      return true;
    };

    // Trigger SW sync
    window.syncUploads = function() {
      if (!navigator.serviceWorker.controller) return;
      navigator.serviceWorker.controller.postMessage({ type: 'SYNC_UPLOADS' });
    };
  </script>
</body>
</html>`;
}

async function requestHandler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;
  const query = parsed.searchParams;

  if (pathname === '/') {
    sendHtml(res, renderPage());
    return;
  }

  if (pathname === '/icon-192.png' || pathname === '/icon-512.png') {
    const filePath = path.join(__dirname, 'public', pathname.slice(1));
    if (!fs.existsSync(filePath)) {
      sendJson(res, { success: false, error: 'Not found' }, 404);
      return;
    }
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, { 'Content-Type': 'image/png' });
    stream.pipe(res);
    return;
  }

  // Service Worker for offline caching
  if (pathname === '/sw.js') {
    const filePath = path.join(__dirname, 'public', 'sw.js');
    if (!fs.existsSync(filePath)) {
      sendJson(res, { success: false, error: 'Not found' }, 404);
      return;
    }
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
    stream.pipe(res);
    return;
  }

  if (pathname === '/manifest.json') {
    const filePath = path.join(__dirname, 'public', 'manifest.json');
    if (!fs.existsSync(filePath)) {
      sendJson(res, { success: false, error: 'Not found' }, 404);
      return;
    }
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    stream.pipe(res);
    return;
  }

  const ctx = {
    VERSION,
    BASE_URL,
    SHARE_TOKEN,
    config,
    db,
    archiver,
    QRCode,
    sendJson,
    sendHtml,
    readJsonBody,
    authRequired,
    getClientIp,
    escapeHtml,
    guessMimeType,
    decodeStoredFile,
    createShareLink,
    validateShareCode,
    maxUploadBytes,
    saveConfig
  };

  try {
    if (await handleApiRoutes(req, res, pathname, query, ctx)) return;
    if (await handleFileRoutes(req, res, pathname, query, ctx)) return;
    if (await handleShareRoutes(req, res, pathname, query, ctx)) return;
    sendJson(res, { success: false, error: 'Not found' }, 404);
  } catch (error) {
    console.error('[ShareTool] Request failed:', error);
    sendJson(res, { success: false, error: error.message || 'Internal server error' }, 500);
  }
}

function createApp() {
  return http.createServer(requestHandler);
}

async function start() {
  const { key, cert } = await getOrCreateCertificate();

  const httpsServer = https.createServer({ key, cert }, requestHandler);
  httpsServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[ShareTool] HTTPS port ${HTTPS_PORT} already in use`);
    } else {
      console.error('[ShareTool] HTTPS server error:', e);
    }
  });
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log('[ShareTool] HTTPS listening on https://0.0.0.0:' + HTTPS_PORT);
    console.log('[ShareTool] LAN address: https://' + LOCAL_IP + ':' + HTTPS_PORT);
    console.log('[ShareTool] Token: ' + SHARE_TOKEN);
  });

  // Initialize WebSocket server on the HTTPS server
  const wss = initWebSocketServer(httpsServer);
  console.log('[ShareTool] WebSocket server ready on wss://0.0.0.0:' + HTTPS_PORT + '/ws');

  const redirectServer = http.createServer((req, res) => {
    const host = req.headers.host || `${LOCAL_IP}:${PORT}`;
    const hostname = host.split(':')[0];
    const destination = `https://${hostname}:${HTTPS_PORT}${req.url}`;
    res.writeHead(301, { 'Location': destination, 'Cache-Control': 'no-cache' });
    res.end(`Redirecting to ${destination}`);
  });
  redirectServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[ShareTool] HTTP redirect port ${PORT} already in use`);
    }
  });
  redirectServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[ShareTool] HTTP redirect listening on http://${LOCAL_IP}:${PORT} -> https://${LOCAL_IP}:${HTTPS_PORT}`);
  });

  return { httpsServer, redirectServer };
}

if (require.main === module) {
  start().catch((e) => {
    console.error('[ShareTool] Failed to start:', e);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  start,
  decodeStoredFile,
  guessMimeType,
  createShareLink,
  validateShareCode
};
