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

// 结构化日志
const pino = require('pino');
const LOG_LEVEL = (function() {
  const envLevel = process.env.SHARETOOL_LOG_LEVEL;
  if (envLevel && ['trace','debug','info','warn','error','fatal'].includes(envLevel)) return envLevel;
  return 'info';
})();
const logger = pino({
  level: LOG_LEVEL,
  transport: process.stdout.isTTY ? {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' }
  } : undefined,
  base: { service: 'sharetool', pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ============================================================
// 常量配置
// ============================================================
const MAX_TS = 32503680000000; // 3000-01-01，永久不过期的时间戳
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
  logger.info('[ShareTool] 首次启动，已生成新 Token:', newToken.substring(0, 8) + '***');
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
// API 全局限流：基于时间窗口桶（内存 Map，进程重启即重置，符合 Ephemeral 原则）
const RATE_LIMIT_GLOBAL_WINDOW_MS = 60 * 1000; // 60秒窗口
const RATE_LIMIT_GLOBAL_MAX = 60;              // 最多60次
const rateLimitMap = new Map();                 // ip -> [{timestamp}]

function checkGlobalRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_GLOBAL_WINDOW_MS;

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }

  const requests = rateLimitMap.get(ip);
  // 清理过期记录
  while (requests.length > 0 && requests[0] < windowStart) {
    requests.shift();
  }

  const remaining = Math.max(0, RATE_LIMIT_GLOBAL_MAX - requests.length);
  if (requests.length >= RATE_LIMIT_GLOBAL_MAX) {
    return { allowed: false, retryAfter: 60, remaining: 0, total: RATE_LIMIT_GLOBAL_MAX };
  }

  requests.push(now);
  return { allowed: true, remaining: remaining - 1, total: RATE_LIMIT_GLOBAL_MAX };
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
  if (!config.trustedOrigins) config.trustedOrigins = [];  // CORS 信任来源，默认空（仅本地）
  
  // 从环境变量或配置文件读取 token
  SHARE_TOKEN = process.env.SHARE_TOKEN || config.shareToken;
  if (!SHARE_TOKEN) {
    // 首次启动，生成新 token
    SHARE_TOKEN = crypto.randomBytes(32).toString('hex');
    config.shareToken = SHARE_TOKEN;
    saveConfig();
    logger.info('[ShareTool] 首次启动，已生成 Token 并保存到 ' + CONFIG_FILE);
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
    logger.error({ err: e }, 'Config save failed');
  }
}

function setCors(res, req) {
  const origin = req?.headers['origin'];
  const trusted = config.trustedOrigins || [];
  
  // 如果有 origin 且在信任列表中，使用具体 origin；否则不设置（或降级）
  if (origin && (trusted.includes('*') || trusted.includes(origin) || isLocalhost(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // 无 origin（CLI 请求）不设置 CORS，避免浏览器干扰
  } else {
    // 有 origin 但不在信任列表，降级为不设置，防止泄露敏感信息
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token, x-refresh-token, Authorization, x-requested-with');
  res.setHeader('Access-Control-Expose-Headers', 'x-requested-with');
}

function isLocalhost(origin) {
  return /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
         /^https?:\/\/127\.(\d+)\.(\d+)\.(\d+)(:\d+)?$/.test(origin) ||
         /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(origin) ||  // 局域网 IP
         /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/.test(origin);    // 局域网 IP
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
  const rate = checkGlobalRateLimit(clientIp);
  if (!rate.allowed) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(rate.retryAfter || 60),
      'X-RateLimit-Limit': String(rate.total),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000) + (rate.retryAfter || 60))
    });
    res.end(JSON.stringify({ success: false, error: 'Too Many Requests', retryAfter: rate.retryAfter || 60 }));
    return null;
  }
  // 设置 RateLimit headers（即使未超限也返回）
  res.setHeader('X-RateLimit-Limit', String(rate.total));
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(Date.now() / 1000) + 60));
  
  const authData = auth(req);
  if (!authData) {
    db.addAuditLog('auth_failed', `IP: ${clientIp}`, clientIp);
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
  
  logger.info(`[ShareTool] Device ID: ${DEVICE_ID}`);
  logger.info(`[ShareTool] HTTP: http://${LOCAL_IP}:${PORT}`);
  logger.info(`[ShareTool] WebSocket: ws://${LOCAL_IP}:${WS_PORT}`);
  logger.info(`[ShareTool] Discovery: udp://${LOCAL_IP}:${DISCOVERY_PORT}`);
}

// ============================================================
// HTTPS 证书管理
// ============================================================
const selfsigned = require('selfsigned');
const QRCode = require('qrcode');

function getCertExpiryInfo(certPath) {
  if (!fs.existsSync(certPath)) return null;
  try {
    // 尝试用 openssl 解析证书日期
    const { execSync } = require('child_process');
    try {
      const out = execSync(`openssl x509 -in "${certPath}" -noout -dates`, { encoding: 'utf8' });
      const notAfterMatch = out.match(/notAfter=(.*)/i);
      if (notAfterMatch && notAfterMatch[1]) {
        const expiresAt = new Date(notAfterMatch[1].trim()).getTime() / 1000;
        const now = Math.floor(Date.now() / 1000);
        const daysRemaining = Math.floor((expiresAt - now) / 86400);
        return { valid: expiresAt > now, daysRemaining, expiresAt, note: null };
      }
    } catch (e) {
      // openssl 不可用，使用 mtime fallback
    }
    // Fallback: 使用文件修改时间估算
    const stats = fs.statSync(certPath);
    const age = (Date.now() - stats.mtimeMs) / 1000 / 86400;
    return { valid: age < 365, daysRemaining: Math.floor(365 - age), expiresAt: null, note: 'Using file age (openssl unavailable)' };
  } catch (e) {
    return { valid: false, daysRemaining: 0, expiresAt: null, note: e.message };
  }
}

