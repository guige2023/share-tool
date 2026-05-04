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
const { handleWebDAV } = require('./routes/webdav');

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
    auditLog: '审计日志', exportData: '导出数据', language: '语言', theme: '主题', dashboard: '存储分析', settings: '设置', appearance: '外观', defaultView: '默认视图', serverInfo: '服务器信息', dark: '深色', light: '浅色', system: '跟随系统', listView: '列表视图', gridView: '网格视图', saved: '已保存', customCSS: '自定义 CSS',
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
const DEFAULT_TOKEN=crypto.randomBytes(32).toString('hex');
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
    uploadMaxSizeMB: 100,
    customCSS: ''
  };

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch (error) {
    if (process.env.LOG_LEVEL !== 'silent') console.error('[ShareTool] Failed to load config:', error.message);
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

function setCors(res, req) {
  // CORS - configurable via ALLOWED_ORIGINS env var (comma-separated)
  // Defaults to restricting to same-origin requests only (secure by default)
  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  let origin = '*';  // default for no-Origin requests (curl, etc.)
  if (req && req.headers.origin) {
    if (allowedOrigins) {
      // Explicit allowlist from env
      const allowed = allowedOrigins.split(',').map(o => o.trim());
      origin = allowed.includes(req.headers.origin) ? req.headers.origin : 'null';
    } else {
      // Default: restrict to same-origin only (localhost + LAN)
      const reqOrigin = req.headers.origin;
      const localIp = LOCAL_IP;
      const isLocal = reqOrigin === 'null' ||
        reqOrigin.includes('localhost') ||
        reqOrigin.includes('127.0.0.1') ||
        reqOrigin.includes('file://') ||
        (localIp && reqOrigin.includes(localIp.split('.')[0]));
      origin = isLocal ? reqOrigin : 'null';
    }
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
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
        if (process.env.LOG_LEVEL !== 'silent') console.log(`[ShareTool] Using existing certificate (expires in ${daysRemaining} days)`);
        certInfo = {
          subject: x509.subject.split('\n')[0].replace('CN=', '').trim(),
          issuer: x509.issuer.split('\n')[0].replace('CN=', '').trim(),
          validTo: x509.validTo,
          daysRemaining
        };
        return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
      }
      if (process.env.LOG_LEVEL !== 'silent') console.log('[ShareTool] Certificate expires soon, regenerating...');
    }
  } catch (e) {
    if (process.env.LOG_LEVEL !== 'silent') console.log('[ShareTool] Certificate check failed, regenerating...');
  }
  const pems = await generateSelfSignedCert();
  fs.writeFileSync(keyPath, pems.key, { mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert, { mode: 0o644 });
  if (process.env.LOG_LEVEL !== 'silent') console.log('[ShareTool] Self-signed certificate generated');
  if (process.env.LOG_LEVEL !== 'silent') console.log(`[ShareTool] Certificate: ${path.join(SSL_DIR, 'cert.pem')}`);
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
  <link rel="stylesheet" href="/styles.css">
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
    <div class="ctx-item" onclick="ctxAction('batchTag')">🏷️ 批量标签</div>
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
        <button id="notifSoundToggle" onclick="toggleNotificationSound()" title="通知声音" style="background:var(--bg-secondary);border:1px solid var(--line);border-radius:12px;padding:6px 10px;cursor:pointer;font-size:16px;line-height:1">🔕</button>
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
          <span style="flex:1"></span>
          <button id="pauseAllBtn" onclick="pauseAllUploads()" style="display:none;background:var(--bg-secondary);border:1px solid var(--line);border-radius:5px;cursor:pointer;font-size:11px;padding:2px 8px;color:var(--text)">⏸ 全部暂停</button>
          <button id="resumeAllBtn" onclick="resumeAllUploads()" style="display:none;background:var(--bg-secondary);border:1px solid var(--line);border-radius:5px;cursor:pointer;font-size:11px;padding:2px 8px;color:var(--text)">▶ 全部继续</button>
          <button onclick="clearDoneUploads()" style="background:var(--bg-secondary);border:1px solid var(--line);border-radius:5px;cursor:pointer;font-size:11px;padding:2px 8px;color:var(--muted)">✕ 清空已完成</button>
        </div>
        <div class="uq-list" style="max-height:200px;overflow-y:auto;padding:0 14px"></div>
      </div>
    </div>

    <div id="versionBanner" style="display:none;margin:10px 0 0;padding:10px 16px;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border:1px solid rgba(255,255,255,.12);border-radius:12px;display:flex;align-items:center;gap:12px;font-size:13px;color:#e2e8f0">
      <span style="font-size:18px;flex-shrink:0">✨</span>
      <div style="flex:1;min-width:0">
        <div id="versionBannerTitle" style="font-weight:600;margin-bottom:2px"></div>
        <div id="versionBannerDesc" style="font-size:12px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button onclick="openChangelogFromBanner()" style="padding:5px 12px;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.25);border-radius:8px;color:#fff;font-size:12px;cursor:pointer">查看详情</button>
        <button onclick="dismissVersionBanner()" style="padding:5px 8px;background:none;border:none;color:rgba(255,255,255,.5);font-size:16px;cursor:pointer;line-height:1">✕</button>
      </div>
    </div>

    <section class="panel" style="margin-top:18px">
      <div class="toolbar">
        <input id="searchInput" type="text" placeholder="搜索文件 (⌘K / 聚焦)" autocomplete="off" inputmode="search" autocorrect="off" spellcheck="false" aria-label="搜索文件" style="padding-right:56px" onfocus="if(getRecentSearches().length>0){document.getElementById('recentSearches').style.display='block'}" oninput="document.getElementById('recentSearches').style.display='none'">
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
            <div id="sortPresetsMenu" style="border-top:1px solid var(--line);margin:4px 0;padding-top:4px"></div>\
            <div class="ctx-item" onclick="openSaveSortPresetModal()" style="color:var(--accent)">⭐ 保存当前排序</div>
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
        <button class="ghost" onclick="openCleanupWizard()" title="存储清理向导">🧹</button>
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
          <button id="dateGroupToggle" onclick="toggleDateGroup()" title="按日期分组" style="padding:5px 8px;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:6px;cursor:pointer;font-size:13px;color:var(--text-muted)">📅</button>
        </div>
      </div>
      <div id="recentSearches" style="display:none;margin-bottom:10px;flex-wrap:wrap;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch"></div>
      <div id="searchResultsBar" style="display:none;background:var(--bg-tertiary);border:1px solid var(--line);border-radius:8px;padding:8px 14px;margin-bottom:8px;font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:10px"></div>
      <div id="typeFilterBar" style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center;overflow-x:auto;-webkit-overflow-scrolling:touch">
        <button class="type-chip active" data-type="" onclick="setTypeFilter('')">全部</button>
        <button class="type-chip" data-type="starred" onclick="setTypeFilter('starred')" id="starredChip">⭐ 星标<span id="starredCountBadge" style="margin-left:3px;font-size:10px;opacity:0.7"></span></button>
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
      <div id="tagModeBar" style="display:none;flex-wrap:wrap;gap:6px;margin-bottom:8px;align-items:center"></div>
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
        <button class="ghost" onclick="openBatchTagModal()">🏷️ 标签</button>
        <button class="ghost" onclick="openBatchRemoveTagModal()">🏷️ 移除标签</button>
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
              <th style="width:160px">路径</th>
              <th style="width:240px">操作</th>
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
        <button class="ghost" onclick="openExpiringLinks()">⏰ 过期提醒</button>
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

  <script src="/app.js"></script>
  <script src="/fab.js"></script>
  <script src="/misc.js"></script>
    <!-- FAB for mobile: trigger file input -->
    <button class="fab" onclick="document.getElementById('fileInput').click()" title="上传文件">+</button>
    <!-- Back to top button -->
    <button id="backToTop" class="back-to-top" onclick="window.scrollTo({top:0,behavior:'smooth'})" title="回到顶部" style="display:none">↑</button>

