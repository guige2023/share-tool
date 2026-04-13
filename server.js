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

// ── i18n: Internationalization ─────────────────────────────────────
const I18N = {
  en: {
    // Navigation & Actions
    files: 'Files', folders: 'Folders', upload: 'Upload', download: 'Download',
    delete: 'Delete', rename: 'Rename', move: 'Move', copy: 'Copy', cancel: 'Cancel', confirm: 'Confirm',
    selectAll: 'Select All', clearAll: 'Clear', search: 'Search', settings: 'Settings',
    help: 'Help', about: 'About', save: 'Save', close: 'Close', edit: 'Edit', view: 'View',
    // File ops
    preview: 'Preview', share: 'Share', copyLink: 'Copy Link', copyPath: 'Copy Path',
    addTag: 'Add Tag', removeTag: 'Remove Tag', addToVF: 'Add to Favorites', removeFromVF: 'Remove from Favorites',
    restore: 'Restore', permanentDelete: 'Delete Forever', versions: 'Versions', compareVersions: 'Compare',
    // Tags & Organization
    tags: 'Tags', favorites: 'Favorites', virtualFolders: 'Virtual Folders', newFolder: 'New Folder',
    tagManager: 'Tag Manager', mergeTags: 'Merge Tags', batchTag: 'Batch Tag',
    // Sorting & View
    sortBy: 'Sort by', name: 'Name', size: 'Size', updated: 'Updated', created: 'Created', type: 'Type',
    gridView: 'Grid', listView: 'List', recentSearches: 'Recent Searches', clearSearchHistory: 'Clear History',
    // Status
    selected: 'selected', of: 'of', loading: 'Loading...', processing: 'Processing...', noFiles: 'No files yet',
    uploadTip: 'Drop files here or click to upload', dragSortTip: 'Drag to reorder',
    // Messages
    deleted: 'Deleted', restored: 'Restored', saved: 'Saved', copied: 'Copied', moved: 'Moved',
    confirmDelete: 'Confirm delete', confirmDeleteMsg: 'Are you sure you want to delete this file?',
    confirmDeleteMulti: 'Delete selected files? This cannot be undone.',
    // System
    storage: 'Storage', usage: 'Usage', duplicateFiles: 'Duplicate Files', cleanupTrash: 'Empty Trash',
    auditLog: 'Audit Log', exportData: 'Export', language: 'Language', theme: 'Theme', dashboard: 'Storage Analysis', settings: 'Settings', appearance: 'Appearance', defaultView: 'Default View', serverInfo: 'Server Info', dark: 'Dark', light: 'Light', system: 'System', listView: 'List View', gridView: 'Grid View', saved: 'Saved',
  },
  zh: {
    // Navigation & Actions
    files: '文件', folders: '文件夹', upload: '上传', download: '下载',
    delete: '删除', rename: '重命名', move: '移动', copy: '复制', cancel: '取消', confirm: '确认',
    selectAll: '全选', clearAll: '清空', search: '搜索', settings: '设置',
    help: '帮助', about: '关于', save: '保存', close: '关闭', edit: '编辑', view: '查看',
    // File ops
    preview: '预览', share: '分享', copyLink: '复制链接', copyPath: '复制路径',
    addTag: '添加标签', removeTag: '移除标签', addToVF: '添加到收藏', removeFromVF: '从收藏移除',
    restore: '恢复', permanentDelete: '永久删除', versions: '版本历史', compareVersions: '版本对比',
    // Tags & Organization
    tags: '标签', favorites: '收藏夹', virtualFolders: '虚拟文件夹', newFolder: '新建文件夹',
    tagManager: '标签管理', mergeTags: '合并标签', batchTag: '批量标签',
    // Sorting & View
    sortBy: '排序', name: '名称', size: '大小', updated: '更新时间', created: '创建时间', type: '类型',
    gridView: '网格', listView: '列表', recentSearches: '最近搜索', clearSearchHistory: '清除历史',
    // Status
    selected: '已选择', of: '/', loading: '加载中...', processing: '处理中...', noFiles: '暂无文件',
    uploadTip: '拖拽文件到此处或点击上传', dragSortTip: '拖拽调整顺序',
    // Messages
    deleted: '已删除', restored: '已恢复', saved: '已保存', copied: '已复制', moved: '已移动',
    confirmDelete: '确认删除', confirmDeleteMsg: '确定要删除此文件吗？',
    confirmDeleteMulti: '删除所选文件？此操作不可撤销。',
    // System
    storage: '存储', usage: '使用量', duplicateFiles: '重复文件', cleanupTrash: '清空回收站',
    auditLog: '审计日志', exportData: '导出数据', language: '语言', theme: '主题', dashboard: '存储分析', settings: '设置', appearance: '外观', defaultView: '默认视图', serverInfo: '服务器信息', dark: '深色', light: '浅色', system: '跟随系统', listView: '列表视图', gridView: '网格视图', saved: '已保存',
  }
};

function t(lang, key, ...args) {
  const dict = I18N[lang] || I18N.zh;
  let text = dict[key] || I18N.zh[key] || key;
  if (args.length > 0) {
    text = text.replace(/\{(\d+)\}/g, (_, i) => args[parseInt(i)] ?? _);
  }
  return text;
}
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
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  // 安全响应头
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.removeHeader('X-Powered-By');
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
    let size = 0;
    const limit = maxUploadBytes;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return { _error: e.message };
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (e) {
    return { _error: 'Invalid JSON' };
  }
}

// Broadcast event to all SSE clients
global.broadcastSSE = function (event) {
  if (!global._sseClients || global._sseClients.size === 0) return;
  const data = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of global._sseClients) {
    try { res.write(data); } catch (_) {}
  }
};

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

// Module-level cert info for UI display
var certInfo = null;