function getCertInfo() {
  const certPath = path.join(SSL_DIR, 'cert.pem');
  const keyPath = path.join(SSL_DIR, 'key.pem');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;

  try {
    const stats = fs.statSync(certPath);
    const keyStats = fs.statSync(keyPath);
    const expiryInfo = getCertExpiryInfo(certPath);

    return {
      exists: true,
      certPath,
      keyPath,
      createdAt: stats.ctimeMs,
      expiresAt: expiryInfo?.expiresAt || null,
      daysRemaining: expiryInfo?.daysRemaining || null,
      valid: expiryInfo?.valid !== false,
      note: expiryInfo?.note || null
    };
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

async function ensureSslCertificates() {
  const certPath = path.join(SSL_DIR, 'cert.pem');
  const keyPath = path.join(SSL_DIR, 'key.pem');

  // 检查证书有效期
  const info = getCertExpiryInfo(certPath);
  if (info && info.valid && info.daysRemaining !== null && info.daysRemaining > 7) {
    logger.info(`[HTTPS] Using existing certificate (expires in ${info.daysRemaining} days)`);
    return true;
  }

  // 证书不存在、已过期或即将过期（<=7天）
  if (info && !info.valid) {
    logger.info(`[HTTPS] Certificate expired, regenerating...`);
  } else if (info && info.daysRemaining !== null) {
    logger.info(`[HTTPS] Certificate expires in ${info.daysRemaining} days, regenerating...`);
  } else {
    logger.info(`[HTTPS] No certificate found, generating...`);
  }

  try {
    if (!fs.existsSync(SSL_DIR)) {
      fs.mkdirSync(SSL_DIR, { recursive: true });
    }

    const { key, cert } = await generateSelfSignedCert();

    fs.writeFileSync(keyPath, key);
    fs.writeFileSync(certPath, cert);

    logger.info('[HTTPS] Self-signed certificate generated');
    logger.info(`[HTTPS] Certificate: ${certPath}`);
    logger.info('[HTTPS] NOTE: Add cert to system trust store for full HTTPS support');
    return true;
  } catch (e) {
    logger.error({ err: e }, 'HTTPS cert generation failed');
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
  
  logger.info(`[HTTPS] SANs: localhost, 127.0.0.1, ${ips.filter(ip => ip !== '127.0.0.1').join(', ')}`);
  
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
  const expiresHours = options.expiryHours;
  // expiryHours = 0 表示永不过期（用 MAX_INT 代替 NULL 避免 SQLite schema 迁移）
  const expiresAt = (!expiresHours && expiresHours !== 0)
    ? Date.now() + 168 * 60 * 60 * 1000  // 默认7天
    : (expiresHours === 0 ? MAX_TS : Date.now() + expiresHours * 60 * 60 * 1000);
  const shareData = {
    code,
    filename,
    createdAt: Date.now(),
    expiresAt,
    password: options.password || null,
    maxDownloads: options.maxDownloads || null,
    downloadCount: 0,
    isText: options.isText || false,
    description: options.description || ''
  };

  db.saveShareLink(shareData);
  return shareData;
}

function validateShareCode(code) {
  const shareData = db.getShareLink(code);
  if (!shareData) return null;
  
  // 检查过期（MAX_TS = 永不过期）
  if (shareData.expiresAt && shareData.expiresAt !== MAX_TS && Date.now() > shareData.expiresAt) {
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
        logger.info(`[HTTPS] Certificate valid for ${info.daysRemaining} days (expires: ${info.validTo})`);
      }
    } catch (e) {
      logger.error({ err: e }, 'HTTPS cert load failed');
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
    setCors(res, req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 速率限制检查（跳过静态资源和健康检查）
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    // Skip rate limit for healthcheck, static assets
    if (!['/api/health', '/index', '/favicon'].some(p => pathname.startsWith(p))) {
      const clientIp = getClientIp(req);
      const rate = checkGlobalRateLimit(clientIp);
      if (!rate.allowed) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(rate.retryAfter || 60),
          'X-RateLimit-Limit': String(rate.total),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000) + (rate.retryAfter || 60))
        });
        res.end(JSON.stringify({ success: false, error: '请求过于频繁，请 60 秒后重试', retryAfter: rate.retryAfter || 60 }));
        return;
      }
      res.setHeader('X-RateLimit-Limit', String(rate.total));
      res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(Date.now() / 1000) + 60));
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

      // PWA Manifest
      if (pathname === '/manifest.json') {
        const manifest = {
          name: 'ShareTool - 局域网文件分享',
          short_name: 'ShareTool',
          description: '局域网文件/文字分享服务，支持多设备同步',
          start_url: '/',
          display: 'standalone',
          background_color: '#0f172a',
          theme_color: '#667eea',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
          ],
          categories: ['productivity', 'utilities'],
          lang: 'zh-CN'
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
        res.end(JSON.stringify(manifest, null, 2));
        return;
      }

      // PWA Service Worker
      if (pathname === '/sw.js') {
        const sw = `// ShareTool Service Worker v1.0
const CACHE_NAME = 'sharetool-v1';
const STATIC_ASSETS = ['/', '/index.html'];
const API_BASE = '';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin
  if (request.method !== 'GET') return;
  if (url.origin !== location.origin) return;

  // API: network-first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => new Response(JSON.stringify({success:false, error:'offline'}), {
        headers: {'Content-Type': 'application/json'}
      }))
    );
    return;
  }

  // Static: cache-first
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(resp => {
      if (resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
      }
      return resp;
    }))
  );
});

// Push notification support (future)
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'ShareTool', {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'sharetool'
    })
  );
});
`;
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
        res.end(sw);
        return;
      }

      // PWA Icons
      const iconMatch = pathname.match(/^\/(icon-(\d+)\.png)$/);
      if (iconMatch) {
        const iconPath = path.join(__dirname, iconMatch[1]);
        if (fs.existsSync(iconPath)) {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=2592000' });
          fs.createReadStream(iconPath).pipe(res);
          return;
        }
      }

      // Docker healthcheck endpoint - no auth required
      if (pathname === '/api/health' && req.method === 'GET') {
        const uptime = Math.floor(process.uptime());
        const memUsage = process.memoryUsage();
        sendJson(res, {
          status: 'ok',
          uptime,
          memory: {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024)
          },
          version: 'v0.40.0'
        });
        return;
      }

      // Route context - shared dependencies for route handlers
      const routeCtx = {
        db, config, sendJson, authRequired, getClientIp, broadcastChange,
        getUploadMaxSize, getFileIcon, isImageFile, archiver, crypto, cryptoModule,
        SHARE_TOKEN, TOKEN_EXPIRES_IN, DEVICE_ID, LOCAL_IP, PORT,
        saveConfig, ensureSslCertificates, getCertInfo, QRCode,
        fs, path, createShareLink, validateShareCode
      };

      // API routes (non-share)
      if (pathname.startsWith('/api/')) {
        const apiRoutes = require('./routes/api');
        if (apiRoutes(req, res, pathname, query, routeCtx)) return;
      }

      // File routes
      const fileRoutes = require('./routes/files');
      if (fileRoutes(req, res, pathname, query, routeCtx)) return;

      // Share routes
      const shareRoutes = require('./routes/share');
      if (shareRoutes(req, res, pathname, query, routeCtx)) return;

      // 未知路由
      sendJson(res, { success: false, error: 'Not found' }, 404);

    } catch (e) {
      // Log full error, return safe message to client
      const safeError = process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : e.message;
      logger.error({ err: e, pathname, method: req.method }, 'HTTP error');
      sendJson(res, { success: false, error: safeError }, 500);
    }
  };

  if (serverOptions.https) {
    httpServer = https.createServer(serverOptions, requestHandler);
    httpServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      logger.info(`[HTTPS] Server listening on https://${LOCAL_IP}:${HTTPS_PORT}`);
    });
    // 同时在 HTTP 端口运行 HTTP（重定向到 HTTPS）
    const redirectHandler = (req, res) => {
      const host = req.headers.host || `localhost:${PORT}`;
      const destination = `https://${host}${req.url}`;
      // 排除 WebSocket 升级请求
      if (req.headers.upgrade === 'websocket') {
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('WebSocket over HTTP not supported, use HTTPS');
        return;
      }
      res.writeHead(301, {
        'Location': destination,
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'Cache-Control': 'no-cache'
      });
      res.end(`Redirecting to ${destination}`);
    };
    const plainServer = http.createServer(redirectHandler);
    plainServer.listen(PORT, '0.0.0.0', () => {
      logger.info(`[HTTP->HTTPS] Redirect server listening on http://${LOCAL_IP}:${PORT} -> https://${LOCAL_IP}:${HTTPS_PORT}`);
    });
  } else {
    httpServer = http.createServer(requestHandler);
    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info(`[HTTP] Server listening on http://${LOCAL_IP}:${PORT}`);
      logger.info('[HTTPS] SSL certificates not found, HTTPS disabled');
      logger.info('[HTTPS] Run with SSL_DIR set to enable HTTPS');
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
    logger.info(`[WS] New connection from ${clientIp}`);
    
    ws.isAlive = true;
    ws.deviceId = null;
    
    ws.on('pong', () => { ws.isAlive = true; });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleWsMessage(ws, msg);
      } catch (e) {
        logger.error({ err: e }, 'WS invalid message');
      }
    });
    
    ws.on('close', () => {
      if (ws.deviceId) {
        wsClients.delete(ws.deviceId);
        syncClients.delete(ws);
        db.setDeviceOffline(ws.deviceId);
        broadcastDeviceList();
        logger.info(`[WS] Device ${ws.deviceId} disconnected`);
      }
    });
    
    ws.on('error', (e) => {
      logger.error({ err: e }, 'WS error');
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
  
  logger.info(`[WS] WebSocket server on ws://${LOCAL_IP}:${WS_PORT}`);
}

function handleWsMessage(ws, msg) {
  const { type, payload } = msg;
  
  switch (type) {
    case 'register': {
      // 设备注册
      const { deviceId, deviceName, lastSyncTs = 0 } = payload;
      ws.deviceId = deviceId;
      wsClients.set(deviceId, ws);
      syncClients.add(ws);
      db.registerDevice(deviceId, deviceName || deviceId, LOCAL_IP, PORT);
      db.setDeviceOnline(deviceId);

      // 增量同步：只返回 lastSyncTs 之后的变更
      const changes = db.getUnsyncedLogs(lastSyncTs);
      const { files } = db.listFiles(100, 0);

      const syncStatus = db.getSyncStatus();
      ws.send(JSON.stringify({
        type: 'registered',
        payload: {
          deviceId: DEVICE_ID,
          deviceName: DEVICE_NAME,
          files: files.map(f => ({ id: f.id, name: f.filename, size: f.size, time: f.created_at * 1000, type: f.type, hash: f.hash, tags: f.tags })),
          devices: db.listDevices().map(d => ({ deviceId: d.device_id, deviceName: d.device_name, ip: d.ip, isOnline: d.is_online === 1 })),
          syncStatus,  // 当前未同步状态
          // 增量同步数据
          sync: {
            changes,
            serverTs: Math.floor(Date.now() / 1000),  // 本次同步时间戳，客户端下次请求时传回
            totalChanges: changes.length
          }
        }
      }));

      broadcastDeviceList();
      logger.info(`[WS] Device registered: ${deviceId} (${deviceName}), incremental sync: ${changes.length} changes since ${lastSyncTs}`);
      break;
    }

    case 'auth': {
      // 分享链接 Token 认证（用于访问受保护的分享链接）
      const { token } = payload;
      if (token && token === SHARE_TOKEN) {
        ws.isShareAuth = true;
        ws.send(JSON.stringify({ type: 'auth_ok', payload: { message: 'authenticated' } }));
        logger.info(`[WS] Share token auth OK from ${ws._socket?.remoteAddress || 'unknown'}`);
      } else {
        ws.send(JSON.stringify({ type: 'auth_failed', payload: { error: 'invalid token' } }));
        logger.warn(`[WS] Share token auth failed from ${ws._socket?.remoteAddress || 'unknown'}`);
      }
      break;
    }

    case 'sync_request': {
      // 增量同步请求
      const { since = 0, deviceId } = payload;
      const changes = db.getUnsyncedLogs(since);
      ws.send(JSON.stringify({
        type: 'sync_response',
        payload: {
          changes,
          serverTs: Math.floor(Date.now() / 1000),
          totalChanges: changes.length
        }
      }));
      logger.info(`[WS] sync_request from ${ws.deviceId}: ${changes.length} changes since ${since}`);
      break;
    }
    
    case 'sync_push': {
      // 推送本地变更到服务器，再广播给其他设备
      const { changes = [] } = payload;
      const processedIds = [];
      
      for (const change of changes) {
        if (change.action === 'create' || change.action === 'update') {
          const result = db.addFile(change.filename, change.content, change.type || 'file', change.hash);
          processedIds.push(result.id);
          // 广播实际文件数据给其他设备
          broadcastChange({ 
            type: change.action === 'create' ? 'file_create' : 'file_update',
            filename: change.filename,
            content: change.content,
            type: change.type || 'file',
            hash: change.hash || result.hash,
            size: result.size
          }, ws.deviceId);
        } else if (change.action === 'delete') {
          const existing = db.getFileByName(change.filename);
          db.deleteFileByName(change.filename);
          if (existing) processedIds.push(existing.id);
          // 广播删除给其他设备
          broadcastChange({ type: 'file_delete', filename: change.filename }, ws.deviceId);
        } else if (change.action === 'rename') {
          const { oldFilename, newFilename } = change;
          const existing = db.getFileByName(oldFilename);
          if (existing) {
            db.renameFile(oldFilename, newFilename);
            processedIds.push(existing.id);
            // 广播重命名给其他设备
            broadcastChange({ type: 'file_rename', oldFilename, newFilename }, ws.deviceId);
          }
        }
      }
      
      if (processedIds.length > 0) {
        db.markLogsSynced(processedIds);
      }
      
      ws.send(JSON.stringify({ type: 'sync_ack', payload: { processed: changes.length } }));
      break;
    }
    
    case 'file_create': {
      const { filename, content, type, hash, clientTs } = payload;
      const existing = db.getFileByName(filename);
      if (existing) {
        // 文件已存在：hash 相同则幂等忽略，hash 不同则冲突
        if (existing.hash === hash) {
          ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_create', filename, status: 'duplicate', hash } }));
        } else {
          // 冲突：通知双方
          const conflictInfo = { type: 'conflict', payload: { action: 'file_create', filename, localHash: existing.hash, remoteHash: hash, localTs: existing.updated_at, remoteTs: clientTs || 0, serverTs: Math.floor(Date.now() / 1000) } };
          ws.send(JSON.stringify(conflictInfo));
          broadcastChange({ type: 'conflict', action: 'file_create', filename, hash: existing.hash, newHash: hash }, null);
          logger.info(`[Conflict] file_create: ${filename} - local=${existing.hash} remote=${hash}`);
        }
      } else {
        db.addFile(filename, content, type || 'file', hash);
        broadcastChange({ type: 'create', filename, hash }, ws.deviceId);
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_create', filename, status: 'ok', hash } }));
      }
      break;
    }

    case 'file_update': {
      const { filename, content, type, hash, clientTs } = payload;
      const existing = db.getFileByName(filename);
      if (!existing) {
        // 文件不存在，直接创建
        db.addFile(filename, content, type || 'file', hash);
        broadcastChange({ type: 'create', filename, hash }, ws.deviceId);
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_update', filename, status: 'created', hash } }));
      } else if (existing.hash === hash) {
        // hash 相同，幂等忽略
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_update', filename, status: 'duplicate', hash } }));
      } else {
        // 冲突
        const conflictInfo = { type: 'conflict', payload: { action: 'file_update', filename, localHash: existing.hash, remoteHash: hash, localTs: existing.updated_at, remoteTs: clientTs || 0, serverTs: Math.floor(Date.now() / 1000) } };
        ws.send(JSON.stringify(conflictInfo));
        broadcastChange({ type: 'conflict', action: 'file_update', filename, hash: existing.hash, newHash: hash }, null);
        logger.info(`[Conflict] file_update: ${filename} - local=${existing.hash} remote=${hash}`);
      }
      break;
    }

    case 'file_delete': {
      const { filename } = payload;
      db.deleteFileByName(filename);
      broadcastChange({ type: 'delete', filename }, ws.deviceId);
      break;
    }

    case 'file_rename': {
      const { oldFilename, newFilename } = payload;
      db.renameFile(oldFilename, newFilename);
      broadcastChange({ type: 'rename', oldFilename, newFilename }, ws.deviceId);
      break;
    }

    case 'conflict_resolve': {
      // 冲突解决：force_remote 接受远程版本覆盖本地，force_local 保留本地版本
      const { filename, resolution, hash, content, type } = payload;
      if (resolution === 'force_remote') {
        if (content !== undefined) {
          const existing = db.getFileByName(filename);
          if (existing) {
            db.updateFileByName(filename, { content, type: type || existing.type, hash });
          } else {
            db.addFile(filename, content, type || 'file', hash);
          }
        }
        broadcastChange({ type: 'update', filename, hash }, ws.deviceId);
        logger.info(`[Conflict] Resolved force_remote: ${filename}`);
      } else if (resolution === 'force_local') {
        // 通知其他设备以本地为准（不需要做什么，因为本地没变）
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'conflict_resolve', filename, status: 'kept_local' } }));
        logger.info(`[Conflict] Resolved force_local: ${filename}`);
      } else if (resolution === 'rename_both') {
        // 重命名远程版本：filename → filename_timestamp
        const ts = Date.now();
        const newName = `${filename}.conflict_${ts}`;
        db.renameFile(filename, newName);
        db.addFile(filename, content, type || 'file', hash);
        broadcastChange({ type: 'rename', oldFilename: filename, newFilename: newName }, ws.deviceId);
        broadcastChange({ type: 'create', filename, hash }, ws.deviceId);
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'conflict_resolve', filename, status: 'renamed', newFilename: filename } }));
        logger.info(`[Conflict] Resolved rename_both: ${filename} → ${newName}`);
      }
      break;
    }

    case 'file_delete': {
      const { filename } = payload;
      const existing = db.getFileByName(filename);
      if (existing) {
        db.deleteFileByName(filename);
        broadcastChange({ type: 'file_delete', filename }, ws.deviceId);
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_delete', filename, status: 'ok' } }));
      } else {
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_delete', filename, status: 'not_found' } }));
      }
      break;
    }

    case 'file_rename': {
      const { oldFilename, newFilename } = payload;
      const result = db.renameFile(oldFilename, newFilename);
      if (result.success) {
        broadcastChange({ type: 'file_rename', oldFilename, newFilename }, ws.deviceId);
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_rename', oldFilename, newFilename, status: 'ok' } }));
      } else {
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_rename', oldFilename, newFilename, status: 'error', error: result.error } }));
      }
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
    if (ws.deviceId !== excludeDeviceId && ws.readyState === 1) {
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
          logger.info(`[Discovery] Found device: ${data.payload.deviceName} (${data.payload.ip})`);
        }
      }
    } catch (e) {
      // 忽略无效消息
    }
  });
  
  udpServer.on('error', (e) => {
    logger.error({ err: e }, 'Discovery error');
  });
  
  udpServer.bind(DISCOVERY_PORT, () => {
    udpServer.setBroadcast(true);
    logger.info(`[Discovery] UDP server on port ${DISCOVERY_PORT}`);
    
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
    const { unsynced, unsyncedSize } = db.getSyncStatus();

    if (onlineDevices.length > 0 && unsynced > 0) {
      logger.info(`[Sync] ${unsynced} unsynced changes (${formatSize(unsyncedSize)}), ${onlineDevices.length} online devices - nudging`);
      // 主动通知在线设备拉取待同步变更
      broadcastChange({ type: 'sync_nudge', pending: unsynced, size: unsyncedSize }, null);
    }
  }, 60000);
  
  // 每小时清理一次过期 Token、分享链接、sync_log
  setInterval(() => {
    db.cleanupExpiredTokens();
    db.cleanupExpiredShareLinks();
    db.cleanupSyncLog(7);  // 保留7天已同步的 sync_log
  }, 3600000);

  // 每天凌晨3点执行 VACUUM（DB碎片整理）
  setInterval(() => {
    const h = new Date().getHours();
    if (h === 3) {
      logger.info('[DB] Running daily VACUUM...');
      db.runVacuum();
    }
  }, 3600000);
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ShareTool</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#667eea" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="ShareTool">
<link rel="apple-touch-icon" href="/icon-192.png">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg-primary: #0f172a;
  --bg-secondary: #1e293b;
  --bg-tertiary: #334155;
  --bg-hover: #1e293b;
  --border-color: #334155;
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
  --bg-hover: #e2e8f0;
  --border-color: #cbd5e1;
  --text-primary: #1e293b;
  --text-secondary: #475569;
  --text-muted: #64748b;
  --accent-primary: #667eea;
  --accent-secondary: #764ba2;
  --success: #22c55e;
  --danger: #dc2626;
  --warning: #d97706;
}
[data-theme="dark"] {
  --bg-primary: #0f172a;
  --bg-secondary: #1e293b;
  --bg-tertiary: #334155;
  --bg-hover: #1e293b;
  --border-color: #334155;
  --text-primary: #f1f5f9;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --accent-primary: #667eea;
  --accent-secondary: #764ba2;
  --success: #22c55e;
  --danger: #dc2626;
  --warning: #d97706;
}
[data-theme="dark"] body { background: var(--bg-primary); }
[data-theme="dark"] .card { background: var(--bg-secondary); border-color: var(--border-color); }
[data-theme="dark"] .hero { background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-color: #334155; }
[data-theme="dark"] input[type="text"], [data-theme="dark"] input[type="search"], [data-theme="dark"] textarea { background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary); }
[data-theme="dark"] .file-item { background: var(--bg-tertiary); border-color: var(--border-color); }
[data-theme="dark"] .file-item:hover { border-color: var(--text-muted); }
[data-theme="dark"] .code-box { background: #0f172a; border-color: #334155; color: #86efac; }
[data-theme="dark"] .modal-content { background: var(--bg-secondary); border-color: var(--border-color); }
[data-theme="dark"] .modal-overlay { background: rgba(0,0,0,0.85); }
[data-theme="dark"] .modal-backdrop { background: rgba(0,0,0,0.7); }
[data-theme="dark"] .modal-close { color: var(--text-muted); }
[data-theme="dark"] .modal-close:hover { color: var(--text-primary); }
[data-theme="dark"] .qr-modal-overlay { background: rgba(0,0,0,0.9); }
[data-theme="dark"] select { background: var(--bg-tertiary); color: var(--text-primary); border-color: var(--border-color); }
[data-theme="dark"] ::-webkit-scrollbar { background: var(--bg-secondary); }
[data-theme="dark"] ::-webkit-scrollbar-thumb { background: var(--bg-tertiary); }
[data-theme="dark"] .device-item { background: var(--bg-tertiary); border-color: var(--border-color); }
[data-theme="dark"] .tag-item { background: var(--bg-tertiary); border-color: var(--border-color); }
[data-theme="dark"] .status-item { background: var(--bg-secondary); border-color: var(--border-color); color: var(--text-secondary); }
[data-theme="dark"] .progress-bar { background: var(--bg-secondary); }
[data-theme="dark"] .file-upload-area { background: var(--bg-tertiary); border-color: var(--border-color); }
[data-theme="dark"] .file-preview { background: var(--bg-secondary); border-color: var(--border-color); color: var(--text-secondary); }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; overscroll-behavior: none; /* prevent pull-to-refresh on mobile */ -webkit-tap-highlight-color: transparent; }
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
input[type="text"], input[type="search"] { width: 100%; padding: 12px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 10px; color: var(--text-primary); font-size: 16px; margin-bottom: 12px; }
input:focus { outline: none; border-color: var(--accent-primary); }
.btn { padding: 12px 20px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; border-radius: 10px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
.btn:hover { opacity: 0.9; transform: translateY(-1px); }
.btn:active { opacity: 0.8; transform: translateY(0); }
.btn-secondary { background: var(--bg-secondary); }
.btn-danger { background: #dc2626; }
.btn-warning { background: #d97706; }
.btn-sm { padding: 8px 14px; font-size: 13px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; }
.file-upload-area { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; background: var(--bg-tertiary); border: 2px dashed var(--border-color); border-radius: 12px; cursor: pointer; transition: all 0.2s; text-align: center; }
.file-upload-area:hover { border-color: var(--accent-primary); background: var(--bg-hover); }
.file-upload-area input { position: absolute; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.file-upload-area .icon { font-size: 40px; margin-bottom: 12px; }
.file-upload-area .text { color: var(--text-muted); font-size: 14px; }
.file-upload-area .hint { color: var(--text-muted); font-size: 12px; margin-top: 8px; }
.file-list { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.file-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }
.file-grid .file-item { flex-direction: column; align-items: stretch; padding: 16px; min-height: 140px; }
.file-grid .file-content { flex: 1; }
.file-grid .file-name { font-size: 13px; }
.file-grid .file-meta { font-size: 11px; }
.file-grid .file-actions { flex-wrap: wrap; justify-content: flex-start; margin-top: 8px; }
.file-grid .file-actions .btn { font-size: 11px; padding: 6px 8px; min-height: 32px; }
.file-grid .file-tags { margin-top: 6px; }
.file-grid .file-tag { font-size: 10px; padding: 2px 6px; }
.file-grid .file-star { position: absolute; top: 8px; right: 8px; }
.file-item { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px; background: var(--bg-tertiary); border-radius: 10px; border: 1px solid var(--border-color); gap: 12px; touch-action: pan-y; user-select: none; position: relative; overflow: hidden; }
.file-item:hover { border-color: var(--text-muted); }
.file-item .swipe-actions { position: absolute; right: 0; top: 0; bottom: 0; display: flex; align-items: center; gap: 0; transform: translateX(100%); transition: transform 0.2s ease; }
.file-item .swipe-actions.show { transform: translateX(0); }
.file-item .swipe-btn { height: 100%; padding: 0 20px; border: none; color: white; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 2px; min-width: 60px; }
.file-item .swipe-btn.delete { background: #dc2626; }
.file-item .swipe-btn.tag { background: #d97706; }
.file-item .swipe-btn .icon { font-size: 16px; }
.file-content { flex: 1; min-width: 0; }
.file-preview { background: var(--bg-secondary); border-radius: 8px; padding: 12px; margin-top: 8px; max-height: 150px; overflow: auto; white-space: pre-wrap; font-size: 12px; color: var(--text-secondary); border: 1px solid var(--border-color); word-break: break-all; display: none; }
.file-preview.show { display: block; }
.file-audio-player audio { width: 100%; height: 36px; margin-top: 4px; }
.file-video-wrapper video { width: 100%; max-height: 200px; border-radius: 8px; background: #000; margin-top: 4px; }
[data-theme="dark"] .file-audio-player audio { filter: invert(0.8); } /* improve contrast on dark bg */
.file-name { font-weight: 500; color: var(--text-primary); word-break: break-all; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.file-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.file-tag { font-size: 10px; padding: 2px 6px; background: rgba(102,126,234,0.2); color: #667eea; border-radius: 4px; cursor: pointer; transition: all 0.15s; }
.file-tag:hover { opacity: 0.85; }
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
.search-wrapper { position: relative; }
.search-suggestions { position: absolute; top: 100%; left: 0; right: 0; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; margin-top: 4px; z-index: 1000; max-height: 240px; overflow-y: auto; box-shadow: 0 4px 16px rgba(0,0,0,0.15); }
.search-suggestion { padding: 10px 14px; cursor: pointer; font-size: 13px; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
.search-suggestion:hover { background: var(--bg-tertiary); }
.search-suggestion .suggestion-icon { color: var(--text-muted); font-size: 12px; }
.search-suggestion .suggestion-tag { font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-left: auto; }
.filter-tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.filter-tab { padding: 6px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 20px; font-size: 12px; color: var(--text-muted); cursor: pointer; transition: all 0.2s; }
.filter-tab:hover { border-color: var(--accent-primary); }
.filter-tab.active { background: rgba(102,126,234,0.2); border-color: var(--accent-primary); }
.tab-bar { display: flex; gap: 4px; margin-bottom: 16px; background: var(--bg-tertiary); padding: 4px; border-radius: 10px; }
.tab-item { flex: 1; padding: 10px; text-align: center; font-size: 14px; color: var(--text-muted); border-radius: 8px; cursor: pointer; transition: all 0.2s; }
.tab-item:hover { color: var(--text-primary); }
.tab-item.active { background: var(--bg-secondary); color: var(--accent-primary); font-weight: 500; }
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
.fab:hover { transform: scale(1.1); }
.fab-menu { display: none; position: fixed; bottom: 90px; right: 24px; flex-direction: column; gap: 8px; z-index: 99; }
.fab-menu.show { display: flex; }
.fab-menu .btn { width: 48px; height: 48px; border-radius: 50%; padding: 0; font-size: 18px; }

.tag-filter-btn { cursor: pointer; transition: all 0.2s; }
.search-highlight { background: rgba(102,126,234,0.4); color: var(--text-primary); border-radius: 2px; padding: 0 2px; }
[data-theme="dark"] .search-highlight { background: rgba(102,126,234,0.3); color: #c4b5fd; }
.loading-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--text-muted); border-top-color: var(--accent-primary); border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.file-item { animation: fadeIn 0.2s ease-out; }
.toast { position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%); background: var(--bg-secondary); border: 1px solid var(--border-color); padding: 12px 24px; border-radius: 10px; font-size: 14px; z-index: 200; box-shadow: 0 4px 20px rgba(0,0,0,0.3); opacity: 0; transition: opacity 0.3s; }
.toast.show { opacity: 1; }
@media (max-width: 768px) {
  .container { max-width: 100%; }
  .modal-content { max-width: 95%; }
  .search-suggestions { max-height: 300px; }
}

@media (max-width: 500px) {
  .container { padding: 12px; padding-bottom: max(100px, calc(100px + env(safe-area-inset-bottom))); }
  .actions { flex-direction: column; }
  .btn { width: 100%; text-align: center; min-height: 44px; /* touch target */ }
  .file-actions { justify-content: flex-start; flex-wrap: wrap; }
  .file-item { flex-direction: column; min-height: 60px; }
  .file-actions .btn { width: auto; flex: 1; min-width: 60px; text-align: center; font-size: 12px; padding: 10px 10px; min-height: 44px; /* touch target */ }
  .setting-row { flex-direction: column; align-items: stretch; }
  .setting-row label { min-width: auto; }
  .hero-content { flex-direction: column; }
  .hero-url { flex-direction: column; }
  .status-bar { flex-direction: column; align-items: center; }
  .search-bar { flex-direction: column; }
  .search-bar .btn { width: 100%; }
  .search-bar input { min-height: 44px; /* touch target */ font-size: 16px; /* prevent iOS zoom */ }
  .sort-bar select, .share-link-box input, input[type="password"] { font-size: 16px; min-height: 44px; }
  .search-suggestions { max-height: 250px; }
  .qr-section.show { display: block; }
  .conn-status { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted); margin-left: 8px; }
  .conn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
  .conn-dot.connected { background: var(--success); box-shadow: 0 0 4px var(--success); }
  .storage-bar { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-muted); }
  .storage-bar progress { width: 80px; height: 6px; accent-color: var(--accent-primary); }
  .storage-text { font-size: 11px; color: var(--text-muted); }
  .share-link-box { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .share-link-box input { flex: 1; padding: 6px 10px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 12px; font-family: monospace; }
  .share-link-box button { padding: 6px 12px; background: var(--accent-primary); border: none; border-radius: 6px; color: white; font-size: 12px; cursor: pointer; }
  .upload-progress-bar { width: 100%; height: 4px; background: var(--bg-tertiary); border-radius: 2px; margin-top: 8px; overflow: hidden; display: none; }
  .upload-progress-fill { height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); border-radius: 2px; transition: width 0.3s; }
  .file-star { cursor: pointer; font-size: 16px; color: var(--text-muted); transition: color 0.2s; user-select: none; }
  .file-star:hover { color: var(--warning); }
  .file-star.starred { color: var(--warning); }
  .notif-badge { position: fixed; top: 12px; right: 12px; background: var(--danger); color: white; border-radius: 50%; width: 20px; height: 20px; font-size: 11px; display: none; align-items: center; justify-content: center; z-index: 400; font-weight: bold; }
  .notif-badge.show { display: flex; }
  .filter-tab .kbd-hint { font-size: 9px; opacity: 0.6; }
.fav-filter-btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 14px; font-size: 12px; color: var(--text-muted); cursor: pointer; }
.fav-filter-btn:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
.fav-filter-btn.active { background: rgba(245, 158, 11, 0.15); border-color: var(--warning); color: var(--warning); }
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
.sort-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; font-size: 12px; color: var(--text-muted); flex-wrap: wrap; }
.sort-bar select { padding: 6px 10px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-primary); font-size: 12px; }
.sort-bar select:focus { outline: none; border-color: var(--accent-primary); }
.view-toggle { display: flex; gap: 2px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 8px; padding: 2px; margin-left: auto; }
.view-toggle button { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 4px 8px; border-radius: 6px; font-size: 13px; line-height: 1; transition: all 0.15s; }
.view-toggle button:hover { color: var(--text-primary); }
.view-toggle button.active { background: var(--accent-primary); color: #fff; }
.pagination { display: flex; gap: 4px; align-items: center; justify-content: center; margin-top: 16px; }
.pagination button { padding: 6px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-muted); cursor: pointer; font-size: 12px; }
.pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
.pagination button.active { background: rgba(102,126,234,0.2); border-color: var(--accent-primary); color: var(--accent-primary); }
.pagination .page-info { font-size: 12px; color: var(--text-muted); padding: 0 8px; }
.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 300; display: none; align-items: center; justify-content: center; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
.modal-overlay.show { display: flex; }
.modal-content { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; max-width: 700px; width: 90%; max-height: 80vh; overflow: auto; padding-bottom: max(24px, env(safe-area-inset-bottom)); }
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
      <button onclick="showShareQRModal()">📷 二维码</button>
    </div>
    <div class="qr-modal-overlay" id="qrModal" onclick="if(event.target===this)closeShareQRModal()" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;align-items:center;justify-content:center;">
      <div style="background:var(--bg-primary);border-radius:16px;padding:24px;max-width:360px;width:90%;text-align:center;">
        <div style="font-size:18px;font-weight:600;margin-bottom:16px;">分享二维码</div>
        <div id="qrModalContent" style="display:flex;justify-content:center;margin-bottom:16px;"></div>
        <div id="qrModalUrl" style="font-size:11px;color:var(--text-muted);word-break:break-all;margin-bottom:16px;font-family:monospace;"></div>
        <button class="btn" onclick="closeShareQRModal()" style="width:100%;">关闭</button>
      </div>
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
    <div class="search-wrapper">
    <div class="search-bar">
      <input type="search" id="searchInput" placeholder="搜索文件名或内容..." autocomplete="off">
      <button class="btn btn-sm" onclick="doSearch()">搜索</button>
      <button class="btn btn-sm btn-secondary" id="clearSearchBtn" onclick="clearSearch()" style="display:none;">×</button>
    </div>
    <div class="search-suggestions" id="searchSuggestions" style="display:none;"></div>
    </div>
    <div class="filter-tabs">
      <span class="filter-tab active" data-filter="all">全部</span>
      <span class="filter-tab" data-filter="text">文字</span>
      <span class="filter-tab" data-filter="file">文件</span>
    </div>
    <div class="batch-bar" id="batchBar">
      <input type="checkbox" id="selectAllBatch" onchange="toggleSelectAll(this.checked)" style="width:18px;height:18px;cursor:pointer;">
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
      <span id="searchResultCount" style="display:none;color:var(--accent-primary);font-weight:500;margin-left:8px;"></span>
      <div class="view-toggle">
        <button class="active" id="listViewBtn" onclick="setView('list')" title="列表视图">☰</button>
        <button id="gridViewBtn" onclick="setView('grid')" title="网格视图">▦</button>
      </div>
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
    <div class="section-title">⚙️ 设置</div>
    <div style="margin-bottom: 12px;">
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">🔐 访问 Token</div>
      <div class="code-box" id="currentTokenDisplay" style="font-size:12px;padding:8px 12px;"></div>
      <button class="btn btn-sm" style="margin-top:8px;" onclick="showTokenModal()">更换Token</button>
      <button class="btn btn-sm btn-secondary" style="margin-top:8px;margin-left:4px;" onclick="refreshToken()">刷新</button>
    </div>
    <div style="margin-bottom: 12px;">
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">🔒 HTTPS 状态</div>
      <div id="httpsStatus" style="font-size:13px;color:var(--text-muted);">检测中...</div>
    </div>
    <div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">📊 操作日志</div>
      <button class="btn btn-sm" onclick="showAuditModal()">查看审计日志</button>
    </div>
    <div style="margin-top:12px;">
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">🔗 分享链接</div>
      <button class="btn btn-sm" onclick="showShareLinksModal()">管理分享链接</button>
      <button class="btn btn-sm" onclick="showTagManager()">🏷 标签管理</button>
    </div>
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

<div class="modal-overlay" id="auditModal" onclick="if(event.target===this)closeAuditModal()">
  <div class="modal-content" style="max-width:700px;max-height:80vh;overflow:auto;">
    <div class="modal-header">
      <div class="modal-title">📊 审计日志</div>
      <button class="modal-close" onclick="closeAuditModal()">x</button>
    </div>
    <div id="auditStats" style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;"></div>
    <div id="auditLogList" style="font-size:12px;"></div>
  </div>
</div>

<div class="modal-overlay" id="tokenModal" onclick="if(event.target===this)closeTokenModal()">
  <div class="modal-content" style="max-width:400px;">
    <div class="modal-header">
      <div class="modal-title">🔐 更换访问 Token</div>
      <button class="modal-close" onclick="closeTokenModal()">x</button>
    </div>
    <div style="padding:8px 0;">
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:6px;">新 Token (留空自动生成):</div>
      <input type="text" id="newTokenInput" placeholder="可选，自定义Token" style="width:100%;padding:10px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:13px;font-family:monospace;">
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button class="btn" onclick="doSetToken()" style="flex:1;">确认更换</button>
        <button class="btn btn-secondary" onclick="closeTokenModal()">取消</button>
      </div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="shareOptionsModal" onclick="if(event.target===this)closeShareOptionsModal()">
  <div class="modal-content" style="max-width:400px;">
    <div class="modal-header">
      <div class="modal-title">🔗 创建分享链接</div>
      <button class="modal-close" onclick="closeShareOptionsModal()">x</button>
    </div>
    <div style="padding:8px 0;">
      <input type="hidden" id="shareOptionsFilename">
      <div id="shareOptionsFileName" style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;padding:8px;background:var(--bg-tertiary);border-radius:8px;word-break:break-all;"></div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">过期时间</div>
        <select id="shareExpiryHours" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:13px;">
          <option value="24">24小时</option>
          <option value="72">3天</option>
          <option value="168" selected>7天（默认）</option>
          <option value="720">30天</option>
          <option value="0">永不过期</option>
        </select>
      </div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">下载次数限制（可选）</div>
        <input type="number" id="shareMaxDownloads" placeholder="不限制" min="1" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:13px;">
      </div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">密码保护（可选）</div>
        <input type="password" id="sharePassword" placeholder="不设置密码" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:13px;">
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn" onclick="doCreateShareLink()" style="flex:1;">创建链接</button>
        <button class="btn btn-secondary" onclick="closeShareOptionsModal()">取消</button>
      </div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="shareLinksModal" onclick="if(event.target===this)closeShareLinksModal()">
  <div class="modal-content" style="max-width:600px;max-height:80vh;overflow:auto;">
    <div class="modal-header">
      <div class="modal-title">🔗 分享链接管理</div>
      <button class="modal-close" onclick="closeShareLinksModal()">x</button>
    </div>
    <div id="shareLinksList" style="padding:8px 0;"></div>
  </div>
</div>

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

<div class="modal-overlay" id="tagManagerModal" onclick="if(event.target===this)closeTagManager()">
  <div class="modal-content" style="max-width:480px;max-height:80vh;overflow:auto;">
    <div class="modal-header">
      <div class="modal-title">🏷 标签管理</div>
      <button class="modal-close" onclick="closeTagManager()">x</button>
    </div>
    <div id="tagManagerList" style="display:flex;flex-direction:column;gap:8px;"></div>
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
let currentView = localStorage.getItem('sharetool_view') || 'list';
const PAGE_SIZE = 20;
let showFavoritesOnly = false;
const lastSyncTs = parseInt(localStorage.getItem('sharetool_last_sync') || '0');
const offlineQueue = JSON.parse(localStorage.getItem('sharetool_offline_queue') || '[]');
const TAG_COLOR_PRESETS = ['#667eea','#f59e0b','#10b981','#ef4444','#3b82f6','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316'];
let tagColors = {};  // { tagName: color } from server

// PWA: Register Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      logger.info('[SW] registered', reg.scope);
    }).catch(err => {
      logger.info('[SW] registration failed:', err);
    });
  });
}

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

