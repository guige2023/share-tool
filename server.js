#!/usr/bin/env node
/**
 * ShareTool v2 - 局域网文件/文字分享服务
 * 特性: SQLite 数据库 / WebSocket 实时同步 / 设备发现 / 动态 Token / HTTPS / 审计日志
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const url = require('url');
const cryptoModule = require('./crypto');

// 内部模块
const db = require('./db');

// WebSocket 服务器
const { WebSocketServer } = require('ws');
// UDP 设备发现
const dgram = require('dgram');
// 批量打包
const archiver = require('archiver');

// ============================================================
// 常量配置
// ============================================================
const PORT = 18790;
const HTTPS_PORT = 18793; // HTTPS 端口
const WS_PORT = 18791;  // WebSocket 专用端口
const DISCOVERY_PORT = 18792; // UDP 广播发现端口
const BROADCAST_INTERVAL = 5000; // 5秒广播一次

const SHARE_DIR = path.join(os.homedir(), '.share-tool', 'files');
const CONFIG_FILE = path.join(os.homedir(), '.share-tool', 'config.json');
const SSL_DIR = path.join(os.homedir(), '.share-tool', 'ssl');

// ============================================================
// Token 配置（从环境变量或配置文件读取，无硬编码）
// ============================================================
function getShareToken() {
  // 优先从环境变量读取
  if (process.env.SHARE_TOKEN) {
    return process.env.SHARE_TOKEN;
  }
  // 从配置文件读取
  if (config.shareToken) {
    return config.shareToken;
  }
  // 首次启动：生成随机 token 并保存
  const newToken = crypto.randomBytes(32).toString('hex');
  config.shareToken = newToken;
  saveConfig();
  console.log('[ShareTool] 首次启动，已生成新 Token:', newToken.substring(0, 8) + '***');
  return newToken;
}

let SHARE_TOKEN = ''; // 延迟初始化
const TOKEN_EXPIRES_IN = 7 * 86400; // 7天

// 本机信息
const DEVICE_ID = crypto.createHash('md5').update(os.hostname() + os.homedir()).digest('hex');
const DEVICE_NAME = os.hostname();
const LOCAL_IP = (() => {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
})();

// 全局状态
let config = {};
let wsClients = new Map(); // deviceId -> WebSocket
let syncClients = new Set(); // 所有同步客户端
let httpServer = null;
let wsServer = null;
let udpServer = null;
let broadcastTimer = null;

// ============================================================
// 速率限制（时间窗口桶）
// ============================================================
const rateLimitWindow = 60 * 1000; // 60秒窗口
const rateLimitMax = 60; // 最多60次请求
const rateLimitMap = new Map(); // ip -> [{timestamp}]

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - rateLimitWindow;

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }

  const requests = rateLimitMap.get(ip);
  // 清理过期记录
  while (requests.length > 0 && requests[0] < windowStart) {
    requests.shift();
  }

  if (requests.length >= rateLimitMax) {
    return false; // 超限
  }

  requests.push(now);
  return true;
}

// ============================================================
// 上传大小限制
// ============================================================
function getUploadMaxSize() {
  // 优先从环境变量读取
  if (process.env.UPLOAD_MAX_SIZE_MB) {
    return parseInt(process.env.UPLOAD_MAX_SIZE_MB) * 1024 * 1024;
  }
  // 从配置文件读取
  const maxMB = config.uploadMaxSizeMB || 100;
  return maxMB * 1024 * 1024;
}

// ============================================================
// WebDAV 服务器
// ============================================================
const WEBDAV_PREFIX = '/webdav';
const DAV_NS = 'DAV:';

function isWebDAVRequest(pathname) {
  return pathname.startsWith(WEBDAV_PREFIX + '/') || pathname === WEBDAV_PREFIX;
}

function parseWebDAVDepth(header) {
  if (header === 'infinity') return 'infinity';
  if (header === '0') return 0;
  if (header === '1') return 1;
  return 1; // 默认 depth=1
}

function webdavPropfind(files, prefix = '') {
  const responses = files.map(f => {
    const href = prefix + '/' + encodeURIPath(f.filename);
    return `<?xml version="1.0" encoding="UTF-8"?>
<d:response xmlns:d="DAV:">
  <d:href>${href}</d:href>
  <d:propstat>
    <d:prop>
      <d:displayname>${escapeXml(f.filename)}</d:displayname>
      <d:getcontentlength>${f.size}</d:getcontentlength>
      <d:getcontenttype>${f.type === 'text' ? 'text/plain' : 'application/octet-stream'}</d:getcontenttype>
      <d:resourcetype>${f.type === 'folder' ? '<d:collection/>' : '<d:file/>'}</d:resourcetype>
      <d:creationdate>${new Date(f.created_at * 1000).toISOString()}</d:creationdate>
      <d:getlastmodified>${new Date(f.updated_at * 1000).toGMTString()}</d:getlastmodified>
      <d:getetag>"${f.hash || ''}"</d:getetag>
      <d:supportedlock/>
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`;
  }).join('\n');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
${responses}
</d:multistatus>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function encodeURIPath(path) {
  return path.split('/').map(p => encodeURIComponent(p)).join('/');
}

function handleWebDAV(req, res, pathname, query) {
  const path = pathname.slice(WEBDAV_PREFIX.length);
  const depth = parseWebDAVDepth(req.headers.depth || '1');
  
  // OPTIONS - Return DAV support
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'DAV': '1, 2',
      'Allow': 'OPTIONS, GET, PUT, DELETE, MKCOL, MOVE, COPY, PROPFIND, PROPPATCH',
      'Content-Length': 0
    });
    res.end();
    return true;
  }
  
  // PROPFIND - List directory contents
  if (req.method === 'PROPFIND') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const allFiles = db.listFiles(1000, 0).files;
      // 根目录
      const rootResponse = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response xmlns:d="DAV:">
    <d:href>${WEBDAV_PREFIX}/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>ShareTool</d:displayname>
        <d:resourcetype><d:collection/></d:resourcetype>
        <d:creationdate>${new Date().toISOString()}</d:creationdate>
        <d:getlastmodified>${new Date().toGMTString()}</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
${allFiles.map(f => `  <d:response xmlns:d="DAV:">
    <d:href>${WEBDAV_PREFIX}/${encodeURIPath(f.filename)}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${escapeXml(f.filename)}</d:displayname>
        <d:getcontentlength>${f.size}</d:getcontentlength>
        <d:getcontenttype>${f.type === 'text' ? 'text/plain' : 'application/octet-stream'}</d:getcontenttype>
        <d:resourcetype>${f.type === 'folder' ? '<d:collection/>' : '<d:file/>'}</d:resourcetype>
        <d:creationdate>${new Date(f.created_at * 1000).toISOString()}</d:creationdate>
        <d:getlastmodified>${new Date(f.updated_at * 1000).toGMTString()}</d:getlastmodified>
        <d:getetag>"${f.hash || ''}"</d:getetag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`).join('\n')}
</d:multistatus>`;
      
      res.writeHead(207, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(rootResponse)
      });
      res.end(rootResponse);
    });
    return true;
  }
  
  // GET - Download file
  if (req.method === 'GET') {
    const filename = decodeURIComponent(path.slice(1));
    const file = db.getFileByName(filename);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return true;
    }
    if (file.encrypted) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Encrypted files not accessible via WebDAV');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': file.type === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'Content-Length': file.size,
      'ETag': `"${file.hash || ''}"`
    });
    res.end(file.content || '');
    db.addAuditLog('webdav_get', `filename=${filename}`, getClientIp(req));
    return true;
  }
  
  // PUT - Upload/update file
  if (req.method === 'PUT') {
    const filename = decodeURIComponent(path.slice(1));
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const existing = db.getFileByName(filename);
        const type = isTextContent(req.headers['content-type']) ? 'text' : 'file';
        const hash = crypto.createHash('md5').update(body).digest('hex');
        const result = db.addFile(filename, body, type, hash, false);
        db.addAuditLog('webdav_put', `filename=${filename}`, getClientIp(req));
        res.writeHead(existing ? 204 : 201, { 'Location': WEBDAV_PREFIX + '/' + encodeURIPath(filename) });
        res.end();
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(e.message);
      }
    });
    return true;
  }
  
  // DELETE - Delete file
  if (req.method === 'DELETE') {
    const filename = decodeURIComponent(path.slice(1));
    if (db.deleteFileByName(filename)) {
      db.addAuditLog('webdav_delete', `filename=${filename}`, getClientIp(req));
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
    return true;
  }
  
  // MKCOL - Create folder (not supported for flat storage)
  if (req.method === 'MKCOL') {
    res.writeHead(405, { 'Allow': 'DELETE, GET, HEAD, OPTIONS, POST, PROPFIND, PUT' });
    res.end('Method Not Allowed - ShareTool uses flat storage');
    return true;
  }
  
  // MOVE - Not implemented
  if (req.method === 'MOVE') {
    res.writeHead(502);
    res.end('MOVE not implemented');
    return true;
  }
  
  // COPY - Not implemented
  if (req.method === 'COPY') {
    res.writeHead(502);
    res.end('COPY not implemented');
    return true;
  }
  
  return false; // Not a WebDAV handler
}

function isTextContent(contentType) {
  if (!contentType) return false;
  const textTypes = ['text/', 'application/json', 'application/javascript', 'application/xml'];
  return textTypes.some(t => contentType.includes(t));
}

// ============================================================
// 工具函数
// ============================================================
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // 确保 downloadDir 是绝对路径
      let downloadDir = loaded.downloadDir || path.join(os.homedir(), 'Downloads', 'ShareTool');
      if (!path.isAbsolute(downloadDir)) {
        downloadDir = path.join(os.homedir(), downloadDir);
      }
      // 默认上传大小限制
      const uploadMaxSizeMB = loaded.uploadMaxSizeMB || 100;
      config = { ...{ downloadDir: path.join(os.homedir(), 'Downloads', 'ShareTool'), lastSync: null, deviceId: DEVICE_ID, uploadMaxSizeMB }, downloadDir, ...loaded };
    } else {
      config = { downloadDir: path.join(os.homedir(), 'Downloads', 'ShareTool'), lastSync: null, deviceId: DEVICE_ID, uploadMaxSizeMB: 100 };
    }
  } catch (e) {
    config = { downloadDir: path.join(os.homedir(), 'Downloads', 'ShareTool'), lastSync: null, deviceId: DEVICE_ID, uploadMaxSizeMB: 100 };
  }
  if (!config.deviceId) config.deviceId = DEVICE_ID;
  if (!config.uploadMaxSizeMB) config.uploadMaxSizeMB = 100;
  
  // 从环境变量或配置文件读取 token
  SHARE_TOKEN = process.env.SHARE_TOKEN || config.shareToken;
  if (!SHARE_TOKEN) {
    // 首次启动，生成新 token
    SHARE_TOKEN = crypto.randomBytes(32).toString('hex');
    config.shareToken = SHARE_TOKEN;
    saveConfig();
    console.log('[ShareTool] 首次启动，已生成 Token 并保存到 ' + CONFIG_FILE);
  }
}

function saveConfig() {
  try {
    const cfgDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
    // 确保保存时 downloadDir 是绝对路径
    const saveConfig = { ...config };
    if (saveConfig.downloadDir && !path.isAbsolute(saveConfig.downloadDir)) {
      saveConfig.downloadDir = path.join(os.homedir(), saveConfig.downloadDir);
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(saveConfig, null, 2));
  } catch (e) {
    console.error('[Config] Save failed:', e.message);
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token, x-refresh-token, Authorization');
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function auth(req) {
  const token = req.headers['x-auth-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return null;
  
  // 验证动态 Token
  const dynamicToken = db.validateToken(token);
  if (dynamicToken) return dynamicToken;
  
  // 验证配置的共享 Token
  if (!SHARE_TOKEN) SHARE_TOKEN = getShareToken();
  if (token === SHARE_TOKEN) return { token: SHARE_TOKEN, isStatic: true };
  return null;
}

function authRequired(req, res) {
  const clientIp = getClientIp(req);
  
  // 检查速率限制
  if (!checkRateLimit(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ success: false, error: 'Too Many Requests', retryAfter: 60 }));
    return null;
  }
  
  const authData = auth(req);
  if (!authData) {
    sendJson(res, { success: false, error: 'Unauthorized' }, 401);
    return null;
  }
  return authData;
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
}

function escapeHtml(str) {
  const div = { textContent: '' };
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// 初始化
// ============================================================
async function init() {
  // 确保目录存在
  if (!fs.existsSync(SHARE_DIR)) {
    fs.mkdirSync(SHARE_DIR, { recursive: true });
  }
  
  // 加载配置
  loadConfig();
  
  // 初始化数据库
  db.initDatabase();
  
  // 注册本机设备
  db.registerDevice(DEVICE_ID, DEVICE_NAME, LOCAL_IP, PORT);
  
  // 确保下载目录存在
  if (!fs.existsSync(config.downloadDir)) {
    fs.mkdirSync(config.downloadDir, { recursive: true });
  }
  
  // 启动 HTTP 服务器
  await startHttpServer();
  
  // 启动 WebSocket 服务器
  startWsServer();
  
  // 启动 UDP 设备发现
  startDiscovery();
  
  // 启动设备心跳
  startHeartbeat();
  
  // 定时同步检查
  startSyncScheduler();
  
  console.log(`[ShareTool] Device ID: ${DEVICE_ID}`);
  console.log(`[ShareTool] HTTP: http://${LOCAL_IP}:${PORT}`);
  console.log(`[ShareTool] WebSocket: ws://${LOCAL_IP}:${WS_PORT}`);
  console.log(`[ShareTool] Discovery: udp://${LOCAL_IP}:${DISCOVERY_PORT}`);
}

// ============================================================
// HTTPS 证书管理
// ============================================================
const selfsigned = require('selfsigned');

async function ensureSslCertificates() {
  const certPath = path.join(SSL_DIR, 'cert.pem');
  const keyPath = path.join(SSL_DIR, 'key.pem');
  
  // 证书已存在
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const stats = fs.statSync(certPath);
    const age = (Date.now() - stats.mtimeMs) / 1000 / 86400; // 天
    if (age < 365) {
      console.log(`[HTTPS] Using existing certificate (age: ${age.toFixed(1)} days)`);
      return true;
    }
    console.log(`[HTTPS] Certificate expired (age: ${age.toFixed(1)} days), regenerating...`);
  }
  
  // 生成新证书
  try {
    if (!fs.existsSync(SSL_DIR)) {
      fs.mkdirSync(SSL_DIR, { recursive: true });
    }
    
    const { key, cert } = await generateSelfSignedCert();
    
    fs.writeFileSync(keyPath, key);
    fs.writeFileSync(certPath, cert);
    
    console.log('[HTTPS] Self-signed certificate generated');
    console.log(`[HTTPS] Certificate: ${certPath}`);
    console.log('[HTTPS] NOTE: Add cert to system trust store for full HTTPS support');
    return true;
  } catch (e) {
    console.error('[HTTPS] Certificate generation failed:', e.message);
    return false;
  }
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
    { type: 2, value: 'localhost' },  // DNS
    { type: 7, value: '127.0.0.1' }    // IP
  ];
  for (const ip of ips) {
    if (ip !== '127.0.0.1') {
      altNames.push({ type: 7, value: ip });
    }
  }
  
  const attrs = [{ name: 'commonName', value: 'ShareTool' }];
  const pems = await selfsigned.generate(attrs, {
    algorithm: 'sha256',
    days: 365,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }]
  });
  
  console.log(`[HTTPS] SANs: localhost, 127.0.0.1, ${ips.filter(ip => ip !== '127.0.0.1').join(', ')}`);
  
  return { key: pems.private, cert: pems.cert };
}

function getCertInfo() {
  const certPath = path.join(SSL_DIR, 'cert.pem');
  if (!fs.existsSync(certPath)) return null;
  
  try {
    const certPem = fs.readFileSync(certPath, 'utf8');
    const cert = new crypto.X509Certificate(certPem);
    return {
      issuer: cert.issuer.CN || cert.issuer.O || 'ShareTool',
      subject: cert.subject.CN || cert.subject.O || 'ShareTool',
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      fingerprint: cert.fingerprint256.replace(/:/g, '').toLowerCase().substring(0, 16) + '...',
      isExpired: new Date(cert.validTo) < new Date(),
      daysRemaining: Math.ceil((new Date(cert.validTo) - new Date()) / 86400000)
    };
  } catch (e) {
    return null;
  }
}

// ============================================================
// 分享码管理
// ============================================================
const SHARE_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // 排除易混淆字符
const SHARE_CODE_LENGTH = 6;
const SHARE_CODE_EXPIRY_DEFAULT = 7 * 24 * 60 * 60 * 1000; // 7天

function generateShareCode() {
  let code = '';
  const bytes = crypto.randomBytes(SHARE_CODE_LENGTH);
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
    code += SHARE_CODE_CHARS[bytes[i] % SHARE_CODE_CHARS.length];
  }
  return code;
}

function createShareLink(filename, options = {}) {
  const code = generateShareCode();
  const expiresAt = Date.now() + (options.expiryHours || 168) * 60 * 60 * 1000;
  const shareData = {
    code,
    filename,
    createdAt: Date.now(),
    expiresAt,
    password: options.password || null, // 可选密码保护
    maxDownloads: options.maxDownloads || null,
    downloadCount: 0,
    isText: options.isText || false
  };
  
  db.saveShareLink(shareData);
  return shareData;
}

function validateShareCode(code) {
  const shareData = db.getShareLink(code);
  if (!shareData) return null;
  
  // 检查过期
  if (Date.now() > shareData.expiresAt) {
    db.deleteShareLink(code);
    return null;
  }
  
  // 检查下载次数
  if (shareData.maxDownloads && shareData.downloadCount >= shareData.maxDownloads) {
    db.deleteShareLink(code);
    return null;
  }
  
  return shareData;
}

// ============================================================
// HTTP/HTTPS 服务器
// ============================================================
async function startHttpServer() {
  const serverOptions = {
    key: null,
    cert: null,
    https: false
  };

  // 自动生成或加载 SSL 证书
  const certPath = path.join(SSL_DIR, 'cert.pem');
  const keyPath = path.join(SSL_DIR, 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      serverOptions.key = fs.readFileSync(keyPath);
      serverOptions.cert = fs.readFileSync(certPath);
      serverOptions.https = true;
      const info = getCertInfo();
      if (info) {
        console.log(`[HTTPS] Certificate valid for ${info.daysRemaining} days (expires: ${info.validTo})`);
      }
    } catch (e) {
      console.error('[HTTPS] Failed to load certificate:', e.message);
    }
  } else {
    // 自动生成自签名证书
    const generated = await ensureSslCertificates();
    if (generated) {
      serverOptions.key = fs.readFileSync(keyPath);
      serverOptions.cert = fs.readFileSync(certPath);
      serverOptions.https = true;
    }
  }

  const requestHandler = async (req, res) => {
    setCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 速率限制检查（跳过静态资源和根路径）
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    if (!pathname.startsWith('/index') && !pathname.startsWith('/favicon')) {
      const clientIp = getClientIp(req);
      if (!checkRateLimit(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        res.end(JSON.stringify({ success: false, error: '请求过于频繁，请 60 秒后重试' }));
        return;
      }
    }

    const query = parsed.query;

    // WebDAV 处理（优先于其他路由）
    if (pathname.startsWith(WEBDAV_PREFIX) || pathname === WEBDAV_PREFIX) {
      const handled = handleWebDAV(req, res, pathname, query);
      if (handled) return;
    }

    // 记录审计日志
    const auditAction = `${req.method} ${pathname}`;

    try {
      // 路由处理
      if (pathname === '/' || pathname === '/index.html') {
        sendHtml(res);
        return;
      }
      
      if (pathname === '/api/list') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const { files, total } = db.listFiles();
        db.addAuditLog('list_files', `Total: ${total}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, files: files.map(f => ({
          id: f.id, name: f.filename, size: f.size, time: f.created_at * 1000,
          type: f.type, hash: f.hash, tags: f.tags
        }))});
        return;
      }
      
      if (pathname === '/api/upload' && req.method === 'POST') {
        const authData = authRequired(req, res);
        if (!authData) return;

        // 大小限制检查（基于 Content-Length header）
        const contentLength = parseInt(req.headers['content-length']) || 0;
        const maxSize = getUploadMaxSize();
        if (contentLength > maxSize) {
          sendJson(res, { success: false, error: `文件大小超过限制（最大 ${config.uploadMaxSizeMB || 100}MB）` }, 413);
          return;
        }

        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { filename, content, type, tags } = JSON.parse(body);
            // Base64 内容实际大小检查
            if (content) {
              const actualSize = Buffer.byteLength(content, 'base64');
              if (actualSize > maxSize) {
                sendJson(res, { success: false, error: `文件大小超过限制（最大 ${config.uploadMaxSizeMB || 100}MB）` }, 413);
                return;
              }
            }
            const result = db.addFile(filename, content, type || 'file');
            if (result) {
              broadcastChange({ type: 'create', filename, hash: result.hash });
              db.addAuditLog('upload', filename, getClientIp(req), authData.token);
              sendJson(res, { success: true, filename, hash: result.hash });
            } else {
              sendJson(res, { success: false, error: 'Upload failed' }, 500);
            }
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 400);
          }
        });
        return;
      }
      
      if (pathname.startsWith('/api/content/')) {
        const authData = authRequired(req, res);
        if (!authData) return;
        const filename = decodeURIComponent(pathname.slice('/api/content/'.length));
        const file = db.getFileByName(filename);
        if (file) {
          db.addAuditLog('read_content', filename, getClientIp(req), authData.token);
          sendJson(res, { success: true, content: file.content, type: file.type });
        } else {
          sendJson(res, { success: false, error: 'File not found' }, 404);
        }
        return;
      }
      
      if (pathname === '/api/latest/text') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const { files } = db.listFiles(10);
        const textFile = files.find(f => f.type === 'text');
        if (textFile) {
          sendJson(res, { success: true, content: textFile.content, filename: textFile.filename });
        } else {
          sendJson(res, { success: false, error: 'No text file found' }, 404);
        }
        return;
      }
      
      if (pathname === '/api/file/' && req.method === 'DELETE') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const filename = decodeURIComponent(query.filename || '');
        if (db.deleteFileByName(filename)) {
          broadcastChange({ type: 'delete', filename });
          db.addAuditLog('delete_file', filename, getClientIp(req), authData.token);
          sendJson(res, { success: true });
        } else {
          sendJson(res, { success: false, error: 'File not found' }, 404);
        }
        return;
      }
      
      if (pathname === '/api/delete-old' && req.method === 'DELETE') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const days = parseInt(query.days) || 7;
        const result = db.deleteOldFiles(days);
        broadcastChange({ type: 'bulk_delete', count: result.deleted });
        db.addAuditLog('delete_old', `Deleted ${result.deleted} files older than ${days} days`, getClientIp(req), authData.token);
        sendJson(res, { success: true, deleted: result.deleted });
        return;
      }
      
      if (pathname === '/api/storage' && req.method === 'GET') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const count = db.getFileCount();
        const totalSize = db.getTotalStorageSize();
        sendJson(res, { count, totalSize, maxSize: 10 * 1024 * 1024 * 1024 }); // 10GB soft limit
        return;
      }

      if (pathname === '/api/delete-all' && req.method === 'DELETE') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const result = db.deleteAllFiles();
        broadcastChange({ type: 'bulk_delete', count: result.deleted });
        db.addAuditLog('delete_all', `Deleted ${result.deleted} files`, getClientIp(req), authData.token);
        sendJson(res, { success: true, deleted: result.deleted });
        return;
      }
      
      if (pathname === '/api/config' && req.method === 'POST') {
        const authData = authRequired(req, res);
        if (!authData) return;
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const updates = JSON.parse(body);
            if (updates.downloadDir) {
              config.downloadDir = updates.downloadDir;
              if (!fs.existsSync(config.downloadDir)) {
                fs.mkdirSync(config.downloadDir, { recursive: true });
              }
            }
            saveConfig();
            db.addAuditLog('update_config', JSON.stringify(updates), getClientIp(req), authData.token);
            sendJson(res, { success: true });
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 400);
          }
        });
        return;
      }
      
      if (pathname === '/api/download-one' && req.method === 'POST') {
        const authData = authRequired(req, res);
        if (!authData) return;
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { filename, downloadDir } = JSON.parse(body);
            const targetDir = downloadDir || config.downloadDir;
            const file = db.getFileByName(filename);
            if (!file) {
              sendJson(res, { success: false, error: 'File not found' }, 404);
              return;
            }
            const targetPath = path.join(targetDir, filename);
            fs.writeFileSync(targetPath, file.content || '', 'utf8');
            db.addAuditLog('download_one', `${filename} -> ${targetDir}`, getClientIp(req), authData.token);
            sendJson(res, { success: true, path: targetPath });
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 500);
          }
        });
        return;
      }

      // 批量打包下载
      if (pathname === '/api/batch-download' && req.method === 'POST') {
        const authData = authRequired(req, res);
        if (!authData) return;
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { filenames } = JSON.parse(body);
            if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
              sendJson(res, { success: false, error: '请提供文件名列表' }, 400);
              return;
            }
            if (filenames.length > 100) {
              sendJson(res, { success: false, error: '最多同时下载 100 个文件' }, 400);
              return;
            }

            // 创建 zip 归档
            const zip = archiver('zip', { zlib: { level: 9 } });
            const chunks = [];

            zip.on('data', (chunk) => chunks.push(chunk));
            zip.on('error', (err) => {
              sendJson(res, { success: false, error: err.message }, 500);
            });

            // 添加文件到 zip
            for (const filename of filenames) {
              const file = db.getFileByName(filename);
              if (file && file.content) {
                zip.append(file.content || '', { name: filename });
              }
            }

            zip.finalize();

            // 等待 zip 完成
            zip.on('end', () => {
              const buffer = Buffer.concat(chunks);
              db.addAuditLog('batch_download', `${filenames.length} files`, getClientIp(req), authData.token);
              res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="share-tool-${Date.now()}.zip"`,
                'Content-Length': buffer.length
              });
              res.end(buffer);
            });
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 400);
          }
        });
        return;
      }
      
      if (pathname === '/api/search') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const q = query.q || '';
        const tags = query.tags || null;
        const results = db.searchFiles(q, tags);
        db.addAuditLog('search', `q=${q}, tags=${tags}`, getClientIp(req), authData.token);
        sendJson(res, { success: true, files: results.map(f => ({
          id: f.id, name: f.filename, size: f.size, time: f.created_at * 1000,
          type: f.type, hash: f.hash, tags: f.tags
        }))});
        return;
      }
      
      // Token API
      if (pathname === '/api/token/current') {
        // 返回当前有效的共享 token
        if (!SHARE_TOKEN) SHARE_TOKEN = getShareToken();
        sendJson(res, { success: true, token: SHARE_TOKEN });
        return;
      }

      if (pathname === '/api/token/set' && req.method === 'POST') {
        // 设置自定义 token（需验证当前 token）
        const authData = authRequired(req, res);
        if (!authData) return;
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { token } = JSON.parse(body);
            if (!token || token.length < 16) {
              sendJson(res, { success: false, error: 'Token 长度至少 16 字符' }, 400);
              return;
            }
            SHARE_TOKEN = token;
            config.shareToken = token;
            saveConfig();
            db.addAuditLog('set_token', 'Token 已更新', getClientIp(req), authData.token);
            sendJson(res, { success: true });
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 400);
          }
        });
        return;
      }

      if (pathname === '/api/token/generate' && req.method === 'POST') {
        const deviceId = req.headers['x-device-id'] || DEVICE_ID;
        const { token, refreshToken, expiresAt } = db.generateToken(deviceId, TOKEN_EXPIRES_IN);
        db.addAuditLog('generate_token', `deviceId: ${deviceId}`, getClientIp(req), token);
        sendJson(res, { success: true, token, refreshToken, expiresAt });
        return;
      }
      
      if (pathname === '/api/token/refresh' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { refreshToken } = JSON.parse(body);
            const result = db.refreshToken(refreshToken);
            if (result) {
              sendJson(res, { success: true, ...result });
            } else {
              sendJson(res, { success: false, error: 'Invalid refresh token' }, 401);
            }
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 400);
          }
        });
        return;
      }
      
      // 设备 API
      if (pathname === '/api/devices') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const devices = db.listDevices();
        sendJson(res, { success: true, devices });
        return;
      }
      
      // 文件标签 API
      if (pathname.startsWith('/api/file-tags/') && req.method === 'PUT') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const filename = decodeURIComponent(pathname.slice('/api/file-tags/'.length));
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { tags } = JSON.parse(body);
            const updated = db.updateFileByName(filename, { tags });
            if (updated) {
              broadcastChange({ type: 'update', filename, tags });
              db.addAuditLog('update_tags', `${filename}: ${tags}`, getClientIp(req), authData.token);
              sendJson(res, { success: true, tags });
            } else {
              sendJson(res, { success: false, error: 'File not found' }, 404);
            }
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 400);
          }
        });
        return;
      }
      
      if (pathname === '/api/sync/status') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const status = db.getSyncStatus();
        sendJson(res, { success: true, ...status });
        return;
      }
      
      if (pathname === '/api/sync/changes' && req.method === 'POST') {
        const authData = authRequired(req, res);
        if (!authData) return;
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { since = 0 } = JSON.parse(body);
            const changes = db.getUnsyncedLogs(since);
            sendJson(res, { success: true, changes });
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 400);
          }
        });
        return;
      }
      

      // 批量下载 API
      if (pathname === '/api/batch-download' && req.method === 'POST') {
        const authData = authRequired(req, res);
        if (!authData) return;
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { filenames } = JSON.parse(body);
            if (!Array.isArray(filenames) || filenames.length === 0) {
              sendJson(res, { success: false, error: '需要提供文件名数组' }, 400);
              return;
            }
            
            // 获取所有文件
            const files = [];
            for (const fn of filenames) {
              const file = db.getFileByName(fn);
              if (file) {
                files.push({ filename: fn, content: file.content || '' });
              }
            }
            
            if (files.length === 0) {
              sendJson(res, { success: false, error: '没有找到任何文件' }, 404);
              return;
            }
            
            // 尝试使用 archiver 打包
            let zipBuffer = null;
            try {
              const archiver = require('archiver');
              const archive = archiver('zip', { zlib: { level: 9 } });
              const chunks = [];
              archive.on('data', chunk => chunks.push(chunk));
              for (const f of files) {
                archive.append(f.content, { name: f.filename });
              }
              archive.finalize();
              zipBuffer = Buffer.concat(chunks);
            } catch (archiverErr) {
              // archiver 不可用，尝试 adm-zip
              try {
                const AdmZip = require('adm-zip');
                const zip = new AdmZip();
                for (const f of files) {
                  zip.addFile(f.filename, Buffer.from(f.content, 'utf8'));
                }
                zipBuffer = zip.toBuffer();
              } catch (admZipErr) {
                // 两者都不可用，返回文件列表
                sendJson(res, { 
                  success: true, 
                  mode: 'multiple',
                  files: files.map(f => ({ 
                    name: f.filename, 
                    size: f.content ? Buffer.byteLength(f.content, 'utf8') : 0 
                  })),
                  message: '批量打包不可用，请使用多标签页下载'
                });
                return;
              }
            }
            
            if (zipBuffer) {
              res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Disposition': 'attachment; filename="sharetool_batch.zip"',
                'Content-Length': zipBuffer.length
              });
              res.end(zipBuffer);
              db.addAuditLog('batch_download', `${files.length} files`, getClientIp(req), authData.token);
              return;
            }
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 400);
          }
        });
        return;
      }
      // 审计 API
      if (pathname === '/api/audit/logs') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const logs = db.listAuditLogs(100, 0);
        const stats = db.getAuditStats();
        sendJson(res, { success: true, logs, stats });
        return;
      }
      
      // HTTPS 证书 API
      if (pathname === '/api/https/cert') {
        const certInfo = getCertInfo();
        if (certInfo) {
          sendJson(res, { success: true, https: true, ...certInfo });
        } else {
          sendJson(res, { success: true, https: false });
        }
        return;
      }
      
      if (pathname === '/api/https/regenerate' && req.method === 'POST') {
        const authData = authRequired(req, res);
        if (!authData) return;
        try {
          const result = await ensureSslCertificates();
          if (result) {
            const info = getCertInfo();
            sendJson(res, { success: true, message: 'Certificate regenerated', ...info });
          } else {
            sendJson(res, { success: false, error: 'Failed to regenerate certificate' }, 500);
          }
        } catch (e) {
          sendJson(res, { success: false, error: e.message }, 500);
        }
        return;
      }
      
      // 分享链接 API（无需认证）
      if (pathname === '/api/share/create' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { filename, expiryHours, maxDownloads, password } = JSON.parse(body);
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
              isText: file.type === 'text'
            });
            const shareUrl = `http://${LOCAL_IP}:${PORT}/s/${shareData.code}`;
            db.addAuditLog('share_create', `code=${shareData.code}, filename=${filename}`, getClientIp(req));
            sendJson(res, { success: true, code: shareData.code, url: shareUrl, expiresAt: shareData.expiresAt });
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 400);
          }
        });
        return;
      }
      
      if (pathname === '/api/share/list') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const links = db.listShareLinks();
        sendJson(res, { success: true, links });
        return;
      }
      
      if (pathname.startsWith('/api/share/delete/') && req.method === 'DELETE') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const code = pathname.slice('/api/share/delete/'.length);
        db.deleteShareLink(code);
        db.addAuditLog('share_delete', `code=${code}`, getClientIp(req), authData.token);
        sendJson(res, { success: true });
        return;
      }
      
      // 通过分享码访问（无需认证）
      if (pathname.startsWith('/s/')) {
        const code = pathname.slice(3);
        const shareData = validateShareCode(code);
        if (!shareData) {
          sendJson(res, { success: false, error: '分享链接已过期或不存在' }, 404);
          return;
        }
        const file = db.getFileByName(shareData.filename);
        if (!file) {
          sendJson(res, { success: false, error: '文件已被删除' }, 404);
          return;
        }
        db.incrementShareLinkDownload(code);
        db.addAuditLog('share_access', `code=${code}, filename=${shareData.filename}`, getClientIp(req));
        // 加密文件不支持无密码分享
        if (file.encrypted) {
          sendJson(res, { success: false, error: '加密文件无法通过分享链接访问，请在 App 中打开' }, 403);
          return;
        }
        // 如果是文字内容，直接返回
        if (file.type === 'text') {
          sendJson(res, { success: true, type: 'text', filename: file.filename, content: file.content });
        } else {
          // 文件返回下载
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(file.filename)}"`,
            'Content-Length': file.size
          });
          res.end(file.content || '');
        }
        return;
      }
      
      // 加密/解密 API（服务端不存储密码，仅做加密运算）
      if (pathname === '/api/encrypt' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { content, password } = JSON.parse(body);
            if (!content || !password) {
              sendJson(res, { success: false, error: '需要 content 和 password' }, 400);
              return;
            }
            const encrypted = cryptoModule.encrypt(content, password);
            sendJson(res, { success: true, encrypted: encrypted.toString('base64') });
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 500);
          }
        });
        return;
      }
      
      if (pathname === '/api/decrypt' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { encrypted, password } = JSON.parse(body);
            if (!encrypted || !password) {
              sendJson(res, { success: false, error: '需要 encrypted 和 password' }, 400);
              return;
            }
            const encryptedBuffer = Buffer.from(encrypted, 'base64');
            const decrypted = cryptoModule.decrypt(encryptedBuffer, password);
            if (!decrypted) {
              sendJson(res, { success: false, error: '密码错误或数据损坏' }, 401);
              return;
            }
            sendJson(res, { success: true, content: decrypted.toString('utf8') });
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 500);
          }
        });
        return;
      }
      
      // 获取文件列表时标记加密状态
      if (pathname === '/api/files') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const { files, total } = db.listFiles(100, 0);
        sendJson(res, { success: true, files, total });
        return;
      }
      
      if (pathname === '/api/files/list') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const limit = parseInt(query.limit) || 100;
        const offset = parseInt(query.offset) || 0;
        const { files, total } = db.listFiles(limit, offset);
        sendJson(res, { success: true, files, total });
        return;
      }
      
      // 上传加密文件（客户端已加密，直接存储）
      if (pathname === '/api/files/upload-encrypted' && req.method === 'POST') {
        const authData = authRequired(req, res);
        if (!authData) return;
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { filename, encryptedContent, size } = JSON.parse(body);
            if (!filename || !encryptedContent) {
              sendJson(res, { success: false, error: '需要 filename 和 encryptedContent' }, 400);
              return;
            }
            const content = Buffer.from(encryptedContent, 'base64').toString('utf8');
            const hash = crypto.createHash('md5').update(content).digest('hex');
            const result = db.addFile(filename, content, 'file', hash, true);
            db.addAuditLog('file_upload_encrypted', `filename=${filename}`, getClientIp(req), authData.token);
            sendJson(res, { success: true, ...result });
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 500);
          }
        });
        return;
      }
      
      // 获取单个文件（包含加密标记）
      if (pathname.match(/^\/api\/files\/[^\/]+$/) && req.method === 'GET') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const filename = decodeURIComponent(pathname.slice('/api/files/'.length));
        const file = db.getFileByName(filename);
        if (!file) {
          sendJson(res, { success: false, error: '文件不存在' }, 404);
          return;
        }
        sendJson(res, { success: true, file });
        return;
      }
      
      // 标记/取消标记文件加密状态（用于手动标记已客户端加密的文件）
      if (pathname.match(/^\/api\/files\/[^\/]+\/encrypt$/) && req.method === 'POST') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const parts = pathname.split('/');
        const filename = decodeURIComponent(parts[parts.length - 2]);
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { encrypted } = JSON.parse(body);
            const file = db.updateFileByName(filename, { encrypted: !!encrypted });
            if (!file) {
              sendJson(res, { success: false, error: '文件不存在' }, 404);
              return;
            }
            db.addAuditLog('file_encrypt', `filename=${filename}, encrypted=${encrypted}`, getClientIp(req), authData.token);
            sendJson(res, { success: true, file });
          } catch (e) {
            sendJson(res, { success: false, error: e.message }, 500);
          }
        });
        return;
      }
      
      // 未知路由
      
      // 静态文件下载（需要认证）
      if (pathname.startsWith('/download/')) {
        const authData = authRequired(req, res);
        if (!authData) return;
        const filename = decodeURIComponent(pathname.slice('/download/'.length));
        const file = db.getFileByName(filename);
        if (file) {
          db.addAuditLog('download', filename, getClientIp(req), authData.token);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
            'Content-Length': file.size
          });
          res.end(file.content || '');
          return;
        }
        sendJson(res, { success: false, error: 'File not found' }, 404);
        return;
      }
      
      // 未知路由
      sendJson(res, { success: false, error: 'Not found' }, 404);
      
    } catch (e) {
      console.error('[HTTP] Error:', e);
      sendJson(res, { success: false, error: e.message }, 500);
    }
  };

  if (serverOptions.https) {
    httpServer = https.createServer(serverOptions, requestHandler);
    httpServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[HTTPS] Server listening on https://${LOCAL_IP}:${HTTPS_PORT}`);
    });
    // 同时在 HTTP 端口运行 HTTP（重定向到 HTTPS）
    const plainServer = http.createServer(requestHandler);
    plainServer.listen(PORT, '0.0.0.0', () => {
      console.log(`[HTTP] Server listening on http://${LOCAL_IP}:${PORT} (plain)`);
    });
  } else {
    httpServer = http.createServer(requestHandler);
    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`[HTTP] Server listening on http://${LOCAL_IP}:${PORT}`);
      console.log('[HTTPS] SSL certificates not found, HTTPS disabled');
      console.log('[HTTPS] Run with SSL_DIR set to enable HTTPS');
    });
  }
}

// ============================================================
// WebSocket 服务器
// ============================================================
function startWsServer() {
  wsServer = new WebSocketServer({ port: WS_PORT });
  
  wsServer.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`[WS] New connection from ${clientIp}`);
    
    ws.isAlive = true;
    ws.deviceId = null;
    
    ws.on('pong', () => { ws.isAlive = true; });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleWsMessage(ws, msg);
      } catch (e) {
        console.error('[WS] Invalid message:', e.message);
      }
    });
    
    ws.on('close', () => {
      if (ws.deviceId) {
        wsClients.delete(ws.deviceId);
        syncClients.delete(ws);
        db.setDeviceOffline(ws.deviceId);
        broadcastDeviceList();
        console.log(`[WS] Device ${ws.deviceId} disconnected`);
      }
    });
    
    ws.on('error', (e) => {
      console.error('[WS] Error:', e.message);
    });
  });

  // 心跳检测
  const heartbeat = setInterval(() => {
    wsServer.clients.forEach((ws) => {
      if (!ws.isAlive) {
        if (ws.deviceId) {
          wsClients.delete(ws.deviceId);
          db.setDeviceOffline(ws.deviceId);
        }
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wsServer.on('close', () => clearInterval(heartbeat));
  
  console.log(`[WS] WebSocket server on ws://${LOCAL_IP}:${WS_PORT}`);
}

function handleWsMessage(ws, msg) {
  const { type, payload } = msg;
  
  switch (type) {
    case 'register': {
      // 设备注册
      const { deviceId, deviceName } = payload;
      ws.deviceId = deviceId;
      wsClients.set(deviceId, ws);
      syncClients.add(ws);
      db.registerDevice(deviceId, deviceName || deviceId, LOCAL_IP, PORT);
      db.setDeviceOnline(deviceId);
      
      // 发送当前状态
      const { files } = db.listFiles(100, 0);
      ws.send(JSON.stringify({
        type: 'registered',
        payload: {
          deviceId: DEVICE_ID,
          deviceName: DEVICE_NAME,
          files: files.map(f => ({ id: f.id, name: f.filename, size: f.size, time: f.created_at * 1000, type: f.type, hash: f.hash, tags: f.tags })),
          devices: db.listDevices().map(d => ({ deviceId: d.device_id, deviceName: d.device_name, ip: d.ip, isOnline: d.is_online === 1 }))
        }
      }));
      
      broadcastDeviceList();
      console.log(`[WS] Device registered: ${deviceId} (${deviceName})`);
      break;
    }
    
    case 'sync_request': {
      // 同步请求 - 获取未同步的变更
      const { since = 0 } = payload;
      const changes = db.getUnsyncedLogs(since);
      ws.send(JSON.stringify({ type: 'sync_response', payload: { changes } }));
      break;
    }
    
    case 'sync_push': {
      // 推送本地变更到服务器
      const { changes = [] } = payload;
      const processedIds = [];
      
      for (const change of changes) {
        if (change.action === 'create' || change.action === 'update') {
          db.addFile(change.filename, change.content, change.type || 'file');
          processedIds.push(change.id);
        } else if (change.action === 'delete') {
          db.deleteFileByName(change.filename);
          processedIds.push(change.id);
        }
      }
      
      if (processedIds.length > 0) {
        db.markLogsSynced(processedIds);
        broadcastChange({ type: 'bulk_update', count: changes.length }, ws.deviceId);
      }
      
      ws.send(JSON.stringify({ type: 'sync_ack', payload: { processed: processedIds.length } }));
      break;
    }
    
    case 'file_create': {
      const { filename, content, type, hash } = payload;
      db.addFile(filename, content, type || 'file', hash);
      broadcastChange({ type: 'create', filename, hash }, ws.deviceId);
      break;
    }
    
    case 'file_update': {
      const { filename, content, type, hash } = payload;
      db.updateFileByName(filename, { content, type, hash });
      broadcastChange({ type: 'update', filename, hash }, ws.deviceId);
      break;
    }
    
    case 'file_delete': {
      const { filename } = payload;
      db.deleteFileByName(filename);
      broadcastChange({ type: 'delete', filename }, ws.deviceId);
      break;
    }
    
    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong' }));
      if (ws.deviceId) db.touchDevice(ws.deviceId);
      break;
    }
  }
}

function broadcastChange(change, excludeDeviceId = null) {
  const msg = JSON.stringify({ type: 'change', payload: change });
  syncClients.forEach((ws) => {
    if (ws !== excludeDeviceId && ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

function broadcastDeviceList() {
  const devices = db.listDevices().map(d => ({
    deviceId: d.device_id,
    deviceName: d.device_name,
    ip: d.ip,
    isOnline: d.is_online === 1
  }));
  const msg = JSON.stringify({ type: 'device_list', payload: { devices } });
  syncClients.forEach((ws) => {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

// ============================================================
// UDP 设备发现
// ============================================================
function startDiscovery() {
  udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  
  udpServer.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      
      if (data.type === 'discovery') {
        // 收到发现请求，响应本机信息
        const response = JSON.stringify({
          type: 'discovery_response',
          payload: {
            deviceId: DEVICE_ID,
            deviceName: DEVICE_NAME,
            ip: LOCAL_IP,
            port: PORT,
            wsPort: WS_PORT
          }
        });
        udpServer.send(response, rinfo.port, rinfo.address);
      }
      else if (data.type === 'discovery_response') {
        // 收到其他设备响应，注册到数据库
        if (data.payload.deviceId !== DEVICE_ID) {
          db.registerDevice(
            data.payload.deviceId,
            data.payload.deviceName,
            data.payload.ip,
            data.payload.port
          );
          console.log(`[Discovery] Found device: ${data.payload.deviceName} (${data.payload.ip})`);
        }
      }
    } catch (e) {
      // 忽略无效消息
    }
  });
  
  udpServer.on('error', (e) => {
    console.error('[Discovery] Error:', e.message);
  });
  
  udpServer.bind(DISCOVERY_PORT, () => {
    udpServer.setBroadcast(true);
    console.log(`[Discovery] UDP server on port ${DISCOVERY_PORT}`);
    
    // 立即广播一次
    broadcastDiscovery();
    
    // 定时广播
    broadcastTimer = setInterval(broadcastDiscovery, BROADCAST_INTERVAL);
  });
}

function broadcastDiscovery() {
  const msg = JSON.stringify({
    type: 'discovery',
    payload: {
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      ip: LOCAL_IP,
      port: PORT,
      wsPort: WS_PORT
    }
  });
  
  // 广播到同网段所有设备
  udpServer.send(msg, DISCOVERY_PORT, '255.255.255.255', (e) => {
    if (e) console.error('[Discovery] Broadcast error:', e.message);
  });
}

function startHeartbeat() {
  setInterval(() => {
    db.touchDevice(DEVICE_ID);
    db.cleanupStaleDevices(5); // 5分钟不活跃视为离线
  }, 60000);
}

function startSyncScheduler() {
  // 每分钟检查一次同步状态
  setInterval(() => {
    const onlineDevices = db.getOnlineDevices().filter(d => d.device_id !== DEVICE_ID);
    const { unsynced } = db.getSyncStatus();
    
    if (onlineDevices.length > 0 && unsynced > 0) {
      console.log(`[Sync] ${unsynced} unsynced changes, ${onlineDevices.length} online devices`);
    }
  }, 60000);
  
  // 每小时清理一次过期 Token 和分享链接
  setInterval(() => {
    db.cleanupExpiredTokens();
    db.cleanupExpiredShareLinks();
  }, 3600000);
}

// ============================================================
// HTML 页面
// ============================================================
function sendHtml(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(getHtml());
}

function getHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ShareTool</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg-primary: #0f172a;
  --bg-secondary: #1e293b;
  --bg-tertiary: #0f172a;
  --border-color: var(--border-color);
  --text-primary: #e2e8f0;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --accent-primary: #667eea;
  --accent-secondary: #764ba2;
  --success: #22c55e;
  --danger: #dc2626;
  --warning: #d97706;
}
[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f8fafc;
  --bg-tertiary: #f1f5f9;
  --border-color: var(--text-primary);
  --text-primary: #1e293b;
  --text-secondary: #475569;
  --text-muted: #64748b;
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; }
.container { max-width: 900px; margin: 0 auto; padding: 24px; }
header { text-align: center; margin-bottom: 32px; }
h1 { font-size: 32px; font-weight: 700; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 8px; }
.subtitle { color: var(--text-muted); font-size: 14px; }
.status-bar { display: flex; gap: 16px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
.status-item { font-size: 12px; padding: 4px 12px; background: var(--bg-secondary); border-radius: 20px; border: 1px solid var(--border-color); }
.status-item.connected { border-color: var(--success); color: #4ade80; }
.status-item.disconnected { border-color: var(--text-muted); color: var(--text-muted); }
.hero { background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px; padding: 24px; margin-bottom: 24px; border: 1px solid var(--border-color); }
.hero-content { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
.hero-text { flex: 1; min-width: 200px; }
.hero-title { font-size: 18px; font-weight: 600; color: var(--text-primary); margin-bottom: 12px; }
.hero-desc { font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 8px; }
.hero-features { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.hero-feature { background: rgba(102, 126, 234, 0.15); padding: 4px 10px; border-radius: 20px; font-size: 11px; color: #667eea; }
.card { background: var(--bg-secondary); border-radius: 16px; padding: 24px; margin-bottom: 20px; border: 1px solid var(--border-color); }
.section-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: var(--text-secondary); display: flex; align-items: center; gap: 8px; }
.section-title::before { content: ''; width: 4px; height: 16px; background: linear-gradient(180deg, #667eea, #764ba2); border-radius: 2px; }
textarea { width: 100%; padding: 14px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 10px; color: var(--text-primary); font-size: 14px; margin-bottom: 12px; resize: vertical; min-height: 100px; font-family: inherit; }
textarea:focus { outline: none; border-color: var(--accent-primary); }
input[type="text"], input[type="search"] { width: 100%; padding: 12px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 10px; color: var(--text-primary); font-size: 14px; margin-bottom: 12px; }
input:focus { outline: none; border-color: var(--accent-primary); }
.btn { padding: 12px 20px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; border-radius: 10px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; }
.btn:hover { opacity: 0.9; transform: translateY(-1px); }
.btn:active { transform: translateY(0); }
.btn-secondary { background: var(--bg-secondary); }
.btn-danger { background: #dc2626; }
.btn-warning { background: #d97706; }
.btn-sm { padding: 8px 14px; font-size: 13px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; }
.file-upload-area { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; background: var(--bg-tertiary); border: 2px dashed var(--border-color); border-radius: 12px; cursor: pointer; transition: all 0.2s; text-align: center; }
.file-upload-area:hover { border-color: var(--accent-primary); background: #1a2744; }
.file-upload-area input { position: absolute; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.file-upload-area .icon { font-size: 40px; margin-bottom: 12px; }
.file-upload-area .text { color: var(--text-muted); font-size: 14px; }
.file-upload-area .hint { color: var(--text-muted); font-size: 12px; margin-top: 8px; }
.file-list { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.file-item { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px; background: var(--bg-tertiary); border-radius: 10px; border: 1px solid var(--border-color); gap: 12px; }
.file-item:hover { border-color: var(--text-muted); }
.file-content { flex: 1; min-width: 0; }
.file-preview { background: var(--bg-secondary); border-radius: 8px; padding: 12px; margin-top: 8px; max-height: 150px; overflow: auto; white-space: pre-wrap; font-size: 12px; color: var(--text-secondary); border: 1px solid var(--border-color); word-break: break-all; display: none; }
.file-preview.show { display: block; }
.file-name { font-weight: 500; color: var(--text-primary); word-break: break-all; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.file-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.file-tag { font-size: 10px; padding: 2px 6px; background: rgba(102,126,234,0.2); color: #667eea; border-radius: 4px; cursor: pointer; transition: all 0.15s; }
.file-tag:hover { background: rgba(102,126,234,0.35); }
.file-tag .remove-tag { margin-left: 4px; opacity: 0.6; }
.file-tag .remove-tag:hover { opacity: 1; }
.file-meta { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.file-actions { display: flex; gap: 8px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.empty { text-align: center; padding: 30px; color: var(--text-muted); }
.empty-icon { font-size: 48px; margin-bottom: 12px; opacity: 0.5; }
.empty-text { font-size: 14px; }
.alert { padding: 12px 16px; border-radius: 10px; margin-bottom: 16px; font-size: 14px; display: none; }
.alert-success { background: rgba(34, 197, 94, 0.15); border: 1px solid #22c55e; color: #4ade80; }
.alert-error { background: rgba(220, 38, 38, 0.15); border: 1px solid #dc2626; color: #f87171; }
.alert-info { background: rgba(59, 130, 246, 0.15); border: 1px solid #3b82f6; color: #60a5fa; }
.alert.show { display: block; }
.code-box { background: var(--bg-tertiary); padding: 14px; border-radius: 10px; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; color: #4ade80; margin: 8px 0; overflow-x: auto; border: 1px solid var(--border-color); white-space: pre-wrap; word-break: break-all; }
.progress-bar { width: 100%; height: 8px; background: var(--bg-secondary); border-radius: 4px; overflow: hidden; margin-top: 8px; }
.progress-bar .fill { height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); transition: width 0.3s; }
.batch-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.setting-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.setting-row label { color: var(--text-secondary); font-size: 14px; min-width: 80px; }
.setting-row input { flex: 1; margin-bottom: 0; }
.device-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.device-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--bg-tertiary); border-radius: 8px; border: 1px solid var(--border-color); font-size: 13px; }
.device-item .indicator { width: 8px; height: 8px; border-radius: 50%; background: #64748b; }
.device-item .indicator.online { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
.device-item .name { flex: 1; color: var(--text-primary); }
.device-item .ip { color: var(--text-muted); font-family: monospace; }
.search-bar { display: flex; gap: 8px; margin-bottom: 16px; }
.search-bar input { flex: 1; margin-bottom: 0; }
.filter-tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.filter-tab { padding: 6px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 20px; font-size: 12px; color: var(--text-muted); cursor: pointer; transition: all 0.2s; }
.filter-tab:hover { border-color: var(--accent-primary); }
.filter-tab.active { background: rgba(102,126,234,0.2); border-color: var(--accent-primary); color: #667eea; }
.tab-bar { display: flex; gap: 4px; margin-bottom: 16px; background: var(--bg-tertiary); padding: 4px; border-radius: 10px; }
.tab-item { flex: 1; padding: 10px; text-align: center; font-size: 14px; color: var(--text-muted); border-radius: 8px; cursor: pointer; transition: all 0.2s; }
.tab-item:hover { color: var(--text-primary); }
.tab-item.active { background: var(--bg-secondary); color: #667eea; font-weight: 500; }
.qr-section { display: none; text-align: center; padding: 16px; background: var(--bg-tertiary); border-radius: 12px; margin-bottom: 16px; }
.qr-section.show { display: block; }
.qr-section canvas { border-radius: 8px; margin: 0 auto 8px; }
.qr-url { font-size: 12px; color: var(--text-muted); word-break: break-all; font-family: monospace; }
.file-checkbox { width: 18px; height: 18px; accent-color: var(--accent-primary); cursor: pointer; flex-shrink: 0; }
.batch-bar { display: none; gap: 8px; align-items: center; padding: 8px 12px; background: var(--bg-tertiary); border-radius: 8px; margin-bottom: 12px; font-size: 13px; }
.batch-bar.show { display: flex; }
.batch-bar .batch-count { color: var(--text-muted); flex: 1; }
.batch-bar button { padding: 6px 12px; background: var(--accent-primary); border: none; border-radius: 6px; color: white; font-size: 12px; cursor: pointer; }
.batch-bar button.danger { background: #e53935; }
.drop-zone { border: 2px dashed var(--border-color); border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 16px; transition: all 0.2s; color: var(--text-muted); font-size: 13px; }
.drop-zone.drag-over { border-color: var(--accent-primary); background: rgba(102,126,234,0.1); color: var(--accent-primary); }
.drop-zone-icon { font-size: 24px; margin-bottom: 8px; }
.file-type-icon { font-size: 16px; margin-right: 6px; }
.fab { display: none; position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px; border-radius: 50%; background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; font-size: 24px; cursor: pointer; box-shadow: 0 4px 20px rgba(102,126,234,0.4); z-index: 100; transition: transform 0.2s; }
.fab:hover { transform: scale(1.1); }
.fab-menu { display: none; position: fixed; bottom: 90px; right: 24px; flex-direction: column; gap: 8px; z-index: 99; }
.fab-menu.show { display: flex; }
.fab-menu .btn { width: 48px; height: 48px; border-radius: 50%; padding: 0; font-size: 18px; }
.search-highlight { background: rgba(102,126,234,0.4); color: #a5b4fc; border-radius: 2px; padding: 0 2px; }
.tag-filter-btn { cursor: pointer; transition: all 0.2s; }
.loading-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--text-muted); border-top-color: var(--accent-primary); border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.file-item { animation: fadeIn 0.2s ease-out; }
.toast { position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%); background: var(--bg-secondary); border: 1px solid var(--border-color); padding: 12px 24px; border-radius: 10px; font-size: 14px; z-index: 200; box-shadow: 0 4px 20px rgba(0,0,0,0.3); opacity: 0; transition: opacity 0.3s; }
.toast.show { opacity: 1; }
@media (max-width: 500px) {
  .container { padding: 16px; padding-bottom: 100px; }
  .actions { flex-direction: column; }
  .btn { width: 100%; text-align: center; }
  .file-actions { justify-content: flex-start; flex-wrap: wrap; }
  .file-item { flex-direction: column; }
  .file-actions .btn { width: auto; flex: 1; min-width: 60px; text-align: center; font-size: 12px; padding: 8px 10px; }
  .setting-row { flex-direction: column; align-items: stretch; }
  .setting-row label { min-width: auto; }
  .hero-content { flex-direction: column; }
  .hero-url { flex-direction: column; }
  .status-bar { flex-direction: column; align-items: center; }
  .search-bar { flex-direction: column; }
  .search-bar .btn { width: 100%; }
.qr-section.show { display: block; }
.conn-status { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted); margin-left: 8px; }
.conn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
.conn-dot.connected { background: #4caf50; box-shadow: 0 0 4px #4caf50; }
.storage-bar { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-muted); }
.storage-bar progress { width: 80px; height: 6px; accent-color: var(--accent-primary); }
.storage-text { font-size: 11px; color: var(--text-muted); }
.share-link-box { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.share-link-box input { flex: 1; padding: 6px 10px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 12px; font-family: monospace; }
.share-link-box button { padding: 6px 12px; background: var(--accent-primary); border: none; border-radius: 6px; color: white; font-size: 12px; cursor: pointer; }
.upload-progress-bar { width: 100%; height: 4px; background: var(--bg-tertiary); border-radius: 2px; margin-top: 8px; overflow: hidden; display: none; }
.upload-progress-fill { height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); border-radius: 2px; transition: width 0.3s; }
.file-star { cursor: pointer; font-size: 16px; color: var(--text-muted); transition: color 0.2s; user-select: none; }
.file-star:hover { color: #f5a623; }
.file-star.starred { color: #f5a623; }
.notif-badge { position: fixed; top: 12px; right: 12px; background: #e53935; color: white; border-radius: 50%; width: 20px; height: 20px; font-size: 11px; display: none; align-items: center; justify-content: center; z-index: 400; font-weight: bold; }
.notif-badge.show { display: flex; }
.filter-tab .kbd-hint { font-size: 9px; opacity: 0.6; }
.fav-filter-btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 14px; font-size: 12px; color: var(--text-muted); cursor: pointer; }
.fav-filter-btn:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
.fav-filter-btn.active { background: rgba(245,166,35,0.15); border-color: #f5a623; color: #f5a623; }
.shortcut-list { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; font-size: 13px; }
.shortcut-key { font-family: monospace; background: var(--bg-tertiary); padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border-color); }
.shortcut-desc { color: var(--text-secondary); align-self: center; }
.paste-hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
.recent-searches { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.recent-search-tag { padding: 3px 8px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 12px; font-size: 11px; color: var(--text-muted); cursor: pointer; }
.recent-search-tag:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
.fab { display: flex; align-items: center; justify-content: center; }
.tab-bar { position: sticky; top: 0; background: var(--bg-tertiary); z-index: 50; margin-bottom: 12px; }
.hide-mobile { display: none; }
.sort-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; font-size: 12px; color: var(--text-muted); }
.sort-bar select { padding: 6px 10px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-primary); font-size: 12px; }
.sort-bar select:focus { outline: none; border-color: var(--accent-primary); }
.pagination { display: flex; gap: 4px; align-items: center; justify-content: center; margin-top: 16px; }
.pagination button { padding: 6px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-muted); cursor: pointer; font-size: 12px; }
.pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
.pagination button.active { background: rgba(102,126,234,0.2); border-color: var(--accent-primary); color: #667eea; }
.pagination .page-info { font-size: 12px; color: var(--text-muted); padding: 0 8px; }
.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 300; display: none; align-items: center; justify-content: center; }
.modal-overlay.show { display: flex; }
.modal-content { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; max-width: 700px; width: 90%; max-height: 80vh; overflow: auto; }
.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.modal-title { font-size: 16px; font-weight: 600; color: var(--text-primary); word-break: break-all; }
.modal-close { background: none; border: none; color: var(--text-muted); font-size: 24px; cursor: pointer; }
.modal-close:hover { color: var(--text-primary); }
.modal-body { font-size: 14px; color: var(--text-secondary); line-height: 1.6; white-space: pre-wrap; word-break: break-all; max-height: 60vh; overflow: auto; }
.modal-meta { font-size: 12px; color: var(--text-muted); margin-bottom: 12px; }
.kbd-hint { font-size: 11px; color: var(--text-muted); text-align: center; margin-top: 8px; }
.kbd { display: inline-block; padding: 2px 6px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 11px; }
}
</style>
</head>
<body>
<div class="container">
  <header>
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <div>
        <h1>ShareTool<span class="conn-status"><span class="conn-dot" id="connDot"></span><span id="connText">连接中</span></span></h1>
        <p class="subtitle">局域网文件/文字分享</p>
      </div>
      <button id="themeToggle" style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 8px 12px; cursor: pointer; color: var(--text-primary); font-size: 18px;" title="切换主题">🌙</button>
    </div>
    <div class="status-bar">
      <span class="status-item disconnected" id="wsStatus">WS 未连接</span>
      <span class="storage-text" id="storageText">加载中...</span>
      <span class="status-item disconnected" id="syncStatus">同步离线</span>
      <span class="status-item" id="deviceCount">设备: 0</span>
    </div>
  </header>

  <div class="hero">
    <div class="hero-content">
      <div class="hero-text">
        <div class="hero-title">📡 局域网文件/文字分享</div>
        <div class="hero-desc">同一 WiFi 网络下扫码访问，支持多设备同步。</div>
        <div class="hero-features">
          <span class="hero-feature">📝 文字分享</span>
          <span class="hero-feature">📁 文件上传</span>
          <span class="hero-feature">🔄 多设备同步</span>
          <span class="hero-feature">🔍 搜索过滤</span>
          <span class="hero-feature">📱 移动适配</span>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="section-title">分享文字</div>
    <div id="textAlert" class="alert"></div>
    <textarea id="textContent" placeholder="输入文字、代码或粘贴内容..."></textarea>
    <div class="paste-hint" id="pasteHint">📋 可直接 Ctrl+V 粘贴图片或文件</div>
    <div class="actions">
      <button class="btn" id="shareTextBtn">分享</button>
      <button class="btn btn-secondary" id="clearTextBtn">清空</button>
    </div>
    <div class="upload-progress-bar" id="uploadProgressBar">
      <div class="upload-progress-fill" id="uploadProgressFill" style="width:0%"></div>
    </div>
    <div class="share-link-box" id="shareLinkBox" style="display:none;">
      <input type="text" id="shareLinkInput" readonly>
      <button onclick="copyShareLink()">复制链接</button>
    </div>
  </div>

  <div class="card">
    <div class="section-title">上传文件</div>
    <div id="uploadAlert" class="alert"></div>
    <div class="drop-zone" id="dropZone">
      <div class="drop-zone-icon">📂</div>
      <div>拖拽文件到此处上传</div>
      <div style="font-size:12px;margin-top:4px;">或继续使用下方按钮</div>
    </div>

    <label class="file-upload-area">
      <input type="file" id="fileInput" multiple webkitdirectory>
      <div class="icon">📁</div>
      <div class="text">点击或拖拽文件到此处</div>
      <div class="hint">支持文件和文件夹上传</div>
    </label>
    <div id="uploadList" class="file-list"></div>
  </div>

  <div class="card">
    <div class="section-title">最近分享</div>
    <div id="listAlert" class="alert"></div>
    <button class="fav-filter-btn" id="favFilterBtn" onclick="toggleFavFilter()">☆ 收藏</button>

    <div class="recent-searches" id="recentSearches" style="display:none;"></div>
    <div class="search-bar">
      <input type="search" id="searchInput" placeholder="搜索文件名或内容...">
      <button class="btn btn-sm" onclick="doSearch()">搜索</button>
      <button class="btn btn-sm btn-secondary" id="clearSearchBtn" onclick="clearSearch()" style="display:none;">×</button>
    </div>
    <div class="filter-tabs">
      <span class="filter-tab active" data-filter="all">全部</span>
      <span class="filter-tab" data-filter="text">文字</span>
      <span class="filter-tab" data-filter="file">文件</span>
    </div>
    <div class="batch-bar" id="batchBar">
      <span class="batch-count" id="batchCount">已选择 0 个文件</span>
      <button onclick="batchDelete()">批量删除</button>
      <button onclick="batchAddTag()">批量标签</button>
      <button class="danger" onclick="clearBatch()">取消</button>
    </div>

    <div class="filter-tabs" id="tagFilterBar" style="margin-top:4px;">
      <!-- Dynamic tags will be injected here -->
    </div>
    <div class="sort-bar">
      <span>排序:</span>
      <select id="sortSelect" onchange="setSort(this.value)">
        <option value="time_desc">最新优先</option>
        <option value="time_asc">最旧优先</option>
        <option value="name_asc">名称 A-Z</option>
        <option value="name_desc">名称 Z-A</option>
        <option value="size_desc">最大优先</option>
        <option value="size_asc">最小优先</option>
      </select>
      <span id="fileCount" style="margin-left:auto;"></span>
    </div>
    <div class="batch-actions">
      <button class="btn btn-sm btn-warning" onclick="deleteOld(7)">删除1周前</button>
      <button class="btn btn-sm btn-warning" onclick="deleteOld(30)">删除1月前</button>
      <button class="btn btn-sm btn-danger" onclick="deleteAll()">删除所有</button>
      <button class="btn btn-sm" onclick="batchDownload()" id="batchDownloadBtn" style="display:none;">📦 批量下载 (<span id="batchCount">0</span>)</button>
    </div>
    <div class="setting-row">
      <label>下载目录:</label>
      <input type="text" id="downloadDir" value="">
      <button class="btn btn-sm" onclick="saveDownloadDir()">保存</button>
    </div>
    <div id="downloadProgress" style="display:none;">
      <div class="progress-bar"><div class="fill" id="progressFill" style="width:0%"></div></div>
      <div id="progressText" style="font-size:12px;color:#64748b;margin-top:4px;"></div>
    </div>
    <div id="filesContainer">
      <div class="empty" id="emptyState">
        <div class="empty-icon">📭</div>
        <div class="empty-text">暂无分享内容</div>
        <div class="empty-text" style="font-size:12px;margin-top:8px;">上传文件或分享文字开始使用</div>
      </div>
    </div>
    <div class="pagination" id="pagination"></div>
  </div>

  <div class="card">
    <div class="section-title">同步设备</div>
    <div class="device-list" id="deviceList">
      <div class="empty"><div class="empty-icon" style="font-size:32px;">📡</div><div class="empty-text">正在发现设备...</div></div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="fileModal" onclick="if(event.target===this)closeModal()">
  <div class="modal-content">
    <div class="modal-header">
      <div class="modal-title" id="modalTitle"></div>
      <button class="modal-close" onclick="closeModal()">x</button>
    </div>
    <div class="modal-meta" id="modalMeta"></div>
    <div class="modal-body" id="modalBody"></div>
    <div class="kbd-hint"><span class="kbd">Esc</span> close</div>
  </div>
</div>

<div class="notif-badge" id="notifBadge"></div>
<div id="toast" class="toast"></div>

<div class="modal-overlay" id="shortcutModal" onclick="if(event.target===this)closeShortcutModal()">
  <div class="modal-content" style="max-width:400px;">
    <div class="modal-header">
      <div class="modal-title">键盘快捷键</div>
      <button class="modal-close" onclick="closeShortcutModal()">x</button>
    </div>
    <div class="shortcut-list">
      <span class="shortcut-key">f</span><span class="shortcut-desc">切换收藏筛选</span>
      <span class="shortcut-key">r</span><span class="shortcut-desc">刷新文件列表</span>
      <span class="shortcut-key">/</span><span class="shortcut-desc">聚焦搜索框</span>
      <span class="shortcut-key">Esc</span><span class="shortcut-desc">关闭弹窗/取消搜索</span>
      <span class="shortcut-key">?</span><span class="shortcut-desc">显示此帮助</span>
    </div>
  </div>
</div>

<script>
const API = '';
let AUTH_TOKEN = '';
const WS_URL = 'ws://' + location.hostname + ':${WS_PORT}';
const DEVICE_ID = '${DEVICE_ID}';
const DEVICE_NAME = navigator.platform || 'Unknown';

let ws = null;
let currentFiles = [];
let config = {};
let currentFilter = 'all';
let reconnectTimer = null;
let reconnectDelay = 1000;
let isConnected = false;
let currentSort = 'time_desc';
let currentPage = 1;
const PAGE_SIZE = 20;
let showFavoritesOnly = false;

function toggleFavFilter() {
  showFavoritesOnly = !showFavoritesOnly;
  const btn = document.getElementById('favFilterBtn');
  if (btn) {
    btn.classList.toggle('active', showFavoritesOnly);
    btn.innerHTML = showFavoritesOnly ? '★ 收藏' : '☆ 收藏';
  }
  currentPage = 1;
  renderFiles();
  if (window.currentSearchQ) applySearchHighlight(window.currentSearchQ);
}

function applyFavoritesFilter(files) {
  if (!showFavoritesOnly) return files;
  const favs = getFavorites();
  return files.filter(f => favs.includes(f.name));
}

function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) headers['x-auth-token'] = AUTH_TOKEN;
  return headers;
}

function getApiHeaders(method) {
  return { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' };
}

function showAlert(id, msg, type, show = true) {
  const el = document.getElementById(id);
  el.className = 'alert alert-' + type + (show ? ' show' : '');
  el.textContent = msg;
  if (show) setTimeout(() => { if (el) el.className = 'alert alert-' + type; }, 4000);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('zh-CN');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function btoaSafe(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(match, p1) {
    return String.fromCharCode(parseInt(p1, 16));
  }));
}

// WebSocket 连接
function connectWS() {
  try {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
    isConnected = true;
    const dot = document.getElementById('connDot');
    const txt = document.getElementById('connText');
    if (dot) dot.classList.add('connected');
    if (txt) txt.textContent = '已连接';
    const statusEl = document.getElementById('wsStatus');
    if (statusEl) { statusEl.className = 'status-item connected'; statusEl.textContent = 'WS 已连接'; }

      console.log('[WS] Connected');
      isConnected = true;
      reconnectDelay = 1000;
      updateWsStatus(true);
      
      ws.send(JSON.stringify({
        type: 'register',
        payload: { deviceId: DEVICE_ID, deviceName: DEVICE_NAME }
      }));
    };
    
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {}
    };
    
    ws.onclose = () => {
    isConnected = false;
    const dot = document.getElementById('connDot');
    const txt = document.getElementById('connText');
    if (dot) dot.classList.remove('connected');
    if (txt) txt.textContent = '未连接';
    const statusEl = document.getElementById('wsStatus');
    if (statusEl) { statusEl.className = 'status-item disconnected'; statusEl.textContent = 'WS 未连接'; }

      console.log('[WS] Disconnected');
      isConnected = false;
      updateWsStatus(false);
      scheduleReconnect();
    };
    
    ws.onerror = (e) => {
      console.error('[WS] Error:', e);
    };
  } catch (e) {
    console.error('[WS] Connect failed:', e);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log('[WS] Reconnecting...');
    connectWS();
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }, reconnectDelay);
}

function updateWsStatus(connected) {
  const el = document.getElementById('wsStatus');
  if (connected) {
    el.className = 'status-item connected';
    el.textContent = 'WS 已连接';
  } else {
    el.className = 'status-item disconnected';
    el.textContent = 'WS 未连接';
  }
}

function handleWsMessage(msg) {
  const { type, payload } = msg;
  
  switch (type) {
    case 'registered': {
      currentFiles = payload.files || [];
      renderFiles();
      renderDevices(payload.devices || []);
      document.getElementById('syncStatus').textContent = '同步在线';
      updateTagFilterBar();
      break;
    }
    case 'change':
    case 'file_create':
    case 'file_update':
    case 'file_delete': {
      if (type === 'change' && payload.type === 'bulk_update') {
        loadFiles();
      } else if (type === 'change' && payload.type === 'bulk_delete') {
        loadFiles();
      } else {
        loadFiles();
      }
      // Toast notification for remote changes
      if (type === 'file_create') showToast('📤 收到新文件: ' + (payload.filename || '').substring(0, 30));
      else if (type === 'file_delete') showToast('🗑 远程删除了文件');
      else if (type === 'change' && payload.type === 'create') showToast('📤 收到新文件: ' + (payload.filename || '').substring(0, 30));
      break;
    }
    case 'device_list': {
      renderDevices(payload.devices || []);
      break;
    }
    case 'pong': {
      break;
    }
  }
}

function renderDevices(devices) {
  const container = document.getElementById('deviceList');
  document.getElementById('deviceCount').textContent = '设备: ' + devices.length;
  
  if (!devices.length) {
    container.innerHTML = '<div class="empty"><div class="empty-icon" style="font-size:32px;">📡</div><div class="empty-text">暂无在线设备</div></div>';
    return;
  }
  
  container.innerHTML = devices.map(d => 
    '<div class="device-item">' +
      '<div class="indicator ' + (d.isOnline ? 'online' : '') + '"></div>' +
      '<div class="name">' + escapeHtml(d.deviceName || d.deviceId) + '</div>' +
      '<div class="ip">' + d.ip + '</div>' +
    '</div>'
  ).join('');
}

async function loadFiles() {
  try {
    const res = await fetch(API + '/api/list', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    currentFiles = data.files || [];
    renderFiles();
    updateTagFilterBar();
  } catch (e) {
    console.error('Load files failed:', e);
  }
}

function updateTagFilterBar() {
  const bar = document.getElementById('tagFilterBar');
  if (!bar) return;
  const allTags = new Set();
  currentFiles.forEach(f => {
    if (f.tags) {
      f.tags.split(',').map(t => t.trim()).filter(t => t).forEach(t => allTags.add(t));
    }
  });
  if (allTags.size === 0) {
    bar.innerHTML = '';
    return;
  }
  const sorted = Array.from(allTags).sort();
  bar.innerHTML = sorted.map(t => {
    const active = (window.currentSearchQ || '').includes('tag:' + t) ? 'active' : '';
    return '<span class="filter-tab ' + active + '" onclick="filterByTag(\'' + t.replace(/'/g, "\\'") + '\')" style="font-size:11px;">🏷 ' + escapeHtml(t) + '</span>';
  }).join('');
}

function renderFiles() {
  const container = document.getElementById('filesContainer');
  const emptyState = document.getElementById('emptyState');
  
  let files = currentFiles;
  if (currentFilter !== 'all') {
    files = files.filter(f => f.type === currentFilter);
  }
  
  // Apply favorites filter
  files = applyFavoritesFilter(files);

  // Apply sorting
  files = applySort(files);

  // Update count
  const countEl = document.getElementById('fileCount');
  if (countEl) countEl.textContent = files.length + ' 个文件';
  
  // Pagination
  const totalPages = Math.ceil(files.length / PAGE_SIZE) || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pagedFiles = files.slice(start, start + PAGE_SIZE);
  
  if (pagedFiles.length === 0 && files.length > 0) {
    currentPage = 1;
    renderFiles();
    return;
  }
  
  if (files.length === 0) {
    container.innerHTML = '<div class="empty" id="emptyState">' +
      '<div class="empty-icon">📭</div>' +
      '<div class="empty-text">暂无分享内容</div>' +
      '<div class="empty-text" style="font-size:12px;margin-top:8px;">上传文件或分享文字开始使用</div>' +
      '</div>';
    renderPagination(0, 1);
    return;
  }

  container.innerHTML = '<div class="file-list">' + pagedFiles.map(f => {
    const isText = f.type === 'text';
    const previewId = 'preview-' + btoaSafe(f.name).substring(0, 20);
    const tags = f.tags ? f.tags.split(',').filter(t => t.trim()) : [];
    const searchQ = (window.currentSearchQ || '').trim();
    
    // Search highlight applied by applySearchHighlight() after render
    
    return '<div class="file-item" data-filename="' + escapeHtml(f.name) + '">' +
      '<div style="margin-right: 12px;">' +
        '<input type="checkbox" class="batch-checkbox" value="' + encodeURIComponent(f.name) + '" style="width: 18px; height: 18px; cursor: pointer;">' +
      '</div>' +
      '<div class="file-content">' +
        '<div class="file-name"><span class="file-type-icon">' + getFileIcon(f.name) + '</span><span class="search-target">' + escapeHtml(f.name) + '</span></div>' +
        (tags.length ? '<div class="file-tags">' + tags.map(t => '<span class="file-tag" onclick="filterByTag(\'' + escapeHtml(t.trim()) + '\')">' + escapeHtml(t.trim()) + '<span class="remove-tag" onclick="event.stopPropagation(); removeTag(\'' + encodeURIComponent(f.name) + '\', \'' + escapeHtml(t.trim()) + '\')">×</span></span>').join('') + '</div>' : '') +
        '<button class="btn btn-sm" style="margin-top:6px;font-size:11px;padding:4px 10px;" onclick="addTag(\'' + encodeURIComponent(f.name) + '\', \'' + (f.tags || '') + '\')">+标签</button>' +
        '<div class="file-meta">' + formatSize(f.size) + ' | ' + formatTime(f.time) + '</div>' +
        (isText ? '<div class="file-preview" id="' + previewId + '"></div>' : '') +
      '</div>' +
      '<div class="file-actions">' +
        (isText ? '<button class="btn btn-sm" onclick="openFileModal(\'' + encodeURIComponent(f.name) + '\')">预览</button>' : '') +
        '<button class="btn btn-sm" onclick="copyContent(\'' + encodeURIComponent(f.name) + '\')">复制</button>' +
        '<button class="btn btn-sm" onclick="downloadFile(\'' + encodeURIComponent(f.name) + '\')">下载</button>' +
        '<span class="file-star" data-starfile="' + encodeURIComponent(f.name) + '" onclick="toggleFavorite(\'' + encodeURIComponent(f.name) + '\')">☆</span>' +
        '<button class="btn btn-sm btn-danger" onclick="deleteFile(\'' + encodeURIComponent(f.name) + '\')">删除</button>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';

  // 加载文本预览
  for (const f of pagedFiles) {
    if (f.type === 'text' && f.size < 50000) {
      loadPreview(f.name, 'preview-' + btoaSafe(f.name).substring(0, 20));
    }
  }

  // Render pagination
  const allFiles = applySort(currentFilter !== 'all' ? currentFiles.filter(f => f.type === currentFilter) : [...currentFiles]);
  const totalPages = Math.ceil(allFiles.length / PAGE_SIZE) || 1;
  renderPagination(currentPage, totalPages);
  updateFavoritesInView();
}

async function loadPreview(filename, previewId) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    const el = document.getElementById(previewId);
    if (el && data.content) {
      el.textContent = data.content.substring(0, 300) + (data.content.length > 300 ? '...' : '');
    }
  } catch (e) {}
}

function togglePreview(filename, previewId) {
  const el = document.getElementById(previewId);
  if (el) {
    el.classList.toggle('show');
    if (!el.classList.contains('show') && !el.textContent) {
      loadPreview(filename, previewId);
    }
  }
}

async function openFileModal(filename) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalMeta').textContent = 'Size: ' + formatSize(data.size || 0) + ' | Modified: ' + formatTime(data.time || 0);
    document.getElementById('modalBody').textContent = data.content || '';
    document.getElementById('fileModal').classList.add('show');
  } catch (e) { showToast('Failed to open file'); }
}

function closeModal() {
  document.getElementById('fileModal').classList.remove('show');
}

function closeShortcutModal() {
  document.getElementById('shortcutModal').classList.remove('show');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeShortcutModal();
  }
  // Don't interfere with typing in inputs
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    toggleFavFilter();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    loadFiles();
    showToast('已刷新');
  } else if (e.key === '?') {
    e.preventDefault();
    document.getElementById('shortcutModal').classList.add('show');
  }
});

function applySearchHighlight(q) {
  if (!q || !q.trim()) return;
  const targets = document.querySelectorAll('.search-target');
  const escaped = q.trim().replace(/[.*+?^\${}()|[\\]\\]/g, '\\$&');
  try {
    const regex = new RegExp('(' + escaped + ')', 'gi');
    targets.forEach(el => {
      el.innerHTML = el.textContent.replace(regex, '<span class="search-highlight">$1</span>');
    });
  } catch (e) {}
}

async function removeTag(filename, tag) {
  const decodedName = decodeURIComponent(filename);
  const decodedTag = tag;
  // Get current tags, remove the tag, update
  const file = currentFiles.find(f => f.name === decodedName);
  if (!file) return;
  const currentTags = file.tags ? file.tags.split(',').map(t => t.trim()).filter(t => t) : [];
  const newTags = currentTags.filter(t => t !== decodedTag).join(',');
  try {
    const res = await fetch(API + '/api/file-tags/' + filename, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ tags: newTags })
    });
    const data = await res.json();
    if (data.success) {
      showToast('已移除标签');
      loadFiles();
    }
  } catch (e) {}
}

function filterByTag(tag) {
  document.getElementById('searchInput').value = 'tag:' + tag;
  window.currentSearchQ = 'tag:' + tag;
  doSearch();
}

function applySort(files) {
  const [field, dir] = currentSort.split('_');
  const sorted = [...files];
  sorted.sort((a, b) => {
    let va, vb;
    if (field === 'time') {
      va = a.time || 0;
      vb = b.time || 0;
    } else if (field === 'name') {
      va = (a.name || '').toLowerCase();
      vb = (b.name || '').toLowerCase();
    } else if (field === 'size') {
      va = a.size || 0;
      vb = b.size || 0;
    }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  return sorted;
}

function setSort(value) {
  currentSort = value;
  currentPage = 1;
  renderFiles();
  if (window.currentSearchQ) applySearchHighlight(window.currentSearchQ);
}

function renderPagination(current, total) {
  const container = document.getElementById('pagination');
  if (!container) return;
  if (total <= 1) {
    container.innerHTML = '';
    return;
  }
  let html = '';
  html += '<button onclick="goPage(' + (current - 1) + ')" ' + (current === 1 ? 'disabled' : '') + '>‹</button>';
  const maxVisible = 5;
  let startPage = Math.max(1, current - Math.floor(maxVisible / 2));
  let endPage = Math.min(total, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);
  if (startPage > 1) {
    html += '<button onclick="goPage(1)">1</button>';
    if (startPage > 2) html += '<span style="color:var(--text-muted)">...</span>';
  }
  for (let i = startPage; i <= endPage; i++) {
    html += '<button class="' + (i === current ? 'active' : '') + '" onclick="goPage(' + i + ')">' + i + '</button>';
  }
  if (endPage < total) {
    if (endPage < total - 1) html += '<span style="color:var(--text-muted)">...</span>';
    html += '<button onclick="goPage(' + total + ')">' + total + '</button>';
  }
  html += '<button onclick="goPage(' + (current + 1) + ')" ' + (current === total ? 'disabled' : '') + '>›</button>';
  html += '<span class="page-info">' + current + '/' + total + '</span>';
  container.innerHTML = html;
}

function goPage(p) {
  const files = applySort(currentFilter !== 'all' ? currentFiles.filter(f => f.type === currentFilter) : [...currentFiles]);
  const total = Math.ceil(files.length / PAGE_SIZE) || 1;
  if (p < 1 || p > total) return;
  currentPage = p;
  renderFiles();
  if (window.currentSearchQ) applySearchHighlight(window.currentSearchQ);
}

function doSearch() {
  const q = document.getElementById('searchInput').value.trim();
  window.currentSearchQ = q;
  document.getElementById('clearSearchBtn').style.display = q ? 'inline-block' : 'none';
  if (!q) {
    loadFiles();
    return;
  }
  
  fetch(API + '/api/search?q=' + encodeURIComponent(q), { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      currentFiles = data.files || [];
      renderFiles();
      if (q) applySearchHighlight(q);
      saveRecentSearch(q);
    })
    .catch(e => showAlert('listAlert', '搜索失败', 'error'));
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  window.currentSearchQ = '';
  document.getElementById('clearSearchBtn').style.display = 'none';
  loadFiles();
}

// Filter tabs
document.querySelectorAll('.filter-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.dataset.filter;
    renderFiles();
  });
});

// 文字分享
document.getElementById('shareTextBtn').addEventListener('click', shareText);
document.getElementById('clearTextBtn').addEventListener('click', () => {
  document.getElementById('textContent').value = '';
});

async function shareText() {
  const content = document.getElementById('textContent').value;
  if (!content.trim()) {
    showToast('请输入内容');
    return;
  }
  const filename = 'share_' + Date.now() + '.txt';
  try {
    const res = await fetch(API + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ filename, content, type: 'text' })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✓ 文字分享成功');
      document.getElementById('textContent').value = '';
      // Show share link
      const link = location.origin + '/api/files/' + encodeURIComponent(filename) + '?auth=' + (AUTH_TOKEN || '');
      const linkBox = document.getElementById('shareLinkBox');
      const linkInput = document.getElementById('shareLinkInput');
      if (linkBox && linkInput) {
        linkInput.value = link;
        linkBox.style.display = 'flex';
      }
      loadFiles();
      broadcastWs({ type: 'file_create', payload: { filename, content, type: 'text' } });
    } else {
      showToast('失败: ' + data.error);
    }
  } catch (e) {
    showToast('失败: ' + e.message);
  }
}

function copyShareLink() {
  const input = document.getElementById('shareLinkInput');
  if (!input || !input.value) return;
  navigator.clipboard.writeText(input.value).then(() => {
    showToast('✓ 链接已复制');
  }).catch(() => {
    input.select();
    document.execCommand('copy');
    showToast('✓ 链接已复制');
  });
}

// 文件上传
document.getElementById('fileInput').addEventListener('change', (e) => {
  uploadFiles(e.target.files);
});

async function uploadFiles(files) {
  let successCount = 0;
  let failCount = 0;
  const totalFiles = files.length;
  const progressBar = document.getElementById('uploadProgressBar');
  const progressFill = document.getElementById('uploadProgressFill');
  if (progressBar) progressBar.style.display = 'block';
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filename = file.webkitRelativePath || file.name;
    
    await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1];
        // Animate progress during upload
        let animFrame = 0;
        const animInterval = setInterval(() => {
          animFrame++;
          const basePct = Math.round((i / totalFiles) * 100);
          const animPct = Math.min(basePct + Math.round(animFrame / 10), basePct + 20);
          if (progressFill) progressFill.style.width = animPct + '%';
        }, 50);
        
        try {
          const res = await fetch(API + '/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
            body: JSON.stringify({ filename, content: base64, type: 'file' })
          });
          clearInterval(animInterval);
          const data = await res.json();
          if (progressFill) progressFill.style.width = Math.round(((i + 1) / totalFiles) * 100) + '%';
          if (data.success) {
            successCount++;
            showToast('✓ ' + filename);
            loadFiles();
            broadcastWs({ type: 'file_create', payload: { filename, hash: data.hash } });
          } else {
            failCount++;
            showAlert('uploadAlert', '失败: ' + data.error, 'error');
          }
        } catch (e) {
          clearInterval(animInterval);
          failCount++;
          showAlert('uploadAlert', '失败: ' + e.message, 'error');
        }
        resolve();
      };
      reader.onerror = () => { failCount++; resolve(); };
      reader.readAsDataURL(file);
    });
  }
  
  setTimeout(() => {
    if (progressBar) progressBar.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
  }, 2000);
  
  if (successCount > 0) {
    showAlert('uploadAlert', '已上传 ' + successCount + ' 个文件' + (failCount > 0 ? '，失败 ' + failCount : ''), failCount > 0 ? 'error' : 'success');
  }
}

async function copyContent(filename) {
  try {
    const res = await fetch(API + '/api/content/' + filename, { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.content) {
      const textarea = document.createElement('textarea');
      textarea.value = data.content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); showToast('内容已复制'); }
      catch (e) { prompt('复制内容:', data.content); }
      document.body.removeChild(textarea);
    }
  } catch (e) { showToast('复制失败'); }
}

function downloadFile(filename) {
  window.open(API + '/download/' + filename, '_blank');
}

async function addTag(filename, existingTags) {
  const current = existingTags ? existingTags.split(',').filter(t => t.trim()).join(', ') : '';
  const input = prompt('输入标签（多个标签用逗号分隔）:', current);
  if (input === null) return;
  const tags = input.split(',').map(t => t.trim()).filter(t => t).join(',');
  try {
    const res = await fetch(API + '/api/file-tags/' + filename, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ tags })
    });
    const data = await res.json();
    if (data.success) {
      showAlert('listAlert', '标签已更新', 'success');
      loadFiles();
    } else {
      showAlert('listAlert', '更新失败: ' + data.error, 'error');
    }
  } catch (e) { showAlert('listAlert', '更新失败: ' + e.message, 'error'); }
}

async function deleteFile(filename) {
  if (!confirm('确定删除?')) return;
  try {
    const res = await fetch(API + '/api/file/' + filename + '?filename=' + encodeURIComponent(filename), { method: 'DELETE', headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success) {
      showAlert('listAlert', '已删除', 'success');
      loadFiles();
      broadcastWs({ type: 'file_delete', payload: { filename: decodeURIComponent(filename) } });
    } else {
      showAlert('listAlert', '删除失败', 'error');
    }
  } catch (e) { showAlert('listAlert', '删除失败: ' + e.message, 'error'); }
}

async function deleteOld(days) {
  if (!confirm('删除 ' + days + ' 天前的文件?')) return;
  try {
    const res = await fetch(API + '/api/delete-old?days=' + days, { method: 'DELETE', headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success) {
      showAlert('listAlert', '已删除 ' + data.deleted + ' 个文件', 'success');
      loadFiles();
    } else {
      showAlert('listAlert', '删除失败', 'error');
    }
  } catch (e) { showAlert('listAlert', '删除失败: ' + e.message, 'error'); }
}

async function deleteAll() {
  if (!confirm('确定删除所有文件?')) return;
  try {
    const res = await fetch(API + '/api/delete-all', { method: 'DELETE', headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success) {
      showAlert('listAlert', '已删除 ' + data.deleted + ' 个文件', 'success');
      loadFiles();
    } else {
      showAlert('listAlert', '删除失败', 'error');
    }
  } catch (e) { showAlert('listAlert', '删除失败: ' + e.message, 'error'); }
}

function updateBatchBar() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  const bar = document.getElementById('batchBar');
  const count = document.getElementById('batchCount');
  if (bar) bar.classList.toggle('show', checked.length > 0);
  if (count) count.textContent = '已选择 ' + checked.length + ' 个文件';
}

function clearBatch() {
  document.querySelectorAll('.batch-checkbox').forEach(cb => cb.checked = false);
  updateBatchBar();
}

async function batchDelete() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  if (checked.length === 0) return;
  if (!confirm('确定删除选中的 ' + checked.length + ' 个文件?')) return;
  let deleted = 0;
  for (const cb of checked) {
    const filename = cb.value;
    try {
      await fetch(API + '/api/file/' + filename + '?filename=' + encodeURIComponent(filename), { method: 'DELETE', headers: { 'x-auth-token': AUTH_TOKEN || '' } });
      deleted++;
    } catch (e) {}
  }
  showToast('已删除 ' + deleted + ' 个文件');
  clearBatch();
  loadFiles();
}

async function batchAddTag() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  if (checked.length === 0) return;
  const tag = prompt('请输入标签名称:');
  if (!tag || !tag.trim()) return;
  let tagged = 0;
  for (const cb of checked) {
    const filename = cb.value;
    try {
      const res = await fetch(API + '/api/file-tags/' + filename, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
        body: JSON.stringify({ tags: tag.trim() })
      });
      if (res.ok) tagged++;
    } catch (e) {}
  }
  showToast('已为 ' + tagged + ' 个文件添加标签');
  clearBatch();
  loadFiles();
}

// Favorites (localStorage)
function getFavorites() {
  try { return JSON.parse(localStorage.getItem('sharetool_favorites') || '[]'); }
  catch (e) { return []; }
}

function toggleFavorite(filename) {
  let favs = getFavorites();
  const decoded = decodeURIComponent(filename);
  if (favs.includes(decoded)) {
    favs = favs.filter(f => f !== decoded);
  } else {
    favs.unshift(decoded);
    favs = favs.slice(0, 20);
  }
  try { localStorage.setItem('sharetool_favorites', JSON.stringify(favs)); } catch (e) {}
  // Update star UI
  const isFav = getFavorites().includes(decoded);
  const starEl = document.querySelector('[data-starfile="' + filename + '"]');
  if (starEl) {
    starEl.classList.toggle('starred', isFav);
    starEl.textContent = isFav ? '★' : '☆';
  }
}

function updateFavoritesInView() {
  const favs = getFavorites();
  document.querySelectorAll('[data-starfile]').forEach(el => {
    const filename = decodeURIComponent(el.getAttribute('data-starfile'));
    const isFav = favs.includes(filename);
    el.classList.toggle('starred', isFav);
    el.textContent = isFav ? '★' : '☆';
  });
}

// Notification badge for WS changes
let notifCount = 0;
function incrementBadge() {
  notifCount++;
  const badge = document.getElementById('notifBadge');
  if (badge) {
    badge.textContent = notifCount > 9 ? '9+' : notifCount;
    badge.classList.add('show');
  }
}

function clearBadge() {
  notifCount = 0;
  const badge = document.getElementById('notifBadge');
  if (badge) badge.classList.remove('show');
}

document.addEventListener('click', () => clearBadge());

// Paste from clipboard (for images)
document.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const textArea = document.getElementById('textContent');
  if (!textArea || document.activeElement !== textArea) return;
  
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          const filename = 'paste_' + Date.now() + '.' + (file.type.split('/')[1] || 'png');
          fetch(API + '/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
            body: JSON.stringify({ filename, content: base64, type: 'file' })
          }).then(r => r.json()).then(data => {
            if (data.success) {
              showToast('✓ 图片已粘贴上传: ' + filename);
              loadFiles();
            }
          });
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  }
});

// 批量选择处理
document.addEventListener('change', (e) => {
  if (e.target.classList.contains('batch-checkbox')) {
    updateBatchBar();
  }
});

async function batchDownload() {
  const checkboxes = document.querySelectorAll('.batch-checkbox:checked');
  if (checkboxes.length === 0) {
    showAlert('listAlert', '请先选择文件', 'error');
    return;
  }
  
  const filenames = Array.from(checkboxes).map(cb => decodeURIComponent(cb.value));
  
  try {
    const res = await fetch(API + '/api/batch-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ filenames })
    });
    
    const contentType = res.headers.get('Content-Type');
    
    if (contentType && contentType.includes('application/json')) {
      const data = await res.json();
      if (data.mode === 'multiple') {
        showAlert('listAlert', '批量打包不可用，正在逐个打开下载...', 'info');
        for (const f of data.files) {
          window.open(API + '/download/' + encodeURIComponent(f.name), '_blank');
        }
      } else {
        showAlert('listAlert', '下载失败: ' + data.error, 'error');
      }
    } else if (contentType && contentType.includes('zip')) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sharetool_batch.zip';
      a.click();
      URL.revokeObjectURL(url);
      showAlert('listAlert', '批量下载成功', 'success');
    }
  } catch (e) {
    showAlert('listAlert', '批量下载失败: ' + e.message, 'error');
  }
}

function saveDownloadDir() {
  const dir = document.getElementById('downloadDir').value.trim();
  localStorage.setItem('shareTool_downloadDir', dir);
  config.downloadDir = dir;
  showAlert('listAlert', '下载目录已保存（仅本机有效）', 'success');
}

// 搜索回车/实时搜索
document.getElementById('searchInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') doSearch();
});
// 实时搜索（输入时自动搜索）
let searchDebounce = null;
document.getElementById('searchInput').addEventListener('input', () => {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(doSearch, 400);
});

function broadcastWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// 主题切换
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', next);
  localStorage.setItem('shareTool_theme', next);
  document.getElementById('themeToggle').textContent = next === 'light' ? '🌙' : '☀️';
}

function initTheme() {
  const saved = localStorage.getItem('shareTool_theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
    document.getElementById('themeToggle').textContent = saved === 'light' ? '🌙' : '☀️';
  }
}

// 初始化
async function init() {
  // 加载 Token
  try {
    const res = await fetch(API + '/api/token/current');
    const data = await res.json();
    if (data.token) AUTH_TOKEN = data.token;
  } catch (e) {}

  initTheme();
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);

  const localDownloadDir = localStorage.getItem('shareTool_downloadDir') || '';
  document.getElementById('downloadDir').value = localDownloadDir;
  
  // 加载文件列表
  await loadFiles();
  
  // 连接 WebSocket
  connectWS();
  
  // Drag and drop
  const dropZone = document.getElementById('dropZone');
  if (dropZone) {
    ['dragenter','dragover'].forEach(evt => {
      dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    });
    ['dragleave','drop'].forEach(evt => {
      dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
    });
    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        document.getElementById('fileInput').files = files;
        uploadFiles();
      }
    });
  }
  
  // Load storage info
  fetchStorageInfo();
  
  // Load recent searches
  renderRecentSearches();
}

async function fetchStorageInfo() {
  try {
    const res = await fetch(API + '/api/storage', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    const used = data.totalSize || 0;
    const max = data.maxSize || 10 * 1024 * 1024 * 1024;
    const pct = Math.round(used / max * 100);
    const el = document.getElementById('storageText');
    if (el) el.textContent = '存储: ' + formatSize(used) + ' / 10GB (' + pct + '%)';
  } catch (e) {
    const el = document.getElementById('storageText');
    if (el) el.textContent = '存储: --';
  }
}

function getRecentSearches() {
  try {
    return JSON.parse(localStorage.getItem('sharetool_recent_searches') || '[]');
  } catch (e) { return []; }
}

function saveRecentSearch(q) {
  if (!q || q.trim().length < 2) return;
  let searches = getRecentSearches().filter(s => s !== q);
  searches.unshift(q);
  searches = searches.slice(0, 5);
  try { localStorage.setItem('sharetool_recent_searches', JSON.stringify(searches)); } catch (e) {}
  renderRecentSearches();
}

function renderRecentSearches() {
  const container = document.getElementById('recentSearches');
  if (!container) return;
  const searches = getRecentSearches();
  if (!searches.length) { container.style.display = 'none'; return; }
  container.style.display = 'flex';
  container.innerHTML = searches.map(s =>
    '<span class="recent-search-tag" onclick="document.getElementById(\'searchInput\').value=\'' + s.replace(/'/g, "\\'") + '\';doSearch()">' + s + '</span>'
  ).join('');
}

function getFileIcon(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const icons = {
    pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗',
    ppt: '📙', pptx: '📙', txt: '📄', md: '📝', json: '📋',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵',
    mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', webm: '🎬',
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    js: '💻', ts: '💻', py: '💻', java: '💻', c: '💻', cpp: '💻', h: '💻',
    css: '🎨', html: '🌐', xml: '🌐', yml: '⚙️', yaml: '⚙️',
    exe: '⚙️', dmg: '⚙️', deb: '⚙️', rpm: '⚙️',
  };
  return icons[ext] || '📄';
}

init();
</script>
</body>
</html>`;
}

// ============================================================
// 启动
// ============================================================
process.on('SIGINT', () => {
  console.log('\n[ShareTool] Shutting down...');
  if (broadcastTimer) clearInterval(broadcastTimer);
  if (wsServer) wsServer.close();
  if (udpServer) udpServer.close();
  if (httpServer) httpServer.close();
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  console.error('[ShareTool] Uncaught exception:', e);
});

init();
