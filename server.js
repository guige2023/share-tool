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

// 内部模块
const db = require('./db');

// WebSocket 服务器
const { WebSocketServer } = require('ws');
// UDP 设备发现
const dgram = require('dgram');

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

// Token 配置
const STATIC_TOKEN = process.env.SHARE_TOKEN || '35e7438f1e72356ebc6d4e839881cc35233ee01ec81d5af6';
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
// 工具函数
// ============================================================
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = { ...{ downloadDir: path.join(os.homedir(), 'Downloads', 'ShareTool'), lastSync: null, deviceId: DEVICE_ID }, ...loaded };
    } else {
      config = { downloadDir: path.join(os.homedir(), 'Downloads', 'ShareTool'), lastSync: null, deviceId: DEVICE_ID };
    }
  } catch (e) {
    config = { downloadDir: path.join(os.homedir(), 'Downloads', 'ShareTool'), lastSync: null, deviceId: DEVICE_ID };
  }
  if (!config.deviceId) config.deviceId = DEVICE_ID;
}

function saveConfig() {
  try {
    const cfgDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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
  
  // 优先验证动态 Token
  const dynamicToken = db.validateToken(token);
  if (dynamicToken) return dynamicToken;
  
  // 降级验证静态 Token
  if (token === STATIC_TOKEN) return { token: STATIC_TOKEN, isStatic: true };
  return null;
}

function authRequired(req, res) {
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
function init() {
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
  startHttpServer();
  
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
// HTTP/HTTPS 服务器
// ============================================================
function startHttpServer() {
  const serverOptions = {
    key: null,
    cert: null,
    https: false
  };

  // 尝试加载 SSL 证书
  const certPath = path.join(SSL_DIR, 'cert.pem');
  const keyPath = path.join(SSL_DIR, 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    serverOptions.key = fs.readFileSync(keyPath);
    serverOptions.cert = fs.readFileSync(certPath);
    serverOptions.https = true;
  }

  const requestHandler = async (req, res) => {
    setCors(res);
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const query = parsed.query;

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
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { filename, content, type, tags } = JSON.parse(body);
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
      
      // 审计 API
      if (pathname === '/api/audit/logs') {
        const authData = authRequired(req, res);
        if (!authData) return;
        const logs = db.listAuditLogs(100, 0);
        const stats = db.getAuditStats();
        sendJson(res, { success: true, logs, stats });
        return;
      }
      
      // 静态文件下载
      if (pathname.startsWith('/download/')) {
        const filename = decodeURIComponent(pathname.slice('/download/'.length));
        const file = db.getFileByName(filename);
        if (file) {
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
  
  // 每小时清理一次过期 Token
  setInterval(() => {
    db.cleanupExpiredTokens();
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
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
.container { max-width: 900px; margin: 0 auto; padding: 24px; }
header { text-align: center; margin-bottom: 32px; }
h1 { font-size: 32px; font-weight: 700; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 8px; }
.subtitle { color: #64748b; font-size: 14px; }
.status-bar { display: flex; gap: 16px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
.status-item { font-size: 12px; padding: 4px 12px; background: #1e293b; border-radius: 20px; border: 1px solid #334155; }
.status-item.connected { border-color: #22c55e; color: #4ade80; }
.status-item.disconnected { border-color: #64748b; color: #64748b; }
.hero { background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px; padding: 24px; margin-bottom: 24px; border: 1px solid #334155; }
.hero-content { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
.hero-text { flex: 1; min-width: 200px; }
.hero-title { font-size: 18px; font-weight: 600; color: #e2e8f0; margin-bottom: 12px; }
.hero-desc { font-size: 13px; color: #94a3b8; line-height: 1.6; margin-bottom: 8px; }
.hero-features { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.hero-feature { background: rgba(102, 126, 234, 0.15); padding: 4px 10px; border-radius: 20px; font-size: 11px; color: #667eea; }
.card { background: #1e293b; border-radius: 16px; padding: 24px; margin-bottom: 20px; border: 1px solid #334155; }
.section-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #94a3b8; display: flex; align-items: center; gap: 8px; }
.section-title::before { content: ''; width: 4px; height: 16px; background: linear-gradient(180deg, #667eea, #764ba2); border-radius: 2px; }
textarea { width: 100%; padding: 14px; background: #0f172a; border: 1px solid #334155; border-radius: 10px; color: #e2e8f0; font-size: 14px; margin-bottom: 12px; resize: vertical; min-height: 100px; font-family: inherit; }
textarea:focus { outline: none; border-color: #667eea; }
input[type="text"], input[type="search"] { width: 100%; padding: 12px 14px; background: #0f172a; border: 1px solid #334155; border-radius: 10px; color: #e2e8f0; font-size: 14px; margin-bottom: 12px; }
input:focus { outline: none; border-color: #667eea; }
.btn { padding: 12px 20px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; border-radius: 10px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; }
.btn:hover { opacity: 0.9; transform: translateY(-1px); }
.btn:active { transform: translateY(0); }
.btn-secondary { background: #334155; }
.btn-danger { background: #dc2626; }
.btn-warning { background: #d97706; }
.btn-sm { padding: 8px 14px; font-size: 13px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; }
.file-upload-area { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; background: #0f172a; border: 2px dashed #334155; border-radius: 12px; cursor: pointer; transition: all 0.2s; text-align: center; }
.file-upload-area:hover { border-color: #667eea; background: #1a2744; }
.file-upload-area input { position: absolute; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.file-upload-area .icon { font-size: 40px; margin-bottom: 12px; }
.file-upload-area .text { color: #64748b; font-size: 14px; }
.file-upload-area .hint { color: #475569; font-size: 12px; margin-top: 8px; }
.file-list { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.file-item { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px; background: #0f172a; border-radius: 10px; border: 1px solid #334155; gap: 12px; }
.file-item:hover { border-color: #475569; }
.file-content { flex: 1; min-width: 0; }
.file-preview { background: #1e293b; border-radius: 8px; padding: 12px; margin-top: 8px; max-height: 150px; overflow: auto; white-space: pre-wrap; font-size: 12px; color: #94a3b8; border: 1px solid #334155; word-break: break-all; display: none; }
.file-preview.show { display: block; }
.file-name { font-weight: 500; color: #e2e8f0; word-break: break-all; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.file-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.file-tag { font-size: 10px; padding: 2px 6px; background: rgba(102,126,234,0.2); color: #667eea; border-radius: 4px; }
.file-meta { font-size: 12px; color: #64748b; margin-top: 4px; }
.file-actions { display: flex; gap: 8px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.empty { text-align: center; padding: 30px; color: #64748b; }
.alert { padding: 12px 16px; border-radius: 10px; margin-bottom: 16px; font-size: 14px; display: none; }
.alert-success { background: rgba(34, 197, 94, 0.15); border: 1px solid #22c55e; color: #4ade80; }
.alert-error { background: rgba(220, 38, 38, 0.15); border: 1px solid #dc2626; color: #f87171; }
.alert-info { background: rgba(59, 130, 246, 0.15); border: 1px solid #3b82f6; color: #60a5fa; }
.alert.show { display: block; }
.code-box { background: #0f172a; padding: 14px; border-radius: 10px; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; color: #4ade80; margin: 8px 0; overflow-x: auto; border: 1px solid #334155; white-space: pre-wrap; word-break: break-all; }
.progress-bar { width: 100%; height: 8px; background: #334155; border-radius: 4px; overflow: hidden; margin-top: 8px; }
.progress-bar .fill { height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); transition: width 0.3s; }
.batch-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.setting-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.setting-row label { color: #94a3b8; font-size: 14px; min-width: 80px; }
.setting-row input { flex: 1; margin-bottom: 0; }
.device-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.device-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: #0f172a; border-radius: 8px; border: 1px solid #334155; font-size: 13px; }
.device-item .indicator { width: 8px; height: 8px; border-radius: 50%; background: #64748b; }
.device-item .indicator.online { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
.device-item .name { flex: 1; color: #e2e8f0; }
.device-item .ip { color: #64748b; font-family: monospace; }
.search-bar { display: flex; gap: 8px; margin-bottom: 16px; }
.search-bar input { flex: 1; margin-bottom: 0; }
.filter-tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.filter-tab { padding: 6px 14px; background: #0f172a; border: 1px solid #334155; border-radius: 20px; font-size: 12px; color: #64748b; cursor: pointer; transition: all 0.2s; }
.filter-tab:hover { border-color: #667eea; }
.filter-tab.active { background: rgba(102,126,234,0.2); border-color: #667eea; color: #667eea; }
.tab-bar { display: flex; gap: 4px; margin-bottom: 16px; background: #0f172a; padding: 4px; border-radius: 10px; }
.tab-item { flex: 1; padding: 10px; text-align: center; font-size: 14px; color: #64748b; border-radius: 8px; cursor: pointer; transition: all 0.2s; }
.tab-item:hover { color: #e2e8f0; }
.tab-item.active { background: #1e293b; color: #667eea; font-weight: 500; }
@media (max-width: 500px) {
  .container { padding: 16px; }
  .actions { flex-direction: column; }
  .btn { width: 100%; text-align: center; }
  .file-actions { justify-content: flex-start; }
  .setting-row { flex-direction: column; align-items: stretch; }
  .setting-row label { min-width: auto; }
  .hero-content { flex-direction: column; }
  .hero-url { flex-direction: column; }
  .status-bar { flex-direction: column; align-items: center; }
}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>ShareTool</h1>
    <p class="subtitle">局域网文件/文字分享</p>
    <div class="status-bar">
      <span class="status-item disconnected" id="wsStatus">WS 未连接</span>
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
    <div class="actions">
      <button class="btn" id="shareTextBtn">分享</button>
      <button class="btn btn-secondary" id="clearTextBtn">清空</button>
    </div>
  </div>

  <div class="card">
    <div class="section-title">上传文件</div>
    <div id="uploadAlert" class="alert"></div>
    <label class="file-upload-area">
      <input type="file" id="fileInput" multiple>
      <div class="icon">📁</div>
      <div class="text">点击或拖拽文件到此处</div>
      <div class="hint">保持原文件名上传</div>
    </label>
    <div id="uploadList" class="file-list"></div>
  </div>

  <div class="card">
    <div class="section-title">最近分享</div>
    <div id="listAlert" class="alert"></div>
    <div class="search-bar">
      <input type="search" id="searchInput" placeholder="搜索文件名或内容...">
      <button class="btn btn-sm" onclick="doSearch()">搜索</button>
    </div>
    <div class="filter-tabs">
      <span class="filter-tab active" data-filter="all">全部</span>
      <span class="filter-tab" data-filter="text">文字</span>
      <span class="filter-tab" data-filter="file">文件</span>
    </div>
    <div class="batch-actions">
      <button class="btn btn-sm btn-warning" onclick="deleteOld(7)">删除1周前</button>
      <button class="btn btn-sm btn-warning" onclick="deleteOld(30)">删除1月前</button>
      <button class="btn btn-sm btn-danger" onclick="deleteAll()">删除所有</button>
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
      <div class="empty">暂无分享内容</div>
    </div>
  </div>

  <div class="card">
    <div class="section-title">同步设备</div>
    <div class="device-list" id="deviceList">
      <div class="empty">正在发现设备...</div>
    </div>
  </div>
</div>

<script>
const API = '';
const STATIC_TOKEN = '${STATIC_TOKEN.substring(0, 8)}***';
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
    container.innerHTML = '<div class="empty">暂无在线设备</div>';
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
    const res = await fetch(API + '/api/list');
    const data = await res.json();
    currentFiles = data.files || [];
    renderFiles();
  } catch (e) {
    console.error('Load files failed:', e);
  }
}

function renderFiles() {
  const container = document.getElementById('filesContainer');
  
  let files = currentFiles;
  if (currentFilter !== 'all') {
    files = files.filter(f => f.type === currentFilter);
  }
  
  if (!files.length) {
    container.innerHTML = '<div class="empty">暂无分享内容</div>';
    return;
  }

  container.innerHTML = '<div class="file-list">' + files.map(f => {
    const isText = f.type === 'text';
    const previewId = 'preview-' + btoaSafe(f.name).substring(0, 20);
    const tags = f.tags ? f.tags.split(',').filter(t => t.trim()) : [];
    
    return '<div class="file-item">' +
      '<div class="file-content">' +
        '<div class="file-name">' + escapeHtml(f.name) + '</div>' +
        (tags.length ? '<div class="file-tags">' + tags.map(t => '<span class="file-tag">' + escapeHtml(t) + '</span>').join('') + '</div>' : '') +
        '<div class="file-meta">' + formatSize(f.size) + ' | ' + formatTime(f.time) + '</div>' +
        (isText ? '<div class="file-preview" id="' + previewId + '"></div>' : '') +
      '</div>' +
      '<div class="file-actions">' +
        (isText ? '<button class="btn btn-sm" onclick="togglePreview(\'' + encodeURIComponent(f.name) + '\', \'' + previewId + '\')">预览</button>' : '') +
        '<button class="btn btn-sm" onclick="copyContent(\'' + encodeURIComponent(f.name) + '\')">复制</button>' +
        '<button class="btn btn-sm" onclick="downloadFile(\'' + encodeURIComponent(f.name) + '\')">下载</button>' +
        '<button class="btn btn-sm btn-danger" onclick="deleteFile(\'' + encodeURIComponent(f.name) + '\')">删除</button>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';

  // 加载文本预览
  for (const f of files) {
    if (f.type === 'text' && f.size < 50000) {
      loadPreview(f.name, 'preview-' + btoaSafe(f.name).substring(0, 20));
    }
  }
}

async function loadPreview(filename, previewId) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename));
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

function doSearch() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) {
    loadFiles();
    return;
  }
  
  fetch(API + '/api/search?q=' + encodeURIComponent(q))
    .then(r => r.json())
    .then(data => {
      currentFiles = data.files || [];
      renderFiles();
    })
    .catch(e => showAlert('listAlert', '搜索失败', 'error'));
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
    showAlert('textAlert', '请输入内容', 'error');
    return;
  }
  const filename = 'share_' + Date.now() + '.txt';
  try {
    const res = await fetch(API + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, content, type: 'text' })
    });
    const data = await res.json();
    if (data.success) {
      showAlert('textAlert', '分享成功！', 'success');
      document.getElementById('textContent').value = '';
      loadFiles();
      broadcastWs({ type: 'file_create', payload: { filename, content, type: 'text' } });
    } else {
      showAlert('textAlert', '失败: ' + data.error, 'error');
    }
  } catch (e) {
    showAlert('textAlert', '失败: ' + e.message, 'error');
  }
}

// 文件上传
document.getElementById('fileInput').addEventListener('change', (e) => {
  uploadFiles(e.target.files);
});

async function uploadFiles(files) {
  for (const file of files) {
    showAlert('uploadAlert', '上传中: ' + file.name, 'info');
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result.split(',')[1];
      try {
        const res = await fetch(API + '/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, content: base64, type: 'file' })
        });
        const data = await res.json();
        if (data.success) {
          showAlert('uploadAlert', '上传成功: ' + file.name, 'success');
          loadFiles();
          broadcastWs({ type: 'file_create', payload: { filename: file.name, hash: data.hash } });
        } else {
          showAlert('uploadAlert', '失败: ' + data.error, 'error');
        }
      } catch (e) {
        showAlert('uploadAlert', '失败: ' + e.message, 'error');
      }
    };
    reader.readAsDataURL(file);
  }
}

async function copyContent(filename) {
  try {
    const res = await fetch(API + '/api/content/' + filename);
    const data = await res.json();
    if (data.content) {
      const textarea = document.createElement('textarea');
      textarea.value = data.content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); showAlert('listAlert', '内容已复制', 'success'); }
      catch (e) { prompt('复制内容:', data.content); }
      document.body.removeChild(textarea);
    }
  } catch (e) { showAlert('listAlert', '复制失败: ' + e.message, 'error'); }
}

function downloadFile(filename) {
  window.open(API + '/download/' + filename, '_blank');
}

async function deleteFile(filename) {
  if (!confirm('确定删除?')) return;
  try {
    const res = await fetch(API + '/api/file/' + filename + '?filename=' + encodeURIComponent(filename), { method: 'DELETE' });
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
    const res = await fetch(API + '/api/delete-old?days=' + days, { method: 'DELETE' });
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
    const res = await fetch(API + '/api/delete-all', { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showAlert('listAlert', '已删除 ' + data.deleted + ' 个文件', 'success');
      loadFiles();
    } else {
      showAlert('listAlert', '删除失败', 'error');
    }
  } catch (e) { showAlert('listAlert', '删除失败: ' + e.message, 'error'); }
}

function saveDownloadDir() {
  const dir = document.getElementById('downloadDir').value.trim();
  localStorage.setItem('shareTool_downloadDir', dir);
  config.downloadDir = dir;
  showAlert('listAlert', '下载目录已保存（仅本机有效）', 'success');
}

// 搜索回车
document.getElementById('searchInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') doSearch();
});

function broadcastWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// 初始化
async function init() {
  // 加载配置
  const localDownloadDir = localStorage.getItem('shareTool_downloadDir') || '';
  document.getElementById('downloadDir').value = localDownloadDir;
  
  // 加载文件列表
  await loadFiles();
  
  // 连接 WebSocket
  connectWS();
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