// 冲突解决弹窗
function showConflictDialog(conflict) {
  const { action, filename, localHash, remoteHash, localTs, remoteTs } = conflict;
  const localTime = localTs ? new Date(localTs * 1000).toLocaleString('zh-CN') : '未知';
  const remoteTime = remoteTs ? new Date(remoteTs * 1000).toLocaleString('zh-CN') : '未知';
  const escapedName = escapeHtml(filename);
  const localHashDisplay = localHash ? localHash.substring(0, 12) + '...' : 'N/A';
  const remoteHashDisplay = remoteHash ? remoteHash.substring(0, 12) + '...' : 'N/A';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = '<div style="background:var(--card-bg);border-radius:16px;padding:28px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);border:1px solid var(--border-color);">' +
    '<div style="font-size:20px;font-weight:600;margin-bottom:8px;">' + '⚠️ 文件冲突' + '</div>' +
    '<div style="color:var(--text-muted);margin-bottom:16px;font-size:13px;">文件 <b>' + escapedName + '</b> 在两台设备上被同时修改</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">' +
      '<div style="background:var(--bg-secondary);border-radius:8px;padding:12px;">' +
        '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">本地版本</div>' +
        '<div style="font-size:12px;font-family:monospace;word-break:break-all;">' + localHashDisplay + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + localTime + '</div>' +
      '</div>' +
      '<div style="background:var(--bg-secondary);border-radius:8px;padding:12px;">' +
        '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">远程版本</div>' +
        '<div style="font-size:12px;font-family:monospace;word-break:break-all;">' + remoteHashDisplay + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + remoteTime + '</div>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:8px;">' +
      '<button id="conflict_keep_local" style="padding:10px 16px;background:var(--primary-color);color:white;border:none;border-radius:8px;cursor:pointer;font-size:14px;">保留本地版本</button>' +
      '<button id="conflict_keep_remote" style="padding:10px 16px;background:var(--bg-secondary);color:var(--text-color);border:1px solid var(--border-color);border-radius:8px;cursor:pointer;font-size:14px;">接受远程版本</button>' +
      '<button id="conflict_cancel" style="padding:10px 16px;background:transparent;color:var(--text-muted);border:none;cursor:pointer;font-size:13px;">稍后处理</button>' +
    '</div>' +
  '</div>';
  document.body.appendChild(overlay);

  overlay.querySelector('#conflict_keep_local').onclick = function() {
    wsSend('conflict_resolve', { filename: filename, resolution: 'force_local' });
    document.body.removeChild(overlay);
    showToast('已保留本地版本');
  };
  overlay.querySelector('#conflict_keep_remote').onclick = function() {
    wsSend('conflict_resolve', { filename: filename, resolution: 'force_remote', hash: remoteHash });
    document.body.removeChild(overlay);
    showToast('已接受远程版本');
  };
  overlay.querySelector('#conflict_cancel').onclick = function() {
    document.body.removeChild(overlay);
  };
  overlay.onclick = function(e) { if (e.target === overlay) document.body.removeChild(overlay); };
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

      logger.info('[WS] Connected');
      isConnected = true;
      reconnectDelay = 1000;
      updateWsStatus(true);
      startPeriodicSync(30000);
      flushOfflineQueue();
      
      ws.send(JSON.stringify({
        type: 'register',
        payload: { deviceId: DEVICE_ID, deviceName: DEVICE_NAME, lastSyncTs }
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

      logger.info('[WS] Disconnected');
      isConnected = false;
      updateWsStatus(false);
      flushOfflineQueue();
      scheduleReconnect();
    };
    
    ws.onerror = (e) => {
      logger.error({ err: e }, 'WS error');
    };
  } catch (e) {
    logger.error({ err: e }, 'WS connect failed');
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    logger.info('[WS] Reconnecting...');
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
      // 加载标签颜色
      loadTagColors();
      // 保存增量同步时间戳
      if (payload.sync && payload.sync.serverTs) {
        lastSyncTs = payload.sync.serverTs;
        localStorage.setItem('sharetool_last_sync', lastSyncTs);
        logger.info('[Sync] Saved lastSyncTs:', lastSyncTs);
      }
      // 显示未同步状态
      if (payload.syncStatus) {
        const { unsynced, unsyncedSize } = payload.syncStatus;
        if (unsynced > 0) {
          const sizeStr = formatSize(unsyncedSize || 0);
          document.getElementById('syncStatus').textContent = '同步在线 · ' + unsynced + ' 项待同步 (' + sizeStr + ')';
        }
      }
      // 应用增量同步变更（差异更新，避免全量刷新）
      if (payload.sync && payload.sync.changes && payload.sync.changes.length > 0) {
        applyIncrementalChanges(payload.sync.changes);
      }
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
      if (type === 'file_create') incrementBadge();
      showToast('📤 收到新文件: ' + (payload.filename || '').substring(0, 30));
      else if (type === 'file_delete') showToast('🗑 远程删除了文件');
      else if (type === 'file_rename') showToast('✏️ 远程重命名: ' + (payload.oldFilename || '') + ' → ' + (payload.newFilename || ''));
      else if (type === 'change' && payload.type === 'create') showToast('📤 收到新文件: ' + (payload.filename || '').substring(0, 30));
      else if (type === 'change' && payload.type === 'rename') showToast('✏️ 远程重命名: ' + (payload.oldFilename || '') + ' → ' + (payload.newFilename || ''));
      break;
    }
    case 'sync_response': {
      // 处理定时增量同步响应
      if (payload.sync && payload.sync.serverTs) {
        lastSyncTs = payload.sync.serverTs;
        localStorage.setItem('sharetool_last_sync', lastSyncTs);
      }
      if (payload.changes && payload.changes.length > 0) {
        applyIncrementalChanges(payload.changes);
        showToast('📥 增量同步 ' + payload.changes.length + ' 项');
      }
      logger.info('[Sync] sync_response:', payload.changes ? payload.changes.length : 0, 'changes');
      break;
    }
    case 'conflict': {
      // 显示冲突弹窗
      showConflictDialog(payload);
      break;
    }
    case 'sync_ack': {
      if (payload.status === 'duplicate' || payload.status === 'kept_local') {
        logger.info('[Sync] Ack:', payload.status, payload.filename);
      } else if (payload.status === 'ok' || payload.status === 'created') {
        showToast('✅ 同步成功: ' + (payload.filename || ''));
      } else if (payload.status === 'renamed') {
        showToast('🔄 冲突解决: 已重命名文件保留双方版本');
      }
      break;
    }
    case 'sync_nudge': {
      // 服务器主动通知有未同步数据，立即拉取
      logger.info('[Sync] Nudge received: pending=' + payload.pending + ', size=' + formatSize(payload.size || 0));
      if (payload.pending > 0) {
        showToast('📡 发现 ' + payload.pending + ' 项待同步变更，开始拉取...');
        doIncrementalSync(lastSyncTs);
      }
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

// 离线队列：操作符发送失败时缓存
function addToOfflineQueue(action, payload) {
  offlineQueue.push({ action, payload, ts: Math.floor(Date.now() / 1000) });
  localStorage.setItem('sharetool_offline_queue', JSON.stringify(offlineQueue));
  logger.info('[OfflineQueue] Added:', action, 'Queue size:', offlineQueue.length);
}

// 重连时批量发送离线操作
function flushOfflineQueue() {
  if (!isConnected || offlineQueue.length === 0) return;
  logger.info('[OfflineQueue] Flushing', offlineQueue.length, 'items');
  const queue = [...offlineQueue];
  offlineQueue = [];
  localStorage.setItem('sharetool_offline_queue', '[]');

  for (const item of queue) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: item.action, payload: item.payload }));
    } else {
      // 仍未连接，放回队列
      offlineQueue.push(item);
    }
  }
  if (offlineQueue.length > 0) {
    localStorage.setItem('sharetool_offline_queue', JSON.stringify(offlineQueue));
  }
  logger.info('[OfflineQueue] Flush complete, remaining:', offlineQueue.length);
}

