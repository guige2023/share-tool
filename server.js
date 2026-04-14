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
const DEFAULT_TOKEN='35e743...5af6';
const LOCAL_IP = getLocalIp();
const BASE_URL = `https://${LOCAL_IP}:${HTTPS_PORT}`;

let config = loadConfig();
let SHARE_TOKEN=process.env.SHARE_TOKEN || config.shareToken || DEFAULT_TOKEN;
function getShareToken() { return SHARE_TOKEN; }

db.initDatabase();
db.cleanupExpiredShareLinks();

// Token rotation - generates 48-char random token, persists to config
let RUNTIME_TOKEN = null; // set at runtime when rotating
function getEffectiveToken() { return RUNTIME_TOKEN || SHARE_TOKEN; }
function rotateShareToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let newTok = '';
  for (let i = 0; i < 48; i++) newTok += chars[Math.floor(Math.random() * chars.length)];
  RUNTIME_TOKEN = newTok;
  config.shareToken = newTok;
  saveConfig();
  return newTok;
}
global.rotateShareToken = rotateShareToken;
global.getEffectiveToken = getEffectiveToken;

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
  const token = req.headers['x-auth-token'] || '';
  const effective = getEffectiveToken();
  // Static token (original or rotated runtime) always valid
  if (token === SHARE_TOKEN || token === effective) {
    return { token: effective, type: 'static' };
  }
  // Check for Bearer token against static token
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7);
    if (bearerToken === SHARE_TOKEN || bearerToken === effective) {
      return { token: effective, type: 'static' };
    }
    // Also check dynamic tokens table
    const valid = db.validateToken(bearerToken);
    if (valid) {
      return { token: bearerToken, type: 'dynamic', deviceId: valid.device_id };
    }
  }
  // Dynamic token from tokens table
  if (token) {
    const valid = db.validateToken(token);
    if (valid) {
      return { token, type: 'dynamic', deviceId: valid.device_id };
    }
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
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
  let expiresAt;
  if (options.customExpiry) {
    expiresAt = options.customExpiry;
  } else {
    const hours = options.expiryHours === undefined || options.expiryHours === null || options.expiryHours === ''
      ? 168
      : parseInt(options.expiryHours, 10);
    expiresAt = hours > 0 ? now + hours * 60 * 60 * 1000 : 0;
  }
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
    [data-theme="dark"] #pull-indicator{background:#0f766e}
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
    /* Mobile: smooth scrolling + overscroll + tap highlight */
    html,body{height:100%;overscroll-behavior:none;-webkit-tap-highlight-color:transparent}
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
    .filter-chip{background:var(--accent-weak);border:1px solid var(--accent);color:var(--accent);border-radius:999px;padding:3px 10px;font-size:11px;white-space:nowrap}
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
    .sort-arrow,.share-sort-arrow,.rl-sort-arrow{font-size:10px;color:var(--muted);margin-left:2px}
    .sort-arrow.active,.share-sort-arrow.active,.rl-sort-arrow.active{color:var(--accent);font-weight:bold}
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
      /* Mobile tag chips: smaller and no max-width so they wrap nicely */
      .file-tags{max-width:none;gap:3px}
      .file-tags .tag-badge,.file-tags .tag-chip{font-size:10px;padding:1px 5px;border-radius:8px}
      /* Context menu: larger touch targets on mobile */
      .ctx-menu{min-width:180px}
      /* Sticky toolbar on mobile scroll */
      .panel:first-of-type{position:sticky;top:0;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,.1)}
      /* Hero section compact on mobile */
      .hero .meta{gap:6px}
      .hero .chip{padding:5px 8px;font-size:10px}
      .hero p{display:none}
      /* Mobile: hide hero subtitle too on very small screens */
      @media(max-width:400px){
        .hero .meta .chip:nth-child(n+4){display:none}
      }
      /* Touch-friendly: increase tap targets */
      button,.ctx-item{padding:10px 14px}
      /* Hide less-used toolbar buttons on small screens, show via FAB+menu */
      #advancedSearchBtn,#downloadSelected,#openTagManager,#deleteAllFiles,#trashBtn,#installPwaBtn{display:none}
      #openDuplicates{display:none!important}
      /* iOS auto-zoom fix: all inputs must be >=16px */
      input,select,textarea{font-size:16px!important}
      /* Prevent double-tap zoom on buttons */
      button{touch-action:manipulation}
      /* Mobile: files panel scrolls vertically */
      #filesPanel{max-height:calc(100vh - 200px);overflow-y:auto}
      /* Mobile: drop zone is the primary upload affordance - make it prominent */
      .drop-zone{padding:24px 16px;font-size:14px}
      .drop-zone-inner p{margin:4px 0}
      /* Mobile bottom nav: show on small screens, add bottom padding to avoid overlap */
      #mobileNav{display:none!important}
      .mobile-nav-btn.active{background:var(--bg-tertiary)!important;border-radius:10px}
      @media(max-width:600px){
        #mobileNav{display:flex!important}
        .wrap{padding-bottom:calc(70px + env(safe-area-inset-bottom, 0px))}
        .panel{margin-bottom:0}
        /* Toolbar: sticky with safe-area top for notched phones */
        .toolbar{position:sticky;top:0;z-index:100;background:var(--bg);padding-top:max(8px,env(safe-area-inset-top));padding-right:max(12px,env(safe-area-inset-right));padding-left:max(12px,env(safe-area-inset-left))}
        /* Show/hide panels based on mobile nav state */
        #filesPanel.mobile-hidden,
        #uploadSection.mobile-hidden,
        .shares.mobile-hidden,
        .request-links.mobile-hidden{display:none!important}
      }
      /* Prevent iOS from auto-zooming on inputs inside toolbar/search */
      .toolbar input{font-size:16px!important}
      #searchInput{min-height:44px;padding:8px 40px 8px 12px;border-radius:10px}
      #searchClear{width:32px;height:32px;display:flex!important;align-items:center;justify-content:center;top:50%;transform:translateY(-50%);font-size:14px}
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
      #tagFilterWrapper{flex:1 1 100%;max-width:160px}
      .tag-filter-item:hover{background:var(--bg-tertiary)}
      .tag-filter-item.active{background:var(--accent-weak);color:var(--accent)}
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
      /* File batch bar */
      #fileBatchBar{overflow-x:auto;justify-content:flex-start!important;padding:8px 12px!important;gap:6px;flex-wrap:nowrap;white-space:nowrap}
      #fileBatchBar button{min-height:36px;padding:7px 12px;font-size:12px;white-space:nowrap;flex-shrink:0}
      #fileBatchCount{white-space:nowrap;font-size:12px;flex-shrink:0}
      .file-check{margin:0}
      /* Mobile: shares/request-links tables — horizontal scroll */
      .shares .list-scroll,.request-links .list-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
      .shares .list-scroll table,.request-links .list-scroll table{min-width:600px}
      /* Mobile: RL batch bar also scrolls */
      #rlBatchBar{overflow-x:auto;justify-content:flex-start!important;padding:8px 12px!important;gap:6px;flex-wrap:nowrap;white-space:nowrap}
      #rlBatchBar button{min-height:36px;padding:7px 12px;font-size:12px;white-space:nowrap;flex-shrink:0}
      /* Mobile modal: full-screen preview */
      .modal-card{width:100%;max-height:100vh;height:100vh;border-radius:0;padding:12px;padding-top:max(12px,env(safe-area-inset-top));padding-bottom:max(12px,env(safe-area-inset-bottom));padding-left:max(12px,env(safe-area-inset-left));padding-right:max(12px,env(safe-area-inset-right))}
      .modal{padding:0}
      /* Mobile: batch bar pinned to bottom, above FAB */
      #batchBar,#fileBatchBar,#rlBatchBar{position:fixed;bottom:max(76px,calc(70px + env(safe-area-inset-bottom)));left:0;right:0;z-index:8888;background:var(--bg);box-shadow:0 -2px 12px rgba(0,0,0,.1);border-radius:0}
      body{padding-bottom:max(130px,calc(130px + env(safe-area-inset-bottom)))}
      /* Mobile: unified search overlay full-width */
      #unifiedSearchOverlay{padding-top:20px!important}
      #unifiedSearchOverlay > div{max-width:100%!important;border-radius:0!important;max-height:90vh!important}
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
    .back-to-top{position:fixed;right:20px;bottom:max(88px,calc(20px + env(safe-area-inset-bottom)));width:44px;height:44px;border-radius:50%;background:var(--btn-secondary-bg,#e2e7ee);color:var(--text);border:none;cursor:pointer;font-size:18px;z-index:199;box-shadow:0 2px 8px rgba(0,0,0,.12);display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .2s}
    .back-to-top.visible{opacity:1;pointer-events:auto}
    [data-theme="dark"] .back-to-top{background:#334155;color:#f1f5f9}
    /* Pull-to-refresh indicator */
    #pull-indicator{position:fixed;top:0;left:0;right:0;height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--accent);color:#fff;font-size:13px;font-weight:500;z-index:999;transition:height .2s}
    #pull-indicator .spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:ptr-spin .8s linear infinite;margin-right:6px}
    @keyframes ptr-spin{to{transform:rotate(360deg)}}
    /* Offline indicator banner */
    #offline-banner{display:none;align-items:center;justify-content:center;gap:6px;background:#92400e;color:#fff;font-size:13px;font-weight:500;padding:8px 16px;text-align:center}
    #offline-banner.visible{display:flex}
    @media(max-width:600px){#offline-banner{position:sticky;top:0;z-index:200}}
    .file-tags{display:flex;flex-wrap:wrap;gap:3px;max-width:110px}
    .tag-badge{background:#e0e7ff;color:#3730a3;font-size:10px;padding:1px 6px;border-radius:10px;font-weight:500}
    .type-chip.active{background:var(--accent)!important;color:#fff!important;border-color:var(--accent)!important}
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
    #fileTable tr.dragging td{opacity:.4;background:var(--bg-tertiary)}
    #fileTable tr.drag-over td:first-child{border-left:3px solid var(--accent);padding-left:calc(var(--td-padding) - 3px)}
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
    /* Mobile shares/request-links table scroll */
    @media(max-width:768px){
      section.shares table,section.request-links table{min-width:600px}
      section.shares .list-scroll,section.request-links .list-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
      .share-sort-arrow,.share-sort-arrow.active,.rl-sort-arrow,.rl-sort-arrow.active{color:var(--accent)}
      section.shares td,section.request-links td{text-align:left}
      section.shares td[data-label]:not(:empty)::before,section.request-links td[data-label]:not(:empty)::before{
        content:attr(data-label);display:block;font-size:11px;color:var(--muted);font-weight:600;margin-bottom:2px}
    }
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
  <div id="pull-indicator"><span class="spinner"></span>下拉刷新...</div>
  <div id="ctxMenu" style="display:none;position:fixed;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10000;min-width:160px;overflow:hidden;font-size:14px">
    <div class="ctx-item" onclick="ctxAction('open')">👁 查看</div>
    <div class="ctx-item" onclick="ctxAction('download')">⬇ 下载</div>
    <div class="ctx-item" onclick="ctxAction('share')">🔗 分享</div>
    <div class="ctx-item" onclick="ctxAction('copyLink')">📋 复制链接</div>
    <div class="ctx-item" onclick="ctxAction('copyName')">📝 复制文件名</div>
    <div class="ctx-item" onclick="ctxAction('copyPath')">📂 复制文件路径</div>
    <div class="ctx-item" onclick="ctxAction('openInFinder')">🔍 在 Finder 中打开</div>
    <div class="ctx-item" onclick="ctxAction('history')">📜 版本历史</div>
    <div class="ctx-item" onclick="ctxAction('stats')">📊 访问统计</div>
    <div class="ctx-item" onclick="ctxAction('info')">ℹ️ 文件属性</div>
    <div class="ctx-item ctx-star" data-starred="0" onclick="ctxAction('addToVF')">⭐ 添加到收藏夹</div>
    <div class="ctx-item ctx-star" data-starred="1" onclick="ctxAction('removeFromVF')" style="display:none">⭐ 从收藏移除</div>
    <div class="ctx-item" onclick="ctxAction('addTags')">🏷️ 添加标签</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" onclick="ctxAction('rename')">✎ 重命名</div>
    <div class="ctx-item" onclick="ctxAction('delete')" style="color:var(--danger)">🗑 删除</div>
  </div>
  <div class="wrap">
    <div id="offline-banner" role="alert">📵 当前处于离线状态，部分功能可能不可用</div>
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
        <button id="notifBell" onclick="toggleNotificationPanel()" title="通知" style="background:var(--bg-secondary);border:1px solid var(--line);border-radius:12px;padding:6px 10px;cursor:pointer;font-size:16px;position:relative;line-height:1">🔔<span id="notifBadge" style="display:none;position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;border-radius:999px;font-size:10px;min-width:16px;height:16px;display:flex;align-items:center;justify-content:center;padding:0 4px;font-weight:bold;line-height:1"></span></button>
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

    <section id="notifPanel" class="panel" style="display:none;margin-top:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <h3 style="margin:0">通知</h3>
        <div style="display:flex;gap:6px">
          <button class="ghost" onclick="markAllNotificationsRead()" style="font-size:12px;padding:4px 8px">全部已读</button>
          <button class="ghost" onclick="clearAllNotifications()" style="font-size:12px;padding:4px 8px;color:var(--danger)">清空</button>
          <button class="ghost" onclick="toggleNotificationPanel()" style="font-size:12px;padding:4px 8px">关闭</button>
        </div>
      </div>
      <div id="notifList" style="max-height:320px;overflow-y:auto"></div>
      <div id="notifEmpty" class="empty" style="display:none">暂无通知</div>
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
        <p class="muted">支持同时选择多个文件、整个文件夹（保留结构），也可拖拽文件到此处。按 Shift+N 新建文件夹，n 新建文本。</p>
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
            <button class="secondary" onclick="openUploadFromUrlModal()">🌐 URL上传</button>
            <button class="secondary" onclick="openNewFolderModal()">📁 新建文件夹</button>
            <button class="secondary" onclick="openNewTextFileModal()">📝 新建文本</button>
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
        <div class="uq-title" style="padding:8px 14px;font-size:12px;font-weight:600;border-bottom:1px solid var(--line);background:var(--bg-tertiary);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span>上传队列</span>
          <span id="offlinePendingBadge" style="display:none;background:#f59e0b;color:#fff;border-radius:999px;font-size:10px;padding:1px 6px;font-weight:600;vertical-align:middle" title="离线待同步"></span>
        </div>
        <div class="uq-list" style="max-height:200px;overflow-y:auto;padding:0 14px"></div>
      </div>
    </div>

    <section class="panel" style="margin-top:18px">
      <div class="toolbar">
        <input id="searchInput" type="text" placeholder="按文件名搜索 (/ 聚焦)" autocomplete="off" inputmode="search" autocorrect="off" spellcheck="false" aria-label="搜索文件" style="padding-right:56px" onfocus="if(getRecentSearches().length>0){document.getElementById('recentSearches').style.display='block'}" oninput="document.getElementById('recentSearches').style.display='none'">
        <span id="searchModeBadge" onclick="cycleSearchMode()" style="position:absolute;right:32px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--accent);font-size:11px;font-weight:700;user-select:none;display:none;padding:2px 5px;border:1px solid var(--accent);border-radius:5px;opacity:0.8" title="点击切换搜索模式 (普通/Glob/正则)">Aa</span>
        <span id="searchClear" onclick="clearSearchInput()" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--muted);font-size:16px;line-height:1;display:none;user-select:none" title="清除搜索">✕</span>
        <div id="tagFilterWrapper" style="position:relative;max-width:160px">
          <input id="tagFilterInput" type="text" placeholder="全部标签" autocomplete="off"
            style="padding:6px 28px 6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);font-size:13px;width:100%;box-sizing:border-box"
            onfocus="openTagFilterDropdown()" oninput="filterTagFilterDropdown()" onkeydown="handleTagFilterKeydown(event)">
          <span id="tagFilterClear" onclick="clearTagFilter()" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--muted);font-size:12px;display:none;user-select:none" title="清除标签">✕</span>
          <div id="tagFilterDropdown" style="display:none;position:absolute;top:calc(100%+4px);left:0;right:0;background:var(--bg-secondary);border:1px solid var(--line);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:1000;max-height:220px;overflow:auto;font-size:13px">
            <div id="tagFilterList"></div>
          </div>
        </div>
        <div style="position:relative">
          <button id="sortDropdownBtn" class="ghost" onclick="toggleSortDropdown()" title="排序方式" style="min-width:90px;font-size:13px">\
            <span id="sortDropdownLabel">↕ 更新时间</span>\
          </button>\
          <div style="display:flex;gap:2px;margin-left:2px">\
            <button id="qs-updated" onclick="setSortFromDropdown('updated_at','desc')" title="最新优先" style="padding:4px 8px;font-size:11px;border-radius:6px;border:none;cursor:pointer;background:var(--bg-tertiary);color:var(--muted)">↕</button>\
            <button id="qs-name" onclick="setSortFromDropdown('filename','asc')" title="名称 A-Z" style="padding:4px 8px;font-size:11px;border-radius:6px;border:none;cursor:pointer;background:var(--bg-tertiary);color:var(--muted)">A↓</button>\
            <button id="qs-size" onclick="setSortFromDropdown('size','desc')" title="最大优先" style="padding:4px 8px;font-size:11px;border-radius:6px;border:none;cursor:pointer;background:var(--bg-tertiary);color:var(--muted)">⬇</button>\
            <button id="qs-type" onclick="setSortFromDropdown('type','asc')" title="按类型" style="padding:4px 8px;font-size:11px;border-radius:6px;border:none;cursor:pointer;background:var(--bg-tertiary);color:var(--muted)">📂</button>\
          </div>\
          <div id="sortDropdownMenu" style="display:none;position:absolute;top:calc(100%+4px);left:0;z-index:1000;background:var(--bg-secondary);border:1px solid var(--line);border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:160px;padding:6px 0;font-size:13px">\
            <div class="ctx-item" onclick="setSortFromDropdown('updated_at','desc')" id="sortItem-updated_at-desc">↕ 最新优先</div>\
            <div class="ctx-item" onclick="setSortFromDropdown('updated_at','asc')" id="sortItem-updated_at-asc">↑ 最旧优先</div>\
            <div class="ctx-item" onclick="setSortFromDropdown('filename','asc')" id="sortItem-filename-asc">A↕ 名称 A-Z</div>\
            <div class="ctx-item" onclick="setSortFromDropdown('filename','desc')" id="sortItem-filename-desc">Z↕ 名称 Z-A</div>\
            <div class="ctx-item" onclick="setSortFromDropdown('size','desc')" id="sortItem-size-desc">⬇ 最大优先</div>\
            <div class="ctx-item" onclick="setSortFromDropdown('size','asc')" id="sortItem-size-asc">⬆ 最小优先</div>\
            <div class="ctx-item" onclick="setSortFromDropdown('created_at','desc')" id="sortItem-created_at-desc">🕐 最新创建</div>\
            <div class="ctx-item" onclick="setSortFromDropdown('created_at','asc')" id="sortItem-created_at-asc">🕐 最旧创建</div>\
            <div class="ctx-item" onclick="setSortFromDropdown('type','asc')" id="sortItem-type-asc">📂 类型</div>\
            <div style="border-top:1px solid var(--line);margin:4px 0"></div>\
            <div class="ctx-item" onclick="setSortFromDropdown('position','asc')" id="sortItem-position-asc">📌 手动排序</div>\
            <div style="border-top:1px solid var(--line);margin:4px 0"></div>\
            <div class="ctx-item" onclick="showRecentFiles()" id="sortItem-recent" style="color:var(--accent);font-weight:500">🕐 最近访问</div>\
          </div>\
        </div>
        <button id="vfBtn" class="ghost" onclick="toggleVirtualFolderMenu()" title="收藏夹">⭐</button>
        <div id="vfMenu" style="display:none;position:absolute;z-index:1000;background:var(--bg-secondary);border:1px solid var(--line);border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:180px;padding:6px 0;font-size:13px;margin-top:4px">
          <div id="vfMenuList"></div>
          <div style="border-top:1px solid var(--line);margin:4px 0"></div>
          <div class="ctx-item" onclick="openVirtualFolderManager()" style="color:var(--accent)">⚙ 管理收藏夹</div>
        </div>
        <nav id="breadcrumb" aria-label="导航路径" style="display:none;align-items:center;gap:4px;font-size:13px;padding:6px 10px;background:var(--bg-secondary);border-radius:10px;border:1px solid var(--line);flex-shrink:0">
          <span style="cursor:pointer;color:var(--accent);font-weight:500" onclick="exitVirtualFolder()" title="返回全部文件">全部文件</span>
        </nav>
        <button onclick="loadFiles()">刷新</button>
        <button id="autoRefreshBtn" class="ghost" onclick="toggleAutoRefresh()" title="自动刷新 (每30秒)" style="font-size:12px">🔁</button>
        <button class="secondary" onclick="searchFiles()">搜索</button>
        <button class="ghost" onclick="openStorageStats()" title="存储统计">📊</button>
        <button class="ghost" onclick="openSyncDashboard()" title="同步面板 (z)">🔄</button>
        <button class="ghost" onclick="toggleTheme()" title="切换主题" id="themeToggleBtn">🌙</button>
        <button class="ghost" onclick="openSettings()" title="设置 (Ctrl+,)">⚙</button>
        <button class="ghost" onclick="openKeyboardHelp()" title="键盘快捷键 (?)">?</button>
        <button id="installPwaBtn" class="secondary" style="display:none" onclick="installPWA()">安装应用</button>
        <button id="advancedSearchBtn" class="ghost" onclick="toggleAdvancedSearch()">高级 ⌄</button>
        <button id="downloadSelected" class="ghost" onclick="downloadSelected()">打包下载选中项</button>
        <button id="openTagManager" class="secondary" onclick="openTagManager()">标签管理</button>
        <button class="ghost" onclick="openDuplicates()" title="查找重复文件">🔁 重复</button>
        <button class="secondary" onclick="openDashboard()">📊 存储分析</button>
        <button id="trashBtn" class="ghost" onclick="openTrash()">回收站</button>
        <button id="deleteAllFiles" class="danger" onclick="deleteAllFiles()">删除全部</button>
        <div class="view-toggle">
          <input type="checkbox" id="gridSelectAll" onchange="toggleFileSelectAll(this.checked)" style="display:none;margin-right:6px;cursor:pointer" title="全选">
          <button id="viewListBtn" class="active" onclick="setView('list')" title="列表视图">☰</button>
          <button id="viewGridBtn" onclick="setView('grid')" title="网格视图">⊞</button>
        </div>
      </div>
      <div id="recentSearches" style="display:none;margin-bottom:10px;flex-wrap:wrap;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch"></div>
      <div id="searchResultsBar" style="display:none;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:8px;padding:8px 14px;margin-bottom:8px;font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:10px"></div>
      <div id="typeFilterBar" style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center;overflow-x:auto;-webkit-overflow-scrolling:touch">
        <button class="type-chip active" data-type="" onclick="setTypeFilter('')">全部</button>
        <button class="type-chip" data-type="starred" onclick="setTypeFilter('starred')">⭐ 星标</button>
        <button class="type-chip" data-type="image" onclick="setTypeFilter('image')">🖼️ 图片</button>
        <button class="type-chip" data-type="video" onclick="setTypeFilter('video')">🎬 视频</button>
        <button class="type-chip" data-type="audio" onclick="setTypeFilter('audio')">🎵 音频</button>
        <button class="type-chip" data-type="pdf" onclick="setTypeFilter('pdf')">📕 PDF</button>
        <button class="type-chip" data-type="document" onclick="setTypeFilter('document')">📄 文档</button>
        <button class="type-chip" data-type="archive" onclick="setTypeFilter('archive')">📦 压缩</button>
        <button class="type-chip" data-type="text" onclick="setTypeFilter('text')">📝 文本</button>
        <button class="type-chip" data-type="recent" onclick="setTypeFilter('recent')">🕐 最近</button>
      </div>
      <div id="tagChipsBar" style="display:none;flex-wrap:wrap;gap:6px;margin-bottom:8px;align-items:center"></div>
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
      <div id="folderTagFilterBar" style="display:none;margin-bottom:4px"></div>
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
              <option value="document">文档</option>
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
      <div id="searchResultChip" style="display:none;background:var(--bg-secondary);border:1px solid var(--line);border-radius:8px;padding:6px 12px;margin-bottom:8px;align-items:center;gap:6px"></div>
      <div id="searchSuggestions" style="position:relative;z-index:100;display:none;background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:10px;overflow:hidden;box-shadow:var(--shadow)"></div>
      <div id="savedSearchesPanel" style="display:none;background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:10px;overflow:hidden;box-shadow:var(--shadow)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line)">
          <span style="font-size:12px;font-weight:600;color:var(--text)">\u5DF2\u4FDD\u5B58\u7684\u641C\u7D22</span>
          <div style="display:flex;gap:6px">
            <button onclick="saveCurrentSearch()" class="ghost" style="font-size:11px;padding:3px 8px">\u4FDD\u5B58\u5F53\u524D</button>
            <button onclick="closeSavedSearchesPanel()" class="ghost" style="font-size:14px;padding:3px 8px">✕</button>
          </div>
        </div>
        <div id="savedSearchesList"></div>
      </div>
      <div id="batchBar" class="batch-bar" style="display:none">
        <span id="batchCount" style="font-size:13px;color:var(--muted)"></span>
        <span id="batchInfo" style="font-size:12px;color:var(--muted);margin-left:8px"></span>
        <div style="flex:1"></div>
        <button class="ghost" onclick="toggleInvertSelection()">反选</button>
        <button class="ghost" onclick="openBatchTagModal()">添加标签</button>
        <button class="ghost" onclick="openBatchRemoveTagModal()">移除标签</button>
        <button class="ghost" onclick="batchToggleStar()">⭐ 收藏</button>
        <button class="ghost" onclick="openBatchRenameModal()">批量重命名</button>
        <button class="ghost" onclick="openBatchCreateShareModal()">🔗 分享链接</button>
        <button class="ghost" onclick="openBatchMoveModal()">📁 移动</button>
        <button class="ghost" onclick="openBatchCopyModal()">📋 复制</button>
        <button class="ghost" onclick="batchDownloadSelected()">📦 下载 ZIP</button>
        <button class="ghost" onclick="batchDeleteSelected()">删除</button>
        <button class="ghost" onclick="clearSelection()">取消选择</button>
      </div>
      <div id="fileBatchBar" class="batch-bar" style="display:none">
        <input type="checkbox" id="fileSelectAllTop" onchange="toggleFileSelectAll(this.checked)" style="margin-right:4px">
        <span id="fileBatchCount" style="font-size:13px;color:var(--muted)"></span>
        <button class="ghost" onclick="batchMoveSelectedFiles()">移动</button>
        <button class="ghost" onclick="openBatchCopyModal()">复制</button>
        <button class="ghost danger" onclick="batchDeleteSelected()">删除</button>
        <button class="ghost" onclick="openBatchStatsModal()">📊 统计</button>
        <button class="ghost" onclick="clearFileSelection()">取消</button>
      </div>
      <div class="list-scroll">
        <table id="fileTable">
          <thead>
            <tr>
              <th style="width:42px"><input type="checkbox" id="selectAll" onchange="toggleFileSelectAll(this.checked)"></th>
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
        <button class="ghost" onclick="openShareAnalytics()">📈 分析</button>
        <button class="ghost" onclick="openExpiringShares()">⏰ 过期提醒</button>
        <button class="danger" onclick="batchDeleteExpiredShares()">删除过期</button>
        <input id="shareSearchInput" type="text" placeholder="搜索分享链接..." oninput="filterShareTable()" style="margin-left:auto;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);font-size:13px;max-width:180px"> <span id="shareResultCount" style="font-size:12px;color:var(--muted);white-space:nowrap"></span>
      </div>
      <div id="shareBatchBar" class="batch-bar" style="display:none">
        <input type="checkbox" id="shareSelectAll" onchange="toggleShareSelectAll(this.checked)" style="margin-right:4px">
        <span id="shareBatchCount" style="font-size:13px;color:var(--muted)"></span>
        <button class="ghost" onclick="batchCopySelectedShares()">复制链接</button>
        <button class="ghost" onclick="batchDownloadSelectedQrs()">下载二维码</button>
        <button class="ghost" onclick="openBatchShareUpdateModal()">批量更新</button>
        <button class="ghost" onclick="batchDeleteSelectedShares()">删除选中</button>
        <button class="ghost" onclick="clearShareSelection()">取消选择</button>
      </div>
      <div id="shareQuickFilters" style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center"></div>
      <div class="list-scroll">
        <table>
          <thead>
            <tr>
              <th style="width:36px" data-label=""><input type="checkbox" id="shareListSelectAll" onchange="toggleShareSelectAll(this.checked)"></th>
              <th data-label="文件" style="cursor:pointer;user-select:none" onclick="setShareSort('filename')">文件 <span class="share-sort-arrow" id="shareArrow-filename"></span></th>
              <th data-label="链接">链接</th>
              <th data-label="二维码" style="width:110px">二维码</th>
              <th data-label="到期" style="cursor:pointer;user-select:none" onclick="setShareSort('expiresAt')">到期 <span class="share-sort-arrow" id="shareArrow-expiresAt"></span></th>
              <th data-label="创建" style="cursor:pointer;user-select:none" onclick="setShareSort('createdAt')">创建 <span class="share-sort-arrow" id="shareArrow-createdAt"></span></th>
              <th data-label="访问">访问</th>
              <th data-label="下载">下载</th>
              <th data-label="总计" style="cursor:pointer;user-select:none" onclick="setShareSort('totalActivity')">总计 <span class="share-sort-arrow" id="shareArrow-totalActivity"></span></th>
              <th data-label="操作" style="width:100px">操作</th>
            </tr>
          </thead>
          <tbody id="shareTable"></tbody>
        </table>
        <div id="shareEmpty" class="empty" style="display:none">还没有创建分享链接</div>
      </div>
    </section>

    <!-- Mobile Bottom Navigation Bar -->
    <nav id="mobileNav" style="display:none;position:fixed;bottom:0;left:0;right:0;background:var(--bg-secondary);border-top:1px solid var(--line);z-index:900;padding:6px 0 env(safe-area-inset-bottom, 8px)">
      <div style="display:flex;justify-content:space-around;align-items:center">
        <button class="mobile-nav-btn active" data-panel="files" onclick="switchMobileNav('files')" style="background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 12px;color:var(--accent);font-size:10px;cursor:pointer;border-radius:10px">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span>文件</span>
        </button>
        <button class="mobile-nav-btn" data-panel="upload" onclick="switchMobileNav('upload')" style="background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 12px;color:var(--muted);font-size:10px;cursor:pointer;position:relative">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <span>上传</span>
          <span id="mobileUploadBadge" style="display:none;position:absolute;top:2px;right:8px;background:#ef4444;color:#fff;border-radius:10px;font-size:9px;padding:1px 4px;line-height:1.2;font-weight:700;min-width:16px;text-align:center"></span>
        </button>
        <button class="mobile-nav-btn" data-panel="shares" onclick="switchMobileNav('shares')" style="background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 12px;color:var(--muted);font-size:10px;cursor:pointer">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          <span>分享</span>
        </button>
        <button class="mobile-nav-btn" data-panel="rl" onclick="switchMobileNav('rl')" style="background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 12px;color:var(--muted);font-size:10px;cursor:pointer">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          <span>收集</span>
        </button>
        <button class="mobile-nav-btn" data-panel="settings" onclick="switchMobileNav('settings')" style="background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 12px;color:var(--muted);font-size:10px;cursor:pointer">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
          <span>设置</span>
        </button>
      </div>
    </nav>

    <section class="panel request-links" style="margin-top:18px">
      <h2>文件收集链接</h2>
      <div class="toolbar" style="margin-bottom:12px;flex-wrap:wrap;gap:6px">
        <input id="requestLinkSearchInput" type="text" placeholder="搜索收集链接" oninput="filterRequestLinks()" style="flex:1 1 180px">
        <select id="rlStatusFilter" onchange="filterRequestLinks()" style="padding:4px 8px;border-radius:6px;border:1px solid var(--border)">
          <option value="">全部</option>
          <option value="active">● 有效</option>
          <option value="inactive">○ 已停用</option>
        </select>
        <button class="primary" onclick="openRequestLinkCreateModal()">+ 新建收集链接</button>
      </div>
      <div id="rlBatchBar" class="batch-bar" style="display:none">
        <input type="checkbox" id="rlSelectAll" onchange="toggleRlSelectAll(this.checked)" style="margin-right:4px">
        <span id="rlBatchCount" style="font-size:13px;color:var(--muted)"></span>
        <button class="ghost" onclick="batchCopySelectedRl()">复制链接</button>
        <button class="ghost" onclick="batchDownloadSelectedRlQrs()">下载二维码</button>
        <button class="ghost danger" onclick="batchDeleteSelectedRl()">删除选中</button>
        <button class="ghost" onclick="clearRlSelection()">取消选择</button>
      </div>
      <div class="list-scroll">
        <table>
          <thead>
            <tr>
              <th style="width:28px"><input type="checkbox" id="rlListSelectAll" onchange="toggleRlSelectAll(this.checked)" style="margin:0"></th>
              <th data-label="名称" style="cursor:pointer;user-select:none" onclick="setRlSort('name')">名称 <span class="rl-sort-arrow" id="rlArrow-name"></span></th>
              <th data-label="链接">链接</th>
              <th data-label="创建时间" style="cursor:pointer;user-select:none" onclick="setRlSort('created_at')">创建时间 <span class="rl-sort-arrow" id="rlArrow-created_at"></span></th>
              <th data-label="已收" style="cursor:pointer;user-select:none" onclick="setRlSort('upload_count')">已收 <span class="rl-sort-arrow" id="rlArrow-upload_count"></span></th>
              <th data-label="状态" style="width:130px">状态</th>
              <th data-label="操作" style="width:130px">操作</th>
            </tr>
          </thead>
          <tbody id="requestLinkTable"></tbody>
        </table>
        <div id="requestLinkEmpty" class="empty" style="display:none">还没有创建收集链接</div>
      </div>
    </section>

    <section class="panel duplicates" style="margin-top:18px">
      <h2>重复文件</h2>
      <div class="toolbar" style="margin-bottom:12px">
        <button class="secondary" onclick="loadDuplicates()">刷新</button>
        <button class="danger" id="duplicatesDeleteBtn" style="display:none" onclick="deleteSelectedDuplicates()">删除选中 (0)</button>
      </div>
      <div id="duplicatesList"></div>
      <div id="duplicatesEmpty" class="empty" style="display:none">没有发现重复文件</div>
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
            <option value="share_update">分享更新</option>
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
        <strong id="modalTitle" style="cursor:pointer" title="点击定位到文件列表中" onclick="jumpToFileFromModal()">预览</strong>
        <button class="secondary" onclick="forceCloseModal()">关闭</button>
      </div>
      <div id="modalBody"></div>
      <div class="modal-actions"></div>
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
    var _loadSeq = 0;  // sequence counter for stale response protection
    var _activeController = null;  // AbortController for in-flight requests
    var _cachedTagData = null;  // tags cache — invalidated on file create/update/delete

    function headers(extra) {
      return Object.assign({ 'x-auth-token': getToken() }, extra || {});
    }

    async function request(url, options) {
      try {
      const response = await fetch(url, Object.assign({}, options || {}, {
        headers: headers((options && options.headers) || {}),
        signal: (options || {}).signal || null
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
      } catch (e) {
        if (e.name === 'AbortError') return null;  // silently ignore aborted requests
        throw e;
      }
    }

    // Check for expiring share/request links and add notifications
    async function checkExpiringLinks() {
      try {
        var data = await request('/api/expiring-links');
        if (!data || !data.success) return;
        var items = data.items || [];
        if (!items.length) return;
        // Only notify once per day (store check date in localStorage)
        var today = new Date().toISOString().slice(0, 10);
        var lastCheck = localStorage.getItem('lastExpirNotifCheck') || '';
        if (lastCheck === today) return;
        localStorage.setItem('lastExpirNotifCheck', today);
        // Post each expiring item as a notification
        var urgent = items.filter(function(i) { return i.hoursLeft <= 24; });
        var warning = items.filter(function(i) { return i.hoursLeft > 24; });
        if (urgent.length > 0) {
          var urgentMsg = urgent.map(function(i) { return i.message; }).join('；');
          await request('/api/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'expiry_urgent', title: '⚠️ 链接即将过期', message: urgentMsg })
          });
        }
        if (warning.length > 0) {
          var warningMsg = warning.map(function(i) { return i.message; }).join('；');
          await request('/api/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'expiry', title: '🔔 链接到期提醒', message: warningMsg })
          });
        }
        // Update badge
        var countData = await request('/api/notifications/unread-count');
        var badge = document.getElementById('notifBadge');
        if (badge) {
          var count = countData.unread_count || 0;
          if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.style.display = 'flex';
          } else {
            badge.style.display = 'none';
          }
        }
      } catch (e) {}
    }

    // Init auth on page load
    initAuth().then(function() {
      loadFiles();
      loadShares();
      updateSortDropdownLabel();
      updateSortDropdownActive();
      updateQuickSortButtons();
      loadStorageStats();
      setupInfiniteScroll();
      showWelcomeIfNeeded();
      checkExpiringLinks();

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

    // ── Theme Toggle ────────────────────────────────────────────────────
    var THEME_KEY = 'sharetool_theme';

    function setTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem(THEME_KEY, theme);
      var btn = document.getElementById('themeToggleBtn');
      if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    }

    function toggleTheme() {
      var current = document.documentElement.getAttribute('data-theme');
      setTheme(current === 'dark' ? 'light' : 'dark');
    }

    // Apply saved theme on load
    (function() {
      var saved = localStorage.getItem(THEME_KEY);
      if (saved) setTheme(saved);
    })();

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
      var info = document.getElementById('batchInfo');
      var selectAll = document.getElementById('selectAll');
      if (!bar || !count) return;
      if (names.length > 0) {
        bar.style.display = 'flex';
        count.textContent = '已选择 ' + names.length + ' 个文件';
        // Compute aggregate size and type breakdown for selected files
        var selectedFiles = names.map(function(n) {
          var decoded = decodeURIComponent(n);
          return currentFiles.find(function(f) { return f.name === decoded; });
        }).filter(Boolean);
        if (selectedFiles.length > 0 && info) {
          var totalSize = selectedFiles.reduce(function(s, f) { return s + (f.size || 0); }, 0);
          var fmtSize = function(b) {
            if (b < 1024) return b + ' B';
            if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
            if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
            return (b/1073741824).toFixed(2) + ' GB';
          };
          var typeMap = {};
          selectedFiles.forEach(function(f) {
            var ext = (f.name || '').split('.').pop().toLowerCase();
            typeMap[ext] = (typeMap[ext] || 0) + 1;
          });
          var topTypes = Object.entries(typeMap).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 3);
          var typeStr = topTypes.map(function(t) { return (t[1] > 1 ? t[1] + '×' : '') + '.' + t[0]; }).join(', ');
          info.textContent = '总计 ' + fmtSize(totalSize) + (typeStr ? ' · ' + typeStr : '');
        }
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
      clearFileSelection();
    }

    async function batchToggleStar() {
      var names = checkedNames();
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      var selectedFiles = names.map(function(n) {
        var decoded = decodeURIComponent(n);
        return currentFiles.find(function(f) { return f.name === decoded; });
      }).filter(Boolean);
      if (!selectedFiles.length) { showToast('未找到选中文件', 'error'); return; }
      // Toggle: if any file is unstarred → star all; otherwise → unstar all
      var anyUnstarred = selectedFiles.some(function(f) { return !f.starred; });
      var newStarred = anyUnstarred ? true : false;
      var failed = 0;
      for (var i = 0; i < names.length; i++) {
        var resp = await fetch('/api/files/' + encodeURIComponent(names[i]), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...headers() },
          body: JSON.stringify({ starred: newStarred })
        });
        if (!resp.ok) failed++;
      }
      var action = newStarred ? '收藏' : '取消收藏';
      showToast(failed ? names.length - failed + '/' + names.length + ' 已' + action : '已' + action + ' ' + names.length + ' 个文件', failed ? 'warn' : 'success');
      loadFiles();
    }

    // File batch operations
    var selectedFileIds = new Set();

    function onFileCheckChange() {
      var checks = document.querySelectorAll('.file-check:checked');
      selectedFileIds.clear();
      checks.forEach(function(c) { selectedFileIds.add(c.dataset.id); });
      updateFileBatchBar();
    }

    function toggleFileSelectAll(checked) {
      document.querySelectorAll('.file-check').forEach(function(c) { c.checked = checked; });
      var topCb = document.getElementById('fileSelectAllTop');
      if (topCb) topCb.checked = checked;
      var headerCb = document.getElementById('selectAll');
      if (headerCb) headerCb.checked = checked;
      var gridCb = document.getElementById('gridSelectAll');
      if (gridCb) gridCb.checked = checked;
      onFileCheckChange();
    }

    function updateFileBatchBar() {
      var bar = document.getElementById('fileBatchBar');
      var count = document.getElementById('fileBatchCount');
      if (!bar) return;
      var n = selectedFileIds.size;
      bar.style.display = n > 0 ? 'flex' : 'none';
      if (count) count.textContent = '已选 ' + n + ' 个文件';
    }

    function clearFileSelection() {
      selectedFileIds.clear();
      document.querySelectorAll('.file-check').forEach(function(c) { c.checked = false; });
      var topCb = document.getElementById('fileSelectAllTop');
      if (topCb) topCb.checked = false;
      var headerCb = document.getElementById('selectAll');
      if (headerCb) headerCb.checked = false;
      var gridCb = document.getElementById('gridSelectAll');
      if (gridCb) gridCb.checked = false;
      updateFileBatchBar();
    }

    function batchDeleteSelected() {
      const names = checkedNames().map(function (n) { return decodeURIComponent(n); });
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      openDeleteConfirmModal(checkedNames());
    }

    async function batchMoveSelectedFiles() {
      if (selectedFileIds.size === 0) return;
      const names = checkedNames().map(function(n) { return decodeURIComponent(n); });
      if (!names.length) { showToast('未找到文件', 'error'); return; }

      var modal = document.getElementById('batchMoveModal');
      if (modal) modal.remove();
      modal = document.createElement('div');
      modal.id = 'batchMoveModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';
      modal.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:480px;font-size:14px">\
          <h3 style="margin:0 0 4px">📂 批量移动文件</h3>\
          <p style="margin:0 0 16px;font-size:12px;color:var(--muted)">将 <strong>' + names.length + '</strong> 个文件移动到目标收藏夹</p>\
          <div style="margin-bottom:16px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">目标收藏夹路径</label>\
            <input id="batchMoveDest" type="text" placeholder="例如：备份/图片（留空表示根目录）" ' +
              'style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'batchMoveModal\').remove()">取消</button>\
            <button id="batchMoveBtn" onclick="confirmBatchMove()">确定移动</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
      window._batchMoveFiles = names;
    }

    async function confirmBatchMove() {
      var names = window._batchMoveFiles || [];
      if (!names.length) return;
      var vf = (document.getElementById('batchMoveDest') || {value: ''}).value.trim();
      var btn = document.getElementById('batchMoveBtn');
      if (btn) { btn.disabled = true; btn.textContent = '移动中...'; }
      try {
        var res = await fetch('/api/files/batch-move', {
          method: 'POST',
          headers: Object.assign(headers(), { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ filenames: names, destFolder: vf })
        });
        var data = await res.json();
        var m = document.getElementById('batchMoveModal');
        if (m) m.remove();
        if (data.success) {
          showToast('已移动 ' + names.length + ' 个文件' + (vf ? ' 到 ' + vf : ''), 'success');
          clearFileSelection();
          loadFiles();
        } else {
          showToast(data.error || '移动失败', 'error');
        }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '确定移动'; }
      }
    }

    async function batchDeleteConfirmed(names) {
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

    // ── Unified Search Overlay ───────────────────────────────────────────────

    var _searchOverlayTimer = null;
    function openUnifiedSearchOverlay() {
      var existing = document.getElementById('unifiedSearchOverlay');
      if (existing) { existing.remove(); }
      var overlay = document.createElement('div');
      overlay.id = 'unifiedSearchOverlay';
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:9998;display:flex;align-items:flex-start;justify-content:center;padding-top:80px';
      overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
      overlay.innerHTML = '\
        <div style="background:var(--bg-primary);border:1px solid var(--line);border-radius:14px;width:100%;max-width:640px;box-shadow:0 8px 32px rgba(0,0,0,.2);overflow:hidden;font-size:13px">\
          <div style="display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);gap:8px">\
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--muted);flex-shrink:0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>\
            <input id="unifiedSearchInput" type="text" placeholder="搜索文件、分享链接、收集链接..." autofocus \
              style="flex:1;border:none;outline:none;background:transparent;font-size:15px;color:var(--text);padding:0" \
              oninput="handleUnifiedSearchInput(this.value)" onkeydown="handleUnifiedSearchKeydown(event)">\
            <button onclick="document.getElementById(\'unifiedSearchOverlay\').remove()" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px;padding:2px 6px">✕</button>\
          </div>\
          <div id="unifiedSearchFilters" style="display:flex;gap:4px;padding:8px 14px;border-bottom:1px solid var(--line)"></div>\
          <div id="unifiedSearchResults" style="max-height:420px;overflow-y:auto;padding:8px 0"></div>\
          <div id="unifiedSearchLoading" style="display:none;text-align:center;padding:24px;color:var(--muted);font-size:13px">搜索中...</div>\
          <div id="unifiedSearchEmpty" style="display:none;text-align:center;padding:32px;color:var(--muted);font-size:13px">未找到结果</div>\
        </div>';
      document.body.appendChild(overlay);
      renderUnifiedSearchFilters('all');
      setTimeout(function() { document.getElementById('unifiedSearchInput').focus(); }, 50);
    }

    var _usFilter = 'all';
    function renderUnifiedSearchFilters(active) {
      _usFilter = active;
      var container = document.getElementById('unifiedSearchFilters');
      if (!container) return;
      var filters = [
        { key: 'all', label: '全部' },
        { key: 'files', label: '📄 文件' },
        { key: 'shares', label: '🔗 分享' },
        { key: 'request-links', label: '📥 收集链接' }
      ];
      container.innerHTML = filters.map(function(f) {
        var isActive = f.key === active;
        return '<button onclick="renderUnifiedSearchFilters(\'' + f.key + '\'); var q=document.getElementById(\'unifiedSearchInput\').value;if(q)handleUnifiedSearchInput(q);" ' +
          'style="padding:3px 10px;font-size:12px;border-radius:999px;border:none;cursor:pointer;font-weight:' + (isActive ? '600' : '400') + ';background:' + (isActive ? 'var(--accent)' : 'transparent') + ';color:' + (isActive ? '#fff' : 'var(--muted)') + '">' + f.label + '</button>';
      }).join('');
    }

    function handleUnifiedSearchInput(q) {
      clearTimeout(_searchOverlayTimer);
      if (!q || !q.trim()) {
        document.getElementById('unifiedSearchResults').innerHTML = '<div style="padding:20px 16px;color:var(--muted);font-size:12px;text-align:center">输入关键词开始搜索</div>';
        document.getElementById('unifiedSearchLoading').style.display = 'none';
        document.getElementById('unifiedSearchEmpty').style.display = 'none';
        return;
      }
      document.getElementById('unifiedSearchLoading').style.display = 'block';
      document.getElementById('unifiedSearchResults').innerHTML = '';
      document.getElementById('unifiedSearchEmpty').style.display = 'none';
      _searchOverlayTimer = setTimeout(function() {
        doUnifiedSearch(q.trim());
      }, 200);
    }

    function doUnifiedSearch(q) {
      var type = _usFilter || 'all';
      var url = '/api/search?q=' + encodeURIComponent(q) + '&type=' + encodeURIComponent(type) + '&limit=30';
      var myHeaders = {};
      var token = localStorage.getItem('token');
      if (token) myHeaders['Authorization'] = 'Bearer ' + token;
      fetch(url, { headers: myHeaders }).then(function(res) { return res.json(); }).then(function(data) {
        document.getElementById('unifiedSearchLoading').style.display = 'none';
        if (!data.success) { showToast(data.error || '搜索失败', 'error'); return; }
        var r = data.results || { files: [], shares: [], requestLinks: [] };
        var total = r.files.length + r.shares.length + r.requestLinks.length;
        if (!total) { document.getElementById('unifiedSearchEmpty').style.display = 'block'; return; }
        var html = '';
        if (r.files.length) {
          html += '<div style="padding:6px 16px 4px;font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px">📄 文件 (' + r.files.length + ')</div>';
          r.files.forEach(function(f) {
            html += '<div onclick="openUnifiedSearchGoTo(\'file\',' + f.id + ')" style="display:flex;align-items:center;padding:8px 16px;cursor:pointer" onmouseenter="this.style.background=\'var(--bg-secondary)\'" onmouseleave="this.style.background=\'\'">';
            html += '<span style="font-size:16px;margin-right:10px;flex-shrink:0">' + getFileIcon(f.filename) + '</span>';
            html += '<div style="flex:1;min-width:0"><div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtmlClient(f.filename) + '</div>';
            html += '<div style="font-size:11px;color:var(--muted)">' + formatFileSize(f.size) + '</div></div></div>';
          });
        }
        if (r.shares.length) {
          html += '<div style="padding:6px 16px 4px;font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px">🔗 分享链接 (' + r.shares.length + ')</div>';
          r.shares.forEach(function(s) {
            html += '<div onclick="openUnifiedSearchGoTo(\'share\',\'' + escapeHtmlClient(s.code) + '\')" style="display:flex;align-items:center;padding:8px 16px;cursor:pointer" onmouseenter="this.style.background=\'var(--bg-secondary)\'" onmouseleave="this.style.background=\'\'">';
            html += '<span style="font-size:16px;margin-right:10px;flex-shrink:0">🔗</span>';
            html += '<div style="flex:1;min-width:0"><div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtmlClient(s.filename || s.code) + '</div>';
            html += '<div style="font-size:11px;color:var(--muted)">' + escapeHtmlClient(s.code) + (s.password ? ' · 🔒' : '') + '</div></div></div>';
          });
        }
        if (r.requestLinks.length) {
          html += '<div style="padding:6px 16px 4px;font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px">📥 收集链接 (' + r.requestLinks.length + ')</div>';
          r.requestLinks.forEach(function(rl) {
            html += '<div onclick="openUnifiedSearchGoTo(\'requestLink\',\'' + escapeHtmlClient(rl.code) + '\')" style="display:flex;align-items:center;padding:8px 16px;cursor:pointer" onmouseenter="this.style.background=\'var(--bg-secondary)\'" onmouseleave="this.style.background=\'\'">';
            html += '<span style="font-size:16px;margin-right:10px;flex-shrink:0">📥</span>';
            html += '<div style="flex:1;min-width:0"><div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtmlClient(rl.name) + '</div>';
            html += '<div style="font-size:11px;color:var(--muted)">' + (rl.active ? '● 有效' : '○ 已停用') + ' · ' + (rl.uploadCount || 0) + ' 个文件</div></div></div>';
          });
        }
        document.getElementById('unifiedSearchResults').innerHTML = html;
      }).catch(function() {
        document.getElementById('unifiedSearchLoading').style.display = 'none';
        showToast('搜索失败', 'error');
      });
    }

    function openUnifiedSearchGoTo(type, id) {
      var overlay = document.getElementById('unifiedSearchOverlay');
      if (overlay) overlay.remove();
      if (type === 'file') {
        navigateToFile(id);
      } else if (type === 'share') {
        switchSection('shares');
        setTimeout(function() {
          var input = document.getElementById('shareSearchInput');
          if (input) { input.value = id; filterShareTable(); }
        }, 100);
      } else if (type === 'requestLink') {
        switchSection('request-links');
        setTimeout(function() {
          var input = document.getElementById('requestLinkSearchInput');
          if (input) { input.value = id; filterRequestLinks(); }
        }, 100);
      }
    }

    function handleUnifiedSearchKeydown(e) {
      if (e.key === 'Escape') {
        var overlay = document.getElementById('unifiedSearchOverlay');
        if (overlay) overlay.remove();
      }
    }

    function navigateToFile(id) {
      // Switch to files section and highlight the file
      switchSection('files');
      var fileEl = document.querySelector('[data-id="' + id + '"]');
      if (fileEl) {
        fileEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        fileEl.style.boxShadow = '0 0 0 3px var(--accent)';
        setTimeout(function() { if (fileEl) fileEl.style.boxShadow = ''; }, 2000);
      }
    }

    // ── Batch Create Share Links ─────────────────────────────────────────────

    function openBatchCreateShareModal() {
      var names = checkedNames().map(function(n) { return decodeURIComponent(n); });
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      var count = names.length;
      var modal = document.createElement('div');
      modal.id = 'batchShareCreateModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';
      modal.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:520px;font-size:14px;max-height:90vh;overflow-y:auto">\
          <h3 style="margin:0 0 4px">🔗 批量创建分享链接</h3>\
          <p style="margin:0 0 16px;font-size:12px;color:var(--muted)">为 <strong>' + count + '</strong> 个文件创建分享链接</p>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">到期时间</label>\
            <div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap">\
              <button onclick="setBscExpiry(7)" style="padding:4px 10px;font-size:12px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--text)">7天</button>\
              <button onclick="setBscExpiry(30)" style="padding:4px 10px;font-size:12px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--text)">30天</button>\
              <button onclick="setBscExpiry(90)" style="padding:4px 10px;font-size:12px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--text)">90天</button>\
              <button onclick="setBscExpiry(365)" style="padding:4px 10px;font-size:12px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--text)">1年</button>\
              <button onclick="clearBscExpiry()" style="padding:4px 10px;font-size:12px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--muted)">永不过期</button>\
            </div>\
            <input id="bscExpiry" type="datetime-local" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">密码保护</label>\
            <input id="bscPwd" type="text" placeholder="留空表示无密码" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="margin-bottom:16px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">下载次数限制</label>\
            <input id="bscMaxDl" type="number" min="0" placeholder="不限制" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:16px">\
            <button class="secondary" onclick="document.getElementById(\'batchShareCreateModal\').remove()">取消</button>\
            <button id="bscCreateBtn" onclick="confirmBatchCreateShare()">创建 ' + count + ' 个链接</button>\
          </div>\
          <div id="batchShareResults" style="display:none"></div>\
        </div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    }

    function setBscExpiry(days) {
      var input = document.getElementById('bscExpiry');
      if (!input) return;
      var d = new Date(Date.now() + days * 86400000);
      input.value = d.toISOString().slice(0, 16);
    }

    function clearBscExpiry() {
      var input = document.getElementById('bscExpiry');
      if (input) input.value = '';
    }

    async function confirmBatchCreateShare() {
      var names = checkedNames().map(function(n) { return decodeURIComponent(n); });
      if (!names.length) return;
      var btn = document.getElementById('bscCreateBtn');
      if (btn) { btn.disabled = true; btn.textContent = '创建中...'; }
      var expiryInput = document.getElementById('bscExpiry');
      var pwdInput = document.getElementById('bscPwd');
      var maxDlInput = document.getElementById('bscMaxDl');
      var expiresTs = expiryInput && expiryInput.value ? Math.floor(new Date(expiryInput.value).getTime() / 1000) : null;
      var pwd = pwdInput && pwdInput.value.trim() ? pwdInput.value.trim() : null;
      var maxDl = maxDlInput && maxDlInput.value ? parseInt(maxDlInput.value, 10) : null;
      var results = [];
      var failed = 0;
      for (var i = 0; i < names.length; i++) {
        try {
          var body = { filename: names[i] };
          if (expiresTs !== null) body.customExpiry = expiresTs * 1000;
          if (pwd !== null) body.password = pwd;
          if (maxDl !== null) body.maxDownloads = maxDl;
          var resp = await fetch('/api/share/create', {
            method: 'POST', headers: headers(),
            body: JSON.stringify(body)
          });
          var data = await resp.json();
          if (data.success && data.share) {
            results.push({ filename: names[i], url: data.share.url, code: data.share.code });
          } else {
            failed++;
            results.push({ filename: names[i], error: data.error || '创建失败' });
          }
        } catch(e) { failed++; results.push({ filename: names[i], error: '网络错误' }); }
      }
      if (btn) { btn.disabled = false; btn.textContent = '创建 ' + names.length + ' 个链接'; }
      var container = document.getElementById('batchShareResults');
      if (!container) return;
      container.style.display = 'block';
      var ok = results.filter(function(r) { return !r.error; });
      var fail = failed;
      var html = '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">';
      html += '<span style="color:var(--success)">✅ 成功: ' + ok.length + '</span>';
      if (fail > 0) html += ' · <span style="color:var(--error)">失败: ' + fail + '</span>';
      html += '</div>';
      if (ok.length) {
        html += '<div style="margin-bottom:8px"><button onclick="copyAllBscLinks()" style="padding:5px 12px;font-size:12px;background:var(--accent);border:none;border-radius:6px;cursor:pointer;color:#fff">📋 复制全部链接</button></div>';
      }
      html += '<div style="max-height:260px;overflow-y:auto">';
      results.forEach(function(r) {
        if (r.error) {
          html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--bg);border-radius:6px;margin-bottom:4px;opacity:0.7">';
          html += '<span style="color:var(--error);font-size:12px">❌</span>';
          html += '<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtmlClient(r.filename) + '">' + escapeHtmlClient(r.filename) + '</span>';
          html += '<span style="font-size:11px;color:var(--error)">' + escapeHtmlClient(r.error) + '</span>';
          html += '</div>';
        } else {
          html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--bg);border-radius:6px;margin-bottom:4px">';
          html += '<span style="color:var(--success);font-size:12px">✅</span>';
          html += '<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtmlClient(r.filename) + '">' + escapeHtmlClient(r.filename) + '</span>';
          html += '<button onclick="copyBscLink(\'' + escapeHtmlClient(r.url).replace(/'/g, "\\'") + '\')" style="padding:3px 8px;font-size:11px;background:var(--accent);border:none;border-radius:5px;cursor:pointer;color:#fff;flex-shrink:0">复制</button>';
          html += '</div>';
        }
      });
      html += '</div>';
      html += '<div style="margin-top:10px;display:flex;justify-content:flex-end"><button class="secondary" onclick="document.getElementById(\'batchShareCreateModal\').remove()" style="font-size:12px">关闭</button></div>';
      container.innerHTML = html;
      window._bscUrls = ok.map(function(r) { return r.url; });
    }

    function copyBscLink(url) {
      if (navigator.clipboard) navigator.clipboard.writeText(url);
      showToast('链接已复制', 'success');
    }

    function copyAllBscLinks() {
      var urls = window._bscUrls || [];
      if (!urls.length) return;
      if (navigator.clipboard) navigator.clipboard.writeText(urls.join('\n'));
      showToast('已复制 ' + urls.length + ' 个链接', 'success');
    }

    function openBatchMoveModal() {
      var names = checkedNames();
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      fetch('/api/virtual-folders', { headers: headers() }).then(function(res) { return res.json(); }).then(function(data) {
        var folders = data.folders || [];
        var body = '<div style="padding:8px 0">' +
          '<p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">将 ' + names.length + ' 个文件添加到收藏夹：</p>';
        if (folders.length === 0) {
          body += '<p style="color:var(--muted);font-size:13px;text-align:center;padding:20px">暂无收藏夹，<button class="secondary" style="font-size:12px;padding:4px 10px" onclick="createVirtualFolderFromMove()">创建第一个</button></p>';
        } else {
          body += '<div id="vfList" style="max-height:240px;overflow-y:auto">';
          folders.forEach(function(f) {
            body += '<div class="ctx-item" onclick="batchMoveToFolder(' + f.id + ')" style="cursor:pointer;padding:10px 14px;display:flex;align-items:center;gap:8px">' +
              '<span style="color:' + escapeHtmlClient(f.color || '#667eea') + ';font-size:16px">●</span>' +
              '<span style="flex:1;font-size:13px">' + escapeHtmlClient(f.name) + '</span>' +
              '<span style="color:var(--muted);font-size:11px">' + (f.file_count || 0) + ' 个文件</span>' +
            '</div>';
          });
          body += '</div>';
        }
        body += '</div>';
        document.getElementById('modalTitle').textContent = '📁 移动到收藏夹';
        document.getElementById('modalBody').innerHTML = body;
        document.getElementById('modal').classList.add('open');
      }).catch(function(e) { showToast('加载收藏夹失败', 'error'); });
    }

    function createVirtualFolderFromMove() {
      var m = document.getElementById('createVFModal');
      if (m) m.remove();
      m = document.createElement('div');
      m.id = 'createVFModal';
      m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10002;display:flex;align-items:center;justify-content:center;padding:20px';
      m.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:400px;font-size:14px">\
          <h3 style="margin:0 0 16px">创建新收藏夹</h3>\
          <div style="margin-bottom:20px">\
            <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--muted)">收藏夹名称</label>\
            <input id="createVFModalInput" type="text" placeholder="例如：备份/图片" ' +
              'style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'createVFModal\').remove()">取消</button>\
            <button id="createVFModalBtn" onclick="confirmCreateVF()">创建</button>\
          </div>\
        </div>';
      document.body.appendChild(m);
      m.addEventListener('click', function(e) { if (e.target === m) m.remove(); });
      setTimeout(function() { var inp = document.getElementById('createVFModalInput'); if (inp) inp.focus(); }, 50);
      var inp = document.getElementById('createVFModalInput');
      inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); confirmCreateVF(); } });
    }

    function confirmCreateVF() {
      var name = (document.getElementById('createVFModalInput') || {value: ''}).value.trim();
      if (!name) return;
      var m = document.getElementById('createVFModal');
      if (m) m.remove();
      fetch('/api/virtual-folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: '' })
      }).then(function(res) { return res.json(); }).then(function(data) {
        if (data.folder && data.folder.id) {
          batchMoveToFolder(data.folder.id);
        } else {
          showToast('创建收藏夹失败', 'error');
        }
      });
    }

    async function batchMoveToFolder(folderId) {
      forceCloseModal();
      var checked = document.querySelectorAll('.file-check:checked');
      var count = 0;
      for (var cb of checked) {
        var fileId = parseInt(cb.dataset.fileId, 10);
        if (fileId) {
          await fetch('/api/virtual-folders/' + folderId + '/files', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId: fileId })
          });
          count++;
        }
      }
      showToast('已添加 ' + count + ' 个文件到收藏夹', 'success');
    }

    function openBatchCopyModal() {
      const names = checkedNames().map(function(n) { return decodeURIComponent(n); });
      if (!names.length) { showToast('请先选择文件', 'error'); return; }

      const existingModal = document.getElementById('batchCopyModal');
      if (existingModal) existingModal.remove();

      const modal = document.createElement('div');
      modal.id = 'batchCopyModal';
      modal.className = 'modal open';
      modal.innerHTML = '\
        <div class="modal-content" style="max-width:500px">\
          <h3>📋 批量复制文件</h3>\
          <p style="color:var(--muted);font-size:13px;margin-bottom:12px">将 ' + names.length + ' 个文件复制到目标文件夹</p>\
          <div style="margin-bottom:12px">\
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">目标文件夹路径（留空表示根目录）</label>\
            <input id="batchCopyDestFolder" type="text" placeholder="例如：备份/图片" \
              style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font-size:14px" \
              oninput="updateBatchCopyPreview()">\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">预览</label>\
            <div id="batchCopyPreview" style="max-height:200px;overflow:auto;background:var(--bg-secondary);border-radius:8px;padding:8px;font-size:12px;font-family:monospace"></div>\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'batchCopyModal\').remove()">取消</button>\
            <button onclick="confirmBatchCopy()">确定复制</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      window._batchCopyFiles = names;
      updateBatchCopyPreview();
    }

    function updateBatchCopyPreview() {
      const dest = (document.getElementById('batchCopyDestFolder') || {value: ''}).value.trim();
      const names = window._batchCopyFiles || [];
      const preview = document.getElementById('batchCopyPreview');
      if (!preview) return;
      let html = '';
      names.forEach(function(n) {
        const basename = n.split('/').pop();
        const destName = dest ? dest + '/' + basename : basename;
        html += '<div style="color:var(--muted)">' + escapeHtmlClient(n) + ' → </div>';
        html += '<div style="color:var(--accent);margin-bottom:6px">' + escapeHtmlClient(destName) + '</div>';
      });
      preview.innerHTML = html || '<div style="color:var(--muted);text-align:center;padding:10px">无文件</div>';
    }

    async function confirmBatchCopy() {
      const names = window._batchCopyFiles || [];
      if (!names.length) return;
      const destFolder = (document.getElementById('batchCopyDestFolder') || {value: ''}).value.trim();
      const btn = document.querySelector('#batchCopyModal button[onclick="confirmBatchCopy()"]');
      if (btn) { btn.disabled = true; btn.textContent = '复制中…'; }

      try {
        const res = await fetch('/api/file-copy-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...Object.fromEntries(Object.entries(headers())) },
          body: JSON.stringify({ operations: names.map(function(n) { return { filename: n }; }), destFolder: destFolder })
        });
        const data = await res.json();
        if (data.success) {
          showToast('已复制 ' + (data.copied || 0) + ' 个文件', 'success');
          if (data.errors && data.errors.length) {
            showToast(data.errors.length + ' 个文件复制失败', 'error');
          }
          document.getElementById('batchCopyModal').remove();
          clearSelection();
          loadFiles();
        } else {
          showToast(data.error || '复制失败', 'error');
        }
      } catch(e) {
        showToast('复制失败: ' + e.message, 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '确定复制'; }
      }
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

    // 新建文本文件 modal
    function openNewTextFileModal() {
      document.getElementById('modalTitle').textContent = '新建文本文件';
      document.getElementById('modalBody').innerHTML =
        '<div style="padding:8px 0">' +
          '<input id="newTextFileName" type="text" placeholder="文件名（如：笔记.txt）" ' +
            'style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg2);color:var(--text);font-size:14px;box-sizing:border-box;margin-bottom:12px" ' +
            'onkeydown="if(event.key===\'Enter\')confirmNewTextFile();if(event.key===\'Escape\')forceCloseModal()">' +
          '<textarea id="newTextFileContent" placeholder="输入文本内容…" ' +
            'style="width:100%;height:200px;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg2);color:var(--text);font-size:14px;box-sizing:border-box;resize:vertical;font-family:monospace" ' +
            'onkeydown="if(event.key===\'Escape\')forceCloseModal()"></textarea>' +
        '</div>';
      var modal = document.getElementById('modal');
      modal.querySelector('.modal-actions').innerHTML =
        '<button class="secondary" onclick="forceCloseModal()">取消</button>' +
        '<button class="primary" onclick="confirmNewTextFile()">创建</button>';
      modal.classList.add('open');
      setTimeout(function() { document.getElementById('newTextFileName').focus(); }, 50);
    }

    async function confirmNewTextFile() {
      var nameInput = document.getElementById('newTextFileName');
      var contentInput = document.getElementById('newTextFileContent');
      var name = (nameInput && nameInput.value.trim()) || '新建文本.txt';
      var content = contentInput ? contentInput.value : '';
      // Ensure .txt extension
      if (!name.includes('.')) name += '.txt';
      forceCloseModal();
      showToast('创建中…');
      try {
        // Try PUT /api/content/:filename first (updates existing)
        var data = await request('/api/content/' + encodeURIComponent(name), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: content })
        });
        if (data.success) {
          showToast('已保存: ' + name, 'success');
        } else if (data.error === 'File not found') {
          // Create new file using POST /api/upload-text
          var createData = await request('/api/upload-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: name, content: content })
          });
          if (createData.success) {
            showToast('已创建: ' + name, 'success');
          } else {
            showToast(createData.error || '创建失败', 'error');
            return;
          }
        } else {
          showToast(data.error || '保存失败', 'error');
          return;
        }
        await loadFiles();
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

    function openBatchStatsModal() {
      const names = checkedNames().map(function(n) { return decodeURIComponent(n); });
      if (!names.length) { showToast('请先选择文件', 'error'); return; }

      const modal = document.getElementById('modal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');
      title.textContent = '📊 批量统计 (' + names.length + ')';
      body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">加载中...</div>';
      modal.classList.add('open');

      // Build stats from currentFiles (already in memory)
      const files = names.map(function(n) {
        return currentFiles.find(function(f) { return (f.name || f.filename) === n; }) || { name: n, filename: n };
      });

      const totalSize = files.reduce(function(s, f) { return s + (f.size || 0); }, 0);
      const byType = {};
      const byExt = {};
      const byDay = {};
      files.forEach(function(f) {
        var type = (f.type || '').toLowerCase() || '未知';
        byType[type] = (byType[type] || 0) + 1;
        var dot = f.name.lastIndexOf('.');
        var ext = dot > 0 ? f.name.slice(dot + 1).toLowerCase() : '(无扩展名)';
        byExt[ext] = (byExt[ext] || 0) + 1;
        var day = f.created_at ? new Date(f.created_at * 1000).toLocaleDateString('zh-CN') : '未知';
        byDay[day] = (byDay[day] || 0) + 1;
      });

      var typeEntries = Object.entries(byType).sort(function(a, b) { return b[1] - a[1]; });
      var extEntries = Object.entries(byExt).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 8);
      var dayEntries = Object.entries(byDay).sort(function(a, b) { return b[0].localeCompare(a[0]); });

      var html = '<div style="max-width:480px">';
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">';
      html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:10px;text-align:center"><div style="font-size:22px;font-weight:700;color:var(--accent)">' + files.length + '</div><div style="font-size:11px;color:var(--muted);margin-top:2px">文件数</div></div>';
      html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:10px;text-align:center"><div style="font-size:22px;font-weight:700;color:var(--accent)">' + formatFileSize(totalSize) + '</div><div style="font-size:11px;color:var(--muted);margin-top:2px">总体积</div></div>';
      html += '</div>';

      html += '<div style="margin-bottom:14px">';
      html += '<div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px">按类型</div>';
      typeEntries.forEach(function(e) {
        var pct = Math.round(e[1] / files.length * 100);
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">';
        html += '<span style="min-width:60px;font-size:12px;color:var(--text-secondary)">' + escapeHtmlClient(e[0]) + '</span>';
        html += '<div style="flex:1;height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden"><div style="height:100%;background:var(--accent);width:' + pct + '%;border-radius:3px"></div></div>';
        html += '<span style="min-width:36px;text-align:right;font-size:11px;color:var(--muted)">' + e[1] + '</span>';
        html += '</div>';
      });
      html += '</div>';

      html += '<div style="margin-bottom:14px">';
      html += '<div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px">按扩展名</div>';
      extEntries.forEach(function(e) {
        var pct = Math.round(e[1] / files.length * 100);
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">';
        html += '<span style="min-width:60px;font-size:12px;color:var(--text-secondary)">' + escapeHtmlClient(e[0]) + '</span>';
        html += '<div style="flex:1;height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden"><div style="height:100%;background:var(--primary);width:' + pct + '%;border-radius:3px"></div></div>';
        html += '<span style="min-width:36px;text-align:right;font-size:11px;color:var(--muted)">' + e[1] + '</span>';
        html += '</div>';
      });
      html += '</div>';

      html += '<div>';
      html += '<div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px">按创建日期</div>';
      dayEntries.slice(0, 6).forEach(function(e) {
        var pct = Math.round(e[1] / files.length * 100);
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">';
        html += '<span style="min-width:80px;font-size:12px;color:var(--text-secondary)">' + escapeHtmlClient(e[0]) + '</span>';
        html += '<div style="flex:1;height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden"><div style="height:100%;background:#10b981;width:' + pct + '%;border-radius:3px"></div></div>';
        html += '<span style="min-width:36px;text-align:right;font-size:11px;color:var(--muted)">' + e[1] + '</span>';
        html += '</div>';
      });
      html += '</div>';

      html += '</div>';
      body.innerHTML = html;
      var actions = modal.querySelector('.modal-actions');
      if (actions) {
        actions.innerHTML = '<button class="secondary" onclick="forceCloseModal()">关闭</button>';
      }
    }

    function openTagInputModal(action, fileCount) {
      const existingModal = document.getElementById('tagInputModal');
      if (existingModal) existingModal.remove();
      const modal = document.createElement('div');
      modal.id = 'tagInputModal';
      modal.className = 'modal';
      modal.innerHTML = '\
        <div class="modal-content" style="max-width:460px">\
          <h3 id="tagInputTitle">' + (action === 'add' ? '添加标签' : '移除标签') + '</h3>\
          <p style="color:var(--muted);font-size:13px;margin-bottom:12px">为 ' + fileCount + ' 个文件' + (action === 'add' ? '添加' : '移除') + '标签</p>\
          <div id="tagChipInput" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;padding:8px;border:1px solid var(--line);border-radius:8px;min-height:44px;cursor:text" onclick="document.getElementById(\'tagInputField\').focus()"></div>\
          <div style="position:relative;margin-bottom:8px">\
            <input id="tagInputField" type="text" placeholder="输入或选择标签后按 Enter 添加" \
              style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font-size:14px" \
              oninput="filterTagSuggestions(this.value)" \
              onkeydown="handleTagInputKeydown(event, \'' + action + '\')">\
            <div id="tagSuggestionDropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg-secondary);border:1px solid var(--line);border-radius:8px;margin-top:4px;max-height:160px;overflow-y:auto;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,0.15)"></div>\
          </div>\
          <div id="existingTagsSection" style="margin-bottom:14px">\
            <div style="font-size:11px;color:var(--muted);margin-bottom:6px">已有标签（点击添加）</div>\
            <div id="existingTagChips" style="display:flex;flex-wrap:wrap;gap:5px"></div>\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'tagInputModal\').remove()">取消</button>\
            <button onclick="confirmBatchTagInput(\'' + action + '\')">确定</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      renderExistingTagChips();
      document.getElementById('tagInputField').focus();
    }

    function renderExistingTagChips() {
      var container = document.getElementById('existingTagChips');
      if (!container) return;
      var allTags = window._allTags || [];
      if (!allTags.length) { container.innerHTML = '<span style="font-size:12px;color:var(--muted)">暂无标签</span>'; return; }
      container.innerHTML = allTags.map(function(t) {
        return '<button onclick="addBatchTagChip(\'' + escapeHtmlClient(t.name) + '\')" style="font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer;font-weight:500;' +
          'border:1px solid ' + escapeHtmlClient(t.color || '#e0e7ff') + ';background:' + (t.color || '#e0e7ff') + ';color:inherit;opacity:0.85" ' +
          'title="' + escapeHtmlClient(t.name) + '">' + (t.icon ? escapeHtmlClient(t.icon) + ' ' : '') + escapeHtmlClient(t.name) + '</button>';
      }).join('');
    }

    function addBatchTagChip(tagName) {
      if (!_batchTagChips.includes(tagName)) {
        _batchTagChips.push(tagName);
        renderBatchTagChips();
      }
      var input = document.getElementById('tagInputField');
      if (input) { input.value = ''; filterTagSuggestions(''); }
    }

    function filterTagSuggestions(query) {
      var dropdown = document.getElementById('tagSuggestionDropdown');
      if (!dropdown) return;
      var allTags = window._allTags || [];
      var q = query.trim().toLowerCase();
      var filtered = allTags.filter(function(t) { return t.name.toLowerCase().includes(q); });
      if (!filtered.length || !q) { dropdown.style.display = 'none'; return; }
      dropdown.innerHTML = filtered.slice(0, 8).map(function(t) {
        return '<div onclick="selectTagSuggestion(\'' + escapeHtmlClient(t.name) + '\')" ' +
          'style="padding:8px 12px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--line)">' +
          '<span style="width:10px;height:10px;border-radius:50%;background:' + escapeHtmlClient(t.color || '#667eea') + ';flex-shrink:0"></span>' +
          '<span>' + escapeHtmlClient(t.name) + '</span></div>';
      }).join('');
      dropdown.style.display = 'block';
    }

    function selectTagSuggestion(tagName) {
      addBatchTagChip(tagName);
      var dropdown = document.getElementById('tagSuggestionDropdown');
      if (dropdown) dropdown.style.display = 'none';
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
    window._droppedFiles = null; // {files: FileList, count: int} — set on desktop drag-drop
    window._uploadFolderPrefix = ''; // set when selecting a folder (webkitRelativePath strips filename)

    function handleFileSelect(files) {
      var list = document.getElementById('fileList');
      if (!files.length) {
        list.innerHTML = '';
        return;
      }
      // Detect folder upload via webkitRelativePath (set when user selects a folder)
      var firstWithPath = Array.from(files).find(function(f) { return f.webkitRelativePath && f.webkitRelativePath.length > 0; });
      var folderPrefix = '';
      if (firstWithPath) {
        // e.g. webkitRelativePath = "my-folder/sub/nested/file.txt" → prefix = "my-folder/sub/nested"
        var lastSlash = firstWithPath.webkitRelativePath.lastIndexOf('/');
        folderPrefix = lastSlash > 0 ? firstWithPath.webkitRelativePath.substring(0, lastSlash) : '';
        window._uploadFolderPrefix = folderPrefix;
      } else {
        window._uploadFolderPrefix = '';
      }
      // Show a compact icon+name+size list for dropped/dragged files
      var html = '<div style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;padding:4px 0">';
      var label = '已选 ' + files.length + ' 个文件';
      if (folderPrefix) label += '（文件夹: ' + folderPrefix + '）';
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:4px">' + label + '</div>';
      Array.from(files).slice(0, 20).forEach(function(f) {
        var icon = getFileIcon(f.name, '');
        var size = formatBytes(f.size);
        var displayName = folderPrefix ? f.webkitRelativePath || f.name : f.name;
        html += '<div style="display:flex;align-items:center;gap:8px;font-size:13px">' +
          '<span>' + icon + '</span>' +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtmlClient(displayName) + '">' + escapeHtmlClient(displayName) + '</span>' +
          '<span style="color:var(--muted);font-size:12px;white-space:nowrap">' + size + '</span></div>';
      });
      if (files.length > 20) html += '<div style="font-size:12px;color:var(--muted);text-align:center">... 还有 ' + (files.length - 20) + ' 个文件</div>';
      html += '</div>';
      list.innerHTML = html;
    }

    function clearFileInput() {
      document.getElementById('fileInput').value = '';
      document.getElementById('fileList').innerHTML = '';
      window._uploadFolderPrefix = '';
    }

    function setupDragDrop() {
      var dropZone = document.getElementById('dropZone');
      if (!dropZone) return;

      // Full-screen drop overlay (shown when dragging files anywhere over the page)
      var globalDropOverlay = null;
      function showGlobalDropOverlay(count) {
        if (globalDropOverlay) {
          if (count > 0) globalDropOverlay.textContent = '📥 释放 ' + count + ' 个文件以上传';
          return;
        }
        globalDropOverlay = document.createElement('div');
        globalDropOverlay.id = 'globalDropOverlay';
        globalDropOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(16,185,129,0.12);border:4px dashed #10b981;z-index:9999;display:flex;align-items:center;justify-content:center;pointer-events:none;font-size:28px;font-weight:bold;color:#10b981;border-radius:16px;margin:16px';
        globalDropOverlay.textContent = count > 0 ? '📥 释放 ' + count + ' 个文件以上传' : '📥 释放文件以上传';
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
            var count = e.dataTransfer.items ? e.dataTransfer.items.length : (e.dataTransfer.files ? e.dataTransfer.files.length : 0);
            showGlobalDropOverlay(count);
          }
        });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        dropZone.addEventListener(evt, function (e) {
          e.preventDefault();
          dropZone.classList.remove('dragover');
          if (evt === 'drop') {
            e.stopPropagation();
            var files = e.dataTransfer.files;
            if (files.length) {
              window._droppedFiles = { files: files, count: files.length };
              handleFileSelect(files);
              showToast('已选择 ' + files.length + ' 个文件，开始上传...', 'info', 2000);
              uploadFiles();
            }
          }
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
          window._droppedFiles = { files: files, count: files.length };
          handleFileSelect(files);
          showToast('已选择 ' + files.length + ' 个文件，开始上传...', 'info', 2000);
          uploadFiles();
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

    // ── Image Gallery State ────────────────────────────────────────────
    var galleryFiles = [];       // current visible image files
    var galleryIndex = 0;        // current index in gallery

    function setGalleryFiles(files) {
      galleryFiles = files;
    }

    function navigateGallery(dir) {
      if (!galleryFiles.length) return;
      galleryIndex = (galleryIndex + dir + galleryFiles.length) % galleryFiles.length;
      var target = galleryFiles[galleryIndex];
      if (target) previewFile(target.name);
    }

    function jumpToFileFromModal() {
      forceCloseModal();
      var titleEl = document.getElementById('modalTitle');
      if (!titleEl) return;
      var raw = titleEl.textContent.replace(/^[预览文件属性版本历史：:：]*/, '').trim();
      if (!raw) return;
      var encoded = encodeURIComponent(raw);
      var el = document.querySelector('[data-filename="' + encoded + '"]');
      if (!el) el = document.querySelector('[data-filename="' + raw + '"]');
      if (!el) { showToast('未在当前列表找到: ' + raw, 'info', 1500); return; }
      // Find index of this element
      var items = getAllFileItems();
      var idx = Array.from(items).indexOf(el);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (idx >= 0) setTimeout(function() { applyNavHighlight(idx); }, 300);
    }

    function openGalleryAt(filename) {
      galleryIndex = galleryFiles.findIndex(function(f) { return f.name === filename; });
      if (galleryIndex < 0) galleryIndex = 0;
    }

    function getAuthHeader() {
      return 'Bearer ' + (localStorage.getItem('st_auth_token') || STATIC_TOKEN);
    }

    function updateMobileUploadBadge() {
      var badge = document.getElementById('mobileUploadBadge');
      if (!badge) return;
      // Count pending + uploading + queued items (not yet done/failed)
      var pending = uploadQueue.filter(function(f) {
        return f.status !== 'done' && f.status !== 'failed';
      }).length;
      if (pending > 0) {
        badge.textContent = pending > 99 ? '99+' : pending;
        badge.style.display = 'block';
      } else {
        badge.style.display = 'none';
      }
    }

    function renderUploadQueuePanel() {
      var panel = document.getElementById('uploadQueuePanel');
      if (!panel) return;
      if (uploadQueue.length === 0) {
        panel.style.display = 'none';
        updateMobileUploadBadge();
        return;
      }
      panel.style.display = 'block';
      var done = uploadQueue.filter(function(f) { return f.status === 'done' || f.status === 'failed'; }).length;
      var total = uploadQueue.length;
      panel.querySelector('.uq-title').textContent = '上传队列 ' + done + '/' + total;

      var list = panel.querySelector('.uq-list');
      list.innerHTML = uploadQueue.map(function(item, i) {
        var isOfflineQueued = item.status === 'queued' && item.offline;
        var color = item.status === 'done' ? '#22c55e' : item.status === 'failed' ? '#ef4444' : item.status === 'paused' ? '#f59e0b' : item.status === 'queued' ? '#8b5cf6' : '#3b82f6';
        var icon = item.status === 'done' ? '✓' : item.status === 'failed' ? '✗' : item.status === 'paused' ? '⏸' : item.status === 'queued' ? (isOfflineQueued ? '⛂' : '⏳') : '↑';
        var canRetry = item.status === 'failed';
        var canPause = item.status === 'uploading';
        var canResume = item.status === 'paused';
        var canCancel = item.status === 'pending' || item.status === 'uploading' || item.status === 'paused' || item.status === 'queued';
        var actions = '';
        if (canRetry) actions += '<button class="uq-btn uq-retry" data-i="' + i + '" title="重试">↻</button>';
        if (canPause) actions += '<button class="uq-btn uq-pause" data-i="' + i + '" title="暂停">⏸</button>';
        if (canResume) actions += '<button class="uq-btn uq-resume" data-i="' + i + '" title="继续">▶</button>';
        if (canCancel) actions += '<button class="uq-btn uq-cancel" data-i="' + i + '" title="取消">✕</button>';
        var itemStyle = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)';
        if (isOfflineQueued) {
          itemStyle += ';background:rgba(139,92,246,0.15);border-left:3px solid #8b5cf6;padding-left:8px;margin-left:-8px';
        }
        return '<div class="uq-item" data-i="' + i + '" style="' + itemStyle + '">' +
          '<span style="color:' + color + ';font-size:14px;width:18px;text-align:center">' + icon + '</span>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + escapeHtmlClient(item.name) + '">' + escapeHtmlClient(item.name) + '</div>' +
            '<div class="uq-bar" style="height:3px;background:var(--line);border-radius:2px;margin-top:3px;overflow:hidden">' +
              '<div class="uq-fill" style="height:100%;width:' + (item.pct || 0) + '%;background:' + color + ';transition:width .2s"></div>' +
            '</div>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted);min-width:60px;text-align:right;white-space:nowrap">' + (item.pct || 0) + '%' + (item.speed ? ' <span style="color:var(--text-muted)">' + item.speed + '</span>' : '') + (item.eta ? ' <span title="剩余时间" style="color:var(--muted)">' + item.eta + '</span>' : '') + '</div>' +
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
      updateMobileUploadBadge();
      // Poll IndexedDB for offline-queued upload count
      if (window.getOfflinePendingCount) {
        window.getOfflinePendingCount().then(function(count) {
          var badge = document.getElementById('offlinePendingBadge');
          if (badge) {
            if (count > 0) {
              badge.textContent = count > 99 ? '99+' : count;
              badge.style.display = 'inline-block';
            } else {
              badge.style.display = 'none';
            }
          }
        });
      }
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
          item._base64 = content; // store for offline queue
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
              // ETA: remaining bytes / speed
              var etaStr = '';
              if (speed > 0 && ev.total > ev.loaded) {
                var remaining = ev.total - ev.loaded;
                var etaSeconds = Math.round(remaining / speed);
                etaStr = formatEta(etaSeconds);
              }
              updateQueueItem(uploadQueue.indexOf(item), { pct: pct, speed: speedStr, eta: etaStr });
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
            // Attempt to queue for later retry when offline
            if (!navigator.onLine || !navigator.serviceWorker.controller) {
              // No SW available — just mark as failed
              updateQueueItem(uploadQueue.indexOf(item), { status: 'failed' });
              reject(new Error('网络错误'));
              processUploadQueue();
              return;
            }
            // Extract base64 content from the blob we just sent (already read in reader.onload)
            // We stored the content — re-queue it via SW
            var queued = queueUpload({
              filename: item.name,
              content: item._base64 || '',
              type: 'file',
              token: (localStorage.getItem('st_auth_token') || STATIC_TOKEN)
            });
            if (queued) {
              updateQueueItem(uploadQueue.indexOf(item), { status: 'queued', pct: 0, offline: true });
              showToast('文件已加入离线队列，网络恢复后将自动上传', 'info', 4000);
              // Trigger background sync so SW processes the queue when online
              if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'TRIGGER_UPLOAD_SYNC' });
              }
            } else {
              updateQueueItem(uploadQueue.indexOf(item), { status: 'failed' });
            }
            reject(new Error('网络错误，已加入队列'));
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

    function openUploadFromUrlModal() {
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '🌐 URL上传';
      body.innerHTML = '\
        <div style="display:flex;flex-direction:column;gap:12px">\
          <div>\
            <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary)">文件URL</label>\
            <input id="urlUploadInput" type="text" placeholder="https://example.com/file.pdf" \
              style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box;font-size:14px">\
          </div>\
          <div>\
            <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary)">保存为文件名（可选）</label>\
            <input id="urlUploadFilename" type="text" placeholder="留空则使用URL中的文件名" \
              style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box;font-size:14px">\
          </div>\
          <div id="urlUploadStatus" style="font-size:13px;color:var(--text-muted);text-align:center;display:none"></div>\
        </div>';
      var actions = modal.querySelector('.modal-actions');
      if (actions) actions.innerHTML = '<button class="secondary" onclick="closeModal()">取消</button><button id="urlUploadConfirmBtn" onclick="confirmUploadFromUrl()">下载并保存</button>';
      modal.classList.add('open');
      setTimeout(function() { var inp = document.getElementById('urlUploadInput'); if (inp) inp.focus(); }, 50);
    }

    async function confirmUploadFromUrl() {
      var url = document.getElementById('urlUploadInput').value.trim();
      if (!url) { showToast('请输入URL', 'error'); return; }
      var filename = document.getElementById('urlUploadFilename').value.trim();
      var status = document.getElementById('urlUploadStatus');
      var btn = document.getElementById('urlUploadConfirmBtn');
      if (btn) { btn.disabled = true; btn.textContent = '下载中...'; }
      if (status) { status.style.display = 'block'; status.textContent = '正在下载...'; }
      try {
        var res = await fetch('/api/upload-from-url', {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ url: url, filename: filename || undefined })
        });
        var data = await res.json();
        if (data.success) {
          if (status) status.textContent = '✓ 下载成功！';
          showToast('文件已保存: ' + data.file.name, 'success');
          closeModal();
          loadFiles();
        } else {
          if (status) status.style.display = 'none';
          showToast(data.error || '下载失败', 'error');
          if (btn) { btn.disabled = false; btn.textContent = '下载并保存'; }
        }
      } catch (e) {
        if (status) status.style.display = 'none';
        showToast('下载失败: ' + e.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = '下载并保存'; }
      }
    }

    async function uploadFiles() {
      const input = document.getElementById('fileInput');
      // Prefer files dropped from desktop (FileList cannot be assigned to input.files)
      const dropped = window._droppedFiles;
      const files = dropped
        ? Array.from(dropped.files)
        : Array.from(input.files || []);
      // Clear dropped state after consuming
      if (dropped) { window._droppedFiles = null; }
      if (!files.length) {
        showToast('请先选择文件', 'error');
        return;
      }

      // Add to queue
      var folderPrefix = window._uploadFolderPrefix || '';
      window._uploadFolderPrefix = ''; // reset after consuming
      files.forEach(function(file) {
        var uploadName = folderPrefix ? folderPrefix + '/' + file.name : file.name;
        uploadQueue.push({ name: uploadName, file: file, status: 'pending', pct: 0 });
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
          _cachedTagData = null;  // uploaded files may have new tags
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

    // Apply current sort to a file array (used for virtual folders, search results)
    function sortFiles(files) {
      return files.slice().sort(function(a, b) {
        var va = a[currentSort], vb = b[currentSort];
        if (va == null) va = '';
        if (vb == null) vb = '';
        if (currentSort === 'size') {
          return currentOrder === 'asc' ? (a.size || 0) - (b.size || 0) : (b.size || 0) - (a.size || 0);
        }
        if (currentSort === 'updated_at' || currentSort === 'created_at') {
          va = va ? new Date(va).getTime() : 0;
          vb = vb ? new Date(vb).getTime() : 0;
          return currentOrder === 'asc' ? va - vb : vb - va;
        }
        if (currentSort === 'type') {
          var extA = (a.name || '').split('.').pop() || '';
          var extB = (b.name || '').split('.').pop() || '';
          return currentOrder === 'asc' ? extA.localeCompare(extB) : extB.localeCompare(extA);
        }
        return currentOrder === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
      });
    }

    var currentOffset = 0;
    var currentTotal = 0;
    var currentPageLimit = 500;
    var isAppending = false;
    var isRecentFilesMode = false;

    // ── Recent Files Mode ───────────────────────────────────────────────
    window.showRecentFiles = async function() {
      isRecentFilesMode = true;
      document.getElementById('sortDropdownMenu').style.display = 'none';
      // Update sort dropdown label to show active state
      var label = document.getElementById('sortDropdownLabel');
      if (label) label.innerHTML = '🕐 最近访问';
      // Clear search input
      document.getElementById('searchInput').value = '';
      currentSearchQuery = '';
      updateTypeFilterChips();
      // Highlight 'recent' chip
      document.querySelectorAll('.type-chip').forEach(function(c) {
        c.classList.toggle('active', c.getAttribute('data-type') === 'recent');
      });
      // Load recent files
      try {
        var res = await fetch('/api/recent-files?limit=100', { headers: headers() });
        var data = await res.json();
        if (data.success && data.files) {
          // Set currentFiles directly and render (fix: renderFileList never existed)
          currentFiles = data.files.map(function(f, i) { f._index = i; return f; });
          currentOffset = currentFiles.length;
          currentTotal = currentFiles.length;
          window._currentFiles = currentFiles;
          window._recentFilesCache = data.files;
          // Build empty tagColorMap (recent files don't need tag coloring here)
          var tagColorMap = {};
          if (window._folderTagDefinitions) {
            window._folderTagDefinitions.forEach(function(td) {
              tagColorMap[td.name] = { color: td.color || '#e0e7ff', icon: td.icon || '' };
            });
          }
          setGalleryFiles(currentFiles.filter(function(f) { return (f.content_type || f.mime || '').startsWith('image/'); }));
          renderFiles(tagColorMap);
          updateFileCountDisplay(data.files.length);
        }
      } catch(e) {
        showToast('加载最近文件失败', 'error');
      }
    };

    function exitRecentFilesMode() {
      if (!isRecentFilesMode) return;
      isRecentFilesMode = false;
      window._recentFilesCache = null;
      var label = document.getElementById('sortDropdownLabel');
      if (label) {
        var sortKey = (currentSort || 'updated_at') + '-' + (currentOrder || 'desc');
        var sortLabels = {
          'updated_at-desc': '↕ 更新时间', 'updated_at-asc': '↕ 更新时间',
          'filename-asc': '↕ 名称 A-Z', 'filename-desc': '↕ 名称 Z-A',
          'size-desc': '↕ 大小', 'size-asc': '↕ 大小',
          'created_at-desc': '↕ 创建时间', 'created_at-asc': '↕ 创建时间',
          'type-asc': '↕ 类型',
          'position-asc': '↕ 手动排序'
        };
        label.textContent = sortLabels[sortKey] || '↕ 排序';
      }
      loadFiles();
    }

    var _autoRefreshInterval = null;
    window.toggleAutoRefresh = function() {
      if (_autoRefreshInterval) {
        clearInterval(_autoRefreshInterval);
        _autoRefreshInterval = null;
        updateAutoRefreshBtn(false);
        showToast('已关闭自动刷新', 'info');
      } else {
        _autoRefreshInterval = setInterval(function() {
          if (!_autoRefreshInterval) return;
          var modal = document.getElementById('modal');
          var isOpen = modal && modal.classList.contains('open');
          if (!isOpen) loadFiles();
        }, 30000);
        updateAutoRefreshBtn(true);
        showToast('已开启自动刷新（每30秒）', 'success');
      }
    };

    window.updateAutoRefreshBtn = function(active) {
      var btn = document.getElementById('autoRefreshBtn');
      if (!btn) return;
      btn.style.color = active ? 'var(--accent)' : '';
      btn.style.opacity = active ? '1' : '';
    };

    async function loadFiles() {
      if (isRecentFilesMode) {
        isRecentFilesMode = false;
        if (window._recentFilesCache) {
          window._recentFilesCache = null;
        }
      }
      if (currentVirtualFolderId !== null) {
        currentVirtualFolderId = null;
        var breadcrumb = document.getElementById('breadcrumb');
        if (breadcrumb) breadcrumb.style.display = 'none';
      }
      clearNavHighlight();
      lastClickedIndex = -1;  // reset shift-click anchor on file list change
      currentOffset = 0;
      const q = document.getElementById('searchInput').value.trim();
      currentSearchQuery = q;  // expose for highlight in render
      const selectedTag = (document.getElementById('tagFilterInput') || {}).dataset.selectedTag || '';
      const sortParam = 'sort=' + encodeURIComponent(currentSort) + '&order=' + encodeURIComponent(currentOrder);
      // Merge single-tag dropdown (selectedTag) with multi-select chips (currentTagFilters); OR logic
      const allTagFilters = selectedTag
        ? (currentTagFilters.includes(selectedTag) ? currentTagFilters : [...currentTagFilters, selectedTag])
        : currentTagFilters;
      const tagMatchMode = window._tagMatchMode || 'OR';
      const tagParam = allTagFilters.length ? '&tags=' + allTagFilters.map(encodeURIComponent).join(',') + '&tagMatch=' + tagMatchMode : '';
      const typeParam = currentTypeFilters.length ? '&type=' + currentTypeFilters.map(encodeURIComponent).join(',') : '';
      // Advanced search filters (size in KB, dates as YYYY-MM-DD)
      var sizeMinParam = '', sizeMaxParam = '', dateFromParam = '', dateToParam = '', tagMatchParam = '';
      var sizeMin = localStorage.getItem('adv_size_min');
      var sizeMax = localStorage.getItem('adv_size_max');
      var dateFrom = localStorage.getItem('adv_date_from');
      var dateTo = localStorage.getItem('adv_date_to');
      var tagMatch = localStorage.getItem('adv_tag_match');
      if (sizeMin) sizeMinParam = '&size_min=' + encodeURIComponent(sizeMin);
      if (sizeMax) sizeMaxParam = '&size_max=' + encodeURIComponent(sizeMax);
      if (dateFrom) dateFromParam = '&date_from=' + encodeURIComponent(dateFrom);
      if (dateTo) dateToParam = '&date_to=' + encodeURIComponent(dateTo);
      if (tagMatch && tagMatch !== 'all') tagMatchParam = '&tagMatch=' + encodeURIComponent(tagMatch);
      const advParams = sizeMinParam + sizeMaxParam + dateFromParam + dateToParam + tagMatchParam;
      // Append search mode param (glob/regex bypass FTS5)
      const modeParam = (_searchMode !== 'normal') ? '&mode=' + _searchMode : '';
      // Use /api/search for any filtering (supports size/date/tagMatch); /api/list only supports sort/order/type/tags
      const hasFilters = q || advParams || allTagFilters.length || currentTypeFilters.length;
      const url = hasFilters
        ? '/api/search?q=' + encodeURIComponent(q || '') + '&' + sortParam + tagParam + typeParam + advParams + modeParam
        : '/api/list?' + sortParam + tagParam + typeParam;
      await loadFilesFromUrl(url, false);
    }

    async function loadFilesFromUrl(url, append) {
      const sentinel = document.getElementById('scrollSentinel');
      const loading = document.getElementById('scrollLoading');
      if (append) {
        loading.style.display = 'block';
      }
      // Abort any in-flight request and start a new seq
      if (_activeController) { _activeController.abort(); }
      _activeController = new AbortController();
      var mySeq = ++_loadSeq;
      // Only fetch tags on first load, not on append/pagination; use cache when available
      var tagData = null;
      if (!append) {
        tagData = _cachedTagData || null;
        if (!tagData) {
          tagData = await request('/api/tags', { signal: _activeController.signal });
          if (tagData) _cachedTagData = tagData;
        }
      }
      const data = await request(url, { signal: _activeController.signal });
      // Ignore stale responses (response came back after a newer request)
      if (mySeq !== _loadSeq) return;
      // data is null if request was aborted
      if (!data) return;
      const incoming = (data.files || []).map(function(f, i) { f._index = currentOffset + i; return f; });
      currentTotal = data.total || 0;
      const prevLen = currentFiles.length;
      if (append) {
        currentFiles = currentFiles.concat(incoming);
      } else {
        currentFiles = incoming;
      }
      currentOffset = currentFiles.length;
      // Expose raw file list for batch operations (ID→filename lookup)
      window._currentFiles = currentFiles;
      // Update image gallery file list for prev/next navigation
      setGalleryFiles(currentFiles.filter(function(f) { return (f.content_type || f.mime || '').startsWith('image/'); }));
      const tagColorMap = {};
      if (tagData && tagData.tags) {
        tagData.tags.forEach(function(t) { tagColorMap[t.tag] = t.color || '#e0e7ff'; });
        updateTagFilterOptions(tagData.tags);
        renderTagChips();
        renderTagQuickBar(tagData);
      }
      // Always load folder tag definitions on first load (independent of file tags)
      if (!append) {
        const ftRes = await request('/api/folder-tags');
        if (ftRes.tags) {
          window._folderTagDefinitions = ftRes.tags;
          renderFolderTagFilterBar();
        }
      }
      // Enrich tagColorMap with folder tag definitions (colors + icons) for colored file row chips
      if (window._folderTagDefinitions) {
        window._folderTagDefinitions.forEach(function(td) {
          if (!tagColorMap[td.name]) {
            tagColorMap[td.name] = { color: td.color || '#e0e7ff', icon: td.icon || '' };
          } else {
            // Already have entry — ensure icon is captured if present
            tagColorMap[td.name] = { color: tagColorMap[td.name].color || td.color || '#e0e7ff', icon: td.icon || tagColorMap[td.name].icon || '' };
          }
        });
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
      const selectedTag = (document.getElementById('tagFilterInput') || {}).dataset.selectedTag || '';
      const sortParam = 'sort=' + encodeURIComponent(currentSort) + '&order=' + encodeURIComponent(currentOrder);
      const tagParam = selectedTag ? '&tags=' + encodeURIComponent(selectedTag) : '';
      const typeParam = currentTypeFilters.length ? '&type=' + currentTypeFilters.map(encodeURIComponent).join(',') : '';
      // Advanced search filters (same as loadFiles)
      var sizeMinParam = '', sizeMaxParam = '', dateFromParam = '', dateToParam = '', tagMatchParam = '';
      var sizeMin = localStorage.getItem('adv_size_min');
      var sizeMax = localStorage.getItem('adv_size_max');
      var dateFrom = localStorage.getItem('adv_date_from');
      var dateTo = localStorage.getItem('adv_date_to');
      var tagMatch = localStorage.getItem('adv_tag_match');
      if (sizeMin) sizeMinParam = '&size_min=' + encodeURIComponent(sizeMin);
      if (sizeMax) sizeMaxParam = '&size_max=' + encodeURIComponent(sizeMax);
      if (dateFrom) dateFromParam = '&date_from=' + encodeURIComponent(dateFrom);
      if (dateTo) dateToParam = '&date_to=' + encodeURIComponent(dateTo);
      if (tagMatch && tagMatch !== 'all') tagMatchParam = '&tagMatch=' + encodeURIComponent(tagMatch);
      const advParams = sizeMinParam + sizeMaxParam + dateFromParam + dateToParam + tagMatchParam;
      const modeParam = (_searchMode !== 'normal') ? '&mode=' + _searchMode : '';
      const hasFilters = q || advParams || currentTypeFilters.length;
      const baseUrl = hasFilters
        ? '/api/search?q=' + encodeURIComponent(q || '') + '&' + sortParam + tagParam + typeParam + advParams + modeParam
        : '/api/list?' + sortParam + tagParam + typeParam;
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

    // Typeahead dropdown data cache
    window._allTags = [];

    function updateTagFilterOptions(tags) {
      // Store tags globally for typeahead filtering
      window._allTags = tags || [];
      const sel = document.getElementById('tagFilterInput');
      if (!sel) return;
      // Keep current value, just update cache
      renderTagFilterDropdown(sel.value);
    }

    function renderTagFilterDropdown(filter) {
      // filter = current input value (for typeahead filtering)
      const list = document.getElementById('tagFilterList');
      const input = document.getElementById('tagFilterInput');
      const clearBtn = document.getElementById('tagFilterClear');
      if (!list || !input) return;
      const all = window._allTags || [];
      const q = (filter || '').toLowerCase().trim();
      const filtered = q ? all.filter(function(t) { return t.tag.toLowerCase().includes(q); }) : all.slice(0, 50);
      const selected = input.dataset.selectedTag || '';

      let html = '';
      // "All tags" option at top
      html += '<div class="tag-filter-item' + (!selected ? ' active' : '') + '" onclick="selectTagFilter(\'\')" style="padding:7px 12px;cursor:pointer;border-radius:6px;color:var(--text-muted);font-size:12px">' +
        '全部标签' + (all.length ? ' <span style="opacity:.5">(' + all.reduce(function(s, t) { return s + (t.count || 0); }, 0) + ')</span>' : '') + '</div>';
      if (filtered.length === 0 && q) {
        html += '<div style="padding:7px 12px;color:var(--text-muted);font-size:12px">无匹配标签</div>';
      }
      filtered.forEach(function(t) {
        const isSelected = t.tag === selected;
        const color = t.color || '#e0e7ff';
        html += '<div class="tag-filter-item' + (isSelected ? ' active' : '') + '" onclick="selectTagFilter(' + JSON.stringify(t.tag) + ')" style="padding:7px 12px;cursor:pointer;border-radius:6px;display:flex;align-items:center;gap:8px' + (isSelected ? ';' : '') + '">' +
          '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + color + ';flex-shrink:0"></span>' +
          '<span style="flex:1">' + escapeHtmlClient(t.tag) + '</span>' +
          '<span style="opacity:.5;font-size:11px">' + t.count + '</span>' +
          (isSelected ? ' <span style="color:var(--accent);font-size:11px">✓</span>' : '') +
          '</div>';
      });

      list.innerHTML = html;
      // Update clear button visibility
      if (clearBtn) clearBtn.style.display = selected ? 'block' : 'none';
    }

    function openTagFilterDropdown() {
      const dropdown = document.getElementById('tagFilterDropdown');
      if (dropdown) {
        dropdown.style.display = 'block';
        renderTagFilterDropdown(document.getElementById('tagFilterInput').value);
      }
      document.addEventListener('click', closeTagFilterOnClickOutside, { once: true });
    }

    function filterTagFilterDropdown() {
      renderTagFilterDropdown(document.getElementById('tagFilterInput').value);
    }

    function closeTagFilterOnClickOutside(e) {
      const wrapper = document.getElementById('tagFilterWrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        const dropdown = document.getElementById('tagFilterDropdown');
        if (dropdown) dropdown.style.display = 'none';
        // Restore display if there's a selected tag
        const input = document.getElementById('tagFilterInput');
        if (input && input.dataset.selectedTag) {
          input.value = input.dataset.selectedTag;
        }
      }
      // Also close sort dropdown when clicking outside
      const sortBtn = document.getElementById('sortDropdownBtn');
      const sortMenu = document.getElementById('sortDropdownMenu');
      if (sortBtn && sortMenu && sortMenu.style.display !== 'none' && !sortBtn.contains(e.target) && !sortMenu.contains(e.target)) {
        sortMenu.style.display = 'none';
      }
    }

    function handleTagFilterKeydown(e) {
      const dropdown = document.getElementById('tagFilterDropdown');
      if (!dropdown || dropdown.style.display === 'none') {
        if (e.key === 'Enter') {
          // Force open dropdown on Enter
          openTagFilterDropdown();
          e.preventDefault();
        }
        return;
      }
      const items = [].slice.call(dropdown.querySelectorAll('.tag-filter-item'));
      const active = dropdown.querySelector('.tag-filter-item.active');
      const idx = items.indexOf(active);
      if (e.key === 'Escape') {
        dropdown.style.display = 'none';
        const input = document.getElementById('tagFilterInput');
        if (input && input.dataset.selectedTag) input.value = input.dataset.selectedTag;
        input && input.blur();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = items[Math.min(idx + 1, items.length - 1)];
        if (next) {
          items.forEach(function(i) { i.classList.remove('active'); });
          next.classList.add('active');
          next.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = items[Math.max(idx - 1, 0)];
        if (prev) {
          items.forEach(function(i) { i.classList.remove('active'); });
          prev.classList.add('active');
          prev.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (active) active.click();
        else dropdown.style.display = 'none';
      } else if (e.key === 'Tab') {
        dropdown.style.display = 'none';
      }
    }

    function selectTagFilter(tag) {
      const input = document.getElementById('tagFilterInput');
      const dropdown = document.getElementById('tagFilterDropdown');
      if (!input) return;
      input.dataset.selectedTag = tag;
      input.value = tag;
      if (dropdown) dropdown.style.display = 'none';
      const clearBtn = document.getElementById('tagFilterClear');
      if (clearBtn) clearBtn.style.display = tag ? 'block' : 'none';
      filterByTag();
    }

    function filterByTag() {
      loadFiles();
    }

    function clearTagFilter() {
      const input = document.getElementById('tagFilterInput');
      if (input) {
        input.value = '';
        input.dataset.selectedTag = '';
      }
      const clearBtn = document.getElementById('tagFilterClear');
      if (clearBtn) clearBtn.style.display = 'none';
      loadFiles();
    }

    // Tag chips multi-select (OR logic)
    function toggleTagFilterChip(tag) {
      var idx = currentTagFilters.indexOf(tag);
      if (idx === -1) {
        currentTagFilters.push(tag);
      } else {
        currentTagFilters.splice(idx, 1);
      }
      localStorage.setItem('tagFilters', currentTagFilters.join(','));
      renderTagChips();
      loadFiles();
    }

    function clearTagFilterChips() {
      currentTagFilters = [];
      window._tagMatchMode = 'OR';
      localStorage.setItem('tagFilters', '');
      renderTagChips();
      loadFiles();
    }

    function toggleTagMatchMode() {
      window._tagMatchMode = (window._tagMatchMode || 'OR') === 'OR' ? 'AND' : 'OR';
      localStorage.setItem('tagMatchMode', window._tagMatchMode);
      renderTagQuickBar({ tags: window._allTags || [] });
      loadFiles();
    }

    // Sort dropdown functions
    function toggleSortDropdown() {
      var menu = document.getElementById('sortDropdownMenu');
      var wasOpen = menu && menu.style.display !== 'none';
      // Close all other dropdowns
      closeAllDropdowns();
      if (wasOpen) {
        if (menu) menu.style.display = 'none';
      } else {
        if (menu) menu.style.display = 'block';
        updateSortDropdownActive();
      }
    }

    function setSortFromDropdown(sort, order) {
      isRecentFilesMode = false; // exit recent files mode on any sort change
      currentSort = sort;
      currentOrder = order;
      localStorage.setItem('sortBy', sort);
      localStorage.setItem('sortOrder', order);
      updateSortDropdownLabel();
      updateSortDropdownActive();
      updateQuickSortButtons();
      closeAllDropdowns();
      loadFiles();
    }

    function updateSortDropdownLabel() {
      var label = document.getElementById('sortDropdownLabel');
      if (!label) return;
      var sortLabels = {
        'updated_at-desc': '↕ 最新优先',
        'updated_at-asc': '↑ 最旧优先',
        'filename-asc': 'A↕ 名称',
        'filename-desc': 'Z↕ 名称',
        'size-desc': '⬇ 最大优先',
        'size-asc': '⬆ 最小优先',
        'created_at-desc': '🕐 最新创建',
        'created_at-asc': '🕐 最旧创建',
        'type-asc': '📂 类型',
        'position-asc': '📌 手动'
      };
      label.textContent = sortLabels[currentSort + '-' + currentOrder] || '↕ 排序';
    }

    function updateSortDropdownActive() {
      var items = document.querySelectorAll('[id^="sortItem-"]');
      items.forEach(function(item) { item.style.fontWeight = ''; item.style.color = ''; });
      var active = document.getElementById('sortItem-' + currentSort + '-' + currentOrder);
      if (active) { active.style.fontWeight = '600'; active.style.color = 'var(--accent)'; }
    }

    function updateQuickSortButtons() {
      var qsKeys = { 'updated_at-desc': 'qs-updated', 'filename-asc': 'qs-name', 'size-desc': 'qs-size', 'type-asc': 'qs-type' };
      var key = currentSort + '-' + currentOrder;
      var activeId = qsKeys[key];
      ['qs-updated', 'qs-name', 'qs-size', 'qs-type'].forEach(function(id) {
        var btn = document.getElementById(id);
        if (!btn) return;
        if (id === activeId) {
          btn.style.background = 'var(--accent)';
          btn.style.color = 'white';
        } else {
          btn.style.background = 'var(--bg-tertiary)';
          btn.style.color = 'var(--muted)';
        }
      });
    }

    function closeAllDropdowns() {
      var tagDd = document.getElementById('tagFilterDropdown');
      if (tagDd) tagDd.style.display = 'none';
      var sortDd = document.getElementById('sortDropdownMenu');
      if (sortDd) sortDd.style.display = 'none';
      var vfDd = document.getElementById('vfMenu');
      if (vfDd) vfDd.style.display = 'none';
    }

    // 点击文件列表中的标签 chip 进行筛选
    function filterBySingleTag(tag) {
      const input = document.getElementById('tagFilterInput');
      if (input) {
        input.value = tag;
        input.dataset.selectedTag = tag;
        const clearBtn = document.getElementById('tagFilterClear');
        if (clearBtn) clearBtn.style.display = tag ? 'block' : 'none';
        loadFiles();
      }
    }

    // 标签筛选栏：多选chips，OR逻辑（与typeFilter chips相同模式）
    function renderTagChips() {
      const bar = document.getElementById('tagChipsBar');
      if (!bar) return;
      const allTags = window._allTags || [];
      if (!allTags.length) { bar.style.display = 'none'; return; }
      const top = allTags.slice(0, 12); // show up to 12 tag chips
      bar.innerHTML = top.map(function(t) {
        const active = currentTagFilters.indexOf(t.tag) !== -1;
        const tc = t.color || '#e0e7ff';
        const escaped = escapeHtmlClient(t.tag);
        const style = 'background:' + (active ? tc : 'var(--bg-tertiary)') + ';font-size:11px;padding:3px 10px;border-radius:999px;font-weight:500;cursor:pointer;color:' + (active ? 'inherit' : 'var(--text-muted)') + ';border:1px solid ' + (active ? tc : 'var(--line)');
        return '<span class="tag-chip" style="' + style + '" onclick="toggleTagFilterChip(' + JSON.stringify(t.tag) + ')" title="筛选: ' + escaped + '">' + escaped + ' <span style="opacity:.6">' + t.count + '</span></span>';
      }).join('');
      bar.style.display = 'flex';
    }

    // ── Folder Tag Filter Bar ────────────────────────────────────────────────
    // Renders the "🏷️ 收藏夹标签" quick bar below the main tag bar
    function renderFolderTagFilterBar() {
      const bar = document.getElementById('folderTagFilterBar');
      if (!bar) return;
      const tags = window._folderTagDefinitions || [];
      if (!tags.length) { bar.style.display = 'none'; return; }
      const activeId = window._activeFolderTagFilter;
      var html = '<div style="display:flex;flex-wrap:nowrap;overflow-x:auto;gap:6px;padding:6px 0;align-items:center;-webkit-overflow-scrolling:touch;scrollbar-width:none">';
      html += '<span style="font-size:11px;color:var(--muted);margin-right:4px;white-space:nowrap;flex-shrink:0">🏷️ 收藏夹:</span>';
      if (activeId) {
        const activeTag = tags.find(t => String(t.id) === String(activeId));
        const color = activeTag ? (activeTag.color || '#e0e7ff') : '#e0e7ff';
        const name = activeTag ? activeTag.name : '未知';
        html += '<span style="background:' + escapeHtmlClient(color) + ';font-size:11px;padding:3px 10px;border-radius:999px;font-weight:500;color:inherit;cursor:pointer;white-space:nowrap;flex-shrink:0" onclick="clearFolderTagFilter()" title="点击清除">' + escapeHtmlClient(name) + ' ×</span>';
        html += '<button onclick="clearFolderTagFilter()" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--muted);padding:2px 6px;border-radius:4px;white-space:nowrap;flex-shrink:0" title="清除筛选">✕</button>';
        html += '<div style="width:1px;height:16px;background:var(--line);margin:0 4px;flex-shrink:0"></div>';
      }
      html += tags.map(t => {
        if (String(t.id) === String(activeId)) return '';
        const color = t.color || '#e0e7ff';
        const name = escapeHtmlClient(t.name);
        return '<span style="background:' + color + ';font-size:11px;padding:3px 10px;border-radius:999px;font-weight:500;cursor:pointer;color:inherit;opacity:0.8;white-space:nowrap;flex-shrink:0" onclick="navigateVirtualFolderByFolderTag(' + t.id + ')" title="查看收藏夹: ' + name + '">' + name + '</span>';
      }).join('');
      html += '</div>';
      bar.innerHTML = html;
      bar.style.display = 'block';
    }

    function clearFolderTagFilter() {
      window._activeFolderTagFilter = null;
      localStorage.removeItem('folderTagFilter');
      renderFolderTagFilterBar();
      loadFiles();
    }

    async function navigateVirtualFolderByFolderTag(tagId) {
      window._activeFolderTagFilter = String(tagId);
      localStorage.setItem('folderTagFilter', String(tagId));
      // Get the first VF with this tag and navigate to it
      const res = await fetch('/api/folder-tags/' + tagId + '/virtual-folders', { headers: headers() });
      const data = await res.json();
      const vfs = data.virtualFolders || [];
      if (vfs.length === 0) {
        showToast('该标签暂无收藏夹', 'info');
        return;
      }
      navigateVirtualFolder(vfs[0].id);
      renderFolderTagFilterBar();
    }

    // 标签快速访问栏：显示所有标签，点击直接筛选
    function renderTagQuickBar(tagData) {
      const bar = document.getElementById('tagQuickBar');
      if (!bar) return;
      const tags = tagData.tags || [];
      const activeTag = (document.getElementById('tagFilterInput') || {}).dataset.selectedTag || '';
      const hasChipFilter = currentTagFilters.length > 0;
      if (!tags.length) { bar.style.display = 'none'; return; }
      // 显示最多8个，按使用频率排序
      const top = tags.slice(0, 8);
      var inner = '<div style="display:flex;flex-wrap:nowrap;overflow-x:auto;gap:6px;padding:8px 0;align-items:center;-webkit-overflow-scrolling:touch;scrollbar-width:none">';
      if (activeTag) {
        var activeColor = '#e0e7ff';
        for (var i = 0; i < tags.length; i++) { if (tags[i].tag === activeTag) { activeColor = tags[i].color || '#e0e7ff'; break; } }
        inner += '<span style="font-size:11px;color:var(--muted);margin-right:4px;white-space:nowrap;flex-shrink:0">标签:</span>';
        inner += '<span class="tag-badge" style="background:' + activeColor + ';font-size:11px;padding:3px 10px;border-radius:999px;font-weight:500;color:inherit;white-space:nowrap;flex-shrink:0"> ' + escapeHtmlClient(activeTag) + ' <span style="opacity:.7;cursor:pointer" onclick="clearTagFilter()">×</span></span>';
        inner += '<button onclick="clearTagFilter()" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--muted);padding:2px 6px;border-radius:4px;white-space:nowrap;flex-shrink:0" title="清除筛选">✕</button>';
        inner += '<div style="width:1px;height:16px;background:var(--line);margin:0 4px;flex-shrink:0"></div>';
      }
      // Show active tag chips (multi-select filter) with individual remove buttons
      if (currentTagFilters.length > 0) {
        inner += '<span style="font-size:11px;color:var(--muted);margin-right:4px;white-space:nowrap;flex-shrink:0">标签:</span>';
        currentTagFilters.forEach(function(tag) {
          var tagColor = '#e0e7ff';
          for (var j = 0; j < tags.length; j++) { if (tags[j].tag === tag) { tagColor = tags[j].color || '#e0e7ff'; break; } }
          var escaped = escapeHtmlClient(tag);
          inner += '<span class="tag-badge" style="background:' + tagColor + ';font-size:11px;padding:3px 10px;border-radius:999px;font-weight:500;color:inherit;white-space:nowrap;flex-shrink:0">' + escaped + ' <span style="opacity:.7;cursor:pointer" onclick="event.stopPropagation();toggleTagFilterChip(' + JSON.stringify(tag) + ')">×</span></span>';
        });
        inner += '<button onclick="clearTagFilterChips()" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--muted);padding:2px 6px;border-radius:4px;white-space:nowrap;flex-shrink:0" title="清除标签筛选">✕</button>';
        // AND/OR match mode toggle — only show when 2+ tags active
        if (currentTagFilters.length >= 2) {
          var mode = window._tagMatchMode || 'OR';
          var andActive = mode === 'AND';
          inner += '<div style="display:flex;gap:0;flex-shrink:0;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-left:4px">';
          inner += '<button onclick="toggleTagMatchMode()" style="padding:2px 8px;font-size:10px;border:none;cursor:pointer;background:' + (andActive ? 'var(--accent)' : 'var(--bg-secondary)') + ';color:' + (andActive ? 'white' : 'var(--text-muted)') + ';font-weight:500" title="满足所有标签">AND</button>';
          inner += '<button onclick="toggleTagMatchMode()" style="padding:2px 8px;font-size:10px;border:none;cursor:pointer;background:' + (!andActive ? 'var(--accent)' : 'var(--bg-secondary)') + ';color:' + (!andActive ? 'white' : 'var(--text-muted)') + ';font-weight:500" title="满足任一标签">OR</button>';
          inner += '</div>';
        }
        inner += '<div style="width:1px;height:16px;background:var(--line);margin:0 4px;flex-shrink:0"></div>';
      }
      inner += top.map(function(t) {
        if (t.tag === activeTag || currentTagFilters.indexOf(t.tag) !== -1) return ''; // skip active + chip-selected tags
        var tc = t.color || '#e0e7ff';
        var escaped = escapeHtmlClient(t.tag);
        return '<span class="tag-badge" style="background:' + tc + ';font-size:11px;padding:3px 10px;border-radius:999px;font-weight:500;cursor:pointer;color:inherit;white-space:nowrap;flex-shrink:0" onclick="filterBySingleTag(\'' + escaped.replace(/'/g, "\\'") + '\')" title="筛选: ' + escaped + '">' + escaped + ' <span style="opacity:.6">' + t.count + '</span></span>';
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
      // Fetch tags for each VF in parallel (folder_path = VF name)
      const folderTags = await Promise.all(data.folders.map(f =>
        fetch('/api/folders/' + encodeURIComponent(f.name) + '/tags', { headers: headers() })
          .then(r => r.json())
          .then(d => ({ id: f.id, tags: d.tags || [] }))
          .catch(() => ({ id: f.id, tags: [] }))
      ));
      const tagMap = {};
      folderTags.forEach(ft => { tagMap[ft.id] = ft.tags; });

      list.innerHTML = data.folders.map(f => {
        const tags = tagMap[f.id] || [];
        const tagChips = tags.length > 0
          ? '<span style="margin-left:4px">' + tags.map(t =>
              '<span style="background:' + escapeHtmlClient(t.color || '#e0e7ff') + ';font-size:10px;padding:1px 5px;border-radius:8px;font-weight:500;color:inherit;display:inline-block;vertical-align:middle">' +
              (t.icon ? escapeHtmlClient(t.icon) + ' ' : '') + escapeHtmlClient(t.name) + '</span>'
            ).join('') + '</span>'
          : '';
        return '<div class="ctx-item" onclick="navigateVirtualFolder(' + f.id + ')" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center">' +
          '<span><span style="color:' + escapeHtmlClient(f.color || '#667eea') + '">●</span> ' +
          escapeHtmlClient(f.name) + ' <span style="color:var(--muted);font-size:11px">(' + f.file_count + ' 个, ' + (f.total_size ? formatFileSize(f.total_size) : '0 B') + ')</span>' + tagChips + '</span>' +
          '<span style="display:flex;gap:2px;align-items:center">' +
            '<button onclick="event.stopPropagation();openVFFolderDetail(' + f.id + ',' + JSON.stringify(f.name).replace(/"/g, '&quot;') + ')" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:11px;padding:2px 5px;border-radius:4px" title="详情/标签">ℹ️</button>' +
            '<button onclick="event.stopPropagation();downloadVirtualFolder(' + f.id + ',' + JSON.stringify(f.name).replace(/"/g, '&quot;') + ')" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:11px;padding:2px 5px;border-radius:4px" title="下载为 ZIP">⬇</button>' +
          '</span>' +
        '</div>';
      }).join('');
    }

    async function openVFFolderDetail(vfId, vfName) {
      document.getElementById('vfMenu').style.display = 'none';
      // Fetch VF info, folder tags, and all tag definitions in parallel
      const [vfRes, ftDefRes, currentTagsRes] = await Promise.all([
        request('/api/virtual-folders/' + vfId),
        request('/api/folder-tags'),
        request('/api/folders/' + encodeURIComponent(vfName) + '/tags')
      ]);
      const vf = vfRes.folder || vfRes;
      const allTags = ftDefRes.tags || [];
      const currentTagIds = (currentTagsRes.tags || []).map(t => t.id);

      var modal = document.getElementById('vfDetailModal');
      if (modal) modal.remove();
      modal = document.createElement('div');
      modal.id = 'vfDetailModal';
      modal.className = 'modal';

      function renderVFTagSection() {
        var html = '<div style="margin-top:10px">';
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px;min-height:32px">';
        if (currentTagIds.length === 0) {
          html += '<span style="color:var(--muted);font-size:13px">暂无标签</span>';
        } else {
          var currentTags = allTags.filter(function(t) { return currentTagIds.includes(t.id); });
          currentTags.forEach(function(t) {
            html += '<span style="background:' + escapeHtmlClient(t.color || '#e0e7ff') + ';font-size:12px;padding:3px 8px;border-radius:10px;font-weight:500;color:inherit;display:inline-flex;align-items:center;gap:4px">' +
              (t.icon ? escapeHtmlClient(t.icon) + ' ' : '') + escapeHtmlClient(t.name) +
              '<button onclick="removeVFTag(' + vfId + ',' + JSON.stringify(vfName) + ',' + t.id + ')" style="background:none;border:none;cursor:pointer;color:inherit;opacity:.7;font-size:13px;line-height:1;padding:0">✕</button></span>';
          });
        }
        html += '</div>';
        html += '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:5px">';
        allTags.forEach(function(t) {
          var assigned = currentTagIds.includes(t.id);
          html += '<button onclick="toggleVFTag(' + vfId + ',' + JSON.stringify(vfName) + ',' + t.id + ',' + (assigned ? 'true' : 'false') + ')" ' +
            'style="font-size:11px;padding:3px 8px;border-radius:8px;cursor:pointer;font-weight:500;border:1px solid ' + escapeHtmlClient(t.color || '#e0e7ff') + ';background:' + (assigned ? (t.color || '#e0e7ff') : 'transparent') + ';color:' + (assigned ? 'inherit' : (t.color || '#3730a3')) + ';opacity:' + (assigned ? '1' : '0.7') + '">' +
            (t.icon ? escapeHtmlClient(t.icon) + ' ' : '') + escapeHtmlClient(t.name) + '</button>';
        });
        html += '</div></div>';
        return html;
      }

      modal.innerHTML = '\
        <div class="modal-content" style="max-width:440px">\
          <h3 style="margin-bottom:4px">收藏夹详情</h3>\
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">\
            <span style="position:relative;display:inline-block">\
              <span id="vfDetailColorDot" onclick="document.getElementById('vfDetailColorPicker').click()" style="font-size:18px;color:' + escapeHtmlClient(vf.color || '#667eea') + ';cursor:pointer" title="点击更换颜色">●</span>\
              <input type="color" id="vfDetailColorPicker" value="' + escapeHtmlClient(vf.color || '#667eea') + '" ' +
                'onchange="updateVFColor(' + vfId + ',' + JSON.stringify(vfName).replace(/\"/g, '&quot;') + ',this.value)" ' +
                'style="position:absolute;opacity:0;width:20px;height:20px;left:0;top:0;cursor:pointer">\
            </span>\
            <strong id="vfDetailName" style="font-size:15px;cursor:pointer" title="双击重命名" ondblclick="startVFRename()">' + escapeHtmlClient(vf.name) + '</strong>\
            <span style="color:var(--muted);font-size:12px">' + (vf.file_count || vf.fileCount || 0) + ' 个文件 · ' + (vf.total_size ? formatFileSize(vf.total_size) : '0 B') + '</span>\
          </div>\
          <div style="border-top:1px solid var(--line);padding-top:10px">\
            <div style="font-size:12px;font-weight:500;color:var(--muted);margin-bottom:6px">🏷️ 标签</div>\
            <div id="vfTagSection">' + renderVFTagSection() + '</div>\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">\
            <button onclick="deleteVFFromDetail()" style="padding:8px 16px;border-radius:8px;border:1px solid var(--error);background:transparent;color:var(--error);cursor:pointer;font-size:13px">删除收藏夹</button>\
            <button onclick="openVFFolderManagerFromDetail()" style="padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:var(--bg-secondary);cursor:pointer;font-size:13px">管理收藏夹</button>\
            <button onclick="closeVFFolderDetail()" style="padding:8px 16px;border-radius:8px;background:var(--accent);color:#fff;border:none;cursor:pointer;font-size:13px">关闭</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      modal.style.display = 'flex';

      window._vfDetailCache = { vfId: vfId, vfName: vfName, allTags: allTags, currentTagIds: currentTagIds };
    }

    async function toggleVFTag(vfId, vfName, tagId, currentlyAssigned) {
      var cache = window._vfDetailCache || {};
      var tagIds = currentlyAssigned
        ? (cache.currentTagIds || []).filter(function(id) { return id !== tagId; })
        : [...(cache.currentTagIds || []), tagId];
      await request('/api/folders/' + encodeURIComponent(vfName) + '/tags', { method: 'PUT', body: JSON.stringify({ tagIds: tagIds }) });
      openVFFolderDetail(vfId, vfName);
    }

    window.updateVFColor = async function(vfId, vfName, color) {
      var dot = document.getElementById('vfDetailColorDot');
      if (dot) dot.style.color = color;
      await request('/api/virtual-folders/' + vfId, { method: 'PATCH', body: JSON.stringify({ color: color }) });
      broadcastSSE({ type: 'files_changed' });
      showToast('颜色已更新', 'success');
    };

    window.startVFRename = function() {
      var cache = window._vfDetailCache || {};
      if (!cache.vfId) return;
      var nameEl = document.getElementById('vfDetailName');
      if (!nameEl) return;
      var currentName = nameEl.textContent || '';
      nameEl.style.display = 'none';
      var input = document.createElement('input');
      input.type = 'text';
      input.id = 'vfDetailNameInput';
      input.value = currentName;
      input.style.cssText = 'font-size:15px;padding:2px 6px;border-radius:4px;border:1px solid var(--accent);background:var(--bg);color:var(--text);outline:none;width:140px';
      input.onkeydown = function(e) {
        if (e.key === 'Enter') { input.blur(); }
        if (e.key === 'Escape') { cancelVFRename(currentName); }
      };
      input.onblur = function() { finishVFRename(cache.vfId, input.value, currentName); };
      nameEl.parentNode.insertBefore(input, nameEl.nextSibling);
      input.focus();
      input.select();
    };

    window.cancelVFRename = function(currentName) {
      var input = document.getElementById('vfDetailNameInput');
      if (input) input.remove();
      var nameEl = document.getElementById('vfDetailName');
      if (nameEl) { nameEl.style.display = ''; nameEl.textContent = currentName; }
    };

    window.finishVFRename = async function(vfId, newName, oldName) {
      var input = document.getElementById('vfDetailNameInput');
      if (input) input.remove();
      var trimmed = (newName || '').trim();
      if (!trimmed || trimmed === oldName) {
        var nameEl = document.getElementById('vfDetailName');
        if (nameEl) { nameEl.style.display = ''; nameEl.textContent = oldName; }
        return;
      }
      var data = await request('/api/virtual-folders/' + vfId, { method: 'PATCH', body: JSON.stringify({ name: trimmed }) });
      if (data && data.success) {
        var nameEl = document.getElementById('vfDetailName');
        if (nameEl) { nameEl.style.display = ''; nameEl.textContent = trimmed; }
        window._vfDetailCache.vfName = trimmed;
        broadcastSSE({ type: 'files_changed' });
        showToast('已重命名', 'success');
      } else {
        var nameEl = document.getElementById('vfDetailName');
        if (nameEl) { nameEl.style.display = ''; nameEl.textContent = oldName; }
        showToast('重命名失败', 'error');
      }
    };

    window.deleteVFFromDetail = async function() {
      var cache = window._vfDetailCache || {};
      if (!cache.vfId) return;
      var m = document.getElementById('confirmVFDeleteModal');
      if (m) m.remove();
      m = document.createElement('div');
      m.id = 'confirmVFDeleteModal';
      m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10002;display:flex;align-items:center;justify-content:center;padding:20px';
      m.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:380px;font-size:14px;text-align:center">\
          <h3 style="margin:0 0 8px">确定删除此收藏夹？</h3>\
          <p style="margin:0 0 20px;font-size:13px;color:var(--muted)">收藏夹内的文件不会被删除，只删除收藏夹本身。</p>\
          <div style="display:flex;gap:10px;justify-content:center">\
            <button class="secondary" onclick="document.getElementById(\'confirmVFDeleteModal\').remove()">取消</button>\
            <button class="danger" onclick="doDeleteVFFromDetail()">确认删除</button>\
          </div>\
        </div>';
      document.body.appendChild(m);
      m.addEventListener('click', function(e) { if (e.target === m) m.remove(); });
    };

    window.doDeleteVFFromDetail = async function() {
      var cache = window._vfDetailCache || {};
      if (!cache.vfId) return;
      var m = document.getElementById('confirmVFDeleteModal');
      if (m) m.remove();
      await fetch('/api/virtual-folders/' + cache.vfId, { method: 'DELETE', headers: headers() });
      closeVFFolderDetail();
      broadcastSSE({ type: 'files_changed' });
      showToast('已删除', 'success');
    };

    window.removeVFTag = async function(vfId, vfName, tagId) {
      var cache = window._vfDetailCache || {};
      var tagIds = (cache.currentTagIds || []).filter(function(id) { return id !== tagId; });
      await request('/api/folders/' + encodeURIComponent(vfName) + '/tags', { method: 'PUT', body: JSON.stringify({ tagIds: tagIds }) });
      openVFFolderDetail(vfId, vfName);
    };

    window.openVFFolderManagerFromDetail = function() {
      closeVFFolderDetail();
      openVirtualFolderManager();
    };

    window.closeVFFolderDetail = function() {
      var m = document.getElementById('vfDetailModal');
      if (m) m.remove();
    };

    async function navigateVirtualFolder(folderId) {
      isRecentFilesMode = false; // exit recent files mode when entering VF
      currentVirtualFolderId = folderId;
      document.getElementById('vfMenu').style.display = 'none';
      var breadcrumb = document.getElementById('breadcrumb');
      breadcrumb.style.display = 'flex';
      breadcrumb.innerHTML = '<span style="cursor:pointer;color:var(--accent);font-weight:500" onclick="exitVirtualFolder()" title="返回全部文件">全部文件</span><span style="color:var(--muted)"> › </span><span id="breadcrumbVFName" style="color:var(--text)">加载中...</span><span id="breadcrumbVFTags" style="margin-left:4px"></span>';
      clearNavHighlight();
      const res = await fetch('/api/virtual-folders/' + folderId + '/files', { headers: headers() });
      const data = await res.json();
      const files = sortFiles(data.files || []);
      if (data.folder) {
        var nameSpan = document.getElementById('breadcrumbVFName');
        if (nameSpan) {
          nameSpan.textContent = data.folder.name;
          nameSpan.style.color = data.folder.color || 'var(--text)';
        }
        // Fetch and display VF tags in breadcrumb
        var tagsRes = await fetch('/api/folders/' + encodeURIComponent(data.folder.name) + '/tags', { headers: headers() });
        var tagsData = await tagsRes.json();
        var tagsSpan = document.getElementById('breadcrumbVFTags');
        if (tagsSpan && tagsData.tags && tagsData.tags.length > 0) {
          tagsSpan.innerHTML = ' ' + tagsData.tags.map(t =>
            '<span style="background:' + escapeHtmlClient(t.color || '#e0e7ff') + ';font-size:10px;padding:1px 6px;border-radius:8px;font-weight:500;color:inherit;display:inline-block;vertical-align:middle">' +
            (t.icon ? escapeHtmlClient(t.icon) + ' ' : '') + escapeHtmlClient(t.name) + '</span>'
          ).join(' ');
        }
      }
      currentFiles = files.map(function(f, i) { f._index = i; return f; });
      currentOffset = files.length;
      currentTotal = files.length;
      const tagColorMap = {};
      updateTagFilterOptions([]);
      // Load folder tag definitions so the filter bar is visible in VF view too
      const ftRes = await request('/api/folder-tags');
      if (ftRes.tags) {
        window._folderTagDefinitions = ftRes.tags;
        renderFolderTagFilterBar();
      }
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
      // Fetch all folder tag definitions
      const tagRes = await fetch('/api/folder-tags', { headers: headers() });
      const tagData = await tagRes.json();
      const allTags = tagData.tags || [];
      // Fetch tags for each folder in parallel
      const folderTags = await Promise.all(folders.map(f =>
        fetch('/api/folders/' + encodeURIComponent(f.name) + '/tags', { headers: headers() })
          .then(r => r.json())
          .then(d => ({ id: f.id, tags: d.tags || [] }))
          .catch(() => ({ id: f.id, tags: [] }))
      ));
      const tagMap = {};
      folderTags.forEach(ft => { tagMap[ft.id] = ft.tags; });

      function renderVFRow(f) {
        const tags = tagMap[f.id] || [];
        const tagChips = tags.length > 0
          ? tags.map(t => '<span style="background:' + escapeHtmlClient(t.color || '#e0e7ff') + ';font-size:10px;padding:1px 6px;border-radius:10px;font-weight:500;color:inherit;display:inline-block;margin-right:3px">' + (t.icon ? escapeHtmlClient(t.icon) + ' ' : '') + escapeHtmlClient(t.name) + '</span>').join('')
          : '<span style="color:var(--muted);font-size:11px">无标签</span>';
        return '<div style="display:flex;align-items:flex-start;gap:8px;padding:10px;border-radius:8px;background:var(--bg-tertiary);margin-bottom:6px">' +
          '<span style="color:' + escapeHtmlClient(f.color || '#667eea') + ';font-size:16px;margin-top:2px">●</span>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;font-weight:500;margin-bottom:4px">' + escapeHtmlClient(f.name) + ' <span style="color:var(--muted);font-size:11px">(' + f.file_count + ' 文件' + (f.size > 0 ? ', ' + formatFileSize(f.size) : '') + ')</span></div>' +
            '<div style="margin-bottom:6px" id="vfTagChips_' + f.id + '">' + tagChips + '</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap" id="vfTagEdit_' + f.id + '">' +
              allTags.map(t => {
                const active = tags.some(ft => ft.id === t.id);
                return '<span onclick="toggleVFFolderTag(' + f.id + ',' + t.id + ')" ' +
                  'style="cursor:pointer;background:' + (active ? escapeHtmlClient(t.color || '#e0e7ff') : 'var(--bg-secondary)') + ';font-size:10px;padding:2px 8px;border-radius:10px;font-weight:500;color:' + (active ? 'inherit' : 'var(--text-muted)') + ';border:1px solid ' + (active ? escapeHtmlClient(t.color || '#e0e7ff') : 'var(--line)') + ';opacity:' + (active ? '1' : '0.6') + '" ' +
                  'title="' + escapeHtmlClient(t.name) + '">' + escapeHtmlClient(t.name) + '</span>';
              }).join('') +
              (allTags.length === 0 ? '<span style="color:var(--muted);font-size:11px">先创建标签</span>' : '') +
            '</div>' +
          '</div>' +
          '<button class="ghost" style="font-size:11px;padding:3px 8px;white-space:nowrap;margin-top:2px" onclick="deleteVirtualFolder(' + f.id + ')">删除</button>' +
        '</div>';
      }

      const body = '<div style="display:flex;flex-direction:column;gap:12px">' +
        '<div id="vfList" style="max-height:340px;overflow-y:auto">' +
        (folders.length === 0 ? '<div style="color:var(--muted);text-align:center;padding:20px">暂无收藏夹，创建一个并为其添加标签</div>' :
          folders.map(f => renderVFRow(f)).join('')) +
        '</div>' +
        '<div style="border-top:1px solid var(--line);padding-top:10px">' +
          '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">点击标签chips切换分配，标签会自动创建</div>' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<input id="vfNameInput" type="text" placeholder="新收藏夹名称" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text)">' +
            '<input id="vfColorInput" type="color" value="#667eea" style="width:36px;height:36px;border:none;cursor:pointer;border-radius:6px">' +
            '<button class="secondary" onclick="createVirtualFolder()">创建</button>' +
          '</div>' +
          '<div style="margin-top:8px">' +
            '<input id="newTagNameInput" type="text" placeholder="新标签名称" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);width:calc(100% - 100px)">' +
            '<input id="newTagColorInput" type="color" value="#e0e7ff" style="width:36px;height:36px;border:none;cursor:pointer;border-radius:6px;margin-left:4px">' +
            '<button class="secondary" style="margin-left:4px" onclick="createFolderTagInVFMgr()">+ 标签</button>' +
          '</div>' +
        '</div>' +
      '</div>';
      openModal('收藏夹 + 标签管理', body, '');
    }

    async function toggleVFFolderTag(vfId, tagId) {
      // VF name is stored as data attribute on the tag chips div
      const chipsEl = document.getElementById('vfTagChips_' + vfId);
      const editEl = document.getElementById('vfTagEdit_' + vfId);
      if (!chipsEl || !editEl) return;
      const vfRow = chipsEl.closest('div[style*="background:var(--bg-tertiary)"]');
      if (!vfRow) return;
      // Find VF name from the name div inside the row
      const vfNameEl = vfRow.querySelector('div > div:first-child');
      if (!vfNameEl) return;
      const vfName = vfNameEl.textContent.replace(/\s*\(\d+\).*/,'').trim();
      if (!vfName) return;
      // Check if this specific tag is currently assigned (opacity 1 = assigned)
      const allSpans = editEl.querySelectorAll('span');
      let isAssigned = false;
      allSpans.forEach(s => {
        try {
          const style = s.getAttribute('style') || '';
          if (style.includes('opacity:0.6')) {
            // not assigned, check if this is the one we're toggling
          } else {
            // Find the onclick attribute to see if this span is for tagId
            const onclick = s.getAttribute('onclick') || '';
            if (onclick.includes(String(tagId))) {
              isAssigned = true;
            }
          }
        } catch(e) {}
      });
      if (isAssigned) {
        await fetch('/api/folders/' + encodeURIComponent(vfName) + '/tags/' + tagId, { method: 'DELETE', headers: headers() });
      } else {
        await fetch('/api/folders/' + encodeURIComponent(vfName) + '/tags/' + tagId, { method: 'POST', headers: headers() });
      }
      openVirtualFolderManager();
    }

    async function createFolderTagInVFMgr() {
      const name = document.getElementById('newTagNameInput')?.value.trim();
      const color = document.getElementById('newTagColorInput')?.value || '#e0e7ff';
      if (!name) return;
      await fetch('/api/folder-tags', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color, icon: '' })
      });
      openVirtualFolderManager();
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
      var m = document.getElementById('confirmVFDeleteModal2');
      if (m) m.remove();
      m = document.createElement('div');
      m.id = 'confirmVFDeleteModal2';
      m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10002;display:flex;align-items:center;justify-content:center;padding:20px';
      m.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:380px;font-size:14px;text-align:center">\
          <h3 style="margin:0 0 8px">确定删除此收藏夹？</h3>\
          <p style="margin:0 0 20px;font-size:13px;color:var(--muted)">收藏夹内的文件不会被删除，只删除收藏夹本身。</p>\
          <div style="display:flex;gap:10px;justify-content:center">\
            <button class="secondary" onclick="document.getElementById(\'confirmVFDeleteModal2\').remove()">取消</button>\
            <button class="danger" onclick="doDeleteVirtualFolder(' + id + ')">确认删除</button>\
          </div>\
        </div>';
      document.body.appendChild(m);
      m.addEventListener('click', function(e) { if (e.target === m) m.remove(); });
    }

    async function doDeleteVirtualFolder(id) {
      var m = document.getElementById('confirmVFDeleteModal2');
      if (m) m.remove();
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
      forceCloseModal();
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
      isRecentFilesMode = false; // exit recent files mode
      currentVirtualFolderId = null;
      var breadcrumb = document.getElementById('breadcrumb');
      if (breadcrumb) breadcrumb.style.display = 'none';
      loadFiles();
    }

    function downloadVirtualFolder(folderId, folderName) {
      var url = '/api/virtual-folders/' + folderId + '/download';
      var token = localStorage.getItem('token');
      if (token) url += (url.includes('?') ? '&' : '?') + 'token=' + token;
      var a = document.createElement('a');
      a.href = url;
      a.download = (folderName || 'folder') + '.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('正在打包下载: ' + folderName, 'info', 3000);
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

    // ============================================================
    // Incremental file sync — update currentFiles + DOM without
    // fetching from server. Keeps sort order intact.
    // ============================================================
    var _syncRenderTimer = null;

    function _buildTagColorMap() {
      var tagDefs = window._folderTagDefinitions || [];
      var map = {};
      tagDefs.forEach(function(td) {
        map[td.name] = { color: td.color || '#e0e7ff', icon: td.icon || '' };
      });
      return map;
    }

    function _scheduleSyncRender(delay) {
      if (_syncRenderTimer) clearTimeout(_syncRenderTimer);
      _syncRenderTimer = setTimeout(function() {
        _syncRenderTimer = null;
        renderFiles(_buildTagColorMap());
      }, delay || 50);
    }

    function _insertFileIncremental(file) {
      // Insert into currentFiles maintaining sort order, then re-render
      currentFiles.unshift(file);
      currentFiles.sort(function(a, b) {
        var aVal = a[currentSort] || '';
        var bVal = b[currentSort] || '';
        var order = currentOrder === 'asc' ? 1 : -1;
        if (aVal < bVal) return -1 * order;
        if (aVal > bVal) return 1 * order;
        return 0;
      });
      _scheduleSyncRender(30);
    }

    function _removeFileIncremental(filename) {
      currentFiles = currentFiles.filter(function(f) { return f.name !== filename; });
      _scheduleSyncRender(30);
    }

    function _updateFileIncremental(updatedFile) {
      var idx = currentFiles.findIndex(function(f) { return f.name === updatedFile.name; });
      if (idx !== -1) {
        // Preserve _index so DOM row references stay valid
        updatedFile._index = currentFiles[idx]._index;
        currentFiles[idx] = updatedFile;
        // Re-sort in case size/order changed
        currentFiles.sort(function(a, b) {
          var aVal = a[currentSort] || '';
          var bVal = b[currentSort] || '';
          var order = currentOrder === 'asc' ? 1 : -1;
          if (aVal < bVal) return -1 * order;
          if (aVal > bVal) return 1 * order;
          return 0;
        });
        _scheduleSyncRender(30);
      }
    }

    // Public: update the DOM row for a single file (used by inline rename, tag edit)
    function updateFileRowDOM(filename, updates) {
      var idx = currentFiles.findIndex(function(f) { return f.name === filename; });
      if (idx === -1) return;
      Object.assign(currentFiles[idx], updates);
      if (!_syncRenderTimer) {
        // Only update this row's DOM, don't re-render everything
        var tagColorMap = _buildTagColorMap();
        var listBody = document.getElementById('fileTableBody');
        var gridBody = document.getElementById('fileTableGrid');
        var row;
        if (currentView === 'grid' && gridBody) {
          row = gridBody.querySelector('[data-filename="' + encodeURIComponent(filename) + '"]');
          if (row) row.outerHTML = renderFileItem(currentFiles[idx], tagColorMap, 'grid');
        } else if (listBody) {
          row = listBody.querySelector('[data-filename="' + encodeURIComponent(filename) + '"]');
          if (row) row.outerHTML = renderFileRow(currentFiles[idx], tagColorMap);
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
            var icon = '';
            if (typeof tc === 'object' && tc !== null) {
              icon = tc.icon || '';
              tc = tc.color || '#e0e7ff';
            }
            return '<span class="tag-badge" style="background:' + tc + ';font-size:10px;padding:1px 6px;border-radius:10px;font-weight:500;margin-right:3px;display:inline-block;color:inherit">' + (icon ? escapeHtmlClient(icon) + ' ' : '') + escapeHtmlClient(t.trim()) + '</span>';
          }).join('') + '</div>'
        : '<span class="muted" style="font-size:11px">—</span>';
      return '<tr draggable="true" data-index="' + file._index + '" data-filename="' + encodeURIComponent(file.name) + '" onmousedown="handleItemClick(event, ' + file._index + ')" ondblclick="if(!e.target.closest(\'.inline-rename-btn\') && !e.target.closest(\'.tag-edit-btn\') && !e.target.closest(\'.file-check\') && !e.target.closest(\'button\')) previewFile(' + JSON.stringify(file.name) + ')">' +
        '<td data-label=""><input class="file-check" type="checkbox" value="' + encodeURIComponent(file.name) + '" data-id="' + (file.id || '') + '" onchange="onFileCheckChange()" onclick="lastClickedIndex=' + file._index + '"></td>' +
        '<td data-label="文件" class="filename-cell" data-filename="' + encodeURIComponent(file.name) + '"><span class="filename-text" ondblclick="startInlineRename(' + JSON.stringify(file.name) + ')">' + (file.highlightedName || (currentSearchQuery ? highlightMatch(file.name, currentSearchQuery) : escapeHtmlClient(file.name))) + '</span><button class="inline-rename-btn" onclick="startInlineRename(' + JSON.stringify(file.name) + ')" title="重命名 (Enter保存/Esc取消)">✏️</button><div class="muted">' + formatFileType(file.type) + '</div></td>' +
        '<td data-label="标签">' + tagHtml + '<button class="tag-edit-btn" onclick="editFileTags(' + JSON.stringify(file.name) + ',' + JSON.stringify(tags) + ')">✎</button></td>' +
        '<td data-label="📌" style="color:var(--muted);cursor:default;text-align:center;font-size:16px" title="拖拽移动">⠿</td>' +
        '<td data-label="大小">' + formatBytes(file.size) + '</td>' +
        '<td data-label="更新时间">' + formatTime(file.updatedAt || file.createdAt) + '</td>' +
        '<td data-label="创建时间">' + formatTime(file.createdAt) + '</td>' +
        '<td class="actions-cell" data-label="操作">' +
          '<button onclick=' + "'" + 'previewFile(' + JSON.stringify(file.name) + ')' + "'" + '>查看</button>' +
          '<button class="secondary" onclick=' + "'" + 'downloadFile(' + JSON.stringify(file.name) + ')' + "'" + '>下载</button>' +
          '<button class="secondary" onclick=' + "'" + 'copyShareLink(' + JSON.stringify(file.name) + ')' + "'" + '>复制链接</button>' +
          '<button class="secondary" onclick=' + "'" + 'createShare(' + JSON.stringify(file.name) + ')' + "'" + '>分享</button>' +
          '<button class="secondary" onclick=' + "'" + 'renameFile(' + JSON.stringify(file.name) + ')' + "'" + '>重命名</button>' +
          '<button class="secondary" onclick=' + "'" + 'openFileActivity(' + JSON.stringify(file.name) + ')' + "'" + '>📊</button>' +
          '<button class="danger" onclick=' + "'" + 'deleteFile(' + JSON.stringify(file.name) + ')' + "'" + '>删除</button>' +
        '</td>' +
      '</tr>';
    }

    function renderFileItem(file, tagColorMap, mode) {
      var tags = file.tags || '';
      var tagHtml = tags
        ? '<div class="file-tags">' + tags.split(',').filter(Boolean).map(function(t) {
            var tc = tagColorMap[t.trim()] || '#e0e7ff';
            var icon = '';
            if (typeof tc === 'object' && tc !== null) {
              icon = tc.icon || '';
              tc = tc.color || '#e0e7ff';
            }
            var tagVal = escapeHtmlClient(t.trim());
            return '<span class="tag-badge" style="background:' + tc + ';font-size:10px;padding:1px 6px;border-radius:10px;font-weight:500;margin-right:3px;display:inline-block;color:inherit;cursor:pointer" onclick="filterBySingleTag(\'' + tagVal.replace(/'/g, "\\'") + '\')" title="点击筛选此标签">' + (icon ? escapeHtmlClient(icon) + ' ' : '') + tagVal + '</span>';
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
          // Lazy thumbnail: show placeholder play icon, load frame via /api/thumbnail/ in viewport
          thumbWrapper = '<div class="img-thumb-wrap" style="display:flex;align-items:center;justify-content:center;height:64px;margin-bottom:8px;position:relative" data-filename="' + encodeURIComponent(file.name) + '">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="1.5"><polygon points="23,7 16,12 23,17"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>' +
            '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(139,92,246,0.3);border-radius:4px"><div style="width:28px;height:28px;background:rgba(139,92,246,0.9);border-radius:50%;display:flex;align-items:center;justify-content:center"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="#fff"><polygon points="5,3 19,12 5,21"/></svg></div></div>' +
            '<div class="img-overlay" style="display:none;position:absolute;inset:0;background:rgba(0,0,0,0.3);border-radius:4px;align-items:center;justify-content:center">' +
            '<div style="width:28px;height:28px;border:3px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite"></div></div></div>';
          iconSvg = thumbWrapper;
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
        '<input class="file-check file-check-row" type="checkbox" value="' + encodeURIComponent(file.name) + '" data-id="' + (file.id || '') + '" onchange="onFileCheckChange()" onclick="lastClickedIndex=' + file._index + '">' +
        '<div class="file-content">' +
          gridIcon +
          '<div class="file-name"><span ondblclick="startInlineRename(' + JSON.stringify(file.name) + ')">' + (file.highlightedName || (currentSearchQuery ? highlightMatch(file.name, currentSearchQuery) : escapeHtmlClient(file.name))) + '</span><button class="inline-rename-btn" onclick="startInlineRename(' + JSON.stringify(file.name) + ')" title="重命名 (Enter保存/Esc取消)">✏️</button></div>' +
          '<div class="file-meta">' + formatBytes(file.size) + ' · ' + formatTime(file.updatedAt || file.createdAt) + '</div>' +
          tagHtml +
        '</div>' +
        '<div class="file-actions">' +
          // Mobile: compact ⋮ menu (shown in grid mode on mobile via CSS)
          '<button class="mobile-more-btn" onclick=' + "'" + 'showMobileMenu(' + JSON.stringify(file.name) + ', event)' + "'" + ' title="更多操作" style="display:none">⋮</button>' +
          '<button class="btn secondary" onclick=' + "'" + 'previewFile(' + JSON.stringify(file.name) + ')' + "'" + '>查看</button>' +
          '<button class="btn secondary" onclick=' + "'" + 'downloadFile(' + JSON.stringify(file.name) + ')' + "'" + '>下载</button>' +
          '<button class="btn secondary" onclick=' + "'" + 'copyShareLink(' + JSON.stringify(file.name) + ')' + "'" + '>复制链接</button>' +
          '<button class="btn secondary" onclick=' + "'" + 'createShare(' + JSON.stringify(file.name) + ')' + "'" + '>分享</button>' +
          '<button class="btn secondary" onclick=' + "'" + 'openFileActivity(' + JSON.stringify(file.name) + ')' + "'" + '>📊</button>' +
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

    // ── Search Mode (normal / glob / regex) ────────────────────────────────
    var _searchMode = localStorage.getItem('searchMode') || 'normal'; // 'normal' | 'glob' | 'regex'
    function getSearchMode() { return _searchMode; }
    function cycleSearchMode() {
      var modes = ['normal', 'glob', 'regex'];
      var idx = modes.indexOf(_searchMode);
      _searchMode = modes[(idx + 1) % modes.length];
      localStorage.setItem('searchMode', _searchMode);
      updateSearchModeBadge();
    }
    function setSearchMode(mode) {
      if (['normal','glob','regex'].indexOf(mode) === -1) return;
      _searchMode = mode;
      localStorage.setItem('searchMode', _searchMode);
      updateSearchModeBadge();
    }
    function updateSearchModeBadge() {
      var badge = document.getElementById('searchModeBadge');
      var input = document.getElementById('searchInput');
      if (!badge) return;
      if (_searchMode === 'normal') {
        badge.textContent = 'Aa';
        badge.style.display = 'none';
        input.style.paddingRight = '56px';
      } else if (_searchMode === 'glob') {
        badge.textContent = 'glob';
        badge.style.display = 'block';
        badge.style.color = '#f59e0b';
        badge.style.borderColor = '#f59e0b';
        input.style.paddingRight = '76px';
      } else if (_searchMode === 'regex') {
        badge.textContent = '.*';
        badge.style.display = 'block';
        badge.style.color = '#10b981';
        badge.style.borderColor = '#10b981';
        input.style.paddingRight = '76px';
      }
    }
    // Restore search state from localStorage on load
    function restoreSearchState() {
      var savedQ = localStorage.getItem('lastSearchQuery') || '';
      var savedMode = localStorage.getItem('searchMode') || 'normal';
      if (savedQ) {
        document.getElementById('searchInput').value = savedQ;
        document.getElementById('searchClear').style.display = 'block';
        currentSearchQuery = savedQ;
      }
      setSearchMode(savedMode);
    }

    // ── Saved Searches (localStorage) ──────────────────────────────────────
    var LS_SAVED_SEARCHES = 'savedSearches';
    var MAX_SAVED_SEARCHES = 20;
    function getSavedSearches() {
      try { return JSON.parse(localStorage.getItem(LS_SAVED_SEARCHES) || '[]'); }
      catch (e) { return []; }
    }
    function saveCurrentSearch() {
      var q = document.getElementById('searchInput').value.trim();
      if (!q) return;
      var mode = getSearchMode();
      var label = q.length > 30 ? q.substring(0, 30) + '…' : q;
      var entry = { q: q, mode: mode, label: label, ts: Date.now() };
      var list = getSavedSearches().filter(function(s) { return s.q !== q; });
      list.unshift(entry);
      if (list.length > MAX_SAVED_SEARCHES) list = list.slice(0, MAX_SAVED_SEARCHES);
      localStorage.setItem(LS_SAVED_SEARCHES, JSON.stringify(list));
      showToast('\u2705 \u5DF2\u4FDD\u5B58\u5F53\u524D\u641C\u7D22', 'success');
    }
    function applySavedSearch(entry) {
      document.getElementById('searchInput').value = entry.q;
      document.getElementById('searchClear').style.display = 'block';
      setSearchMode(entry.mode || 'normal');
      currentSearchQuery = entry.q;
      loadFiles();
    }
    function deleteSavedSearch(idx) {
      var list = getSavedSearches();
      list.splice(idx, 1);
      localStorage.setItem(LS_SAVED_SEARCHES, JSON.stringify(list));
      renderSavedSearches();
    }
    function renderSavedSearches() {
      var container = document.getElementById('savedSearchesList') || null;
      if (!container) return;
      var list = getSavedSearches();
      if (!list.length) { container.innerHTML = '<div style="padding:8px 12px;color:var(--muted);font-size:12px">暂无已保存的搜索</div>'; return; }
      var html = '';
      list.forEach(function(s, i) {
        var modeTag = s.mode === 'glob' ? '<span style="color:#f59e0b;font-size:10px">glob</span>' : (s.mode === 'regex' ? '<span style="color:#10b981;font-size:10px">regex</span>' : '');
        html += '<div class="suggestion-item" style="display:flex;align-items:center;padding:8px 12px;cursor:pointer" onmouseenter="this.style.background=\'var(--bg-secondary)\'" onmouseleave="this.style.background=\'\'" onclick="applySavedSearch(' + JSON.stringify(s) + ')">';
        html += '<span style="flex:1;font-size:13px;color:var(--text)">' + escapeHtmlClient(s.q) + '</span>';
        html += modeTag ? '<span style="margin:0 6px">' + modeTag + '</span>' : '';
        html += '<span style="color:var(--muted);font-size:11px;margin-right:8px">' + new Date(s.ts).toLocaleDateString('zh') + '</span>';
        html += '<span onclick="event.stopPropagation();deleteSavedSearch(' + i + ')" style="cursor:pointer;color:var(--muted);font-size:14px;padding:2px 4px" title="删除">✕</span>';
        html += '</div>';
      });
      container.innerHTML = html;
    }

    // Result count chip — shown after search completes
    function showSearchResultChip(total, q) {
      var chip = document.getElementById('searchResultChip');
      if (!chip) return;
      if (!q && !currentTypeFilters.length && !allTagFilters.length) {
        chip.style.display = 'none';
        return;
      }
      var qLabel = q ? '\u201C' + escapeHtmlClient(q) + '\u201D' : '';
      var modeLabel = getSearchMode() === 'normal' ? '' : (' [' + getSearchMode() + ']');
      chip.innerHTML = '<span style="font-size:12px">找到 <strong>' + total + '</strong> 个结果' + (qLabel ? ' \u7528\u4E8E ' + qLabel : '') + modeLabel + '</span><span onclick="clearSearchInput();clearAdvancedSearch()" style="cursor:pointer;margin-left:10px;color:var(--muted);font-size:13px">✕</span>';
      chip.style.display = 'flex';
    }
    function hideSearchResultChip() {
      var chip = document.getElementById('searchResultChip');
      if (chip) chip.style.display = 'none';
    }

    // Override loadFilesFromUrl to inject search mode + save/restore state
    var _origLoadFilesFromUrl = window.loadFilesFromUrl || loadFilesFromUrl;
    async function loadFilesFromUrl(url, append) {
      // Inject mode param
      var mode = getSearchMode();
      if (mode !== 'normal') {
        url += (url.indexOf('?') === -1 ? '?' : '&') + 'mode=' + encodeURIComponent(mode);
      }
      // Save state
      var q = document.getElementById('searchInput') && document.getElementById('searchInput').value || '';
      if (q) localStorage.setItem('lastSearchQuery', q);
      else localStorage.removeItem('lastSearchQuery');
      // Call original
      var result = await _origLoadFilesFromUrl(url, append);
      // After load, update result chip if not appending
      if (!append) {
        var totalEl = document.getElementById('fileCountDisplay');
        if (totalEl) {
          var text = totalEl.textContent || '';
          var match = text.match(/\u5171(\d+)/);
          if (match) showSearchResultChip(match[1], q);
          else hideSearchResultChip();
        }
      }
      return result;
    }
    window.loadFilesFromUrl = loadFilesFromUrl;

    // Also intercept searchFiles to save last query
    var _origSearchFiles = searchFiles;
    window.searchFiles = async function() {
      var q = document.getElementById('searchInput').value.trim();
      if (q) localStorage.setItem('lastSearchQuery', q);
      else localStorage.removeItem('lastSearchQuery');
      return _origSearchFiles.call(this);
    };


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
      // Show/hide star item based on file's current starred state
      var file = currentFiles.find(function(f) { return (f.name || f.filename) === decodeURIComponent(ctxTarget); });
      var isStarred = file && file.starred;
      var starItems = menu.querySelectorAll('.ctx-star');
      starItems.forEach(function(item) {
        var showStarred = item.dataset.starred === '1';
        item.style.display = showStarred === isStarred ? '' : 'none';
      });
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
      // Show/hide star item based on file's current starred state
      var file = currentFiles.find(function(f) { return (f.name || f.filename) === decodeURIComponent(ctxTarget); });
      var isStarred = file && file.starred;
      var starItems = menu.querySelectorAll('.ctx-star');
      starItems.forEach(function(item) {
        var showStarred = item.dataset.starred === '1';
        item.style.display = showStarred === isStarred ? '' : 'none';
      });
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
      // Store in window._droppedFiles (same pattern as drag-and-drop, FileList is readonly)
      window._droppedFiles = { files: files, count: files.length };
      handleFileSelect(files);
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

      // Ctrl/Cmd+A → select all files
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        toggleAll(true);
        return;
      }

      // "/" focuses the search box
      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('searchInput').focus();
        return;
      }

      // Escape closes modal
      if (e.key === 'Escape') {
        var modal = document.getElementById('modal');
        if (modal && modal.classList.contains('open')) {
          modal.classList.remove('open');
          return;
        }
        var ctx = document.getElementById('ctxMenu');
        if (ctx) ctx.style.display = 'none';
        // Escape clears search if active
        if (currentSearchQuery) {
          clearSearchInput();
          return;
        }
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
          if (e.ctrlKey || e.metaKey) return; // handled above
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
          // Delete: delete selected files — use modal instead of confirm()
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          var selected = getSelectedFiles();
          if (!selected.length) return;
          e.preventDefault();
          openDeleteConfirmModal(selected);
          break;
        }
        case 'z':
        case 'Z': {
          // z: open sync dashboard
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          openSyncDashboard();
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
          openNewFolderModal();
          break;
        }
        case 'n': {
          // n: create new text file
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          openNewTextFileModal();
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
        case 'c':
        case 'C':
        case 'l': {
          // c or l: copy share link of selected file
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          var selected = getSelectedFiles();
          if (selected.length === 1) {
            e.preventDefault();
            copyShareLink(selected[0]);
          }
          break;
        }
        case 'p': {
          // p: preview selected file
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          var names = getSelectedFiles();
          if (!names.length && keyboardNavIndex >= 0) {
            var item = getFileAtIndex(keyboardNavIndex);
            if (item) names = [item.getAttribute('data-name')];
          }
          if (names.length === 1) {
            e.preventDefault();
            previewFile(names[0]);
          }
          break;
        }
        case 'i': {
          // i: show file info panel for selected file
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          var names = getSelectedFiles();
          if (!names.length && keyboardNavIndex >= 0) {
            var item = getFileAtIndex(keyboardNavIndex);
            if (item) names = [item.getAttribute('data-name')];
          }
          if (names.length === 1) {
            e.preventDefault();
            showFileInfo(names[0]);
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
        case 'e':
        case 'E': {
          // e: rename selected file
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          var names = getSelectedFiles();
          if (!names.length && keyboardNavIndex >= 0) {
            var item = getFileAtIndex(keyboardNavIndex);
            if (item) names = [item.getAttribute('data-name')];
          }
          if (names.length === 1) {
            e.preventDefault();
            startInlineRename(names[0]);
          }
          break;
        }
        case 'Y': {
          // Shift+Y: copy full file path
          if (!e.shiftKey) break;
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          var names = getSelectedFiles();
          if (names.length === 1) {
            e.preventDefault();
            navigator.clipboard.writeText('/' + names[0]).then(function() {
              showToast('已复制文件路径: /' + names[0], 'success');
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
        case 'j': {
          // j: move keyboard nav down
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          updateGridColumns();
          applyNavHighlight(keyboardNavIndex + 1);
          break;
        }
        case 'k': {
          // k: move keyboard nav up
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          updateGridColumns();
          applyNavHighlight(keyboardNavIndex - 1);
          break;
        }
        case 'Home': {
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          var firstItems = getAllFileItems();
          if (firstItems.length) {
            applyNavHighlight(0);
            firstItems[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
          break;
        }
        case 'End': {
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          var lastItems = getAllFileItems();
          if (lastItems.length) {
            applyNavHighlight(lastItems.length - 1);
            lastItems[lastItems.length - 1].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
          break;
        }
        case 'r': {
          // r: refresh file list
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          loadFiles();
          break;
        }
        case 'n': {
          // n: new text file
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          openNewFileDialog();
          break;
        }
        case 'Space': {
          // Space: toggle checkbox on keyboard-navigated file
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          if (keyboardNavIndex < 0) return;
          var spaceItem = getFileAtIndex(keyboardNavIndex);
          if (!spaceItem) return;
          var cb = spaceItem.querySelector('.file-check');
          if (cb) {
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change'));
            updateBatchBar();
          }
          break;
        }
        case 's': {
          // s: toggle star on keyboard-navigated file
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          if (keyboardNavIndex < 0) return;
          var sItem = getFileAtIndex(keyboardNavIndex);
          if (!sItem) return;
          var sFilename = decodeURIComponent(sItem.getAttribute('data-filename') || '');
          if (sFilename) toggleStar(sFilename);
          break;
        }
        case 'y': {
          // y: copy filename to clipboard
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          if (keyboardNavIndex < 0) return;
          var yItem = getFileAtIndex(keyboardNavIndex);
          if (!yItem) return;
          var yFilename = decodeURIComponent(yItem.getAttribute('data-filename') || '');
          if (yFilename) { copyToClipboard(yFilename); showToast('已复制: ' + yFilename, 'success'); }
          break;
        }
        case 'c': {
          // c: copy share link for keyboard-navigated file
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          if (keyboardNavIndex < 0) return;
          var cItem = getFileAtIndex(keyboardNavIndex);
          if (!cItem) return;
          var cFilename = decodeURIComponent(cItem.getAttribute('data-filename') || '');
          if (cFilename) copyShareLink(cFilename);
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
        case 'o':
        case 'O': {
          // o: open saved searches panel
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
          openSavedSearchesPanel();
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
          // ?: show keyboard shortcuts help
          if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
          e.preventDefault();
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
        case 'openInFinder': {
          var enc = encodeURIComponent(filename);
          var res2 = await fetch('/api/file-path/' + enc, { headers: headers() });
          var data2 = await res2.json();
          if (data2.success) showToast('已在 Finder 中定位', 'success');
          else showToast('打开失败: ' + (data2.error || '未知错误'), 'error');
          break;
        }
        case 'rename': startInlineRename(filename); break;
        case 'delete': openDeleteConfirmModal([filename]); break;
        case 'history': openVersionHistory(filename); break;
        case 'stats': openFileAccessStats(filename); break;
        case 'info': showFileInfo(filename); break;
        case 'addToVF': openAddToVirtualFolder(filename); break;
        case 'removeFromVF': toggleFileStarred(filename, false); break;
        case 'addTags':
          openTagInputModalForFiles('add', [filename]);
          break;
        case 'removeTags':
          openTagInputModalForFiles('remove', [filename]);
          break;
        case 'move':
          // Select just this file and open the batch move modal
          toggleFileSelect(filename, true);
          openBatchMoveModal();
          break;
      }
    }

    function openTagInputModalForFiles(action, files) {
      var modal = document.getElementById('tagInputModal');
      if (modal) modal.remove();
      modal = document.createElement('div');
      modal.id = 'tagInputModal';
      modal.className = 'modal';
      var count = files.length;
      var nameStr = count === 1 ? escapeHtmlClient(files[0]) : count + ' 个文件';
      modal.innerHTML = '\
        <div class="modal-content" style="max-width:400px">\
          <h3 id="tagInputTitle">' + (action === 'add' ? '添加标签' : '移除标签') + '</h3>\
          <p style="color:var(--muted);font-size:13px;margin-bottom:12px;word-break:break-all">为 <strong>' + nameStr + '</strong>' + (action === 'add' ? '添加' : '移除') + '标签</p>\
          <div id="tagChipInput" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;padding:8px;border:1px solid var(--line);border-radius:8px;min-height:44px;cursor:text" onclick="document.getElementById(\'tagInputField\').focus()"></div>\
          <input id="tagInputField" type="text" placeholder="输入标签后按 Enter 添加" \
            style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;margin-bottom:14px;font-size:14px" \
            onkeydown="handleTagInputKeydown(event, \'' + action + '\')">\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'tagInputModal\').remove()">取消</button>\
            <button onclick="confirmTagInputForFiles(\'' + action + '\', \'' + files.map(encodeURIComponent).join(',') + '\')">确定</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      document.getElementById('tagInputField').focus();
    }

    function confirmTagInputForFiles(action, filesEncoded) {
      var files = filesEncoded.split(',').map(decodeURIComponent);
      if (!files.length) { showToast('文件信息无效', 'error'); return; }
      if (!_batchTagChips.length) { showToast('请至少输入一个标签', 'error'); return; }
      var tagStr = _batchTagChips.join(',');
      fetch('/api/file-tags/batch', {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ files: files, action: action, tags: tagStr })
      }).then(function (r) { return r.json(); }).then(function () {
        document.getElementById('tagInputModal').remove();
        _batchTagChips = [];
        showToast(action === 'add' ? '已添加标签' : '已移除标签', 'success');
        loadFiles();
      }).catch(function () { showToast('操作失败', 'error'); });
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
        const html = '<div id="versionList" style="max-height:50vh;overflow:auto">' +
          data.versions.map(v => {
            const date = new Date(v.created_at * 1000).toLocaleString('zh-CN');
            const size = formatSize ? formatSize(v.size) : v.size + ' B';
            const isCurrent = v.hash === data.currentHash;
            return '<div class="version-item" data-id="' + v.id + '" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px">' +
              '<div style="display:flex;align-items:center;gap:8px">' +
                '<input type="checkbox" class="version-check" value="' + v.id + '" style="width:16px;height:16px;cursor:pointer" ' + (isCurrent ? 'disabled' : '') + '>' +
                '<div style="flex:1">' +
                  '<div style="color:var(--text)">' + date + (isCurrent ? ' <span style="background:var(--accent);color:#fff;font-size:10px;padding:1px 5px;border-radius:3px">当前</span>' : '') + '</div>' +
                  '<div style="color:var(--text-muted);font-size:11px;margin-top:2px">' + size + ' · ' + escapeHtmlClient(v.hash ? v.hash.slice(0, 8) : '') + '</div>' +
                '</div>' +
              '</div>' +
              '<div style="display:flex;gap:6px">' +
                '<button class="btn-sm secondary" onclick="viewVersion(' + v.id + ')" style="padding:5px 12px;font-size:12px">预览</button>' +
                (!isCurrent ? '<button class="btn-sm primary" onclick="restoreVersion(' + v.id + ')" style="padding:5px 12px;font-size:12px">恢复</button>' : '') +
              '</div>' +
            '</div>';
          }).join('') + '</div>' +
          '<div id="compareBar" style="display:none;padding:12px 0;border-top:2px solid var(--accent);margin-top:8px;text-align:center">' +
            '<span id="compareText" style="color:var(--text-muted);font-size:13px"></span> ' +
            '<button class="btn primary" id="compareBtn" onclick="compareSelectedVersions()" style="padding:8px 20px;font-size:13px;margin-left:8px">版本对比</button>' +
          '</div>';
        modalBody.innerHTML = html;
        window._versionHistoryFilename = filename;
        window._versionData = data;
        // Checkbox handlers
        document.querySelectorAll('.version-check').forEach(cb => {
          cb.addEventListener('change', updateCompareBar);
        });
      } catch (e) {
        modalBody.innerHTML = '<p style="color:var(--danger);padding:20px;text-align:center">加载失败: ' + escapeHtmlClient(e.message) + '</p>';
      }
    }

    function updateCompareBar() {
      const checked = [...document.querySelectorAll('.version-check:checked')];
      const bar = document.getElementById('compareBar');
      const text = document.getElementById('compareText');
      if (checked.length === 2) {
        bar.style.display = 'block';
        const ids = checked.map(cb => cb.value);
        const v1 = window._versionData.versions.find(v => v.id == ids[0]);
        const v2 = window._versionData.versions.find(v => v.id == ids[1]);
        text.textContent = '已选择 2 个版本';
      } else if (checked.length === 1) {
        bar.style.display = 'block';
        text.textContent = '已选择 1 个版本，还需再选 1 个';
      } else {
        bar.style.display = 'none';
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
          modalBody.innerHTML = '<div style="margin-bottom:10px"><button class="btn secondary" onclick="openVersionHistory(window._versionHistoryFilename)" style="font-size:12px;padding:5px 12px">← 返回版本列表</button></div>' +
            '<div style="max-height:65vh;overflow:auto;background:var(--bg-secondary);border-radius:8px;padding:16px;font-family:monospace;font-size:13px;white-space:pre-wrap;word-break:break-all">' + escapeHtmlClient(display) + '</div>' +
            (truncated ? '<p style="color:var(--text-muted);font-size:12px;margin-top:8px;text-align:center">内容过长，已截断</p>' : '');
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
      showConfirm('确认恢复此版本？<br><span style="color:var(--text-muted);font-size:12px">当前文件内容将保存为新版本。</span>', async function() {
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
      });
    }

    async function compareSelectedVersions() {
      const checked = [...document.querySelectorAll('.version-check:checked')];
      if (checked.length !== 2) return;
      const ids = checked.map(cb => parseInt(cb.value, 10));
      const modalBody = document.getElementById('modalBody');
      modalBody.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">加载中...</div>';
      try {
        const [res1, res2] = await Promise.all([
          fetch('/api/versions/' + ids[0], { headers: headers() }),
          fetch('/api/versions/' + ids[1], { headers: headers() })
        ]);
        const [data1, data2] = await Promise.all([res1.json(), res2.json()]);
        if (!data1.success || !data2.success) {
          modalBody.innerHTML = '<p class="muted">版本加载失败</p>';
          return;
        }
        const v1 = data1.version;
        const v2 = data2.version;
        const ext = (v1.filename || '').split('.').pop().toLowerCase();
        const isText = ['js','ts','py','rb','go','rs','java','md','json','css','html','htm','sh','yaml','yml','xml','sql'].includes(ext);
        if (!isText || !v1.content || !v2.content) {
          modalBody.innerHTML = '<p class="muted">版本对比仅支持文本文件。</p><button class="btn secondary" onclick="openVersionHistory(window._versionHistoryFilename)" style="margin-top:12px">返回版本列表</button>';
          return;
        }
        const date1 = new Date(v1.created_at * 1000).toLocaleString('zh-CN');
        const date2 = new Date(v2.created_at * 1000).toLocaleString('zh-CN');
        const lines1 = v1.content.split('\n');
        const lines2 = v2.content.split('\n');
        const diff = computeLineDiff(lines1, lines2);
        modalBody.innerHTML =
          '<div style="margin-bottom:12px"><button class="btn secondary" onclick="openVersionHistory(window._versionHistoryFilename)" style="font-size:12px;padding:5px 12px">← 返回版本列表</button></div>' +
          '<div style="display:flex;gap:8px;margin-bottom:8px;font-size:12px">' +
            '<span style="color:var(--text-muted)">旧版: ' + date1 + '</span>' +
            '<span style="color:var(--text-muted)">|</span>' +
            '<span style="color:var(--text-muted)">新版: ' + date2 + '</span>' +
          '</div>' +
          '<div style="display:flex;gap:4px;margin-bottom:8px">' +
            '<span style="background:#dc2626;color:#fff;font-size:11px;padding:2px 6px;border-radius:3px">- 删除</span>' +
            '<span style="background:#16a34a;color:#fff;font-size:11px;padding:2px 6px;border-radius:3px">+ 新增</span>' +
          '</div>' +
          '<div style="display:flex;max-height:60vh;border:1px solid var(--border);border-radius:8px;overflow:hidden">' +
            '<div id="diffLeft" style="flex:1;overflow:auto;background:var(--bg);font-family:monospace;font-size:13px;line-height:1.5;padding:8px;border-right:1px solid var(--border)"></div>' +
            '<div id="diffRight" style="flex:1;overflow:auto;background:var(--bg);font-family:monospace;font-size:13px;line-height:1.5;padding:8px"></div>' +
          '</div>';
        renderDiffLines('diffLeft', diff.left, diff.right);
        renderDiffLines('diffRight', diff.right, diff.left);
      } catch (e) {
        modalBody.innerHTML = '<p class="muted">加载失败: ' + escapeHtmlClient(e.message) + '</p>';
      }
    }

    function computeLineDiff(linesA, linesB) {
      // Simple LCS-based line diff
      const m = linesA.length, n = linesB.length;
      const dp = Array.from({length: m+1}, () => new Array(n+1).fill(0));
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          if (linesA[i-1] === linesB[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
          else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
        }
      }
      const result = { left: [], right: [] };
      let i = m, j = n;
      const tempA = [], tempB = [];
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && linesA[i-1] === linesB[j-1]) {
          tempA.unshift({ text: linesA[i-1], type: 'same' });
          tempB.unshift({ text: linesB[j-1], type: 'same' });
          i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
          tempA.unshift({ text: '', type: 'empty' });
          tempB.unshift({ text: linesB[j-1], type: 'add' });
          j--;
        } else {
          tempA.unshift({ text: linesA[i-1], type: 'del' });
          tempB.unshift({ text: '', type: 'empty' });
          i--;
        }
      }
      result.left = tempA;
      result.right = tempB;
      return result;
    }

    function renderDiffLines(containerId, lines, otherLines) {
      const container = document.getElementById(containerId);
      let html = '';
      lines.forEach((line, idx) => {
        const lineNum = idx + 1;
        let bg = 'transparent';
        let content = escapeHtmlClient(line.text || '');
        if (line.type === 'del') bg = 'rgba(220,38,38,0.15)';
        else if (line.type === 'add') bg = 'rgba(22,163,74,0.15)';
        else if (line.type === 'empty') bg = 'rgba(245,158,11,0.08)';
        const lineContent = line.type === 'empty' ? '&nbsp;' : content;
        html += '<div style="display:flex;background:' + bg + ';min-height:22px;padding:0 4px">' +
          '<span style="color:var(--text-muted);width:40px;text-align:right;margin-right:8px;user-select:none;flex-shrink:0">' + (line.type === 'empty' ? '' : lineNum) + '</span>' +
          '<span style="color:' + (line.type === 'del' ? '#dc2626' : line.type === 'add' ? '#16a34a' : 'inherit') + ';white-space:pre-wrap;word-break:break-all">' + lineContent + '</span>' +
          '</div>';
      });
      container.innerHTML = html;
    }

    async function downloadVersion(versionId) {
      try {
        const res = await fetch('/api/versions/' + versionId, { headers: headers() });
        const data = await res.json();
        if (!data.success || !data.version) { showToast('下载失败', 'error'); return; }
        const v = data.version;
        const blob = new Blob([v.content || ''], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = v.filename || 'version_' + versionId;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        showToast('下载失败: ' + e.message, 'error');
      }
    }

    window.startInfoRename = function() {
      var disp = document.getElementById('infoFilenameDisplay');
      var edit = document.getElementById('infoFilenameEdit');
      if (!disp || !edit) return;
      disp.style.display = 'none';
      edit.style.display = 'block';
      var inp = document.getElementById('infoFilenameInput');
      if (inp) { inp.focus(); inp.select(); }
    };

    window.saveInfoRename = async function() {
      var inp = document.getElementById('infoFilenameInput');
      if (!inp) return;
      var newName = inp.value.trim();
      if (!newName || newName === window._infoOriginalFilename) {
        cancelInfoRename();
        return;
      }
      var btn = document.getElementById('infoRenameBtn');
      if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }
      try {
        var res = await fetch('/api/file-rename/' + encodeURIComponent(window._infoOriginalFilename), {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ newFilename: newName })
        });
        var data = await res.json();
        if (data.success) {
          showToast('已重命名为: ' + newName, 'success');
          closeModal();
          loadFiles();
        } else {
          showToast(data.error || '重命名失败', 'error');
          if (btn) { btn.disabled = false; btn.textContent = '保存'; }
        }
      } catch (e) {
        showToast('重命名失败: ' + e.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = '保存'; }
      }
    };

    window.cancelInfoRename = function() {
      var disp = document.getElementById('infoFilenameDisplay');
      var edit = document.getElementById('infoFilenameEdit');
      if (disp) disp.style.display = 'flex';
      if (edit) edit.style.display = 'none';
    };

    async function showFileInfo(filename) {
      const modalBody = document.getElementById('modalBody');
      document.getElementById('modalTitle').textContent = '文件属性: ' + escapeHtmlClient(filename);
      modalBody.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">加载中...</div>';
      document.getElementById('modal').classList.add('open');
      window._infoOriginalFilename = filename;

      // Ensure tag definitions are loaded for colored chip display
      if (!window._folderTagDefinitions) {
        try {
          const ftRes = await fetch('/api/folder-tags', { headers: headers() });
          const ftData = await ftRes.json();
          if (ftData.tags) window._folderTagDefinitions = ftData.tags;
        } catch (_) {}
      }

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

        // Load notes separately
        var fileNotes = '';
        try {
          const notesRes = await fetch('/api/file-notes/' + encoded, { headers: headers() });
          const notesData = await notesRes.json();
          if (notesData && notesData.success) fileNotes = notesData.notes || '';
        } catch (_) {}
        const fmtSize = formatSize ? formatSize(f.size) : (f.size || 0) + ' B';
        const fmtDate = ts => ts ? new Date(ts).toLocaleString('zh-CN') : '--';
        const fmtTs = ts => ts ? new Date(ts).toLocaleString('zh-CN') : '--';

        // Build colored tag chips from tag definitions
        var tagDefs = window._folderTagDefinitions || [];
        var tagColorMap = {};
        tagDefs.forEach(function(td) { tagColorMap[td.name] = td; });
        var tagsHtml = f.tags
          ? f.tags.split(',').filter(Boolean).map(function(t) {
              var et = escapeHtmlClient(t.trim());
              var def = tagColorMap[t.trim()] || {};
              var color = def.color || '#e0e7ff';
              var icon = def.icon || '';
              var chipStyle = 'background:' + color + ';padding:2px 8px;border-radius:6px;font-size:11px;margin:2px;display:inline-block;cursor:pointer;color:inherit;font-weight:500';
              return '<span onclick="filterBySingleTag(\'' + et.replace(/'/g, "\\'") + '\')" style="' + chipStyle + '" title="点击筛选: ' + et + '">' + (icon ? escapeHtmlClient(icon) + ' ' : '') + et + '</span>';
            }).join('')
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
                '<div style="color:var(--text-muted)">文件名</div>' +
                '<div id="infoFilenameDisplay" style="word-break:break-all;font-weight:500;display:flex;align-items:center;gap:6px">' +
                  '<span id="infoFilenameText">' + escapeHtmlClient(f.name) + '</span>' +
                  '<button onclick="startInfoRename()" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--muted);padding:0" title="重命名">✏️</button>' +
                '</div>' +
                '<div id="infoFilenameEdit" style="word-break:break-all;font-weight:500;display:none;grid-column:2">' +
                  '<input id="infoFilenameInput" value="' + escapeHtmlClient(f.name) + '" ' +
                    'style="width:100%;padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box" ' +
                    'onkeydown="if(event.key===\'Enter\')saveInfoRename();if(event.key===\'Escape\')cancelInfoRename()">' +
                '</div>' +
                '<div style="color:var(--text-muted)">类型</div><div>' + escapeHtmlClient(f.type || 'file') + '</div>' +
                '<div style="color:var(--text-muted)">大小</div><div>' + fmtSize + '</div>' +
                '<div style="color:var(--text-muted)">MIME</div><div style="font-family:monospace;font-size:12px;word-break:break-all">' + escapeHtmlClient(f.contentType || '--') + '</div>' +
                '<div style="color:var(--text-muted)">MD5</div><div style="font-family:monospace;font-size:12px;word-break:break-all;color:var(--text-muted)">' + escapeHtmlClient(f.hash || '--') + '</div>' +
                '<div style="color:var(--text-muted)">加密</div><div>' + (f.encrypted ? '🔒 是' : '否') + '</div>' +
                '<div style="color:var(--text-muted)">收藏</div><div><button id="infoStarBtn" onclick="toggleFileStarred(\'' + escapeHtmlClient(f.name).replace(/'/g, "\\'") + '\', ' + !f.starred + ')" style="background:' + (f.starred ? 'var(--accent)' : 'var(--bg-tertiary)') + ';border:none;border-radius:6px;padding:2px 10px;font-size:12px;cursor:pointer;color:' + (f.starred ? '#fff' : 'var(--text)') + '">' + (f.starred ? '⭐ 已收藏' : '☆ 收藏') + '</button></div>' +
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
            // 标签（可编辑）
            '<div style="background:var(--bg-secondary);border-radius:12px;padding:16px">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
                '<div style="font-size:12px;color:var(--text-muted)">标签</div>' +
                '<button onclick="editInfoPanelTags()" style="background:var(--accent);border:none;border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer;color:#fff">✏️ 编辑</button>' +
              '</div>' +
              '<div id="infoTagsDisplay">' + tagsHtml + '</div>' +
              '<div id="infoTagsEdit" style="display:none">' +
                '<input id="infoTagsInput" type="text" value="' + escapeHtmlClient(f.tags || '') + '" ' +
                  'placeholder="输入标签，用逗号分隔" ' +
                  'style="width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;margin-bottom:6px"> ' +
                '<div style="display:flex;gap:6px">' +
                  '<button onclick="saveInfoPanelTags(\'' + escapeHtmlClient(f.name).replace(/'/g, "\\'") + '\')" ' +
                    'style="background:var(--accent);border:none;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;color:#fff">保存</button>' +
                  '<button onclick="cancelInfoPanelTags()" ' +
                    'style="background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer">取消</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
            // 备注
            '<div style="background:var(--bg-secondary);border-radius:12px;padding:16px">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
                '<div style="font-size:12px;color:var(--text-muted)">备注</div>' +
                '<div id="infoNotesSaveStatus" style="font-size:11px;color:var(--muted)"></div>' +
              '</div>' +
              '<div id="infoNotesDisplay" style="font-size:13px;min-height:40px;padding:8px;background:var(--bg);border-radius:8px;border:1px solid var(--line);cursor:pointer;white-space:pre-wrap;word-break:break-word" onclick="startInfoNotesEdit()">' +
                (fileNotes
                  ? '<span id="infoNotesText">' + escapeHtmlClient(fileNotes) + '</span>'
                  : '<span id="infoNotesText" style="color:var(--text-muted);font-style:italic">点击添加备注...</span>') +
              '</div>' +
              '<div id="infoNotesEdit" style="display:none">' +
                '<textarea id="infoNotesInput" rows="3" ' +
                  'placeholder="输入备注内容..." ' +
                  'style="width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;resize:vertical;font-family:inherit;margin-bottom:6px"></textarea> ' +
                '<div style="display:flex;gap:6px">' +
                  '<button onclick="saveInfoNotes()" ' +
                    'style="background:var(--accent);border:none;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;color:#fff">保存</button>' +
                  '<button onclick="cancelInfoNotesEdit()" ' +
                    'style="background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer">取消</button>' +
                '</div>' +
              '</div>' +
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

    function editInfoPanelTags() {
      document.getElementById('infoTagsDisplay').style.display = 'none';
      document.getElementById('infoTagsEdit').style.display = 'block';
      const input = document.getElementById('infoTagsInput');
      input.focus();
      input.select();
    }

    async function saveInfoPanelTags(filename) {
      const newTags = document.getElementById('infoTagsInput').value.trim();
      try {
        const res = await fetch('/api/files/' + encodeURIComponent(filename), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...headers() },
          body: JSON.stringify({ tags: newTags })
        });
        const data = await res.json();
        if (data.success) {
          showToast('标签已保存', 'success');
          // Refresh the panel
          showFileInfo(filename);
          if (typeof refreshTags === 'function') refreshTags();
        } else {
          showToast('保存失败: ' + (data.error || ''), 'error');
        }
      } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
      }
    }

    function cancelInfoPanelTags() {
      document.getElementById('infoTagsDisplay').style.display = 'block';
      document.getElementById('infoTagsEdit').style.display = 'none';
    }

    function startInfoNotesEdit() {
      var notesText = document.getElementById('infoNotesText');
      var currentNotes = (notesText && notesText.style.fontStyle !== 'italic') ? notesText.textContent : '';
      document.getElementById('infoNotesDisplay').style.display = 'none';
      var editDiv = document.getElementById('infoNotesEdit');
      editDiv.style.display = 'block';
      var textarea = document.getElementById('infoNotesInput');
      textarea.value = currentNotes;
      textarea.focus();
    }

    function cancelInfoNotesEdit() {
      document.getElementById('infoNotesEdit').style.display = 'none';
      document.getElementById('infoNotesDisplay').style.display = 'block';
    }

    async function saveInfoNotes() {
      var textarea = document.getElementById('infoNotesInput');
      var notes = textarea.value;
      var filename = window._infoOriginalFilename;
      var status = document.getElementById('infoNotesSaveStatus');
      if (status) { status.textContent = '保存中...'; status.style.color = 'var(--muted)'; }
      try {
        var res = await fetch('/api/file-notes/' + encodeURIComponent(filename), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...headers() },
          body: JSON.stringify({ notes: notes })
        });
        var data = await res.json();
        if (data && data.success) {
          var display = document.getElementById('infoNotesDisplay');
          var textEl = document.getElementById('infoNotesText');
          if (textEl) {
            if (notes.trim()) {
              textEl.textContent = notes;
              textEl.style.fontStyle = 'normal';
              textEl.style.color = 'var(--text)';
            } else {
              textEl.textContent = '点击添加备注...';
              textEl.style.fontStyle = 'italic';
              textEl.style.color = 'var(--text-muted)';
            }
          }
          document.getElementById('infoNotesEdit').style.display = 'none';
          display.style.display = 'block';
          if (status) { status.textContent = '已保存'; status.style.color = 'var(--success)'; setTimeout(function() { if (status) status.textContent = ''; }, 2000); }
        } else {
          if (status) { status.textContent = '保存失败'; status.style.color = 'var(--error)'; }
        }
      } catch(e) {
        if (status) { status.textContent = '保存失败'; status.style.color = 'var(--error)'; }
      }
    }

    async function toggleFileStarred(filename, willStar) {
      try {
        const res = await fetch('/api/files/' + encodeURIComponent(filename), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...headers() },
          body: JSON.stringify({ starred: willStar ? 1 : 0 })
        });
        const data = await res.json();
        if (data.success) {
          showToast(willStar ? '已添加收藏' : '已取消收藏', 'success');
          showFileInfo(filename);
          if (typeof loadFiles === 'function') loadFiles();
        }
      } catch (e) {
        showToast('操作失败', 'error');
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
      const url = data.share.url;
      await copyToClipboard(url);
      // Show URL in toast (truncated if too long)
      const display = url.length > 60 ? url.slice(0, 57) + '...' : url;
      showToast('已复制: ' + display, 'success');
    }

    async function copyFilePath(filename) {
      await navigator.clipboard.writeText('/' + filename);
      showToast('已复制文件路径: /' + filename, 'success');
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
        forceCloseModal();
      }
    });

    async function previewFile(filename) {
      const modalBody = document.getElementById('modalBody');
      document.getElementById('modalTitle').textContent = filename;
      modalBody.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">加载中...</div>';
      document.getElementById('modal').classList.add('open');

      function setPreviewActions(filename) {
        var previewModal = document.getElementById('modal');
        if (!previewModal) return;
        var actions = previewModal.querySelector('.modal-actions');
        if (!actions) return;
        var i18n = typeof langDict !== 'undefined' ? langDict : {};
        var closeL = i18n['close'] || '关闭';
        var dlL = i18n['download'] || '下载';
        var shareL = i18n['share'] || '分享';
        var renameL = '重命名';
        var copyPathL = '复制路径';
        actions.innerHTML =
          '<button class="secondary" onclick="forceCloseModal()">' + closeL + '</button>' +
          '<button class="secondary" onclick="startInlineRename(\'' + filename.replace(/'/g, "\\'") + '\');forceCloseModal()">' + renameL + '</button>' +
          '<button class="secondary" onclick="createShare(' + JSON.stringify(filename) + ');forceCloseModal()">' + shareL + '</button>' +
          '<button class="secondary" onclick="copyFilePath(\'' + filename.replace(/'/g, "\\'") + '\')">' + copyPathL + '</button>' +
          '<button class="secondary" onclick="openFileVersions(' + JSON.stringify(filename) + ')">📜 历史</button>' +
          '<button class="primary" onclick="downloadFile(' + JSON.stringify(filename) + ')">' + dlL + '</button>';
      }

      // Track gallery position when opening preview
      openGalleryAt(filename);

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
        var galTotal = galleryFiles.length;
        var galIdx = galleryIndex + 1;
        var prevBtn = galTotal > 1 ? '<button onclick="navigateGallery(-1)" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.45);border:none;color:#fff;width:44px;height:44px;border-radius:50%;cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)" title="上一张 (←)">‹</button>' : '';
        var nextBtn = galTotal > 1 ? '<button onclick="navigateGallery(1)" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.45);border:none;color:#fff;width:44px;height:44px;border-radius:50%;cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)" title="下一张 (→)">›</button>' : '';
        var counter = galTotal > 1 ? '<div style="position:absolute;top:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.45);color:#fff;padding:4px 12px;border-radius:20px;font-size:12px;backdrop-filter:blur(4px)">' + galIdx + ' / ' + galTotal + '</div>' : '';
        var modDate = file.updated_at ? new Date(file.updated_at).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '-';
        var infoBar = '<div style="display:flex;align-items:center;justify-content:center;gap:16px;margin-top:8px;font-size:12px;color:var(--muted)"><span>📄 ' + formatBytes(file.size || 0) + '</span><span>🕐 ' + modDate + '</span></div>';
        modalBody.innerHTML = '<div id="imgPreviewWrap" style="text-align:center;cursor:zoom-in;position:relative" onclick="openLightbox(\'' + imgSrc.replace(/'/g, "\\'") + '\', \'' + (file.mime || '').replace(/'/g, "\\'") + '\', ' + JSON.stringify(filename) + ')">' + prevBtn + nextBtn + counter + '<img alt="" src="' + imgSrc + '" style="max-width:100%;max-height:70vh;display:block;margin:0 auto;border-radius:8px"></div><div style="text-align:center;margin-top:8px;font-size:11px;color:var(--muted)">点击图片放大</div>' + infoBar;
        setPreviewActions(filename);
      } else if (file.mime === 'application/pdf') {
        modalBody.innerHTML = '<iframe src="data:application/pdf;base64,' + file.content + '" style="width:100%;height:70vh;border:none;border-radius:8px" title="PDF预览"></iframe>';
        setPreviewActions(filename);
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
        setPreviewActions(filename);
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
        setPreviewActions(filename);
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
        setPreviewActions(filename);
        return;
      } else if ((file.mime || '').startsWith('video/')) {
        var vModDate = file.updated_at ? new Date(file.updated_at).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '-';
        var vInfoBar = '<div style="display:flex;align-items:center;justify-content:center;gap:16px;margin-top:8px;font-size:12px;color:var(--muted)"><span>📄 ' + formatBytes(file.size || 0) + '</span><span>🕐 ' + vModDate + '</span><span>← → 切换</span></div>';
        modalBody.innerHTML = '<video controls style="width:100%;max-height:70vh;border-radius:8px;background:#000"><source src="data:' + file.mime + ';base64,' + file.content + '">您的浏览器不支持视频预览</video>' + vInfoBar;
        setPreviewActions(filename);
      } else if ((file.mime || '').startsWith('audio/')) {
        var aModDate = file.updated_at ? new Date(file.updated_at).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '-';
        var aInfoBar = '<div style="display:flex;align-items:center;justify-content:center;gap:16px;margin-top:8px;font-size:12px;color:var(--muted)"><span>📄 ' + formatBytes(file.size || 0) + '</span><span>🕐 ' + aModDate + '</span></div>';
        modalBody.innerHTML = '<audio controls style="width:100%;margin-top:20px"><source src="data:' + file.mime + ';base64,' + file.content + '">您的浏览器不支持音频预览</audio>' + aInfoBar;
        setPreviewActions(filename);
      } else {
        modalBody.innerHTML = '<p class="muted">此文件类型不做内嵌预览，请直接下载。</p><button class="btn secondary" onclick=' + "'" + 'downloadFile(' + JSON.stringify(filename) + ')' + "'" + '>下载文件</button>';
      }
    }

    function openQrLightbox(code) {
      // Fetch the QR code image URL and show it in lightbox
      var qrUrl = '/api/share/qr/' + encodeURIComponent(code);
      openLightbox(qrUrl, 'image/png', null); // null = no download btn for QR
    }

    async function downloadQrCode(code) {
      try {
        var response = await fetch('/api/share/qr/' + encodeURIComponent(code));
        if (!response.ok) { showToast('下载失败', 'error'); return; }
        var blob = await response.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'share-qr-' + code + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch(e) {
        showToast('下载失败', 'error');
      }
    }

    async function downloadRequestLinkQr(code) {
      try {
        var response = await fetch('/api/request-link/qr/' + encodeURIComponent(code));
        if (!response.ok) { showToast('下载失败', 'error'); return; }
        var blob = await response.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'request-link-qr-' + code + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch(e) {
        showToast('下载失败', 'error');
      }
    }

    /* ===== File Hover Card ===== */
    .hover-card {
      position: fixed;
      z-index: 9998;
      background: var(--bg-secondary, #fff);
      border: 1px solid var(--line, #e5e7eb);
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,.15);
      pointer-events: none;
      opacity: 0;
      transition: opacity .15s;
      max-width: 280px;
      min-width: 180px;
    }
    .hover-card.show { opacity: 1; }
    .hover-card .hc-name {
      font-weight: 600;
      font-size: 13px;
      word-break: break-all;
      margin-bottom: 6px;
      color: var(--text);
    }
    .hover-card .hc-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--text-secondary, #6b7280);
      padding: 2px 0;
    }
    .hover-card .hc-row span:first-child { color: var(--text-muted, #9ca3af); }

    function openLightbox(imgSrc, mime, filename) {
      var lb = document.getElementById('lightboxOverlay');
      if (lb) { lb.remove(); }
      lb = document.createElement('div');
      lb.id = 'lightboxOverlay';
      lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center';
      lb.onclick = function(e) { if (e.target === lb || e.target.tagName === 'IMG') lb.remove(); };
      var downloadBtn = filename
        ? '<button onclick="downloadFile(' + JSON.stringify(filename) + ')" style="position:fixed;top:16px;right:80px;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);color:#fff;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;backdrop-filter:blur(4px)">⬇ 下载</button>'
        : '';
      lb.innerHTML = downloadBtn +
        '<img src="' + imgSrc + '" style="max-width:95vw;max-height:95vh;object-fit:contain;border-radius:4px;box-shadow:0 8px 40px rgba(0,0,0,.5);cursor:zoom-out" alt="">' +
        '<button onclick="lbremove()" style="position:fixed;top:16px;right:16px;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)">✕</button>';
      window.lbremove = function() { var l = document.getElementById('lightboxOverlay'); if (l) l.remove(); };
      document.body.appendChild(lb);
    }

    /* ===== Hover Card ===== */
    var hoverCardTimer = null;
    var lastHoverCardIndex = -1;

    function showHoverCard(index) {
      if (index === lastHoverCardIndex) return;
      lastHoverCardIndex = index;
      clearTimeout(hoverCardTimer);
      var el = getFileAtIndex(index);
      if (!el) return;
      var file = currentFiles[index];
      if (!file) return;

      var hc = document.getElementById('hoverCard');
      if (!hc) {
        hc = document.createElement('div');
        hc.id = 'hoverCard';
        hc.className = 'hover-card';
        document.body.appendChild(hc);
      }

      var size = file.size ? formatSize(file.size) : '--';
      var created = file.created_at ? new Date(file.created_at * 1000).toLocaleDateString('zh-CN') : '--';
      var hash = file.hash ? '<div class="hc-row"><span>MD5</span><span style="font-family:monospace;font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis">' + escapeHtmlClient(file.hash) + '</span></div>' : '';

      hc.innerHTML =
        '<div class="hc-name">' + escapeHtmlClient(file.name) + '</div>' +
        '<div class="hc-row"><span>大小</span><span>' + size + '</span></div>' +
        '<div class="hc-row"><span>类型</span><span>' + escapeHtmlClient(file.type || 'file') + '</span></div>' +
        '<div class="hc-row"><span>创建</span><span>' + created + '</span></div>' +
        hash +
        '<div class="hc-row"><span>标签</span><span>' + escapeHtmlClient(file.tags || '无') + '</span></div>';

      // Position below the file item
      var rect = el.getBoundingClientRect();
      var hcRect = hc.getBoundingClientRect();
      var top = rect.bottom + 8;
      var left = rect.left;
      // Keep on screen
      if (left + 280 > window.innerWidth) left = window.innerWidth - 290;
      if (top + 200 > window.innerHeight) top = rect.top - 200 - 8;
      hc.style.top = top + 'px';
      hc.style.left = left + 'px';
      hc.classList.add('show');
    }

    function hideHoverCard() {
      lastHoverCardIndex = -1;
      hoverCardTimer = setTimeout(function() {
        var hc = document.getElementById('hoverCard');
        if (hc) hc.classList.remove('show');
      }, 150);
    }

    function attachHoverCard() {
      document.removeEventListener('mouseover', hoverCardMouseOver);
      document.removeEventListener('mouseout', hoverCardMouseOut);
      document.addEventListener('mouseover', hoverCardMouseOver, { passive: true });
      document.addEventListener('mouseout', hoverCardMouseOut, { passive: true });
    }

    function hoverCardMouseOver(e) {
      var el = e.target.closest('#fileTableBody tr[data-index], #fileTableGrid .file-item');
      if (!el) { hideHoverCard(); return; }
      var idx = parseInt(el.dataset.index, 10);
      if (isNaN(idx)) { hideHoverCard(); return; }
      clearTimeout(hoverCardTimer);
      showHoverCard(idx);
    }

    function hoverCardMouseOut(e) {
      if (e.relatedTarget && e.target.closest('#fileTableBody tr[data-index], #fileTableGrid .file-item')) {
        // Check if moving to another file item
        if (!e.relatedTarget.closest('#hoverCard') &&
            !e.relatedTarget.closest('#fileTableBody tr[data-index], #fileTableGrid .file-item')) {
          hideHoverCard();
        }
      } else if (!e.relatedTarget || !e.relatedTarget.closest('#hoverCard')) {
        hideHoverCard();
      }
    }

    // Call attachHoverCard after renderFiles
    var _origRenderFiles = renderFiles;
    renderFiles = function() {
      _origRenderFiles.apply(this, arguments);
      attachHoverCard();
    };

    function renderTextPreview(filename, content, origSize, isTruncated, lang, ext) {
      const modalBody = document.getElementById('modalBody');
      const truncatedNote = isTruncated && origSize
        ? '<div style="background:#fffbea;border:1px solid #f59e0b;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#92400e">⚠️ 文件过大（' + formatSize(origSize) + '），仅显示前 500KB。<button class="btn-sm secondary" onclick=' + "'" + 'downloadFile(' + JSON.stringify(filename) + ')' + "'" + '>下载查看完整内容</button></div>'
        : '';
      const isMd = ext === 'md';
      let bodyContent;
      // Edit button (text files only, non-truncated) — content stored in window var to avoid stringify issues
      const editBtn = !isMd && !lang && !isTruncated
        ? '<button id="textEditBtn" onclick="switchToEditMode(' + JSON.stringify(filename).replace(/'/g, "\\'") + ')" style="padding:5px 12px;font-size:12px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer;margin-bottom:10px">✏️ 编辑</button>'
        : '';
      if (!isMd && !lang && !isTruncated) window._previewContent = content;

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
        modalBody.innerHTML = truncatedNote + editBtn +
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
      // Add modal action buttons for text preview
      var previewModal = document.getElementById('modal');
      if (previewModal) {
        var actions = previewModal.querySelector('.modal-actions');
        if (actions) {
          // Use langDict (client-side i18n) — consistent with setLanguage/i18n API
          var closeLabel = (typeof langDict !== 'undefined' && langDict['close']) ? langDict['close'] : '关闭';
          var dlLabel = (typeof langDict !== 'undefined' && langDict['download']) ? langDict['download'] : '下载';
          actions.innerHTML = '<button class="secondary" onclick="forceCloseModal()">' + closeLabel + '</button>' +
            '<button class="primary" onclick="downloadFile(' + JSON.stringify(filename) + ')">' + dlLabel + '</button>';
        }
      }
    }

    function switchToEditMode(filename) {
      var content = window._previewContent || '';
      var modalBody = document.getElementById('modalBody');
      document.getElementById('modalTitle').textContent = '✏️ 编辑: ' + escapeHtmlClient(filename);
      modalBody.innerHTML =
        '<textarea id="editContent" spellcheck="false" style="width:100%;min-height:60vh;background:var(--bg-secondary);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:16px;font-family:monospace;font-size:13px;line-height:1.5;resize:vertical;box-sizing:border-box;outline:none">' + escapeHtmlClient(content) + '</textarea>' +
        '<div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">' +
        '<button onclick="cancelEdit(\'' + filename.replace(/'/g, "\\'") + '\')" class="secondary" style="padding:8px 16px">取消</button>' +
        '<button onclick="saveEdit(\'' + filename.replace(/'/g, "\\'") + '\')" class="primary" style="padding:8px 16px">💾 保存</button>' +
        '</div>';
      window._previewContent = content; // preserve original for cancel
    }

    async function saveEdit(filename) {
      var newContent = document.getElementById('editContent').value;
      try {
        var res = await fetch('/api/content/' + encodeURIComponent(filename), {
          method: 'PUT',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
          body: JSON.stringify({ content: newContent })
        });
        var data = await res.json();
        if (data.success) {
          showToast('文件已保存', 'success');
          window._previewContent = newContent;
          document.getElementById('modal').classList.remove('open');
          if (typeof loadFiles === 'function') loadFiles();
        } else {
          showToast('保存失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
      }
    }

    function cancelEdit(filename) {
      // Restore to preview mode by re-fetching
      previewFile(filename);
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

    function formatEta(seconds) {
      if (seconds < 60) return seconds + '秒';
      if (seconds < 3600) return Math.round(seconds / 60) + '分钟';
      return (seconds / 3600).toFixed(1) + '小时';
    }

    function openDeleteConfirmModal(selected) {
      var isMulti = selected.length > 1;
      document.getElementById('modalTitle').textContent = '确认删除';
      document.getElementById('modalBody').innerHTML =
        '<div style="padding:8px 0;text-align:center">' +
          '<div style="font-size:48px;margin-bottom:16px">🗑️</div>' +
          '<p style="font-size:15px;margin-bottom:8px">' + (isMulti ? '确定删除选中的 ' + selected.length + ' 个文件？' : '确定删除「' + escapeHtmlClient(selected[0]) + '」？') + '</p>' +
          '<p style="color:var(--text-muted);font-size:13px">此操作不可撤销</p>' +
        '</div>';
      var modal = document.getElementById('modal');
      modal.querySelector('.modal-actions').innerHTML =
        '<button class="secondary" onclick="forceCloseModal()">取消</button>' +
        '<button style="background:#dc2626;color:#fff" onclick="confirmDeleteFromModal(' + selected.length + ')">删除</button>';
      modal.classList.add('open');
    }

    function confirmDeleteFromModal(count) {
      forceCloseModal();
      var names = checkedNames().map(function(n) { return decodeURIComponent(n); });
      if (!names.length) return;
      var toDelete = names.slice(0, count);
      if (toDelete.length === 1) {
        deleteFile(toDelete[0]);
      } else {
        batchDeleteConfirmed(toDelete);
      }
    }

    function forceCloseModal() {
      document.getElementById('modal').classList.remove('open');
      document.getElementById('modalBody').innerHTML = '';
    }

    function closeModal(event) {
      if (event.target.id === 'modal') forceCloseModal();
    }

    // Generic modal opener — used by virtual folder manager and "add to VF" modals
    function openModal(title, body /*, _actions (unused) */) {
      document.getElementById('modalTitle').textContent = title;
      document.getElementById('modalBody').innerHTML = body;
      document.getElementById('modal').classList.add('open');
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
          fetch('/api/file-rename/' + encodeURIComponent(original), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers() },
            body: JSON.stringify({ newFilename: newName })
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
      var m = document.getElementById('renameFileModal');
      if (m) m.remove();
      m = document.createElement('div');
      m.id = 'renameFileModal';
      m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10002;display:flex;align-items:center;justify-content:center;padding:20px';
      m.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:440px;font-size:14px">\
          <h3 style="margin:0 0 16px">重命名文件</h3>\
          <div style="margin-bottom:16px">\
            <label style="display:block;margin-bottom:4px;font-size:13px;color:var(--muted)">当前名称</label>\
            <div style="padding:8px 10px;background:var(--bg);border-radius:6px;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted)">' + escapeHtmlClient(filename) + '</div>\
          </div>\
          <div style="margin-bottom:20px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">新名称</label>\
            <input id="renameFileInput" type="text" value="' + escapeHtmlClient(filename) + '" ' +
              'style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'renameFileModal\').remove()">取消</button>\
            <button id="renameFileBtn" onclick="confirmRenameFile(\'' + filename.replace(/'/g, "\\'") + '\')">确定</button>\
          </div>\
        </div>';
      document.body.appendChild(m);
      m.addEventListener('click', function(e) { if (e.target === m) m.remove(); });
      // Focus and select filename (without extension)
      var inp = document.getElementById('renameFileInput');
      setTimeout(function() { inp.focus(); var dot = inp.value.lastIndexOf('.'); if (dot > 0) inp.setSelectionRange(0, dot); else inp.select(); }, 50);
      inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); confirmRenameFile(filename); } });
    }

    async function confirmRenameFile(origFilename) {
      var next = (document.getElementById('renameFileInput') || {value: ''}).value.trim();
      if (!next || next === origFilename) { var m = document.getElementById('renameFileModal'); if (m) m.remove(); return; }
      var btn = document.getElementById('renameFileBtn');
      if (btn) { btn.disabled = true; }
      var m = document.getElementById('renameFileModal');
      try {
        await request('/api/file-rename/' + encodeURIComponent(origFilename), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newFilename: next })
        });
        if (m) m.remove();
        await loadFiles();
      } catch (e) {
        showToast('重命名失败: ' + e.message, 'error');
        if (btn) { btn.disabled = false; }
      }
    }
      await loadShares();
    }

    async function deleteFile(filename) {
      // Optimistic remove: update DOM immediately, revert on failure
      var deletedIdx = currentFiles.findIndex(function(f) { return f.name === filename; });
      var deletedFile = deletedIdx !== -1 ? currentFiles[deletedIdx] : null;
      var deletedEl = null;
      if (deletedIdx !== -1) {
        currentFiles.splice(deletedIdx, 1);
        var el = document.querySelector('[data-filename="' + encodeURIComponent(filename) + '"]');
        if (el) { el.style.opacity = '0.3'; el.style.pointerEvents = 'none'; deletedEl = el; }
      }
      try {
        const res = await request('/api/files/' + encodeURIComponent(filename), { method: 'DELETE' });
        if (res && res.trash_id) {
          lastDeletedTrashId = res.trash_id;
          undoDeleteTimer = setTimeout(() => { lastDeletedTrashId = null; }, 5500);
          showToast('已删除', '', true);
        } else {
          showToast('已删除', 'success');
        }
        // Remove DOM element after brief visual feedback
        if (deletedEl) {
          setTimeout(function() { if (deletedEl.parentNode) deletedEl.remove(); }, 150);
        }
        // Update stats without full re-render
        var countEl = document.getElementById('fileCountDisplay');
        if (countEl && deletedIdx !== -1) {
          countEl.innerHTML = '共 <strong>' + currentFiles.length + '</strong> 个文件';
        }
        // Invalidate tags cache — tags may have changed
        _cachedTagData = null;
        await loadShares();
      } catch (error) {
        // Revert optimistic update on failure
        if (deletedIdx !== -1 && deletedFile) {
          currentFiles.splice(deletedIdx, 0, deletedFile);
          if (deletedEl) { deletedEl.style.opacity = ''; deletedEl.style.pointerEvents = ''; }
        }
        showToast(error.message, 'error');
      }
    }

    async function deleteAllFiles() {
      openConfirmModal({
        title: '确定删除所有文件？',
        text: '所有文件将被永久删除，此操作不可恢复。',
        danger: true,
        onConfirm: async function() {
          await request('/api/delete-all', { method: 'DELETE' });
          await loadFiles();
          await loadShares();
        }
      });
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

        // Default sort
        '<div>' +
          '<label style="font-weight:600;display:block;margin-bottom:8px">默认排序</label>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
            '<button class="secondary" style="font-size:12px;padding:5px 10px" onclick="setDefaultSort(\'filename\',\'asc\')">名称 ↑</button>' +
            '<button class="secondary" style="font-size:12px;padding:5px 10px" onclick="setDefaultSort(\'filename\',\'desc\')">名称 ↓</button>' +
            '<button class="secondary" style="font-size:12px;padding:5px 10px" onclick="setDefaultSort(\'size\',\'desc\')">大小 ↓</button>' +
            '<button class="secondary" style="font-size:12px;padding:5px 10px" onclick="setDefaultSort(\'updated_at\',\'desc\')">更新时间 ↓</button>' +
            '<button class="secondary" style="font-size:12px;padding:5px 10px" onclick="setDefaultSort(\'created_at\',\'desc\')">创建时间 ↓</button>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:6px">当前: <span id="settingsCurrentSort"></span></div>' +
        '</div>' +

        // Confirm before delete
        '<div>' +
          '<label style="font-weight:600;display:block;margin-bottom:8px">安全确认</label>' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">' +
            '<input type="checkbox" id="settingsConfirmDelete" onchange="setConfirmDelete(this.checked)" style="width:16px;height:16px">' +
            '<span>删除前显示确认对话框</span>' +
          '</label>' +
        '</div>' +

        // Trash auto-cleanup
        '<div>' +
          '<label style="font-weight:600;display:block;margin-bottom:8px">🗑️ 回收站自动清理</label>' +
          '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">进入回收站超过此天数的文件将自动永久删除（不开启则永不自动清理）</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
            '<button id="tacOff" class="secondary" style="font-size:12px;padding:5px 10px" onclick="setTrashAutoClean(0)">不开启</button>' +
            '<button id="tac7" class="secondary" style="font-size:12px;padding:5px 10px" onclick="setTrashAutoClean(7)">7天</button>' +
            '<button id="tac30" class="secondary" style="font-size:12px;padding:5px 10px" onclick="setTrashAutoClean(30)">30天</button>' +
            '<button id="tac90" class="secondary" style="font-size:12px;padding:5px 10px" onclick="setTrashAutoClean(90)">90天</button>' +
          '</div>' +
          '<div id="trashAutoCleanStatus" style="font-size:11px;color:var(--muted);margin-top:6px"></div>' +
        '</div>' +

        // Keyboard shortcuts
        '<div>' +
          '<label style="font-weight:600;display:block;margin-bottom:8px">键盘快捷键</label>' +
          '<button class="secondary" style="font-size:13px;padding:6px 14px" onclick="openKeyboardHelpFromSettings()">⌨️ 查看快捷键</button>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:6px">按 <kbd style="background:var(--bg-tertiary);padding:1px 5px;border-radius:3px;font-size:10px">?</kbd> 可随时查看</div>' +
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

        // Token management
        '<div style="border-top:1px solid var(--line);padding-top:16px;margin-top:4px">' +
          '<label style="font-weight:600;display:block;margin-bottom:8px">🔑 Token 管理</label>' +
          '<div style="font-size:12px;color:var(--muted);line-height:1.8;margin-bottom:10px">定期更换 Token 可提升安全性。当前 Token: <code id="settingsCurrentToken" style="background:var(--bg-tertiary);padding:2px 6px;border-radius:4px;font-size:11px;word-break:break-all"></code></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="secondary" style="font-size:13px;padding:6px 14px" onclick="rotateToken()">🔄 更换 Token</button>' +
            '<button class="ghost" style="font-size:13px;padding:6px 14px" onclick="openAuditLog()">📋 审计日志</button>' +
            '<button class="ghost" style="font-size:13px;padding:6px 14px" onclick="openDeviceManager()">📱 设备管理</button>' +
            '<button class="ghost" style="font-size:13px;padding:6px 14px" onclick="openSyncDashboard()">📡 同步面板</button>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Database backup
        '<div style="border-top:1px solid var(--line);padding-top:16px;margin-top:4px">' +
          '<label style="font-weight:600;display:block;margin-bottom:8px">💾 数据库备份</label>' +
          '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">创建 SQLite 数据库完整备份，可直接导入恢复。</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="secondary" style="font-size:13px;padding:6px 14px" onclick="backupDatabase()">📦 下载备份</button>' +
          '</div>' +
        '</div>' +

        // Share templates management
        '<div style="border-top:1px solid var(--line);padding-top:16px;margin-top:4px">' +
          '<label style="font-weight:600;display:block;margin-bottom:8px">🔗 分享模板管理</label>' +
          '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">管理保存的分享链接预设模板。</div>' +
          '<div id="shareTemplatesList" style="margin-bottom:10px"></div>' +
          '<button class="secondary" style="font-size:13px;padding:6px 14px" onclick="openManageShareTemplates()">管理模板</button>' +
        '</div>' +

        // Version history
        '<div style="border-top:1px solid var(--line);padding-top:16px;margin-top:4px">' +
          '<label style="font-weight:600;display:block;margin-bottom:8px">📋 版本历史</label>' +
          '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">查看 ShareTool 所有已发布的功能更新记录。</div>' +
          '<button class="secondary" style="font-size:13px;padding:6px 14px" onclick="openVersionHistory()">查看版本历史</button>' +
        '</div>';

      modal.classList.add('open');
      loadSettingsInfo();
      loadShareTemplatesSettings();
      loadTrashAutoCleanSetting();
    }

    function openVersionHistory() {
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '📋 版本历史';

      var versions = [
        { ver: 'v6.186.0', desc: '🔍 全屏搜索 — Ctrl+K 打开统一搜索，覆盖文件/分享/收集链接，带类型过滤芯片和分组结果' },
        { ver: 'v6.185.0', desc: '📊 分享链接详情弹窗 — 点击分享文件名查看访问/下载/过期统计，快捷操作按钮；虚拟文件夹管理器显示大小' },
        { ver: 'v6.184.0', desc: '🔽 收集链接状态过滤器 — 下拉筛选全部/有效/已停用' },
        { ver: 'v6.183.0', desc: '🗂️ 批量操作弹窗化 — 删除、重命名等操作全面替换为样式弹窗替代浏览器 confirm/prompt' },
        { ver: 'v6.182.0', desc: '🌐 URL 上传 — 支持从远程 HTTP(S) URL 直接下载文件保存到存储' },
        { ver: 'v6.181.0', desc: '🗑️ 回收站自动清理 — 可配置 7/30/90 天自动清空；修复 SQL 占位符 bug' },
        { ver: 'v6.180.0', desc: '📁 在 Finder 中打开 — 右键菜单支持"在 Finder 中打开"，使用 open -R 定位文件' },
        { ver: 'v6.179.0', desc: '📊 批量统计弹窗 — 批量操作栏新增"统计"按钮，显示选中文件的总大小、类型分布、扩展名分布、创建日期分布' },
        { ver: 'v6.178.0', desc: '🔧 批量 UI 优化 — 批量移动改为弹窗输入框，删除改为样式弹窗确认' },
        { ver: 'v6.177.0', desc: '🔢 快速排序按钮 — 文件列表头部新增 4 个一键排序按钮（更新时间/A-Z/大小/类型），当前排序高亮显示' },
        { ver: 'v6.176.0', desc: '📋 收集链接复制 — 复制现有收集链接的配置到新链接，默认 30 天有效期' },
        { ver: 'v6.175.0', desc: '✏️ 虚拟文件夹双击重命名 — 双击文件夹名称可直接编辑，Enter 确认，Escape 取消' },
        { ver: 'v6.174.0', desc: '🏷️ 批量标签改进 — 标签输入弹窗新增已有标签面板（点击添加）和实时标签建议下拉' },
        { ver: 'v6.173.0', desc: '🎨 虚拟文件夹颜色选择器 — 文件夹详情弹窗中点击颜色圆点可打开颜色选择器' },
        { ver: 'v6.172.0', desc: 'ℹ️ 批量文件详情查看器 — 批量操作栏"i"按钮显示所有选中文件的元数据（名称/大小/类型/上传时间/标签）' },
        { ver: 'v6.171.0', desc: '🐛 修复批量分享复选框 bug — 修复批量复制/删除/移动/编辑时 data-code 属性读取错误' },
        { ver: 'v6.170.0', desc: '⏱️ 批量分享快捷过期 — 批量分享弹窗新增 7天/30天/90天/1年快捷按钮和"永不过期"清除按钮' },
        { ver: 'v6.169.0', desc: '📝 分享链接模板 — 保存/加载/删除分享预设（有效期/密码/下载限制/主题），在设置面板管理' },
      ];

      var html = '<div style="max-height:500px;overflow-y:auto;padding:4px 0">';
      html += '<div style="text-align:center;padding:8px 0 16px;border-bottom:1px solid var(--line);margin-bottom:12px">';
      html += '<div style="font-size:18px;font-weight:700;margin-bottom:4px">ShareTool</div>';
      html += '<div style="font-size:12px;color:var(--muted)">持续迭代中 · 已发布 ' + versions.length + ' 个版本</div>';
      html += '</div>';
      versions.forEach(function(v) {
        html += '<div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);align-items:flex-start">';
        html += '<div style="min-width:70px;font-weight:600;color:var(--accent);font-size:12px;padding-top:1px">' + v.ver + '</div>';
        html += '<div style="font-size:13px;line-height:1.6;color:var(--text-secondary)">' + v.desc + '</div>';
        html += '</div>';
      });
      html += '<div style="text-align:center;padding:16px 0 4px;font-size:12px;color:var(--muted)">';
      html += '更早版本请查看 <a href="https://github.com/guige2023/share-tool/releases" target="_blank" style="color:var(--accent)">GitHub Releases</a>';
      html += '</div></div>';
      body.innerHTML = html;
      modal.classList.add('open');
    }

    async function openStorageStats() {
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '存储统计';
      body.innerHTML = '<div id="storageStatsContent" style="padding:8px 0"><div style="text-align:center;color:var(--muted);padding:20px">加载中…</div></div>';
      modal.classList.add('open');

      try {
        var res = await fetch('/api/storage', { headers: headers() });
        var data = await res.json();
        if (!data.success) throw new Error(data.error || '加载失败');

        var stats = data.stats || {};
        var total = stats.totalSize || 0;
        var totalStr = total > 1024 * 1024 * 1024 ? (Math.round(total / 1024 / 1024 / 1024 * 10) / 10 + ' GB') : total > 1024 * 1024 ? (Math.round(total / 1024 / 1024) + ' MB') : (Math.round(total / 1024) + ' KB');
        var totalFiles = stats.totalFiles || 0;
        var byType = stats.byType || [];
        var byDay = stats.byDay || [];

        var maxCount = Math.max.apply(null, byDay.map(function(d) { return d.file_count || 0; })) || 1;

        var html = '';

        // Summary cards
        html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px">';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px;text-align:center">';
        html += '<div style="font-size:24px;font-weight:700;color:var(--accent)">' + totalStr + '</div>';
        html += '<div style="font-size:11px;color:var(--muted);margin-top:4px">总占用</div></div>';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px;text-align:center">';
        html += '<div style="font-size:24px;font-weight:700;color:var(--primary)">' + totalFiles + '</div>';
        html += '<div style="font-size:11px;color:var(--muted);margin-top:4px">文件总数</div></div>';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px;text-align:center">';
        html += '<div style="font-size:24px;font-weight:700;color:#8b5cf6">' + (byType.length) + '</div>';
        html += '<div style="font-size:11px;color:var(--muted);margin-top:4px">文件类型</div></div>';
        html += '</div>';

        // Type breakdown
        if (byType.length) {
          html += '<div style="margin-bottom:20px">';
          html += '<div style="font-weight:600;margin-bottom:10px;font-size:13px">📂 文件类型分布</div>';
          var maxSize = Math.max.apply(null, byType.map(function(t) { return t.size || 0; })) || 1;
          byType.forEach(function(t) {
            var pct = Math.round((t.size / maxSize) * 100);
            var sizeStr = t.size > 1024 * 1024 * 1024 ? (Math.round(t.size / 1024 / 1024 / 1024 * 10) / 10 + ' GB') : t.size > 1024 * 1024 ? (Math.round(t.size / 1024 / 1024) + ' MB') : (Math.round(t.size / 1024) + ' KB');
            var colors = { image: '#10b981', video: '#8b5cf6', audio: '#f59e0b', pdf: '#ef4444', document: '#3b82f6', text: '#6366f1', other: '#94a3b8', archive: '#f97316' };
            var color = colors[t.category] || '#94a3b8';
            html += '<div style="margin-bottom:8px">';
            html += '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">';
            html += '<span>' + t.category + ' <span style="color:var(--muted)">(' + t.count + '个)</span></span>';
            html += '<span style="color:var(--muted)">' + sizeStr + '</span></div>';
            html += '<div style="height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden">';
            html += '<div style="height:100%;width:' + pct + '%;background:' + color + ';border-radius:3px;transition:width .3s"></div>';
            html += '</div></div>';
          });
          html += '</div>';
        }

        // 7-day trend
        if (byDay.length) {
          html += '<div style="margin-bottom:16px">';
          html += '<div style="font-weight:600;margin-bottom:10px;font-size:13px">📈 近7天趋势</div>';
          html += '<div style="display:flex;align-items:flex-end;gap:4px;height:60px">';
          byDay.forEach(function(d) {
            var barH = Math.max(4, Math.round((d.file_count / maxCount) * 56));
            var dayStr = d.day; // day is already a string like '2026-04-14'
            html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">';
            html += '<div style="font-size:10px;color:var(--accent);font-weight:600">' + d.file_count + '</div>';
            html += '<div style="width:100%;background:var(--accent);border-radius:3px 3px 0 0;min-height:4px;height:' + barH + 'px;opacity:.7"></div>';
            html += '<div style="font-size:9px;color:var(--muted)">' + dayStr.slice(5) + '</div>';
            html += '</div>';
          });
          html += '</div></div>';
        }

        // Size ranges
        if (stats.sizeRanges && stats.sizeRanges.length) {
          html += '<div style="margin-bottom:16px">';
          html += '<div style="font-weight:600;margin-bottom:10px;font-size:13px">📐 文件大小分布</div>';
          stats.sizeRanges.forEach(function(r) {
            var sizeStr = r.size > 1024 * 1024 * 1024 ? (Math.round(r.size / 1024 / 1024 / 1024 * 10) / 10 + ' GB') : r.size > 1024 * 1024 ? (Math.round(r.size / 1024 / 1024) + ' MB') : (Math.round(r.size / 1024) + ' KB');
            html += '<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;color:var(--text-secondary);border-bottom:1px solid var(--line)">';
            html += '<span>' + r.label + '</span><span style="color:var(--muted)">' + r.count + '个 · ' + sizeStr + '</span></div>';
          });
          html += '</div>';
        }

        // Top 5 largest files
        if (stats.topFiles && stats.topFiles.length) {
          html += '<div style="margin-bottom:16px">';
          html += '<div style="font-weight:600;margin-bottom:10px;font-size:13px">🔍 最大文件 Top5</div>';
          stats.topFiles.forEach(function(f, i) {
            var sizeStr = f.size > 1024 * 1024 * 1024 ? (Math.round(f.size / 1024 / 1024 / 1024 * 10) / 10 + ' GB') : f.size > 1024 * 1024 ? (Math.round(f.size / 1024 / 1024) + ' MB') : (Math.round(f.size / 1024) + ' KB');
            html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">';
            html += '<span style="color:var(--muted);font-size:12px;width:16px;text-align:center">' + (i + 1) + '</span>';
            html += '<span style="font-size:16px;flex-shrink:0">' + getFileIcon(f.filename) + '</span>';
            html += '<div style="flex:1;min-width:0">';
            html += '<div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtmlClient(f.filename) + '">' + escapeHtmlClient(f.filename) + '</div>';
            html += '</div>';
            html += '<span style="font-size:12px;color:var(--accent);font-weight:600;flex-shrink:0">' + sizeStr + '</span>';
            html += '</div>';
          });
          html += '</div>';
        }

        document.getElementById('storageStatsContent').innerHTML = html;
      } catch (e) {
        document.getElementById('storageStatsContent').innerHTML = '<div style="color:var(--error);padding:12px">加载失败: ' + escapeHtmlClient(e.message) + '</div>';
      }
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
        var tok = document.getElementById('settingsCurrentToken');
        if (tok) tok.textContent = data.token || SHARE_TOKEN;
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

    async function rotateToken() {
      openConfirmModal({
        title: '确定要更换 Token 吗？',
        text: '更换后需要重新扫码或手动输入新 Token。',
        danger: false,
        onConfirm: async function() {
          try {
            var data = await request('/api/settings/rotate-token', { method: 'POST' });
            if (data.success && data.token) {
              var tok = document.getElementById('settingsCurrentToken');
              if (tok) tok.textContent = data.token;
              showToast('Token 已更换，请刷新页面并更新客户端', 'success', 4000);
            } else {
              showToast(data.error || '更换 Token 失败', 'error');
            }
          } catch (e) {
            showToast('更换 Token 失败: ' + e.message, 'error');
          }
        }
      });
    }

    function backupDatabase() {
      showToast('正在创建备份...', 'info', 2000);
      var a = document.createElement('a');
      a.href = '/api/db/backup';
      a.download = '';
      var h = headers();
      Object.keys(h).forEach(function(k) { a.setAttribute(k, h[k]); });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    function openAuditLog() {
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '审计日志';
      body.innerHTML = '<div id="auditStats" style="display:flex;gap:16px;flex-wrap:wrap;padding:8px 0;font-size:13px;color:var(--muted);border-bottom:1px solid var(--line);margin-bottom:12px"><span>总: <b id="auditTotal">-</b></span><span>今日: <b id="auditToday">-</b></span><span>操作类型: <b id="auditTypes">-</b></span></div><div id="auditFilters" style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center"><select id="auditActionFilter" onchange="loadAuditLogs()" style="padding:5px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);font-size:12px"><option value="">全部操作</option><option value="upload">上传</option><option value="delete">删除</option><option value="share_create">创建分享</option><option value="share_access">访问分享</option><option value="share_delete">删除分享</option><option value="share_update">更新分享</option><option value="token_rotate">更换Token</option><option value="text_update">文本更新</option><option value="rename">重命名</option><option value="batch_delete">批量删除</option><option value="note">备注</option></select><button onclick="exportAuditCSV()" style="font-size:12px;padding:5px 12px" class="secondary">导出 CSV</button><button onclick="openAddAuditNote()" style="font-size:12px;padding:5px 12px" class="ghost">+ 添加备注</button><button onclick="openClearAuditLogs()" style="font-size:12px;padding:5px 12px" class="ghost">清理旧日志</button></div><div id="auditLogs" style="max-height:400px;overflow-y:auto;font-size:12px"></div>';
      modal.classList.add('open');
      loadAuditStats();
      loadAuditLogs();
    }

    async function loadAuditStats() {
      try {
        var data = await request('/api/audit/logs?limit=1&offset=0');
        if (data.stats) {
          var totalEl = document.getElementById('auditTotal');
          var todayEl = document.getElementById('auditToday');
          var typesEl = document.getElementById('auditTypes');
          if (totalEl) totalEl.textContent = data.stats.total || 0;
          if (todayEl) todayEl.textContent = data.stats.todayCount || 0;
          if (typesEl) {
            var byAction = data.stats.byAction || [];
            typesEl.textContent = byAction.slice(0, 5).map(function(a) { return a.action + '(' + a.count + ')'; }).join(', ');
          }
        }
      } catch (e) {}
    }

    async function loadAuditLogs() {
      var action = document.getElementById('auditActionFilter') && document.getElementById('auditActionFilter').value;
      var url = '/api/audit/logs?limit=200&offset=0' + (action ? '&action=' + encodeURIComponent(action) : '');
      try {
        var data = await request(url);
        var logs = data.logs || [];
        var container = document.getElementById('auditLogs');
        if (!container) return;
        if (logs.length === 0) {
          container.innerHTML = '<div style="text-align:center;color:var(--muted);padding:20px">暂无日志</div>';
          return;
        }
        var html = '<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr style="border-bottom:1px solid var(--line);color:var(--muted)"><th style="text-align:left;padding:4px 6px">时间</th><th style="text-align:left;padding:4px 6px">操作</th><th style="text-align:left;padding:4px 6px">详情</th><th style="text-align:left;padding:4px 6px">IP</th></tr></thead><tbody>';
        logs.forEach(function(log) {
          var time = new Date(log.timestamp).toLocaleString('zh-CN', { hour12: false });
          var action = escapeHtmlClient(log.action || '');
          var details = escapeHtmlClient(log.details || '-');
          var ip = escapeHtmlClient(log.ip || '-');
          var actionColors = { upload: '#10b981', delete: '#ef4444', share_create: '#3b82f6', share_access: '#8b5cf6', token_rotate: '#f59e0b' };
          var actionColor = actionColors[action] || 'var(--text-secondary)';
          html += '<tr style="border-bottom:1px solid var(--line)"><td style="padding:4px 6px;color:var(--muted);white-space:nowrap">' + time + '</td><td style="padding:4px 6px;font-weight:500;color:' + actionColor + '">' + action + '</td><td style="padding:4px 6px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + details + '">' + details + '</td><td style="padding:4px 6px;color:var(--muted)">' + ip + '</td></tr>';
        });
        html += '</tbody></table>';
        container.innerHTML = html;
      } catch (e) {
        var c = document.getElementById('auditLogs');
        if (c) c.innerHTML = '<div style="color:#ef4444;padding:10px">加载失败: ' + escapeHtmlClient(e.message) + '</div>';
      }
    }

    function exportAuditCSV() {
      var action = document.getElementById('auditActionFilter') && document.getElementById('auditActionFilter').value;
      var url = '/api/audit/export' + (action ? '?action=' + encodeURIComponent(action) : '');
      window.open(url, '_blank');
    }

    function openAddAuditNote() {
      var note = prompt('输入备注内容（最多500字）:');
      if (!note || !note.trim()) return;
      request('/api/audit/logs', { method: 'POST', body: { note: note.trim() } }).then(function(data) {
        if (data.success) { showToast('备注已添加'); loadAuditLogs(); loadAuditStats(); }
        else showToast('添加失败: ' + (data.error || ''), 'error');
      }).catch(function(e) { showToast('添加失败: ' + e.message, 'error'); });
    }

    function openClearAuditLogs() {
      var days = prompt('清理多少天之前的日志？（默认90天）:', '90');
      if (days === null) return;
      var d = parseInt(days, 10);
      if (!days || isNaN(d) || d < 1) { showToast('请输入有效天数', 'error'); return; }
      if (!confirm('确认清理 ' + d + ' 天之前的日志？此操作不可撤销。')) return;
      request('/api/audit/clear', { method: 'POST', body: { confirm: true, olderThanDays: d } }).then(function(data) {
        if (data.success) { showToast('已清理 ' + (data.deleted || 0) + ' 条日志'); loadAuditLogs(); loadAuditStats(); }
        else showToast('清理失败: ' + (data.error || ''), 'error');
      }).catch(function(e) { showToast('清理失败: ' + e.message, 'error'); });
    }

    // ── Device Manager ────────────────────────────────────────────────
    async function openDeviceManager() {
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '📱 设备管理';
      body.innerHTML = '<div style="padding:8px 0"><div id="deviceList" style="max-height:400px;overflow-y:auto"></div></div>';
      modal.classList.add('open');
      await loadDeviceList();
    }

    async function loadDeviceList() {
      var container = document.getElementById('deviceList');
      if (!container) return;
      try {
        var data = await request('/api/devices');
        var devices = data.devices || [];
        if (devices.length === 0) {
          container.innerHTML = '<div style="text-align:center;color:var(--muted);padding:24px">暂无已注册设备</div>';
          return;
        }
        var html = '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
          '<thead><tr style="border-bottom:1px solid var(--line);color:var(--muted)">' +
          '<th style="text-align:left;padding:8px 10px">设备</th>' +
          '<th style="text-align:left;padding:8px 10px">IP</th>' +
          '<th style="text-align:left;padding:8px 10px">最后活跃</th>' +
          '<th style="text-align:center;padding:8px 10px">状态</th>' +
          '<th style="text-align:right;padding:8px 10px">操作</th></tr></thead><tbody>';
        devices.forEach(function(d) {
          var isOnline = d.is_online === 1;
          var lastSeen = d.last_seen ? new Date(d.last_seen * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未知';
          var syncInfo = d.last_sync_at ? ('同步于 ' + new Date(d.last_sync_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })) : '从未同步';
          var name = escapeHtmlClient(d.device_name || d.device_id || '未知设备');
          var ip = escapeHtmlClient(d.ip || '-');
          html += '<tr style="border-bottom:1px solid var(--line)">' +
            '<td style="padding:8px 10px"><div style="font-weight:500">' + name + '</div><div style="font-size:11px;color:var(--muted);margin-top:2px">' + syncInfo + '</div></td>' +
            '<td style="padding:8px 10px;color:var(--muted);font-size:12px">' + ip + '</td>' +
            '<td style="padding:8px 10px;color:var(--muted);font-size:12px;white-space:nowrap">' + lastSeen + '</td>' +
            '<td style="padding:8px 10px;text-align:center"><span style="padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500;background:' + (isOnline ? '#10b98122;color:#10b981' : '#94a3b822;color:#94a3b8') + '">' + (isOnline ? '🟢 在线' : '⚫ 离线') + '</span></td>' +
            '<td style="padding:8px 10px;text-align:right"><button onclick="deleteDeviceById(\'' + escapeHtmlClient(d.device_id || '').replace(/'/g, "\\'") + '\')" class="danger" style="font-size:12px;padding:4px 10px">删除</button></td></tr>';
        });
        html += '</tbody></table>';
        container.innerHTML = html;
      } catch (e) {
        container.innerHTML = '<div style="color:#ef4444;padding:12px">加载失败: ' + escapeHtmlClient(e.message) + '</div>';
      }
    }

    async function deleteDeviceById(deviceId) {
      openConfirmModal({
        title: '确认删除该设备？',
        text: '删除后该设备需要重新注册。',
        danger: true,
        onConfirm: async function() {
          try {
            var data = await request('/api/devices/' + encodeURIComponent(deviceId), { method: 'DELETE' });
            if (data.success) { showToast('设备已删除', 'success'); loadDeviceList(); }
            else showToast('删除失败: ' + (data.error || ''), 'error');
          } catch (e) { showToast('删除失败: ' + e.message, 'error'); }
        }
      });
    }

    async function openSyncDashboard() {
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '📡 同步面板';
      body.innerHTML = '<div style="padding:8px 0;color:var(--muted);text-align:center">加载中...</div>';
      modal.classList.add('open');

      var syncStatus, devices, logs;
      try {
        var tres = await Promise.all([
          fetch('/api/sync/status', { headers: headers() }),
          fetch('/api/devices', { headers: headers() }),
          fetch('/api/sync/logs?since=0', { headers: headers() })
        ]);
        var jdata = await Promise.all(tres.map(function(r) { return r.json(); }));
        syncStatus = jdata[0];
        devices = jdata[1];
        logs = jdata[2];
      } catch(e) {
        body.innerHTML = '<p style="color:var(--error);padding:20px">加载失败: ' + escapeHtmlClient(e.message) + '</p>';
        return;
      }

      var status = syncStatus || {};
      var deviceList = devices.devices || [];
      var synclogs = (logs.logs || []).slice(0, 20);

      // Status section
      var unsyncedCount = status.unsynced || 0;
      var totalLogs = status.total || 0;
      var unsyncedSize = status.unsyncedSize || 0;
      var statusColor = unsyncedCount === 0 ? '#10b981' : '#f59e0b';
      var statusText = unsyncedCount === 0 ? '✅ 已同步' : '⏳ ' + unsyncedCount + ' 条待同步';

      var html = '<div style="max-width:560px">';

      // Status card
      html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">';
      html += '<div style="background:var(--bg-secondary);border-radius:12px;padding:14px;text-align:center">';
      html += '<div style="font-size:22px;font-weight:700;color:' + statusColor + '">' + statusText + '</div>';
      html += '<div style="font-size:11px;color:var(--muted);margin-top:4px">同步状态</div></div>';
      html += '<div style="background:var(--bg-secondary);border-radius:12px;padding:14px;text-align:center">';
      html += '<div style="font-size:22px;font-weight:700">' + totalLogs + '</div>';
      html += '<div style="font-size:11px;color:var(--muted);margin-top:4px">总记录</div></div>';
      html += '<div style="background:var(--bg-secondary);border-radius:12px;padding:14px;text-align:center">';
      html += '<div style="font-size:22px;font-weight:700">' + formatBytes(unsyncedSize) + '</div>';
      html += '<div style="font-size:11px;color:var(--muted);margin-top:4px">待同步大小</div></div>';
      html += '</div>';

      // Connected devices section
      html += '<div style="margin-bottom:20px">';
      html += '<div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--text-secondary)">📱 已连接设备 (' + deviceList.length + ')</div>';
      if (!deviceList.length) {
        html += '<div style="color:var(--muted);font-size:13px;text-align:center;padding:16px">暂无设备连接</div>';
      } else {
        html += '<div style="display:flex;flex-direction:column;gap:6px">';
        deviceList.forEach(function(dev) {
          var online = dev.isOnline ? '🟢' : '⚫';
          var lastSeen = dev.lastSeen ? new Date(dev.lastSeen * 1000).toLocaleString('zh-CN', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '未知';
          html += '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-secondary);border-radius:8px">';
          html += '<span style="font-size:18px">' + online + '</span>';
          html += '<div style="flex:1;min-width:0">';
          html += '<div style="font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtmlClient(dev.deviceName || '未知设备') + '</div>';
          html += '<div style="font-size:11px;color:var(--muted)">' + (dev.isOnline ? '在线' : '最后在线: ' + lastSeen) + '</div>';
          html += '</div>';
          html += '<div style="font-size:11px;color:var(--muted)">' + (dev.lastSeen ? lastSeen : '') + '</div>';
          html += '</div>';
        });
        html += '</div>';
      }
      html += '</div>';

      // Recent sync activity
      html += '<div>';
      html += '<div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--text-secondary)">📋 最近同步记录</div>';
      if (!synclogs.length) {
        html += '<div style="color:var(--muted);font-size:13px;text-align:center;padding:16px">暂无同步记录</div>';
      } else {
        html += '<div style="display:flex;flex-direction:column;gap:4px;max-height:300px;overflow-y:auto">';
        synclogs.forEach(function(log) {
          var actionIcon = log.action === 'create' ? '➕' : log.action === 'delete' ? '🗑️' : log.action === 'rename' ? '✏️' : '📝';
          var actionText = log.action === 'create' ? '创建' : log.action === 'delete' ? '删除' : log.action === 'rename' ? '重命名' : '更新';
          var time = new Date(log.timestamp * 1000).toLocaleString('zh-CN', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
          html += '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg-secondary);border-radius:6px;font-size:12px">';
          html += '<span>' + actionIcon + '</span>';
          html += '<span style="color:var(--muted);min-width:32px">' + actionText + '</span>';
          html += '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500">' + escapeHtmlClient(log.filename || '-') + '</span>';
          html += '<span style="color:var(--muted)">' + time + '</span>';
          html += '</div>';
        });
        html += '</div>';
      }
      html += '</div>';

      html += '</div>';
      body.innerHTML = html;

      // Update modal actions to just have close
      var actions = modal.querySelector('.modal-actions');
      if (actions) {
        var i18n = typeof langDict !== 'undefined' ? langDict : {};
        actions.innerHTML = '<button class="secondary" onclick="forceCloseModal()">' + (i18n['close'] || '关闭') + '</button>';
      }
    }

    function openKeyboardHelpFromSettings() {
      closeModal();
      setTimeout(openKeyboardHelp, 50);
    }

    function openKeyboardHelp() {
      const modal = document.getElementById('modal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');
      title.textContent = '⌨️ 键盘快捷键';

      function section(title2, shortcuts2) {
        return '<div style="margin-bottom:16px">' +
          '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:8px">' + title2 + '</div>' +
          '<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 16px;padding:0">' +
          shortcuts2.map(function(s) {
            return '<kbd style="background:var(--bg-tertiary);border:1px solid var(--line);border-radius:5px;padding:2px 8px;font-family:monospace;font-size:12px;text-align:center;min-width:52px;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,0.1)">' + escapeHtmlClient(s[0]) + '</kbd>' +
              '<span style="color:var(--text-secondary);padding-top:3px;font-size:13px">' + escapeHtmlClient(s[1]) + '</span>';
          }).join('') + '</div></div>';
      }

      body.innerHTML = '<div style="max-height:80vh;overflow-y:auto;padding:4px">' +

        section('导航', [
          ['j / ↓', '向下导航'],
          ['k / ↑', '向上导航'],
          ['Home / End', '跳到开头/末尾'],
          ['gg', '跳到顶部（连按 g）'],
        ]) +

        section('文件操作', [
          ['Enter', '打开/预览文件'],
          ['Space', '选中/取消选中'],
          ['s', '标记/取消收藏'],
          ['y', '复制文件名'],
          ['c', '复制分享链接'],
          ['n', '新建文本文件'],
          ['r', '刷新文件列表'],
        ]) +

        section('批量操作', [
          ['p', '批量预览选中文件'],
          ['Ctrl+A', '全选 / 取消全选'],
          ['Shift+点击', '范围选中'],
          ['Ctrl+点击', '多选文件'],
          ['Delete', '删除选中的文件'],
        ]) +

        section('视图与主题', [
          ['v', '切换视图 (list ↔ grid)'],
          ['d', '切换主题 (light ↔ dark)'],
          ['f / /', '聚焦搜索框'],
        ]) +

        section('面板', [
          ['t', '打开回收站'],
          ['z', '打开同步面板'],
          ['o', '打开已保存搜索'],
          ['u', '触发上传'],
          ['p', '批量预览选中文件'],
        ]) +

        section('其他', [
          ['?', '显示帮助'],
          ['Esc', '关闭弹窗 / 取消选择'],
        ]) +

        '</div>';
      modal.classList.add('open');
    }

    async function openFileVersions(filename) {
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '📜 ' + filename + ' — 版本历史';
      body.innerHTML = '<div id="versionsContent" style="max-height:70vh;overflow:auto;padding:4px 0"><div style="display:flex;justify-content:center;align-items:center;height:120px;color:var(--muted)">加载中...</div></div>';
      modal.classList.add('open');
      try {
        var res = await fetch('/api/file-versions/' + encodeURIComponent(filename) + '?limit=50', { headers: headers() });
        var data = await res.json();
        if (!data.success) throw new Error(data.error);
        var versions = data.versions || [];
        var currentHash = data.currentHash;
        var fmtSize = function(b) {
          if (b < 1024) return b + ' B';
          if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
          if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
          return (b/1073741824).toFixed(2) + ' GB';
        };
        var fmtTime = function(ts) {
          var d = new Date(ts * 1000);
          return d.toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
        };
        var html = '';
        if (!versions.length) {
          html = '<div style="text-align:center;color:var(--muted);padding:40px">暂无版本记录<br><span style="font-size:12px">修改文件内容后会自动保存版本</span></div>';
        } else {
          html = '<div style="margin-bottom:12px;font-size:12px;color:var(--muted)">共 ' + versions.length + ' 个版本（当前版本以绿色标记）</div>';
          html += '<div style="display:flex;flex-direction:column;gap:8px">';
          versions.forEach(function(v, i) {
            var isCurrent = v.hash === currentHash;
            var bg = isCurrent ? 'border-left:3px solid #10b981;background:var(--bg-tertiary)' : 'border-left:3px solid var(--line)';
            var label = isCurrent ? '<span style="background:#10b98122;color:#10b981;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:600">当前</span>' : '';
            html += '<div style="padding:10px 12px;border-radius:8px;' + bg + '">';
            html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">';
            html += '<div style="display:flex;align-items:center;gap:8px">';
            html += '<span style="font-size:11px;color:var(--muted)">v' + (versions.length - i) + '</span>';
            html += '<span style="font-size:12px;color:var(--text-secondary)">' + fmtTime(v.created_at) + '</span>';
            html += label + '</div>';
            html += '<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)">' + fmtSize(v.size) + '</div></div>';
            html += '<div style="display:flex;gap:6px;margin-top:6px">';
            html += '<button onclick="previewVersion(\'' + filename.replace(/'/g, "\\'") + '\',' + v.id + ')" style="padding:4px 10px;font-size:11px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--line);border-radius:6px;cursor:pointer">预览</button>';
            if (!isCurrent) {
              html += '<button onclick="restoreVersion(\'' + filename.replace(/'/g, "\\'") + '\',' + v.id + ')" style="padding:4px 10px;font-size:11px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer">恢复此版本</button>';
              html += '<button onclick="deleteVersion(\'' + filename.replace(/'/g, "\\'") + '\',' + v.id + ')" style="padding:4px 10px;font-size:11px;background:var(--error);color:#fff;border:none;border-radius:6px;cursor:pointer">删除</button>';
            }
            html += '</div></div>';
          });
          html += '</div>';
        }
        var targetEl = document.getElementById('versionsContent');
        if (targetEl) targetEl.innerHTML = html;
      } catch (e) {
        var errEl = document.getElementById('versionsContent');
        if (errEl) errEl.innerHTML = '<div style="color:var(--error);padding:12px">加载失败: ' + escapeHtmlClient(e.message) + '</div>';
      }
    }

    async function openFileAccessStats(filename) {
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '📊 文件访问统计';
      body.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px">加载中...</div>';
      modal.classList.add('show');
      try {
        var res = await fetch('/api/file-access-stats/' + encodeURIComponent(filename), { headers: headers() });
        var data = await res.json();
        if (!data.success) throw new Error(data.error);
        var s = data.stats;
        var html = '<div style="max-width:600px;padding:4px 0">';

        html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px">';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px;text-align:center"><div style="font-size:24px;font-weight:700">' + (s.totalAccess||0) + '</div><div style="font-size:11px;color:var(--muted)">总访问</div></div>';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px;text-align:center"><div style="font-size:24px;font-weight:700">' + (s.viewCount||0) + '</div><div style="font-size:11px;color:var(--muted)">预览</div></div>';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px;text-align:center"><div style="font-size:24px;font-weight:700">' + (s.downloadCount||0) + '</div><div style="font-size:11px;color:var(--muted)">下载</div></div>';
        html += '</div>';

        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px;margin-bottom:16px">';
        html += '<div style="font-weight:600;margin-bottom:12px;font-size:13px">近30天访问趋势</div>';
        if (s.daily && s.daily.length) {
          var maxDay = Math.max.apply(null, s.daily.map(function(d) { return d.count; }).concat([1]));
          html += '<div style="display:flex;align-items:flex-end;gap:3px;height:60px">';
          s.daily.forEach(function(d) {
            var h = Math.max(Math.round(d.count / maxDay * 50), d.count > 0 ? 3 : 1);
            html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:0;height:100%;justify-content:flex-end" title="' + d.day + ': ' + d.count + '次"><div style="width:100%;height:' + h + 'px;background:var(--accent);border-radius:2px 2px 0 0;opacity:0.8"></div></div>';
          });
          html += '</div>';
        } else {
          html += '<div style="color:var(--muted);font-size:12px;text-align:center">暂无数据</div>';
        }
        html += '</div>';

        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px">';
        html += '<div style="font-weight:600;margin-bottom:12px;font-size:13px">最近访问记录</div>';
        if (s.recent && s.recent.length) {
          html += '<table style="width:100%;font-size:12px"><thead><tr><th style="text-align:left;padding:4px 8px;color:var(--muted)">时间</th><th style="text-align:left;padding:4px 8px;color:var(--muted)">操作</th></tr></thead><tbody>';
          s.recent.forEach(function(r) {
            var dt = new Date(r.timestamp * 1000).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
            var actionLabel = r.action === 'view' ? '预览' : '下载';
            var actionColor = r.action === 'view' ? 'var(--accent)' : '#f59e0b';
            html += '<tr><td style="padding:4px 8px;color:var(--text-secondary)">' + dt + '</td><td style="padding:4px 8px"><span style="color:' + actionColor + ';font-weight:600">' + actionLabel + '</span></td></tr>';
          });
          html += '</tbody></table>';
        } else {
          html += '<div style="color:var(--muted);font-size:12px;text-align:center">暂无记录</div>';
        }
        html += '</div></div>';

        body.innerHTML = html;
      } catch(e) {
        body.innerHTML = '<div style="color:var(--error);padding:12px">加载失败: ' + escapeHtmlClient(e.message) + '</div>';
      }
    }

    window.previewVersion = async function(filename, versionId) {
      try {
        var res = await fetch('/api/file-versions/' + encodeURIComponent(filename) + '/version/' + versionId, { headers: headers() });
        var data = await res.json();
        if (!data.success) { showToast(data.error || '加载失败', 'error'); return; }
        var v = data.version;
        var isText = v.content !== null && v.content !== undefined && v.size < 1024 * 512;
        if (isText) {
          // Show text diff preview
          var previewModal = document.getElementById('modal');
          var previewBody = document.getElementById('modalBody');
          var previewTitle = document.getElementById('modalTitle');
          previewTitle.textContent = '📜 版本预览 v' + versionId + ' — ' + filename;
          previewBody.innerHTML = '<div style="max-height:60vh;overflow:auto;background:var(--bg-secondary);padding:12px;border-radius:8px;font-family:monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;color:var(--text-secondary)">' + escapeHtmlClient(v.content) + '</div>';
          previewModal.classList.add('open');
        } else {
          showToast('此版本为二进制文件，无法预览', 'info');
        }
      } catch (e) { showToast('加载失败: ' + e.message, 'error'); }
    };

    window.restoreVersion = async function(filename, versionId) {
      if (!confirm('确认恢复到此版本？当前内容将作为新版本保存。')) return;
      try {
        var res = await fetch('/api/file-versions/' + encodeURIComponent(filename) + '/restore/' + versionId, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() } });
        var data = await res.json();
        if (data.success) {
          showToast('版本已恢复', 'success');
          openFileVersions(filename);
        } else { showToast(data.error || '恢复失败', 'error'); }
      } catch (e) { showToast('恢复失败: ' + e.message, 'error'); }
    };

    window.deleteVersion = async function(filename, versionId) {
      if (!confirm('确认删除此版本？')) return;
      try {
        var res = await fetch('/api/file-versions/' + encodeURIComponent(filename) + '/version/' + versionId, { method: 'DELETE', headers: headers() });
        var data = await res.json();
        if (data.success) { showToast('版本已删除', 'success'); openFileVersions(filename); }
        else { showToast(data.error || '删除失败', 'error'); }
      } catch (e) { showToast('删除失败: ' + e.message, 'error'); }
    };

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

        // Also fetch tag definitions (icons) in parallel
        const tagDefRes = await fetch('/api/folder-tags', { headers: headers() });
        const tagDefData = await tagDefRes.json();
        const tagDefMap = {};
        (tagDefData.tags || []).forEach(function(td) { tagDefMap[td.name] = td; });

        const tags = (data.tags || []).map(function(t) {
          t.icon = (tagDefMap[t.tag] && tagDefMap[t.tag].icon) || '';
          return t;
        });
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
            html += '<span style="font-size:14px;cursor:pointer" id="tagname_' + escapeHtmlClient(t.tag) + '" onclick="openTagIconPicker(\'' + escapeHtmlClient(t.tag).replace(/'/g, "\\'") + '\')" title="点击设置图标">' + (t.icon ? '<span style="font-size:15px">' + escapeHtmlClient(t.icon) + '</span> ' : '<span style="font-size:11px;color:var(--muted)">🏷</span> ') + escapeHtmlClient(t.tag) + '</span>';
            html += '<span style="font-size:11px;color:var(--muted);margin-left:6px">' + t.count + ' 个文件</span>';
            html += '</div>';
            html += '<div style="display:flex;gap:2px;align-items:center;flex-shrink:0">' + colorDot + '</div>';
            html += '<button onclick="openRenameTagModal(\'' + escapeHtmlClient(t.tag).replace(/'/g, "\\'") + '\')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:4px" title="重命名">✎</button>';
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
      openConfirmModal({
        title: '确定删除所有孤立标签？',
        text: '此操作不可撤销。',
        danger: true,
        onConfirm: async function() {
          const res = await fetch('/api/tags/orphans', { method: 'DELETE', headers: headers() });
          const data = await res.json();
          if (data.success) {
            showToast('已清理 ' + data.deleted + ' 个孤立标签', 'success');
            openTagManager();
          } else {
            showToast('清理失败: ' + (data.error || '未知错误'), 'error');
          }
        }
      });
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

    async function openTagIconPicker(tag) {
      const tagDefRes = await fetch('/api/folder-tags', { headers: headers() });
      const tagDefData = await tagDefRes.json();
      const tagDefs = tagDefData.tags || [];
      const td = tagDefs.find(function(t) { return t.name === tag; });
      const currentIcon = td && td.icon ? td.icon : '';
      const tagId = td && td.id ? td.id : null;
      const emojiList = ['🏷','📁','📂','🗂','📄','📝','📋','📌','📎','🗒','🗓','📅','📆','🗑','🏹','⚡','🔥','💡','🎯','⭐','🌟','💫','✨','💎','🔑','🗝','🔐','🔒','🔓','🛡','⚙️','🔧','🛠','🔩','⚙️','🎨','🎭','🎪','🎬','🎥','📷','🎙','🎚','🎛','🎵','🎶','📡','🌐','🗺','🧭','📍','📍','🗳','🗳️','📊','📈','📉','📉','📋','📑','🗃','🗄','💾','💿','📀','🎮','🕹','🎲','🧩','🃏','🀄','♟','♟️','🎰','🏆','🥇','🥈','🥉','🏅','🎖','🎗','🎫','🎟','🎭','🛒','💰','💵','💴','💶','💷','💸','💳','🧾','🏧','📱','💻','🖥','🖨','⌨️','🖱','🖲','💽','📠','📞','☎️','📟','📠','📺','📻','🧭','⏰','⏱','⏲','⏳','🕐','🕑','🕒','🕓','🕔','🕕','🕖','🕗','🕘','🕙','🕚','🕛','🌡','🌡️','🗺','🌍','🌎','🌏','🌐','🪐','☀️','🌤️','⛅','🌥','☁️','⛈','🌩','🌨','❄️','☃️','🌬','💨','🌪','🌫','🌙','🌛','🌜','🌚','🌝','🌞','🌅','🌄','🌇','🌆','🏙','🌃','🌉','🌌','🎠','🎡','🎢','🎡','🎪','🎭','🛖','🏕','⛺','🛤️','🛣','🗾','🗾','🏔','⛰','🌋','🗻','🏗','🏠','🏡','🏢','🏣','🏤','🏥','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕍','🕌','🛕','⛩','⛩️','🛤','🛢','💈','🔭','🔬','💊','💉','🩺','🩻','🏧','🦠','🧫','🧬','🧪','🧫','🧬','🧯','🧹','🧺','🧻','🚽','🚰','🚿','🛁','🛀','🧼','🪥','🪒','🧽','🪣','🧴','🛎','🔑','🗝','🔒','🔓','🔏','🔐','🔑','🗡','⚔','🛡','🔫','🎯','🏹','🪃','🛡','⚔','🗡','🪓','🪚','🪛','🔩','🧱','🧲','⚙️','🧱','🪜','🪚','🪛','🪜'];
      var html = '<div style="padding:8px 4px">';
      html += '<div style="text-align:center;font-size:13px;color:var(--muted);margin-bottom:12px">选择图标（点击确认）</div>';
      html += '<div style="display:grid;grid-template-columns:repeat(8,1fr);gap:4px;max-height:200px;overflow-y:auto;margin-bottom:12px">';
      emojiList.forEach(function(e) {
        var sel = currentIcon === e ? 'border-color:var(--primary);background:var(--bg-secondary)' : '';
        html += '<span onclick="setTagIcon(\'' + tag.replace(/'/g, "\\'") + '\',\'' + e.replace(/'/g, "\\'") + '\',' + (tagId || 'null') + ')" style="cursor:pointer;font-size:20px;text-align:center;padding:4px;border-radius:6px;border:2px solid transparent;' + sel + '">' + e + '</span>';
      });
      html += '</div>';
      html += '<div style="text-align:center"><button onclick="setTagIcon(\'' + tag.replace(/'/g, "\\'") + '\',\'\',' + (tagId || 'null') + ')" style="padding:6px 16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:12px;color:var(--muted)">清除图标</button></div>';
      html += '</div>';
      openModal('🏷 选择图标', html, '');
    }

    async function setTagIcon(tag, icon, tagId) {
      if (tagId) {
        var res = await fetch('/api/folder-tags/' + tagId, {
          method: 'PUT',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ icon: icon })
        });
        var data = await res.json();
        if (data.success) {
          closeModal();
          openTagManager();
        }
      } else {
        closeModal();
        openTagManager();
      }
    }

    async function deleteTag(tag) {
      openConfirmModal({
        title: '确定删除标签「' + tag + '」？',
        text: '该标签将从所有文件中移除。',
        danger: true,
        onConfirm: async function() {
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
      });
    }

    function openRenameTagModal(oldTag) {
      document.getElementById('modalTitle').textContent = '重命名标签';
      document.getElementById('modalBody').innerHTML =
        '<div style="padding:8px 0">' +
          '<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">将标签「<strong>' + escapeHtmlClient(oldTag) + '</strong>」重命名为：</p>' +
          '<input id="renameTagInput" type="text" value="' + escapeHtmlClient(oldTag) + '" ' +
            'style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg2);color:var(--text);font-size:14px;box-sizing:border-box" ' +
            'onkeydown="if(event.key===\'Enter\')confirmRenameTag(\'' + oldTag.replace(/'/g, "\\'") + '\');if(event.key===\'Escape\')forceCloseModal()">' +
        '</div>';
      var modal = document.getElementById('modal');
      modal.querySelector('.modal-actions').innerHTML =
        '<button class="secondary" onclick="forceCloseModal()">取消</button>' +
        '<button class="primary" onclick="confirmRenameTag(\'' + oldTag.replace(/'/g, "\\'") + '\')">确认</button>';
      modal.classList.add('open');
      setTimeout(function() { document.getElementById('renameTagInput').focus(); document.getElementById('renameTagInput').select(); }, 50);
    }

    async function confirmRenameTag(oldTag) {
      var input = document.getElementById('renameTagInput');
      var newTag = input && input.value.trim();
      if (!newTag || newTag === oldTag) { forceCloseModal(); return; }
      forceCloseModal();
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
      openConfirmModal({
        title: '删除 ' + filename + '？',
        danger: true,
        onConfirm: async function() {
          const res = await fetch('/api/files/' + encodeURIComponent(filename), { method: 'DELETE', headers: headers() });
          if (res.ok) {
            showToast('已删除', 'success');
            openDuplicates(); // refresh
          } else {
            showToast('删除失败', 'error');
          }
        }
      });
    }

    async function deleteSelectedDupes() {
      var names = Array.from(document.querySelectorAll('.dupe-check:checked')).map(function(el) { return el.getAttribute('data-name'); });
      if (!names.length) { showToast('请先选择文件', 'error'); return; }
      openConfirmModal({
        title: '删除 ' + names.length + ' 个重复文件？',
        danger: true,
        onConfirm: async function() {
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
      });
    }

    async function openFileActivity(filename) {
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '📊 ' + filename + ' - 访问记录';
      body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">加载中...</div>';
      modal.classList.add('open');

      try {
        var res = await fetch('/api/file-access-log/' + encodeURIComponent(filename) + '?limit=100', { headers: headers() });
        var data = await res.json();
        if (!data.success) throw new Error(data.error || '加载失败');

        var statsRes = await fetch('/api/file-access-stats/' + encodeURIComponent(filename), { headers: headers() });
        var statsData = await statsRes.json();
        var stats = statsData.stats || { view_count: 0, download_count: 0 };

        var logs = data.logs || [];
        var html = '<div style="display:flex;gap:16px;margin-bottom:16px">';
        html += '<div style="flex:1;padding:12px;background:var(--bg-secondary);border-radius:10px;text-align:center"><div style="font-size:22px;font-weight:700;color:var(--accent)">' + (stats.view_count || 0) + '</div><div style="font-size:12px;color:var(--muted)">浏览</div></div>';
        html += '<div style="flex:1;padding:12px;background:var(--bg-secondary);border-radius:10px;text-align:center"><div style="font-size:22px;font-weight:700;color:#10b981">' + (stats.download_count || 0) + '</div><div style="font-size:12px;color:var(--muted)">下载</div></div>';
        html += '</div>';

        if (!logs.length) {
          html += '<div style="text-align:center;padding:30px;color:var(--muted)">暂无访问记录</div>';
        } else {
          html += '<div style="max-height:55vh;overflow-y:auto">';
          logs.forEach(function(log) {
            var icon = log.action === 'view' ? '👁' : (log.action === 'download' ? '⬇' : '📝');
            var actionLabel = log.action === 'view' ? '浏览' : (log.action === 'download' ? '下载' : log.action);
            var time = new Date(log.timestamp * 1000).toLocaleString('zh-CN');
            var ip = log.ip || '—';
            html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">';
            html += '<span style="font-size:18px;flex-shrink:0">' + icon + '</span>';
            html += '<div style="flex:1">';
            html += '<div style="font-weight:500">' + actionLabel + '</div>';
            html += '<div style="font-size:11px;color:var(--muted)">' + time + ' · IP: ' + escapeHtmlClient(ip) + '</div>';
            html += '</div>';
            html += '</div>';
          });
          html += '</div>';
        }
        body.innerHTML = html;
      } catch (e) {
        body.innerHTML = '<p style="color:var(--error);padding:20px">' + escapeHtmlClient(e.message) + '</p>';
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
        var byFolder = data.byFolder || [];
        var topLargest = data.topLargest || [];
        var monthlyTrend = data.monthlyTrend || [];
        var dailyTrend = data.dailyTrend || [];
        var topAccessed = data.topAccessed || [];
        var activity = data.activity, shares = data.shares, devices = data.devices;
        var tokens = data.tokens, audit = data.audit;
        var sync = data.sync || {};
        var fmtSize = function(b) {
          if (b < 1024) return b + ' B';
          if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
          if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
          return (b/1073741824).toFixed(2) + ' GB';
        };
        var fmtSizeNum = function(b) {
          if (b < 1024) return b;
          if (b < 1048576) return Math.round(b/1024);
          if (b < 1073741824) return Math.round(b/1048576);
          return Math.round(b/1073741824 * 10) / 10;
        };

        // Clickable stat cards — navigate to filtered view
        var card = function(label, value, icon, action) {
          var cls = action ? 'cursor:pointer;border:1px solid transparent' : '';
          var extra = action ? ' onclick="' + action + '" title="' + action.replace(/"/g, '') + '"' : '';
          return '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px;text-align:center;' + cls + '"' + extra + '>' +
            '<div style="font-size:22px;margin-bottom:4px">' + icon + '</div>' +
            '<div style="font-size:20px;font-weight:700;color:var(--text)">' + escapeHtmlClient('' + value) + '</div>' +
            '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + label + '</div></div>';
        };
        var cards = [
          { label: '\u6587\u4EF6\u603B\u6570', value: files.total, icon: '\uD83D\uDCC4', action: '' },
          { label: '\u5B58\u50A8\u7528\u91CF', value: fmtSize(storage.total), icon: '\uD83D\uDCBE', action: '' },
          { label: '\u4ECA\u65E5\u65B0\u589E', value: activity.today, icon: '\uD83D\uDCC8', action: '' },
          { label: '\u672C\u5468\u65B0\u589E', value: activity.week, icon: '\uD83D\uDCC5', action: '' },
          { label: '\u6D3B\u8DC3\u5206\u4EAB', value: shares.active, icon: '\uD83D\uDD17', action: '' },
          { label: '\u5728\u7EBF\u8BBE\u5907', value: devices.online + '/' + devices.total, icon: '\uD83D\uDCF1', action: '' },
        ];
        var html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px">';
        for (var ci = 0; ci < cards.length; ci++) {
          var c = cards[ci];
          html += card(c.label, c.value, c.icon, c.action);
        }
        html += '</div>';

        // Row 2: File type + extension
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
            html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer" onclick="forceCloseModal();setTypeFilter(\'' + escapeHtmlClient(r.type || '').replace(/'/g, "\\'") + '\')" title="\u7B5B\u9009\u6B64\u7C7B\u6587\u4EF6">';
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
            html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer" onclick="forceCloseModal();filterByExt(\'' + escapeHtmlClient(er.ext || '').replace(/'/g, "\\'") + '\')" title="\u7B5B\u9009 .' + escapeHtmlClient(er.ext || '') + ' \u6587\u4EF6">';
            html += '<div style="width:40px;font-size:11px;color:var(--muted);flex-shrink:0">.' + escapeHtmlClient(er.ext || 'none') + '</div>';
            html += '<div style="flex:1;height:6px;background:var(--bg-tertiary);border-radius:3px">';
            html += '<div style="height:6px;width:' + epct + '%;background:var(--accent);border-radius:3px;opacity:0.7"></div></div>';
            html += '<div style="font-size:11px;color:var(--muted);width:28px;text-align:right">' + er.count + '</div></div>';
          }
        } else {
          html += '<div style="color:var(--muted);font-size:12px">\u6682\u65E0\u6570\u636E</div>';
        }
        html += '</div></div>';

        // Row 3: VF storage + Top largest files
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px">';
        html += '<div style="font-weight:600;margin-bottom:12px;font-size:13px">\uD83D\uDCC2 \u865A\u62DF\u6587\u4EF6\u5939\u5B58\u50A8</div>';
        if (byFolder && byFolder.length) {
          var maxFolderSize = byFolder[0] ? byFolder[0].size : 1;
          byFolder.forEach(function(f) {
            var fpct = maxFolderSize > 0 ? Math.round(f.size / maxFolderSize * 100) : 0;
            var color = f.color || '#6366f1';
            html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer" onclick="forceCloseModal();navigateVirtualFolder(\'' + escapeHtmlClient(f.name || '').replace(/'/g, "\\'") + '\')" title="' + escapeHtmlClient(f.name) + ': ' + fmtSize(f.size) + '">';
            html += '<div style="width:10px;height:10px;border-radius:50%;background:' + color + ';flex-shrink:0"></div>';
            html += '<div style="flex:1;font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtmlClient(f.name) + '</div>';
            html += '<div style="font-size:11px;color:var(--muted)">' + f.file_count + '\u4E2A</div>';
            html += '<div style="font-size:11px;color:var(--muted);width:60px;text-align:right">' + fmtSize(f.size) + '</div></div>';
            html += '<div style="height:4px;background:var(--bg-tertiary);border-radius:4px;margin-bottom:8px">';
            html += '<div style="height:4px;width:' + fpct + '%;background:' + color + ';border-radius:4px"></div></div>';
          });
        } else {
          html += '<div style="color:var(--muted);font-size:12px">\u6682\u65E0\u865A\u62DF\u6587\u4EF6\u5939</div>';
        }
        html += '</div>';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px">';
        html += '<div style="font-weight:600;margin-bottom:12px;font-size:13px">\uD83D\uDCDD \u6700\u5927\u6587\u4EF6 TOP 10</div>';
        if (topLargest && topLargest.length) {
          topLargest.forEach(function(f, i) {
            var sizeLabel = fmtSize(f.size);
            var barW = topLargest[0] && topLargest[0].size > 0 ? Math.round(f.size / topLargest[0].size * 100) : 0;
            html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer" onclick="forceCloseModal();previewFile(\'' + escapeHtmlClient(encodeURIComponent(f.filename || '')).replace(/'/g, "\\'") + '\')" title="' + escapeHtmlClient(f.filename) + ' - ' + sizeLabel + '">';
            html += '<div style="font-size:10px;color:var(--muted);width:16px;flex-shrink:0;text-align:right">' + (i + 1) + '</div>';
            html += '<div style="flex:1;font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtmlClient(f.filename) + '</div>';
            html += '<div style="font-size:11px;color:var(--muted);width:56px;text-align:right;flex-shrink:0">' + sizeLabel + '</div></div>';
            html += '<div style="height:3px;background:var(--bg-tertiary);border-radius:3px;margin-bottom:8px;padding-left:24px">';
            html += '<div style="height:3px;width:' + barW + '%;background:#f59e0b;border-radius:3px"></div></div>';
          });
        } else {
          html += '<div style="color:var(--muted);font-size:12px">\u6682\u65E0\u6570\u636E</div>';
        }
        html += '</div></div>';

        // Row 4: Daily trend (7 days, added + deleted bars) + Hot files TOP 10
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px">';
        html += '<div style="font-weight:600;margin-bottom:14px;font-size:13px">📅 近7天每日趋势</div>';
        if (dailyTrend && dailyTrend.length) {
          var maxDaily = Math.max.apply(null, dailyTrend.map(function(d) { return Math.max(d.added, d.deleted); }).concat([1]));
          html += '<div style="display:flex;align-items:flex-end;gap:6px;height:80px">';
          dailyTrend.forEach(function(w) {
            var addedH = Math.max(Math.round(w.added / maxDaily * 60), w.added > 0 ? 4 : 1);
            var delH = Math.max(Math.round(w.deleted / maxDaily * 60), w.deleted > 0 ? 4 : 1);
            html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:0;height:100%;justify-content:flex-end">';
            html += '<div style="width:100%;display:flex;flex-direction:column;align-items:center;gap:1px">';
            html += '<div style="font-size:9px;color:var(--muted)">' + w.added + '</div>';
            html += '<div style="width:100%;height:' + addedH + 'px;background:#10b981;border-radius:2px 2px 0 0;opacity:0.85"></div>';
            html += '<div style="width:100%;height:' + delH + 'px;background:#ef4444;border-radius:0 0 2px 2px;opacity:0.85"></div>';
            html += '</div>';
            html += '<div style="font-size:9px;color:var(--muted);margin-top:3px">' + escapeHtmlClient(w.label) + '</div></div>';
          });
          html += '</div>';
          html += '<div style="display:flex;gap:12px;margin-top:8px;justify-content:center">';
          html += '<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)"><div style="width:8px;height:8px;border-radius:2px;background:#10b981"></div>新增</div>';
          html += '<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)"><div style="width:8px;height:8px;border-radius:2px;background:#ef4444"></div>删除</div>';
          html += '</div>';
        } else {
          html += '<div style="color:var(--muted);font-size:12px">暂无数据</div>';
        }
        html += '</div>';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px">';
        html += '<div style="font-weight:600;margin-bottom:12px;font-size:13px">🔥 热门文件 TOP 10</div>';
        if (topAccessed && topAccessed.length) {
          var maxAccess = topAccessed[0] && topAccessed[0].access_count > 0 ? topAccessed[0].access_count : 1;
          for (var ai = 0; ai < topAccessed.length; ai++) {
            var af = topAccessed[ai];
            if (!af.filename) continue;
            var apct = Math.round(af.access_count / maxAccess * 100);
            var lastStr = af.last_access ? new Date(af.last_access * 1000).toLocaleDateString('zh-CN', {month:'numeric',day:'numeric'}) : '-';
            html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer" onclick="forceCloseModal();previewFile(\'' + escapeHtmlClient(encodeURIComponent(af.filename || '')).replace(/'/g, "\\'") + '\')" title="访问' + af.access_count + '次 | 查看' + (af.view_count||0) + ' | 下载' + (af.download_count||0) + ' | 上次' + lastStr + '">';
            html += '<div style="font-size:10px;color:var(--muted);width:16px;flex-shrink:0;text-align:right">' + (ai + 1) + '</div>';
            html += '<div style="flex:1;font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtmlClient(af.filename) + '</div>';
            html += '<div style="font-size:10px;color:var(--muted);flex-shrink:0">' + af.access_count + '</div>';
            html += '</div>';
            html += '<div style="height:3px;background:var(--bg-tertiary);border-radius:3px;margin-bottom:8px;padding-left:24px">';
            html += '<div style="height:3px;width:' + apct + '%;background:#f97316;border-radius:3px"></div></div>';
          }
        } else {
          html += '<div style="color:var(--muted);font-size:12px">暂无访问数据</div>';
        }
        html += '</div></div>';

        // Row 5: Weekly trend + System stats
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px">';
        html += '<div style="font-weight:600;margin-bottom:14px;font-size:13px">📊 近4周每周趋势</div>';
        if (monthlyTrend && monthlyTrend.length) {
          var maxAdded = Math.max.apply(null, monthlyTrend.map(function(d) { return d.added; }).concat([1]));
          html += '<div style="display:flex;align-items:flex-end;gap:8px;height:80px">';
          monthlyTrend.forEach(function(w) {
            var addedH = Math.max(Math.round(w.added / maxAdded * 60), w.added > 0 ? 4 : 1);
            html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">';
            html += '<div style="font-size:10px;color:var(--muted)">' + w.added + '</div>';
            html += '<div style="width:100%;height:' + addedH + 'px;background:#10b981;border-radius:3px 3px 0 0;opacity:0.8"></div>';
            html += '<div style="font-size:9px;color:var(--muted)">' + escapeHtmlClient(w.label) + '</div></div>';
          });
          html += '</div>';
          html += '<div style="display:flex;gap:12px;margin-top:8px;justify-content:center">';
          html += '<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)"><div style="width:8px;height:8px;border-radius:2px;background:#10b981"></div>新增</div>';
          html += '<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)"><div style="width:8px;height:8px;border-radius:2px;background:#ef4444"></div>删除</div>';
          html += '</div>';
        } else {
          html += '<div style="color:var(--muted);font-size:12px">暂无数据</div>';
        }
        html += '</div>';
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px">';
        html += '<div style="font-weight:600;margin-bottom:14px;font-size:13px">📊 系统状态</div>';
        var lastSyncStr = sync.lastSync ? new Date(sync.lastSync * 1000).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '从未';
        var sysItems = [
          { label: '文本文件', value: files.text },
          { label: '二进制文件', value: files.binary },
          { label: '星标文件', value: files.starred },
          { label: '回收站', value: files.trash },
          { label: '总分享数', value: shares.total },
          { label: '密码保护', value: shares.withPassword },
          { label: '未同步项', value: sync.unsynced || 0 },
          { label: '未同步大小', value: fmtSize(sync.unsyncedSize || 0) },
          { label: '今日同步', value: sync.todaySyncLogs || 0 },
          { label: '上次同步', value: lastSyncStr },
          { label: 'Token 总数', value: tokens.total },
          { label: 'Token 活跃', value: tokens.active },
          { label: '审计日志', value: audit.total },
          { label: '今日审计', value: audit.today },
        ];
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">';
        for (var si = 0; si < sysItems.length; si++) {
          var s = sysItems[si];
          html += '<div style="display:flex;justify-content:space-between;padding:7px 10px;background:var(--bg-tertiary);border-radius:6px;font-size:12px">';
          html += '<span style="color:var(--muted)">' + s.label + '</span>';
          html += '<span style="font-weight:600;color:var(--text)">' + escapeHtmlClient('' + s.value) + '</span></div>';
        }
        html += '</div></div></div>';

        // Row 6: Share link analytics
        html += '<div style="background:var(--bg-secondary);padding:14px;border-radius:12px;margin-bottom:20px">';
        html += '<div style="font-weight:600;margin-bottom:14px;font-size:13px">📊 分享分析</div>';
        var shareMetricItems = [
          { label: '总浏览', value: shareAnalytics.totalViews },
          { label: '总下载', value: shareAnalytics.totalDownloads },
          { label: '今日浏览', value: shareAnalytics.todayViews },
          { label: '本周下载', value: shareAnalytics.weekDownloads },
        ];
        html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:16px">';
        for (var smi = 0; smi < shareMetricItems.length; smi++) {
          var sm = shareMetricItems[smi];
          html += '<div style="background:var(--bg-tertiary);padding:10px 12px;border-radius:8px;text-align:center">';
          html += '<div style="font-size:18px;font-weight:700;color:var(--text)">' + escapeHtmlClient('' + (sm.value || 0)) + '</div>';
          html += '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + escapeHtmlClient(sm.label) + '</div></div>';
        }
        html += '</div>';
        html += '<div style="font-weight:600;margin-bottom:10px;font-size:12px">🔥 热门分享 TOP 10</div>';
        if (shareAnalytics.topLinks && shareAnalytics.topLinks.length) {
          html += '<div style="display:grid;grid-template-columns:1fr 60px 60px 80px;gap:4px;font-size:11px;color:var(--muted);padding:0 4px 6px;border-bottom:1px solid var(--bg-tertiary);margin-bottom:4px">';
          html += '<div>文件名</div><div style="text-align:right">浏览</div><div style="text-align:right">下载</div><div style="text-align:right">总计</div></div>';
          for (var sli = 0; sli < shareAnalytics.topLinks.length; sli++) {
            var sl = shareAnalytics.topLinks[sli];
            var slTotal = (sl.view_count || 0) + (sl.download_count || 0);
            html += '<div style="display:grid;grid-template-columns:1fr 60px 60px 80px;gap:4px;font-size:12px;padding:5px 4px;align-items:center;border-bottom:1px solid var(--bg-tertiary)">';
            html += '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)" title="' + escapeHtmlClient(sl.filename || '') + '">' + escapeHtmlClient(sl.filename || '') + '</div>';
            html += '<div style="text-align:right;color:var(--muted)">' + (sl.view_count || 0) + '</div>';
            html += '<div style="text-align:right;color:var(--muted)">' + (sl.download_count || 0) + '</div>';
            html += '<div style="text-align:right;font-weight:600;color:var(--text)">' + slTotal + '</div></div>';
          }
        } else {
          html += '<div style="color:var(--muted);font-size:12px;text-align:center;padding:8px">暂无分享数据</div>';
        }
        html += '</div>';

        var targetEl = document.getElementById('dashboardContent');
        if (targetEl) targetEl.innerHTML = html;
      } catch (e) {
        var errEl = document.getElementById('dashboardContent');
        if (errEl) errEl.innerHTML = '<div style="color:var(--error);padding:12px">\u52A0\u8F7D\u5931\u8D25: ' + escapeHtmlClient(e.message) + '</div>';
      }
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
        const totalSize = (data.totalSize || 0);
        const totalSizeStr = totalSize > 1024 * 1024 * 1024 ? (Math.round(totalSize / 1024 / 1024 / 1024 * 10) / 10 + ' GB') : totalSize > 1024 * 1024 ? (Math.round(totalSize / 1024 / 1024) + ' MB') : (Math.round(totalSize / 1024) + ' KB');

        let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap">';
        html += '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">';
        html += '<div style="font-size:13px;color:var(--muted)">共 <strong id="trashCount">' + items.length + '</strong> 个文件';
        if (totalSize > 0) html += ' <span style="color:var(--text-muted)">(' + totalSizeStr + ')</span>';
        if (expiredCount > 0) html += '（<span style="color:var(--warning)">' + expiredCount + ' 个已过期</span>）';
        html += '</div>';
        html += '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer;user-select:none">';
        html += '<input type="checkbox" id="trashSelectAll" onchange="toggleTrashSelectAll()" style="width:16px;height:16px;cursor:pointer">全选';
        html += '</label>';
        html += '<select id="trashSortSelect" onchange="sortTrashItems()" style="padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);font-size:12px">';
        html += '<option value="deleted_at">按删除时间</option>';
        html += '<option value="filename">按名称</option>';
        html += '<option value="size">按大小</option>';
        html += '</select>';
        html += '</div>';
        html += '<div style="display:flex;gap:8px;align-items:center">';
        html += '<input id="trashSearchInput" type="text" placeholder="搜索回收站文件..." oninput="filterTrashItems()" style="flex:1;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg-secondary);color:var(--text);font-size:13px;max-width:200px">';
        html += '<button id="trashBatchRestore" onclick="batchRestoreTrash()" disabled style="padding:6px 14px;font-size:12px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer;opacity:0.5">恢复(<span id="trashRestoreCount">0</span>)</button>';
        html += '<button id="trashBatchDelete" onclick="batchPermanentDeleteTrash()" disabled style="padding:6px 14px;font-size:12px;background:var(--error);color:#fff;border:none;border-radius:6px;cursor:pointer;opacity:0.5">彻底删除(<span id="trashDeleteCount">0</span>)</button>';
        html += '<button class="danger" onclick="confirmEmptyTrash()" style="padding:6px 14px;font-size:12px;font-weight:600" ' + (items.length === 0 ? 'disabled' : '') + '>🗑️ 清空回收站</button>';
        html += '</div>';
        html += '</div>';
        window._trashItems = items;

        html += '<div id="trashItemsContainer">';
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
        html += '</div>'; // close trashItemsContainer

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
      var m = document.getElementById('confirmBatchDeleteModal');
      if (m) m.remove();
      m = document.createElement('div');
      m.id = 'confirmBatchDeleteModal';
      m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10002;display:flex;align-items:center;justify-content:center;padding:20px';
      m.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:380px;font-size:14px;text-align:center">\
          <div style="font-size:40px;margin-bottom:12px">⚠️</div>\
          <h3 style="margin:0 0 8px">彻底删除 ' + ids.length + ' 个文件？</h3>\
          <p style="margin:0 0 20px;font-size:13px;color:var(--muted)">此操作不可恢复，确定要彻底删除吗？</p>\
          <div style="display:flex;gap:10px;justify-content:center">\
            <button class="secondary" onclick="document.getElementById(\'confirmBatchDeleteModal\').remove()">取消</button>\
            <button class="danger" onclick="doBatchPermanentDeleteTrash()">确认删除</button>\
          </div>\
        </div>';
      document.body.appendChild(m);
      m.addEventListener('click', function(e) { if (e.target === m) m.remove(); });
      window._pendingBatchDeleteTrash = ids;
    }

    async function doBatchPermanentDeleteTrash() {
      var ids = window._pendingBatchDeleteTrash || [];
      if (!ids.length) return;
      var m = document.getElementById('confirmBatchDeleteModal');
      if (m) m.remove();
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
      var m = document.getElementById('confirmDeleteModal');
      if (m) m.remove();
      m = document.createElement('div');
      m.id = 'confirmDeleteModal';
      m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10002;display:flex;align-items:center;justify-content:center;padding:20px';
      m.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:380px;font-size:14px;text-align:center">\
          <div style="font-size:40px;margin-bottom:12px">⚠️</div>\
          <h3 style="margin:0 0 8px">彻底删除文件？</h3>\
          <p style="margin:0 0 20px;font-size:13px;color:var(--muted)">此操作不可恢复，确定要彻底删除吗？</p>\
          <div style="display:flex;gap:10px;justify-content:center">\
            <button class="secondary" onclick="document.getElementById(\'confirmDeleteModal\').remove()">取消</button>\
            <button class="danger" onclick="doPermanentDeleteTrash(' + trashId + ')">确认删除</button>\
          </div>\
        </div>';
      document.body.appendChild(m);
      m.addEventListener('click', function(e) { if (e.target === m) m.remove(); });
      window._pendingDeleteTrashId = trashId;
    }

    async function doPermanentDeleteTrash(trashId) {
      var m = document.getElementById('confirmDeleteModal');
      if (m) m.remove();
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

    async function confirmEmptyTrash() {
      const count = document.getElementById('trashCount') ? document.getElementById('trashCount').textContent : '所有';
      var m = document.getElementById('confirmEmptyTrashModal');
      if (m) m.remove();
      m = document.createElement('div');
      m.id = 'confirmEmptyTrashModal';
      m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10002;display:flex;align-items:center;justify-content:center;padding:20px';
      m.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:400px;font-size:14px;text-align:center">\
          <div style="font-size:40px;margin-bottom:12px">🗑️</div>\
          <h3 style="margin:0 0 8px">确定清空回收站？</h3>\
          <p style="margin:0 0 20px;font-size:13px;color:var(--muted)"><strong>' + count + '</strong> 个文件将被永久删除，此操作不可恢复。</p>\
          <div style="display:flex;gap:10px;justify-content:center">\
            <button class="secondary" onclick="document.getElementById(\'confirmEmptyTrashModal\').remove()">取消</button>\
            <button class="danger" onclick="doEmptyTrash()">确认清空</button>\
          </div>\
        </div>';
      document.body.appendChild(m);
      m.addEventListener('click', function(e) { if (e.target === m) m.remove(); });
    }

    async function doEmptyTrash() {
      var m = document.getElementById('confirmEmptyTrashModal');
      if (m) m.remove();
      try {
        const res = await fetch('/api/trash/empty', { method: 'POST', headers: headers() });
        const data = await res.json();
        if (data.success) {
          showToast('回收站已清空', 'success');
          closeModal();
          loadFiles();
        } else {
          showToast('清空失败: ' + (data.error || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('清空失败: ' + e.message, 'error');
      }
    }

    function filterTrashItems() {
      var q = (document.getElementById('trashSearchInput') && document.getElementById('trashSearchInput').value || '').trim().toLowerCase();
      var sortBy = document.getElementById('trashSortSelect') && document.getElementById('trashSortSelect').value;
      var container = document.getElementById('trashItemsContainer');
      if (!container) return;
      var items = window._trashItems || [];
      var filtered = q ? items.filter(function(item) {
        return (item.filename && item.filename.toLowerCase().includes(q));
      }) : items;
      var sortFn;
      if (sortBy === 'filename') {
        sortFn = function(a, b) { return (a.filename || '').localeCompare(b.filename || ''); };
      } else if (sortBy === 'size') {
        sortFn = function(a, b) { return (b.size || 0) - (a.size || 0); };
      } else {
        sortFn = function(a, b) { return (b.deleted_at || 0) - (a.deleted_at || 0); };
      }
      filtered.sort(sortFn);
      var html = '';
      if (filtered.length === 0) {
        html = '<div style="text-align:center;color:var(--muted);padding:30px">没有找到匹配的文件</div>';
      } else {
        filtered.forEach(function(item) {
          var fid = 'trash-item-' + item.id;
          var deletedAt = new Date(item.deleted_at * 1000).toLocaleString('zh-CN');
          var sizeStr = formatFileSize(item.size || 0);
          var expiredInfo = item.expires_at ? ('（' + Math.max(0, Math.ceil((item.expires_at * 1000 - Date.now()) / 86400000)) + ' 天后永久删除）') : '';
          var checked = selectedTrashItems.has(item.id) ? 'checked' : '';
          html += '<div id="' + fid + '" class="trash-item" style="display:flex;align-items:center;padding:10px 12px;gap:10px;border-bottom:1px solid var(--line)">';
          html += '<input type="checkbox" class="trash-check" data-id="' + item.id + '" style="width:16px;height:16px;cursor:pointer;flex-shrink:0" ' + checked + ' onchange="toggleTrashItem(this)">';
          html += '<span style="font-size:18px;flex-shrink:0">' + getFileIcon(item.filename) + '</span>';
          html += '<div style="flex:1;min-width:0">';
          html += '<div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtmlClient(item.filename) + '">' + escapeHtmlClient(item.filename) + '</div>';
          html += '<div style="font-size:11px;color:var(--muted)">' + sizeStr + ' · ' + deletedAt + ' ' + expiredInfo + '</div>';
          html += '</div>';
          html += '<button onclick="restoreTrashItem(' + item.id + ')" style="padding:4px 10px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px">恢复</button>';
          html += '<button onclick="permanentDeleteTrashItem(' + item.id + ')" style="padding:4px 10px;background:var(--error);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px">删除</button>';
          html += '</div>';
        });
      }
      container.innerHTML = html;
      updateTrashBatchButtons();
    }

    function toggleTrashItem(el) {
      var id = parseInt(el.getAttribute('data-id'), 10);
      if (!id) return;
      if (el.checked) selectedTrashItems.add(id);
      else selectedTrashItems.delete(id);
      updateTrashBatchButtons();
    }

    function updateTrashBatchButtons() {
      var count = selectedTrashItems.size;
      var restoreBtn = document.getElementById('trashBatchRestore');
      var deleteBtn = document.getElementById('trashBatchDelete');
      var selectAll = document.getElementById('trashSelectAll');
      if (restoreBtn) {
        restoreBtn.disabled = count === 0;
        restoreBtn.style.opacity = count === 0 ? '0.5' : '1';
        var span = restoreBtn.querySelector('span');
        if (span) span.textContent = count;
      }
      if (deleteBtn) {
        deleteBtn.disabled = count === 0;
        deleteBtn.style.opacity = count === 0 ? '0.5' : '1';
        var span = deleteBtn.querySelector('span');
        if (span) span.textContent = count;
      }
      var checkedCount = document.querySelectorAll('.trash-check:checked').length;
      var totalCount = document.querySelectorAll('.trash-check').length;
      if (selectAll) selectAll.checked = totalCount > 0 && checkedCount === totalCount;
    }

    function sortTrashItems() {
      var container = document.getElementById('trashItemsContainer');
      var sortBy = document.getElementById('trashSortSelect') && document.getElementById('trashSortSelect').value;
      if (!container) return;
      var items = Array.from(container.querySelectorAll('[id^="trash-item-"]'));
      items.sort(function(a, b) {
        var idA = parseInt(a.id.replace('trash-item-', ''));
        var idB = parseInt(b.id.replace('trash-item-', ''));
        // Get data from DOM
        var textA = a.querySelector('[style*="overflow"]') && a.querySelector('[style*="overflow"]').textContent || '';
        var textB = b.querySelector('[style*="overflow"]') && b.querySelector('[style*="overflow"]').textContent || '';
        var sizeA = 0, sizeB = 0;
        var sizeMatchA = (a.textContent.match(/[\d.]+\s*(KB|MB|GB)/) || [''])[0];
        var sizeMatchB = (b.textContent.match(/[\d.]+\s*(KB|MB|GB)/) || [''])[0];
        if (sortBy === 'filename') return textA.localeCompare(textB);
        if (sortBy === 'size') {
          sizeA = parseFloat(sizeMatchA) * (sizeMatchA.includes('GB') ? 1024 * 1024 : sizeMatchA.includes('MB') ? 1024 : 1);
          sizeB = parseFloat(sizeMatchB) * (sizeMatchB.includes('GB') ? 1024 * 1024 : sizeMatchB.includes('MB') ? 1024 : 1);
          return sizeB - sizeA; // largest first
        }
        return idB - idA; // default: newest deleted first (higher id = newer)
      });
      items.forEach(function(item) { container.appendChild(item); });
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
          <p id="shareCreateFileName" style="font-size:13px;color:var(--muted);margin-bottom:12px;word-break:break-all"></p>\
          <div id="shareTemplateRow" style="margin-bottom:12px;display:none">\
            <div style="display:flex;gap:6px;align-items:center">\
              <select id="shareTemplateSelect" onchange="applyShareTemplate(this.value)" style="flex:1;padding:7px;border:1px solid var(--line);border-radius:8px;font-size:13px;background:var(--bg)">\
                <option value="">— 选择模板（可选）—</option>\
              </select>\
              <button type="button" onclick="openSaveShareTemplateModal()" style="padding:6px 12px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:8px;cursor:pointer;font-size:12px;white-space:nowrap">💾 保存模板</button>\
            </div>\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">有效期</label>\
            <div style="display:flex;gap:6px;align-items:center">\
              <select id="shareExpirySelect" onchange="toggleShareCustomExpiry(this.value)" style="flex:1;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:var(--bg)">\
                <option value="24">24 小时</option>\
                <option value="48">48 小时</option>\
                <option value="168" selected>7 天（推荐）</option>\
                <option value="336">14 天</option>\
                <option value="720">30 天</option>\
                <option value="custom">自定义日期</option>\
                <option value="0">永不过期</option>\
              </select>\
              <input id="shareCustomExpiry" type="datetime-local" style="flex:1;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:var(--bg);display:none">\
            </div>\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">访问密码（可选）</label>\
            <input id="sharePasswordInput" type="text" placeholder="留空则无需密码" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px;box-sizing:border-box">\
          </div>\
          <div style="margin-bottom:16px">\
            <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">最大下载次数（可选）</label>\
            <input id="shareMaxDlInput" type="number" min="1" placeholder="无限制" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:14px;box-sizing:border-box">\
          </div>\
          <details style="margin-bottom:12px;border:1px solid var(--line);border-radius:10px;padding:10px 12px">\
            <summary style="cursor:pointer;font-size:13px;color:var(--muted);user-select:none">🎨 自定义外观（可选）</summary>\
            <div style="margin-top:10px">\
              <div style="margin-bottom:8px">\
                <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">背景颜色</label>\
                <input id="shareThemeBg" type="color" value="#f6f7fb" style="width:48px;height:32px;border-radius:6px;border:1px solid var(--line);cursor:pointer;vertical-align:middle">\
                <span style="font-size:12px;color:var(--muted);margin-left:6px">或输入色值</span>\
                <input id="shareThemeBgHex" type="text" placeholder="#f6f7fb" style="width:80px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;font-size:12px;margin-left:4px">\
              </div>\
              <div style="margin-bottom:8px">\
                <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">主题颜色（按钮/文字）</label>\
                <input id="shareThemeColor" type="color" value="#111827" style="width:48px;height:32px;border-radius:6px;border:1px solid var(--line);cursor:pointer;vertical-align:middle">\
                <input id="shareThemeColorHex" type="text" placeholder="#111827" style="width:80px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;font-size:12px;margin-left:4px">\
              </div>\
              <div>\
                <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">品牌文字（页脚显示）</label>\
                <input id="shareBrandText" type="text" placeholder="例如：© 2024 我的公司" maxlength="80" style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;font-size:12px;box-sizing:border-box">\
              </div>\
            </div>\
          </details>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'shareCreateModal\').remove()">取消</button>\
            <button onclick="confirmShareCreate(\'' + filename.replace(/'/g, "\\'") + '\')" id="shareCreateBtn">创建并复制链接</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      document.getElementById('shareCreateFileName').textContent = filename;
      // Load share templates into dropdown
      loadShareTemplates();
      // Focus password field for quick entry
      document.getElementById('sharePasswordInput').focus();
    }

    function toggleShareCustomExpiry(val) {
      var input = document.getElementById('shareCustomExpiry');
      if (!input) return;
      input.style.display = val === 'custom' ? 'block' : 'none';
      if (val === 'custom') setTimeout(function() { input.focus(); }, 50);
    }

    // Share Link Templates
    var _shareTemplates = null;

    function getShareTemplates() {
      try {
        return JSON.parse(localStorage.getItem('st_share_templates') || '[]');
      } catch(e) { return []; }
    }

    function saveShareTemplates(templates) {
      localStorage.setItem('st_share_templates', JSON.stringify(templates));
      _shareTemplates = templates;
    }

    function loadShareTemplates() {
      var sel = document.getElementById('shareTemplateSelect');
      if (!sel) return;
      _shareTemplates = getShareTemplates();
      var currentExpiry = document.getElementById('shareExpirySelect') ? document.getElementById('shareExpirySelect').value : '';
      var currentPwd = document.getElementById('sharePasswordInput') ? document.getElementById('sharePasswordInput').value.trim() : '';
      var currentMaxDl = document.getElementById('shareMaxDlInput') ? document.getElementById('shareMaxDlInput').value.trim() : '';
      var currentBg = document.getElementById('shareThemeBgHex') ? document.getElementById('shareThemeBgHex').value.trim() : '';
      var currentColor = document.getElementById('shareThemeColorHex') ? document.getElementById('shareThemeColorHex').value.trim() : '';
      var currentBrand = document.getElementById('shareBrandText') ? document.getElementById('shareBrandText').value.trim() : '';
      sel.innerHTML = '<option value="">— 选择模板（可选）—</option>';
      _shareTemplates.forEach(function(t, i) {
        var label = t.name + (t.expiryHours ? ' · ' + t.expiryHours + 'h' : '') + (t.password ? ' · 🔒' : '');
        sel.innerHTML += '<option value="' + i + '">' + label + '</option>';
      });
    }

    function applyShareTemplate(idx) {
      if (idx === '' || _shareTemplates === null) return;
      var t = _shareTemplates[parseInt(idx, 10)];
      if (!t) return;
      if (document.getElementById('shareExpirySelect')) {
        document.getElementById('shareExpirySelect').value = t.expiryHours !== undefined ? String(t.expiryHours) : '0';
        toggleShareCustomExpiry(String(t.expiryHours || 0));
      }
      if (document.getElementById('sharePasswordInput')) document.getElementById('sharePasswordInput').value = t.password || '';
      if (document.getElementById('shareMaxDlInput')) document.getElementById('shareMaxDlInput').value = t.maxDownloads || '';
      if (document.getElementById('shareThemeBgHex')) document.getElementById('shareThemeBgHex').value = t.themeBg || '';
      if (document.getElementById('shareThemeBg')) document.getElementById('shareThemeBg').value = t.themeBg || '#f6f7fb';
      if (document.getElementById('shareThemeColorHex')) document.getElementById('shareThemeColorHex').value = t.themeColor || '';
      if (document.getElementById('shareThemeColor')) document.getElementById('shareThemeColor').value = t.themeColor || '#111827';
      if (document.getElementById('shareBrandText')) document.getElementById('shareBrandText').value = t.brandText || '';
      showToast('已应用模板: ' + t.name, 'success');
    }

    function openSaveShareTemplateModal() {
      var name = prompt('输入模板名称:', '我的模板');
      if (!name || !name.trim()) return;
      name = name.trim();
      var expiryHours = document.getElementById('shareExpirySelect') ? parseInt(document.getElementById('shareExpirySelect').value, 10) : 168;
      var password = document.getElementById('sharePasswordInput') ? document.getElementById('sharePasswordInput').value.trim() : '';
      var maxDownloads = document.getElementById('shareMaxDlInput') ? document.getElementById('shareMaxDlInput').value.trim() : '';
      var themeBg = document.getElementById('shareThemeBgHex') ? document.getElementById('shareThemeBgHex').value.trim() : '';
      var themeColor = document.getElementById('shareThemeColorHex') ? document.getElementById('shareThemeColorHex').value.trim() : '';
      var brandText = document.getElementById('shareBrandText') ? document.getElementById('shareBrandText').value.trim() : '';
      var templates = getShareTemplates();
      templates.push({ name: name, expiryHours: expiryHours, password: password, maxDownloads: maxDownloads, themeBg: themeBg, themeColor: themeColor, brandText: brandText });
      saveShareTemplates(templates);
      loadShareTemplates();
      showToast('模板已保存: ' + name, 'success');
    }

    function loadShareTemplatesSettings() {
      var container = document.getElementById('shareTemplatesList');
      if (!container) return;
      var templates = getShareTemplates();
      if (!templates.length) {
        container.innerHTML = '<span style="font-size:12px;color:var(--muted)">暂无模板，在创建分享时💾保存模板</span>';
        return;
      }
      var html = '<div style="display:flex;flex-direction:column;gap:4px">';
      templates.forEach(function(t, i) {
        var expiryStr = t.expiryHours > 0 ? t.expiryHours + '小时' : '永不过期';
        var pwdStr = t.password ? ' · 🔒' : '';
        html += '<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;border-bottom:1px solid var(--line)">' +
          '<span style="flex:1">' + escapeHtmlClient(t.name) + ' <span style="color:var(--muted)">(' + expiryStr + pwdStr + ')</span></span>' +
          '<button onclick="deleteShareTemplate(' + i + ')" style="padding:2px 8px;background:var(--error);color:white;border:none;border-radius:4px;cursor:pointer;font-size:11px">删除</button>' +
          '</div>';
      });
      html += '</div>';
      container.innerHTML = html;
    }

    function openManageShareTemplates() {
      loadShareTemplatesSettings();
      showToast('已在设置面板中显示模板列表', 'success');
    }

    function deleteShareTemplate(idx) {
      if (!confirm('确认删除此模板？')) return;
      var templates = getShareTemplates();
      templates.splice(parseInt(idx, 10), 1);
      saveShareTemplates(templates);
      loadShareTemplatesSettings();
      showToast('模板已删除', 'success');
    }

    async function confirmShareCreate(filename) {
      var btn = document.getElementById('shareCreateBtn');
      if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
      var expiryVal = document.getElementById('shareExpirySelect').value;
      var expiryHours = expiryVal === 'custom' ? null : parseInt(expiryVal, 10);
      var customExpiry = expiryVal === 'custom' ? document.getElementById('shareCustomExpiry').value : null;
      var password = document.getElementById('sharePasswordInput').value.trim();
      var maxDownloads = document.getElementById('shareMaxDlInput').value.trim();
      try {
        var body = {
          filename: filename,
          expiryHours: expiryHours,
          password: password,
          maxDownloads: maxDownloads ? parseInt(maxDownloads, 10) : null,
          themeBg: document.getElementById('shareThemeBgHex').value.trim() || null,
          themeColor: document.getElementById('shareThemeColorHex').value.trim() || null,
          brandText: document.getElementById('shareBrandText').value.trim() || null
        };
        if (customExpiry) {
          body.customExpiry = new Date(customExpiry).getTime();
        }
        var data = await request('/api/share/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!data || !data.success || !data.share || !data.share.url) {
          showToast('创建分享链接失败', 'error');
          return;
        }
        await copyToClipboard(data.share.url);
        showToast('分享链接已复制到剪贴板', 'success');
        // Show success state with QR code in the modal
        var m = document.getElementById('shareCreateModal');
        if (m) {
          var content = m.querySelector('.modal-content');
          if (content) {
            var share = data.share;
            var qrImg = '<img src="/api/share/qr/' + encodeURIComponent(share.code) + '" style="max-width:180px;border-radius:12px;border:1px solid var(--line);display:block;margin:0 auto" alt="QR Code">';
            content.innerHTML = '\
              <h3>分享链接已创建</h3>\
              <p style="font-size:13px;color:var(--muted);margin-bottom:12px;word-break:break-all;background:var(--bg-secondary);padding:8px 12px;border-radius:8px">' + escapeHtmlClient(share.url) + '</p>\
              <div style="text-align:center;margin:16px 0">' + qrImg + '</div>\
              <div style="text-align:center;font-size:12px;color:var(--muted);margin-bottom:16px">扫码访问 · 链接已复制到剪贴板</div>\
              <div style="display:flex;gap:8px;justify-content:center">\
                <button class="secondary" onclick="downloadQrCode(\'' + share.code + '\')">下载二维码</button>\
                <button onclick="document.getElementById(\'shareCreateModal\').remove()">关闭</button>\
              </div>';
          }
        }
        await loadShares();
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '创建并复制链接'; }
      }
    }

    var currentShareSort = 'filename';
    var currentShareOrder = 'asc';

    function getShareSortArrow(field) {
      if (field !== currentShareSort) return '';
      return currentShareOrder === 'asc' ? '↑' : '↓';
    }

    function applyShareSort(shareList) {
      var field = currentShareSort;
      var order = currentShareOrder;
      return shareList.slice().sort(function (a, b) {
        var va = a[field], vb = b[field];
        if (va == null) va = '';
        if (vb == null) vb = '';
        if (field === 'expiresAt' || field === 'createdAt') {
          va = va ? new Date(va).getTime() : 0;
          vb = vb ? new Date(vb).getTime() : 0;
        }
        if (field === 'totalActivity') {
          va = (a.viewCount || 0) + (a.downloadCount || 0);
          vb = (b.viewCount || 0) + (b.downloadCount || 0);
        }
        if (typeof va === 'number' && typeof vb === 'number') {
          return order === 'asc' ? va - vb : vb - va;
        }
        var cmp = String(va).localeCompare(String(vb));
        return order === 'asc' ? cmp : -cmp;
      });
    }

    function updateShareSortArrows() {
      var fields = ['filename', 'expiresAt', 'viewCount', 'downloadCount'];
      fields.forEach(function (f) {
        var el = document.getElementById('shareArrow-' + f);
        if (el) {
          el.textContent = getShareSortArrow(f);
          el.className = 'share-sort-arrow' + (f === currentShareSort ? ' active' : '');
        }
      });
    }

    function setShareSort(field) {
      if (field === currentShareSort) {
        currentShareOrder = currentShareOrder === 'asc' ? 'desc' : 'asc';
      } else {
        currentShareSort = field;
        currentShareOrder = field === 'filename' ? 'asc' : 'desc';
      }
      updateShareSortArrows();
      filterShares();
    }

    var currentRlSort = 'created_at';
    var currentRlOrder = 'desc';

    function applyRlSort(rlList) {
      var field = currentRlSort;
      var order = currentRlOrder;
      return rlList.slice().sort(function (a, b) {
        var va = a[field], vb = b[field];
        if (va == null) va = '';
        if (vb == null) vb = '';
        if (field === 'created_at') {
          va = a.created_at || 0;
          vb = b.created_at || 0;
        }
        if (typeof va === 'number' && typeof vb === 'number') {
          return order === 'asc' ? va - vb : vb - va;
        }
        var cmp = String(va).localeCompare(String(vb));
        return order === 'asc' ? cmp : -cmp;
      });
    }

    function updateRlSortArrows() {
      var fields = ['name', 'created_at', 'upload_count'];
      fields.forEach(function (f) {
        var el = document.getElementById('rlArrow-' + f);
        if (el) {
          el.textContent = f === currentRlSort ? (currentRlOrder === 'asc' ? '↑' : '↓') : '';
          el.className = 'rl-sort-arrow' + (f === currentRlSort ? ' active' : '');
        }
      });
    }

    function setRlSort(field) {
      if (field === currentRlSort) {
        currentRlOrder = currentRlOrder === 'asc' ? 'desc' : 'asc';
      } else {
        currentRlSort = field;
        currentRlOrder = field === 'name' ? 'asc' : 'desc';
      }
      updateRlSortArrows();
      filterRequestLinks();
    }

    async function loadShares() {
      const data = await request('/api/share/list');
      const shares = data.shares || [];
      currentShares = shares;
      updateShareSortArrows();
      renderShareQuickFilters();
      renderShareTable(applyShareSort(shares));
    }

    var _shareQuickFilter = null; // 'active', 'expired', 'password', or null for all

    function renderShareQuickFilters() {
      var container = document.getElementById('shareQuickFilters');
      if (!container) return;
      var now = Date.now() / 1000;
      var all = currentShares.length;
      var active = currentShares.filter(function(s) { return !s.expiresAt || s.expiresAt > now; }).length;
      var expired = currentShares.filter(function(s) { return s.expiresAt && s.expiresAt <= now; }).length;
      var pwd = currentShares.filter(function(s) { return s.password; }).length;
      var filters = [
        { key: null, label: '全部', count: all },
        { key: 'active', label: '有效', count: active },
        { key: 'expired', label: '已过期', count: expired },
        { key: 'password', label: '有密码', count: pwd }
      ];
      var activeFilter = _shareQuickFilter;
      container.innerHTML = filters.map(function(f) {
        var isActive = f.key === activeFilter;
        return '<button onclick="setShareQuickFilter(\'' + (f.key || '') + '\')" style="padding:3px 10px;font-size:12px;border-radius:999px;border:none;cursor:pointer;font-weight:' + (isActive ? '600' : '400') + ';background:' + (isActive ? 'var(--accent)' : 'var(--bg-tertiary)') + ';color:' + (isActive ? '#fff' : 'var(--muted)') + '">' + f.label + ' (' + f.count + ')</button>';
      }).join('');
    }

    function setShareQuickFilter(key) {
      _shareQuickFilter = key === '' ? null : key;
      var now = Date.now() / 1000;
      var filtered = currentShares;
      if (key === 'active') filtered = currentShares.filter(function(s) { return !s.expiresAt || s.expiresAt > now; });
      else if (key === 'expired') filtered = currentShares.filter(function(s) { return s.expiresAt && s.expiresAt <= now; });
      else if (key === 'password') filtered = currentShares.filter(function(s) { return s.password; });
      renderShareQuickFilters();
      renderShareTable(applyShareSort(filtered));
    }

    function filterShareTable() {
      var q = document.getElementById('shareSearchInput').value.trim().toLowerCase();
      var countEl = document.getElementById('shareResultCount');
      if (!q) {
        if (countEl) countEl.textContent = '';
        renderShareTable(applyShareSort(currentShares));
        return;
      }
      var filtered = currentShares.filter(function(s) {
        return (s.filename && s.filename.toLowerCase().includes(q)) ||
               (s.code && s.code.toLowerCase().includes(q)) ||
               (s.url && s.url.toLowerCase().includes(q));
      });
      if (countEl) countEl.textContent = ' (' + filtered.length + '/' + currentShares.length + ')';
      renderShareTable(applyShareSort(filtered));
    }

    function renderShareTable(shares) {
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
        const expiresIn = share.expiresAt ? Math.ceil((share.expiresAt - Date.now()) / 86400000) : null;
        const expiringBadge = (expiresIn !== null && expiresIn <= 7 && expiresIn > 0) ? ' <span style="background:#92400e;color:#fff;font-size:10px;padding:1px 6px;border-radius:10px;white-space:nowrap">⚠️ ' + expiresIn + '天后</span>' : '';
        const expiredBadge = (expiresIn !== null && expiresIn <= 0) ? ' <span style="background:#991b1b;color:#fff;font-size:10px;padding:1px 6px;border-radius:10px">已过期</span>' : '';
        const renewBtn = (expiresIn !== null && expiresIn <= 30) ? '<button class="secondary" onclick="renewShareLink(\'' + escapeHtmlClient(share.code) + '\')" style="font-size:11px;padding:3px 8px">续期</button>' : '';
        const createdText = share.createdAt ? formatTime(share.createdAt) : '-';
        const totalActivity = (share.viewCount || 0) + (share.downloadCount || 0);
        return '<tr>' +
          '<td data-label=""><input type="checkbox" class="share-check" data-code="' + escapeHtmlClient(share.code) + '" onchange="onShareCheckChange()"></td>' +
          '<td data-label="文件"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (share.themeColor || 'var(--line)') + ';margin-right:5px;vertical-align:middle;flex-shrink:0"></span><strong style="cursor:pointer;color:var(--accent)" onclick="openShareDetailModal(\'' + escapeHtmlClient(share.code) + '\')">' + escapeHtmlClient(share.filename) + '</strong></td>' +
          '<td data-label="链接"><a href="' + escapeHtmlClient(share.url) + '" target="_blank" style="word-break:break-all;font-size:12px">' + escapeHtmlClient(share.url) + '</a></td>' +
          '<td data-label="二维码"><img alt="QR" src="/api/share/qr/' + encodeURIComponent(share.code) + '" style="cursor:pointer;border-radius:6px;max-width:48px;height:auto" onclick="openQrLightbox(\'' + escapeHtmlClient(share.code) + '\')" title="点击查看大图"></td>' +
          '<td data-label="到期">' + expireText + expiringBadge + expiredBadge + '</td>' +
          '<td data-label="创建">' + createdText + '</td>' +
          '<td data-label="访问">' + (share.viewCount || 0) + '</td>' +
          '<td data-label="下载">' + (share.downloadCount || 0) + (share.maxDownloads ? ' / ' + share.maxDownloads : '') + '</td>' +
          '<td data-label="总计" style="font-weight:700;color:var(--accent)">' + totalActivity + '</td>' +
          '<td class="actions-cell" data-label="操作">' +
            (renewBtn || '') +
            '<button class="secondary" onclick=' + "'" + 'copyShare(' + JSON.stringify(share.url) + ')' + "'" + '>复制</button>' +
            '<button class="secondary" onclick=' + "'" + 'copyShareEmbed("' + escapeHtmlClient(share.code) + '")' + "'" + '>嵌入</button>' +
            '<button class="secondary" onclick=' + "'" + 'previewShare("' + escapeHtmlClient(share.code) + '")' + "'" + '>预览</button>' +
            '<button class="secondary" onclick=' + "'" + 'downloadQrCode(' + JSON.stringify(share.code) + ')' + "'" + '>二维码</button>' +
            '<button class="secondary" onclick=' + "'" + 'openShareEditModal(' + JSON.stringify(share.code) + ')' + "'" + '>编辑</button>' +
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
      renderShareTable(applyShareSort(filtered));
    }

    async function copyAllShares() {
      if (!currentShares.length) return;
      var urls = currentShares.map(function (s) { return s.url; }).join('\n');
      await copyToClipboard(urls);
      showToast('已复制 ' + currentShares.length + ' 个链接', 'success');
    }

    async function copyShare(url) {
      await copyToClipboard(url);
      var display = url.length > 60 ? url.slice(0, 57) + '...' : url;
      showToast('已复制: ' + display, 'success');
    }

    async function copyShareEmbed(code) {
      var share = currentShares.find(function(s) { return s.code === code; });
      if (!share) { showToast('分享不存在', 'error'); return; }
      var url = share.url || (location.origin + '/s/' + code);
      var name = share.filename || code;
      var html = '<a href="' + url + '" target="_blank">' + escapeHtmlClient(name) + '</a>';
      await copyToClipboard(html);
      showToast('已复制嵌入代码', 'success');
    }

    async function deleteShare(code) {
      openConfirmModal({
        title: '删除分享链接？',
        text: '此操作不可撤销。',
        danger: true,
        onConfirm: async function() {
          await request('/api/share/delete/' + encodeURIComponent(code), { method: 'DELETE' });
          await loadShares();
        }
      });
    }

    async function renewShareLink(code) {
      var days = prompt('续期天数（默认7天）:', '7');
      if (days === null) return;
      days = parseInt(days, 10) || 7;
      var data = await request('/api/share/renew/' + encodeURIComponent(code), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: days })
      });
      if (data && data.success) {
        showToast('已续期 ' + data.days + ' 天', 'success');
        await loadShares();
      } else {
        showToast('续期失败: ' + (data && data.error || '未知错误'), 'error');
      }
    }

    async function openShareDetailModal(code) {
      var share = currentShares.find(function(s) { return s.code === code; });
      if (!share) return;
      var expireText = share.expiresAt ? formatTime(share.expiresAt) : '永不过期';
      var expiresIn = share.expiresAt ? Math.ceil((share.expiresAt - Date.now()) / 86400000) : null;
      var createdText = share.createdAt ? formatTime(share.createdAt) : '—';
      var expiryInfo = '永不过期';
      if (share.expiresAt) {
        var days = Math.ceil((share.expiresAt - Date.now()) / 86400000);
        if (days > 0) expiryInfo = '还有 ' + days + ' 天';
        else if (days === 0) expiryInfo = '今天过期';
        else expiryInfo = '已过期 ' + Math.abs(days) + ' 天';
      }
      var dlPct = (share.maxDownloads && share.maxDownloads > 0)
        ? Math.round((share.downloadCount || 0) / share.maxDownloads * 100)
        : null;
      var dlBar = dlPct !== null
        ? '<div style="margin-top:8px"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px"><span>下载进度</span><span>' + (share.downloadCount || 0) + '/' + share.maxDownloads + '</span></div><div style="height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden"><div style="height:100%;width:' + dlPct + '%;background:' + (dlPct >= 100 ? '#ef4444' : dlPct >= 80 ? '#f59e0b' : 'var(--accent)') + ';border-radius:3px"></div></div></div>'
        : '';
      var stats = '\
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">\
          <div style="background:var(--bg-tertiary);border-radius:10px;padding:14px;text-align:center">\
            <div style="font-size:24px;font-weight:700;color:var(--accent)">' + (share.viewCount || 0) + '</div>\
            <div style="font-size:11px;color:var(--muted);margin-top:2px">浏览</div>\
          </div>\
          <div style="background:var(--bg-tertiary);border-radius:10px;padding:14px;text-align:center">\
            <div style="font-size:24px;font-weight:700;color:var(--accent)">' + (share.downloadCount || 0) + '</div>\
            <div style="font-size:11px;color:var(--muted);margin-top:2px">下载</div>\
          </div>\
          <div style="background:var(--bg-tertiary);border-radius:10px;padding:14px;text-align:center;position:relative">\
            <div style="font-size:24px;font-weight:700">' + (share.maxDownloads ? share.maxDownloads : '∞') + '</div>\
            <div style="font-size:11px;color:var(--muted);margin-top:2px">最大下载</div>' + dlBar + '\
          </div>\
          <div style="background:var(--bg-tertiary);border-radius:10px;padding:14px;text-align:center">\
            <div style="font-size:14px;font-weight:700">' + expiryInfo + '</div>\
            <div style="font-size:11px;color:var(--muted);margin-top:2px">到期时间</div>\
          </div>\
        </div>';
      var infoRows = '\
        <table style="width:100%;font-size:13px;border-collapse:collapse">\
          <tr style="border-bottom:1px solid var(--line)">\
            <td style="padding:7px 4px;color:var(--muted);width:90px">文件名</td>\
            <td style="padding:7px 4px;font-weight:500;word-break:break-all">' + escapeHtmlClient(share.filename) + '</td>\
          </tr>\
          <tr style="border-bottom:1px solid var(--line)">\
            <td style="padding:7px 4px;color:var(--muted)">分享码</td>\
            <td style="padding:7px 4px;font-family:monospace;font-size:12px;color:var(--accent)">' + escapeHtmlClient(share.code) + '</td>\
          </tr>\
          <tr style="border-bottom:1px solid var(--line)">\
            <td style="padding:7px 4px;color:var(--muted)">创建时间</td>\
            <td style="padding:7px 4px">' + createdText + '</td>\
          </tr>\
          <tr style="border-bottom:1px solid var(--line)">\
            <td style="padding:7px 4px;color:var(--muted)">到期时间</td>\
            <td style="padding:7px 4px">' + expireText + '</td>\
          </tr>\
          <tr style="border-bottom:1px solid var(--line)">\
            <td style="padding:7px 4px;color:var(--muted)">密码</td>\
            <td style="padding:7px 4px">' + (share.hasPassword ? '🔒 有密码' : '无') + '</td>\
          </tr>' +
          (share.description ? '\
          <tr style="border-bottom:1px solid var(--line)">\
            <td style="padding:7px 4px;color:var(--muted)">描述</td>\
            <td style="padding:7px 4px;color:var(--text-secondary);font-size:12px">' + escapeHtmlClient(share.description) + '</td>\
          </tr>' : '') + '\
        </table>';
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '📋 ' + escapeHtmlClient(share.filename);
      body.innerHTML = '<div style="max-width:480px">' + stats + infoRows +
        '<div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">\
          <button class="secondary" onclick="closeModal();copyShare(\'' + escapeHtmlClient(share.url || '').replace(/'/g, "\\'") + '\')" style="font-size:13px">📋 复制链接</button>\
          <button class="secondary" onclick="closeModal();openQrLightbox(\'' + escapeHtmlClient(code) + '\')" style="font-size:13px">🔳 查看二维码</button>\
          <button class="secondary" onclick="closeModal();previewShare(\'' + escapeHtmlClient(code) + '\')" style="font-size:13px">👁 预览</button>\
          <button class="secondary" onclick="closeModal();openShareEditModal(\'' + escapeHtmlClient(code) + '\')" style="font-size:13px">✏ 编辑</button>\
          <button class="danger" onclick="closeModal();deleteShare(\'' + escapeHtmlClient(code) + '\')" style="font-size:13px">🗑 删除</button>\
        </div></div>';
      modal.classList.add('open');
    }

    window.previewShare = function(code) {
      var base = window.location.origin;
      var url = base + '/s/' + encodeURIComponent(code);
      window.open(url, '_blank', 'noopener,noreferrer');
    };

    async function openShareEditModal(code) {
      var share = currentShares.find(function(s) { return s.code === code; });
      if (!share) return;
      var modal = document.createElement('div');
      modal.id = 'shareEditModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';
      var currentExpiry = share.expiresAt ? new Date(share.expiresAt).toISOString().slice(0, 16) : '';
      var maxDl = share.maxDownloads || '';
      var themeBgVal = share.themeBg || '';
      var themeColorVal = share.themeColor || '';
      var brandTextVal = share.brandText || '';
      modal.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:460px;font-size:14px;max-height:90vh;overflow-y:auto">\
          <h3 style="margin:0 0 20px">编辑分享链接</h3>\
          <p style="margin:0 0 6px;font-size:12px;color:var(--muted);word-break:break-all"><strong>文件:</strong> ' + escapeHtmlClient(share.filename) + '</p>\
          <p style="margin:0 0 6px;font-size:12px;color:var(--muted);word-break:break-all"><strong>链接:</strong> ' + escapeHtmlClient(share.url || '') + '</p>\
          <div style="margin-bottom:16px;text-align:center">\
            <img src="/api/share/qr/' + encodeURIComponent(share.code) + '" style="border-radius:12px;max-width:160px;border:1px solid var(--line)" alt="QR">\
            <div style="margin-top:8px"><button class="secondary" onclick="downloadQrCode(\'' + escapeHtmlClient(share.code) + '\')" style="font-size:12px;padding:6px 12px">下载二维码</button></div>\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">到期时间</label>\
            <input id="editShareExpiry" type="datetime-local" value="' + currentExpiry + '" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
            <div style="font-size:11px;color:var(--muted);margin-top:3px">留空表示永不过期</div>\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">下载次数限制</label>\
            <input id="editShareMaxDl" type="number" min="0" placeholder="不限制" value="' + maxDl + '" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">密码保护</label>\
            <input id="editSharePwd" type="text" placeholder="留空则不设置密码" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
            ' + (share.hasPassword ? '<div style="font-size:11px;color:var(--muted);margin-top:3px">当前已设置密码，如需修改请填写新密码</div>' : '') + '\
          </div>\
          <details style="margin-bottom:12px;border:1px solid var(--line);border-radius:10px;padding:10px 12px">\
            <summary style="cursor:pointer;font-size:13px;color:var(--muted);user-select:none">🎨 自定义外观</summary>\
            <div style="margin-top:10px">\
              <div style="margin-bottom:8px">\
                <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">背景颜色</label>\
                <input id="editShareThemeBg" type="color" value="' + (themeBgVal || '#f6f7fb') + '" style="width:48px;height:32px;border-radius:6px;border:1px solid var(--line);cursor:pointer;vertical-align:middle">\
                <input id="editShareThemeBgHex" type="text" placeholder="#f6f7fb" value="' + escapeHtmlClient(themeBgVal) + '" style="width:100px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;font-size:12px;margin-left:4px">\
                <button onclick="clearShareThemeBg()" style="margin-left:6px;font-size:11px;padding:3px 8px;border-radius:6px;background:var(--line);border:none;cursor:pointer;color:var(--muted)">清除</button>\
              </div>\
              <div style="margin-bottom:8px">\
                <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">主题颜色</label>\
                <input id="editShareThemeColor" type="color" value="' + (themeColorVal || '#111827') + '" style="width:48px;height:32px;border-radius:6px;border:1px solid var(--line);cursor:pointer;vertical-align:middle">\
                <input id="editShareThemeColorHex" type="text" placeholder="#111827" value="' + escapeHtmlClient(themeColorVal) + '" style="width:100px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;font-size:12px;margin-left:4px">\
                <button onclick="clearShareThemeColor()" style="margin-left:6px;font-size:11px;padding:3px 8px;border-radius:6px;background:var(--line);border:none;cursor:pointer;color:var(--muted)">清除</button>\
              </div>\
              <div>\
                <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">品牌文字</label>\
                <input id="editShareBrandText" type="text" placeholder="例如：© 2024 我的公司" maxlength="80" value="' + escapeHtmlClient(brandTextVal) + '" style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;font-size:12px;box-sizing:border-box">\
              </div>\
            </div>\
          </details>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'shareEditModal\').remove()">取消</button>\
            <button onclick="confirmShareEdit(\'' + code + '\')" id="shareEditBtn">保存</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
      // Sync color pickers with hex inputs
      var bgPicker = document.getElementById('editShareThemeBg');
      var bgHex = document.getElementById('editShareThemeBgHex');
      if (bgPicker && bgHex) { bgPicker.addEventListener('input', function() { bgHex.value = bgPicker.value; }); }
      var colorPicker = document.getElementById('editShareThemeColor');
      var colorHex = document.getElementById('editShareThemeColorHex');
      if (colorPicker && colorHex) { colorPicker.addEventListener('input', function() { colorHex.value = colorPicker.value; }); }
    }

    function clearShareThemeBg() {
      var el = document.getElementById('editShareThemeBgHex');
      if (el) el.value = '';
    }
    function clearShareThemeColor() {
      var el = document.getElementById('editShareThemeColorHex');
      if (el) el.value = '';
    }

    async function confirmShareEdit(code) {
      var btn = document.getElementById('shareEditBtn');
      if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }
      try {
        var expiryInput = document.getElementById('editShareExpiry').value;
        var maxDlInput = document.getElementById('editShareMaxDl').value;
        var pwdInput = document.getElementById('editSharePwd').value.trim();
        var themeBgInput = document.getElementById('editShareThemeBgHex').value.trim();
        var themeColorInput = document.getElementById('editShareThemeColorHex').value.trim();
        var brandTextInput = document.getElementById('editShareBrandText').value.trim();
        var updates = {};
        if (expiryInput) {
          updates.expiresAt = new Date(expiryInput).getTime();
        } else {
          // Check if field was cleared (empty string means "never expire")
          var share = currentShares.find(function(s) { return s.code === code; });
          updates.expiresAt = expiryInput === '' ? (share.expiresAt ? 0 : null) : null;
        }
        updates.maxDownloads = maxDlInput ? parseInt(maxDlInput, 10) : 0;
        updates.password = pwdInput || null;
        updates.themeBg = themeBgInput || null;
        updates.themeColor = themeColorInput || null;
        updates.brandText = brandTextInput || null;
        var result = await request('/api/share/update/' + encodeURIComponent(code), {
          method: 'PUT',
          body: JSON.stringify(updates)
        });
        if (result && result.success) {
          showToast('分享链接已更新', 'success');
          document.getElementById('shareEditModal').remove();
          await loadShares();
        } else {
          showToast((result && result.error) || '更新失败', 'error');
        }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '保存'; }
      }
    }

    function openBatchShareUpdateModal() {
      var checked = document.querySelectorAll('.share-check:checked');
      if (!checked.length) { showToast('请先选择要更新的分享链接', 'error'); return; }
      var count = checked.length;
      var modal = document.createElement('div');
      modal.id = 'batchShareUpdateModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';
      modal.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:420px;font-size:14px;max-height:90vh;overflow-y:auto">\
          <h3 style="margin:0 0 6px">批量更新分享链接</h3>\
          <p style="margin:0 0 16px;font-size:12px;color:var(--muted)">将同时更新选中的 ' + count + ' 个链接。不修改的字段留空即可。</p>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">到期时间</label>\
            <div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap">\
              <button onclick="setBatchShareExpiryDays(7)" style="padding:4px 10px;font-size:12px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--text)">7天</button>\
              <button onclick="setBatchShareExpiryDays(30)" style="padding:4px 10px;font-size:12px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--text)">30天</button>\
              <button onclick="setBatchShareExpiryDays(90)" style="padding:4px 10px;font-size:12px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--text)">90天</button>\
              <button onclick="setBatchShareExpiryDays(365)" style="padding:4px 10px;font-size:12px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--text)">1年</button>\
              <button onclick="clearBatchShareExpiry()" style="padding:4px 10px;font-size:12px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--muted)">永不过期</button>\
            </div>\
            <input id="batchShareExpiry" type="datetime-local" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
            <div style="font-size:11px;color:var(--muted);margin-top:3px">留空表示不修改；清空并保存表示永不过期</div>\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">下载次数限制</label>\
            <input id="batchShareMaxDl" type="number" min="0" placeholder="不限制（留空）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
            <div style="font-size:11px;color:var(--muted);margin-top:3px">留空表示不修改；0或不限制均表示无限制</div>\
          </div>\
          <div style="margin-bottom:16px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">密码保护</label>\
            <input id="batchSharePwd" type="text" placeholder="留空表示不修改" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
            <div style="font-size:11px;color:var(--muted);margin-top:3px">留空表示不修改；输入密码则统一设置</div>\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'batchShareUpdateModal\').remove()">取消</button>\
            <button id="batchShareUpdateBtn" onclick="confirmBatchShareUpdate()">保存更新</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    }

    function setBatchShareExpiryDays(days) {
      var input = document.getElementById('batchShareExpiry');
      if (!input) return;
      var d = new Date(Date.now() + days * 86400000);
      input.value = d.toISOString().slice(0, 16);
    }
    function clearBatchShareExpiry() {
      var input = document.getElementById('batchShareExpiry');
      if (!input) return;
      input.value = '';
    }

    async function confirmBatchShareUpdate() {
      var checked = document.querySelectorAll('.share-check:checked');
      if (!checked.length) return;
      var codes = Array.from(checked).map(function(c) { return c.getAttribute('data-code'); });
      var btn = document.getElementById('batchShareUpdateBtn');
      if (btn) { btn.disabled = true; btn.textContent = '更新中...'; }
      var expiryInput = document.getElementById('batchShareExpiry').value;
      var maxDlInput = document.getElementById('batchShareMaxDl').value;
      var pwdInput = document.getElementById('batchSharePwd').value.trim();
      var results = { success: 0, failed: 0 };
      var errors = [];
      for (var i = 0; i < codes.length; i++) {
        var code = codes[i];
        var updates = {};
        if (expiryInput !== '') {
          updates.expiresAt = expiryInput ? new Date(expiryInput).getTime() : 0; // 0 = never
        }
        if (maxDlInput !== '') {
          updates.maxDownloads = maxDlInput ? parseInt(maxDlInput, 10) : 0;
        }
        if (pwdInput !== '') {
          updates.password = pwdInput;
        }
        if (Object.keys(updates).length === 0) {
          showToast('请至少填写一个要更新的字段', 'error');
          if (btn) { btn.disabled = false; btn.textContent = '保存更新'; }
          return;
        }
        try {
          var r = await request('/api/share/update/' + encodeURIComponent(code), {
            method: 'PUT',
            body: JSON.stringify(updates)
          });
          if (r && r.success) results.success++;
          else { results.failed++; errors.push(code + ': ' + (r && r.error || '未知错误')); }
        } catch(e) { results.failed++; errors.push(code + ': ' + e.message); }
      }
      if (btn) { btn.disabled = false; btn.textContent = '保存更新'; }
      document.getElementById('batchShareUpdateModal').remove();
      var msg = '成功更新 ' + results.success + ' 个';
      if (results.failed > 0) msg += '，失败 ' + results.failed + ' 个';
      showToast(msg, results.failed > 0 ? 'error' : 'success');
      await loadShares();
    }

    // ── Request Links (文件收集链接) ───────────────────────────────────────

    var currentRequestLinks = [];

    async function loadRequestLinks() {
      var data = await request('/api/request-links');
      currentRequestLinks = data.request_links || [];
      updateRlSortArrows();
      renderRequestLinkTable(applyRlSort(currentRequestLinks));
    }

    function renderRequestLinkTable(links) {
      var body = document.getElementById('requestLinkTable');
      var empty = document.getElementById('requestLinkEmpty');
      if (!links || !links.length) {
        body.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      clearRlSelection(); // reset batch bar on re-render
      body.innerHTML = links.map(function(rl) {
        var url = (location.origin || '') + '/r/' + rl.code;
        var statusLabel = rl.active ? '<span style="color:#22c55e">● 有效</span>' : '<span style="color:#94a3b8">○ 已停用</span>';
        var info = [];
        if (rl.upload_count) info.push('已收: ' + rl.upload_count + (rl.max_uploads ? '/' + rl.max_uploads : ''));
        if (rl.has_password) info.push('🔒 有密码');
        if (rl.expires_at) info.push('到期: ' + formatTime(rl.expires_at * 1000));
        if (rl.target_folder) info.push('目录: ' + escapeHtmlClient(rl.target_folder));
        return '<tr>' +
          '<td data-label=""><input type="checkbox" class="rl-check" value="' + encodeURIComponent(rl.code) + '" onchange="updateRlBatchBar()" style="margin:0"></td>' +
          '<td data-label="名称"><strong>' + escapeHtmlClient(rl.name) + '</strong></td>' +
          '<td data-label="链接"><a href="' + escapeHtmlClient(url) + '" target="_blank" style="word-break:break-all;font-size:12px">' + escapeHtmlClient('/r/' + rl.code) + '</a></td>' +
          '<td data-label="创建时间">' + (rl.created_at ? formatTime(rl.created_at * 1000) : '—') + '</td>' +
          '<td data-label="已收">' + (rl.upload_count || 0) + (rl.max_uploads ? ' / ' + rl.max_uploads : '') + '</td>' +
          '<td data-label="状态">' + statusLabel + (info.length ? '<br><span style="font-size:11px;color:var(--muted)">' + info.join(' · ') + '</span>' : '') + '</td>' +
          '<td class="actions-cell" data-label="操作">' +
            '<button class="secondary" onclick="copyToClipboard(\'' + escapeHtmlClient(url) + '\').then(function(){showToast(\'链接已复制\',\'success\')})">复制</button> ' +
            '<button class="secondary" onclick="downloadRequestLinkQr(\'' + encodeURIComponent(rl.code) + '\')">二维码</button> ' +
            '<button class="secondary" onclick="openRequestLinkFilesModal(\'' + escapeHtmlClient(rl.code) + '\')">📁 已收集' + (rl.upload_count ? ' (' + rl.upload_count + ')' : '') + '</button> ' +
            '<button class="secondary" onclick="duplicateRequestLink(\'' + escapeHtmlClient(rl.code) + '\')">复制链接</button> ' +
            '<button class="secondary" onclick="openRequestLinkEditModal(\'' + escapeHtmlClient(rl.code) + '\')">编辑</button> ' +
            '<button class="secondary" onclick="toggleRequestLinkActive(\'' + escapeHtmlClient(rl.code) + '\', ' + !rl.active + ')">' + (rl.active ? '停用' : '启用') + '</button> ' +
            '<button class="danger" onclick="deleteRequestLink(\'' + escapeHtmlClient(rl.code) + '\')">删除</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    function filterRequestLinks() {
      var q = document.getElementById('requestLinkSearchInput').value.trim().toLowerCase();
      var statusFilter = document.getElementById('rlStatusFilter') && document.getElementById('rlStatusFilter').value;
      var base = currentRequestLinks;
      if (statusFilter === 'active') base = base.filter(function(rl) { return rl.active; });
      else if (statusFilter === 'inactive') base = base.filter(function(rl) { return !rl.active; });
      if (!q) {
        renderRequestLinkTable(applyRlSort(base));
        return;
      }
      var filtered = base.filter(function(rl) {
        return rl.name.toLowerCase().includes(q) || (rl.code || '').toLowerCase().includes(q);
      });
      renderRequestLinkTable(applyRlSort(filtered));
    }

    // Pull-to-refresh for mobile
    (function() {
      var ptrStartY = 0;
      var ptrPulled = false;
      var ptrEl = document.getElementById('pull-indicator');
      var ptrTextNode;
      if (ptrEl) ptrTextNode = ptrEl.childNodes[ptrEl.childNodes.length - 1];
      document.addEventListener('touchstart', function(e) {
        if (document.documentElement.scrollTop <= 5 || document.body.scrollTop <= 5) {
          ptrStartY = e.touches[0].clientY;
          ptrPulled = false;
        }
      }, { passive: true });
      document.addEventListener('touchmove', function(e) {
        if (ptrStartY === 0) return;
        var delta = e.touches[0].clientY - ptrStartY;
        if (delta > 60 && !ptrPulled) {
          ptrPulled = true;
          if (navigator.vibrate) navigator.vibrate(10);
        }
        if (delta > 0) {
          var pullPx = Math.min(delta - 0, 100);
          ptrEl.style.height = pullPx + 'px';
          var spinner = ptrEl.querySelector('.spinner');
          if (spinner) spinner.style.display = pullPx >= 60 ? 'inline-block' : 'none';
          if (ptrTextNode) ptrTextNode.textContent = pullPx >= 60 ? '松开刷新' : '下拉刷新...';
        }
      }, { passive: true });
      document.addEventListener('touchend', function() {
        if (ptrStartY === 0) return;
        var h = parseInt(ptrEl.style.height) || 0;
        ptrStartY = 0;
        ptrPulled = false;
        ptrEl.style.height = '0px';
        if (h >= 60) {
          if (navigator.vibrate) navigator.vibrate([10, 50, 10]);
          loadFiles();
          showToast('刷新中...', 'info');
        }
      }, { passive: true });
    })();

    function toggleRlSelectAll(checked) {
      document.querySelectorAll('.rl-check').forEach(function(el) { el.checked = checked; });
      updateRlBatchBar();
    }

    function updateRlBatchBar() {
      var checked = document.querySelectorAll('.rl-check:checked');
      var bar = document.getElementById('rlBatchBar');
      var count = document.getElementById('rlBatchCount');
      var listAll = document.getElementById('rlListSelectAll');
      if (!bar || !count) return;
      if (checked.length > 0) {
        bar.style.display = 'flex';
        count.textContent = '已选择 ' + checked.length + ' 个链接';
        listAll.checked = checked.length === document.querySelectorAll('.rl-check').length;
      } else {
        bar.style.display = 'none';
        listAll.checked = false;
      }
    }

    async function batchCopySelectedRl() {
      var checked = document.querySelectorAll('.rl-check:checked');
      var rls = Array.from(checked).map(function(el) {
        return currentRequestLinks.find(function(r) { return r.code === decodeURIComponent(el.value); });
      }).filter(Boolean);
      if (!rls.length) { showToast('请先选择链接', 'error'); return; }
      var urls = rls.map(function(r) { return (location.origin || '') + '/r/' + r.code; }).join('\n');
      await copyToClipboard(urls);
      showToast('已复制 ' + rls.length + ' 个链接', 'success');
    }

    async function batchDownloadSelectedRlQrs() {
      var checked = document.querySelectorAll('.rl-check:checked');
      var codes = Array.from(checked).map(function(el) { return decodeURIComponent(el.value); });
      if (!codes.length) { showToast('请先选择链接', 'error'); return; }
      showToast('开始下载 ' + codes.length + ' 个二维码...');
      var count = 0;
      for (var i = 0; i < codes.length; i++) {
        try {
          var response = await fetch('/api/request-link/qr/' + encodeURIComponent(codes[i]));
          if (!response.ok) continue;
          var blob = await response.blob();
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'request-link-qr-' + codes[i] + '.png';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          count++;
          await new Promise(function(r) { setTimeout(r, 200); });
        } catch(e) {}
      }
      showToast('已下载 ' + count + ' 个二维码', 'success');
    }

    function clearRlSelection() {
      document.querySelectorAll('.rl-check').forEach(function(el) { el.checked = false; });
      document.getElementById('rlListSelectAll').checked = false;
      updateRlBatchBar();
    }

    function openRequestLinkCreateModal() {
      var modal = document.createElement('div');
      modal.id = 'requestLinkCreateModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';
      modal.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:420px;font-size:14px;max-height:90vh;overflow-y:auto">\
          <h3 style="margin:0 0 20px">新建收集链接</h3>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">名称 *</label>\
            <input id="rlName" type="text" placeholder="例如：收集作业" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">目标文件夹</label>\
            <input id="rlTargetFolder" type="text" placeholder="留空则存根目录" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">有效期</label>\
            <select id="rlExpires" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
              <option value="">永不过期</option>\
              <option value="7">7天</option>\
              <option value="30">30天</option>\
              <option value="90">90天</option>\
            </select>\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">上传次数限制</label>\
            <input id="rlMaxUploads" type="number" min="0" placeholder="不限制" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">密码保护</label>\
            <input id="rlPassword" type="text" placeholder="留空则无需密码" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="document.getElementById(\'requestLinkCreateModal\').remove()">取消</button>\
            <button onclick="confirmRequestLinkCreate()" id="rlCreateBtn">创建</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    }

    async function confirmRequestLinkCreate() {
      var name = document.getElementById('rlName').value.trim();
      if (!name) { showToast('请输入名称', 'error'); return; }
      var targetFolder = document.getElementById('rlTargetFolder').value.trim();
      var expires = document.getElementById('rlExpires').value;
      var maxUploads = document.getElementById('rlMaxUploads').value;
      var password = document.getElementById('rlPassword').value.trim();
      var btn = document.getElementById('rlCreateBtn');
      if (btn) { btn.disabled = true; btn.textContent = '创建中...'; }
      try {
        var body = { name: name };
        if (targetFolder) body.target_folder = targetFolder;
        if (expires) body.expires_in_days = parseInt(expires, 10);
        if (maxUploads) body.max_uploads = parseInt(maxUploads, 10);
        if (password) body.password = password;
        var result = await request('/api/request-links', { method: 'POST', body: JSON.stringify(body) });
        if (result && result.success && result.request_link) {
          document.getElementById('requestLinkCreateModal').remove();
          await loadRequestLinks();
          openRequestLinkQrModal(result.request_link.code);
        } else {
          showToast((result && result.error) || '创建失败', 'error');
        }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '创建'; }
      }
    }

    function openRequestLinkQrModal(code) {
      var url = location.origin + '/r/' + code;
      var modal = document.createElement('div');
      modal.id = 'requestLinkQrModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';
      modal.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:360px;font-size:14px;text-align:center">\
          <h3 style="margin:0 0 16px">收集链接已创建</h3>\
          <img src="/api/request-link/qr/' + encodeURIComponent(code) + '" style="border-radius:12px;max-width:100%;height:auto" alt="QR Code">\
          <p style="margin:12px 0 4px;font-size:13px;color:var(--muted);word-break:break-all">' + escapeHtmlClient(url) + '</p>\
          <div style="display:flex;gap:8px;justify-content:center;margin-top:16px">\
            <button class="secondary" onclick="copyToClipboard(\'' + escapeHtmlClient(url) + '\').then(function(){showToast(\'链接已复制\',\'success\')})">复制链接</button>\
            <button class="secondary" onclick="downloadRequestLinkQr(\'' + encodeURIComponent(code) + '\')">下载二维码</button>\
            <button class="secondary" onclick="document.getElementById(\'requestLinkQrModal\').remove()">关闭</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    }

    function openRequestLinkEditModal(code) {
      var rl = currentRequestLinks.find(function(r) { return r.code === code; });
      if (!rl) return;
      var modal = document.createElement('div');
      modal.id = 'requestLinkEditModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';
      var expiresDays = rl.expires_at ? Math.max(1, Math.round((rl.expires_at * 1000 - Date.now()) / 86400000)) : '';
      var rlUrl = '/r/' + code;
      modal.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:420px;font-size:14px;max-height:90vh;overflow-y:auto">\
          <h3 style="margin:0 0 12px">编辑收集链接</h3>\
          <div style="margin-bottom:12px;text-align:center">\
            <img src="/api/request-link/qr/' + encodeURIComponent(code) + '" style="border-radius:12px;max-width:120px;border:1px solid var(--line)" alt="QR">\
            <div style="margin-top:6px;font-size:11px;color:var(--muted);word-break:break-all">' + escapeHtmlClient(rlUrl) + '</div>\
            <div style="margin-top:4px"><button class="secondary" onclick="downloadRequestLinkQr(\'' + escapeHtmlClient(code) + '\')" style="font-size:12px;padding:4px 10px">下载二维码</button></div>\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">名称</label>\
            <input id="rlEditName" type="text" value="' + escapeHtmlClient(rl.name) + '" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">目标文件夹</label>\
            <input id="rlEditTargetFolder" type="text" value="' + escapeHtmlClient(rl.target_folder || '') + '" placeholder="留空则存根目录" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">密码（留空保持不变）</label>\
            <input id="rlEditPassword" type="text" placeholder="留空则无需密码" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">最大上传数（0或不填=不限）</label>\
            <input id="rlEditMaxUploads" type="number" value="' + (rl.max_uploads || '') + '" placeholder="0" min="0" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="margin-bottom:12px">\
            <label style="display:block;margin-bottom:4px;font-size:13px">过期天数（0或不填=永不过期）</label>\
            <input id="rlEditExpires" type="number" value="' + expiresDays + '" placeholder="0" min="0" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);box-sizing:border-box">\
          </div>\
          <div style="display:flex;gap:8px;justify-content:flex-end">\
            <button class="secondary" onclick="closeEditModal()">取消</button>\
            <button class="primary" id="rlEditSaveBtn" onclick="saveRequestLinkEdit(\'' + escapeHtmlClient(code) + '\')">保存</button>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function(e) {
        if (e.target === modal) closeEditModal();
      });
    }

    function closeEditModal() {
      var m = document.getElementById('requestLinkEditModal');
      if (m) m.remove();
    }

    async function saveRequestLinkEdit(code) {
      var name = document.getElementById('rlEditName').value.trim();
      var target_folder = document.getElementById('rlEditTargetFolder').value.trim();
      var password = document.getElementById('rlEditPassword').value;
      var max_uploads = parseInt(document.getElementById('rlEditMaxUploads').value, 10) || null;
      var expires_days = parseInt(document.getElementById('rlEditExpires').value, 10) || null;
      if (!name) { showToast('名称不能为空', 'error'); return; }
      var btn = document.getElementById('rlEditSaveBtn');
      if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }
      try {
        var body = { name: name };
        if (target_folder !== undefined) body.target_folder = target_folder;
        if (password !== '') body.password = password || null;
        if (max_uploads !== null) body.max_uploads = max_uploads;
        if (expires_days !== null) body.expires_in_days = expires_days;
        var data = await request('/api/request-links/' + encodeURIComponent(code), {
          method: 'PUT',
          body: JSON.stringify(body)
        });
        if (data.success) {
          showToast('保存成功', 'success');
          closeEditModal();
          await loadRequestLinks();
        } else {
          showToast(data.error || '保存失败', 'error');
        }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '保存'; }
      }
    }

    async function duplicateRequestLink(code) {
      var rl = currentRequestLinks.find(function(r) { return r.code === code; });
      if (!rl) return;
      var newName = rl.name + ' (副本)';
      var body = { name: newName };
      if (rl.target_folder) body.target_folder = rl.target_folder;
      if (rl.has_password) body.password = null; // don't copy password
      if (rl.max_uploads) body.max_uploads = rl.max_uploads;
      // default new expiry: 30 days
      body.expires_in_days = 30;
      try {
        var data = await request('/api/request-links', { method: 'POST', body: JSON.stringify(body) });
        if (data.success || data.request_link) {
          showToast('已创建副本: ' + newName, 'success');
          await loadRequestLinks();
        } else {
          showToast(data.error || '创建失败', 'error');
        }
      } catch(e) { showToast('创建失败', 'error'); }
    }

    async function toggleRequestLinkActive(code, active) {
      await request('/api/request-links/' + encodeURIComponent(code) + '/active', {
        method: 'PUT',
        body: JSON.stringify({ active: active })
      });
      await loadRequestLinks();
    }

    async function deleteRequestLink(code) {
      openConfirmModal({
        title: '删除收集链接？',
        text: '此操作不可撤销。',
        danger: true,
        onConfirm: async function() {
          await request('/api/request-links/' + encodeURIComponent(code), { method: 'DELETE' });
          await loadRequestLinks();
        }
      });
    }

    async function batchDeleteSelectedRl() {
      const codes = Array.from(document.querySelectorAll('.rl-check:checked')).map(el => el.value);
      if (!codes.length) { showToast('请先选择收集链接', 'error'); return; }
      if (!confirm('删除选中的 ' + codes.length + ' 个收集链接?')) return;
      var failed = 0;
      for (var i = 0; i < codes.length; i++) {
        var resp = await fetch('/api/request-links/' + encodeURIComponent(codes[i]), { method: 'DELETE', headers: headers() });
        if (!resp.ok) failed++;
      }
      showToast(failed ? codes.length - failed + '/' + codes.length + ' 已删除，' + failed + ' 失败' : codes.length + ' 个已删除', failed ? 'warn' : 'success');
      clearRlSelection();
      await loadRequestLinks();
    }

    // ── Request Link Files Modal ─────────────────────────────────────────────

    function openRequestLinkFilesModal(code) {
      window._currentRlCode = code;
      var rl = currentRequestLinks.find(function(r) { return r.code === code; });
      if (!rl) return;
      var modal = document.createElement('div');
      modal.id = 'requestLinkFilesModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px';
      modal.innerHTML = '\
        <div style="background:var(--bg-secondary);border-radius:14px;padding:24px;width:100%;max-width:580px;font-size:14px;max-height:85vh;overflow-y:auto">\
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">\
            <h3 style="margin:0">📁 已收集文件 — ' + escapeHtmlClient(rl.name) + '</h3>\
          </div>\
          <div style="font-size:12px;color:var(--muted);margin-bottom:16px">收集链接: /r/' + escapeHtmlClient(code) + '</div>\
          <div id="rlFilesBody" style="min-height:60px"><span style="color:var(--muted)">加载中...</span></div>\
          <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:8px">\
            <div style="display:flex;align-items:center;gap:8px">\
              <input type="checkbox" id="rlFilesSelectAll" onchange="toggleRlFilesSelectAll(this.checked)" style="cursor:pointer">\
              <button id="rlBatchDeleteBtn" onclick="batchDeleteRlFiles()" style="padding:4px 12px;background:var(--error);color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;display:none">删除选中</button>\
            </div>\
            <div style="display:flex;gap:8px">\
              <button class="secondary" onclick="downloadRequestLinkZip(\'' + escapeHtmlClient(code) + '\', this)" id="rlZipBtn" style="font-size:13px">📦 打包下载</button>\
              <button class="secondary" onclick="closeRlFilesModal()">关闭</button>\
            </div>\
          </div>\
        </div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function(e) { if (e.target === modal) closeRlFilesModal(); });
      loadRequestLinkFiles(code);
    }

    function closeRlFilesModal() {
      window._currentRlCode = '';
      var m = document.getElementById('requestLinkFilesModal');
      if (m) m.remove();
    }

    async function loadRequestLinkFiles(code) {
      var res = await fetch('/api/request-links/' + encodeURIComponent(code) + '/files', { headers: headers() });
      var data = await res.json();
      var body = document.getElementById('rlFilesBody');
      if (!data.success) { body.innerHTML = '<div style="color:var(--error);padding:10px">加载失败: ' + (data.error || '') + '</div>'; return; }
      var files = data.files || [];
      var zipBtn = document.getElementById('rlZipBtn');
      if (zipBtn) zipBtn.disabled = !files.length;
      if (!files.length) {
        body.innerHTML = '<div style="text-align:center;color:var(--muted);padding:30px">暂无文件</div>';
        return;
      }
      var totalSize = files.reduce(function(s, f) { return s + (f.size || 0); }, 0);
      var totalSizeStr = totalSize > 0 ? ' · <span style="color:var(--muted)">' + formatFileSize(totalSize) + '</span>' : '';
      var html = '<div style="margin-bottom:10px"><strong>' + files.length + '</strong> 个文件' + totalSizeStr + '</div>';
      html += '<div style="display:flex;flex-direction:column;gap:6px">';
      files.forEach(function(f) {
        var size = formatFileSize(f.size);
        var time = new Date(f.uploaded_at * 1000).toLocaleString('zh-CN');
        html += '<div style="display:flex;align-items:center;padding:8px 10px;background:var(--bg);border-radius:8px;gap:10px;border:1px solid var(--line)">';
        html += '<input type="checkbox" class="rl-file-check" data-id="' + f.id + '" onchange="updateRlBatchDeleteBtn()" style="cursor:pointer;flex-shrink:0">';
        html += '<span style="font-size:18px;flex-shrink:0">' + getFileIcon(f.filename) + '</span>';
        html += '<div style="flex:1;min-width:0">';
        html += '<div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtmlClient(f.filename) + '">' + escapeHtmlClient(f.filename) + '</div>';
        html += '<div style="font-size:11px;color:var(--muted)">' + size + ' · ' + time + '</div>';
        html += '</div>';
        html += '<button onclick="downloadRlFile(\'' + escapeHtmlClient(code) + '\',\'' + escapeHtmlClient(f.filename) + '\')" style="padding:4px 10px;background:var(--bg-tertiary);color:var(--text);border:1px solid var(--line);border-radius:6px;cursor:pointer;font-size:12px">下载</button>';
        html += '<button onclick="deleteRequestLinkFile(\'' + escapeHtmlClient(code) + '\',' + f.id + ',this)" style="padding:4px 10px;background:var(--error);color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px">删除</button>';
        html += '</div>';
      });
      html += '</div>';
      body.innerHTML = html;
    }

    async function deleteRequestLinkFile(code, fileId, btn) {
      if (!confirm('确认删除此文件？')) return;
      btn.disabled = true;
      try {
        var res = await fetch('/api/request-links/' + encodeURIComponent(code) + '/files/' + fileId, { method: 'DELETE', headers: headers() });
        var data = await res.json();
        if (data.success) {
          showToast('已删除', 'success');
          loadRequestLinkFiles(code);
        } else {
          showToast(data.error || '删除失败', 'error');
          btn.disabled = false;
        }
      } catch(e) {
        showToast('删除失败', 'error');
        btn.disabled = false;
      }
    }

    function downloadRequestLinkZip(code, btn) {
      var a = document.createElement('a');
      a.href = '/api/request-links/' + encodeURIComponent(code) + '/files/zip';
      a.download = 'request_link_' + code + '.zip';
      var orig = btn.textContent;
      btn.textContent = '生成中...';
      btn.disabled = true;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function() { btn.textContent = orig; btn.disabled = false; }, 3000);
    }

    function downloadRlFile(code, filename) {
      fetch('/download/' + encodeURIComponent(filename), { headers: headers() }).then(function(resp) {
        if (!resp.ok) { showToast('下载失败', 'error'); return; }
        return resp.blob();
      }).then(function(blob) {
        if (!blob) return;
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }).catch(function() { showToast('下载失败', 'error'); });
    }

    function toggleRlFilesSelectAll(checked) {
      document.querySelectorAll('.rl-file-check').forEach(function(el) { el.checked = checked; });
      updateRlBatchDeleteBtn();
    }

    function updateRlBatchDeleteBtn() {
      var checked = document.querySelectorAll('.rl-file-check:checked');
      var btn = document.getElementById('rlBatchDeleteBtn');
      if (!btn) return;
      if (checked.length > 0) {
        btn.style.display = '';
        btn.textContent = '删除选中 (' + checked.length + ')';
      } else {
        btn.style.display = 'none';
      }
    }

    async function batchDeleteRlFiles() {
      var checked = document.querySelectorAll('.rl-file-check:checked');
      if (!checked.length) { showToast('请先选择文件', 'error'); return; }
      if (!confirm('确认删除 ' + checked.length + ' 个文件？')) return;
      var code = _currentRlCode;
      var ids = Array.from(checked).map(function(el) { return parseInt(el.dataset.id, 10); });
      var btn = document.getElementById('rlBatchDeleteBtn');
      if (btn) { btn.disabled = true; btn.textContent = '删除中...'; }
      var ok = 0, fail = 0;
      for (var i = 0; i < ids.length; i++) {
        try {
          var res = await fetch('/api/request-links/' + encodeURIComponent(code) + '/files/' + ids[i], { method: 'DELETE', headers: headers() });
          var data = await res.json();
          if (data.success) ok++; else fail++;
        } catch(e) { fail++; }
      }
      if (btn) { btn.disabled = false; updateRlBatchDeleteBtn(); }
      showToast('已删除 ' + ok + ' 个文件' + (fail ? '，失败 ' + fail : ''), fail ? 'error' : 'success');
      loadRequestLinkFiles(code);
    }

    // Store current RL code for batch operations
    window._currentRlCode = '';

    var selectedDuplicates = new Set();

    async function loadDuplicates() {
      var data = await request('/api/duplicates');
      renderDuplicates(data.duplicates || []);
    }

    function renderDuplicates(groups) {
      var list = document.getElementById('duplicatesList');
      var empty = document.getElementById('duplicatesEmpty');
      selectedDuplicates.clear();
      updateDuplicatesDeleteBtn();
      if (!groups || groups.length === 0) {
        list.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      list.innerHTML = groups.map(function(group, gi) {
        var groupId = 'dupe-group-' + gi;
        var shortHash = group.hash ? group.hash.substring(0, 12) : '?';
        return '<div style="margin-bottom:16px;border:1px solid var(--line);border-radius:10px;overflow:hidden">' +
          '<div style="background:var(--bg-secondary);padding:8px 12px;font-size:12px;color:var(--muted);display:flex;justify-content:space-between;align-items:center">' +
            '<span>' + group.count + ' 个相同文件 · ' + shortHash + '</span>' +
            '<span style="cursor:pointer" onclick="toggleDupeGroup(\'' + groupId + '\')">[展开/折叠]</span>' +
          '</div>' +
          '<div id="' + groupId + '" style="padding:8px">' +
            group.files.map(function(file) {
              var fid = 'dupe-' + file.id;
              return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px">' +
                '<input type="checkbox" id="' + fid + '" onchange="toggleDupeSelect(\'' + file.id + '\', this.checked)" style="flex-shrink:0">' +
                '<label for="' + fid + '" style="flex:1;min-width:0;cursor:pointer;word-break:break-all">' + escapeHtmlClient(file.filename) + '</label>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</div>';
      }).join('');
    }

    function toggleDupeGroup(id) {
      var el = document.getElementById(id);
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }

    function toggleDupeSelect(id, checked) {
      if (checked) {
        selectedDuplicates.add(parseInt(id, 10));
      } else {
        selectedDuplicates.delete(parseInt(id, 10));
      }
      updateDuplicatesDeleteBtn();
    }

    function updateDuplicatesDeleteBtn() {
      var btn = document.getElementById('duplicatesDeleteBtn');
      var count = selectedDuplicates.size;
      if (count > 0) {
        btn.style.display = 'inline-block';
        btn.textContent = '删除选中 (' + count + ')';
      } else {
        btn.style.display = 'none';
      }
    }

    async function deleteSelectedDuplicates() {
      if (selectedDuplicates.size === 0) return;
      if (!confirm('删除选中的 ' + selectedDuplicates.size + ' 个文件?')) return;
      var ids = Array.from(selectedDuplicates);
      var promises = ids.map(function(id) {
        return request('/api/files/' + encodeURIComponent(id), { method: 'DELETE' });
      });
      await Promise.all(promises);
      showToast('已删除 ' + ids.length + ' 个重复文件', 'success');
      selectedDuplicates.clear();
      await loadDuplicates();
      await loadFiles();
    }

    // ── Notifications ───────────────────────────────────────────────────────

    function toggleNotificationPanel() {
      var panel = document.getElementById('notifPanel');
      if (panel.style.display === 'none') {
        panel.style.display = 'block';
        loadNotifications();
      } else {
        panel.style.display = 'none';
      }
    }

    async function loadNotifications() {
      var data = await request('/api/notifications');
      var notifs = data.notifications || [];
      var countData = await request('/api/notifications/unread-count');
      updateNotifBadge(countData.unread_count || 0);
      renderNotificationList(notifs);
    }

    async function loadUnreadNotifCount() {
      var countData = await request('/api/notifications/unread-count');
      updateNotifBadge(countData.unread_count || 0);
    }

    function updateNotifBadge(count) {
      var badge = document.getElementById('notifBadge');
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    }

    function renderNotificationList(notifs) {
      var list = document.getElementById('notifList');
      var empty = document.getElementById('notifEmpty');
      if (!notifs || notifs.length === 0) {
        list.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      list.innerHTML = notifs.map(function(n) {
        var timeAgo = formatTime(n.created_at ? n.created_at * 1000 : Date.now());
        var unread = n.read === 0 || n.read === false ? 'font-weight:bold' : 'opacity:0.6';
        return '<div style="padding:8px 0;border-bottom:1px solid var(--line);' + unread + '" id="notif-' + n.id + '">' +
          '<div style="display:flex;justify-content:space-between;align-items:start;gap:8px">' +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-size:13px;margin-bottom:2px">' + escapeHtmlClient(n.title || n.type || '通知') + '</div>' +
              (n.message ? '<div style="font-size:12px;color:var(--muted);word-break:break-all">' + escapeHtmlClient(n.message) + '</div>' : '') +
            '</div>' +
            '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">' +
              '<span style="font-size:11px;color:var(--muted)">' + timeAgo + '</span>' +
              '<div style="display:flex;gap:4px">' +
                (n.read === 0 || n.read === false ? '<button class="ghost" onclick="markNotificationRead(' + n.id + ')" style="font-size:10px;padding:2px 6px">已读</button>' : '') +
                '<button class="ghost" onclick="deleteNotification(' + n.id + ')" style="font-size:10px;padding:2px 6px;color:var(--danger)">删除</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    async function markNotificationRead(id) {
      await request('/api/notifications/mark-read', {
        method: 'POST',
        body: JSON.stringify({ id: id })
      });
      await loadNotifications();
    }

    async function markAllNotificationsRead() {
      await request('/api/notifications/mark-read', {
        method: 'POST',
        body: JSON.stringify({ all: true })
      });
      await loadNotifications();
    }

    async function deleteNotification(id) {
      await request('/api/notifications', {
        method: 'DELETE',
        body: JSON.stringify({ id: id })
      });
      await loadNotifications();
    }

    async function clearAllNotifications() {
      openConfirmModal({
        title: '清空所有通知？',
        text: '此操作不可撤销。',
        danger: true,
        onConfirm: async function() {
          await request('/api/notifications', { method: 'DELETE' });
          await loadNotifications();
        }
      });
    }

    function toggleShareSelectAll(checked) {
      document.querySelectorAll('.share-check').forEach(function(el) { el.checked = checked; });
      updateShareBatchBar();
    }

    function onShareCheckChange() {
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

    async function batchCopySelectedShares() {
      var checked = document.querySelectorAll('.share-check:checked');
      var shares = Array.from(checked).map(function(el) {
        return currentShares.find(function(s) { return s.code === el.getAttribute('data-code'); });
      }).filter(Boolean);
      if (!shares.length) { showToast('请先选择链接', 'error'); return; }
      var urls = shares.map(function(s) { return s.url; }).join('\n');
      await copyToClipboard(urls);
      showToast('已复制 ' + shares.length + ' 个链接', 'success');
    }

    async function batchDownloadSelectedQrs() {
      var checked = document.querySelectorAll('.share-check:checked');
      var codes = Array.from(checked).map(function(el) { return el.getAttribute('data-code'); });
      if (!codes.length) { showToast('请先选择链接', 'error'); return; }
      showToast('开始下载 ' + codes.length + ' 个二维码...');
      var count = 0;
      for (var i = 0; i < codes.length; i++) {
        try {
          var response = await fetch('/api/share/qr/' + encodeURIComponent(codes[i]));
          if (!response.ok) continue;
          var blob = await response.blob();
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'share-qr-' + codes[i] + '.png';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          count++;
          await new Promise(function(r) { setTimeout(r, 200); });
        } catch(e) {}
      }
      showToast('已下载 ' + count + ' 个二维码', 'success');
    }

    function clearShareSelection() {
      document.querySelectorAll('.share-check').forEach(function(el) { el.checked = false; });
      document.getElementById('shareListSelectAll').checked = false;
      updateShareBatchBar();
    }

    function openBatchShareUpdateModal() {
      var checked = document.querySelectorAll('.share-check:checked');
      if (!checked.length) { showToast('请先选择链接', 'error'); return; }
      document.getElementById('modalTitle').textContent = '批量更新分享链接 (' + checked.length + ')';
      document.getElementById('modalBody').innerHTML = '\
        <div style="display:flex;flex-direction:column;gap:14px;padding:4px 0">\
          <div>\
            <label style="display:block;margin-bottom:6px;font-size:13px;font-weight:500">到期时间</label>\
            <input id="batchShareExpiry" type="datetime-local" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg2);color:var(--text);font-size:14px;box-sizing:border-box">\
            <p style="font-size:11px;color:var(--muted);margin-top:4px">留空表示保持不变，设值则批量更新</p>\
          </div>\
          <div>\
            <label style="display:block;margin-bottom:6px;font-size:13px;font-weight:500">最大下载次数</label>\
            <input id="batchShareMaxDl" type="number" min="0" placeholder="留空保持不变" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg2);color:var(--text);font-size:14px;box-sizing:border-box">\
          </div>\
          <div>\
            <label style="display:block;margin-bottom:6px;font-size:13px;font-weight:500">密码保护</label>\
            <input id="batchSharePwd" type="text" placeholder="留空保持不变，填 none 则清除密码" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg2);color:var(--text);font-size:14px;box-sizing:border-box">\
          </div>\
          <div>\
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">\
              <input type="checkbox" id="batchShareActive">\
              <span>设为激活状态（勾选后激活，取消则保持不变）</span>\
            </label>\
          </div>\
        </div>';
      document.getElementById('modalFooter').innerHTML = '\
        <button class="secondary" onclick="forceCloseModal()">取消</button>\
        <button onclick="confirmBatchShareUpdate(' + checked.length + ')">确认更新</button>';
      openModal();
    }

    async function confirmBatchShareUpdate(count) {
      var checked = document.querySelectorAll('.share-check:checked');
      var codes = Array.from(checked).map(function(el) { return el.getAttribute('data-code'); });
      if (!codes.length) return;
      var expiry = document.getElementById('batchShareExpiry').value;
      var maxDl = document.getElementById('batchShareMaxDl').value;
      var pwd = document.getElementById('batchSharePwd').value;
      var activate = document.getElementById('batchShareActive').checked;
      var count2 = 0;
      for (var i = 0; i < codes.length; i++) {
        var updates = {};
        if (expiry) updates.expiresAt = new Date(expiry).getTime();
        if (maxDl !== '') updates.maxDownloads = maxDl ? parseInt(maxDl, 10) : 0;
        if (pwd === 'none') updates.password = null;
        else if (pwd) updates.password = pwd;
        if (activate) updates.active = true;
        var keys = Object.keys(updates);
        if (keys.length === 0) continue;
        await request('/api/share/update/' + encodeURIComponent(codes[i]), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
        });
        count2++;
      }
      forceCloseModal();
      showToast('已更新 ' + count2 + ' 个分享链接', 'success');
      await loadShares();
    }

    // ── Share Analytics ────────────────────────────────────────────────
    async function openShareAnalytics() {
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '📈 分享分析';
      body.innerHTML = '<div class="loading">加载中…</div>';
      modal.classList.add('active');

      try {
        var data = await request('/api/share/stats');
        if (!data.success) throw new Error(data.error || '获取失败');
        var s = data.stats;

        var card = function(label, value, sub, color) {
          return '<div style="background:var(--bg-secondary);border-radius:12px;padding:16px;min-width:100px">' +
            '<div style="font-size:11px;color:var(--muted);margin-bottom:6px">' + label + '</div>' +
            '<div style="font-size:28px;font-weight:700;color:' + (color || 'var(--text)') + '">' + value + '</div>' +
            (sub ? '<div style="font-size:11px;color:var(--muted);margin-top:4px">' + sub + '</div>' : '') +
            '</div>';
        };

        var html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;margin-bottom:20px">';
        html += card('总链接', s.total);
        html += card('有效', s.active, null, '#10b981');
        html += card('已过期', s.expired, null, '#ef4444');
        html += card('密码保护', s.withPassword);
        html += card('总浏览', s.totalViews);
        html += card('总下载', s.totalDownloads);
        html += card('限次数', s.withMaxDl);
        html += card('已耗尽', s.atMaxDl, null, '#f59e0b');
        html += '</div>';

        // Top by views
        var topViewsRows = '';
        if (s.topByViews && s.topByViews.length) {
          s.topByViews.forEach(function(r, i) {
            var barW = s.totalViews > 0 ? Math.round(r.views / s.totalViews * 100) : 0;
            topViewsRows += '<div style="margin-bottom:10px">' +
              '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">' +
              '<span style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtmlClient(r.filename) + '">' + (i + 1) + '. ' + escapeHtmlClient(r.filename) + '</span>' +
              '<span style="color:var(--muted)">' + r.views + ' 次</span></div>' +
              '<div style="background:var(--bg-tertiary);border-radius:4px;height:6px;overflow:hidden">' +
              '<div style="height:6px;width:' + barW + '%;background:#6366f1;border-radius:4px"></div></div></div>';
          });
        } else {
          topViewsRows = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:12px">暂无数据</div>';
        }

        // Top by downloads
        var topDlRows = '';
        if (s.topByDownloads && s.topByDownloads.length) {
          s.topByDownloads.forEach(function(r, i) {
            var barW = s.totalDownloads > 0 ? Math.round(r.downloads / s.totalDownloads * 100) : 0;
            topDlRows += '<div style="margin-bottom:10px">' +
              '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">' +
              '<span style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtmlClient(r.filename) + '">' + (i + 1) + '. ' + escapeHtmlClient(r.filename) + '</span>' +
              '<span style="color:var(--muted)">' + r.downloads + ' 次</span></div>' +
              '<div style="background:var(--bg-tertiary);border-radius:4px;height:6px;overflow:hidden">' +
              '<div style="height:6px;width:' + barW + '%;background:#10b981;border-radius:4px"></div></div></div>';
          });
        } else {
          topDlRows = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:12px">暂无数据</div>';
        }

        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">' +
          '<div style="background:var(--bg-secondary);border-radius:12px;padding:16px">' +
          '<div style="font-weight:600;margin-bottom:14px;font-size:13px">🏆 浏览量 TOP 10</div>' + topViewsRows + '</div>' +
          '<div style="background:var(--bg-secondary);border-radius:12px;padding:16px">' +
          '<div style="font-weight:600;margin-bottom:14px;font-size:13px">📥 下载量 TOP 10</div>' + topDlRows + '</div></div>';

        body.innerHTML = html;
      } catch (e) {
        body.innerHTML = '<p class="muted">加载失败: ' + escapeHtmlClient(e.message) + '</p>';
      }
    }

    async function openExpiringShares() {
      var modal = document.getElementById('modal');
      var title = document.getElementById('modalTitle');
      var body = document.getElementById('modalBody');
      title.textContent = '⏰ 即将过期';
      body.innerHTML = '<div class="loading">加载中…</div>';
      modal.classList.add('active');

      try {
        var data = await request('/api/share/expiring?days=30');
        if (!data.success) throw new Error(data.error || '获取失败');
        var rows = data.shares || [];

        if (!rows.length) {
          body.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted)">未来30天内没有即将过期的分享链接</div>';
          return;
        }

        var urgentRows = rows.filter(function(r) { return r.daysLeft <= 3; });
        var soonRows = rows.filter(function(r) { return r.daysLeft > 3; });

        var makeRows = function(items) {
          var h = '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
            '<thead><tr style="border-bottom:1px solid var(--line);color:var(--muted)">' +
            '<th style="text-align:left;padding:6px 8px">文件</th><th style="text-align:center;padding:6px 8px">剩余</th><th style="text-align:right;padding:6px 8px">浏览</th><th style="text-align:right;padding:6px 8px">下载</th><th style="text-align:right;padding:6px 8px">操作</th></tr></thead><tbody>';
          items.forEach(function(r) {
            var color = r.daysLeft <= 1 ? '#ef4444' : r.daysLeft <= 3 ? '#f59e0b' : '#94a3b8';
            h += '<tr style="border-bottom:1px solid var(--line)">' +
              '<td style="padding:6px 8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtmlClient(r.filename) + '">' + escapeHtmlClient(r.filename) + '</td>' +
              '<td style="padding:6px 8px;text-align:center;color:' + color + ';font-weight:600">' + r.daysLeft + '天</td>' +
              '<td style="padding:6px 8px;text-align:right;color:var(--muted)">' + (r.views || 0) + '</td>' +
              '<td style="padding:6px 8px;text-align:right;color:var(--muted)">' + (r.downloads || 0) + '</td>' +
              '<td style="padding:6px 8px;text-align:right"><button onclick="extendShareExpiry(\'' + escapeHtmlClient(r.code).replace(/'/g, "\\'") + '\')" class="secondary" style="font-size:11px;padding:3px 8px">续期</button></td></tr>';
          });
          h += '</tbody></table>';
          return h;
        };

        var html = '<div style="max-height:500px;overflow-y:auto">';
        if (urgentRows.length) {
          html += '<div style="margin-bottom:16px"><div style="font-weight:600;margin-bottom:8px;font-size:13px;color:#ef4444">🔥 紧急（3天内）' + urgentRows.length + '个</div>' + makeRows(urgentRows) + '</div>';
        }
        if (soonRows.length) {
          html += '<div><div style="font-weight:600;margin-bottom:8px;font-size:13px;color:var(--muted)">📅 近期（4-30天）' + soonRows.length + '个</div>' + makeRows(soonRows) + '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
      } catch (e) {
        body.innerHTML = '<p class="muted">加载失败: ' + escapeHtmlClient(e.message) + '</p>';
      }
    }

    async function extendShareExpiry(code) {
      var days = prompt('延长多少天？', '30');
      if (!days || isNaN(parseInt(days))) return;
      var newExpiry = Date.now() + parseInt(days) * 86400000;
      try {
        var data = await request('/api/share/update/' + encodeURIComponent(code), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresAt: newExpiry })
        });
        if (data.success) { showToast('已续期', 'success'); openExpiringShares(); }
        else showToast('续期失败: ' + (data.error || ''), 'error');
      } catch (e) { showToast('续期失败: ' + e.message, 'error'); }
    }

    async function batchDeleteSelectedShares() {
      var checked = document.querySelectorAll('.share-check:checked');
      var codes = Array.from(checked).map(function(el) { return el.getAttribute('data-code'); });
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
      document.getElementById('recentSearches').style.display = 'none';
      document.getElementById('savedSearchesPanel').style.display = 'none';
      document.getElementById('searchResultChip').style.display = 'none';
      currentSearchQuery = '';
      localStorage.removeItem('lastSearchQuery');
      loadFiles();
      document.getElementById('searchInput').focus();
    }

    function openSavedSearchesPanel() {
      document.getElementById('savedSearchesPanel').style.display = 'block';
      document.getElementById('searchSuggestions').style.display = 'none';
      renderSavedSearches();
    }
    window.openSavedSearchesPanel = openSavedSearchesPanel;
    function closeSavedSearchesPanel() {
      document.getElementById('savedSearchesPanel').style.display = 'none';
    }
    window.closeSavedSearchesPanel = closeSavedSearchesPanel;

    function filterByExt(ext) {
      // Use glob-style search: .ext at end of filename
      var q = ext ? '.' + ext + '$' : '';
      document.getElementById('searchInput').value = q;
      document.getElementById('searchClear').style.display = q ? 'block' : 'none';
      currentSearchQuery = q;
      loadFiles();
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
    restoreSearchState();
    var currentSort = localStorage.getItem('sortBy') || 'updated_at';
    var currentOrder = localStorage.getItem('sortOrder') || 'desc';
    var currentTypeFilters = localStorage.getItem('typeFilters')
      ? localStorage.getItem('typeFilters').split(',').filter(Boolean)
      : [];
    var currentTagFilters = localStorage.getItem('tagFilters')
      ? localStorage.getItem('tagFilters').split(',').filter(Boolean)
      : [];
    // Folder tag definitions cache (fetched from API)
    window._folderTagDefinitions = [];
    // Active folder tag filter (tagId as string or null)
    window._activeFolderTagFilter = null;

    // Initialize sort arrows on page load
    ['filename', 'size', 'updated_at', 'position', 'starred'].forEach(function(c) {
      var arrow = document.getElementById('arrow-' + c);
      if (arrow) {
        arrow.textContent = c === currentSort ? (currentOrder === 'asc' ? '↑' : '↓') : '';
        arrow.className = 'sort-arrow' + (c === currentSort ? ' active' : '');
      }
    });

    // Initialize type filter chips from localStorage
    updateTypeFilterChips();

    // Type filter chips (multi-select)
    function setTypeFilter(type) {
      // 'recent' triggers recent-files mode instead of type filtering
      if (type === 'recent') {
        isRecentFilesMode = false; // reset first so showRecentFiles can detect entering
        showRecentFiles();
        return;
      }
      var idx = currentTypeFilters.indexOf(type);
      if (idx === -1) {
        currentTypeFilters.push(type);
      } else {
        currentTypeFilters.splice(idx, 1);
      }
      localStorage.setItem('typeFilters', currentTypeFilters.join(','));
      updateTypeFilterChips();
      loadFiles();
    }

    function updateTypeFilterChips() {
      document.querySelectorAll('.type-chip').forEach(function(c) {
        var t = c.getAttribute('data-type');
        c.classList.toggle('active', t === '' ? currentTypeFilters.length === 0 : currentTypeFilters.indexOf(t) !== -1);
      });
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
        if (arrow) {
          arrow.textContent = c === currentSort ? (currentOrder === 'asc' ? '↑' : '↓') : '';
          arrow.className = 'sort-arrow' + (c === currentSort ? ' active' : '');
        }
      });
      updateSortDropdownLabel();
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
          fetch('/api/thumbnail/' + encodeURIComponent(filename), { headers: headers() })
            .then(function (r) {
              if (!r.ok) throw new Error('thumb failed');
              return r.blob();
            })
            .then(function (blob) {
              var img = document.createElement('img');
              img.src = URL.createObjectURL(blob);
              img.alt = filename;
              img.style = 'width:100%;height:64px;object-fit:cover;border-radius:4px;display:block';
              // Save original placeholder before replacing
              wrap.dataset.origIcon = wrap.querySelector('.img-placeholder') ? wrap.querySelector('.img-placeholder').outerHTML : '';
              wrap.innerHTML = '';
              wrap.appendChild(img);
              img.onload = function () {
                URL.revokeObjectURL(img.src);
                observer.unobserve(wrap);
              };
              img.onerror = function () {
                URL.revokeObjectURL(img.src);
                if (wrap.dataset.origIcon) {
                  wrap.innerHTML = wrap.dataset.origIcon;
                }
                observer.unobserve(wrap);
              };
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

    // Mobile bottom navigation
    function switchMobileNav(panel) {
      document.querySelectorAll('.mobile-nav-btn').forEach(function(btn) {
        var isActive = btn.dataset.panel === panel;
        btn.classList.toggle('active', isActive);
        btn.style.color = isActive ? 'var(--accent)' : 'var(--muted)';
        btn.style.borderRadius = isActive ? '10px' : '';
      });
      var filesPanel = document.getElementById('filesPanel');
      var uploadSection = document.getElementById('uploadSection');
      var sharesSection = document.querySelector('.shares');
      var rlSection = document.querySelector('.request-links');
      var settingsPanel = document.getElementById('settingsPanel');
      [filesPanel, uploadSection, sharesSection, rlSection].forEach(function(el) {
        if (el) el.classList.add('mobile-hidden');
      });
      if (panel === 'files') {
        if (filesPanel) filesPanel.classList.remove('mobile-hidden');
      } else if (panel === 'upload') {
        if (uploadSection) uploadSection.classList.remove('mobile-hidden');
      } else if (panel === 'shares') {
        if (filesPanel) filesPanel.classList.remove('mobile-hidden');
        if (sharesSection) sharesSection.classList.remove('mobile-hidden');
      } else if (panel === 'rl') {
        if (filesPanel) filesPanel.classList.remove('mobile-hidden');
        if (rlSection) rlSection.classList.remove('mobile-hidden');
      } else if (panel === 'settings') {
        if (filesPanel) filesPanel.classList.remove('mobile-hidden');
        if (settingsPanel) { settingsPanel.classList.remove('mobile-hidden'); settingsPanel.style.display = 'block'; }
      }
      window.scrollTo(0, 0);
    }
    window.switchMobileNav = switchMobileNav;

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
      // Skip if typing in an input/textarea
      var active = document.activeElement;
      var tag = active && active.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // Ctrl+K or Ctrl+F: open unified search overlay
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        openUnifiedSearchOverlay();
        return;
      }
      // ?: show shortcuts help
      if (e.key === '?') {
        var existing = document.getElementById('shortcutsHelp');
        if (existing) { existing.remove(); return; }
        var div = document.createElement('div');
        div.id = 'shortcutsHelp';
        div.style.cssText = 'position:fixed;bottom:60px;right:16px;background:var(--bg-secondary);border:1px solid var(--line);border-radius:12px;padding:16px 20px;min-width:240px;font-size:12px;z-index:1000;box-shadow:0 4px 20px rgba(0,0,0,0.15)';
        var shortcuts = [
          ['Ctrl+K', '全屏搜索'],
          ['?', '显示/隐藏快捷键'],
          ['r', '刷新文件列表'],
          ['f', '聚焦搜索框'],
          ['n', '新建文本文件'],
          ['Ctrl+V', '粘贴图片/文件上传'],
          ['Enter', '打开/预览文件'],
          ['← / →', '预览中切换图片'],
          ['j/k', 'vim导航'],
          ['d', '删除选中文件'],
          ['e', '重命名选中文件'],
          ['i', '显示文件属性'],
          ['c / l', '复制分享链接'],
          ['y', '复制文件名'],
          ['s', '标记/取消标记收藏'],
          ['t', '批量添加标签'],
          ['o', '已保存搜索'],
          ['v', '切换网格/列表视图'],
          ['Ctrl+A', '全选文件'],
          ['Ctrl+,', '打开设置'],
          ['Ctrl+Enter', '上传/保存'],
          ['Space', '选择/取消'],
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
      // Ctrl/Cmd + K: focus search (VS Code / GitHub style)
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('searchInput').focus();
        document.getElementById('searchInput').select();
      }
      // Ctrl/Cmd + ,: open settings
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        openSettings();
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
          batchDeleteSelected();
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
      // l: copy share link (alias for c)
      if (e.key === 'l' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        var checked = document.querySelectorAll('.file-check:checked');
        var fnL = null;
        if (checked.length === 1) {
          var item = checked[0].closest('tr') || checked[0].closest('.file-item');
          fnL = item && (item.getAttribute('data-filename') || item.querySelector('.filename') && item.querySelector('.filename').textContent);
        } else if (keyboardNavIndex >= 0) {
          var items = getAllFileItems();
          var item = items[keyboardNavIndex];
          fnL = item && (item.getAttribute('data-filename') || item.querySelector('.filename') && item.querySelector('.filename').textContent);
        }
        if (fnL) { copyShareLink(fnL.trim()); }
        return;
      }
      // y: copy filename of selected/navigated file
      if (e.key === 'y' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        var checked = document.querySelectorAll('.file-check:checked');
        var fnY = null;
        if (checked.length === 1) {
          var item = checked[0].closest('tr') || checked[0].closest('.file-item');
          fnY = item && (item.getAttribute('data-filename') || item.querySelector('.filename') && item.querySelector('.filename').textContent);
        } else if (keyboardNavIndex >= 0) {
          var items = getAllFileItems();
          var item = items[keyboardNavIndex];
          fnY = item && (item.getAttribute('data-filename') || item.querySelector('.filename') && item.querySelector('.filename').textContent);
        }
        if (fnY) {
          navigator.clipboard.writeText(fnY.trim()).then(function() { showToast('文件名已复制', 'info', 1500); });
        }
        return;
      }
      // i: show file info of selected/navigated file
      if (e.key === 'i' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        var checked = document.querySelectorAll('.file-check:checked');
        var fnI = null;
        if (checked.length === 1) {
          var item = checked[0].closest('tr') || checked[0].closest('.file-item');
          fnI = item && (item.getAttribute('data-filename') || item.querySelector('.filename') && item.querySelector('.filename').textContent);
        } else if (keyboardNavIndex >= 0) {
          var items = getAllFileItems();
          var item = items[keyboardNavIndex];
          fnI = item && (item.getAttribute('data-filename') || item.querySelector('.filename') && item.querySelector('.filename').textContent);
        }
        if (fnI) { showFileInfo(fnI.trim()); }
        return;
      }
      // Space: toggle selection of current file (without opening)
      if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        if (keyboardNavIndex >= 0) {
          var items = getAllFileItems();
          var item = items[keyboardNavIndex];
          if (item) {
            var cb = item.querySelector('.file-check');
            if (cb) { cb.checked = !cb.checked; updateBatchBar(); }
          }
        }
        return;
      }
      // s: toggle sort direction
      if (e.key === 's' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        currentOrder = currentOrder === 'asc' ? 'desc' : 'asc';
        localStorage.setItem('sortOrder', currentOrder);
        loadFiles();
        showToast('排序: ' + (currentOrder === 'desc' ? '最新优先' : '最旧优先'), 'info', 1500);
        return;
      }
      // v: toggle view mode (list/grid)
      if (e.key === 'v' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        setView(currentView === 'list' ? 'grid' : 'list');
        return;
      }
      // m: toggle theme
      if (e.key === 'm' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
        toggleTheme();
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
      // Home: jump to first file
      if (e.key === 'Home' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var active = document.activeElement;
        if (!(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT'))) {
          var items = getAllFileItems();
          if (items.length > 0) { setKeyboardNavIndex(0); applyNavHighlight(0); items[0].scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        }
        return;
      }
      // End: jump to last file
      if (e.key === 'End' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var active = document.activeElement;
        if (!(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT'))) {
          var items = getAllFileItems();
          if (items.length > 0) { var last = items.length - 1; setKeyboardNavIndex(last); applyNavHighlight(last); items[last].scrollIntoView({ behavior: 'smooth', block: 'end' }); }
        }
        return;
      }
      // Arrow keys in modal (image gallery): navigate prev/next
      var modalOpen = document.getElementById('modal') && document.getElementById('modal').classList.contains('open');
      if (modalOpen && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); navigateGallery(-1); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); navigateGallery(1); return; }
      }
    });

    Promise.all([loadFiles(), loadShares(), loadRequestLinks(), loadUnreadNotifCount()]).catch(function (error) {
      status(error.message);
    });

    // Real-time file change notifications via SSE
    (function initSSE() {
      var token = localStorage.getItem('st_auth_token') || STATIC_TOKEN;
      var es = new EventSource('/api/events?token=' + encodeURIComponent(token));
      es.addEventListener('files_changed', function (e) {
        // Skip reload if tab is hidden — wait until visible
        if (document.visibilityState === 'hidden') return;
        _cachedTagData = null;
        loadFiles();
        showToast('文件已更新', 'info', 3000);
      });
      es.addEventListener('batch_delete', function (e) {
        var data = JSON.parse(e.data || '{}');
        var filenames = data.filenames || [];
        // Incremental removal: remove each deleted file from DOM + currentFiles
        filenames.forEach(function(fn) {
          var idx = currentFiles.findIndex(function(f) { return f.name === fn; });
          if (idx !== -1) currentFiles.splice(idx, 1);
          var el = document.querySelector('[data-filename="' + encodeURIComponent(fn) + '"]');
          if (el) el.remove();
        });
        if (document.visibilityState === 'hidden') return;
        // Update stats bar
        var countEl = document.getElementById('fileCountDisplay');
        if (countEl) countEl.innerHTML = '共 <strong>' + currentFiles.length + '</strong> 个文件';
        _cachedTagData = null;
        showToast('批量删除完成：' + filenames.length + ' 个文件', 'success', 4000);
      });
      es.addEventListener('batch_rename', function (e) {
        if (document.visibilityState === 'hidden') return;
        var d = JSON.parse(e.data || '{}');
        showToast('批量重命名完成：' + (d.renamed || 0) + ' 个文件', 'success', 4000);
        loadFiles();
      });
      es.addEventListener('batch_move', function (e) {
        if (document.visibilityState === 'hidden') return;
        var d = JSON.parse(e.data || '{}');
        showToast('批量移动完成：' + (d.moved || 0) + ' 个文件', 'success', 4000);
        loadFiles();
      });
      es.addEventListener('batch_copy', function (e) {
        if (document.visibilityState === 'hidden') return;
        var d = JSON.parse(e.data || '{}');
        showToast('批量复制完成：' + (d.copied || 0) + ' 个文件', 'success', 4000);
        loadFiles();
      });
      es.onerror = function () {
        // Silently reconnect; EventSource auto reconnects
      };
    })();

    // Reload when tab becomes visible again — but only if we skipped a remote change
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        // Only force reload if there were pending remote changes (SSE events were skipped while hidden)
        loadFiles();
      }
    });
  </script>
  <script>
    // FAB + back-to-top auto-show/hide on mobile
    (function() {
      var fab = document.querySelector('.fab');
      var btt = document.getElementById('backToTop');
      if (!fab && !btt) return;
      var lastY = 0;
      var ticking = false;
      window.addEventListener('scroll', function() {
        if (!ticking) {
          requestAnimationFrame(function() {
            var y = document.documentElement.scrollTop || document.body.scrollTop;
            if (y > lastY && y > 100) {
              if (fab) { fab.style.opacity = '0'; fab.style.pointerEvents = 'none'; }
            } else {
              if (fab) { fab.style.opacity = ''; fab.style.pointerEvents = ''; }
            }
            if (btt) {
              if (y > 300) { btt.classList.add('visible'); } else { btt.classList.remove('visible'); }
            }
            lastY = y;
            ticking = false;
          });
          ticking = true;
        }
      }, { passive: true });
    })();
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
          // Remove synced queued items from browser upload queue
          if (data.syncedFilenames && data.syncedFilenames.length) {
            var syncedSet = new Set(data.syncedFilenames);
            var removed = 0;
            for (var i = uploadQueue.length - 1; i >= 0; i--) {
              if (uploadQueue[i].status === 'queued' && syncedSet.has(uploadQueue[i].name)) {
                uploadQueue.splice(i, 1);
                removed++;
              }
            }
            if (removed > 0) renderUploadQueuePanel();
          }
        }
        // Update offline pending count badge when SW reports it
        if (data.type === 'PENDING_COUNT') {
          var badge = document.getElementById('offlinePendingBadge');
          if (badge) {
            if (data.count > 0) {
              badge.textContent = data.count > 99 ? '99+' : data.count;
              badge.style.display = 'inline-block';
            } else {
              badge.style.display = 'none';
            }
          }
        }
      });
    }

    // Queue upload when offline — file: { filename, content, type, token }
    window.queueUpload = function(file) {
      if (!navigator.serviceWorker.controller) return false;
      var mc = new MessageChannel();
      navigator.serviceWorker.controller.postMessage(
        { type: 'QUEUE_UPLOAD', file: file },
        [mc.port2]
      );
      return true;
    };

    // Browser-side online/offline detection
    window.addEventListener('online', function() {
      var banner = document.getElementById('offline-banner');
      if (banner) banner.classList.remove('visible');
      syncUploads();
    });
    window.addEventListener('offline', function() {
      var banner = document.getElementById('offline-banner');
      if (banner) banner.classList.add('visible');
      // Check offline pending count when going offline
      if (window.getOfflinePendingCount) {
        window.getOfflinePendingCount().then(function(count) {
          var badge = document.getElementById('offlinePendingBadge');
          if (badge) {
            if (count > 0) {
              badge.textContent = count > 99 ? '99+' : count;
              badge.style.display = 'inline-block';
            } else {
              badge.style.display = 'none';
            }
          }
        });
      }
    });
    // Show offline banner on initial load if already offline
    if (!navigator.onLine) {
      var banner = document.getElementById('offline-banner');
      if (banner) banner.classList.add('visible');
    }

    // Trigger SW sync
    window.syncUploads = function() {
      if (!navigator.serviceWorker.controller) return;
      navigator.serviceWorker.controller.postMessage({ type: 'SYNC_UPLOADS' });
    };

    // Query IndexedDB pending upload count from SW
    window.getOfflinePendingCount = function() {
      if (!navigator.serviceWorker.controller) return Promise.resolve(0);
      return new Promise(function(resolve) {
        var mc = new MessageChannel();
        mc.port1.onmessage = function(e) {
          mc.port1.close();
          resolve(e.data && e.data.count || 0);
        };
        navigator.serviceWorker.controller.postMessage({ type: 'GET_PENDING_COUNT' }, [mc.port2]);
        // Timeout fallback
        setTimeout(function() {
          try { mc.port1.close(); } catch(e) {}
          resolve(0);
        }, 2000);
      });
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
      var sizeMin = (document.getElementById('sizeMin') || {}).value || '';
      var sizeMax = (document.getElementById('sizeMax') || {}).value || '';
      var dateFrom = (document.getElementById('dateFrom') || {}).value || '';
      var dateTo = (document.getElementById('dateTo') || {}).value || '';
      var typeFilter = (document.getElementById('typeFilter') || {}).value || '';
      var tagMatchFilter = (document.getElementById('tagMatchFilter') || {}).value || 'all';
      var hasFilters = sizeMin || sizeMax || dateFrom || dateTo || typeFilter;

      // Persist size/date/type filters to localStorage
      localStorage.setItem('adv_size_min', sizeMin);
      localStorage.setItem('adv_size_max', sizeMax);
      localStorage.setItem('adv_date_from', dateFrom);
      localStorage.setItem('adv_date_to', dateTo);
      localStorage.setItem('adv_type', typeFilter);
      localStorage.setItem('adv_tag_match', tagMatchFilter);

      // Update filter chips
      updateActiveFilterChips();

      // If no text query and no advanced filters, just return
      var q = (document.getElementById('searchInput') || {}).value.trim() || '';
      if (!q && !hasFilters) return;

      // Build search URL with all filters
      var params = [];
      if (q) params.push('q=' + encodeURIComponent(q));
      if (sizeMin) params.push('size_min=' + (parseInt(sizeMin) * 1024));
      if (sizeMax) params.push('size_max=' + (parseInt(sizeMax) * 1024));
      if (dateFrom) params.push('date_from=' + Math.floor(new Date(dateFrom).getTime() / 1000));
      if (dateTo) params.push('date_to=' + Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000));
      if (typeFilter) params.push('type=' + typeFilter);
      var tags = (document.getElementById('tagFilterInput') || {}).dataset.selectedTag || '';
      if (tags) params.push('tags=' + encodeURIComponent(tags));
      if (tagMatchFilter === 'any') params.push('tagMatch=any');
      var sort = document.getElementById('sortSelect') && document.getElementById('sortSelect').value;
      var order = document.getElementById('orderSelect') && document.getElementById('orderSelect').value;
      if (sort) params.push('sort=' + sort);
      if (order) params.push('order=' + order);
      // Append search mode (glob/regex bypass FTS5)
      if (_searchMode !== 'normal') params.push('mode=' + _searchMode);

      // Sync typeFilter into main type filter system
      if (typeFilter) {
        currentTypeFilters = [typeFilter];
        localStorage.setItem('typeFilters', typeFilter);
        updateTypeFilterChips();
      }

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
      ['adv_size_min','adv_size_max','adv_date_from','adv_date_to','adv_type','adv_tag_match'].forEach(function(k) {
        localStorage.removeItem(k);
      });
      currentTagFilters = [];
      localStorage.setItem('tagFilters', '');
      updateActiveFilterChips();
      renderTagChips();
      document.getElementById('searchResultChip').style.display = 'none';
      loadFiles();
    };

    // Restore advanced filters from localStorage on load
    (function restoreAdvancedFilters() {
      var ids = ['sizeMin','sizeMax','dateFrom','dateTo','typeFilter','tagMatchFilter'];
      var keys = ['adv_size_min','adv_size_max','adv_date_from','adv_date_to','adv_type','adv_tag_match'];
      ids.forEach(function(id, i) {
        var el = document.getElementById(id);
        var stored = localStorage.getItem(keys[i]);
        if (el && stored) el.value = stored;
      });
      // Sync typeFilter from advanced search into currentTypeFilters
      var advType = localStorage.getItem('adv_type');
      if (advType) {
        currentTypeFilters = [advType];
        localStorage.setItem('typeFilters', advType);
        updateTypeFilterChips();
      }
      // Restore tag filters
      var savedTags = localStorage.getItem('tagFilters');
      if (savedTags) {
        currentTagFilters = savedTags.split(',').filter(Boolean);
        renderTagChips();
      }
      // Restore folder tag filter
      var savedFolderTag = localStorage.getItem('folderTagFilter');
      if (savedFolderTag) {
        window._activeFolderTagFilter = savedFolderTag;
        renderFolderTagFilterBar();
      }
      var savedTagMatch = localStorage.getItem('tagMatchMode');
      if (savedTagMatch === 'AND' || savedTagMatch === 'OR') {
        window._tagMatchMode = savedTagMatch;
      }
      updateActiveFilterChips();

      // ── Pull-to-refresh on mobile ─────────────────────────────────────────
      // Works by detecting downward pull gesture on the files panel
      (function initPullToRefresh() {
        var panel = document.getElementById('filesPanel');
        if (!panel) return;
        var touchStartY = 0;
        var pullEl = null;
        var pullIndicator = null;

        function createIndicator() {
          if (pullIndicator) return;
          pullIndicator = document.createElement('div');
          pullIndicator.id = 'pullIndicator';
          pullIndicator.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;color:var(--muted);padding:10px"><span id="pullSpinner" style="display:none;font-size:16px">↻</span><span id="pullArrow" style="font-size:16px;transition:transform .2s">↓</span> 下拉刷新</div>';
          pullIndicator.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9998;background:var(--bg-secondary);border-bottom:1px solid var(--line);text-align:center;transform:translateY(-100%);transition:transform .3s;padding-top:max(12px,env(safe-area-inset-top))';
          document.body.appendChild(pullIndicator);
        }

        panel.addEventListener('touchstart', function(e) {
          if (window.scrollY > 10) return; // only when at top
          touchStartY = e.touches[0].clientY;
          createIndicator();
        }, { passive: true });

        panel.addEventListener('touchmove', function(e) {
          if (!pullIndicator) return;
          var delta = e.touches[0].clientY - touchStartY;
          if (delta > 0 && window.scrollY <= 10) {
            e.preventDefault();
            pullIndicator.style.transform = 'translateY(' + Math.min(delta - 60, 0) + 'px)';
            var arrow = document.getElementById('pullArrow');
            if (arrow) arrow.style.transform = 'rotate(' + (Math.min(delta, 60) * 3) + 'deg)';
          }
        }, { passive: false });

        panel.addEventListener('touchend', function() {
          if (!pullIndicator) return;
          var delta = parseInt(pullIndicator.style.transform.replace('translateY(', '').replace('px)', ''), 10);
          if (delta > -30) {
            // Not far enough — snap back
            pullIndicator.style.transform = 'translateY(-100%)';
            setTimeout(function() { if (pullIndicator) { pullIndicator.remove(); pullIndicator = null; } }, 300);
          } else {
            // Trigger refresh
            pullIndicator.style.transform = 'translateY(0)';
            var arrow = document.getElementById('pullArrow');
            var spinner = document.getElementById('pullSpinner');
            if (arrow) arrow.style.display = 'none';
            if (spinner) spinner.style.display = 'inline';
            loadFiles();
            setTimeout(function() {
              pullIndicator.style.transform = 'translateY(-100%)';
              setTimeout(function() { if (pullIndicator) { pullIndicator.remove(); pullIndicator = null; } }, 300);
            }, 800);
          }
        });
      })();
    })();

    // Service Worker registration (PWA offline support)
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
          // SW registration failure is non-fatal
        });

        // WebSocket status manager with token auth + auto reconnect + real-time UI refresh
        (function wsStatusManager() {
          var chip = document.getElementById('wsStatusChip');
          if (!chip) return;
          var ws = null;
          var reconnectDelay = 2000;
          var maxReconnectDelay = 30000;
          var reconnectTimer = null;
          var lastSyncTs = parseInt(localStorage.getItem('ws_lastSync') || '0', 10);
          var pendingChanges = 0;

          function updateChip(status, color) {
            chip.textContent = status;
            chip.style.color = color || '';
          }

          function connect() {
            // Get a short-lived WebSocket token from the server
            fetch('/api/ws-token', { headers: headers() }).then(function(r) {
              if (!r.ok) throw new Error('Token fetch failed');
              return r.json();
            }).then(function(data) {
              if (!data.token) throw new Error('No token in response');
              var wsProtocol = location.protocol === 'https:' ? 'wss:' : 'wss:';
              var wsUrl = wsProtocol + '//' + location.host + '/ws?token=' + encodeURIComponent(data.token);
              ws = new WebSocket(wsUrl);

              ws.onopen = function() {
                reconnectDelay = 2000;
                updateChip('✅ 已连接', '#10b981');
                // Register this browser as a device
                ws.send(JSON.stringify({
                  type: 'register',
                  payload: {
                    deviceId: 'browser-' + Math.random().toString(36).slice(2, 9),
                    deviceName: navigator.userAgent.slice(0, 50)
                  }
                }));
                // Pull any missed changes since last sync on reconnect
                if (lastSyncTs > 0) {
                  ws.send(JSON.stringify({ type: 'sync_request', payload: { since: Math.floor(lastSyncTs / 1000) } }));
                }
              };

              ws.onmessage = function(ev) {
                try {
                  var msg = JSON.parse(ev.data);
                  if (msg.type === 'file_create' || msg.type === 'file_delete' || msg.type === 'file_update' || msg.type === 'files_changed') {
                    lastSyncTs = Date.now();
                    localStorage.setItem('ws_lastSync', lastSyncTs);
                    pendingChanges++;
                    updateChip('🔄 同步中 (' + pendingChanges + ')', '#f59e0b');

                    // Incremental update: skip server fetch, update currentFiles directly
                    var p = msg.payload || msg;
                    if (!currentSearchQuery && currentVirtualFolderId === null && !isRecentFilesMode) {
                      // Normal browsing mode — incremental update
                      if (msg.type === 'file_create' && p.filename) {
                        // Fetch just the new file metadata (not full list)
                        fetch('/api/file-info/' + encodeURIComponent(p.filename), { headers: headers() })
                          .then(function(r) { return r.json(); })
                          .then(function(data) {
                            if (data.file) {
                              data.file._index = currentFiles.length;
                              _insertFileIncremental(data.file);
                            }
                          }).catch(function() {});
                      } else if (msg.type === 'file_delete' && p.filename) {
                        _removeFileIncremental(p.filename);
                      } else if ((msg.type === 'file_update' || msg.type === 'files_changed') && p.filename) {
                        fetch('/api/file-info/' + encodeURIComponent(p.filename), { headers: headers() })
                          .then(function(r) { return r.json(); })
                          .then(function(data) {
                            if (data.file) {
                              data.file._index = currentFiles.findIndex(function(f) { return f.name === data.file.name; });
                              _updateFileIncremental(data.file);
                            }
                          }).catch(function() {});
                      }
                      pendingChanges = Math.max(0, pendingChanges - 1);
                      if (pendingChanges === 0) updateChip('✅ 已同步', '#10b981');
                    } else {
                      // In search/VF/recent mode — fall back to full reload
                      (async function() {
                        await loadFiles();
                        pendingChanges = Math.max(0, pendingChanges - 1);
                        if (pendingChanges === 0) updateChip('✅ 已同步', '#10b981');
                      })();
                    }
                  } else if (msg.type === 'device_list') {
                    // Devices changed — no UI needed yet
                  } else if (msg.type === 'pong') {
                    // Keepalive response
                  } else if (msg.type === 'sync_response') {
                    // Server pushed changes in response to our sync_request or sync_nudge
                    var syncLogs = (msg.payload && msg.payload.logs) || [];
                    if (syncLogs.length > 0) {
                      // Apply changes locally and mark synced
                      var idsToMark = [];
                      (function processNext(i) {
                        if (i >= syncLogs.length) {
                          // All processed: mark synced and update timestamp
                          if (idsToMark.length > 0) {
                            fetch('/api/sync/mark', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', ...headers() },
                              body: JSON.stringify({ ids: idsToMark })
                            }).catch(function() {});
                          }
                          lastSyncTs = Date.now();
                          localStorage.setItem('ws_lastSync', lastSyncTs);
                          return;
                        }
                        var log = syncLogs[i];
                        if (log.action === 'create' || log.action === 'update') {
                          if (log.filename && log.content !== undefined) {
                            var formData = new FormData();
                            formData.append('file', new Blob([log.content || ''], { type: 'text/plain' }), log.filename);
                            fetch('/api/upload', { method: 'POST', headers: headers(), body: formData })
                              .then(function(r) { return r.json(); })
                              .then(function(data) {
                                if (data.id) idsToMark.push(log.id);
                                processNext(i + 1);
                              }).catch(function() { processNext(i + 1); });
                          } else {
                            processNext(i + 1);
                          }
                        } else if (log.action === 'delete' && log.filename) {
                          fetch('/api/files/' + encodeURIComponent(log.filename), { method: 'DELETE', headers: headers() })
                            .then(function() { processNext(i + 1); }).catch(function() { processNext(i + 1); });
                        } else if (log.action === 'rename' && log.filename) {
                          processNext(i + 1);
                        } else {
                          idsToMark.push(log.id);
                          processNext(i + 1);
                        }
                      })(0);
                    }
                  }
                } catch(e) {}
              };

              ws.onclose = function() {
                updateChip('⚠️ 离线模式 (重连中…)', '#ef4444');
                scheduleReconnect();
              };

              ws.onerror = function() {
                updateChip('⚠️ 连接失败', '#ef4444');
              };
            }).catch(function(e) {
              updateChip('⚠️ 同步不可用', '#ef4444');
            });
          }

          function scheduleReconnect() {
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(function() {
              connect();
              reconnectDelay = Math.min(reconnectDelay * 1.5, maxReconnectDelay);
            }, reconnectDelay);
          }

          connect();

          // Heartbeat: nudge server every 60s to detect stale connections
          setInterval(function() {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping' }));
            }
          }, 60000);
        })();
      });
    }
  </script>
    <!-- FAB for mobile: trigger file input -->
    <button class="fab" onclick="document.getElementById('fileInput').click()" title="上传文件">+</button>
    <!-- Back to top button -->
    <button id="backToTop" class="back-to-top" onclick="window.scrollTo({top:0,behavior:'smooth'})" title="回到顶部" style="display:none">↑</button>

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
    getShareToken,
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
    saveConfig,
    rotateShareToken,
    getEffectiveToken
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

    function loadTrashAutoCleanSetting() {
      var saved = parseInt(localStorage.getItem('trashAutoCleanDays') || '0', 10);
      var status = document.getElementById('trashAutoCleanStatus');
      // Highlight the active button
      ['tacOff','tac7','tac30','tac90'].forEach(function(id) {
        var btn = document.getElementById(id);
        if (!btn) return;
        var days = id === 'tacOff' ? 0 : id === 'tac7' ? 7 : id === 'tac30' ? 30 : 90;
        btn.className = (saved === days) ? 'primary' : 'secondary';
      });
      if (status) {
        if (saved > 0) {
          status.textContent = '已开启：进入回收站超过 ' + saved + ' 天的文件将自动永久删除';
        } else {
          status.textContent = '未开启自动清理';
        }
      }
    }

    function setTrashAutoClean(days) {
      localStorage.setItem('trashAutoCleanDays', String(days));
      loadTrashAutoCleanSetting();
      showToast(days > 0 ? '已设置为 ' + days + ' 天后自动清理' : '已关闭自动清理', 'info');
    }

    async function runTrashAutoClean() {
      var days = parseInt(localStorage.getItem('trashAutoCleanDays') || '0', 10);
      if (!days) return;
      try {
        var res = await fetch('/api/trash/auto-clean?days=' + days, { headers: headers() });
        var data = await res.json();
        if (data.deleted > 0) {
          console.log('[TrashAutoClean] Deleted ' + data.deleted + ' old trash items');
        }
      } catch(e) {
        console.error('[TrashAutoClean] Failed:', e);
      }
    }

    // Run trash auto-clean on startup (after a short delay to let server start)
    setTimeout(runTrashAutoClean, 5000);

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