${config.customCSS ? `<style id="custom-css-injected">${config.customCSS}</style>` : ''}
</body>
</html>`;
}

async function requestHandler(req, res) {
  setCors(res, req);

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

  // Serve extracted frontend assets from public/
  if (pathname === '/styles.css' || pathname === '/app.js' || pathname === '/fab.js' || pathname === '/misc.js') {
    const filePath = path.join(__dirname, 'public', pathname);
    if (!fs.existsSync(filePath)) {
      sendJson(res, { success: false, error: 'Not found' }, 404);
      return;
    }
    const stream = fs.createReadStream(filePath);
    const ct = pathname.endsWith('.css') ? 'text/css' : 'application/javascript';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
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
    if (await handleWebDAV(req, res, pathname, query, ctx)) return;
    sendJson(res, { success: false, error: 'Not found' }, 404);
  } catch (error) {
    if (process.env.LOG_LEVEL !== 'silent') console.error('[ShareTool] Request failed:', error);
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
        if (process.env.LOG_LEVEL !== 'silent') console.log(`[Cleanup] tokens=${removedTokens} sync_log=${removedSync} trash=${removedTrash}`);
      }
    } catch (e) {
      if (process.env.LOG_LEVEL !== 'silent') console.error('[Cleanup] Error:', e.message);
    }
    // Prune old file versions across all files (call without fileId to prune all)
    try {
      db.pruneAllFileVersions(10);
    } catch (e) {
      if (process.env.LOG_LEVEL !== 'silent') console.error('[Cleanup] pruneFileVersions error:', e.message);
    }
  }
  // Run immediately on startup, then every hour
  runCleanup();
  setInterval(runCleanup, RUN_INTERVAL);
  if (process.env.LOG_LEVEL !== 'silent') console.log('[ShareTool] Cleanup scheduler started (every hour)');
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
          if (process.env.LOG_LEVEL !== 'silent') console.log('[TrashAutoClean] Deleted ' + data.deleted + ' old trash items');
        }
      } catch(e) {
        if (process.env.LOG_LEVEL !== 'silent') console.error('[TrashAutoClean] Failed:', e);
      }
    }

    // Run trash auto-clean on startup (after a short delay to let server start)
    // Skip in Node.js (server) environment - client-side only
    if (typeof window !== 'undefined') {
      setTimeout(runTrashAutoClean, 5000);
    }

async function start() {
  const { key, cert } = await getOrCreateCertificate();

  const httpsServer = https.createServer({ key, cert }, requestHandler);
  httpsServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      if (process.env.LOG_LEVEL !== 'silent') console.error(`[ShareTool] HTTPS port ${HTTPS_PORT} already in use`);
    } else {
      if (process.env.LOG_LEVEL !== 'silent') console.error('[ShareTool] HTTPS server error:', e);
    }
  });
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    if (process.env.LOG_LEVEL !== 'silent') console.log('[ShareTool] HTTPS listening on https://0.0.0.0:' + HTTPS_PORT);
    if (process.env.LOG_LEVEL !== 'silent') console.log('[ShareTool] LAN address: https://' + LOCAL_IP + ':' + HTTPS_PORT);
    if (process.env.LOG_LEVEL !== 'silent') console.log('[ShareTool] Token: ' + SHARE_TOKEN);
  });

  // Initialize WebSocket server on the HTTPS server
  const wss = initWebSocketServer(httpsServer);
  if (process.env.LOG_LEVEL !== 'silent') console.log('[ShareTool] WebSocket server ready on wss://0.0.0.0:' + HTTPS_PORT + '/ws');

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
      if (process.env.LOG_LEVEL !== 'silent') console.error(`[ShareTool] HTTP redirect port ${PORT} already in use`);
    }
  });
  redirectServer.listen(PORT, '0.0.0.0', () => {
    if (process.env.LOG_LEVEL !== 'silent') console.log(`[ShareTool] HTTP redirect listening on http://${LOCAL_IP}:${PORT} -> https://${LOCAL_IP}:${HTTPS_PORT}`);
  });

  return { httpsServer, redirectServer };
}

// Global error handlers — prevent silent crashes
process.on('uncaughtException', (err) => {
  if (process.env.LOG_LEVEL !== 'silent') console.error('[ShareTool] Uncaught Exception:', err);
  // Don't exit immediately — let cleanup run
});

process.on('unhandledRejection', (reason, promise) => {
  if (process.env.LOG_LEVEL !== 'silent') console.error('[ShareTool] Unhandled Rejection at:', promise, 'reason:', reason);
});

if (require.main === module) {
  start().catch((e) => {
    if (process.env.LOG_LEVEL !== 'silent') console.error('[ShareTool] Failed to start:', e);
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