// 增量同步：定期从服务器拉取变更
let syncIntervalId = null;

// 手动触发一次增量同步
function doIncrementalSync(sinceTs = 0) {
  if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) {
    logger.info('[Sync] Cannot sync: not connected');
    return;
  }
  ws.send(JSON.stringify({ type: 'sync_request', payload: { since: sinceTs || lastSyncTs, deviceId: DEVICE_ID } }));
  logger.info('[Sync] Manual sync_request sent, since:', sinceTs || lastSyncTs);
}

function startPeriodicSync(intervalMs = 30000) {
  if (syncIntervalId) clearInterval(syncIntervalId);
  syncIntervalId = setInterval(() => {
    if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'sync_request', payload: { since: lastSyncTs, deviceId: DEVICE_ID } }));
      logger.info('[Sync] Periodic sync_request sent, since:', lastSyncTs);
    }
  }, intervalMs);
  logger.info('[Sync] Periodic sync started, interval:', intervalMs, 'ms');
}

// 应用增量同步变更（差异更新）
function applyIncrementalChanges(changes) {
  if (!changes || !changes.length) return;
  logger.info('[Sync] Applying', changes.length, 'incremental changes');
  let updated = false;
  for (const change of changes) {
    const action = change.action;
    const filename = change.filename;
    if (action === 'create' || action === 'update') {
      // 文件创建或更新：检查是否存在
      const idx = currentFiles.findIndex(f => f.name === filename);
      const fileData = { name: filename, size: change.size, time: (change.timestamp || 0) * 1000, type: change.type, hash: change.current_hash || change.hash, tags: [] };
      if (idx >= 0) {
        currentFiles[idx] = { ...currentFiles[idx], ...fileData };
      } else {
        currentFiles.unshift(fileData);
      }
      updated = true;
    } else if (action === 'delete') {
      currentFiles = currentFiles.filter(f => f.name !== filename);
      updated = true;
    } else if (action === 'rename') {
      const idx = currentFiles.findIndex(f => f.name === change.oldFilename);
      if (idx >= 0) {
        currentFiles[idx].name = change.newFilename;
        updated = true;
      }
    }
  }
  if (updated) {
    renderFiles();
    updateTagFilterBar();
  }
}