async function getOrCreateCertificate() {
  const certPath = path.join(SSL_DIR, 'cert.pem');
  const keyPath = path.join(SSL_DIR, 'key.pem');
  try {
    if (!fs.existsSync(SSL_DIR)) {
      fs.mkdirSync(SSL_DIR, { recursive: true });
    }
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const certPem = fs.readFileSync(certPath, 'utf8');
      const x509 = new crypto.X509Certificate(certPem);
      const daysRemaining = Math.ceil((new Date(x509.validTo) - new Date()) / 86400000);
      if (daysRemaining > 7) {
        console.log(`[ShareTool] Using existing certificate (expires in ${daysRemaining} days)`);
        certInfo = {
          subject: x509.subject.split('\n')[0].replace('CN=', '').trim(),
          issuer: x509.issuer.split('\n')[0].replace('CN=', '').trim(),
          validTo: x509.validTo,
          daysRemaining
        };
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
  const x509 = new crypto.X509Certificate(pems.cert);
  certInfo = {
    subject: 'ShareTool Self-Signed',
    issuer: 'ShareTool',
    validTo: x509.validTo,
    daysRemaining: 365
  };
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
    maxUploadSizeMB: config.uploadMaxSizeMB,
    certInfo: certInfo
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="ShareTool">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#0f172a">
  <link rel="manifest" href="/manifest.json">
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
      --primary:#4f46e5;
      --warning:#d97706;
      --danger:#b91c1c;
      --shadow:0 24px 60px rgba(15,23,42,.08);
      --border:var(--line);
      --btn-bg:#0f172a;
      --btn-color:#fff;
      --btn-secondary-bg:#e2e8f0;
      --btn-secondary-color:#0f172a;
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
        --primary:#818cf8;
        --warning:#fbbf24;
        --danger:#f87171;
        --shadow:0 24px 60px rgba(0,0,0,.3);
        --border:#334155;
      }
      body{background:var(--bg);color:var(--text)}
      .hero{background:rgba(30,41,59,.86)}
      input[type="text"],input[type="password"],input[type="number"],textarea{background:#0f172a;color:#f1f5f9;border-color:#334155}
      pre{background:#0f172a!important;color:#e2e8f0!important}
      .modal-card{background:#1e293b}
      .panel{background:#1e293b;border-color:#334155}
      .toast{--toast-bg:#1e293b;--toast-color:#f1f5f9}
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
      --border:#334155;
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
    [data-theme="dark"] .chip{color:#2dd4bf}
    [data-theme="dark"] .chip.warn{background:#451a03;color:#fde68a}
    [data-theme="dark"] .tag-badge{color:#c7d2fe}
    [data-theme="dark"] .fab{background:#0f766e}
    *{box-sizing:border-box}
    [data-theme="dark"] body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    [data-theme="dark"] .hero{border-color:var(--line);background:rgba(30,41,59,.86)}
    [data-theme="dark"] .modal-card pre{background:#0f172a!important;color:#e2e8f0!important}
    [data-theme="dark"] button.secondary{background:#334155;color:#f1f5f9}
    [data-theme="dark"] .modal-card button:not(.secondary):not(.danger):not(.ghost){background:#334155;color:#f1f5f9}
    [data-theme="dark"] button.ghost{background:transparent;border-color:#475569;color:#f1f5f9}
    [data-theme="dark"] button{--btn-bg:#e2e8f0;--btn-color:#0f172a;--btn-secondary-bg:#334155;--btn-secondary-color:#f1f5f9}
    [data-theme="dark"] .tag-badge{color:#c7d2fe}
    [data-theme="dark"] .progress-bar-wrap{background:#1e293b}
    [data-theme="dark"] .shares img{background:#0f172a}
    [data-theme="dark"] .shares .empty-state span{color:#94a3b8}
    [data-theme="dark"] .list-scroll::-webkit-scrollbar{background:#1e293b}
    [data-theme="dark"] .list-scroll::-webkit-scrollbar-thumb{background:#475569;border-radius:4px}
    [data-theme="dark"] .empty{color:#475569}
    [data-theme="dark"] #ctxMenu{background:#1e293b;border-color:#334155;color:#f1f5f9}
    [data-theme="dark"] .ctx-item:hover{background:#334155}
    [data-theme="dark"] .view-toggle button.active{background:var(--primary);color:var(--text-inverse, #fff)}
    [data-theme="dark"] .view-toggle button{background:#334155;color:#f1f5f9}
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
    .chip.warn{background:#fef3c7;color:#92400e}
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
      border:none;border-radius:14px;padding:11px 16px;background:var(--btn-bg,#111827);color:var(--btn-color,#fff);cursor:pointer
    }
    button.secondary{background:var(--btn-secondary-bg,#e2e8f0);color:var(--btn-secondary-color,#0f172a)}
    button.danger{background:var(--danger)}
    button.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
    .drop-zone{border:2px dashed var(--line);border-radius:16px;padding:28px;text-align:center;cursor:pointer;transition:border-color .2s,background .2s;background:rgba(255,255,255,.4)}
    .drop-zone:hover,.drop-zone.dragover{border-color:var(--accent);background:rgba(16,185,129,.06)}
    .drop-zone.dragover{border-style:solid}
    .drop-zone-inner{pointer-events:none}
    .drop-icon{font-size:32px;margin-bottom:8px}
    .toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;position:relative}
    .toolbar input{flex:1 1 260px}
    .batch-bar{display:flex;gap:8px;align-items:center;padding:10px 14px;background:var(--bg-secondary);border-radius:12px;margin-bottom:12px;font-size:13px}
    .batch-bar button{min-height:36px;padding:6px 12px;font-size:13px;border-radius:8px;flex-shrink:0}
    .type-chip{background:var(--bg-tertiary);border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:12px;cursor:pointer;transition:all .15s;color:var(--text-secondary);white-space:nowrap}
    .type-chip:hover{background:var(--bg-secondary);color:var(--text)}
    .type-chip.active{background:var(--accent-weak);border-color:var(--accent);color:var(--accent);font-weight:500}
    .recent-search-tag{display:inline-flex;align-items:center;gap:4px;padding:4px 8px 4px 12px;background:var(--accent-weak);color:var(--accent);border-radius:999px;font-size:12px;margin-right:6px;cursor:pointer}
    .recent-search-tag .delete-btn{opacity:0;padding:2px 4px;border-radius:999px;font-size:13px;line-height:1;transition:opacity .15s}
    .recent-search-tag:hover .delete-btn{opacity:1}
    .recent-search-tag .delete-btn:hover{background:var(--accent);color:#fff}
    .suggestion-item{padding:9px 12px;cursor:pointer;font-size:13px;display:flex;justify-content:space-between;align-items:center;white-space:nowrap;overflow:hidden}
    .suggestion-item:hover,.suggestion-item.selected{background:var(--bg-tertiary)}
    .suggestion-item mark{background:#fef08a;color:inherit;padding:0 2px;border-radius:2px}
    [data-theme="dark"] .suggestion-item mark{background:#854d0e;color:#fef08a}
    mark.search-highlight{background:#fef08a;color:inherit;padding:0 2px;border-radius:2px}
    [data-theme="dark"] mark.search-highlight{background:#854d0e;color:#fef08a}
    .suggestion-type{font-size:11px;color:var(--muted);flex-shrink:0;margin-left:10px}
    table{width:100%;border-collapse:collapse}
    th,td{padding:12px 8px;border-bottom:1px solid #edf2f7;text-align:left;vertical-align:top;font-size:14px}
    .sort-arrow{font-size:10px;color:var(--muted);margin-left:2px}
    th{color:var(--muted);font-weight:600}
    td.actions{display:flex;gap:8px;flex-wrap:wrap}
    td.actions button{padding:8px 10px;border-radius:10px;font-size:13px}
    .muted{color:var(--muted)}
    .status{margin-top:12px;min-height:22px;color:var(--muted)}
    .progress-bar-wrap{display:none;margin-top:10px;background:#edf2f7;border-radius:999px;height:10px;overflow:hidden;position:relative}
    .progress-bar-wrap.active{display:block}
    .progress-bar{height:100%;background:var(--accent);border-radius:999px;transition:width .15s;min-width:2px}
    .list-scroll{max-height:620px;overflow:auto}
    .empty{padding:30px 10px;color:var(--muted);text-align:center}
    .modal{position:fixed;inset:0;background:rgba(15,23,42,.58);display:none;align-items:center;justify-content:center;padding:20px}
    .modal.open{display:flex}
    .modal-card{width:min(900px,96vw);max-height:88vh;overflow:auto;background:var(--panel);border-radius:24px;padding:20px;border:1px solid var(--line)}
    .modal-card pre{white-space:pre-wrap;word-break:break-word;background:#0f172a;color:#e2e8f0;padding:18px;border-radius:16px;overflow:auto}
    .modal-card img{max-width:100%;border-radius:16px}
    .shares img{width:84px;height:84px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
    @media (max-width: 960px){
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
    @media(max-width:600px){
      /* Context menu: larger touch targets on mobile */
      .ctx-menu{min-width:180px}
      /* Sticky toolbar on mobile scroll */
      .panel:first-of-type{position:sticky;top:0;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,.1)}
      /* Hero section compact on mobile */
      .hero .meta{gap:6px}
      .hero .chip{padding:5px 8px;font-size:10px}
      .hero p{display:none}
      /* Touch-friendly: increase tap targets */
      button,.ctx-item{padding:10px 14px}
      /* Hide less-used toolbar buttons on small screens, show via FAB+menu */
      #advancedSearchBtn,#downloadSelected,#openTagManager,#deleteAllFiles,#trashBtn,#installPwaBtn{display:none}
      #openDuplicates{display:none!important}
      /* iOS auto-zoom fix: all inputs must be >=16px */
      input,select,textarea{font-size:16px!important}
      /* Mobile: drop zone is the primary upload affordance - make it prominent */
      .drop-zone{padding:24px 16px;font-size:14px}
      .drop-zone-inner p{margin:4px 0}
      /* Prevent iOS from auto-zooming on inputs inside toolbar/search */
      .toolbar input{font-size:16px!important}
      .search-input-wrap input{font-size:16px!important}
      .meta .chip{font-size:11px;padding:7px 10px}
      .hero h1{font-size:24px}
      .hero{padding:16px;padding-top:max(16px,env(safe-area-inset-top));padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}
      .wrap{padding:12px;padding-left:max(12px,env(safe-area-inset-left));padding-right:max(12px,env(safe-area-inset-right));padding-bottom:max(12px,env(safe-area-inset-bottom))}
      .panel{padding:14px}
      /* Let toolbar buttons wrap naturally - remove 100% width that broke toolbar layout */
      .toolbar{flex-wrap:wrap;gap:8px}
      .toolbar button{min-width:44px;width:auto;padding:9px 12px;font-size:13px}
      .toolbar input{flex:1 1 100%!important;min-width:0!important}
      #tagFilterSelect{flex:1 1 100%;max-width:100%}
      #shareSearchInput{flex:1 1 100%!important}
      #shareStatusFilter{width:100%}
      /* Touch targets: min 44px height for buttons */
      button,.btn{min-height:44px;font-size:15px}
      /* Card-mode table: readable labels */
      td{padding:6px 0 6px 40%;font-size:13px}
      td:first-child{font-size:15px;font-weight:500}
      td.actions-cell a,td.actions-cell button{padding:8px 10px;font-size:13px}
      /* Prevent horizontal overflow */
      body{overflow-x:hidden}
      /* Grid view: smaller cards on narrow screens */
      #fileTableGrid tbody{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
      #fileTableGrid .file-item .file-name{word-break:break-word;hyphens:auto;line-height:1.3}
      #fileTableGrid .file-item{padding:10px}
      /* On mobile grid: hide inline actions, use context menu instead */
      @media (max-width: 600px){
        #fileTableGrid .file-actions{display:none}
        .mobile-more-btn{display:flex!important;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;background:var(--btn-bg,#e5e7eb);border:none;font-size:18px;cursor:pointer;flex-shrink:0}
      }
      /* Batch bar: horizontal scroll on small screens */
      #batchBar{overflow-x:auto;justify-content:flex-start!important;padding:8px 12px!important;gap:6px;flex-wrap:nowrap;white-space:nowrap}
      #batchBar button{min-height:36px;padding:7px 12px;font-size:12px;white-space:nowrap;flex-shrink:0}
      #batchCount{white-space:nowrap;font-size:12px;flex-shrink:0}
      /* Mobile modal: full-screen preview */
      .modal-card{width:100%;max-height:100vh;height:100vh;border-radius:0;padding:12px;padding-top:max(12px,env(safe-area-inset-top));padding-bottom:max(12px,env(safe-area-inset-bottom));padding-left:max(12px,env(safe-area-inset-left));padding-right:max(12px,env(safe-area-inset-right))}
      .modal{padding:0}
    }
    /* Toast notification */
    #toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--toast-bg,#111827);color:var(--toast-color,#fff);padding:12px 20px;border-radius:10px;font-size:14px;opacity:0;transition:transform .3s,opacity .3s;pointer-events:none;z-index:9999;max-width:90vw;text-align:center;word-break:break-all}
    @keyframes spin{to{transform:rotate(360deg)}}
    #toast.show{transform:translateX(-50%) translateY(0);opacity:1}
    #toast.success{background:#059669}
    #toast.error{background:#dc2626}
    [data-theme="dark"] #toast{--toast-bg:#1e293b;--toast-color:#f1f5f9}
    [data-theme="dark"] #toast.success{background:#065f46}
    /* ===== FAB - Mobile Floating Action Button ===== */
    .fab{
      position:fixed;right:20px;bottom:max(20px,env(safe-area-inset-bottom));width:56px;height:56px;
      border-radius:50%;background:var(--accent);color:#fff;border:none;
      font-size:28px;line-height:1;cursor:pointer;z-index:9000;
      box-shadow:0 4px 16px rgba(15,118,110,.4);display:none;align-items:center;justify-content:center;
      transition:transform .2s,box-shadow .2s;
    }
    .fab:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(15,118,110,.5)}
    .fab:active{transform:scale(.96)}
    @media(max-width:600px){.fab{display:flex}}
    [data-theme="dark"] #toast.error{background:#991b1b}
    .file-tags{display:flex;flex-wrap:wrap;gap:3px;max-width:110px}
    .tag-badge{background:#e0e7ff;color:#3730a3;font-size:10px;padding:1px 6px;border-radius:10px;font-weight:500}
    .tag-edit-btn{background:none;border:none;color:var(--muted);cursor:pointer;font-size:10px;padding:2px 4px;border-radius:4px;transition:color .2s,background .2s}
    .tag-edit-btn:hover{color:var(--primary);background:rgba(99,102,241,.1)}
    /* Inline rename */
    .inline-rename-btn{background:none;border:none;color:var(--muted);cursor:pointer;font-size:11px;padding:1px 3px;border-radius:3px;transition:color .2s,background .2s;margin-left:4px;vertical-align:middle}
    .inline-rename-btn:hover{color:var(--primary);background:rgba(99,102,241,.1)}
    .filename-cell{position:relative}
    .filename-text:hover + .inline-rename-btn,.inline-rename-btn:hover{opacity:1}
    .inline-rename-btn{opacity:.5}
    .inline-rename-input{width:100%;border:1px solid var(--primary);border-radius:4px;padding:2px 6px;font-size:13px;background:var(--bg-primary);color:var(--text);outline:none;box-sizing:border-box}
    /* Batch bar */
    .ctx-item{padding:10px 16px;cursor:pointer;transition:background .15s}
    .ctx-item:hover{background:var(--bg-tertiary)}
    .ctx-sep{height:1px;background:var(--border);margin:4px 0}
    /* View toggle */
    .view-toggle{display:flex;gap:2px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:8px;padding:2px;margin-left:auto}
    .view-toggle button{background:none;border:none;color:var(--muted);cursor:pointer;padding:4px 8px;border-radius:6px;font-size:13px;line-height:1;transition:all .15s}
    .view-toggle button:hover{color:var(--text-primary)}
    .view-toggle button.active{background:var(--primary);color:var(--text-inverse, #fff)}
    /* Grid view */
    #fileTable,#fileTableGrid{display:table;width:100%;table-layout:fixed}
    #fileTableGrid tbody{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
    #fileTable .file-item,#fileTableGrid .file-item{display:flex;flex-direction:column;padding:14px;background:var(--bg-secondary);border:1px solid var(--line);border-radius:12px;transition:box-shadow .2s,border-color .2s;min-height:140px;content-visibility:auto;contain-intrinsic-size:0 160px}
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
    /* Keyboard navigation highlight */
    .file-item.keyboard-nav,
    #fileTableBody tr.keyboard-nav { outline: 2px solid var(--accent, #6366f1); outline-offset: -2px; border-radius: 4px; }
    #fileTableBody tr.keyboard-nav td:first-child { border-left: 2px solid var(--accent, #6366f1); }
    /* Drag-to-reorder */
    #fileTableGrid .file-item,#fileTable .file-item{cursor:grab}
    #fileTableGrid .file-item:active,#fileTable .file-item:active{cursor:grabbing}
    .file-item.dragging{opacity:.4;transform:scale(.97)}
    .file-item.drag-over:not(.dragging){border-color:var(--accent)!important;box-shadow:0 0 0 2px var(--accent);transform:scale(1.02);border-style:dashed}
    /* Code block styling */
    #codeBlock,#codeBlock code,#plainTextPre{background:var(--bg-secondary)!important}
    #codeBlock code.hljs{background:transparent!important;padding:.5em!important;border-radius:8px}
    #plainTextPre{white-space:pre-wrap;word-break:break-all}
    /* Markdown preview */
    #mdPreview h1,#mdPreview h2,#mdPreview h3{color:var(--text-primary);border-bottom:1px solid var(--line);padding-bottom:4px;margin-top:1.2em}
    #mdPreview pre{background:var(--bg-secondary);padding:12px;border-radius:8px;overflow-x:auto}
    #mdPreview code{background:var(--bg-secondary);padding:2px 5px;border-radius:4px;font-size:.9em}
    #mdPreview pre code{background:transparent;padding:0}
    #mdPreview table{border-collapse:collapse;width:100%}
    #mdPreview td,#mdPreview th{border:1px solid var(--line);padding:6px 10px}
    #mdPreview blockquote{border-left:3px solid var(--accent);margin:0;padding:4px 12px;color:var(--text-muted)}
  </style>
  <!-- Syntax highlighting + Markdown -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css" media="(prefers-color-scheme:light)">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" media="(prefers-color-scheme:dark)">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.1/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
</head>
<body>
  <div id="toast" role="status" aria-live="polite" aria-atomic="true"></div>
  <div id="ctxMenu" style="display:none;position:fixed;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10000;min-width:160px;overflow:hidden;font-size:14px">
    <div class="ctx-item" onclick="ctxAction('open')">👁 查看</div>
    <div class="ctx-item" onclick="ctxAction('download')">⬇ 下载</div>
    <div class="ctx-item" onclick="ctxAction('share')">🔗 分享</div>
    <div class="ctx-item" onclick="ctxAction('copyLink')">📋 复制链接</div>
    <div class="ctx-item" onclick="ctxAction('copyName')">📝 复制文件名</div>
    <div class="ctx-item" onclick="ctxAction('copyPath')">📂 复制文件路径</div>
    <div class="ctx-item" onclick="ctxAction('history')">📜 版本历史</div>
    <div class="ctx-item" onclick="ctxAction('info')">ℹ️ 文件属性</div>
    <div class="ctx-item" onclick="ctxAction('addToVF')">⭐ 添加到收藏夹</div>
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
        <select id="langSelect" onchange="setLanguage(this.value)" title="语言" style="background:var(--bg-secondary);border:1px solid var(--line);border-radius:12px;padding:6px 10px;cursor:pointer;font-size:13px;color:var(--text)">
          <option value="zh">🇨🇳 中文</option>
          <option value="en">🇺🇸 English</option>
        </select>
      </div>
      <div class="meta">
        <div class="chip">局域网地址 https://${escapeHtml(pageInfo.localIp)}:${pageInfo.port}</div>
        <div class="chip">Token ${escapeHtml(pageInfo.token)}</div>
        <div class="chip">最大上传 ${pageInfo.maxUploadSizeMB} MB</div>
        <div class="chip" id="wsStatusChip" title="WebSocket 实时同步状态">🔄 同步中</div>
        <div class="chip">版本 v${escapeHtml(pageInfo.version)}</div>
        ${pageInfo.certInfo ? '<div class="chip ' + (pageInfo.certInfo.daysRemaining < 30 ? 'warn' : '') + '" id="certStatusChip" title="SSL 证书状态\n颁发者: ' + escapeHtml(pageInfo.certInfo.issuer) + '\n过期: ' + pageInfo.certInfo.validTo + '">' + (pageInfo.certInfo.daysRemaining < 30 ? '⚠️ SSL ' + pageInfo.certInfo.daysRemaining + '天' : '🔒 SSL') + '</div>' : ''}
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
        <p class="muted">支持同时选择多个文件、整个文件夹（保留结构），也可拖拽文件到此处。Shift+N 新建文件夹。</p>
        <div id="dropZone" class="drop-zone" onclick="document.getElementById('fileInput').click()">
          <input id="fileInput" type="file" multiple webkitdirectory style="display:none" onchange="handleFileSelect(this.files)" title="支持选择文件夹">
          <div class="drop-zone-inner">
            <div class="drop-icon">📁</div>
            <div>拖拽文件到此处，或点击选择文件/文件夹</div>
          </div>
        </div>
        <div id="fileList" style="margin-top:10px;font-size:13px;color:var(--muted)"></div>
        <div class="row" style="margin-top:12px">
          <button onclick="uploadFiles()">上传文件</button>
          <button class="secondary" onclick="openNewFolderModal()">📁 新建文件夹</button>
          <button class="secondary" onclick="clearFileInput()">清空选择</button>
        </div>
        <div class="progress-bar-wrap" id="progressBarWrap">
          <div class="progress-bar" id="progressBar" style="width:0%;background:var(--accent)"></div>
          <div class="progress-bar" id="fileProgressBar" style="position:absolute;top:0;left:0;height:100%;background:var(--text-muted);opacity:0.5;width:0%;border-radius:999px;transition:width .1s"></div>
        </div>
        <div class="status" id="uploadStatus"></div>
      </section>

      <!-- Upload Queue Panel -->
      <div id="uploadQueuePanel" style="display:none;background:var(--bg-secondary);border:1px solid var(--line);border-radius:10px;margin-top:8px;overflow:hidden">
        <div class="uq-title" style="padding:8px 14px;font-size:12px;font-weight:600;border-bottom:1px solid var(--line);background:var(--bg-tertiary)">上传队列</div>
        <div class="uq-list" style="max-height:200px;overflow-y:auto;padding:0 14px"></div>
      </div>
    </div>

    <section class="panel" style="margin-top:18px">
      <div class="toolbar">
        <input id="searchInput" type="text" placeholder="按文件名搜索" autocomplete="off" inputmode="search" autocorrect="off" spellcheck="false" aria-label="搜索文件" style="padding-right:32px">
        <span id="searchClear" onclick="clearSearchInput()" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--muted);font-size:16px;line-height:1;display:none;user-select:none" title="清除搜索">✕</span>
        <select id="tagFilterSelect" onchange="filterByTag()" aria-label="按标签筛选" style="padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);font-size:13px;max-width:140px">
          <option value="">全部标签</option>
        </select>
        <button id="vfBtn" class="ghost" onclick="toggleVirtualFolderMenu()" title="收藏夹">⭐</button>
        <div id="vfMenu" style="display:none;position:absolute;z-index:1000;background:var(--bg-secondary);border:1px solid var(--line);border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:180px;padding:6px 0;font-size:13px;margin-top:4px">
          <div id="vfMenuList"></div>
          <div style="border-top:1px solid var(--line);margin:4px 0"></div>
          <div class="ctx-item" onclick="openVirtualFolderManager()" style="color:var(--accent)">⚙ 管理收藏夹</div>
        </div>
        <button id="vfBackBtn" class="ghost" style="display:none" onclick="exitVirtualFolder()">← 全部文件</button>
        <button onclick="loadFiles()">刷新</button>
        <button class="secondary" onclick="searchFiles()">搜索</button>
        <button class="ghost" onclick="openSettings()" title="设置 (Ctrl+,)">⚙</button>
        <button class="ghost" onclick="openKeyboardHelp()" title="键盘快捷键 (?)">?</button>
        <button id="installPwaBtn" class="secondary" style="display:none" onclick="installPWA()">安装应用</button>
        <button id="advancedSearchBtn" class="ghost" onclick="toggleAdvancedSearch()">高级 ⌄</button>
        <button class="ghost" onclick="downloadSelected()">打包下载选中项</button>
        <button class="secondary" onclick="openTagManager()">标签管理</button>
        <button class="secondary" onclick="openDashboard()">📊 存储分析</button>
        <button class="ghost" onclick="openTrash()">回收站</button>
        <button class="danger" onclick="deleteAllFiles()">删除全部</button>
        <div class="view-toggle">
          <input type="checkbox" id="gridSelectAll" onchange="toggleAll(this.checked)" style="display:none;margin-right:6px;cursor:pointer" title="全选">
          <button id="viewListBtn" class="active" onclick="setView('list')" title="列表视图">☰</button>
          <button id="viewGridBtn" onclick="setView('grid')" title="网格视图">⊞</button>
        </div>
      </div>
      <div id="recentSearches" style="display:none;margin-bottom:10px"></div>
      <div id="searchResultsBar" style="display:none;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:8px;padding:8px 14px;margin-bottom:8px;font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:10px"></div>
      <div id="typeFilterBar" style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center">
        <button class="type-chip active" data-type="" onclick="setTypeFilter('')">全部</button>
        <button class="type-chip" data-type="starred" onclick="setTypeFilter('starred')">⭐ 星标</button>
        <button class="type-chip" data-type="image" onclick="setTypeFilter('image')">🖼️ 图片</button>
        <button class="type-chip" data-type="video" onclick="setTypeFilter('video')">🎬 视频</button>
        <button class="type-chip" data-type="audio" onclick="setTypeFilter('audio')">🎵 音频</button>
        <button class="type-chip" data-type="pdf" onclick="setTypeFilter('pdf')">📕 PDF</button>
        <button class="type-chip" data-type="document" onclick="setTypeFilter('document')">📄 文档</button>
        <button class="type-chip" data-type="archive" onclick="setTypeFilter('archive')">📦 压缩</button>
        <button class="type-chip" data-type="text" onclick="setTypeFilter('text')">📝 文本</button>
      </div>
      <div id="fileStatsBar" style="display:flex;gap:16px;align-items:center;padding:0 0 8px 0;font-size:12px;color:var(--muted);font-family:monospace;flex-wrap:wrap">
        <span id="fileCountDisplay">共 <strong>0</strong> 个文件</span>
        <span id="selectedCountDisplay" style="display:none">，已选 <strong>0</strong> 个</span>
        <span id="storageBar" style="display:none;align-items:center;gap:6px">
          <span id="storageText"></span>
          <span id="storageTrack" style="display:inline-block;width:60px;height:6px;background:var(--line);border-radius:3px;overflow:hidden;vertical-align:middle">
            <span id="storageFill" style="display:inline-block;height:100%;background:var(--accent);border-radius:3px;width:0%;transition:width .4s ease"></span>
          </span>
        </span>
      </div>
      <div id="tagQuickBar" style="display:none;margin-bottom:4px"></div>
      <div id="advancedSearchPanel" style="display:none;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:10px;gap:12px">
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;color:var(--muted)">文件大小</label>
            <div style="display:flex;gap:6px;align-items:center">
              <input id="sizeMin" type="number" placeholder="最小 KB" min="0" style="width:80px;padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);font-size:12px">
              <span style="color:var(--muted)">-</span>
              <input id="sizeMax" type="number" placeholder="最大 KB" min="0" style="width:80px;padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);font-size:12px">
              <span style="font-size:11px;color:var(--muted)">KB</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;color:var(--muted)">日期范围</label>
            <div style="display:flex;gap:6px;align-items:center">
              <input id="dateFrom" type="date" style="padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);font-size:12px">
              <span style="color:var(--muted)">-</span>
              <input id="dateTo" type="date" style="padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);font-size:12px">
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;color:var(--muted)">文件类型</label>
            <select id="typeFilter" style="padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);font-size:12px;min-width:100px">
              <option value="">全部类型</option>
              <option value="image">图片</option>
              <option value="video">视频</option>
              <option value="audio">音频</option>
              <option value="text">文本</option>
              <option value="pdf">PDF</option>
              <option value="doc">文档</option>
              <option value="archive">压缩包</option>
            </select>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;color:var(--muted)">标签匹配</label>
            <select id="tagMatchFilter" style="padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);font-size:12px;min-width:100px">
              <option value="all">包含全部</option>
              <option value="any">包含任一</option>
            </select>
          </div>
          <div style="margin-left:auto;display:flex;gap:6px;align-items:flex-end">
            <button onclick="doAdvancedSearch()" class="secondary" style="font-size:12px;padding:5px 12px">应用筛选</button>
            <button onclick="clearAdvancedSearch()" class="ghost" style="font-size:12px;padding:5px 10px">清除</button>
          </div>
        </div>
        <div id="activeFilters" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div>
      </div>
      <div id="searchSuggestions" style="position:relative;z-index:100;display:none;background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:10px;overflow:hidden;box-shadow:var(--shadow)"></div>
      <div id="batchBar" class="batch-bar" style="display:none">
        <span id="batchCount" style="font-size:13px;color:var(--muted)"></span>
        <button class="ghost" onclick="toggleInvertSelection()">反选</button>
        <button class="ghost" onclick="openBatchTagModal()">添加标签</button>
        <button class="ghost" onclick="openBatchRemoveTagModal()">移除标签</button>
        <button class="ghost" onclick="openBatchRenameModal()">批量重命名</button>
        <button class="ghost" onclick="batchCopyShareLinks()">🔗 复制链接</button>
        <button class="ghost" onclick="openBatchMoveModal()">📁 移动</button>
        <button class="ghost" onclick="batchDownloadSelected()">📦 下载 ZIP</button>
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
              <th style="width:60px;cursor:pointer;user-select:none" onclick="setSort('position')" title="手动排序，拖拽调整顺序">📌 <span class="sort-arrow" id="arrow-position"></span></th>
              <th style="width:100px;cursor:pointer;user-select:none" onclick="setSort('size')">大小 <span class="sort-arrow" id="arrow-size"></span></th>
              <th style="width:170px;cursor:pointer;user-select:none" onclick="setSort('updated_at')">更新时间 <span class="sort-arrow" id="arrow-updated_at"></span></th>
              <th style="width:140px;cursor:pointer;user-select:none" onclick="setSort('created_at')">创建时间 <span class="sort-arrow" id="arrow-created_at"></span></th>
              <th style="width:280px">操作</th>
            </tr>
          </thead>
          <tbody id="fileTableBody"></tbody>
        </table>
        <div id="fileTableGrid" style="display:none"></div>
        <div id="fileEmpty" class="empty" style="display:none">还没有内容</div>
        <div id="scrollSentinel" style="height:1px;margin-top:-1px"></div>
        <div id="scrollLoading" style="display:none;text-align:center;padding:16px;color:var(--muted);font-size:13px">加载更多...</div>
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

  <div id="modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" onclick="closeModal(event)">
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
    const STORAGE_KEY_LANG = 'st_lang'; // 'zh' | 'en'

    // Language / i18n management
    var currentLang = 'zh';
    var langDict = {};

    async function setLanguage(lang) {
      localStorage.setItem(STORAGE_KEY_LANG, lang);
      currentLang = lang;
      try {
        const res = await fetch('/api/i18n?lang=' + lang);
        const data = await res.json();
        if (data.success) {
          langDict = data.dict;
          applyTranslations();
        }
      } catch (e) { /* ignore */ }
      var langSelect = document.getElementById('langSelect');
      if (langSelect) langSelect.value = lang;
    }

    function applyTranslations() {
      document.querySelectorAll('[data-i18n]').forEach(function(el) {
        var key = el.getAttribute('data-i18n');
        if (langDict[key]) el.textContent = langDict[key];
      });
      document.querySelectorAll('[data-i18n-title]').forEach(function(el) {
        var key = el.getAttribute('data-i18n-title');
        if (langDict[key]) el.title = langDict[key];
      });
    }

    async function initLanguage() {
      var savedLang = localStorage.getItem(STORAGE_KEY_LANG) || 'zh';
      currentLang = savedLang;
      try {
        const res = await fetch('/api/i18n?lang=' + savedLang);
        const data = await res.json();
        if (data.success) langDict = data.dict;
      } catch (e) { /* ignore */ }
      var langSelect = document.getElementById('langSelect');
      if (langSelect) langSelect.value = savedLang;
    }

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
    initLanguage();

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
    initAuth().then(function() {
      loadFiles();
      loadStorageStats();
      setupInfiniteScroll();
      showWelcomeIfNeeded();

      // URL param ?f=filename - highlight and scroll to specific file
      (function() {
        var params = new URLSearchParams(location.search);
        var target = params.get('f');
        if (!target) return;
        target = decodeURIComponent(target);
        var attempt = 0;
        var iv = setInterval(function() {
          attempt++;
          var el = document.querySelector('[data-filename="' + encodeURIComponent(target) + '"]');
          if (!el && attempt < 20) return;
          clearInterval(iv);
          if (!el) return;
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.style.boxShadow = '0 0 0 3px var(--accent)';
          setTimeout(function() { el.style.boxShadow = ''; }, 3000);
        }, 100);
      })();
    });

    // Refresh storage stats when page becomes visible again
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible') {
        loadStorageStats();
      }
    });

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
      var fileBar = document.getElementById('fileProgressBar');
      if (wrap) wrap.classList.remove('active');
      if (bar) bar.style.width = '0%';
      if (fileBar) fileBar.style.width = '0%';
    }

    // 删除撤销状态
    var lastDeletedTrashId = null;
    var undoDeleteTimer = null;

    function showToast(message, type = '', undoCallback = null) {
      const el = document.getElementById('toast');
      if (undoCallback) {
        el.innerHTML = '<span style="margin-right:12px">' + escapeHtmlClient(message) + '</span><button onclick="event.stopPropagation();undoLastDelete()" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);color:#fff;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">撤销</button>';
      } else {
        el.textContent = message;
      }
      el.className = 'show' + (type ? ' ' + type : '');
      clearTimeout(el._timer);
      el._timer = setTimeout(() => {
        el.className = '';
        if (undoCallback) {
          clearTimeout(undoDeleteTimer);
          lastDeletedTrashId = null;
        }
      }, 5000);
    }

    async function undoLastDelete() {
      if (!lastDeletedTrashId) return;
      const idToRestore = lastDeletedTrashId;
      clearTimeout(undoDeleteTimer);
      lastDeletedTrashId = null;
      try {
        await fetch('/api/trash/restore', {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ trashId: idToRestore })
        });
        showToast('已恢复', 'success');
        await loadFiles();
        await loadShares();
      } catch (e) {
        showToast('恢复失败: ' + e.message, 'error');
      }
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

    function formatFileType(mime) {
      if (!mime) return '文件';
      if (mime.startsWith('image/')) return '图片';
      if (mime.startsWith('video/')) return '视频';
      if (mime.startsWith('audio/')) return '音频';
      if (mime === 'application/pdf') return 'PDF';
      if (mime.startsWith('text/')) return '文本';
      if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar') || mime.includes('gz') || mime.includes('7z')) return '压缩包';
      if (mime.includes('word') || mime.includes('document')) return 'Word';
      if (mime.includes('excel') || mime.includes('spreadsheet')) return 'Excel';
      if (mime.includes('powerpoint') || mime.includes('presentation')) return 'PPT';
      // Shorten common types
      var short = mime.replace(/^application\//, '').replace(/^text\//, '');
      return short.length > 12 ? '文件' : short.charAt(0).toUpperCase() + short.slice(1);
    }

    // Welcome guide for first-time users
    var WELCOME_KEY = 'sharetool_welcomed_v1';
    function showWelcomeIfNeeded() {
      if (localStorage.getItem(WELCOME_KEY)) return;
      var modal = document.createElement('div');
      modal.id = 'welcomeModal';
      modal.className = 'modal open';
      modal.innerHTML = '\
        <div class="modal-content" style="max-width:500px">\
          <h3>👋 欢迎使用 ShareTool</h3>\
          <div style="line-height:1.7;font-size:14px;color:var(--text-secondary);margin:16px 0">\
            <p><strong>📤 上传文件</strong>：点击顶部「上传」按钮或直接拖拽文件到窗口</p>\
            <p><strong>🔗 分享链接</strong>：选中文件后点击「分享」，生成分享码或链接</p>\
            <p><strong>📱 多设备同步</strong>：同一局域网下自动发现，文件实时同步</p>\
            <p><strong>⌨️ 快捷键</strong>：按 <kbd style="background:#eee;padding:2px 6px;border-radius:4px;font-size:12px">?</kbd> 查看所有快捷键</p>\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="showTour()">功能导览</button>\
            <button onclick="dismissWelcome()">知道了</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
    }

    function dismissWelcome() {
      localStorage.setItem(WELCOME_KEY, '1');
      var m = document.getElementById('welcomeModal');
      if (m) m.remove();
    }

    function showTour() {
      localStorage.setItem(WELCOME_KEY, '1');
      var m = document.getElementById('welcomeModal');
      if (m) m.remove();
      // Highlight upload button as tour step 1
      var uploadBtn = document.querySelector('.action-btn:not([disabled])') || document.querySelector('[onclick*="upload"]');
      if (uploadBtn) {
        uploadBtn.style.boxShadow = '0 0 0 3px var(--accent)';
        uploadBtn.style.borderRadius = '8px';
        setTimeout(function() { uploadBtn.style.boxShadow = ''; }, 4000);
      }
      showToast('点击「上传」开始添加文件', 'info', 4000);
    }

    // PWA Install prompt
    var deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', function(e) {
      e.preventDefault();
      deferredPrompt = e;
      var btn = document.getElementById('installPwaBtn');
      if (btn) { btn.style.display = ''; }
    });
    window.addEventListener('appinstalled', function() {
      deferredPrompt = null;
      var btn = document.getElementById('installPwaBtn');
      if (btn) { btn.style.display = 'none'; }
      showToast('ShareTool 已安装到主屏幕！', 'success');
    });
    async function installPWA() {
      if (!deferredPrompt) {
        showToast('请使用 Chrome/Edge 浏览器访问此页面来安装应用', 'error');
        return;
      }
      deferredPrompt.prompt();
      var result = await deferredPrompt.userChoice;
      if (result.outcome === 'accepted') {
        showToast('正在安装...', 'success');
      }
      deferredPrompt = null;
      document.getElementById('installPwaBtn').style.display = 'none';
    }

    function escapeHtmlClient(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Handle file item click: normal click clears selection, Shift+click does range select
    function handleItemClick(e, index) {
      // Ignore if clicking on interactive elements (checkbox, buttons, etc.)
      if (e.target.closest('.file-check') || e.target.closest('button') || e.target.closest('.tag-edit-btn') || e.target.closest('.inline-rename-btn')) return;
      // Ignore right/middle clicks
      if (e.button !== 0) return;
      if (e.shiftKey) {
        // Shift+Click: range select from lastClickedIndex to current
        e.preventDefault();
        var start = lastClickedIndex;
        var end = index;
        if (start < 0) start = end;
        var min = Math.min(start, end);
        var max = Math.max(start, end);
        var items = getAllFileItems();
        // Clear existing selection first
        document.querySelectorAll('.file-check').forEach(function(el) { el.checked = false; });
        for (var i = min; i <= max; i++) {
          var item = items[i];
          if (item) {
            var checkbox = item.querySelector('.file-check');
            if (checkbox) checkbox.checked = true;
          }
        }
        updateBatchBar();
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+Click: toggle this item only (don't clear selection)
        // Already handled by checkbox bubbling - do nothing special
      } else {
        // Normal click: clear selection, then select this item
        clearSelection();
        var items = getAllFileItems();
        var item = items[index];
        if (item) {
          var checkbox = item.querySelector('.file-check');
          if (checkbox) checkbox.checked = true;
          updateBatchBar();
        }
        lastClickedIndex = index;
      }
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
        var selEl = document.getElementById('selectedCountDisplay');
        if (selEl) { selEl.style.display = 'inline'; selEl.innerHTML = '，已选 <strong>' + names.length + '</strong> 个'; }
        var total = document.querySelectorAll('.file-check').length;
        if (selectAll) selectAll.checked = names.length === total;
      } else {
        bar.style.display = 'none';
        if (selectAll) selectAll.checked = false;
        var selEl = document.getElementById('selectedCountDisplay');
        if (selEl) selEl.style.display = 'none';
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
      if (!confirm('确定删除 ' + names.length + ' 个文件？文件将移入回收站。')) return;
      fetch('/api/files/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({ filenames: names })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data.success) {
          showToast('已删除 ' + data.deleted + ' 个文件', 'success');
          clearSelection();
          loadFiles();
        } else {
          showToast(data.error || '删除失败', 'error');
        }
      }).catch(function () { showToast('删除失败', 'error'); });
    }

    async function batchCopyShareLinks() {
      const names = checkedNames().map(function (n) { return decodeURIComponent(n); });
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      var links = [];
      for (var i = 0; i < names.length; i++) {
        try {
          var resp = await fetch('/api/share/create', {
            method: 'POST', headers: headers(),
            body: JSON.stringify({ filename: names[i], expires: 7 * 86400 })
          });
          if (resp.ok) {
            var data = await resp.json();
            if (data.success && data.share && data.share.url) links.push(data.share.url);
          }
        } catch(e) {}
      }
      if (links.length) {
        copyToClipboard(links.join('\n'));
        showToast('已复制 ' + links.length + ' 个分享链接', 'success');
      } else {
        showToast('创建链接失败', 'error');
      }
    }

    function openBatchMoveModal() {
      var names = checkedNames();
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      var folder = prompt('输入目标文件夹前缀（如 backups），文件将重命名为「前缀_原名」：', '');
      if (folder === null) return;
      folder = folder.trim();
      // Strip leading slash to satisfy validateFilename (no absolute paths)
      if (folder.startsWith('/')) folder = folder.slice(1);
      batchMoveSelected(names.map(function (n) { return decodeURIComponent(n); }), folder);
    }

    async function batchMoveSelected(names, folder) {
      var moved = 0, failed = 0;
      for (var i = 0; i < names.length; i++) {
        var oldPath = names[i];
        var newPath = (folder ? folder + '_' : '') + oldPath.split('/').pop();
        if (oldPath === newPath) continue;
        try {
          var resp = await fetch('/api/file-rename/' + encodeURIComponent(oldPath), {
            method: 'POST', headers: headers(),
            body: JSON.stringify({ newFilename: newPath })
          });
          if (resp.ok) moved++; else failed++;
        } catch(e) { failed++; }
      }
      if (moved || failed) { showToast((moved ? '已移动 ' + moved + ' 个文件' : '') + (failed ? '，' + failed + ' 个失败' : ''), moved > 0 ? 'success' : 'error'); loadFiles(); }
      else showToast('无文件需要移动', 'info');
    }

    async function batchDownloadSelected() {
      const names = checkedNames().map(function (n) { return decodeURIComponent(n); });
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      try {
        showToast('正在打包 ' + names.length + ' 个文件...', '');
        const resp = await fetch('/api/batch-download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers() },
          body: JSON.stringify({ filenames: names })
        });
        if (!resp.ok) throw new Error('Server error: ' + resp.status);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'sharetool_batch_' + Date.now() + '.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast('已下载 ' + names.length + ' 个文件', 'success');
      } catch (e) {
        showToast('下载失败: ' + e.message, 'error');
      }
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

    function getCurrentFolder() { return ''; } // ShareTool uses flat structure, no real folders

    // 新建文件夹 modal
    function openNewFolderModal() {
      var current = getCurrentFolder();
      document.getElementById('modalTitle').textContent = i18n.newFolder || '新建文件夹';
      document.getElementById('modalBody').innerHTML =
        '<div style="padding:8px 0">' +
          '<p style="color:var(--muted);font-size:13px;margin-bottom:12px">' +
            (current ? '在当前文件夹下创建: ' + escapeHtmlClient(current) : '在根目录创建') +
          '</p>' +
          '<input id="newFolderName" type="text" placeholder="文件夹名称" ' +
            'style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg2);color:var(--text);font-size:14px;box-sizing:border-box" ' +
            'onkeydown="if(event.key===\'Enter\')confirmNewFolder();if(event.key===\'Escape\')forceCloseModal()">' +
        '</div>';
      var modal = document.getElementById('modal');
      modal.querySelector('.modal-actions').innerHTML =
        '<button class="secondary" onclick="forceCloseModal()">' + (i18n.cancel || '取消') + '</button>' +
        '<button class="primary" onclick="confirmNewFolder()">' + (i18n.confirm || '确认') + '</button>';
      modal.classList.add('open');
      setTimeout(function() { document.getElementById('newFolderName').focus(); }, 50);
    }

    async function confirmNewFolder() {
      var input = document.getElementById('newFolderName');
      var name = input && input.value.trim();
      if (!name) { showToast('请输入文件夹名称', 'error'); return; }
      var current = getCurrentFolder();
      try {
        var body = { name: name };
        if (current) body.parent = current;
        var data = await request('/api/folders', { method: 'POST', body: JSON.stringify(body) });
        if (data.success) {
          showToast('已创建文件夹: ' + name, 'success');
          forceCloseModal();
          await loadFiles();
        } else {
          showToast(data.error || '创建失败', 'error');
        }
      } catch(e) { showToast('创建失败: ' + e.message, 'error'); }
    }

    // 批量重命名 modal
    function openBatchRenameModal() {
      const names = checkedNames().map(function(n) { return decodeURIComponent(n); });
      if (!names.length) { showToast('请先选择文件', 'error'); return; }

      const existingModal = document.getElementById('batchRenameModal');
      if (existingModal) existingModal.remove();

      const modal = document.createElement('div');
      modal.id = 'batchRenameModal';
      modal.className = 'modal open';
      modal.innerHTML = '\
        <div class="modal-content" style="max-width:600px">\
          <h3>批量重命名</h3>\
          <p style="color:var(--muted);font-size:13px;margin-bottom:12px">为 ' + names.length + ' 个文件重命名</p>\
          <div style="margin-bottom:10px">\
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">重命名规则</label>\
            <select id="batchRenameType" onchange="updateBatchRenamePreview()" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:var(--bg)">\
              <option value="prefix">添加前缀</option>\
              <option value="suffix">添加后缀</option>\
              <option value="replace">替换文本</option>\
              <option value="pattern">使用模式 {name}_{n}</option>\
            </select>\
          </div>\
          <div id="batchRenameFields"></div>\
          <div style="margin-bottom:12px">\
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">预览</label>\
            <div id="batchRenamePreview" style="max-height:200px;overflow:auto;background:var(--bg-secondary);border-radius:8px;padding:8px;font-size:12px;font-family:monospace"></div>\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'batchRenameModal\').remove()">取消</button>\
            <button onclick="confirmBatchRename()">确定重命名</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      window._batchRenameFiles = names;
      updateBatchRenamePreview();
    }

    function updateBatchRenamePreview() {
      const type = document.getElementById('batchRenameType').value;
      const fields = document.getElementById('batchRenameFields');
      const preview = document.getElementById('batchRenamePreview');
      const names = window._batchRenameFiles || [];

      let html = '';
      if (type === 'prefix') {
        fields.innerHTML = '<input id="batchRenamePrefix" type="text" placeholder="输入前缀" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px" oninput="updateBatchRenamePreview()">';
        const prefix = document.getElementById('batchRenamePrefix').value;
        names.forEach(function(n) { html += '<div>' + escapeHtmlClient(prefix + n) + '</div>'; });
      } else if (type === 'suffix') {
        fields.innerHTML = '<input id="batchRenameSuffix" type="text" placeholder="输入后缀（不含扩展名）" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px" oninput="updateBatchRenamePreview()">';
        const suffix = document.getElementById('batchRenameSuffix').value;
        names.forEach(function(n) {
          const lastDot = n.lastIndexOf('.');
          const base = lastDot > 0 ? n.slice(0, lastDot) : n;
          const ext = lastDot > 0 ? n.slice(lastDot) : '';
          html += '<div>' + escapeHtmlClient(base + suffix + ext) + '</div>';
        });
      } else if (type === 'replace') {
        fields.innerHTML = '<input id="batchRenameFrom" type="text" placeholder="要替换的文本" style="width:48%;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px;margin-right:4px" oninput="updateBatchRenamePreview()"><input id="batchRenameTo" type="text" placeholder="替换为" style="width:48%;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px" oninput="updateBatchRenamePreview()">';
        const from = (document.getElementById('batchRenameFrom') || {value:''}).value;
        const to = (document.getElementById('batchRenameTo') || {value:''}).value;
        names.forEach(function(n) { html += '<div>' + escapeHtmlClient(from ? n.replace(from, to) : n) + '</div>'; });
      } else if (type === 'pattern') {
        fields.innerHTML = '<input id="batchRenamePattern" type="text" placeholder="{name}_{n}，支持 {name} {ext} {n} {n2} {n3} {date}" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px" oninput="updateBatchRenamePreview()">';
        const pattern = (document.getElementById('batchRenamePattern') || {value:'{name}_{n}'}).value || '{name}_{n}';
        names.forEach(function(n, i) {
          const lastDot = n.lastIndexOf('.');
          const base = lastDot > 0 ? n.slice(0, lastDot) : n;
          const ext = lastDot > 0 ? n.slice(lastDot) : '';
          const pad = function(v, l) { return String(v).padStart(l, '0'); };
          const now = new Date();
          const dateStr = now.getFullYear() + pad(now.getMonth()+1,2) + pad(now.getDate(),2);
          let newName = pattern
            .replace(/\{name\}/g, base)
            .replace(/\{ext\}/g, ext)
            .replace(/\{n\}/g, String(i+1))
            .replace(/\{n2\}/g, pad(i+1, 2))
            .replace(/\{n3\}/g, pad(i+1, 3))
            .replace(/\{date\}/g, dateStr);
          html += '<div>' + escapeHtmlClient(newName) + '</div>';
        });
      }

      preview.innerHTML = html;
    }

    async function confirmBatchRename() {
      const type = document.getElementById('batchRenameType').value;
      const names = window._batchRenameFiles || [];
      const operations = [];

      if (type === 'prefix') {
        const prefix = document.getElementById('batchRenamePrefix').value;
        names.forEach(function(n) { operations.push({ oldFilename: n, newFilename: prefix + n }); });
      } else if (type === 'suffix') {
        names.forEach(function(n) {
          const lastDot = n.lastIndexOf('.');
          const base = lastDot > 0 ? n.slice(0, lastDot) : n;
          const ext = lastDot > 0 ? n.slice(lastDot) : '';
          operations.push({ oldFilename: n, newFilename: base + document.getElementById('batchRenameSuffix').value + ext });
        });
      } else if (type === 'replace') {
        const from = document.getElementById('batchRenameFrom').value;
        const to = document.getElementById('batchRenameTo').value;
        names.forEach(function(n) { operations.push({ oldFilename: n, newFilename: n.replace(from, to) }); });
      } else if (type === 'pattern') {
        const pattern = document.getElementById('batchRenamePattern').value || '{name}_{n}';
        names.forEach(function(n, i) {
          const lastDot = n.lastIndexOf('.');
          const base = lastDot > 0 ? n.slice(0, lastDot) : n;
          const ext = lastDot > 0 ? n.slice(lastDot) : '';
          const pad = function(v, l) { return String(v).padStart(l, '0'); };
          const now = new Date();
          const dateStr = now.getFullYear() + pad(now.getMonth()+1,2) + pad(now.getDate(),2);
          const newName = pattern
            .replace(/\{name\}/g, base)
            .replace(/\{ext\}/g, ext)
            .replace(/\{n\}/g, String(i+1))
            .replace(/\{n2\}/g, pad(i+1, 2))
            .replace(/\{n3\}/g, pad(i+1, 3))
            .replace(/\{date\}/g, dateStr);
          operations.push({ oldFilename: n, newFilename: newName });
        });
      }

      // 过滤无变化的
      const toRename = operations.filter(function(op) { return op.oldFilename !== op.newFilename; });
      if (toRename.length === 0) {
        showToast('没有需要重命名的文件', 'info');
        return;
      }

      try {
        const res = await fetch('/api/file-rename-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...Object.fromEntries(Object.entries(headers())) },
          body: JSON.stringify({ operations: toRename })
        });
        const data = await res.json();
        if (data.success) {
          showToast('已重命名 ' + data.renamed + ' 个文件', 'success');
          if (data.errors && data.errors.length) {
            showToast(data.errors.length + ' 个文件重命名失败', 'error');
          }
          document.getElementById('batchRenameModal').remove();
          clearSelection();
          loadFiles();
        } else {
          showToast(data.error || '重命名失败', 'error');
        }
      } catch(e) {
        showToast('重命名失败: ' + e.message, 'error');
      }
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

      // Full-screen drop overlay (shown when dragging files anywhere over the page)
      var globalDropOverlay = null;
      function showGlobalDropOverlay() {
        if (globalDropOverlay) return;
        globalDropOverlay = document.createElement('div');
        globalDropOverlay.id = 'globalDropOverlay';
        globalDropOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(16,185,129,0.12);border:4px dashed #10b981;z-index:9999;display:flex;align-items:center;justify-content:center;pointer-events:none;font-size:28px;font-weight:bold;color:#10b981;border-radius:16px;margin:16px';
        globalDropOverlay.textContent = '📥 释放文件以上传';
        document.body.appendChild(globalDropOverlay);
      }
      function hideGlobalDropOverlay() {
        if (!globalDropOverlay) return;
        globalDropOverlay.remove();
        globalDropOverlay = null;
      }

      ['dragenter', 'dragover'].forEach(function (evt) {
        dropZone.addEventListener(evt, function (e) {
          e.preventDefault();
          dropZone.classList.add('dragover');
        });
        // Also show global overlay for page-level drag
        document.addEventListener(evt, function (e) {
          if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
            showGlobalDropOverlay();
          }
        });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        dropZone.addEventListener(evt, function (e) {
          e.preventDefault();
          dropZone.classList.remove('dragover');
        });
      });
      // Hide global overlay on drop or when leaving window
      document.addEventListener('dragleave', function (e) {
        if (e.target === document.documentElement) hideGlobalDropOverlay();
      });
      document.addEventListener('drop', function (e) {
        hideGlobalDropOverlay();
        var files = e.dataTransfer.files;
        if (files.length) {
          document.getElementById('fileInput').files = files;
          handleFileSelect(files);
        }
      });
    }

    // ============================================================
    // Upload Queue Manager
    // ============================================================
    var uploadQueue = [];
    var uploadActive = 0;
    var uploadPaused = false;
    var MAX_CONCURRENT = 2;
    var uploadingFiles = new Map(); // fileName -> { xhr, status }

    function getAuthHeader() {
      return 'Bearer ' + (localStorage.getItem('st_auth_token') || STATIC_TOKEN);
    }

    function renderUploadQueuePanel() {
      var panel = document.getElementById('uploadQueuePanel');
      if (!panel) return;
      if (uploadQueue.length === 0) {
        panel.style.display = 'none';
        return;
      }
      panel.style.display = 'block';
      var done = uploadQueue.filter(function(f) { return f.status === 'done' || f.status === 'failed'; }).length;
      var total = uploadQueue.length;
      panel.querySelector('.uq-title').textContent = '上传队列 ' + done + '/' + total;

      var list = panel.querySelector('.uq-list');
      list.innerHTML = uploadQueue.map(function(item, i) {
        var color = item.status === 'done' ? '#22c55e' : item.status === 'failed' ? '#ef4444' : item.status === 'paused' ? '#f59e0b' : '#3b82f6';
        var icon = item.status === 'done' ? '✓' : item.status === 'failed' ? '✗' : item.status === 'paused' ? '⏸' : '↑';
        var canRetry = item.status === 'failed';
        var canPause = item.status === 'uploading';
        var canResume = item.status === 'paused';
        var canCancel = item.status === 'pending' || item.status === 'uploading' || item.status === 'paused';
        var actions = '';
        if (canRetry) actions += '<button class="uq-btn uq-retry" data-i="' + i + '" title="重试">↻</button>';
        if (canPause) actions += '<button class="uq-btn uq-pause" data-i="' + i + '" title="暂停">⏸</button>';
        if (canResume) actions += '<button class="uq-btn uq-resume" data-i="' + i + '" title="继续">▶</button>';
        if (canCancel) actions += '<button class="uq-btn uq-cancel" data-i="' + i + '" title="取消">✕</button>';
        return '<div class="uq-item" data-i="' + i + '" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">' +
          '<span style="color:' + color + ';font-size:14px;width:18px;text-align:center">' + icon + '</span>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + escapeHtmlClient(item.name) + '">' + escapeHtmlClient(item.name) + '</div>' +
            '<div class="uq-bar" style="height:3px;background:var(--line);border-radius:2px;margin-top:3px;overflow:hidden">' +
              '<div class="uq-fill" style="height:100%;width:' + (item.pct || 0) + '%;background:' + color + ';transition:width .2s"></div>' +
            '</div>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted);min-width:60px;text-align:right;white-space:nowrap">' + (item.pct || 0) + '%' + (item.speed ? ' <span style="color:var(--text-muted)">' + item.speed + '</span>' : '') + '</div>' +
          '<div style="display:flex;gap:4px">' + actions + '</div>' +
        '</div>';
      }).join('');

      // Bind action buttons
      list.querySelectorAll('.uq-retry').forEach(function(btn) {
        btn.addEventListener('click', function() { retryUploadItem(parseInt(btn.dataset.i, 10)); });
      });
      list.querySelectorAll('.uq-pause').forEach(function(btn) {
        btn.addEventListener('click', function() { pauseUploadItem(parseInt(btn.dataset.i, 10)); });
      });
      list.querySelectorAll('.uq-resume').forEach(function(btn) {
        btn.addEventListener('click', function() { resumeUploadItem(parseInt(btn.dataset.i, 10)); });
      });
      list.querySelectorAll('.uq-cancel').forEach(function(btn) {
        btn.addEventListener('click', function() { cancelUploadItem(parseInt(btn.dataset.i, 10)); });
      });
    }

    function updateQueueItem(i, updates) {
      Object.assign(uploadQueue[i], updates);
      renderUploadQueuePanel();
    }

    function retryUploadItem(i) {
      var item = uploadQueue[i];
      if (item.status !== 'failed') return;
      item.status = 'pending';
      item.pct = 0;
      item.retries = (item.retries || 0) + 1;
      renderUploadQueuePanel();
      processUploadQueue();
    }

    function pauseUploadItem(i) {
      var item = uploadQueue[i];
      if (item.status !== 'uploading') return;
      item.status = 'paused';
      if (item.xhr) { item.xhr.abort(); item.xhr = null; }
      uploadActive--;
      renderUploadQueuePanel();
      processUploadQueue();
    }

    function resumeUploadItem(i) {
      var item = uploadQueue[i];
      if (item.status !== 'paused') return;
      item.status = 'pending';
      renderUploadQueuePanel();
      processUploadQueue();
    }

    function cancelUploadItem(i) {
      var item = uploadQueue[i];
      if (item.xhr) { item.xhr.abort(); item.xhr = null; }
      uploadQueue.splice(i, 1);
      if (item.status === 'uploading') uploadActive--;
      renderUploadQueuePanel();
      processUploadQueue();
    }

    function uploadItem(item) {
      return new Promise(function(resolve, reject) {
        item.status = 'uploading';
        updateQueueItem(uploadQueue.indexOf(item), { status: 'uploading' });

        var reader = new FileReader();
        reader.onload = function(e) {
          var content = e.target.result;
          if (content.startsWith('data:')) content = content.split(',')[1] || '';
          var payload = JSON.stringify({ filename: item.name, content: content, type: 'file' });
          var blob = new Blob([payload], { type: 'application/json' });

          var xhr = new XMLHttpRequest();
          item.xhr = xhr;
          xhr.open('POST', '/api/upload', true);
          xhr.setRequestHeader('Authorization', getAuthHeader());
          xhr.setRequestHeader('Content-Type', 'application/json');

          xhr.upload.onprogress = function(ev) {
            if (ev.lengthComputable) {
              var pct = Math.round((ev.loaded / ev.total) * 100);
              var now = Date.now();
              if (!item._lastLoaded || !item._lastTime) {
                item._lastLoaded = ev.loaded;
                item._lastTime = now;
              }
              var elapsed = (now - item._lastTime) / 1000;
              var bytesDelta = ev.loaded - item._lastLoaded;
              var speed = elapsed > 0 ? Math.round(bytesDelta / elapsed) : 0;
              item._lastLoaded = ev.loaded;
              item._lastTime = now;
              var speedStr = speed > 0 ? formatSpeed(speed) : '';
              updateQueueItem(uploadQueue.indexOf(item), { pct: pct, speed: speedStr });
              status('上传中 ' + item.name + ' ' + pct + '%' + (speedStr ? ' ' + speedStr : ''));
            }
          };

          xhr.onload = function() {
            item.xhr = null;
            uploadActive--;
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                var data = JSON.parse(xhr.responseText);
                if (data.success) {
                  updateQueueItem(uploadQueue.indexOf(item), { status: 'done', pct: 100 });
                  resolve(data);
                } else {
                  updateQueueItem(uploadQueue.indexOf(item), { status: 'failed' });
                  reject(new Error(data.error || '上传失败'));
                }
              } catch (e) {
                updateQueueItem(uploadQueue.indexOf(item), { status: 'failed' });
                reject(new Error('上传失败'));
              }
            } else {
              updateQueueItem(uploadQueue.indexOf(item), { status: 'failed' });
              reject(new Error('HTTP ' + xhr.status));
            }
            processUploadQueue();
          };

          xhr.onerror = function() {
            item.xhr = null;
            uploadActive--;
            updateQueueItem(uploadQueue.indexOf(item), { status: 'failed' });
            reject(new Error('网络错误'));
            processUploadQueue();
          };

          xhr.onabort = function() {
            item.xhr = null;
          };

          xhr.send(blob);
        };
        reader.readAsDataURL(item.file);
      });
    }

    function processUploadQueue() {
      if (uploadPaused) return;
      while (uploadActive < MAX_CONCURRENT) {
        var next = uploadQueue.findIndex(function(f) { return f.status === 'pending'; });
        if (next === -1) break;
        uploadActive++;
        var item = uploadQueue[next];
        uploadItem(item).then(function() {
          updateQueueItem(next, { status: 'done', pct: 100 });
        }).catch(function() {
          // already handled in uploadItem
        });
      }
      renderUploadQueuePanel();
    }

    async function uploadFiles() {
      const input = document.getElementById('fileInput');
      const files = Array.from(input.files || []);
      if (!files.length) {
        showToast('请先选择文件', 'error');
        return;
      }

      // Add to queue
      files.forEach(function(file) {
        uploadQueue.push({ name: file.name, file: file, status: 'pending', pct: 0 });
      });
      renderUploadQueuePanel();
      input.value = '';
      clearFileInput();
      status('上传队列已添加 ' + files.length + ' 个文件');
      processUploadQueue();

      // Watch for completion
      var checkDone = setInterval(function() {
        var allDone = uploadQueue.every(function(f) { return f.status === 'done' || f.status === 'failed'; });
        if (allDone) {
          clearInterval(checkDone);
          var failed = uploadQueue.filter(function(f) { return f.status === 'failed'; }).length;
          if (failed === 0) {
            status('上传完成');
          } else {
            status(failed + ' 个文件上传失败，可重试', 'error');
          }
          uploadQueue = [];
          renderUploadQueuePanel();
          loadFiles();
          loadStorageStats();
        }
      }, 500);
    }

    function uploadSingleFile(file) {
      return new Promise(function(resolve, reject) {
        var xhr = new XMLHttpRequest();
        var reader = new FileReader();

        reader.onload = function(e) {
          var content = e.target.result;
          // If it's base64, extract the data part
          if (content.startsWith('data:')) {
            content = content.split(',')[1] || '';
          }

          var payload = JSON.stringify({ filename: file.name, content: content, type: 'file' });
          var blob = new Blob([payload], { type: 'application/json' });

          xhr.open('POST', '/api/upload', true);
          xhr.setRequestHeader('Authorization', 'Bearer ' + (localStorage.getItem('st_auth_token') || STATIC_TOKEN));
          xhr.setRequestHeader('Content-Type', 'application/json');

          // Upload progress - update file-level progress
          xhr.upload.onprogress = function(ev) {
            if (ev.lengthComputable) {
              var pct = Math.round((ev.loaded / ev.total) * 100);
              var fp = document.getElementById('fileProgressBar');
              if (fp) fp.style.width = pct + '%';
              status('上传中 ' + file.name + ' ' + pct + '%');
            }
          };

          xhr.onload = function() {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                var data = JSON.parse(xhr.responseText);
                if (data.success) {
                  resolve(data);
                } else {
                  reject(new Error(data.error || '上传失败'));
                }
              } catch (e) {
                reject(new Error('上传失败'));
              }
            } else {
              reject(new Error('HTTP ' + xhr.status));
            }
          };

          xhr.onerror = function() { reject(new Error('网络错误')); };
          xhr.send(blob);
        };

        reader.onerror = function() { reject(new Error('读取文件失败')); };
        reader.readAsDataURL(file);
      });
    }

    var currentOffset = 0;
    var currentTotal = 0;
    var currentPageLimit = 500;
    var isAppending = false;

    async function loadFiles() {
      if (currentVirtualFolderId !== null) {
        currentVirtualFolderId = null;
        document.getElementById('vfBackBtn').style.display = 'none';
      }
      clearNavHighlight();
      lastClickedIndex = -1;  // reset shift-click anchor on file list change
      currentOffset = 0;
      const q = document.getElementById('searchInput').value.trim();
      currentSearchQuery = q;  // expose for highlight in render
      const selectedTag = (document.getElementById('tagFilterSelect') || {}).value || '';
      const sortParam = 'sort=' + encodeURIComponent(currentSort) + '&order=' + encodeURIComponent(currentOrder);
      const tagParam = selectedTag ? '&tags=' + encodeURIComponent(selectedTag) : '';
      const typeParam = currentTypeFilter ? '&type=' + encodeURIComponent(currentTypeFilter) : '';
      const url = q ? '/api/search?q=' + encodeURIComponent(q) + '&' + sortParam + tagParam + typeParam : '/api/list?' + sortParam + tagParam + typeParam;
      await loadFilesFromUrl(url, false);
    }

    async function loadFilesFromUrl(url, append) {
      const sentinel = document.getElementById('scrollSentinel');
      const loading = document.getElementById('scrollLoading');
      if (append) {
        loading.style.display = 'block';
      }
      // Only fetch tags on first load, not on append/pagination
      const [data, tagData] = append
        ? [await request(url), null]
        : await Promise.all([request(url), request('/api/tags')]);
      const incoming = (data.files || []).map(function(f, i) { f._index = currentOffset + i; return f; });
      currentTotal = data.total || 0;
      const prevLen = currentFiles.length;
      if (append) {
        currentFiles = currentFiles.concat(incoming);
      } else {
        currentFiles = incoming;
      }
      currentOffset = currentFiles.length;
      const tagColorMap = {};
      if (tagData && tagData.tags) {
        tagData.tags.forEach(function(t) { tagColorMap[t.tag] = t.color || '#e0e7ff'; });
        updateTagFilterOptions(tagData.tags);
        renderTagQuickBar(tagData);
      }
      if (append && prevLen > 0) {
        // Incremental append: only render new rows, don't re-render existing DOM
        appendFileRows(incoming, tagColorMap);
      } else {
        renderFiles(tagColorMap);
      }
      loading.style.display = 'none';
      // Hide sentinel if no more files
      if (sentinel) sentinel.style.display = currentOffset >= currentTotal ? 'none' : 'block';
    }

    async function loadMoreFiles() {
      if (isAppending) return;
      if (currentOffset >= currentTotal) return;
      isAppending = true;
      const q = document.getElementById('searchInput').value.trim();
      const selectedTag = (document.getElementById('tagFilterSelect') || {}).value || '';
      const sortParam = 'sort=' + encodeURIComponent(currentSort) + '&order=' + encodeURIComponent(currentOrder);
      const tagParam = selectedTag ? '&tags=' + encodeURIComponent(selectedTag) : '';
      const typeParam = currentTypeFilter ? '&type=' + encodeURIComponent(currentTypeFilter) : '';
      const baseUrl = q ? '/api/search?q=' + encodeURIComponent(q) + '&' + sortParam + tagParam + typeParam : '/api/list?' + sortParam + tagParam + typeParam;
      const url = baseUrl + '&offset=' + currentOffset + '&limit=' + currentPageLimit;
      await loadFilesFromUrl(url, true);
      isAppending = false;
    }

    // Infinite scroll via IntersectionObserver
    function setupInfiniteScroll() {
      var sentinel = document.getElementById('scrollSentinel');
      if (!sentinel) return;
      if (!('IntersectionObserver' in window)) {
        sentinel.style.display = 'none';
        return;
      }
      var observer = new IntersectionObserver(function(entries) {
        if (entries[0].isIntersecting) {
          loadMoreFiles();
        }
      }, { rootMargin: '200px' });
      observer.observe(sentinel);
    }

    function updateTagFilterOptions(tags) {
      const sel = document.getElementById('tagFilterSelect');
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">全部标签</option>' +
        tags.map(function(t) {
          return '<option value="' + escapeHtmlClient(t.tag) + '"' + (t.tag === current ? ' selected' : '') + '>' +
            escapeHtmlClient(t.tag) + ' (' + t.count + ')</option>';
        }).join('');
      sel.value = current;
    }

    function filterByTag() {
      loadFiles();
    }

    function clearTagFilter() {
      const sel = document.getElementById('tagFilterSelect');
      if (sel) sel.value = '';
      loadFiles();
    }

    // 点击文件列表中的标签 chip 进行筛选
    function filterBySingleTag(tag) {
      const sel = document.getElementById('tagFilterSelect');
      if (sel) {
        sel.value = tag;
        loadFiles();
      }
    }

    // 标签快速访问栏：显示所有标签，点击直接筛选
    function renderTagQuickBar(tagData) {
      const bar = document.getElementById('tagQuickBar');
      if (!bar) return;
      const tags = tagData.tags || [];
      const activeTag = (document.getElementById('tagFilterSelect') || {}).value || '';
      if (!tags.length) { bar.style.display = 'none'; return; }
      // 显示最多8个，按使用频率排序
      const top = tags.slice(0, 8);
      var inner = '<div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 0;align-items:center">';
      if (activeTag) {
        var activeColor = '#e0e7ff';
        for (var i = 0; i < tags.length; i++) { if (tags[i].tag === activeTag) { activeColor = tags[i].color || '#e0e7ff'; break; } }
        inner += '<span style="font-size:11px;color:var(--muted);margin-right:4px">标签筛选:</span>';
        inner += '<span class="tag-badge" style="background:' + activeColor + ';font-size:11px;padding:3px 10px;border-radius:999px;font-weight:500;color:inherit">' + escapeHtmlClient(activeTag) + ' <span style="opacity:.7">×</span></span>';
        inner += '<button onclick="clearTagFilter()" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--muted);padding:2px 6px;border-radius:4px" title="清除筛选">✕清除</button>';
        inner += '<div style="width:1px;height:16px;background:var(--line);margin:0 4px"></div>';
      }
      inner += top.map(function(t) {
        if (t.tag === activeTag) return ''; // skip active tag
        var tc = t.color || '#e0e7ff';
        var escaped = escapeHtmlClient(t.tag);
        return '<span class="tag-badge" style="background:' + tc + ';font-size:11px;padding:3px 10px;border-radius:999px;font-weight:500;cursor:pointer;color:inherit" onclick="filterBySingleTag(\'' + escaped.replace(/'/g, "\\'") + '\')" title="筛选: ' + escaped + '">' + escaped + ' <span style="opacity:.7">' + t.count + '</span></span>';
      }).join('');
      inner += '</div>';
      bar.innerHTML = inner;
      bar.style.display = 'block';
    }

    var currentVirtualFolderId = null;

    async function toggleVirtualFolderMenu() {
      const menu = document.getElementById('vfMenu');
      if (menu.style.display === 'none') {
        await loadVirtualFolderMenu();
        menu.style.display = 'block';
        document.addEventListener('click', closeVfMenuOnClickOutside, { once: true });
      } else {
        menu.style.display = 'none';
      }
    }

    function closeVfMenuOnClickOutside(e) {
      const menu = document.getElementById('vfMenu');
      const btn = document.getElementById('vfBtn');
      if (!menu.contains(e.target) && !btn.contains(e.target)) {
        menu.style.display = 'none';
      }
    }

    async function loadVirtualFolderMenu() {
      const res = await fetch('/api/virtual-folders', { headers: headers() });
      const data = await res.json();
      const list = document.getElementById('vfMenuList');
      if (!data.folders || data.folders.length === 0) {
        list.innerHTML = '<div style="padding:8px 14px;color:var(--muted);font-size:12px">暂无收藏夹</div>';
        return;
      }
      list.innerHTML = data.folders.map(f =>
        '<div class="ctx-item" onclick="navigateVirtualFolder(' + f.id + ')" style="cursor:pointer">' +
          '<span style="color:' + escapeHtmlClient(f.color || '#667eea') + '">●</span> ' +
          escapeHtmlClient(f.name) + ' <span style="color:var(--muted);font-size:11px">(' + f.file_count + ')</span>' +
        '</div>'
      ).join('');
    }

    async function navigateVirtualFolder(folderId) {
      currentVirtualFolderId = folderId;
      document.getElementById('vfMenu').style.display = 'none';
      document.getElementById('vfBackBtn').style.display = 'inline-block';
      clearNavHighlight();
      const res = await fetch('/api/virtual-folders/' + folderId + '/files', { headers: headers() });
      const data = await res.json();
      const files = data.files || [];
      currentFiles = files.map(function(f, i) { f._index = i; return f; });
      currentOffset = files.length;
      currentTotal = files.length;
      const tagColorMap = {};
      updateTagFilterOptions([]);
      const gridBody = document.getElementById('fileTableGrid');
      const listBody = document.getElementById('fileTableBody');
      if (gridBody) gridBody.innerHTML = '';
      if (listBody) listBody.innerHTML = '';
      const countEl = document.getElementById('fileCountDisplay');
      if (countEl) countEl.innerHTML = '共 <strong>' + files.length + '</strong> 个文件（收藏夹）';
      const selEl = document.getElementById('selectedCountDisplay');
      if (selEl) selEl.style.display = 'none';
      renderFiles(tagColorMap);
      showToast('已切换到收藏夹视图', 'info');
    }

    async function openVirtualFolderManager() {
      document.getElementById('vfMenu').style.display = 'none';
      const res = await fetch('/api/virtual-folders', { headers: headers() });
      const data = await res.json();
      const folders = data.folders || [];
      const body = '<div style="display:flex;flex-direction:column;gap:12px">' +
        '<div id="vfList" style="max-height:300px;overflow-y:auto">' +
        (folders.length === 0 ? '<div style="color:var(--muted);text-align:center;padding:20px">暂无收藏夹</div>' :
          folders.map(f => '<div style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;background:var(--bg-tertiary);margin-bottom:6px">' +
            '<span style="color:' + escapeHtmlClient(f.color || '#667eea') + ';font-size:16px">●</span>' +
            '<span style="flex:1;font-size:13px">' + escapeHtmlClient(f.name) + ' <span style="color:var(--muted);font-size:11px">(' + f.file_count + ')</span></span>' +
            '<button class="ghost" style="font-size:11px;padding:3px 8px" onclick="deleteVirtualFolder(' + f.id + ')">删除</button>' +
          '</div>'
        ).join('')) +
        '</div>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<input id="vfNameInput" type="text" placeholder="新收藏夹名称" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text)">' +
          '<input id="vfColorInput" type="color" value="#667eea" style="width:36px;height:36px;border:none;cursor:pointer;border-radius:6px">' +
          '<button class="secondary" onclick="createVirtualFolder()">创建</button>' +
        '</div>' +
      '</div>';
      openModal('收藏夹管理', body, '');
    }

    async function createVirtualFolder() {
      const name = document.getElementById('vfNameInput').value.trim();
      const color = document.getElementById('vfColorInput').value;
      if (!name) return;
      await fetch('/api/virtual-folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color })
      });
      openVirtualFolderManager();
    }

    async function deleteVirtualFolder(id) {
      if (!confirm('确定删除此收藏夹？')) return;
      await fetch('/api/virtual-folders/' + id, { method: 'DELETE', headers: headers() });
      openVirtualFolderManager();
    }

    async function openAddToVirtualFolder(filename) {
      const file = currentFiles.find(f => f.name === filename || f.filename === filename);
      if (!file || !file.id) { showToast('文件不存在', 'error'); return; }
      const res = await fetch('/api/virtual-folders', { headers: headers() });
      const data = await res.json();
      const folders = data.folders || [];
      if (folders.length === 0) {
        showToast('请先创建收藏夹', 'error');
        return;
      }
      const body = '<div style="padding:8px 0">' +
        '<div style="margin-bottom:12px;color:var(--text-muted);font-size:12px">选择收藏夹添加到「' + escapeHtmlClient(filename) + '」：</div>' +
        folders.map(f => '<div class="ctx-item" onclick="addFileToVirtualFolder(' + f.id + ',' + file.id + ')" style="cursor:pointer;padding:10px 14px">' +
          '<span style="color:' + escapeHtmlClient(f.color || '#667eea') + '">●</span> ' + escapeHtmlClient(f.name) + ' <span style="color:var(--muted);font-size:11px">(' + f.file_count + ')</span>' +
        '</div>'
        ).join('') +
      '</div>';
      openModal('添加到收藏夹', body, '');
    }

    async function addFileToVirtualFolder(folderId, fileId) {
      closeModal();
      await fetch('/api/virtual-folders/' + folderId + '/files', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId })
      });
      showToast('已添加', 'info');
    }

    // Add selected files to virtual folder via context menu
    async function addSelectedToVirtualFolder(folderId) {
      const checked = Array.from(document.querySelectorAll('.file-check:checked'));
      for (const cb of checked) {
        const fileId = parseInt(cb.dataset.fileId, 10);
        if (fileId) {
          await fetch('/api/virtual-folders/' + folderId + '/files', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId })
          });
        }
      }
      showToast('已添加到收藏夹', 'info');
    }

    function exitVirtualFolder() {
      currentVirtualFolderId = null;
      document.getElementById('vfBackBtn').style.display = 'none';
      loadFiles();
    }

    // Append only new rows during infinite scroll — does not re-render existing DOM
    function appendFileRows(newFiles, tagColorMap) {
      if (!newFiles || !newFiles.length) return;
      if (currentView === 'grid') {
        var gridBody = document.getElementById('fileTableGrid');
        if (gridBody) {
          var frag = document.createDocumentFragment();
          newFiles.forEach(function(file) {
            frag.appendChild(stringToDOM(renderFileItem(file, tagColorMap, 'grid')));
          });
          gridBody.appendChild(frag);
        }
      } else {
        var listBody = document.getElementById('fileTableBody');
        if (listBody) {
          var frag = document.createDocumentFragment();
          newFiles.forEach(function(file) {
            frag.appendChild(stringToDOM(renderFileRow(file, tagColorMap)));
          });
          listBody.appendChild(frag);
        }
      }
    }

    function stringToDOM(html) {
      var t = document.createElement('div');
      t.innerHTML = html;
      return t.firstElementChild;
    }

    function renderFiles(tagColorMap) {
      const empty = document.getElementById('fileEmpty');
      const listBody = document.getElementById('fileTableBody');
      const gridBody = document.getElementById('fileTableGrid');
      // Update stats bar
      const countEl = document.getElementById('fileCountDisplay');
      if (countEl) {
        const total = currentFiles.length;
        const selected = document.querySelectorAll('.file-check:checked').length;
        const totalLabel = (currentSearchQuery && currentTotal > 0) ? currentTotal : total;
        const searchLabel = currentSearchQuery ? ' <span style="color:var(--accent);font-size:11px">搜索结果</span>' : '';
        countEl.innerHTML = '共 <strong>' + totalLabel + '</strong> 个文件' + searchLabel;
        // Update search results bar
        const resultsBar = document.getElementById('searchResultsBar');
        if (currentSearchQuery) {
          resultsBar.innerHTML = '<div>' +
            '找到 <strong>' + totalLabel + '</strong> 个匹配「<span style="color:var(--accent)">' + escapeHtmlClient(currentSearchQuery) + '</span>」的文件' +
            '</div>' +
            '<button onclick="clearSearchInput()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:4px 8px;border-radius:4px">✕ 清除搜索</button>';
          resultsBar.style.display = 'flex';
        } else {
          resultsBar.style.display = 'none';
        }
        const selEl = document.getElementById('selectedCountDisplay');
        if (selEl) {
          if (selected > 0) {
            selEl.style.display = 'inline';
            selEl.innerHTML = '，已选 <strong>' + selected + '</strong> 个';
          } else {
            selEl.style.display = 'none';
          }
        }
      }
      if (!currentFiles.length) {
        listBody.innerHTML = '';
        gridBody.innerHTML = '';
        let emptyIcon, emptyTitle, emptyHint;
        if (currentSearchQuery) {
          emptyIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M8 11h6"/></svg>';
          emptyTitle = '未找到匹配「' + escapeHtmlClient(currentSearchQuery) + '」的文件';
          emptyHint = '试试其他关键词，或清除筛选条件';
        } else {
          emptyIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>';
          emptyTitle = '还没有内容';
          emptyHint = '上传一个文件或创建文字，开始使用 ShareTool';
        }
        empty.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:40px 20px;color:var(--muted)">' +
          '<div style="opacity:0.4">' + emptyIcon + '</div>' +
          '<div style="font-size:15px;font-weight:500;color:var(--text-secondary)">' + emptyTitle + '</div>' +
          '<div style="font-size:13px;color:var(--text-muted)">' + emptyHint + '</div>' +
          '</div>';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';

      if (currentView === 'grid') {
        document.getElementById('fileTable').style.display = 'none';
        gridBody.style.display = 'block';
        gridBody.innerHTML = currentFiles.map(function(file) {
          return renderFileItem(file, tagColorMap, 'grid');
        }).join('');
      } else {
        document.getElementById('fileTable').style.display = 'table';
        gridBody.style.display = 'none';
        listBody.innerHTML = currentFiles.map(function(file) {
          return renderFileRow(file, tagColorMap);
        }).join('');
      }

      // Set up drag-and-drop for file reordering (list view only, sort by position)
      if (currentView !== 'grid' && currentSort === 'position') {
        setupFileDragDrop();
      }
    }

    var draggedIndex = null;
    var dragDropInitialized = false;

    function setupFileDragDrop() {
      if (dragDropInitialized) return; // Only set up once via delegation
      dragDropInitialized = true;
      var container = document.getElementById('fileTableBody');
      if (!container) return;
      container.addEventListener('dragstart', function(e) {
        var row = e.target.closest('tr[data-index]');
        if (!row) return;
        draggedIndex = parseInt(row.dataset.index, 10);
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedIndex);
      });
      container.addEventListener('dragend', function(e) {
        var row = e.target.closest('tr[data-index]');
        if (row) row.classList.remove('dragging');
        container.querySelectorAll('tr').forEach(function(r) { r.classList.remove('drag-over'); });
        draggedIndex = null;
      });
      container.addEventListener('dragover', function(e) {
        e.preventDefault();
        var row = e.target.closest('tr[data-index]');
        if (row && !row.classList.contains('dragging')) {
          row.classList.add('drag-over');
        }
      });
      container.addEventListener('dragleave', function(e) {
        var row = e.target.closest('tr[data-index]');
        if (row && !row.contains(e.relatedTarget)) {
          row.classList.remove('drag-over');
        }
      });
      container.addEventListener('drop', async function(e) {
        e.preventDefault();
        var row = e.target.closest('tr[data-index]');
        if (row) row.classList.remove('drag-over');
        if (!row) return;
        var targetIndex = parseInt(row.dataset.index, 10);
        if (draggedIndex === null || draggedIndex === targetIndex) return;
        var reordered = Array.from(currentFiles);
        var [moved] = reordered.splice(draggedIndex, 1);
        reordered.splice(targetIndex, 0, moved);
        var positions = reordered.map(function(f, i) {
          return { id: f.id, position: i };
        });
        try {
          await fetch('/api/file-positions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ positions })
          });
          currentSort = 'position';
          currentOrder = 'asc';
          loadFiles();
        } catch (err) {
          showToast('排序保存失败', 'error');
        }
      });
    }

    function renderFileRow(file, tagColorMap) {
      var tags = file.tags || '';
      var tagHtml = tags
        ? '<div class="file-tags">' + tags.split(',').filter(Boolean).map(function(t) {
            var tc = tagColorMap[t.trim()] || '#e0e7ff';
            return '<span class="tag-badge" style="background:' + tc + ';font-size:10px;padding:1px 6px;border-radius:10px;font-weight:500;margin-right:3px;display:inline-block;color:inherit">' + escapeHtmlClient(t.trim()) + '</span>';
          }).join('') + '</div>'
        : '<span class="muted" style="font-size:11px">—</span>';
      return '<tr data-index="' + file._index + '" data-filename="' + encodeURIComponent(file.name) + '" onmousedown="handleItemClick(event, ' + file._index + ')" ondblclick="if(!e.target.closest(\'.inline-rename-btn\') && !e.target.closest(\'.tag-edit-btn\') && !e.target.closest(\'.file-check\') && !e.target.closest(\'button\')) previewFile(' + JSON.stringify(file.name) + ')">' +
        '<td data-label=""><input class="file-check" type="checkbox" value="' + encodeURIComponent(file.name) + '" data-file-id="' + (file.id || '') + '" onchange="updateBatchBar()" onclick="lastClickedIndex=' + file._index + '"></td>' +
        '<td data-label="文件" class="filename-cell" data-filename="' + encodeURIComponent(file.name) + '"><span class="filename-text" ondblclick="startInlineRename(' + JSON.stringify(file.name) + ')">' + (currentSearchQuery ? highlightMatch(file.name, currentSearchQuery) : escapeHtmlClient(file.name)) + '</span><button class="inline-rename-btn" onclick="startInlineRename(' + JSON.stringify(file.name) + ')" title="重命名 (Enter保存/Esc取消)">✏️</button><div class="muted">' + formatFileType(file.type) + '</div></td>' +
        '<td data-label="标签">' + tagHtml + '<button class="tag-edit-btn" onclick="editFileTags(' + JSON.stringify(file.name) + ',' + JSON.stringify(tags) + ')">✎</button></td>' +
        '<td data-label="📌" style="color:var(--muted);cursor:default;text-align:center;font-size:16px" title="拖拽移动">⠿</td>' +
        '<td data-label="大小">' + formatBytes(file.size) + '</td>' +
        '<td data-label="更新时间">' + formatTime(file.updatedAt || file.createdAt) + '</td>' +
        '<td data-label="创建时间">' + formatTime(file.createdAt) + '</td>' +
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
            var tagVal = escapeHtmlClient(t.trim());
            return '<span class="tag-badge" style="background:' + tc + ';font-size:10px;padding:1px 6px;border-radius:10px;font-weight:500;margin-right:3px;display:inline-block;color:inherit;cursor:pointer" onclick="filterBySingleTag(\'' + tagVal.replace(/'/g, "\\'") + '\')" title="点击筛选此标签">' + tagVal + '</span>';
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

      return '<div class="file-item" data-index="' + file._index + '" data-filename="' + encodeURIComponent(file.name) + '" tabindex="0" draggable="true" onmousedown="handleItemClick(event, ' + file._index + ')" ondblclick="previewFile(' + JSON.stringify(file.name) + ')">' +
        '<input class="file-check file-check-row" type="checkbox" value="' + encodeURIComponent(file.name) + '" data-file-id="' + (file.id || '') + '" onchange="updateBatchBar()" onclick="lastClickedIndex=' + file._index + '">' +
        '<div class="file-content">' +
          gridIcon +
          '<div class="file-name"><span ondblclick="startInlineRename(' + JSON.stringify(file.name) + ')">' + (currentSearchQuery ? highlightMatch(file.name, currentSearchQuery) : escapeHtmlClient(file.name)) + '</span><button class="inline-rename-btn" onclick="startInlineRename(' + JSON.stringify(file.name) + ')" title="重命名 (Enter保存/Esc取消)">✏️</button></div>' +
          '<div class="file-meta">' + formatBytes(file.size) + ' · ' + formatTime(file.updatedAt || file.createdAt) + '</div>' +
          tagHtml +
        '</div>' +
        '<div class="file-actions">' +
          // Mobile: compact ⋮ menu (shown in grid mode on mobile via CSS)
          '<button class="mobile-more-btn" onclick=' + "'" + 'showMobileMenu(' + JSON.stringify(file.name) + ', event)' + "'" + ' title="更多操作" style="display:none">⋮</button>' +
          '<button class="btn secondary" onclick=' + "'" + 'previewFile(' + JSON.stringify(file.name) + ')' + "'" + '>查看</button>' +
          '<button class="btn secondary" onclick=' + "'" + 'downloadFile(' + JSON.stringify(file.name) + ')' + "'" + '>下载</button>' +
          '<button class="btn secondary" onclick=' + "'" + 'createShare(' + JSON.stringify(file.name) + ')' + "'" + '>分享</button>' +
          '<button class="btn danger" onclick=' + "'" + 'deleteFile(' + JSON.stringify(file.name) + ')' + "'" + '>删除</button>' +
        '</div>' +
      '</div>';
    }

    var currentView = localStorage.getItem('viewMode') || 'list';
    var currentSearchQuery = '';  // current search query for filename highlight

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
      // Only show for file rows (list view tr or grid view .file-item)
      var row = e.target.closest('tr');
      var checkbox = null;
      if (row) {
        checkbox = row.querySelector('.file-check');
      } else {
        var gridItem = e.target.closest('.file-item');
        if (gridItem) checkbox = gridItem.querySelector('.file-check');
      }
      if (!checkbox) return;
      e.preventDefault();
      ctxTarget = checkbox.value;
      var menu = document.getElementById('ctxMenu');
      var x = Math.min(e.clientX, window.innerWidth - 170);
      var y = Math.min(e.clientY, window.innerHeight - 220);
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      menu.style.display = 'block';
      // Init keyboard nav state for ctx menu
      ctxMenuNavIndex = -1;
      updateCtxMenuHighlight();
    });

    document.addEventListener('click', function(e) {
      var menu = document.getElementById('ctxMenu');
      if (!menu.contains(e.target)) menu.style.display = 'none';
    });

    // --- Context Menu Keyboard Navigation ---
    var ctxMenuNavIndex = -1;
    var ctxMenuItems = [];

    function updateCtxMenuHighlight() {
      ctxMenuItems = Array.from(document.querySelectorAll('#ctxMenu .ctx-item'));
      ctxMenuItems.forEach(function(item, i) {
        item.style.background = i === ctxMenuNavIndex ? 'var(--primary)' : '';
        item.style.color = i === ctxMenuNavIndex ? 'var(--text-inverse,#fff)' : '';
      });
    }

    function getCtxMenuVisibleItems() {
      return Array.from(document.querySelectorAll('#ctxMenu .ctx-item')).filter(function(item) {
        return item.style.display !== 'none' && !item.classList.contains('ctx-sep');
      });
    }

    // Mobile: long-press (500ms) on file row shows context menu
    var longPressTimer = null;
    document.addEventListener('touchstart', function(e) {
      var row = e.target.closest('tr');
      var checkbox = null;
      if (row) {
        checkbox = row.querySelector('.file-check');
      } else {
        var gridItem = e.target.closest('.file-item');
        if (gridItem) checkbox = gridItem.querySelector('.file-check');
      }
      if (!checkbox) return;
      longPressTimer = setTimeout(function() {
        e.preventDefault();
        ctxTarget = checkbox.value;
        var menu = document.getElementById('ctxMenu');
        var touch = e.touches[0];
        var x = Math.min(touch.clientX, window.innerWidth - 170);
        var y = Math.min(touch.clientY, window.innerHeight - 220);
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        menu.style.display = 'block';
      }, 500);
    }, { passive: false });
    document.addEventListener('touchend', function() { clearTimeout(longPressTimer); });
    document.addEventListener('touchmove', function() { clearTimeout(longPressTimer); });

    // Mobile: show context menu for grid items (triggered by ⋮ button)
    function showMobileMenu(filename, event) {
      event.stopPropagation();
      ctxTarget = filename;
      var menu = document.getElementById('ctxMenu');
      var x = Math.min(event.clientX, window.innerWidth - 170);
      var y = Math.min(event.clientY, window.innerHeight - 220);
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      menu.style.display = 'block';
      ctxMenuNavIndex = -1;
      updateCtxMenuHighlight();
    }

    // Context menu keyboard navigation
    document.addEventListener('keydown', function(e) {
      var menu = document.getElementById('ctxMenu');
      if (!menu || menu.style.display === 'none') return;
      var items = getCtxMenuVisibleItems();
      if (!items.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        ctxMenuNavIndex = Math.min(ctxMenuNavIndex + 1, items.length - 1);
        updateCtxMenuHighlight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        ctxMenuNavIndex = Math.max(ctxMenuNavIndex - 1, 0);
        updateCtxMenuHighlight();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (ctxMenuNavIndex >= 0 && ctxMenuNavIndex < items.length) {
          items[ctxMenuNavIndex].click();
        }
      } else if (e.key === 'Escape') {
        menu.style.display = 'none';
      }
    }, true); // Use capture to intercept before handleKeyboardNav

    // --- Drag-to-Reorder ---
    var draggedItem = null;
    var draggedIndex = -1;

    function getAllFileItems() {
      if (currentView === 'grid') {
        return Array.from(document.querySelectorAll('#fileTableGrid .file-item'));
      }
      return Array.from(document.querySelectorAll('#fileTableBody tr[data-index]'));
    }

    function getContainer() {
      return currentView === 'grid'
        ? document.getElementById('fileTableGrid')
        : document.getElementById('fileTableBody');
    }

    document.addEventListener('dragstart', function(e) {
      var item = e.target.closest('.file-item');
      if (!item) return;
      draggedItem = item;
      draggedIndex = parseInt(item.dataset.index);
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedIndex);
    });

    document.addEventListener('dragend', function(e) {
      var item = e.target.closest('.file-item');
      if (item) item.classList.remove('dragging');
      document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      draggedItem = null;
      draggedIndex = -1;
    });

    // Paste images/files from clipboard (Ctrl+V / Cmd+V)
    document.addEventListener('paste', function(e) {
      // Skip if focus is in an input/textarea
      var active = document.activeElement;
      var tag = active && active.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;

      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (!files.length) return;

      e.preventDefault();
      // Use existing fileInput + handleFileSelect flow
      var fi = document.getElementById('fileInput');
      if (!fi) return;
      // Create a DataTransfer to set files on the input
      var dt = new DataTransfer();
      files.forEach(function(f) { dt.items.add(f); });
      fi.files = dt.files;
      showToast('已粘贴 ' + files.length + ' 个文件，正在上传...', 'info');
      uploadFiles();
    });

    document.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var item = e.target.closest('.file-item');
      if (!item || item === draggedItem) return;
      document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      item.classList.add('drag-over');
    });

    document.addEventListener('dragleave', function(e) {
      var item = e.target.closest('.file-item');
      if (item && !item.contains(e.relatedTarget)) {
        item.classList.remove('drag-over');
      }
    });

    document.addEventListener('drop', function(e) {
      e.preventDefault();
      var targetItem = e.target.closest('.file-item');
      if (!targetItem || targetItem === draggedItem) return;
      targetItem.classList.remove('drag-over');

      var targetIndex = parseInt(targetItem.dataset.index);
      if (draggedIndex === targetIndex) return;

      // Reorder currentFiles array
      var moved = currentFiles.splice(draggedIndex, 1)[0];
      currentFiles.splice(targetIndex, 0, moved);

      // Re-render immediately for smooth UX
      renderFiles(tagColorMap);

      // Persist new positions to server
      var positions = currentFiles.map(function(file, idx) {
        return { id: file.id, position: idx };
      });
      saveFilePositions(positions);
    });

    async function saveFilePositions(positions) {
      try {
        await fetch('/api/file-positions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers() },
          body: JSON.stringify({ positions })
        });
      } catch (err) {
        console.error('saveFilePositions failed:', err);
      }
    }

    // --- Keyboard Navigation ---
    var keyboardNavIndex = -1;
    var gridColumns = 1;
    var lastClickedIndex = -1;  // for Shift+Click range select

    function getAllFileItems() {
      if (currentView === 'grid') {
        return document.querySelectorAll('#fileTableGrid .file-item');
      }
      return document.querySelectorAll('#fileTableBody tr[data-index]');
    }

    function updateGridColumns() {
      if (currentView !== 'grid') return;
      var grid = document.getElementById('fileTableGrid');
      if (!grid) return;
      var item = grid.querySelector('.file-item');
      if (!item) { gridColumns = 1; return; }
      var itemWidth = item.offsetWidth || 180;
      gridColumns = Math.max(1, Math.floor(grid.offsetWidth / itemWidth));
    }

    function clearNavHighlight() {
      getAllFileItems().forEach(function(el) { el.classList.remove('keyboard-nav'); });
      keyboardNavIndex = -1;
    }

    function applyNavHighlight(index) {
      var items = getAllFileItems();
      if (!items.length) return;
      keyboardNavIndex = Math.max(0, Math.min(index, items.length - 1));
      clearNavHighlight();
      var target = items[keyboardNavIndex];
      target.classList.add('keyboard-nav');
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function getFileAtIndex(index) {
      var items = getAllFileItems();
      if (!items.length || index < 0 || index >= items.length) return null;
      return items[index];
    }

    function getIndexFromItem(item) {
      return parseInt(item.getAttribute('data-index'), 10);
    }

    function handleKeyboardNav(e) {
      var tagInFocus = document.activeElement && document.activeElement.tagName;
      if (tagInFocus === 'INPUT' || tagInFocus === 'TEXTAREA') return;

      // Escape closes modal
      if (e.key === 'Escape') {
        var modal = document.getElementById('modal');
        if (modal && modal.classList.contains('open')) {
          modal.classList.remove('open');
          return;
        }
        var ctx = document.getElementById('ctxMenu');
        if (ctx) ctx.style.display = 'none';
        return;
      }

      var items = getAllFileItems();
      if (!items.length) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          updateGridColumns();
          applyNavHighlight(keyboardNavIndex + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          updateGridColumns();
          applyNavHighlight(keyboardNavIndex - 1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          updateGridColumns();
          if (gridColumns > 1) applyNavHighlight(keyboardNavIndex + gridColumns);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          updateGridColumns();
          if (gridColumns > 1) applyNavHighlight(keyboardNavIndex - gridColumns);
          break;
        case 'Enter': {
          e.preventDefault();
          if (keyboardNavIndex < 0) return;
          var item = getFileAtIndex(keyboardNavIndex);
          if (!item) return;
          var checkbox = item.querySelector('.file-check');
          if (checkbox) {
            var filename = decodeURIComponent(checkbox.value);
            previewFile(filename);
          }
          break;
        }
        case ' ': {
          // Space: toggle selection of current file (without opening)
          e.preventDefault();
          if (keyboardNavIndex < 0) return;
          var item = getFileAtIndex(keyboardNavIndex);
          if (!item) return;
          var checkbox = item.querySelector('.file-check');
          if (checkbox) {
            checkbox.checked = !checkbox.checked;
            updateBatchBar();
          }
          break;
        }
        function getSelectedFiles() { return checkedNames(); }
        case 'a': {
          if (e.ctrlKey || e.metaKey) return; // let browser select-all pass through
          // 'a' alone → select all files
          e.preventDefault();
          toggleAll(true);
          break;
        }
        case 'r': {
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          loadFiles();
          break;
        }
        case 's':
        case 'S': {
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          // Toggle star on selected files (or navigated file if none selected)
          var names = checkedNames();
          if (names.length === 0 && keyboardNavIndex >= 0) {
            var item = getFileAtIndex(keyboardNavIndex);
            if (item) names = [item.getAttribute('data-name')];
          }
          if (names.length === 0) { showToast('请先选择一个文件', 'error'); return; }
          // Check current star state to decide toggle direction
          var file = currentFiles.find(function(f) { return f.name === names[0]; });
          var newStarred = !file || !file.starred; // toggle: unstar if starred, star if not
          Promise.all(names.map(function(name) {
            return fetch('/api/files/' + encodeURIComponent(name), { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify({ starred: newStarred }) });
          })).then(function(results) {
            var successCount = results.filter(function(r) { return r.ok; }).length;
            var action = newStarred ? '标记' : '取消标记';
            showToast((successCount > 0 ? '已' : '') + action + successCount + '个文件', 'success');
            loadFiles();
          }).catch(function() { showToast('操作失败', 'error'); });
          break;
        }
        case 'b':
        case 'B': {
          // b: batch download selected files as zip
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          batchDownloadSelected();
          break;
        }
        case 'Delete': {
          // Delete: delete selected files
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          var selected = getSelectedFiles();
          if (!selected.length) return;
          e.preventDefault();
          if (selected.length === 1) {
            if (confirm(i18n.confirmDeleteMsg || '确定删除 ' + selected[0] + '？')) deleteFiles([selected[0]]);
          } else {
            if (confirm(i18n.confirmDeleteMulti || '确定删除选中的 ' + selected.length + ' 个文件？')) deleteFiles(selected);
          }
          break;
        }
        case 'v':
        case 'V': {
          // v: toggle list/grid view
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          setView(currentView === 'list' ? 'grid' : 'list');
          break;
        }
        case 'N': {
          // Shift+N: create new folder
          if (!e.shiftKey) break;
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          createNewFolder();
          break;
        }
        case 'e': {
          // e: rename selected file (inline edit)
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          var selected = getSelectedFiles();
          if (selected.length === 1) {
            e.preventDefault();
            startInlineRename(selected[0]);
          }
          break;
        }
        case 'l': {
          // l: copy share link of selected file
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          var selected = getSelectedFiles();
          if (selected.length === 1) {
            e.preventDefault();
            copyShareLink(selected[0]);
          }
          break;
        }
        case 'y': {
          // y: yank (copy) filename of selected file to clipboard
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          var selected = getSelectedFiles();
          if (selected.length === 1) {
            e.preventDefault();
            navigator.clipboard.writeText(selected[0]).then(function() {
              showToast('已复制文件名: ' + selected[0], 'success');
            }).catch(function() { showToast('复制失败', 'error'); });
          }
          break;
        }
        case 'j': {
          // j: vim-style down
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          updateGridColumns();
          applyNavHighlight(keyboardNavIndex + 1);
          break;
        }
        case 'k': {
          // k: vim-style up
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          updateGridColumns();
          applyNavHighlight(keyboardNavIndex - 1);
          break;
        }
        case 'g': {
          // g: go to top; Shift+G: go to bottom
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          if (e.shiftKey) {
            var items = getAllFileItems();
            if (items.length) {
              applyNavHighlight(items.length - 1);
              items[items.length - 1].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
          } else {
            applyNavHighlight(0);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
          break;
        }
        case 'G': {
          // G: go to bottom
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          var items = getAllFileItems();
          if (items.length) {
            applyNavHighlight(items.length - 1);
            items[items.length - 1].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
          break;
        }
        case '?': {
          // ?: show keyboard shortcuts help
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          openKeyboardHelp();
          break;
        }
        case 'd': {
          // d: toggle dark mode (cycle: light → dark → system)
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          var themeEl = document.getElementById('themeSelect');
          if (!themeEl) return;
          var current = themeEl.value;
          var next = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
          themeEl.value = next;
          setThemeMode(next);
          showToast('主题: ' + { light: '浅色', dark: '深色', system: '跟随系统' }[next], 'info');
          break;
        }
        case 'v': {
          // v: toggle grid/list view
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          var newView = currentView === 'grid' ? 'list' : 'grid';
          setView(newView);
          break;
        }
        case '/':
        case 'f':
        case 'F': {
          // / or f: focus search input
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          var si = document.getElementById('searchInput');
          if (si) { si.focus(); si.select(); }
          break;
        }
        case 't':
        case 'T': {
          // t: open trash
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          openTrash();
          break;
        }
        case 'u':
        case 'U': {
          // u: trigger file upload
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          var fi = document.getElementById('fileInput');
          if (fi) fi.click();
          break;
        }
        case '?': {
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          openKeyboardHelp();
          break;
        }
        case 'Escape':
          document.getElementById('ctxMenu').style.display = 'none';
          clearNavHighlight();
          // Close modal if open
          if (document.getElementById('modal').classList.contains('open')) {
            forceCloseModal();
          }
          break;
      }
    }

    document.addEventListener('keydown', function(e) {
      handleKeyboardNav(e);
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
        case 'copyName': await navigator.clipboard.writeText(filename); showToast('已复制文件名: ' + filename, 'success'); break;
        case 'copyPath': await navigator.clipboard.writeText('/' + filename); showToast('已复制文件路径', 'success'); break;
        case 'rename': startInlineRename(filename); break;
        case 'delete': if (confirm('确认删除 ' + filename + '？')) deleteFile(filename); break;
        case 'history': openVersionHistory(filename); break;
        case 'info': showFileInfo(filename); break;
        case 'addToVF': openAddToVirtualFolder(filename); break;
      }
    }

    async function openVersionHistory(filename) {
      const modalBody = document.getElementById('modalBody');
      document.getElementById('modalTitle').textContent = '版本历史: ' + escapeHtmlClient(filename);
      modalBody.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">加载中...</div>';
      document.getElementById('modal').classList.add('open');
      try {
        const encoded = encodeURIComponent(filename);
        const res = await fetch('/api/versions?filename=' + encoded, { headers: headers() });
        const data = await res.json();
        if (!data.success || !data.versions.length) {
          modalBody.innerHTML = '<p style="text-align:center;padding:40px;color:var(--text-muted)">暂无版本记录。文件修改时会自动保存版本。</p>';
          return;
        }
        const html = '<div style="max-height:60vh;overflow:auto">' +
          data.versions.map(v => {
            const date = new Date(v.created_at * 1000).toLocaleString('zh-CN');
            const size = formatSize ? formatSize(v.size) : v.size + ' B';
            const isCurrent = v.hash === data.currentHash;
            return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px">' +
              '<div style="flex:1">' +
                '<div style="color:var(--text)">' + date + (isCurrent ? ' <span style="background:var(--accent);color:#fff;font-size:10px;padding:1px 5px;border-radius:3px">当前</span>' : '') + '</div>' +
                '<div style="color:var(--text-muted);font-size:11px;margin-top:2px">' + size + ' · ' + escapeHtmlClient(v.hash ? v.hash.slice(0, 8) : '') + '</div>' +
              '</div>' +
              '<div style="display:flex;gap:6px">' +
                '<button class="btn-sm secondary" onclick="viewVersion(' + v.id + ')" style="padding:5px 12px;font-size:12px">预览</button>' +
                (!isCurrent ? '<button class="btn-sm primary" onclick="restoreVersion(' + v.id + ')" style="padding:5px 12px;font-size:12px">恢复</button>' : '') +
              '</div>' +
            '</div>';
          }).join('') + '</div>';
        modalBody.innerHTML = html;
        window._versionHistoryFilename = filename;
      } catch (e) {
        modalBody.innerHTML = '<p style="color:var(--danger);padding:20px;text-align:center">加载失败: ' + escapeHtmlClient(e.message) + '</p>';
      }
    }

    async function viewVersion(versionId) {
      const modalBody = document.getElementById('modalBody');
      modalBody.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">加载中...</div>';
      try {
        const res = await fetch('/api/versions/' + versionId, { headers: headers() });
        const data = await res.json();
        if (!data.success || !data.version) {
          modalBody.innerHTML = '<p class="muted">版本不存在</p>'; return;
        }
        const v = data.version;
        const ext = (v.filename || '').split('.').pop().toLowerCase();
        const langMap = { js:'javascript', ts:'typescript', py:'python', rb:'ruby', go:'go', rs:'rust', java:'java', md:'markdown', json:'json', css:'css', html:'html', htm:'html', sh:'bash', yaml:'yaml', yml:'yaml', xml:'xml', sql:'sql' };
        const lang = langMap[ext] || '';
        const isText = ['js','ts','py','rb','go','rs','java','md','json','css','html','htm','sh','yaml','yml','xml','sql'].includes(ext);
        if (isText && v.content) {
          const truncated = v.content.length > 500000;
          const display = truncated ? v.content.slice(0, 500000) : v.content;
          modalBody.innerHTML = '<div style="max-height:70vh;overflow:auto;background:var(--bg-secondary);border-radius:8px;padding:16px;font-family:monospace;font-size:13px;white-space:pre-wrap;word-break:break-all">' + escapeHtmlClient(display) + '</div>' + (truncated ? '<p style="color:var(--text-muted);font-size:12px;margin-top:8px;text-align:center">内容过长，已截断</p>' : '');
        } else if (v.content) {
          modalBody.innerHTML = '<p class="muted">此版本为非文本文件，请下载查看。</p><button class="btn secondary" onclick="downloadVersion(' + versionId + ')">下载此版本</button>';
        } else {
          modalBody.innerHTML = '<p class="muted">版本内容不可用</p>';
        }
      } catch (e) {
        modalBody.innerHTML = '<p class="muted">加载失败: ' + escapeHtmlClient(e.message) + '</p>';
      }
    }

    async function restoreVersion(versionId) {
      if (!confirm('确认恢复此版本？当前内容将保存为新版本。')) return;
      try {
        const res = await fetch('/api/versions/' + versionId + '/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (data.success) {
          showToast('版本已恢复', 'success');
          document.getElementById('modal').classList.remove('open');
          if (typeof loadFiles === 'function') loadFiles();
        } else {
          showToast('恢复失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('恢复失败: ' + e.message, 'error');
      }
    }

    async function showFileInfo(filename) {
      const modalBody = document.getElementById('modalBody');
      document.getElementById('modalTitle').textContent = '文件属性: ' + escapeHtmlClient(filename);
      modalBody.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">加载中...</div>';
      document.getElementById('modal').classList.add('open');

      try {
        const encoded = encodeURIComponent(filename);
        const res = await fetch('/api/file-info/' + encoded, { headers: headers() });
        const data = await res.json();
        if (!data.success || !data.file) {
          modalBody.innerHTML = '<p style="text-align:center;padding:40px;color:var(--text-muted)">加载失败</p>';
          return;
        }

        const f = data.file;
        const s = data.stats;
        const fmtSize = formatSize ? formatSize(f.size) : (f.size || 0) + ' B';
        const fmtDate = ts => ts ? new Date(ts).toLocaleString('zh-CN') : '--';
        const fmtTs = ts => ts ? new Date(ts).toLocaleString('zh-CN') : '--';

        const tagsHtml = f.tags
          ? f.tags.split(',').filter(Boolean).map(t => '<span style="background:var(--bg-tertiary);padding:2px 8px;border-radius:6px;font-size:11px;margin:2px;display:inline-block">' + escapeHtmlClient(t) + '</span>').join('')
          : '<span style="color:var(--text-muted);font-size:12px">无</span>';

        const accessRows = s.recentAccess && s.recentAccess.length
          ? s.recentAccess.map(a => {
              const actionLabels = { view: '👁 预览', download: '⬇ 下载' };
              return '<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)">' +
                '<span>' + (actionLabels[a.action] || a.action) + '</span>' +
                '<span style="color:var(--text-muted);font-family:monospace;font-size:10px">' + escapeHtmlClient(a.ip || '--') + '</span>' +
                '<span style="color:var(--text-muted);font-size:11px">' + fmtDate(a.timestamp) + '</span>' +
              '</div>';
            }).join('')
          : '<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:10px">暂无访问记录</div>';

        modalBody.innerHTML =
          '<div style="display:grid;gap:16px;font-size:13px">' +
            // 基本信息
            '<div style="background:var(--bg-secondary);border-radius:12px;padding:16px">' +
              '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">基本信息</div>' +
              '<div style="display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center">' +
                '<div style="color:var(--text-muted)">文件名</div><div style="word-break:break-all;font-weight:500">' + escapeHtmlClient(f.name) + '</div>' +
                '<div style="color:var(--text-muted)">类型</div><div>' + escapeHtmlClient(f.type || 'file') + '</div>' +
                '<div style="color:var(--text-muted)">大小</div><div>' + fmtSize + '</div>' +
                '<div style="color:var(--text-muted)">MIME</div><div style="font-family:monospace;font-size:12px;word-break:break-all">' + escapeHtmlClient(f.contentType || '--') + '</div>' +
                '<div style="color:var(--text-muted)">MD5</div><div style="font-family:monospace;font-size:12px;word-break:break-all;color:var(--text-muted)">' + escapeHtmlClient(f.hash || '--') + '</div>' +
                '<div style="color:var(--text-muted)">加密</div><div>' + (f.encrypted ? '🔒 是' : '否') + '</div>' +
                '<div style="color:var(--text-muted)">收藏</div><div>' + (f.starred ? '⭐ 是' : '否') + '</div>' +
              '</div>' +
            '</div>' +
            // 时间信息
            '<div style="background:var(--bg-secondary);border-radius:12px;padding:16px">' +
              '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">时间</div>' +
              '<div style="display:grid;grid-template-columns:80px 1fr;gap:8px">' +
                '<div style="color:var(--text-muted)">创建</div><div style="font-size:12px">' + fmtTs(f.createdAt) + '</div>' +
                '<div style="color:var(--text-muted)">修改</div><div style="font-size:12px">' + fmtTs(f.updatedAt) + '</div>' +
                '<div style="color:var(--text-muted)">最近访问</div><div style="font-size:12px">' + (s.lastAccess ? fmtTs(s.lastAccess) : '<span style="color:var(--text-muted)">从未</span>') + '</div>' +
              '</div>' +
            '</div>' +
            // 标签
            '<div style="background:var(--bg-secondary);border-radius:12px;padding:16px">' +
              '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">标签</div>' +
              '<div>' + tagsHtml + '</div>' +
            '</div>' +
            // 访问统计
            '<div style="background:var(--bg-secondary);border-radius:12px;padding:16px">' +
              '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">统计（近7天）</div>' +
              '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center;margin-bottom:12px">' +
                '<div><div style="font-size:20px;font-weight:600">' + (s.accessCount || 0) + '</div><div style="font-size:11px;color:var(--text-muted)">总访问</div></div>' +
                '<div><div style="font-size:20px;font-weight:600">' + (s.viewCount || 0) + '</div><div style="font-size:11px;color:var(--text-muted)">预览</div></div>' +
                '<div><div style="font-size:20px;font-weight:600">' + (s.downloadCount || 0) + '</div><div style="font-size:11px;color:var(--text-muted)">下载</div></div>' +
              '</div>' +
              '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">版本历史: ' + (s.versionCount || 0) + ' 个版本</div>' +
              '<div style="margin-top:8px">' +
                '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">最近访问</div>' +
                accessRows +
              '</div>' +
            '</div>' +
          '</div>';
      } catch (e) {
        modalBody.innerHTML = '<p style="color:var(--danger);padding:20px;text-align:center">加载失败: ' + escapeHtmlClient(e.message) + '</p>';
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
    var LS_KEY = 'sharetool_recent_searches';

    // 从 localStorage 恢复搜索历史（同步，立即可用）
    function loadFromLocal() {
      try {
        var raw = localStorage.getItem(LS_KEY);
        if (raw) recentSearchesCache = JSON.parse(raw);
      } catch (e) { recentSearchesCache = []; }
    }

    // 写入 localStorage（同步）
    function saveToLocal() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(recentSearchesCache));
      } catch (e) { /* quota or private mode */ }
    }

    async function loadRecentSearches() {
      // Step 1: 先从 localStorage 恢复（同步，立刻显示）
      loadFromLocal();
      renderRecentSearches();
      // Step 2: 后台从服务器拉取最新历史并合并
      try {
        const res = await fetch('/api/search/history?limit=' + MAX_RECENT_SEARCHES);
        const data = await res.json();
        var serverHistory = (data.history || []).map(function (h) { return h.query; });
        // 合并：以服务器为准，去重
        if (serverHistory.length > 0) {
          recentSearchesCache = serverHistory.slice(0, MAX_RECENT_SEARCHES);
          saveToLocal();
          renderRecentSearches();
        }
      } catch (e) { /* offline — localStorage data already shown */ }
    }

    function getRecentSearches() {
      return recentSearchesCache;
    }

    async function saveRecentSearch(query) {
      var q = query.trim();
      if (!q) return;
      // 更新本地缓存并持久化（立刻生效）
      recentSearchesCache = recentSearchesCache.filter(function (s) { return s !== q; });
      recentSearchesCache.unshift(q);
      if (recentSearchesCache.length > MAX_RECENT_SEARCHES) recentSearchesCache = recentSearchesCache.slice(0, MAX_RECENT_SEARCHES);
      saveToLocal();
      renderRecentSearches();
      // 异步同步到服务器
      try {
        await fetch('/api/search/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
      } catch (e) { /* offline — localStorage already saved */ }
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
        return '<span class="recent-search-tag" onclick="applyRecentSearch(' + JSON.stringify(s) + ')">' +
          escapeHtmlClient(s) +
          '<span class="delete-btn" onclick="event.stopPropagation();deleteRecentSearch(' + JSON.stringify(s) + ')">✕</span></span>';
      }).join('') + '<span class="recent-search-tag" style="color:var(--muted)" onclick="clearRecentSearches()">清除全部</span>';
    }

    function applyRecentSearch(query) {
      document.getElementById('searchInput').value = query;
      searchFiles();
    }

    async function clearRecentSearches() {
      recentSearchesCache = [];
      saveToLocal();
      renderRecentSearches();
      try {
        await fetch('/api/search/history', { method: 'DELETE' });
      } catch (e) { /* offline */ }
    }

    async function deleteRecentSearch(query) {
      recentSearchesCache = recentSearchesCache.filter(function (s) { return s !== query; });
      saveToLocal();
      renderRecentSearches();
      try {
        await fetch('/api/search/history?query=' + encodeURIComponent(query), { method: 'DELETE' });
      } catch (e) { /* offline */ }
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
      // "/" focuses search (not in input/textarea)
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        document.getElementById('searchInput').focus();
      }
      // Escape clears search and closes modals
      if (e.key === 'Escape') {
        const searchInput = document.getElementById('searchInput');
        if (searchInput && searchInput.value.trim()) {
          searchInput.value = '';
          searchFiles();
        }
        closeModal();
      }
    });

    async function previewFile(filename) {
      const modalBody = document.getElementById('modalBody');
      document.getElementById('modalTitle').textContent = filename;
      modalBody.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">加载中...</div>';
      document.getElementById('modal').classList.add('open');

      let data;
      try {
        const resp = await fetch('/api/content/' + encodeURIComponent(filename), { headers: headers() });
        // Large text files return plain text directly (not JSON)
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.startsWith('text/plain')) {
          const text = await resp.text();
          const origSize = parseInt(resp.headers.get('x-preview-original-size') || '0', 10);
          renderTextPreview(filename, text, origSize, true);
          return;
        }
        data = await resp.json();
      } catch (e) {
        modalBody.innerHTML = '<p class="muted">加载失败: ' + escapeHtmlClient(e.message) + '</p>';
        return;
      }

      const file = data.file;
      if (!file) {
        modalBody.innerHTML = '<p class="muted">文件不存在</p>';
        return;
      }

      // 非阻塞记录文件访问日志（预览成功后才记录）
      fetch('/api/file-access-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({ filename, action: 'view' })
      }).catch(function() {});

      // Detect language for syntax highlighting
      const ext = filename.split('.').pop().toLowerCase();
      const langMap = { js:'javascript', ts:'typescript', py:'python', rb:'ruby', go:'go', rs:'rust', java:'java', c:'c', cpp:'cpp', h:'c', cs:'csharp', php:'php', swift:'swift', kt:'kotlin', tsx:'typescript', jsx:'javascript', sh:'bash', bash:'bash', zsh:'bash', yaml:'yaml', yml:'yaml', xml:'xml', sql:'sql', md:'markdown', json:'json', css:'css', html:'html', htm:'html' };
      const lang = langMap[ext] || '';

      if (file.type === 'text' || (file.mime || '').startsWith('text/') || ['js','ts','py','rb','go','rs','java','c','cpp','h','cs','php','swift','kt','tsx','jsx','sh','bash','yaml','yml','xml','sql','md','json','css','html','htm'].includes(ext)) {
        const content = file.content || '';
        const isTruncated = file.previewTruncated;
        const origSize = file.previewOriginalSize;
        renderTextPreview(filename, content, origSize, isTruncated, lang, ext);
      } else if ((file.mime || '').startsWith('image/')) {
        var imgSrc = 'data:' + file.mime + ';base64,' + file.content;
        modalBody.innerHTML = '<div id="imgPreviewWrap" style="text-align:center;cursor:zoom-in" onclick="openLightbox(\'' + imgSrc.replace(/'/g, "\\'") + '\', \'' + (file.mime || '').replace(/'/g, "\\'") + '\')"><img alt="" src="' + imgSrc + '" style="max-width:100%;max-height:70vh;display:block;margin:0 auto;border-radius:8px"></div><div style="text-align:center;margin-top:8px;font-size:11px;color:var(--muted)">点击图片放大</div>';
      } else if (file.mime === 'application/pdf') {
        modalBody.innerHTML = '<iframe src="data:application/pdf;base64,' + file.content + '" style="width:100%;height:70vh;border:none;border-radius:8px" title="PDF预览"></iframe>';
      } else if (file.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        modalBody.innerHTML = '<div id="docxPreview" style="max-height:70vh;overflow:auto;padding:16px;background:#fff;color:#222;border-radius:8px"><div style="text-align:center;color:var(--text-muted);padding:40px">正在加载文档...</div></div>';
        try {
          const binaryStr = atob(file.content);
          const data = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) data[i] = binaryStr.charCodeAt(i);
          Mammoth.convertToHtml({ arrayBuffer: data.buffer }).then(result => {
            document.getElementById('docxPreview').innerHTML = result.value;
          }).catch(() => {
            document.getElementById('docxPreview').innerHTML = '<p class="muted">文档预览失败，请下载查看。</p>';
          });
        } catch () {
          document.getElementById('docxPreview').innerHTML = '<p class="muted">文档预览失败，请下载查看。</p>';
        }
        return;
      } else if (file.mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
        modalBody.innerHTML = '<div id="pptxPreview" style="max-height:70vh;overflow:auto;padding:16px;background:#fff;color:#222;border-radius:8px"><div style="text-align:center;color:var(--text-muted);padding:40px">正在加载演示文稿...</div></div>';
        try {
          const binaryStr = atob(file.content);
          const data = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) data[i] = binaryStr.charCodeAt(i);
          Mammoth.convertToHtml({ arrayBuffer: data.buffer }).then(result => {
            const html = result.value || '<p class="muted">无法提取演示文稿内容。</p>';
            document.getElementById('pptxPreview').innerHTML = html;
          }).catch(() => {
            document.getElementById('pptxPreview').innerHTML = '<p class="muted">演示文稿预览失败，请下载查看。</p>';
          });
        } catch () {
          document.getElementById('pptxPreview').innerHTML = '<p class="muted">演示文稿预览失败，请下载查看。</p>';
        }
        return;
      } else if (file.mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        modalBody.innerHTML = '<div id="xlsxPreview" style="max-height:70vh;overflow:auto;padding:0;background:#fff;border-radius:8px"><div style="text-align:center;color:var(--text-muted);padding:40px">正在加载表格...</div></div>';
        try {
          const binaryStr = atob(file.content);
          const data = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) data[i] = binaryStr.charCodeAt(i);
          const wb = XLSX.read(data, { type: 'array' });
          const firstSheet = wb.Sheets[wb.SheetNames[0]];
          const html = XLSX.utils.sheet_to_html(firstSheet, { editable: false });
          document.getElementById('xlsxPreview').innerHTML = '<div style="overflow:auto;max-height:70vh">' + html + '</div>';
          const style = document.createElement('style');
          style.textContent = '#xlsxPreview table{border-collapse:collapse;width:100%;font-size:13px}#xlsxPreview td,#xlsxPreview th{border:1px solid #d0d0d0;padding:6px 10px;white-space:nowrap}#xlsxPreview th{background:#f5f5f5;font-weight:600}#xlsxPreview tr:hover{background:#f0f0f0}';
          document.getElementById('xlsxPreview').appendChild(style);
        } catch () {
          document.getElementById('xlsxPreview').innerHTML = '<p class="muted">表格预览失败，请下载查看。</p>';
        }
        return;
      } else if ((file.mime || '').startsWith('video/')) {
        modalBody.innerHTML = '<video controls style="width:100%;max-height:70vh;border-radius:8px;background:#000"><source src="data:' + file.mime + ';base64,' + file.content + '">您的浏览器不支持视频预览</video>';
      } else if ((file.mime || '').startsWith('audio/')) {
        modalBody.innerHTML = '<audio controls style="width:100%;margin-top:20px"><source src="data:' + file.mime + ';base64,' + file.content + '">您的浏览器不支持音频预览</audio>';
      } else {
        modalBody.innerHTML = '<p class="muted">此文件类型不做内嵌预览，请直接下载。</p><button class="btn secondary" onclick=' + "'" + 'downloadFile(' + JSON.stringify(filename) + ')' + "'" + '>下载文件</button>';
      }
    }

    function openQrLightbox(code) {
      // Fetch the QR code image URL and show it in lightbox
      var qrUrl = '/api/share/qr/' + encodeURIComponent(code);
      openLightbox(qrUrl, 'image/png');
    }

    function openLightbox(imgSrc, mime) {
      var lb = document.getElementById('lightboxOverlay');
      if (lb) { lb.remove(); }
      lb = document.createElement('div');
      lb.id = 'lightboxOverlay';
      lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:10000;display:flex;align-items:center;justify-content:center;cursor:zoom-out';
      lb.onclick = function() { lb.remove(); };
      lb.innerHTML = '<img src="' + imgSrc + '" style="max-width:95vw;max-height:95vh;object-fit:contain;border-radius:4px;box-shadow:0 8px 40px rgba(0,0,0,.5)" alt="">';
      document.body.appendChild(lb);
    }

    function renderTextPreview(filename, content, origSize, isTruncated, lang, ext) {
      const modalBody = document.getElementById('modalBody');
      const truncatedNote = isTruncated && origSize
        ? '<div style="background:#fffbea;border:1px solid #f59e0b;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#92400e">⚠️ 文件过大（' + formatSize(origSize) + '），仅显示前 500KB。<button class="btn-sm secondary" onclick=' + "'" + 'downloadFile(' + JSON.stringify(filename) + ')' + "'" + '>下载查看完整内容</button></div>'
        : '';
      const isMd = ext === 'md';
      let bodyContent;

      if (isMd) {
        // Markdown rendering using marked (already in package.json)
        bodyContent = '<div id="mdPreview" style="max-height:65vh;overflow:auto;line-height:1.6"></div>';
        modalBody.innerHTML = truncatedNote + bodyContent;
        const mdDiv = document.getElementById('mdPreview');
        if (typeof marked !== 'undefined') {
          // GFM: tables, task lists, strikethrough, breaks
          mdDiv.innerHTML = marked.parse(content, { gfm: true, breaks: true });
          // Add copy buttons to code blocks
          mdDiv.querySelectorAll('pre code').forEach(block => {
            const pre = block.parentElement;
            const btn = document.createElement('button');
            btn.textContent = '📋 复制';
            btn.className = 'btn-sm secondary';
            btn.style.cssText = 'position:absolute;top:8px;right:8px;font-size:11px';
            btn.onclick = () => { navigator.clipboard.writeText(block.textContent); btn.textContent = '✅ 已复制'; setTimeout(() => btn.textContent = '📋 复制', 2000); };
            pre.style.position = 'relative';
            pre.appendChild(btn);
          });
        } else {
          // Fallback: show plain text with escaping
          mdDiv.innerHTML = '<pre style="white-space:pre-wrap">' + escapeHtmlClient(content) + '</pre>';
        }
      } else if (lang) {
        // Syntax highlighted code view with line numbers
        const lines = content.split('\n');
        const lineNumbers = lines.map((_, i) => '<span class="ln">' + (i + 1) + '</span>').join('');
        bodyContent = '<div id="codeWrapper" style="position:relative;display:flex;max-height:65vh;border-radius:8px;overflow:hidden;background:var(--bg-tertiary)">' +
          '<div id="lineNumbers" style="padding:16px 12px 16px 16px;text-align:right;user-select:none;min-width:48px;background:var(--bg-secondary);color:var(--text-muted);font-family:monospace;font-size:13px;line-height:1.5;overflow:hidden;flex-shrink:0;border-right:1px solid var(--line)">' + lineNumbers + '</div>' +
          '<div id="codeScroll" style="flex:1;overflow:auto"><pre id="codeBlock" style="margin:0;padding:16px"><code id="codeContent" class="language-' + lang + '" style="font-family:monospace;font-size:13px;line-height:1.5"></code></pre></div>' +
          '</div>';
        modalBody.innerHTML = truncatedNote + bodyContent;
        const codeEl = document.getElementById('codeContent');
        codeEl.textContent = content;
        // Sync scroll between line numbers and code
        const codeScroll = document.getElementById('codeScroll');
        const lineNumbersEl = document.getElementById('lineNumbers');
        codeScroll.addEventListener('scroll', () => { lineNumbersEl.scrollTop = codeScroll.scrollTop; });
        if (typeof hljs !== 'undefined') {
          hljs.highlightElement(codeEl);
        }
        // Add copy button
        const wrapper = document.getElementById('codeWrapper');
        const btn = document.createElement('button');
        btn.textContent = '📋 复制';
        btn.className = 'btn-sm secondary';
        btn.style.cssText = 'position:absolute;top:8px;right:8px;font-size:11px;z-index:10';
        btn.onclick = () => { navigator.clipboard.writeText(content); btn.textContent = '✅ 已复制'; setTimeout(() => btn.textContent = '📋 复制', 2000); };
        wrapper.style.position = 'relative';
        wrapper.appendChild(btn);
      } else {
        // Plain text with line numbers
        const lines = content.split('\n');
        const lineNumbers = lines.map((_, i) => '<span class="ln">' + (i + 1) + '</span>').join('');
        modalBody.innerHTML = truncatedNote +
          '<div id="plainTextWrapper" style="display:flex;max-height:65vh;border-radius:8px;overflow:hidden;background:var(--bg-tertiary)">' +
          '<div id="plainLineNumbers" style="padding:12px 12px 12px 16px;text-align:right;user-select:none;min-width:48px;background:var(--bg-secondary);color:var(--text-muted);font-family:monospace;font-size:13px;line-height:1.5;overflow:hidden;flex-shrink:0;border-right:1px solid var(--line)">' + lineNumbers + '</div>' +
          '<div id="plainTextScroll" style="flex:1;overflow:auto"><pre id="plainTextPre" style="margin:0;padding:12px 16px;white-space:pre-wrap;background:var(--bg-secondary);font-size:13px;line-height:1.5">' + escapeHtmlClient(content) + '</pre></div>' +
          '</div>';
        // Sync scroll
        const plainScroll = document.getElementById('plainTextScroll');
        const plainLineNumbers = document.getElementById('plainLineNumbers');
        if (plainScroll && plainLineNumbers) {
          plainScroll.addEventListener('scroll', () => { plainLineNumbers.scrollTop = plainScroll.scrollTop; });
        }
      }
    }

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    function formatSpeed(bytesPerSec) {
      if (bytesPerSec < 1024) return bytesPerSec + ' B/s';
      if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
      return (bytesPerSec / 1024 / 1024).toFixed(1) + ' MB/s';
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

    async function startInlineRename(filename) {
      // Find the cell - try list view first, then grid
      var cell = document.querySelector('.filename-cell[data-filename="' + encodeURIComponent(filename) + '"]');
      var nameSpan, metaDiv;
      if (cell) {
        nameSpan = cell.querySelector('.filename-text');
        metaDiv = cell.querySelector('.muted');
      } else {
        // Grid view: find the file-item
        var item = document.querySelector('.file-item[data-filename="' + encodeURIComponent(filename) + '"]');
        if (!item) return;
        var nameDiv = item.querySelector('.file-name');
        if (!nameDiv) return;
        nameSpan = nameDiv.querySelector('span') || nameDiv;
        var metaDiv = item.querySelector('.file-meta');
      }
      if (!nameSpan) return;

      var original = filename;
      var input = document.createElement('input');
      input.type = 'text';
      input.value = original;
      input.className = 'inline-rename-input';
      input.style.cssText = nameSpan.style.cssText;
      var parent = nameSpan.parentElement;
      // Show input, hide text
      nameSpan.style.display = 'none';
      // Hide inline-rename button during edit
      var renameBtn = parent.querySelector('.inline-rename-btn');
      if (renameBtn) renameBtn.style.display = 'none';
      parent.insertBefore(input, nameSpan);
      input.focus();
      input.select();

      function commit() {
        var newName = input.value.trim();
        if (newName && newName !== original) {
          // Call API
          fetch('/api/file/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers() },
            body: JSON.stringify({ filename: original, newFilename: newName })
          }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.success) {
              // Update UI: restore display
              nameSpan.textContent = newName;
              nameSpan.style.display = '';
              if (renameBtn) renameBtn.style.display = '';
              // Update filename in the specific row/item (no full reload = preserves scroll)
              var row = document.querySelector('[data-filename="' + encodeURIComponent(original) + '"]');
              if (row) {
                row.setAttribute('data-filename', encodeURIComponent(newName));
                var cb = row.querySelector('input[type="checkbox"]');
                if (cb) cb.value = encodeURIComponent(newName);
                var nameCell = row.querySelector('.filename-cell');
                if (nameCell) {
                  nameCell.setAttribute('data-filename', encodeURIComponent(newName));
                  var textSpan = nameCell.querySelector('.filename-text');
                  if (textSpan) textSpan.textContent = newName;
                } else {
                  var nameDiv = row.querySelector('.file-name');
                  if (nameDiv) {
                    var textSpan = nameDiv.querySelector('span') || nameDiv;
                    textSpan.textContent = newName;
                  }
                }
              }
              showToast('已重命名为: ' + newName, 'success');
            } else {
              showToast(data.error || '重命名失败', 'error');
              nameSpan.style.display = '';
              if (renameBtn) renameBtn.style.display = '';
            }
          }).catch(function() {
            showToast('重命名失败', 'error');
            nameSpan.style.display = '';
            if (renameBtn) renameBtn.style.display = '';
          });
        } else {
          // No change, restore
          nameSpan.style.display = '';
          if (renameBtn) renameBtn.style.display = '';
        }
        input.remove();
      }

      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') {
          nameSpan.style.display = '';
          if (renameBtn) renameBtn.style.display = '';
          input.remove();
        }
      });
      input.addEventListener('blur', function() {
        // Delay to allow commit to run first
        setTimeout(function() {
          if (document.body.contains(input)) { nameSpan.style.display = ''; if (renameBtn) renameBtn.style.display = ''; input.remove(); }
        }, 100);
      });
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
      try {
        const res = await request('/api/files/' + encodeURIComponent(filename), { method: 'DELETE' });
        // 保存被删除文件的 trashId 以便撤销
        if (res && res.trash_id) {
          lastDeletedTrashId = res.trash_id;
          undoDeleteTimer = setTimeout(() => { lastDeletedTrashId = null; }, 5500);
          showToast('已删除', '', true);
        } else {
          showToast('已删除', 'success');
        }
        await loadFiles();
        await loadShares();
      } catch (error) {
        showToast(error.message, 'error');
      }
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

      // Fetch all existing tags for autocomplete
      var tagSuggestions = [];
      try {
        var res = await fetch('/api/tags/list', { headers: headers() });
        if (res.ok) {
          var data = await res.json();
          tagSuggestions = (data.tags || []).map(function(t) { return t.tag; }).filter(Boolean);
        }
      } catch(e) {}

      var suggestionsHtml = tagSuggestions.length
        ? '<datalist id="tagSuggestions"><option value="' + tagSuggestions.join('"><option value="') + '"></datalist>'
        : '';
      body.innerHTML = '<div style="padding:8px 0">' +
        '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">文件名: ' + escapeHtmlClient(filename) + '</div>' +
        suggestionsHtml +
        '<input id="tagInput" type="text" list="tagSuggestions" placeholder="标签（逗号分隔，如：工作,重要）" value="' + escapeHtmlClient(currentTags || '') + '" ' +
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

    function openSettings() {
      const modal = document.getElementById('modal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');
      title.textContent = i18n.settings || '设置';

      var savedLang = localStorage.getItem('st_lang') || 'zh';
      var savedTheme = localStorage.getItem('st_theme_mode') || 'system';
      var savedView = localStorage.getItem('viewMode') || 'list';

      body.innerHTML = '<div style="display:flex;flex-direction:column;gap:20px;padding:8px 0;font-size:14px">' +

        // Language
        '<div>' +
          '<label style="font-weight:600;display:block;margin-bottom:8px">' + (i18n.language || '语言') + '</label>' +
          '<div style="display:flex;gap:8px">' +
            '<button id="langZhBtn" class="' + (savedLang === 'zh' ? 'primary' : 'secondary') + '" onclick="setLangAndReload(\'zh\')">中文</button>' +
            '<button id="langEnBtn" class="' + (savedLang === 'en' ? 'primary' : 'secondary') + '" onclick="setLangAndReload(\'en\')">English</button>' +
          '</div>' +
        '</div>' +

        // Theme
        '<div>' +
          '<label style="font-weight:600;display:block;margin-bottom:8px">' + (i18n.appearance || '外观') + '</label>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button id="themeDarkBtn" class="' + (savedTheme === 'dark' ? 'primary' : 'secondary') + '" onclick="setThemeAndReload(\'dark\')">🌙 ' + (i18n.dark || '深色') + '</button>' +
            '<button id="themeLightBtn" class="' + (savedTheme === 'light' ? 'primary' : 'secondary') + '" onclick="setThemeAndReload(\'light\')">☀️ ' + (i18n.light || '浅色') + '</button>' +
            '<button id="themeSystemBtn" class="' + (savedTheme === 'system' ? 'primary' : 'secondary') + '" onclick="setThemeAndReload(\'system\')">💻 ' + (i18n.system || '跟随系统') + '</button>' +
          '</div>' +
        '</div>' +

        // Default view
        '<div>' +
          '<label style="font-weight:600;display:block;margin-bottom:8px">' + (i18n.defaultView || '默认视图') + '</label>' +
          '<div style="display:flex;gap:8px">' +
            '<button id="viewListBtn2" class="' + (savedView === 'list' ? 'primary' : 'secondary') + '" onclick="setDefaultView(\'list\')">☰ ' + (i18n.listView || '列表视图') + '</button>' +
            '<button id="viewGridBtn2" class="' + (savedView === 'grid' ? 'primary' : 'secondary') + '" onclick="setDefaultView(\'grid\')">⊞ ' + (i18n.gridView || '网格视图') + '</button>' +
          '</div>' +
        '</div>' +

        // Server info
        '<div style="border-top:1px solid var(--line);padding-top:16px;margin-top:4px">' +
          '<label style="font-weight:600;display:block;margin-bottom:8px">' + (i18n.serverInfo || '服务器信息') + '</label>' +
          '<div style="font-size:12px;color:var(--muted);line-height:1.8">' +
            '<div>ShareTool <span id="settingsVersion"></span></div>' +
            '<div id="settingsUptime"></div>' +
            '<div id="settingsStorage"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

      modal.classList.add('open');
      loadSettingsInfo();
    }

    function setLangAndReload(lang) {
      localStorage.setItem('st_lang', lang);
      location.reload();
    }

    function setThemeAndReload(theme) {
      localStorage.setItem('st_theme_mode', theme);
      location.reload();
    }

    function setDefaultView(view) {
      localStorage.setItem('viewMode', view);
      showToast(i18n.saved || '已保存', 'success');
      // Update button states
      document.getElementById('viewListBtn2').className = view === 'list' ? 'primary' : 'secondary';
      document.getElementById('viewGridBtn2').className = view === 'grid' ? 'primary' : 'secondary';
    }

    function loadSettingsInfo() {
      fetch('/api/health', { headers: headers() }).then(function(r) { return r.json(); }).then(function(data) {
        var ver = document.getElementById('settingsVersion');
        if (ver) ver.textContent = 'v' + (data.version || '?');
      }).catch(function() {});
      fetch('/api/storage', { headers: headers() }).then(function(r) { return r.json(); }).then(function(data) {
        var el = document.getElementById('settingsStorage');
        if (el && data.total !== undefined) {
          el.textContent = i18n.storage || '存储' + ': ' + formatBytes(data.used || 0) + ' / ' + formatBytes(data.total || 0);
        }
      }).catch(function() {});
      // Uptime from global if available
      var up = document.getElementById('settingsUptime');
      if (up && typeof _serverUptime !== 'undefined') up.textContent = 'Uptime: ' + _serverUptime;
    }

    function openKeyboardHelp() {
      const modal = document.getElementById('modal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');
      title.textContent = '键盘快捷键';
      const shortcuts = [
        ['↑ ↓ ← →', '导航文件'],
        ['j / k', 'vim 风格下/上导航'],
        ['g', '跳转至顶部'],
        ['Shift+G', '跳转至底部'],
        ['/ 或 f', '聚焦搜索框'],
        ['Enter', '打开选中文件'],
        ['Space', '选中/取消选中'],
        ['a', '全选文件'],
        ['Shift+Click', '范围选择'],
        ['u', '上传文件'],
        ['s', '切换星标'],
        ['b', '批量下载'],
        ['e', '内联重命名'],
        ['l', '复制链接'],
        ['t', '回收站'],
        ['y', '复制文件名'],
        ['Del', '删除选中'],
        ['Shift+N', '新建文件夹'],
        ['d', '删除选中'],
        ['v', '切换视图'],
        ['r', '刷新文件列表'],
        ['?', '显示此帮助'],
        ['Esc', '关闭弹窗/菜单'],
      ];
      body.innerHTML = '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px 20px;padding:8px 0;font-size:13px">' +
        shortcuts.map(([k, d]) =>
          '<kbd style="background:var(--bg-tertiary);border:1px solid var(--line);border-radius:5px;padding:2px 8px;font-family:monospace;font-size:12px;text-align:center;min-width:40px">' + escapeHtmlClient(k) + '</kbd>' +
          '<span style="color:var(--text-secondary);padding-top:2px">' + escapeHtmlClient(d) + '</span>'
        ).join('') + '</div>';
      modal.classList.add('open');
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
        const orphanTags = tags.filter(function(t) { return (t.count || 0) === 0; });
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

        // Sort controls + orphan tag cleanup
        statsHtml += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">';
        statsHtml += '<select id="tagSortSelect" onchange="sortTagList(this.value)" style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text);font-size:13px">';
        statsHtml += '<option value="count-desc">按使用次数 ↓</option>';
        statsHtml += '<option value="count-asc">按使用次数 ↑</option>';
        statsHtml += '<option value="alpha-asc">按名称 A→Z</option>';
        statsHtml += '<option value="alpha-desc">按名称 Z→A</option>';
        statsHtml += '</select>';
        if (orphanTags.length > 0) {
          statsHtml += '<button onclick="confirmCleanupOrphans()" style="padding:6px 12px;background:#fef9c3;border:1px solid #f59e0b;border-radius:8px;color:#92400e;font-size:12px;cursor:pointer;white-space:nowrap">清理孤立 (' + orphanTags.length + ')</button>';
        }
        statsHtml += '</div>';
        if (orphanTags.length > 0) {
          statsHtml += '<div id="orphanTagSection" style="display:none;margin-bottom:12px;padding:10px;background:#fef9c3;border-radius:8px">';
          statsHtml += '<div style="font-size:12px;color:#92400e;margin-bottom:8px">孤立标签（未使用，将被清理）：</div>';
          orphanTags.forEach(function(t) {
            statsHtml += '<span style="display:inline-block;padding:2px 8px;background:#fde68a;color:#78350f;border-radius:12px;font-size:12px;margin:2px">' + escapeHtmlClient(t.tag) + '</span> ';
          });
          statsHtml += '</div>';
        }

        // Tag distribution bars (top 8)
        if (tags.length > 0) {
          statsHtml += '<div style="margin-bottom:16px" id="tagDistSection">';
          statsHtml += '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">标签分布</div>';
          tags.slice(0, 8).forEach(function (t) {
            const pct = maxCount > 0 ? Math.round((t.count / maxCount) * 100) : 0;
            const barColor = t.color || '#e0e7ff';
            statsHtml += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;cursor:pointer" onclick="filterBySingleTag(\'' + escapeHtmlClient(t.tag).replace(/'/g, "\\'") + '\');document.getElementById(\'modal\').classList.remove(\'show\')" title="点击筛选此标签">';
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
        // Tag search within manager
        if (tags.length > 5) {
          html += '<div style="margin-bottom:12px">';
          html += '<input id="tagSearchInput" type="text" placeholder="搜索标签…" oninput="filterTagList(this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text);font-size:14px;box-sizing:border-box;margin-bottom:8px">';
          html += '</div>';
        }
        html += '<div style="display:flex;gap:8px;margin-bottom:12px">';
        html += '<input id="newTagInput" type="text" placeholder="新标签名称" inputmode="text" autocomplete="off" style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text);font-size:16px">';
        html += '<button class="primary" onclick="createNewTag()" style="padding:8px 16px">添加</button>';
        html += '</div>';

        // Merge section
        html += '<div id="mergeSection" style="margin-bottom:12px;display:none">';
        html += '<div style="font-size:12px;color:var(--muted);margin-bottom:6px">合并标签（选中 2 个以上标签后出现）</div>';
        html += '<div style="display:flex;gap:8px;align-items:center">';
        html += '<span style="font-size:12px;color:var(--muted);white-space:nowrap" id="mergeLabel">已选 0 个标签</span>';
        html += '<button id="mergeBtn" class="secondary" onclick="executeMergeTags()" style="padding:6px 14px;font-size:12px" disabled>合并到目标</button>';
        html += '<select id="mergeTargetSelect" style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text);font-size:13px">';
        html += '<option value="">选择目标标签…</option>';
        tags.forEach(function(t) { html += '<option value="' + escapeHtmlClient(t.tag) + '">' + escapeHtmlClient(t.tag) + '</option>'; });
        html += '</select>';
        html += '</div></div>';

        html += '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">点击颜色圆点切换，点击 ✕ 删除；勾选后可合并标签</div>';
        html += '</div>';

        if (tags.length === 0) {
          html += '<div style="text-align:center;color:var(--muted);padding:20px">暂无标签，添加文件标签后会自动创建</div>';
        } else {
          html += '<div style="max-height:400px;overflow-y:auto">';
          tags.forEach(function(t) {
            const colorDot = colorPresets.map(function(c) {
              return '<span onclick="setTagColor(\'' + escapeHtmlClient(t.tag) + '\',\'' + c + '\')" style="display:inline-block;width:20px;height:20px;border-radius:50%;background:' + c + ';cursor:pointer;margin-right:4px;border:' + (t.color === c ? '2px solid var(--primary)' : '2px solid transparent') + ';box-sizing:border-box"></span>';
            }).join('');
            html += '<div data-tag-item style="display:flex;align-items:center;padding:8px 4px;border-bottom:1px solid var(--border);gap:8px" data-tag="' + escapeHtmlClient(t.tag) + '">';
            html += '<input type="checkbox" id="mtag_' + escapeHtmlClient(t.tag) + '" onchange="toggleTagMergeSelect(\'' + escapeHtmlClient(t.tag).replace(/'/g, "\\'") + '\')" style="width:16px;height:16px;cursor:pointer;accent-color:var(--primary);flex-shrink:0">';
            html += '<div style="flex:1;min-width:0">';
            html += '<span style="font-size:14px" id="tagname_' + escapeHtmlClient(t.tag) + '">' + escapeHtmlClient(t.tag) + '</span>';
            html += '<span style="font-size:11px;color:var(--muted);margin-left:6px">' + t.count + ' 个文件</span>';
            html += '</div>';
            html += '<div style="display:flex;gap:2px;align-items:center;flex-shrink:0">' + colorDot + '</div>';
            html += '<button onclick="renameTag(\'' + escapeHtmlClient(t.tag).replace(/'/g, "\\'") + '\')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:4px" title="重命名">✎</button>';
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

    function filterTagList(query) {
      const items = document.querySelectorAll('#tagManagerContent [data-tag-item]');
      const q = query.toLowerCase().trim();
      items.forEach(function(el) {
        el.style.display = q ? (el.dataset.tag.toLowerCase().includes(q) ? '' : 'none') : '';
      });
    }

    function sortTagList(sortType) {
      const container = document.getElementById('tagManagerContent');
      const items = Array.prototype.slice.call(container.querySelectorAll('[data-tag-item]'));
      const searchInput = document.getElementById('tagSearchInput');
      const q = searchInput ? searchInput.value.toLowerCase().trim() : '';
      // Restore full tags for sorting (unhide all first)
      items.forEach(function(el) { el.style.display = ''; });
      items.sort(function(a, b) {
        const aTag = a.dataset.tag || '';
        const bTag = b.dataset.tag || '';
        const aCount = parseInt(a.querySelector('[style*="font-size:11px"]') ? a.querySelector('[style*="font-size:11px"]').textContent : '0', 10);
        const bCount = parseInt(b.querySelector('[style*="font-size:11px"]') ? b.querySelector('[style*="font-size:11px"]').textContent : '0', 10);
        if (sortType === 'count-desc') return bCount - aCount;
        if (sortType === 'count-asc') return aCount - bCount;
        if (sortType === 'alpha-asc') return aTag.localeCompare(bTag, 'zh-CN');
        if (sortType === 'alpha-desc') return bTag.localeCompare(aTag, 'zh-CN');
        return 0;
      });
      const listContainer = container.querySelector('[style*="max-height:400px"]') || container.lastElementChild;
      items.forEach(function(el) { listContainer.appendChild(el); });
      // Re-apply search filter
      if (q) filterTagList(q);
    }

    function cleanupOrphanTags() {
      const section = document.getElementById('orphanTagSection');
      if (!section) return;
      if (section.style.display === 'none') {
        section.style.display = 'block';
      } else {
        section.style.display = 'none';
      }
    }

    async function confirmCleanupOrphans() {
      const section = document.getElementById('orphanTagSection');
      if (!section) return;
      if (!confirm('确定删除所有孤立标签？此操作不可撤销。')) return;
      const res = await fetch('/api/tags/orphans', { method: 'DELETE', headers: headers() });
      const data = await res.json();
      if (data.success) {
        showToast('已清理 ' + data.deleted + ' 个孤立标签', 'success');
        openTagManager();
      } else {
        showToast('清理失败: ' + (data.error || '未知错误'), 'error');
      }
    }

    async function createNewTag() {
      const input = document.getElementById('newTagInput');
      const tag = (input.value || '').trim();
      if (!tag) { showToast('请输入标签名称', 'error'); return; }
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ tag: tag })
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

    async function renameTag(oldTag) {
      var newTag = prompt('将标签「' + oldTag + '」重命名为：', oldTag);
      if (!newTag || newTag === oldTag) return;
      newTag = newTag.trim();
      if (!newTag) { showToast('标签名称不能为空', 'error'); return; }
      var res = await fetch('/api/tags/rename', {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ oldTag: oldTag, newTag: newTag })
      });
      var data = await res.json();
      if (data.success) {
        showToast('已重命名（更新了 ' + data.updated + ' 个文件）', 'success');
        openTagManager();
      } else {
        showToast('重命名失败: ' + (data.error || '未知错误'), 'error');
      }
    }

    var _selectedMergeTags = new Set();
    function toggleTagMergeSelect(tag) {
      if (_selectedMergeTags.has(tag)) {
        _selectedMergeTags.delete(tag);
      } else {
        _selectedMergeTags.add(tag);
      }
      var section = document.getElementById('mergeSection');
      var label = document.getElementById('mergeLabel');
      var btn = document.getElementById('mergeBtn');
      if (!_selectedMergeTags.size) {
        section.style.display = 'none';
      } else {
        section.style.display = 'block';
        label.textContent = '已选 ' + _selectedMergeTags.size + ' 个标签';
        btn.disabled = _selectedMergeTags.size < 2;
      }
    }

    async function executeMergeTags() {
      var sources = Array.from(_selectedMergeTags);
      var target = document.getElementById('mergeTargetSelect').value;
      if (sources.length < 2) { showToast('请至少选择 2 个标签', 'error'); return; }
      if (!target) { showToast('请选择目标标签', 'error'); return; }
      if (sources.includes(target)) { showToast('目标标签不能在被合并的标签中', 'error'); return; }
      var btn = document.getElementById('mergeBtn');
      btn.disabled = true;
      btn.textContent = '合并中…';
      try {
        var res = await fetch('/api/tags/merge', {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ sources: sources, target: target })
        });
        var data = await res.json();
        if (data.success) {
          showToast('已合并 ' + data.updated + ' 个文件', 'success');
          _selectedMergeTags = new Set();
          openTagManager();
        } else {
          showToast('合并失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch(e) {
        showToast('合并失败: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '合并到目标';
      }
    }

    var selectedTrashItems = new Set();

    async function openDuplicates() {
      const modal = document.getElementById('modal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');
      title.textContent = '重复文件';
      body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">扫描中...</div>';
      modal.classList.add('open');

      try {
        const res = await fetch('/api/duplicates', { headers: headers() });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        const dupes = data.duplicates || [];
        if (dupes.length === 0) {
          body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">没有发现重复文件 ✓</div>';
          return;
        }

        let html = '<div style="margin-bottom:12px;color:var(--muted);font-size:13px">发现 ' + dupes.length + ' 组重复文件（' + dupes.reduce(function(s, g) { return s + g.count; }, 0) + ' 个文件）</div>';
        html += '<div style="max-height:60vh;overflow-y:auto">';

        dupes.forEach(function(group, gi) {
          html += '<div style="margin-bottom:16px;padding:12px;background:var(--bg-secondary);border-radius:10px">';
          html += '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">Hash: <code style="font-size:11px">' + escapeHtmlClient(group.hash || 'N/A') + '</code> · ' + group.count + ' 个副本</div>';
          group.files.forEach(function(f) {
            html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">';
            html += '<input type="checkbox" class="dupe-check" value="' + escapeHtmlClient(f.filename) + '" style="flex-shrink:0">';
            html += '<span style="flex:1;word-break:break-all;font-size:13px">' + escapeHtmlClient(f.filename) + '</span>';
            html += '<button class="ghost" style="padding:4px 10px;font-size:12px;flex-shrink:0" onclick="previewFile(' + JSON.stringify(f.filename) + ')">预览</button>';
            html += '<button class="danger" style="padding:4px 10px;font-size:12px;flex-shrink:0" onclick="deleteDupe(\'' + escapeHtmlClient(f.filename).replace(/'/g, "\\'") + '\')">删除</button>';
            html += '</div>';
          });
          html += '</div>';
        });

        html += '</div>';
        html += '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line);display:flex;gap:8px">';
        html += '<button class="secondary" onclick="selectAllDupes()">全选</button>';
        html += '<button class="danger" onclick="deleteSelectedDupes()">删除选中</button>';
        html += '</div>';
        body.innerHTML = html;
      } catch (e) {
        body.innerHTML = '<p class="muted">加载失败: ' + escapeHtmlClient(e.message) + '</p>';
      }
    }

    function selectAllDupes() {
      document.querySelectorAll('.dupe-check').forEach(function(cb) { cb.checked = true; });
    }

    async function deleteDupe(filename) {
      if (!confirm('删除 ' + filename + '？')) return;
      const res = await fetch('/api/files/' + encodeURIComponent(filename), { method: 'DELETE', headers: headers() });
      if (res.ok) {
        showToast('已删除', 'success');
        openDuplicates(); // refresh
      } else {
        showToast('删除失败', 'error');
      }
    }

    async function deleteSelectedDupes() {
      var names = Array.from(document.querySelectorAll('.dupe-check:checked')).map(function(cb) { return cb.value; });
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      if (!confirm('删除 ' + names.length + ' 个重复文件？')) return;
      const res = await fetch('/api/files/batch-delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() },
        body: JSON.stringify({ filenames: names })
      });
      const data = await res.json();
      if (data.success) {
        showToast('已删除 ' + data.deleted + ' 个文件', 'success');
        openDuplicates(); // refresh
      } else {
        showToast(data.error || '删除失败', 'error');
      }
    }

    async function openDashboard() {
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '\uD83D\uDCC8 \u5B58\u50A8\u5206\u6790';
      body.innerHTML = '<div id="dashboardContent" style="max-height:70vh;overflow:auto;padding:4px 0"><div style="display:flex;justify-content:center;align-items:center;height:120px;color:var(--muted)">\u52A0\u8F7D\u4E2D...</div></div>';
      modal.classList.add('show');
      try {
        var res = await fetch('/api/dashboard', { headers: headers() });
        var data = await res.json();
        if (!data.success) throw new Error(data.error);
        var files = data.files, storage = data.storage, byType = data.byType, byExt = data.byExt;
        var activity = data.activity, shares = data.shares, devices = data.devices;
        var tokens = data.tokens, audit = data.audit;
        var fmtSize = function(b) {
          if (b < 1024) return b + ' B';
          if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
          if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
          return (b/1073741824).toFixed(2) + ' GB';
        };
        var cards = [
          { label: '\u6587\u4EF6\u603B\u6570', value: files.total, icon: '\uD83D\uDCC4' },
          { label: '\u5B58\u50A8\u7528\u91CF', value: fmtSize(storage.total), icon: '\uD83D\uDCBE' },
          { label: '\u4ECA\u65E5\u65B0\u589E', value: activity.today, icon: '\uD83D\uDCC8' },
          { label: '\u672C\u5468\u65B0\u589E', value: activity.week, icon: '\uD83D\uDCC5' },
          { label: '\u6D3B\u8DC3\u5206\u4EAB', value: shares.active, icon: '\uD83D\uDD17' },
          { label: '\u5728\u7EBF\u8BBE\u5907', value: devices.online + '/' + devices.total, icon: '\uD83D\uDCF1' },
        ];
        var html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px">';
        for (var ci = 0; ci < cards.length; ci++) {
          var c = cards[ci];
          html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px;text-align:center">';
          html += '<div style="font-size:22px;margin-bottom:4px">' + c.icon + '</div>';
          html += '<div style="font-size:20px;font-weight:700;color:var(--text)">' + escapeHtmlClient('' + c.value) + '</div>';
          html += '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + c.label + '</div></div>';
        }
        html += '</div>';
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px">';
        html += '<div style="font-weight:600;margin-bottom:12px;font-size:13px">\uD83D\uDCC1 \u6587\u4EF6\u7C7B\u578B\u5206\u5E03</div>';
        if (byType && byType.length) {
          var totalFiles = 0, ti;
          for (ti = 0; ti < byType.length; ti++) totalFiles += byType[ti].count;
          var colors = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6'];
          for (ti = 0; ti < byType.length; ti++) {
            var r = byType[ti];
            var pct = totalFiles > 0 ? Math.round(r.count / totalFiles * 100) : 0;
            var color = colors[ti % colors.length];
            html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
            html += '<div style="width:12px;height:12px;border-radius:3px;background:' + color + ';flex-shrink:0"></div>';
            html += '<div style="flex:1;font-size:12px;color:var(--text-secondary)">' + escapeHtmlClient(r.type || 'unknown') + '</div>';
            html += '<div style="font-size:12px;color:var(--muted)">' + r.count + ' (' + pct + '%)</div></div>';
            html += '<div style="height:4px;background:var(--bg-tertiary);border-radius:4px;margin-bottom:10px">';
            html += '<div style="height:4px;width:' + pct + '%;background:' + color + ';border-radius:4px"></div></div>';
          }
        } else {
          html += '<div style="color:var(--muted);font-size:12px">\u6682\u65E0\u6570\u636E</div>';
        }
        html += '</div>';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px">';
        html += '<div style="font-weight:600;margin-bottom:12px;font-size:13px">\uD83D\uDD24 \u5E38\u89C1\u540E\u7F00 TOP 10</div>';
        if (byExt && byExt.length) {
          var maxCount = byExt[0] ? byExt[0].count : 1;
          for (var ei = 0; ei < byExt.length; ei++) {
            var er = byExt[ei];
            var epct = Math.round(er.count / maxCount * 100);
            html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">';
            html += '<div style="width:40px;font-size:11px;color:var(--muted);flex-shrink:0">.' + escapeHtmlClient(er.ext || 'none') + '</div>';
            html += '<div style="flex:1;height:6px;background:var(--bg-tertiary);border-radius:3px">';
            html += '<div style="height:6px;width:' + epct + '%;background:var(--accent);border-radius:3px;opacity:0.7"></div></div>';
            html += '<div style="font-size:11px;color:var(--muted);width:28px;text-align:right">' + er.count + '</div></div>';
          }
        } else {
          html += '<div style="color:var(--muted);font-size:12px">\u6682\u65E0\u6570\u636E</div>';
        }
        html += '</div></div>';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px;margin-bottom:20px">';
        html += '<div style="font-weight:600;margin-bottom:14px;font-size:13px">\uD83D\uDCC8 \u8FD17\u5929\u6587\u4EF6\u6D3B\u52A8</div>';
        if (activity.dailyNew && activity.dailyNew.length) {
          var maxDay = Math.max.apply(null, activity.dailyNew.map(function(d) { return d.count; }).concat([1]));
          html += '<div style="display:flex;align-items:flex-end;gap:4px;height:80px">';
          for (var di = 0; di < activity.dailyNew.length; di++) {
            var dd = activity.dailyNew[di];
            var dh = Math.max(Math.round(dd.count / maxDay * 70), dd.count > 0 ? 4 : 1);
            html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">';
            html += '<div style="font-size:10px;color:var(--muted)">' + dd.count + '</div>';
            html += '<div style="width:100%;height:' + dh + 'px;background:var(--accent);border-radius:3px 3px 0 0;opacity:0.8"></div>';
            html += '<div style="font-size:9px;color:var(--muted)">' + escapeHtmlClient(dd.date) + '</div></div>';
          }
          html += '</div>';
        } else {
          html += '<div style="color:var(--muted);font-size:12px">\u6682\u65E0\u6570\u636E</div>';
        }
        html += '</div>';
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">';
        var sysItems = [
          { label: '\u6587\u672C\u6587\u4EF6', value: files.text },
          { label: '\u4E8C\u8FDB\u5236\u6587\u4EF6', value: files.binary },
          { label: '\u661F\u6807\u6587\u4EF6', value: files.starred },
          { label: '\u56DE\u6536\u7AD9', value: files.trash },
          { label: '\u603B\u5206\u4EAB\u6570', value: shares.total },
          { label: '\u5BC6\u7801\u4FDD\u62A4', value: shares.withPassword },
          { label: 'Token \u603B\u6570', value: tokens.total },
          { label: 'Token \u6D3B\u8DC3', value: tokens.active },
          { label: '\u5BA1\u8BA1\u65E5\u5FD7', value: audit.total },
          { label: '\u4ECA\u65E5\u5BA1\u8BA1', value: audit.today },
        ];
        for (var si = 0; si < sysItems.length; si++) {
          var s = sysItems[si];
          html += '<div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--bg-secondary);border-radius:8px;font-size:12px">';
          html += '<span style="color:var(--muted)">' + s.label + '</span>';
          html += '<span style="font-weight:600;color:var(--text)">' + escapeHtmlClient('' + s.value) + '</span></div>';
        }
        html += '</div>';
        var targetEl = document.getElementById('dashboardContent');
        if (targetEl) targetEl.innerHTML = html;
      } catch (e) {
        var errEl = document.getElementById('dashboardContent');
        if (errEl) errEl.innerHTML = '<div style="color:var(--error);padding:12px">\u52A0\u8F7D\u5931\u8D25: ' + escapeHtmlClient(e.message) + '</div>';
      }
    }

    async function openTrash() {
      const modal = document.getElementById('modal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');
      title.textContent = '回收站';
      selectedTrashItems.clear();
      body.innerHTML = '<div id="trashContent" style="padding:8px 0"><div style="text-align:center;color:var(--muted);padding:20px">加载中…</div></div>';
      modal.classList.add('show');

      try {
        const res = await fetch('/api/trash', { headers: headers() });
        const data = await res.json();
        if (!data.success) { throw new Error(data.error || '加载失败'); }

        const items = data.items || [];
        const expiredCount = items.filter(i => i.expires_at && Date.now() / 1000 > i.expires_at).length;

        let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap">';
        html += '<div style="display:flex;align-items:center;gap:12px">';
        html += '<div style="font-size:13px;color:var(--muted)">共 <strong id="trashCount">' + items.length + '</strong> 个文件';
        if (expiredCount > 0) html += '（<span style="color:var(--warning)">' + expiredCount + ' 个已过期</span>）';
        html += '</div>';
        html += '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer;user-select:none">';
        html += '<input type="checkbox" id="trashSelectAll" onchange="toggleTrashSelectAll()" style="width:16px;height:16px;cursor:pointer">全选';
        html += '</label>';
        html += '</div>';
        html += '<div style="display:flex;gap:8px;align-items:center">';
        html += '<button id="trashBatchRestore" onclick="batchRestoreTrash()" disabled style="padding:6px 14px;font-size:12px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer;opacity:0.5">恢复(<span id="trashRestoreCount">0</span>)</button>';
        html += '<button id="trashBatchDelete" onclick="batchPermanentDeleteTrash()" disabled style="padding:6px 14px;font-size:12px;background:var(--error);color:#fff;border:none;border-radius:6px;cursor:pointer;opacity:0.5">彻底删除(<span id="trashDeleteCount">0</span>)</button>';
        html += '<button class="danger" onclick="emptyTrash()" style="padding:6px 14px;font-size:12px" ' + (items.length === 0 ? 'disabled' : '') + '>清空</button>';
        html += '</div>';
        html += '</div>';

        if (items.length === 0) {
          html += '<div style="text-align:center;color:var(--muted);padding:40px 20px">回收站为空</div>';
        } else {
          html += '<div style="max-height:500px;overflow-y:auto">';
          items.forEach(function(item) {
            const deletedAt = new Date(item.deleted_at * 1000);
            const expiryInfo = item.expires_at ? ('（' + Math.max(0, Math.ceil((item.expires_at * 1000 - Date.now()) / 86400000)) + ' 天后永久删除）') : '';
            const sizeStr = item.size > 1024 * 1024 ? (Math.round(item.size / 1024 / 1024) + ' MB') : (Math.round(item.size / 1024) + ' KB');
            const typeIcon = '📄';
            html += '<div id="trash-item-' + item.id + '" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:var(--bg-secondary);margin-bottom:8px">';
            html += '<input type="checkbox" data-id="' + item.id + '" onchange="toggleTrashItem(' + item.id + ')" style="width:18px;height:18px;flex-shrink:0;cursor:pointer">';
            html += '<span style="font-size:20px;flex-shrink:0">' + typeIcon + '</span>';
            html += '<div style="flex:1;min-width:0">';
            html += '<div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtmlClient(item.filename) + '">' + escapeHtmlClient(item.filename) + '</div>';
            html += '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + sizeStr + ' · 删除于 ' + deletedAt.toLocaleDateString('zh-CN') + ' ' + expiryInfo + '</div>';
            html += '</div>';
            html += '<button onclick="restoreTrashItem(' + item.id + ')" style="padding:5px 12px;font-size:12px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer">恢复</button>';
            html += '<button onclick="permanentDeleteTrashItem(' + item.id + ')" style="padding:5px 12px;font-size:12px;background:var(--bg-tertiary);color:var(--muted);border:1px solid var(--line);border-radius:6px;cursor:pointer">彻底删除</button>';
            html += '</div>';
          });
          html += '</div>';
        }

        document.getElementById('trashContent').innerHTML = html;
      } catch (e) {
        document.getElementById('trashContent').innerHTML = '<div style="color:var(--error);padding:12px">加载失败: ' + escapeHtmlClient(e.message) + '</div>';
      }
    }

    function toggleTrashItem(id) {
      if (selectedTrashItems.has(id)) selectedTrashItems.delete(id);
      else selectedTrashItems.add(id);
      updateTrashBatchButtons();
    }

    function toggleTrashSelectAll() {
      const checked = document.getElementById('trashSelectAll').checked;
      const checkboxes = document.querySelectorAll('#trashContent input[type="checkbox"]');
      selectedTrashItems.clear();
      checkboxes.forEach(cb => {
        if (cb.id !== 'trashSelectAll') {
          cb.checked = checked;
          if (checked) {
            const id = parseInt(cb.getAttribute('data-id'));
            if (id) selectedTrashItems.add(id);
          }
        }
      });
      updateTrashBatchButtons();
    }

    function updateTrashBatchButtons() {
      const count = selectedTrashItems.size;
      const restoreBtn = document.getElementById('trashBatchRestore');
      const deleteBtn = document.getElementById('trashBatchDelete');
      if (restoreBtn) {
        restoreBtn.disabled = count === 0;
        restoreBtn.style.opacity = count === 0 ? '0.5' : '1';
        document.getElementById('trashRestoreCount').textContent = count;
      }
      if (deleteBtn) {
        deleteBtn.disabled = count === 0;
        deleteBtn.style.opacity = count === 0 ? '0.5' : '1';
        document.getElementById('trashDeleteCount').textContent = count;
      }
    }

    async function batchRestoreTrash() {
      const ids = Array.from(selectedTrashItems);
      if (ids.length === 0) return;
      try {
        const res = await fetch('/api/trash/restore-batch', {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ trashIds: ids })
        });
        const data = await res.json();
        if (data.success) {
          showToast('已恢复 ' + data.restored + ' 个文件', 'success');
          openTrash();
          loadFiles();
        } else {
          showToast('恢复失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('恢复失败: ' + e.message, 'error');
      }
    }

    async function batchPermanentDeleteTrash() {
      const ids = Array.from(selectedTrashItems);
      if (ids.length === 0) return;
      if (!confirm('彻底删除 ' + ids.length + ' 个文件后无法恢复，确定？')) return;
      try {
        const res = await fetch('/api/trash/delete-batch', {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ trashIds: ids })
        });
        const data = await res.json();
        if (data.success) {
          showToast('已删除 ' + data.deleted + ' 个文件', 'success');
          openTrash();
        } else {
          showToast('删除失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('删除失败: ' + e.message, 'error');
      }
    }

    async function restoreTrashItem(trashId) {
      try {
        const res = await fetch('/api/trash/restore', {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ trashId })
        });
        const data = await res.json();
        if (data.success) {
          showToast('已恢复', 'success');
          openTrash();
        } else {
          showToast('恢复失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('恢复失败: ' + e.message, 'error');
      }
    }

    async function permanentDeleteTrashItem(trashId) {
      if (!confirm('彻底删除后无法恢复，确定？')) return;
      try {
        const res = await fetch('/api/trash/delete', {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ trashId })
        });
        const data = await res.json();
        if (data.success) {
          showToast('已彻底删除', 'success');
          openTrash();
        } else {
          showToast('删除失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('删除失败: ' + e.message, 'error');
      }
    }

    async function emptyTrash() {
      if (!confirm('确定清空回收站？所有文件将被永久删除。')) return;
      try {
        const res = await fetch('/api/trash/empty', { method: 'POST', headers: headers() });
        const data = await res.json();
        if (data.success) {
          showToast('回收站已清空', 'success');
          openTrash();
        } else {
          showToast('清空失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('清空失败: ' + e.message, 'error');
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
      // Remove any existing share-create modal
      var existing = document.getElementById('shareCreateModal');
      if (existing) existing.remove();

      var modal = document.createElement('div');
      modal.id = 'shareCreateModal';
      modal.className = 'modal open';
      modal.innerHTML = '\
        <div class="modal-content" style="max-width:460px">\
          <h3>创建分享链接</h3>\
          <p id="shareCreateFileName" style="font-size:13px;color:var(--muted);margin-bottom:16px;word-break:break-all"></p>\
          <div style="margin-bottom:12px">\
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">有效期</label>\
            <select id="shareExpirySelect" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:var(--bg)">\
              <option value="24">24 小时</option>\
              <option value="48">48 小时</option>\
              <option value="168" selected>7 天（推荐）</option>\
              <option value="336">14 天</option>\
              <option value="720">30 天</option>\
              <option value="0">永不过期</option>\
            </select>\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">访问密码（可选）</label>\
            <input id="sharePasswordInput" type="text" placeholder="留空则无需密码" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px;box-sizing:border-box">\
          </div>\
          <div style="margin-bottom:16px">\
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">最大下载次数（可选）</label>\
            <input id="shareMaxDlInput" type="number" min="1" placeholder="无限制" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px;box-sizing:border-box">\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'shareCreateModal\').remove()">取消</button>\
            <button onclick="confirmShareCreate(\'' + filename.replace(/'/g, "\\'") + '\')" id="shareCreateBtn">创建并复制链接</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      document.getElementById('shareCreateFileName').textContent = filename;
      // Focus password field for quick entry
      document.getElementById('sharePasswordInput').focus();
    }

    async function confirmShareCreate(filename) {
      var btn = document.getElementById('shareCreateBtn');
      if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
      var expiryHours = parseInt(document.getElementById('shareExpirySelect').value, 10);
      var password = document.getElementById('sharePasswordInput').value.trim();
      var maxDownloads = document.getElementById('shareMaxDlInput').value.trim();
      try {
        var data = await request('/api/share/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: filename,
            expiryHours: expiryHours,
            password: password,
            maxDownloads: maxDownloads ? parseInt(maxDownloads, 10) : null
          })
        });
        if (!data || !data.success || !data.share || !data.share.url) {
          showToast('创建分享链接失败', 'error');
          return;
        }
        await copyToClipboard(data.share.url);
        showToast('分享链接已复制到剪贴板', 'success');
        var m = document.getElementById('shareCreateModal');
        if (m) m.remove();
        await loadShares();
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '创建并复制链接'; }
      }
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
          '<td data-label="链接"><a href="' + escapeHtmlClient(share.url) + '" target="_blank">' + escapeHtmlClient(share.url) + '</a></td>' +
          '<td data-label=""><img alt="QR" src="/api/share/qr/' + encodeURIComponent(share.code) + '" style="cursor:pointer;border-radius:6px;max-width:48px;height:auto" onclick="openQrLightbox(\'' + escapeHtmlClient(share.code) + '\')" title="点击查看大图"></td>' +
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
          '<td data-label="链接"><a href="' + escapeHtmlClient(share.url) + '" target="_blank">' + escapeHtmlClient(share.url) + '</a></td>' +
          '<td data-label=""><img alt="QR" src="/api/share/qr/' + encodeURIComponent(share.code) + '" style="cursor:pointer;border-radius:6px;max-width:48px;height:auto" onclick="openQrLightbox(\'' + escapeHtmlClient(share.code) + '\')" title="点击查看大图"></td>' +
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
      if (event.key === 'Enter') {
        document.getElementById('searchSuggestions').style.display = 'none';
        searchFiles();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Navigate search suggestions with arrow keys
        var container = document.getElementById('searchSuggestions');
        var items = container.querySelectorAll('.suggestion-item');
        if (!items.length) return;
        event.preventDefault();
        var current = container.querySelector('.suggestion-item.selected');
        if (!current) {
          // Select first (ArrowDown) or last (ArrowUp)
          var idx = event.key === 'ArrowDown' ? 0 : items.length - 1;
          items[idx].classList.add('selected');
        } else {
          current.classList.remove('selected');
          var idx = Array.from(items).indexOf(current);
          if (event.key === 'ArrowDown' && idx < items.length - 1) idx++;
          else if (event.key === 'ArrowUp' && idx > 0) idx--;
          items[idx].classList.add('selected');
          items[idx].scrollIntoView({ block: 'nearest' });
        }
      } else if (event.key === 'Escape') {
        document.getElementById('searchSuggestions').style.display = 'none';
      }
    });

    // Search autocomplete - debounced suggestions as user types
    var _searchSuggestTimer = null;
    var _searchLiveTimer = null;
    document.getElementById('searchInput').addEventListener('input', function () {
      clearTimeout(_searchSuggestTimer);
      clearTimeout(_searchLiveTimer);
      const q = this.value.trim();
      // Show/hide clear button
      document.getElementById('searchClear').style.display = q ? 'block' : 'none';
      if (!q || q.length < 1) {
        document.getElementById('searchSuggestions').style.display = 'none';
        return;
      }
      _searchSuggestTimer = setTimeout(async function () {
        await loadSearchSuggestions(q);
      }, 200);
      // Real-time search: debounced 300ms
      _searchLiveTimer = setTimeout(function () {
        loadFiles();
      }, 300);
    });

    async function loadSearchSuggestions(q) {
      try {
        const res = await fetch('/api/search/suggest?q=' + encodeURIComponent(q), { headers: headers() });
        const data = await res.json();
        if (!data.success) return;
        const suggestions = data.suggestions || [];
        const container = document.getElementById('searchSuggestions');
        if (!suggestions.length) {
          container.style.display = 'none';
          return;
        }
        container.innerHTML = suggestions.map(function (s) {
          const highlighted = highlightMatch(escapeHtmlClient(s.text), q);
          return '<div class="suggestion-item" onclick="applySearchSuggestion(\'' + escapeHtmlClient(s.text).replace(/'/g, "\\'") + '\')">' + highlighted + '<span class="suggestion-type">' + (s.type || '') + '</span></div>';
        }).join('');
        container.style.display = 'block';
      } catch (_) {}
    }

    function applySearchSuggestion(text) {
      document.getElementById('searchInput').value = text;
      document.getElementById('searchSuggestions').style.display = 'none';
      searchFiles();
    }

    function clearSearchInput() {
      document.getElementById('searchInput').value = '';
      document.getElementById('searchClear').style.display = 'none';
      document.getElementById('searchSuggestions').style.display = 'none';
      currentSearchQuery = '';
      loadFiles();
      document.getElementById('searchInput').focus();
    }

    function escapeRegex(s) {
      return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    }

    function highlightMatch(text, query) {
      if (!query || !text) return escapeHtmlClient(text);
      const escaped = escapeHtmlClient(text);
      const q = escapeHtmlClient(query);
      return escaped.replace(new RegExp(escapeRegex(q), 'gi'), '<mark class="search-highlight">$&</mark>');
    }

    document.getElementById('shareSearchInput').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') filterShares();
    });

    // Sort state
    var currentSort = localStorage.getItem('sortBy') || 'updated_at';
    var currentOrder = localStorage.getItem('sortOrder') || 'desc';
    var currentTypeFilter = localStorage.getItem('typeFilter') || '';

    // Initialize sort arrows on page load
    ['filename', 'size', 'updated_at', 'position', 'starred'].forEach(function(c) {
      var arrow = document.getElementById('arrow-' + c);
      if (arrow) arrow.textContent = c === currentSort ? (currentOrder === 'asc' ? '↑' : '↓') : '';
    });

    // Type filter chips
    function setTypeFilter(type) {
      currentTypeFilter = type;
      localStorage.setItem('typeFilter', type);
      document.querySelectorAll('.type-chip').forEach(function(c) {
        c.classList.toggle('active', c.getAttribute('data-type') === type);
      });
      loadFiles();
    }

    // Storage usage bar
    var _storageStatsTimer = null;
    function loadStorageStats() {
      clearTimeout(_storageStatsTimer);
      _storageStatsTimer = setTimeout(async function() {
        try {
          var res = await fetch('/api/storage', { headers: headers() });
          if (res.status < 400) {
            var data = await res.json();
            var used = data.totalSize || 0;
            var max = data.maxSize || 10 * 1024 * 1024 * 1024;
            var pct = Math.min(100, Math.round(used / max * 100));
            var fill = document.getElementById('storageFill');
            var track = document.getElementById('storageTrack');
            var text = document.getElementById('storageText');
            var bar = document.getElementById('storageBar');
            if (fill && track && text && bar) {
              bar.style.display = 'inline-flex';
              fill.style.width = pct + '%';
              fill.style.background = pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : 'var(--accent)';
              text.textContent = '存储 ' + formatSize(used) + ' / ' + formatSize(max) + ' (' + pct + '%)';
            }
            // Update type chip counts
            var typeCounts = {};
            if (data.byType) {
              data.byType.forEach(function(r) { typeCounts[r.category] = r.count; });
            }
            // Update starred separately via API call (no stats endpoint for starred)
            updateTypeChipCounts(typeCounts, data.count || 0);
          }
        } catch (e) {}
      }, 500);
    }

    function updateTypeChipCounts(typeCounts, totalCount) {
      // Map category names to data-type values
      var mapping = {
        'image': 'image',
        'video': 'video',
        'audio': 'audio',
        'pdf': 'pdf',
        'document': 'document',
        'archive': 'archive',
        'text': 'text'
      };
      Object.keys(mapping).forEach(function(cat) {
        var btn = document.querySelector('.type-chip[data-type="' + mapping[cat] + '"]');
        if (btn) {
          var count = typeCounts[cat] || 0;
          var label = {
            'image': '🖼️ 图片',
            'video': '🎬 视频',
            'audio': '🎵 音频',
            'pdf': '📕 PDF',
            'document': '📄 文档',
            'archive': '📦 压缩',
            'text': '📝 文本'
          }[cat];
          var existing = btn.textContent.replace(/\u00a0\d+$/, ''); // strip existing count
          btn.textContent = existing + '\u00a0' + count;
        }
      });
      // Update total (全部)
      var allBtn = document.querySelector('.type-chip[data-type=""]');
      if (allBtn) {
        var existing = allBtn.textContent.replace(/\u00a0\d+$/, '');
        allBtn.textContent = existing + '\u00a0' + totalCount;
      }
      // Fetch starred count separately
      fetchStarredCount();
    }

    var _starredCount = 0;
    function fetchStarredCount() {
      // Use a quick search with type=starred to get count
      fetch('/api/search?type=starred&limit=1', { headers: headers() })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          _starredCount = data.total || 0;
          var btn = document.querySelector('.type-chip[data-type="starred"]');
          if (btn) {
            var existing = btn.textContent.replace(/\u00a0\d+$/, '');
            btn.textContent = existing + '\u00a0' + _starredCount;
          }
        }).catch(function() {});
    }

    // Show initial sort arrow
    (function initArrows() {
      ['filename', 'size', 'updated_at', 'created_at'].forEach(function (c) {
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
      localStorage.setItem('sortBy', currentSort);
      localStorage.setItem('sortOrder', currentOrder);
      // Update arrow indicators
      ['filename', 'size', 'updated_at', 'created_at', 'position'].forEach(function (c) {
        var arrow = document.getElementById('arrow-' + c);
        if (arrow) arrow.textContent = c === currentSort ? (currentOrder === 'asc' ? '↑' : '↓') : '';
      });
      loadFiles();
    }

    setupDragDrop();
    // Initialize sort arrows on page load
    ['filename', 'size', 'updated_at', 'created_at', 'position'].forEach(function (c) {
      var arrow = document.getElementById('arrow-' + c);
      if (arrow) arrow.textContent = c === currentSort ? (currentOrder === 'asc' ? '↑' : '↓') : '';
    });
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
      // Skip if typing in an input/textarea
      var active = document.activeElement;
      var tag = active && active.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // ?: show shortcuts help
      if (e.key === '?') {
        var existing = document.getElementById('shortcutsHelp');
        if (existing) { existing.remove(); return; }
        var div = document.createElement('div');
        div.id = 'shortcutsHelp';
        div.style.cssText = 'position:fixed;bottom:60px;right:16px;background:var(--bg-secondary);border:1px solid var(--line);border-radius:12px;padding:16px 20px;min-width:240px;font-size:12px;z-index:1000;box-shadow:0 4px 20px rgba(0,0,0,0.15)';
        var shortcuts = [
          ['?', '显示/隐藏快捷键'],
          ['r', '刷新文件列表'],
          ['f', '聚焦搜索框'],
          ['n', '新建文本文件'],
          ['Ctrl+V', '粘贴图片/文件上传'],
          ['Enter', '打开/预览文件'],
          ['d', '删除选中文件'],
          ['c', '复制分享链接'],
          ['s', '切换排序方向'],
          ['Ctrl+A', '全选文件'],
          ['Ctrl+Enter', '上传/保存'],
          ['Esc', '关闭弹窗/取消选择'],
        ];
        div.innerHTML = '<div style="font-weight:600;margin-bottom:10px;font-size:13px">⌨ 快捷键</div>' +
          shortcuts.map(function(s) { return '<div style="display:flex;justify-content:space-between;margin:6px 0"><kbd style="background:var(--bg-tertiary);padding:2px 7px;border-radius:4px;font-size:11px;min-width:70px;text-align:center;border:1px solid var(--line);color:var(--text-primary)">' + escapeHtmlClient(s[0]) + '</kbd><span style="color:var(--muted);margin-left:12px">' + escapeHtmlClient(s[1]) + '</span></div>'; }).join('');
        document.body.appendChild(div);
        setTimeout(function() { document.addEventListener('click', function h(e2) { var h2 = document.getElementById('shortcutsHelp'); if (h2 && !h2.contains(e2.target)) { h2.remove(); document.removeEventListener('click', h); } }); }, 0);
        return;
      }
      // r: refresh
      if (e.key === 'r') {
        loadFiles();
        showToast('已刷新', 'info', 1500);
        return;
      }
      // f: focus search
      if (e.key === 'f') {
        document.getElementById('searchInput').focus();
        document.getElementById('searchInput').select();
        return;
      }
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
      // Ctrl/Cmd + A: select all files
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        e.preventDefault();
        document.querySelectorAll('.file-check').forEach(function(el) { el.checked = true; });
        updateBatchBar();
      }
      // Enter: open/preview selected file (or first keyboard-navigated file)
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        var items = getAllFileItems();
        var targetItem = null;
        if (keyboardNavIndex >= 0 && items[keyboardNavIndex]) {
          targetItem = items[keyboardNavIndex];
        } else {
          var checked = document.querySelectorAll('.file-check:checked');
          if (checked.length === 1) {
            targetItem = checked[0].closest('tr') || checked[0].closest('.file-item');
          }
        }
        if (targetItem) {
          var fn = targetItem.getAttribute('data-filename') || targetItem.querySelector('.filename') && targetItem.querySelector('.filename').textContent;
          if (fn) { previewFile(fn.trim()); }
        }
        return;
      }
      // n: new text file
      if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        document.getElementById('newFileDialog').style.display = 'block';
        var nfi = document.getElementById('newFileInput');
        if (nfi) { nfi.focus(); nfi.select(); }
        return;
      }
      // d: delete selected files (with confirmation)
      if (e.key === 'd' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        var checked = document.querySelectorAll('.file-check:checked');
        if (checked.length === 0 && keyboardNavIndex >= 0) {
          var items = getAllFileItems();
          var item = items[keyboardNavIndex];
          if (item) {
            var fn3 = item.getAttribute('data-filename') || item.querySelector('.filename') && item.querySelector('.filename').textContent;
            if (fn3) { deleteFile(fn3.trim()); }
          }
        } else if (checked.length > 0) {
          deleteSelected();
        }
        return;
      }
      // c: copy share link of selected file
      if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        var checked = document.querySelectorAll('.file-check:checked');
        var fn4 = null;
        if (checked.length === 1) {
          var item = checked[0].closest('tr') || checked[0].closest('.file-item');
          fn4 = item && (item.getAttribute('data-filename') || item.querySelector('.filename') && item.querySelector('.filename').textContent);
        } else if (keyboardNavIndex >= 0) {
          var items = getAllFileItems();
          var item = items[keyboardNavIndex];
          fn4 = item && (item.getAttribute('data-filename') || item.querySelector('.filename') && item.querySelector('.filename').textContent);
        }
        if (fn4) { copyShareLink(fn4.trim()); }
        return;
      }
      // s: toggle safe area / toggle sidebar
      if (e.key === 's' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        // Toggle sort direction
        var currentOrder = localStorage.getItem('st_sort_order') || 'desc';
        var newOrder = currentOrder === 'desc' ? 'asc' : 'desc';
        localStorage.setItem('st_sort_order', newOrder);
        loadFiles();
        showToast('排序: ' + (newOrder === 'desc' ? '最新优先' : '最旧优先'), 'info', 1500);
        return;
      }
      // Escape: close modal or lightbox, clear toast, clear selection
      if (e.key === 'Escape') {
        var lb = document.getElementById('lightboxOverlay');
        if (lb) { lb.remove(); } else { forceCloseModal(); }
        // Hide toast if showing
        var toast = document.getElementById('toast');
        if (toast) { toast.className = ''; if (toast._timer) clearTimeout(toast._timer); }
        clearSelection();
      }
    });

    Promise.all([loadFiles(), loadShares()]).catch(function (error) {
      status(error.message);
    });

    // Real-time file change notifications via SSE
    (function initSSE() {
      var token = localStorage.getItem('st_auth_token') || STATIC_TOKEN;
      var es = new EventSource('/api/events?token=' + encodeURIComponent(token));
      es.addEventListener('files_changed', function (e) {
        loadFiles();
        showToast('文件已更新', 'info', 3000);
      });
      es.onerror = function () {
        // Silently reconnect; EventSource auto reconnects
      };
    })();

    // Reload when tab becomes visible again
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        loadFiles();
      }
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

    // Advanced search panel toggle
    window.toggleAdvancedSearch = function() {
      var panel = document.getElementById('advancedSearchPanel');
      var btn = document.getElementById('advancedSearchBtn');
      if (!panel) return;
      if (panel.style.display === 'none') {
        panel.style.display = 'block';
        btn.textContent = '高级 ∧';
      } else {
        panel.style.display = 'none';
        btn.textContent = '高级 ⌄';
      }
    };

    // Get current advanced filter values
    function getAdvancedFilters() {
      var sizeMin = document.getElementById('sizeMin') && document.getElementById('sizeMin').value;
      var sizeMax = document.getElementById('sizeMax') && document.getElementById('sizeMax').value;
      var dateFrom = document.getElementById('dateFrom') && document.getElementById('dateFrom').value;
      var dateTo = document.getElementById('dateTo') && document.getElementById('dateTo').value;
      var typeFilter = document.getElementById('typeFilter') && document.getElementById('typeFilter').value;
      var tagMatch = document.getElementById('tagMatchFilter') && document.getElementById('tagMatchFilter').value;
      return { sizeMin, sizeMax, dateFrom, dateTo, typeFilter, tagMatch };
    }

    // Update active filter chips
    function updateActiveFilterChips() {
      var container = document.getElementById('activeFilters');
      if (!container) return;
      var filters = getAdvancedFilters();
      var chips = [];
      if (filters.sizeMin) chips.push('<span class="filter-chip">大小≥' + filters.sizeMin + 'KB</span>');
      if (filters.sizeMax) chips.push('<span class="filter-chip">大小≤' + filters.sizeMax + 'KB</span>');
      if (filters.dateFrom) chips.push('<span class="filter-chip">从' + filters.dateFrom + '</span>');
      if (filters.dateTo) chips.push('<span class="filter-chip">至' + filters.dateTo + '</span>');
      if (filters.typeFilter) chips.push('<span class="filter-chip">类型:' + filters.typeFilter + '</span>');
      if (filters.tagMatch === 'any') chips.push('<span class="filter-chip">标签:任一</span>');
      container.innerHTML = chips.join('');
    }

    // Attach input listeners for filter chips
    ['sizeMin','sizeMax','dateFrom','dateTo','typeFilter','tagMatchFilter'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', updateActiveFilterChips);
    });

    // Apply advanced filters and search
    window.doAdvancedSearch = function() {
      var filters = getAdvancedFilters();
      var hasFilters = filters.sizeMin || filters.sizeMax || filters.dateFrom || filters.dateTo || filters.typeFilter;
      // Update chips
      updateActiveFilterChips();
      // If no text query, just update the regular search with filters
      var q = document.getElementById('searchInput').value.trim();
      if (!q && !hasFilters) return;
      var params = [];
      if (q) params.push('q=' + encodeURIComponent(q));
      if (hasFilters) {
        if (filters.sizeMin) params.push('size_min=' + (parseInt(filters.sizeMin) * 1024));
        if (filters.sizeMax) params.push('size_max=' + (parseInt(filters.sizeMax) * 1024));
        if (filters.dateFrom) params.push('date_from=' + Math.floor(new Date(filters.dateFrom).getTime() / 1000));
        if (filters.dateTo) params.push('date_to=' + Math.floor(new Date(filters.dateTo + 'T23:59:59').getTime() / 1000));
        if (filters.typeFilter) params.push('type=' + filters.typeFilter);
      }
      var tags = document.getElementById('tagFilterSelect') && document.getElementById('tagFilterSelect').value;
      if (tags) params.push('tags=' + encodeURIComponent(tags));
      if (filters.tagMatch === 'any') params.push('tagMatch=any');
      var sort = document.getElementById('sortSelect') && document.getElementById('sortSelect').value;
      var order = document.getElementById('orderSelect') && document.getElementById('orderSelect').value;
      if (sort) params.push('sort=' + sort);
      if (order) params.push('order=' + order);
      var url = '/api/search?' + params.join('&');
      currentSearchQuery = q;
      loadFilesFromUrl(url);
    };

    // Clear advanced filters
    window.clearAdvancedSearch = function() {
      ['sizeMin','sizeMax','dateFrom','dateTo','typeFilter','tagMatchFilter'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
      updateActiveFilterChips();
    };

    // Service Worker registration (PWA offline support)
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
          // SW registration failure is non-fatal
        });

        // WebSocket status manager
        (function wsStatusManager() {
          var chip = document.getElementById('wsStatusChip');
          if (!chip) return;
          var lastSync = Date.now();
          var connected = false;

          function updateChip(status, color) {
            chip.textContent = status;
            chip.style.color = color || '';
          }

          // Try WebSocket connection
          var wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          var wsUrl = wsProtocol + '//' + location.host + '/ws';
          var ws = new WebSocket(wsUrl);

          ws.onopen = function() {
            connected = true;
            lastSync = Date.now();
            updateChip('✅ 已连接', '#10b981');
          };

          ws.onmessage = function(ev) {
            try {
              var msg = JSON.parse(ev.data);
              if (msg.type === 'sync' || msg.type === 'file_update') {
                lastSync = Date.now();
                updateChip('🔄 同步中', '#f59e0b');
                setTimeout(function() { updateChip('✅ 已同步', '#10b981'); }, 2000);
              }
            } catch(e) {}
          };

          ws.onclose = function() {
            connected = false;
            updateChip('⚠️ 离线模式', '#ef4444');
          };

          ws.onerror = function() {
            connected = false;
            updateChip('⚠️ 连接失败', '#ef4444');
          };

          // Heartbeat every 30s
          setInterval(function() {
            if (connected) {
              var age = Math.round((Date.now() - lastSync) / 1000);
              if (age > 10) {
                updateChip('🔄 同步中', '#f59e0b');
              }
            }
          }, 30000);
        })();
      });
    }
  </script>
    <!-- FAB for mobile: trigger file input -->
    <button class="fab" onclick="document.getElementById('fileInput').click()" title="上传文件">+</button>

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
    // Inject dynamic cache version from package.json so SW always uses latest
    const pkg = require('./package.json');
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(/const CACHE_NAME = '[^']+';/, `const CACHE_NAME = 'sharetool-v${pkg.version}';`);
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
    res.end(content);
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
    I18N,
    t,
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

function startCleanupScheduler() {
  // Run cleanup every hour
  const RUN_INTERVAL = 60 * 60 * 1000; // 1 hour
  function runCleanup() {
    try {
      const removedTokens = db.cleanupExpiredTokens();
      const removedSync = db.cleanupSyncLog();
      const removedTrash = db.cleanupExpiredTrash();
      if (removedTokens > 0 || removedSync > 0 || removedTrash > 0) {
        console.log(`[Cleanup] tokens=${removedTokens} sync_log=${removedSync} trash=${removedTrash}`);
      }
    } catch (e) {
      console.error('[Cleanup] Error:', e.message);
    }
    // Prune old file versions across all files (call without fileId to prune all)
    try {
      db.pruneAllFileVersions(10);
    } catch (e) {
      console.error('[Cleanup] pruneFileVersions error:', e.message);
    }
  }
  // Run immediately on startup, then every hour
  runCleanup();
  setInterval(runCleanup, RUN_INTERVAL);
  console.log('[ShareTool] Cleanup scheduler started (every hour)');
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

  // Hourly cleanup scheduler: expired tokens, sync logs, audit logs, trash
  startCleanupScheduler();

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

// Global error handlers — prevent silent crashes
process.on('uncaughtException', (err) => {
  console.error('[ShareTool] Uncaught Exception:', err);
  // Don't exit immediately — let cleanup run
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ShareTool] Unhandled Rejection at:', promise, 'reason:', reason);
});

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