// 发送 WS 消息（带离线队列）
function wsSend(type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  } else {
    addToOfflineQueue(type, payload);
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
      '<div class="ip">' + escapeHtml(d.ip) + '</div>' +
    '</div>'
  ).join('');
}

async function loadTagColors() {
  try {
    const res = await fetch(API + '/api/tags/colors', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success && data.colors) {
      tagColors = {};
      data.colors.forEach(c => { tagColors[c.tag] = c.color; });
      renderFiles();
    }
  } catch (e) {
    logger.error({ err: e }, 'TagColor load failed');
  }
}

function getTagStyle(tagName) {
  const color = tagColors[tagName];
  if (color) {
    const r = parseInt(color.slice(1,3), 16);
    const g = parseInt(color.slice(3,5), 16);
    const b = parseInt(color.slice(5,7), 16);
    return 'background:rgba(' + r + ',' + g + ',' + b + ',0.2);color:' + color + ';';
  }
  return '';
}

async function loadFiles() {
  try {
    const sortRaw = localStorage.getItem('sharetool_sort') || 'created_at';
    const sortOrder = localStorage.getItem('sharetool_order') || 'desc';
    const res = await fetch(API + '/api/list?sort=' + sortRaw + '&order=' + sortOrder, { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    currentFiles = data.files || [];
    // Sync sort select UI
    initSortSelect(sortRaw, sortOrder);
    renderFiles();
    updateTagFilterBar();
  } catch (e) {
    logger.error({ err: e }, 'Load files failed');
  }
}

function initSortSelect(sort, order) {
  const sel = document.getElementById('sortSelect');
  if (!sel) return;
  const sortKey = sort === 'created_at' ? 'time' : sort;
  const target = sortKey + '_' + order;
  for (const opt of sel.options) {
    opt.selected = opt.value === target;
  }
  currentSort = target;
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
    const style = getTagStyle(t) || '';
    return '<span class="filter-tab ' + active + '" onclick="filterByTag(\'' + t.replace(/'/g, "\\'") + '\')" style="font-size:11px;' + style + '">🏷 ' + escapeHtml(t) + '</span>';
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
    const searchMode = !!window.currentSearchQ;
    container.innerHTML = '<div class="empty" id="emptyState">' +
      '<div class="empty-icon">' + (searchMode ? '🔍' : '📭') + '</div>' +
      '<div class="empty-text">' + (searchMode ? '未找到匹配结果' : '暂无分享内容') + '</div>' +
      '<div class="empty-text" style="font-size:12px;margin-top:8px;">' + (searchMode ? '尝试其他关键词或清除筛选' : '上传文件或分享文字开始使用') + '</div>' +
      '</div>';
    container.classList.remove('file-list', 'file-grid');
    container.classList.add(currentView === 'grid' ? 'file-grid' : 'file-list');
    renderPagination(0, 1);
    return;
  }

  container.innerHTML = '<div class="file-list">' + pagedFiles.map(f => {
    const isText = f.type === 'text';
    const isImage = isImageFile(f.name);
    const isAudio = isAudioFile(f.name);
    const isVideo = isVideoFile(f.name);
    const isPdf = isPdfFile(f.name);
    const previewId = 'preview-' + btoaSafe(f.name).substring(0, 20);
    const thumbId = 'thumb-' + btoaSafe(f.name).substring(0, 20);
    const tags = f.tags ? f.tags.split(',').filter(t => t.trim()) : [];
    const searchQ = (window.currentSearchQ || '').trim();

    // Search highlight applied by applySearchHighlight() after render

    return '<div class="file-item" data-filename="' + escapeHtml(f.name) + '" ontouchstart="handleSwipeStart(event, this)" ontouchmove="handleSwipeMove(event, this)" ontouchend="handleSwipeEnd(event, this)">' +
      '<div class="swipe-actions" id="swipe-' + btoaSafe(f.name).substring(0, 20) + '">' +
        '<button class="swipe-btn tag" onclick="event.preventDefault(); event.stopPropagation(); addTag(\'' + encodeURIComponent(f.name) + '\', \'' + (f.tags || '') + '\'); resetSwipe(this)"><span class="icon">🏷</span><span>标签</span></button>' +
        '<button class="swipe-btn delete" onclick="event.preventDefault(); event.stopPropagation(); deleteFile(\'' + encodeURIComponent(f.name) + '\'); resetSwipe(this)"><span class="icon">🗑</span><span>删除</span></button>' +
      '</div>' +
      '<div style="margin-right: 12px; display:flex; align-items:center;">' +
        '<input type="checkbox" class="batch-checkbox" value="' + encodeURIComponent(f.name) + '" style="width: 18px; height: 18px; cursor: pointer;">' +
      '</div>' +
      '<div class="file-content">' +
        (isImage
          ? '<div class="file-thumb-wrapper" style="margin-bottom:8px;"><img class="file-thumb-img" id="' + thumbId + '" data-src="" loading="lazy" style="border-radius:6px;max-width:100%;max-height:120px;object-fit:cover;display:block;cursor:pointer;" onclick="openImageModal(\'' + encodeURIComponent(f.name) + '\')" /></div>'
          : '<div class="file-name"><span class="file-type-icon">' + getFileIcon(f.name) + '</span><span class="search-target">' + escapeHtml(f.name) + '</span></div>') +
        (tags.length ? '<div class="file-tags">' + tags.map(t => '<span class="file-tag" style="' + getTagStyle(t.trim()) + '" onclick="filterByTag(\'' + escapeHtml(t.trim()) + '\')">' + escapeHtml(t.trim()) + '<span class="remove-tag" onclick="event.stopPropagation(); removeTag(\'' + encodeURIComponent(f.name) + '\', \'' + escapeHtml(t.trim()) + '\')">×</span></span>').join('') + '</div>' : '') +
        '<button class="btn btn-sm" style="margin-top:6px;font-size:11px;padding:4px 10px;" onclick="addTag(\'' + encodeURIComponent(f.name) + '\', \'' + (f.tags || '') + '\')">+标签</button>' +
        '<div class="file-meta">' + formatSize(f.size) + ' | ' + formatTime(f.time) + '</div>' +
        (isText ? '<div class="file-preview" id="' + previewId + '"></div>' : '') +
        // Audio/Video/PDF inline player
        (isAudio ? '<div class="file-audio-player" id="player-' + btoaSafe(f.name).substring(0, 20) + '" style="margin-top:8px;"></div>' : '') +
        (isVideo ? '<div class="file-video-wrapper" id="player-' + btoaSafe(f.name).substring(0, 20) + '" style="margin-top:8px;"></div>' : '') +
        (isPdf ? '<button class="btn btn-sm" style="margin-top:8px;font-size:11px;padding:4px 10px;" onclick="openPdfModal(\'' + encodeURIComponent(f.name) + '\')">📕 预览PDF</button>' : '') +
      '</div>' +
      '<div class="file-actions">' +
        (isText ? '<button class="btn btn-sm" onclick="openFileModal(\'' + encodeURIComponent(f.name) + '\')">预览</button>' : '') +
        (isAudio || isVideo ? '<button class="btn btn-sm" onclick="openMediaModal(\'' + encodeURIComponent(f.name) + '\')">▶ 播放</button>' : '') +
        (isImage ? '<button class="btn btn-sm" onclick="openImageModal(\'' + encodeURIComponent(f.name) + '\')">🖼 查看</button>' : '') +
        '<button class="btn btn-sm" onclick="copyContent(\'' + encodeURIComponent(f.name) + '\')">复制</button>' +
        '<button class="btn btn-sm" onclick="renameFile(\'' + encodeURIComponent(f.name) + '\')">重命名</button>' +
        '<button class="btn btn-sm" onclick="downloadFile(\'' + encodeURIComponent(f.name) + '\')">下载</button>' +
        '<button class="btn btn-sm" onclick="shareFile(\'' + encodeURIComponent(f.name) + '\')">分享</button>' +
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

  // 懒加载图片缩略图（仅 jpg/png/gif/webp，限制大小 2MB）
  for (const f of pagedFiles) {
    if (isImageFile(f.name) && f.size > 0 && f.size < 2 * 1024 * 1024) {
      loadImageThumb(f.name, 'thumb-' + btoaSafe(f.name).substring(0, 20));
    }
  }

  // Render pagination
  const allFiles = applySort(currentFilter !== 'all' ? currentFiles.filter(f => f.type === currentFilter) : [...currentFiles]);
  const totalPages = Math.ceil(allFiles.length / PAGE_SIZE) || 1;
  renderPagination(currentPage, totalPages);
  updateFavoritesInView();
}

// Mobile swipe gesture handling
let swipeState = {};
const SWIPE_THRESHOLD = 60;

function handleSwipeStart(e, el) {
  swipeState.el = el;
  swipeState.startX = e.touches[0].clientX;
  swipeState.currentX = swipeState.startX;
}

function handleSwipeMove(e, el) {
  if (!swipeState.el || swipeState.el !== el) return;
  const dx = e.touches[0].clientX - swipeState.startX;
  swipeState.currentX = e.touches[0].clientX;
  const actions = el.querySelector('.swipe-actions');
  if (!actions) return;
  if (dx < 0) {
    el.style.transform = 'translateX(' + Math.max(dx, -140) + 'px)';
    el.style.transition = 'none';
  }
}

function handleSwipeEnd(e, el) {
  if (!swipeState.el || swipeState.el !== el) return;
  const dx = swipeState.currentX - swipeState.startX;
  const actions = el.querySelector('.swipe-actions');
  if (!actions) return;
  el.style.transition = 'transform 0.2s ease';
  if (dx < -SWIPE_THRESHOLD) {
    el.style.transform = 'translateX(-140px)';
    actions.classList.add('show');
  } else {
    el.style.transform = 'translateX(0)';
    actions.classList.remove('show');
  }
  swipeState = {};
}

function resetSwipe(btn) {
  const item = btn.closest('.file-item');
  if (!item) return;
  item.style.transition = 'transform 0.2s ease';
  item.style.transform = 'translateX(0)';
  const actions = item.querySelector('.swipe-actions');
  if (actions) actions.classList.remove('show');
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

// 懒加载图片缩略图：获取文件内容转为 data URL
async function loadImageThumb(filename, thumbId) {
  const el = document.getElementById(thumbId);
  if (!el || el.dataset.src) return; // 已有内容，跳过
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.content && data.type && data.type.startsWith('image/')) {
      const ext = filename.split('.').pop().toLowerCase();
      const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      const mime = mimeMap[ext] || 'image/jpeg';
      el.src = 'data:' + mime + ';base64,' + data.content;
      el.dataset.src = 'loaded';
    }
  } catch (e) {}
}

// 点击图片缩略图打开全屏预览
async function openImageModal(filename) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.content) return;
    const ext = filename.split('.').pop().toLowerCase();
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
    const mime = mimeMap[ext] || 'image/jpeg';
    const dataUrl = 'data:' + mime + ';base64,' + data.content;
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalMeta').textContent = 'Size: ' + formatSize(data.size || 0);
    document.getElementById('modalBody').innerHTML = '<img src="' + dataUrl + '" style="max-width:100%;max-height:80vh;display:block;margin:0 auto;border-radius:8px;" />';
    document.getElementById('fileModal').classList.add('show');
  } catch (e) { showToast('Failed to open image'); }
}

async function openMediaModal(filename) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.content) return;
    const ext = filename.split('.').pop().toLowerCase();
    const isAudio = isAudioFile(filename);
    const mimeMap = {
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', m4a: 'audio/mp4',
      mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo', mov: 'video/quicktime', mkv: 'video/x-matroska'
    };
    const mime = mimeMap[ext] || (isAudio ? 'audio/mpeg' : 'video/mp4');
    const dataUrl = 'data:' + mime + ';base64,' + data.content;
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalMeta').textContent = formatSize(data.size || 0);
    if (isAudio) {
      document.getElementById('modalBody').innerHTML =
        '<div style="text-align:center;padding:20px;background:var(--bg-tertiary);border-radius:8px;"><audio controls autoplay style="width:100%;max-width:500px;"><source src="' + dataUrl + '" type="' + mime + '">您的浏览器不支持音频播放</audio></div>';
    } else {
      document.getElementById('modalBody').innerHTML =
        '<div style="text-align:center;background:#000;padding:10px;border-radius:8px;"><video controls autoplay style="max-width:100%;max-height:70vh;border-radius:8px;"><source src="' + dataUrl + '" type="' + mime + '">您的浏览器不支持视频播放</video></div>';
    }
    document.getElementById('fileModal').classList.add('show');
  } catch (e) { showToast('Failed to open media: ' + e.message); }
}

async function openPdfModal(filename) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.content) return;
    const dataUrl = 'data:application/pdf;base64,' + data.content;
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalMeta').textContent = formatSize(data.size || 0);
    document.getElementById('modalBody').innerHTML =
      '<iframe src="' + dataUrl + '" style="width:100%;height:70vh;border:none;border-radius:8px;background:var(--bg-tertiary);" title="PDF预览"></iframe>';
    document.getElementById('fileModal').classList.add('show');
  } catch (e) { showToast('Failed to open PDF: ' + e.message); }
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

function closeAuditModal() {
  document.getElementById('auditModal').classList.remove('show');
}

function closeTokenModal() {
  document.getElementById('tokenModal').classList.remove('show');
}

function closeShareLinksModal() {
  document.getElementById('shareLinksModal').classList.remove('show');
}

function showShareLinksModal() {
  fetch(API + '/api/share/list', { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      if (!data.success) { showToast('获取分享链接失败'); return; }
      const links = data.links || [];
      const el = document.getElementById('shareLinksList');
      if (!el) return;
      if (!links.length) {
        el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">暂无分享链接</div>';
      } else {
        el.innerHTML = '<div style="display:flex;flex-direction:column;gap:8px;">' + links.map(l => {
          const url = location.origin + '/s/' + l.code + (l.password ? '?pwd=' : '');
          const isExpired = l.expiresAt && l.expiresAt !== MAX_TS && l.expiresAt < Date.now();
          const expires = (l.expiresAt === MAX_TS || !l.expiresAt) ? '永不过期' : (isExpired ? '已过期' : '剩余 ' + Math.ceil((l.expiresAt - Date.now()) / 86400000) + ' 天');
          return '<div style="padding:12px;background:var(--bg-tertiary);border-radius:8px;display:flex;flex-direction:column;gap:6px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
              '<span style="font-weight:600;">' + escapeHtml(l.filename) + (l.password ? ' 🔒' : '') + '</span>' +
              '<span style="font-size:11px;color:' + (isExpired ? '#dc2626' : 'var(--text-muted)') + ';">' + (isExpired ? '已过期' : expires) + '</span>' +
            '</div>' +
            '<div style="font-size:11px;font-family:monospace;color:var(--text-muted);word-break:break-all;">' + escapeHtml(url) + '</div>' +
            '<div style="display:flex;gap:8px;margin-top:4px;">' +
              '<button class="btn btn-sm" onclick="copyShareLinkOf(\'' + l.code + '\', \'' + escapeHtml(url) + '\')">复制链接</button>' +
              '<button class="btn btn-sm" onclick="showShareLinkQR(\'' + l.code + '\')">二维码</button>' +
              '<button class="btn btn-sm btn-danger" onclick="deleteShareLink(\'' + l.code + '\')">删除</button>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';
      }
      document.getElementById('shareLinksModal').classList.add('show');
    }).catch(() => showToast('获取分享链接失败'));
}

function copyShareLinkOf(code, url) {
  navigator.clipboard.writeText(url).then(() => showToast('✓ 链接已复制')).catch(() => showToast('复制失败'));
}

function showShareLinkQR(code) {
  // Reuse the QR modal
  showShareQRModalForCode(code);
}

function showShareQRModalForCode(code) {
  const url = location.origin + '/s/' + code;
  const modal = document.getElementById('qrModal');
  const content = document.getElementById('qrModalContent');
  const urlEl = document.getElementById('qrModalUrl');
  if (modal && content && urlEl) {
    content.innerHTML = '<div style="font-size:40px;animation:spin 1s linear infinite;">⏳</div>';
    urlEl.textContent = url;
    modal.classList.add('show');
    fetch(API + '/api/share/qr/' + code, { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
      .then(r => r.json())
      .then(qrData => {
        if (qrData.success && qrData.dataUrl) {
          content.innerHTML = '<img src="' + qrData.dataUrl + '" style="border-radius:8px;max-width:256px;width:100%;" />';
        } else {
          content.innerHTML = '<div style="color:#dc2626;">生成失败</div>';
        }
      })
      .catch(e => { content.innerHTML = '<div style="color:#dc2626;">请求失败</div>'; });
  }
}

function deleteShareLink(code) {
  if (!confirm('确定删除此分享链接？')) return;
  fetch(API + '/api/share/delete/' + code, { method: 'DELETE', headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        showToast('✓ 已删除');
        showShareLinksModal(); // Refresh
      } else {
        showToast('删除失败');
      }
    }).catch(() => showToast('删除失败'));
}

function showAuditModal() {
  fetch(API + '/api/audit/logs', { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      if (!data.success) { showToast('获取日志失败'); return; }
      const stats = data.stats || {};
      document.getElementById('auditStats').innerHTML =
        '<div style="background:var(--bg-tertiary);padding:8px 14px;border-radius:8px;font-size:12px;"><div style="color:var(--text-muted);">今日操作</div><div style="font-size:20px;font-weight:600;color:#667eea">' + (stats.todayCount || 0) + '</div></div>' +
        '<div style="background:var(--bg-tertiary);padding:8px 14px;border-radius:8px;font-size:12px;"><div style="color:var(--text-muted);">总操作</div><div style="font-size:20px;font-weight:600;color:#667eea">' + (stats.totalCount || 0) + '</div></div>' +
        '<div style="background:var(--bg-tertiary);padding:8px 14px;border-radius:8px;font-size:12px;"><div style="color:var(--text-muted);">最后操作</div><div style="font-size:12px;color:var(--text-secondary)">' + escapeHtml(stats.lastAction || '--') + '</div></div>';

      const logs = data.logs || [];
      document.getElementById('auditLogList').innerHTML = logs.length ? logs.map(l =>
        '<div style="padding:8px 0;border-bottom:1px solid var(--border-color);display:flex;justify-content:space-between;gap:12px;">' +
          '<div><div style="color:var(--text-primary);">' + escapeHtml(l.action || '') + '</div><div style="color:var(--text-muted);font-size:11px;margin-top:2px;">' + escapeHtml(l.detail || '') + '</div></div>' +
          '<div style="text-align:right;flex-shrink:0;"><div style="color:var(--text-muted);font-size:11px;">' + formatTime((l.created_at || 0) * 1000) + '</div>' +
          (l.ip ? '<div style="color:var(--text-muted);font-size:10px;font-family:monospace;">' + escapeHtml(l.ip) + '</div>' : '') +
          '</div></div>'
      ).join('') : '<div style="padding:20px;text-align:center;color:var(--text-muted);">暂无日志记录</div>';
      document.getElementById('auditModal').classList.add('show');
    }).catch(() => showToast('获取日志失败'));
}

function showTokenModal() {
  document.getElementById('tokenModal').classList.add('show');
  document.getElementById('newTokenInput').value = '';
  document.getElementById('newTokenInput').focus();
}

async function refreshToken() {
  try {
    const res = await fetch(API + '/api/token/refresh', { method: 'POST', headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success) {
      AUTH_TOKEN = data.token;
      localStorage.setItem('sharetool_token', AUTH_TOKEN);
      document.getElementById('currentTokenDisplay').textContent = AUTH_TOKEN;
      showToast('Token 已刷新');
    } else {
      showToast('刷新失败: ' + (data.error || ''));
    }
  } catch (e) { showToast('刷新失败'); }
}

async function doSetToken() {
  const newToken = document.getElementById('newTokenInput').value.trim();
  try {
    const res = await fetch(API + '/api/token/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ token: newToken })
    });
    const data = await res.json();
    if (data.success) {
      AUTH_TOKEN = data.token;
      localStorage.setItem('sharetool_token', AUTH_TOKEN);
      document.getElementById('currentTokenDisplay').textContent = AUTH_TOKEN;
      closeTokenModal();
      showToast('Token 更新成功');
    } else {
      showToast('更新失败: ' + (data.error || ''));
    }
  } catch (e) { showToast('更新失败'); }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeShortcutModal();
    closeAuditModal();
    closeTokenModal();
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
  const [sortKey, sortOrder] = value.split('_');
  localStorage.setItem('sharetool_sort', sortKey === 'time' ? 'created_at' : sortKey);
  localStorage.setItem('sharetool_order', sortOrder);
  currentSort = value;
  currentPage = 1;
  loadFiles();
  if (window.currentSearchQ) applySearchHighlight(window.currentSearchQ);
}

function setView(mode) {
  currentView = mode;
  localStorage.setItem('sharetool_view', mode);
  applyView(mode);
  renderFiles();
}

function applyView(mode) {
  const listBtn = document.getElementById('listViewBtn');
  const gridBtn = document.getElementById('gridViewBtn');
  if (listBtn) listBtn.classList.toggle('active', mode === 'list');
  if (gridBtn) gridBtn.classList.toggle('active', mode === 'grid');
  const container = document.getElementById('filesContainer');
  if (!container) return;
  // Remove both classes first
  container.classList.remove('file-list', 'file-grid');
  // Add the appropriate class
  container.classList.add(mode === 'grid' ? 'file-grid' : 'file-list');
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
      if (data.files && data.files.length > 0) saveRecentSearch(q);
      // Show result count in sort-bar area
      const countEl = document.getElementById('searchResultCount');
      if (countEl) {
        countEl.textContent = '找到 ' + currentFiles.length + ' 个结果';
        countEl.style.display = 'inline';
      }
    })
    .catch(e => showAlert('listAlert', '搜索失败', 'error'));
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  window.currentSearchQ = '';
  document.getElementById('clearSearchBtn').style.display = 'none';
  const countEl = document.getElementById('searchResultCount');
  if (countEl) countEl.style.display = 'none';
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
      // Create share link for the file
      const shareRes = await fetch(API + '/api/share/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
        body: JSON.stringify({ filename })
      });
      const shareData = await shareRes.json();
      const linkBox = document.getElementById('shareLinkBox');
      const linkInput = document.getElementById('shareLinkInput');
      if (linkBox && linkInput) {
        linkInput.value = shareData.success ? shareData.url : (location.origin + '/api/files/' + encodeURIComponent(filename) + '?auth=' + (AUTH_TOKEN || ''));
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

async function shareFile(filename) {
  // Open share options modal
  document.getElementById('shareOptionsFilename').value = filename;
  document.getElementById('shareOptionsFileName').textContent = filename;
  document.getElementById('shareExpiryHours').value = '168';
  document.getElementById('shareMaxDownloads').value = '';
  document.getElementById('sharePassword').value = '';
  document.getElementById('shareOptionsModal').classList.add('show');
}

async function doCreateShareLink() {
  const filename = document.getElementById('shareOptionsFilename').value;
  if (!filename) { showToast('文件名无效'); return; }
  const expiryHours = parseInt(document.getElementById('shareExpiryHours').value) || 168;
  const maxDownloads = parseInt(document.getElementById('shareMaxDownloads').value) || null;
  const password = document.getElementById('sharePassword').value || null;
  closeShareOptionsModal();
  try {
    const res = await fetch(API + '/api/share/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ filename, expiryHours: expiryHours || null, maxDownloads, password })
    });
    const data = await res.json();
    if (data.success) {
      const shareUrl = data.url;
      const linkBox = document.getElementById('shareLinkBox');
      const linkInput = document.getElementById('shareLinkInput');
      if (linkBox && linkInput) {
        linkInput.value = shareUrl;
        linkBox.style.display = 'flex';
      }
      showToast('✓ 分享链接已创建');
    } else {
      showToast('分享失败: ' + data.error);
    }
  } catch (e) {
    showToast('分享失败: ' + e.message);
  }
}

function closeShareOptionsModal() {
  document.getElementById('shareOptionsModal').classList.remove('show');
}

function showShareQRModal() {
  const linkInput = document.getElementById('shareLinkInput');
  if (!linkInput || !linkInput.value) { showToast('请先生成分享链接'); return; }
  const url = linkInput.value;
  const modal = document.getElementById('qrModal');
  const content = document.getElementById('qrModalContent');
  const urlEl = document.getElementById('qrModalUrl');
  if (modal && content && urlEl) {
    content.innerHTML = '<div style="font-size:40px;animation:spin 1s linear infinite;">⏳</div>';
    urlEl.textContent = url;
    modal.classList.add('show');
    // Generate QR from URL (share code is embedded)
    // Extract code from URL like http://IP:PORT/s/XXXX
    const code = url.split('/s/')[1] || '';
    fetch(API + '/api/share/qr/' + code, { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
      .then(r => r.json())
      .then(qrData => {
        if (qrData.success && qrData.dataUrl) {
          content.innerHTML = '<img src="' + qrData.dataUrl + '" style="border-radius:8px;max-width:256px;width:100%;" />';
        } else {
          content.innerHTML = '<div style="color:#dc2626;">生成失败: ' + escapeHtml(qrData.error || '未知错误') + '</div>';
        }
      })
      .catch(e => { content.innerHTML = '<div style="color:#dc2626;">请求失败: ' + escapeHtml(e.message) + '</div>'; });
  }
}

function closeShareQRModal() {
  const modal = document.getElementById('qrModal');
  if (modal) modal.classList.remove('show');
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
  const newTags = input.split(',').map(t => t.trim()).filter(t => t);
  if (newTags.length === 0) return;

  // 为新标签请求颜色
  for (const tag of newTags) {
    if (!tagColors[tag]) {
      try {
        const res = await fetch(API + '/api/tags/suggest-color?tag=' + encodeURIComponent(tag), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
        const data = await res.json();
        if (data.success) {
          tagColors[tag] = data.color;
          await fetch(API + '/api/tags/color', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
            body: JSON.stringify({ tag, color: data.color })
          });
        }
      } catch (e) {}
    }
  }

  const tags = newTags.join(',');
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

async function renameFile(oldFilename) {
  const newFilename = prompt('输入新文件名:', decodeURIComponent(oldFilename));
  if (!newFilename || newFilename === decodeURIComponent(oldFilename)) return;
  try {
    const res = await fetch(API + '/api/file-rename/' + oldFilename, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ newFilename: newFilename.trim() })
    });
    const data = await res.json();
    if (data.success) {
      showToast('已重命名: ' + data.newFilename);
      loadFiles();
      broadcastWs({ type: 'file_rename', payload: { oldFilename: data.oldFilename, newFilename: data.newFilename } });
    } else {
      showAlert('listAlert', '重命名失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (e) { showAlert('listAlert', '重命名失败: ' + e.message, 'error'); }
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

function toggleSelectAll(checked) {
  document.querySelectorAll('.batch-checkbox').forEach(cb => cb.checked = checked);
  updateBatchBar();
}

function updateBatchBar() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  const bar = document.getElementById('batchBar');
  const count = document.getElementById('batchCount');
  if (bar) bar.classList.toggle('show', checked.length > 0);
  if (count) count.textContent = '已选择 ' + checked.length + ' 个文件';
  const selectAll = document.getElementById('selectAllBatch');
  if (selectAll) selectAll.checked = checked.length > 0 && checked.length === document.querySelectorAll('.batch-checkbox').length;
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

async function showTagManager() {
  const res = await fetch(API + '/api/tags/list', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
  const data = await res.json();
  const list = document.getElementById('tagManagerList');
  if (!data.success || !data.tags.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">暂无标签</div>';
  } else {
    list.innerHTML = data.tags.map(t => {
      const color = t.color || '#667eea';
      const tagEsc = escapeHtml(t.tag);
      return '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-tertiary);border-radius:8px;">' +
        '<span style="width:12px;height:12px;border-radius:50%;background:' + color + ';flex-shrink:0;"></span>' +
        '<span style="flex:1;font-size:13px;">' + tagEsc + '</span>' +
        '<span style="font-size:11px;color:var(--text-muted);">' + t.count + '个</span>' +
        '<button class="btn btn-sm" style="font-size:11px;padding:4px 8px;" onclick="renameTag(\'' + tagEsc + '\')">重命名</button>' +
        '<button class="btn btn-sm btn-danger" style="font-size:11px;padding:4px 8px;" onclick="deleteTag(\'' + tagEsc + '\')">删除</button>' +
      '</div>';
    }).join('');
  }
  document.getElementById('tagManagerModal').classList.add('show');
}

function closeTagManager() {
  document.getElementById('tagManagerModal').classList.remove('show');
}

async function renameTag(oldTag) {
  const newTag = prompt('将标签 "' + oldTag + '" 重命名为：', oldTag);
  if (!newTag || newTag === oldTag) return;
  const res = await fetch(API + '/api/tags/rename/' + encodeURIComponent(oldTag), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
    body: JSON.stringify({ newTag })
  });
  const data = await res.json();
  if (data.success) {
    showToast('已重命名，更新了 ' + data.updated + ' 个文件');
    showTagManager();
    loadFiles();
  } else {
    showToast('重命名失败');
  }
}

async function deleteTag(tag) {
  if (!confirm('确定删除标签 "' + tag + '"？将从所有文件中移除。')) return;
  const res = await fetch(API + '/api/tags/delete/' + encodeURIComponent(tag), {
    method: 'DELETE',
    headers: { 'x-auth-token': AUTH_TOKEN || '' }
  });
  const data = await res.json();
  if (data.success) {
    showToast('已删除，从 ' + data.updated + ' 个文件中移除');
    showTagManager();
    loadFiles();
  } else {
    showToast('删除失败');
  }
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
let suggestDebounce = null;
document.getElementById('searchInput').addEventListener('input', () => {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(doSearch, 400);
  // 搜索自动补全
  const q = document.getElementById('searchInput').value.trim();
  if (suggestDebounce) clearTimeout(suggestDebounce);
  if (q.length < 1) { hideSuggestions(); return; }
  suggestDebounce = setTimeout(() => fetchSuggestions(q), 200);
});

async function fetchSuggestions(q) {
  try {
    const res = await fetch(API + '/api/search/suggest?q=' + encodeURIComponent(q), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success && data.suggestions.length > 0) {
      renderSuggestions(data.suggestions);
    } else {
      hideSuggestions();
    }
  } catch (e) { hideSuggestions(); }
}

function renderSuggestions(suggestions) {
  const container = document.getElementById('searchSuggestions');
  container.innerHTML = suggestions.map(s => {
    const tagStyle = s.color ? 'background:rgba(' + hexToRgb(s.color) + ',0.2);color:' + s.color + ';' : 'background:rgba(102,126,234,0.2);color:#667eea;';
    const tagLabel = s.type === 'tag' ? '<span class="suggestion-tag" style="' + tagStyle + '">tag</span>' : '';
    return '<div class="search-suggestion" onclick="applySuggestion(\'' + escapeHtml(s.text).replace(/'/g, "\\'") + '\', \'' + s.type + '\')">' +
      '<span class="suggestion-icon">' + escapeHtml(s.icon || '') + '</span>' +
      '<span>' + escapeHtml(s.text) + '</span>' +
      tagLabel +
      '</div>';
  }).join('');
  container.style.display = 'block';
}

function hideSuggestions() {
  document.getElementById('searchSuggestions').style.display = 'none';
}

function applySuggestion(text, type) {
  document.getElementById('searchInput').value = type === 'tag' ? 'tag:' + text : text;
  hideSuggestions();
  doSearch();
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return r + ',' + g + ',' + b;
}

// 点击其他区域关闭建议
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrapper')) hideSuggestions();
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
  document.getElementById('themeToggle').textContent = next === 'light' ? '☀️' : '🌙';
  // 更新 theme-color meta
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.content = next === 'light' ? '#667eea' : '#0f172a';
}

function initTheme() {
  const saved = localStorage.getItem('shareTool_theme');
  const theme = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeToggle').textContent = theme === 'light' ? '☀️' : '🌙';
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.content = theme === 'light' ? '#667eea' : '#0f172a';
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

  // 恢复视图模式
  applyView(currentView);
  
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

  // Load HTTPS status + token display
  if (document.getElementById('currentTokenDisplay')) {
    document.getElementById('currentTokenDisplay').textContent = AUTH_TOKEN || '(无)';
  }
  if (document.getElementById('httpsStatus')) {
    fetch(API + '/api/https/cert', { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
      .then(r => r.json())
      .then(data => {
        const el = document.getElementById('httpsStatus');
        if (el) {
          if (data.https) {
            el.innerHTML = '<span style="color:#4ade80">✅ HTTPS 已启用</span> <span style="color:var(--text-muted)">到期: ' + (data.expires || '未知') + '</span>';
          } else {
            el.innerHTML = '<span style="color:#f59e0b">⚠️ HTTPS 未启用</span> <span style="color:var(--text-muted)">局域网可跳过</span>';
          }
        }
      }).catch(() => {
        const el = document.getElementById('httpsStatus');
        if (el) el.textContent = '检测失败';
      });
  }
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
    '<span class="recent-search-tag" onclick="document.getElementById(\'searchInput\').value=\'' + escapeHtml(s).replace(/'/g, "\\'") + '\';doSearch()">' + escapeHtml(s) + '</span>'
  ).join('') + '<span class="recent-search-tag" style="color:#dc2626" onclick="clearRecentSearches()">✕清除</span>';
}

function clearRecentSearches() {
  try { localStorage.setItem('sharetool_recent_searches', '[]'); } catch (e) {}
  renderRecentSearches();
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


// ============================================================
// HTML Page Handler
// ============================================================
function sendHtml(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML_PAGE);
}

// ============================================================
// Server-side utilities (shared with route modules)
// ============================================================
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

const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','svg','bmp','ico']);
const AUDIO_EXTS = new Set(['mp3','wav','ogg','aac','flac','m4a','wma','opus']);
const VIDEO_EXTS = new Set(['mp4','webm','avi','mov','mkv','flv','wmv','m4v','mpeg','mpg']);
const PDF_EXTS = new Set(['pdf']);

function isImageFile(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return IMAGE_EXTS.has(ext);
}
function isAudioFile(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return AUDIO_EXTS.has(ext);
}
function isVideoFile(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return VIDEO_EXTS.has(ext);
}
function isPdfFile(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return PDF_EXTS.has(ext);
}


// ============================================================
// 启动
// ============================================================
// Graceful shutdown helper
function gracefulShutdown(code = 0) {
  logger.info('[ShareTool] Shutting down gracefully...');
  if (broadcastTimer) clearInterval(broadcastTimer);
  if (wsServer) wsServer.close();
  if (udpServer) udpServer.close();
  if (httpServer) httpServer.close();
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => gracefulShutdown(0));
process.on('SIGTERM', () => gracefulShutdown(0));

process.on('uncaughtException', (e) => {
  logger.fatal({ err: e }, 'Uncaught exception - shutting down');
  gracefulShutdown(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason: String(reason) }, 'Unhandled Promise rejection');
});

init();
