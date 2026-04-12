#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const readline = require('readline');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.share-tool', 'config.json');
const HISTORY_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.share-tool', 'history');
const MANIFEST_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.share-tool', 'sync-manifest.json');
const SYNC_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.share-tool', 'sync-files');
const DEFAULT_URL = 'http://localhost:18790';
const CHUNK_SIZE = 512 * 1024; // 512KB per chunk
const MAX_HISTORY = 500;

// CLI internationalization (English by default, zh-CN if LANG matches)
const CLI_I18N = (() => {
  const lang = (process.env.LANG || '').toLowerCase();
  const isZh = lang.includes('zh');
  return {
    resume:          isZh ? '断点续传' : 'Resuming',
    uploadStart:     isZh ? '开始上传' : 'Uploading',
    chunkUploaded:   isZh ? '个分片' : ' chunks',
    chunkFailed:     isZh ? '分片' : 'Chunk',
    uploadFailed:    isZh ? '上传失败' : 'Upload failed',
    completeFailed:  isZh ? '完成上传失败' : 'Failed to complete upload',
  };
})();

// WebSocket sync client for multi-device real-time sync
let wsClient = null;
let lastSyncTs = 0;
let deviceId = null;

function getDeviceId() {
  if (!deviceId) {
    const config = getConfig();
    deviceId = config.deviceId || crypto.randomUUID();
    saveConfig({ deviceId });
  }
  return deviceId;
}

function createWsUrl() {
  const serverUrl = getServerUrl();
  const u = new URL(serverUrl);
  const wsProtocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${u.host}/ws`;
}

function connectSyncWs() {
  return new Promise((resolve, reject) => {
    const { WebSocket } = require('ws');
    const wsUrl = createWsUrl();
    const token = getToken();
    
    wsClient = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`, {
      rejectUnauthorized: false  // Allow self-signed HTTPS certs
    });
    
    wsClient.on('open', () => {
      // Register this device
      const devId = getDeviceId();
      const hostname = require('os').hostname();
      wsClient.send(JSON.stringify({
        type: 'register',
        payload: { deviceId: devId, deviceName: hostname }
      }));
    });

    wsClient.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleWsMessage(msg);
      } catch (e) {
        // ignore
      }
    });

    wsClient.on('close', () => {
      wsClient = null;
      // Reconnect after 5s
      setTimeout(() => { connectSyncWs(); }, 5000);
    });

    wsClient.on('error', (err) => {
      wsClient = null;
    });

    // Resolve after registration ack
    // Use 'on' instead of 'once' because broadcastDeviceList sends device_list
    // to this client before register_ack, which would prematurely satisfy 'once'
    let resolved = false;
    wsClient.on('message', function handler(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'register_ack') {
          if (resolved) return;
          resolved = true;
          wsClient.removeListener('message', handler);
          if (msg.success) {
            resolve(msg);
          } else {
            reject(new Error('WS registration failed'));
          }
        }
        // All other messages (device_list, etc.) handled by handleWsMessage below
      } catch (e) {
        // ignore non-JSON messages
      }
    });

    setTimeout(() => {
      if (!resolved) {
        wsClient.removeListener('message', handler);
        reject(new Error('WS connect timeout'));
      }
    }, 10000);
  });
}

function handleWsMessage(msg) {
  const { type, payload } = msg;
  switch (type) {
    case 'file_create':
    case 'file_update':
    case 'file_delete':
    case 'file_rename':
      // Update local DB state
      // For CLI, just update lastSyncTs
      lastSyncTs = Math.floor(Date.now() / 1000);
      break;
    case 'device_list':
      // Could display online devices
      break;
    case 'sync_response':
      if (payload && payload.logs) {
        lastSyncTs = Math.floor(Date.now() / 1000);
      }
      break;
  }
}

async function syncPush(changes) {
  if (!wsClient || wsClient.readyState !== 1) {
    await connectSyncWs();
  }
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const replyHandler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'sync_ack') {
          clearTimeout(pushTimeout);
          wsClient.removeListener('message', replyHandler);
          resolve(msg);
        }
      } catch (e) {}
    };
    wsClient.on('message', replyHandler);
    wsClient.send(JSON.stringify({ type: 'sync_push', payload: { changes } }));
    const pushTimeout = setTimeout(() => {
      if (wsClient) wsClient.removeListener('message', replyHandler);
      reject(new Error('sync_push timeout'));
    }, 10000);
  });
}

async function syncPull() {
  if (!wsClient || wsClient.readyState !== 1) {
    await connectSyncWs();
  }
  return new Promise((resolve, reject) => {
    const replyHandler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'sync_response') {
          clearTimeout(syncTimeout);
          wsClient.removeListener('message', replyHandler);
          // Mark received logs as synced via REST API
          if (msg.payload && msg.payload.logs && msg.payload.logs.length > 0) {
            const ids = msg.payload.logs.map(l => l.id).filter(Boolean);
            if (ids.length > 0) {
              // Fire-and-forget: mark as synced in background
              request('POST', '/api/sync/mark', {
                body: JSON.stringify({ ids }),
                contentType: 'application/json'
              }).catch(() => {});
            }
          }
          resolve(msg);
        }
      } catch (e) {}
    };
    wsClient.on('message', replyHandler);
    wsClient.send(JSON.stringify({ type: 'sync_request', payload: { since: lastSyncTs } }));
    const syncTimeout = setTimeout(() => {
      if (wsClient) wsClient.removeListener('message', replyHandler);
      reject(new Error('sync_request timeout'));
    }, 10000);
  });
}

function disconnectSyncWs() {
  if (wsClient) {
    wsClient.terminate();
    wsClient = null;
  }
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    // ignore
  }
  return {};
}

function saveConfig(updates) {
  const config = getConfig();
  const merged = { ...config, ...updates };
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// ============================================================
// Sync manifest: local file snapshot for incremental sync
// ============================================================
function loadManifest() {
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      const data = fs.readFileSync(MANIFEST_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {}
  return { version: 1, files: {}, lastSync: 0 };
}

function saveManifest(manifest) {
  const dir = path.dirname(MANIFEST_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

// Build manifest from server file list
async function buildManifestFromServer() {
  const res = await request('GET', '/api/list?limit=10000');
  if (res.status >= 400 || !res.data || !res.data.files) return null;
  const manifest = { version: 1, files: {}, lastSync: Math.floor(Date.now() / 1000) };
  for (const f of res.data.files) {
    manifest.files[f.name] = { hash: f.hash, size: f.size, updatedAt: f.updatedAt };
  }
  return manifest;
}

// Apply incoming change to local manifest and download file
async function applyRemoteChange(log, onEvent) {
  const { action, filename, content, hash } = log;
  if (!filename) {
    onEvent(`Skipped: ${action} — no filename in log`);
    return;
  }
  switch (action) {
    case 'create':
    case 'update': {
      if (content !== undefined) {
        const filePath = path.join(SYNC_DIR, filename);
        const parentDir = path.dirname(filePath);
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
        if (typeof content === 'string') {
          fs.writeFileSync(filePath, content, 'utf8');
        } else {
          fs.writeFileSync(filePath, Buffer.from(content));
        }
        onEvent(`Downloaded: ${filename}`);
      } else {
        // No content in log — download from server
        try {
          const res = await request('GET', '/api/content/' + encodeURIComponent(filename));
          if (res.status === 200 && res.data && res.data.content !== undefined) {
            const filePath = path.join(SYNC_DIR, filename);
            const parentDir = path.dirname(filePath);
            if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
            if (typeof res.data.content === 'string') {
              fs.writeFileSync(filePath, res.data.content, 'utf8');
            } else {
              fs.writeFileSync(filePath, Buffer.from(res.data.content));
            }
            onEvent(`Downloaded: ${filename}`);
          }
        } catch (e) {
          onEvent(`Failed to download ${filename}: ${e.message}`);
        }
      }
      break;
    }
    case 'delete': {
      const filePath = path.join(SYNC_DIR, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        onEvent(`Deleted: ${filename}`);
      }
      break;
    }
    case 'rename': {
      const { oldFilename, newFilename } = log;
      const oldPath = path.join(SYNC_DIR, oldFilename);
      const newPath = path.join(SYNC_DIR, newFilename);
      if (fs.existsSync(oldPath)) {
        const parentDir = path.dirname(newPath);
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
        fs.renameSync(oldPath, newPath);
        onEvent(`Renamed: ${oldFilename} → ${newFilename}`);
      }
      break;
    }
  }
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const data = fs.readFileSync(HISTORY_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {}
  return [];
}

function saveHistory(history) {
  const dir = path.dirname(HISTORY_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
}

function addHistory(cmd) {
  const history = loadHistory();
  // Deduplicate: remove if already exists
  const filtered = history.filter(h => h.cmd !== cmd);
  filtered.unshift({ cmd, ts: Date.now() });
  // Keep max
  if (filtered.length > MAX_HISTORY) filtered.length = MAX_HISTORY;
  saveHistory(filtered);
}

function getHistory() {
  return loadHistory();
}

function getServerUrl() {
  return process.env.SHARE_TOOL_URL || DEFAULT_URL;
}

function getToken() {
  const config = getConfig();
  return config.shareToken || config.token || '';
}

function parseUrl(serverUrl, endpoint) {
  const parsed = new URL(endpoint, serverUrl);
  return parsed;
}

function request(method, endpoint, options = {}) {
  return new Promise(async (resolve, reject) => {
    const serverUrl = getServerUrl();
    const parsedUrl = parseUrl(serverUrl, endpoint);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    let token = getToken();

    const doReq = () => {
      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method,
        headers: {
          'Content-Type': options.contentType || 'application/json'
        }
      };

      if (token) {
        reqOptions.headers['x-auth-token'] = token;
      }

      const req = client.request(reqOptions, async (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', async () => {
          try {
            const json = JSON.parse(data);
            // Auto-refresh on 401 (once)
            if (res.statusCode === 401 && !options._retried) {
              const config = getConfig();
              const rt = config.refreshToken;
              if (rt) {
                try {
                  const refreshRes = await new Promise((resolv, rej) => {
                    const r = http.request({
                      hostname: 'localhost', port: 18790,
                      path: '/api/auth/refresh', method: 'POST',
                      headers: { 'Content-Type': 'application/json' }
                    }, (resp) => {
                      let d = '';
                      resp.on('data', c => d += c);
                      resp.on('end', () => resolv({ status: resp.statusCode, data: JSON.parse(d) }));
                    }).on('error', rej);
                    r.end(JSON.stringify({ refreshToken: rt }));
                  });
                  if (refreshRes.data.success) {
                    saveConfig({ ...config, token: refreshRes.data.token, refreshToken: refreshRes.data.refreshToken });
                    token = refreshRes.data.token;
                    options._retried = true;
                    doReq();
                    return;
                  }
                } catch (e) { /* refresh failed */ }
              }
            }
            resolve({ status: res.statusCode, data: json });
          } catch (e) {
            resolve({ status: res.statusCode, data: data });
          }
        });
      });

      req.on('error', reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    };

    doReq();
  });
}

// 上传单个文件（自动分片 + 断点续传）
async function uploadFile(filePath) {
  const fileName = path.basename(filePath);
  const fileContent = fs.readFileSync(filePath);
  const totalSize = fileContent.length;

  // 1. 检查是否有未完成的上传（断点续传）
  const checkRes = await request('GET', `/api/upload/check/${encodeURIComponent(fileName)}`);
  let uploadId;
  let receivedChunks = [];

  if (checkRes.status === 200 && checkRes.data && checkRes.data.success && checkRes.data.hasIncomplete) {
    // 断点续传
    uploadId = checkRes.data.uploadId;
    receivedChunks = checkRes.data.receivedChunks || [];
    const totalChunks = checkRes.data.totalChunks;
    console.log(`📡 ${CLI_I18N.resume}: ${fileName} (${receivedChunks.length}/${totalChunks}${CLI_I18N.chunkUploaded})`);
  } else {
    // 发起新的分片上传
    const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);
    const initRes = await request('POST', '/api/upload/init', {
      body: JSON.stringify({ filename: fileName, totalChunks: chunkCount, size: totalSize })
    });
    if (initRes.status !== 200 || !initRes.data.success) {
      // 文件较小或 init 失败，回退到普通上传
      return uploadFileSimple(filePath);
    }
    uploadId = initRes.data.uploadId;
    receivedChunks = [];
    console.log(`⬆️  ${CLI_I18N.uploadStart}: ${fileName} (${chunkCount}${CLI_I18N.chunkUploaded})`);
  }

  // 2. 上传缺失的分片
  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
  const BAR_WIDTH = 24;
  const startTime = Date.now();
  let uploadedChunks = receivedChunks.length; // count of chunks already confirmed uploaded

  for (let i = 0; i < totalChunks; i++) {
    if (receivedChunks.includes(i)) continue; // 跳过已上传的

    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalSize);
    const chunkContent = fileContent.slice(start, end).toString('base64');
    uploadedChunks++;

    const uploadedBytes = Math.min(uploadedChunks * CHUNK_SIZE, totalSize);
    const pct = Math.round((uploadedBytes / totalSize) * 100);
    const barFilled = Math.round((pct / 100) * BAR_WIDTH);
    const bar = '█'.repeat(barFilled) + '░'.repeat(BAR_WIDTH - barFilled);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const speed = elapsed > 0 ? formatSize(Math.round(uploadedBytes / elapsed)) + '/s' : '';

    process.stdout.write(`\r  ${fileName}  [${bar}] ${String(pct).padStart(3)}%  ${formatSize(uploadedBytes)}/${formatSize(totalSize)}  ${speed}`);

    const chunkRes = await request('POST', '/api/upload/chunk', {
      body: JSON.stringify({ uploadId, chunkIndex: i, content: chunkContent })
    });

    if (chunkRes.status !== 200 || !chunkRes.data.success) {
      console.log(`\nError: Chunk ${i} upload failed: ${chunkRes.data.error || chunkRes.status}`);
      throw new Error(`${CLI_I18N.chunkFailed} ${i} ${CLI_I18N.uploadFailed}: ${chunkRes.data.error || chunkRes.status}`);
    }
  }
  const finalBar = '█'.repeat(BAR_WIDTH);
  console.log(`\r  ${fileName}  [${finalBar}] 100%  ${formatSize(totalSize)}/${formatSize(totalSize)}`);

  // 3. 完成上传
  const completeRes = await request('POST', '/api/upload/complete', {
    body: JSON.stringify({ uploadId })
  });
  if (completeRes.status !== 200 || !completeRes.data.success) {
    throw new Error(`${CLI_I18N.completeFailed}: ${completeRes.data.error}`);
  }
  return { status: 200, data: completeRes.data };
}

// 简单上传（不分片，用于小文件或 init 失败时）
function uploadFileSimple(filePath) {
  return new Promise((resolve, reject) => {
    const serverUrl = getServerUrl();
    const parsedUrl = parseUrl(serverUrl, '/api/upload');
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const token = getToken();
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);
    const base64Content = fileContent.toString('base64');

    const body = JSON.stringify({
      filename: fileName,
      content: base64Content,
      type: 'file'
    });

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    if (token) {
      reqOptions.headers['x-auth-token'] = token;
    }

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function downloadFile(name, outputDir, onProgress) {
  return new Promise((resolve, reject) => {
    const serverUrl = getServerUrl();
    const parsedUrl = parseUrl(serverUrl, `/download/${encodeURIComponent(name)}`);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const token = getToken();
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {}
    };

    if (token) {
      reqOptions.headers['x-auth-token'] = token;
    }

    const req = client.request(reqOptions, (res) => {
      const contentDisposition = res.headers['content-disposition'];
      let fileName = name;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?(.+)"?/);
        if (match) fileName = match[1];
      }

      const outputPath = outputDir
        ? path.join(outputDir, fileName)
        : path.join(process.cwd(), fileName);

      const writeStream = fs.createWriteStream(outputPath);
      const totalSize = parseInt(res.headers['content-length'], 10);
      let downloaded = 0;

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress && totalSize > 0) {
          onProgress(downloaded, totalSize, fileName);
        }
      });

      res.pipe(writeStream);

      writeStream.on('finish', () => {
        resolve({ status: res.statusCode, data: { saved: outputPath, size: totalSize } });
      });
      writeStream.on('error', reject);
    });

    req.on('error', reject);
    req.end();
  });
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function printError(msg) {
  console.error('Error:', msg);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log('Usage: share-tool <command> [args]');
    console.log('Commands:');
    console.log('  list [-l]      List all files (-l: long format)');
    console.log('  upload <file>  Upload a single file');
    console.log('  upload-dir <dir>  Upload all files in a directory');
    console.log('  batch-upload <file1> [file2] ... [--dir <dir>]  Batch upload multiple files or all files in a directory');
    console.log('  download <name> [-o dir]  Download a file');
    console.log('  delete <name>  Delete a file');
    console.log('  copy <src> <dest>  Copy a file to a new name');
    console.log('  rename <old> <new>  Rename a file');
    console.log('  batch-delete <name1> [name2] ...  Delete multiple files');
    console.log('  batch-download [-c N] [-o <dir>] [--search <pattern>] [name1] [name2] .. Download multiple files');
    console.log('  batch-tag <tag> [files...]        Add tag to files (alias: share-tool batch-tag add <tag> [files])');
    console.log('  batch-tag remove <tag> [files]   Remove tag from files');
    console.log('  batch-tag set <tag> [files]       Set (replace) tag on files');
    console.log('  batch-rename <old1> <new1> [old2 new2...]  Batch rename files');
    console.log('  tags           Show all tags with usage bar chart');
    console.log('  search <query> [-l]  Search files (-l: long format)');
    console.log('  cat <name>     Print file content to stdout');
    console.log('  find <query> [--tag=x] [--type=x] [--limit=n]  Advanced search');
    console.log('  share <text>   Share text snippet');
    console.log('  share-link <file> [--expires=7d] [--max-downloads=n] [--password=x]  Create share link');
    console.log('  sync           Pull changes from server via WebSocket');
    console.log('  sync-watch     Watch for real-time changes (long-lived)');
    console.log('  status         Check if server is online');
    console.log('  open           Open server URL in browser');
    console.log('  serve          Start server in foreground (Ctrl+C to stop)');
    console.log('  log [--limit=n] [--action=x] [--date=YYYY-MM-DD] [-f]  Show audit logs (-f: follow)');
    console.log('  stats          Show storage stats');
    console.log('  recent [n]     Show recently modified files (default: 10)');
    console.log('  trash [list|restore <id>|delete <id>|empty]  Manage trash');
    console.log('  share-list     List all active share links');
    console.log('  share-delete <code>  Delete a share link');
    console.log('  share-extend <code> [hours]  Extend expiry (default 168h)');
    console.log('  share-password <code> [pwd]  Set/remove password');
    console.log('  share-info <code>  Show share link details');
    console.log('  top [n]         Show largest files (default: 10)');
    console.log('  duplicates [delete <id>|keep <id> <file>]  List/delete duplicate files');
    console.log('  diff <filename> [v1] [v2]  Compare file versions');
    console.log('  export [-o dir]  Export all files to local directory');
    console.log('  token          Show current token');
    console.log('  token refresh  Refresh dynamic token via /api/auth/login');
    console.log('  history [--clear]  Show command history');
    console.log('  renew-cert     Force renew HTTPS certificate');
    console.log('  config         Show all config');
    console.log('  config get <key>        Get a config value');
    console.log('  config set <key> <value> Set a config value');
    console.log('  config unset <key>       Remove a config value');
    console.log('  config reset             Reset all config');
    process.exit(1);
  }

  // Record command in history (skip 'history' itself)
  if (command !== 'history') {
    addHistory(process.argv.slice(2).join(' '));
  }

  try {
    switch (command) {
      case 'list': {
        const longFlag = args.includes('-l') || args.includes('--long');
        const res = await request('GET', '/api/list');
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        if (longFlag) {
          const files = res.data.files || [];
          if (files.length === 0) { console.log('No files.'); break; }
          // Calculate column widths
          const nameW = Math.min(Math.max(...files.map(f => (f.name||'').length)) + 2, 40);
          const sizeW = 8;
          const typeW = 6;
          const header = 'NAME'.padEnd(nameW) + 'SIZE'.padStart(sizeW) + '  TYPE    TAGS';
          console.log(header);
          console.log('-'.repeat(nameW + sizeW + 14));
          for (const f of files) {
            const name = (f.name||'').length > nameW - 2 ? (f.name||'').slice(0, nameW-3) + '...' : (f.name||'');
            const size = formatSize(f.size || 0).padStart(sizeW);
            const type = (f.type||'file').slice(0,5).padEnd(6);
            const tags = f.tags || '';
            console.log(name.padEnd(nameW) + size + '  ' + type + ' ' + tags);
          }
          console.log(`\n${files.length} file(s)`);
        } else {
          printJson(res.data);
        }
        break;
      }

      case 'cat': {
        const filename = args[1];
        if (!filename) {
          printError('Usage: share-tool cat <filename>');
          process.exit(1);
        }
        const encoded = encodeURIComponent(filename);
        const res = await request('GET', `/api/files/${encoded}`);
        if (res.status === 404) {
          printError(`File not found: ${filename}`);
          process.exit(1);
        }
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          process.exit(1);
        }
        const file = res.data.file;
        if (!file) {
          printError('Unexpected response format');
          process.exit(1);
        }
        if (file.content !== undefined && file.content !== null) {
          process.stdout.write(String(file.content));
        } else {
          printError(`File has no text content (type: ${file.type || 'unknown'}). Use 'download' command instead.`);
          process.exit(1);
        }
        break;
      }

      case 'upload': {
        const filePath = args[1];
        if (!filePath) {
          printError('File path required');
          process.exit(1);
        }
        if (!fs.existsSync(filePath)) {
          printError(`File not found: ${filePath}`);
          process.exit(1);
        }
        const res = await uploadFile(filePath);
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        printJson(res.data);
        break;
      }

      case 'batch-upload': {
        const files = args.slice(1).filter(a => !a.startsWith('-'));
        const dirFlag = args.includes('--dir');
        if (files.length === 0) {
          printError('Usage: share-tool batch-upload <file1> [file2] ... or share-tool batch-upload <directory> --dir');
          process.exit(1);
        }
        let toUpload = [];
        if (dirFlag && files.length === 1) {
          // Upload all files from a directory (non-recursive)
          const dirPath = files[0];
          if (!fs.existsSync(dirPath)) {
            printError(`Directory not found: ${dirPath}`);
            process.exit(1);
          }
          const entries = fs.readdirSync(dirPath);
          for (const entry of entries) {
            const fullPath = path.join(dirPath, entry);
            const stat = fs.statSync(fullPath);
            if (stat.isFile()) toUpload.push(fullPath);
          }
        } else {
          toUpload = files;
        }
        if (toUpload.length === 0) {
          console.log('No files to upload.');
          process.exit(0);
        }
        let success = 0, failed = 0;
        const totalSize = toUpload.reduce((acc, f) => acc + (fs.statSync(f).size || 0), 0);
        let uploadedBytes = 0;
        const startTime = Date.now();
        const bar = (pct) => {
          const W = 20;
          const filled = Math.round((pct / 100) * W);
          return '█'.repeat(filled) + '░'.repeat(W - filled);
        };
        console.log(`📦 Batch upload: ${toUpload.length} files (${fmtSize(totalSize)} total)`);
        for (let i = 0; i < toUpload.length; i++) {
          const filePath = toUpload[i];
          const fileName = path.basename(filePath);
          const fileSize = fs.statSync(filePath).size;
          process.stdout.write(`\n[${i + 1}/${toUpload.length}] ${fileName} (${fmtSize(fileSize)})...\n`);
          try {
            const res = await uploadFile(filePath);
            if (res.status >= 400) {
              console.log(`  ❌ Failed: ${res.data?.error || res.status}`);
              failed++;
            } else {
              console.log(`  ✅ Done`);
              success++;
            }
            uploadedBytes += fileSize;
          } catch (e) {
            console.log(`  ❌ Error: ${e.message}`);
            failed++;
          }
          const elapsed = (Date.now() - startTime) / 1000;
          const overallPct = totalSize > 0 ? Math.round((uploadedBytes / totalSize) * 100) : 0;
          const speed = elapsed > 0 ? fmtSize(Math.round(uploadedBytes / elapsed)) + '/s' : '';
          process.stdout.write(`  ▌ Overall: [${bar(overallPct)}] ${overallPct}%  ${fmtSize(uploadedBytes)}/${fmtSize(totalSize)}  ${speed}  \n`);
        }
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n📊 Summary: ${success} ✅  ${failed} ❌  (${elapsed}s)`);
        process.exit(failed > 0 ? 1 : 0);
        break;
      }

      case 'download': {
        const name = args[1];
        if (!name) {
          printError('File name required');
          process.exit(1);
        }
        let outputDir;
        const oIndex = args.indexOf('-o');
        if (oIndex !== -1 && args[oIndex + 1]) {
          outputDir = args[oIndex + 1];
        }

        function formatBytes(b) {
          if (b < 1024) return b + ' B';
          if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
          if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
          if (b < 1099511627776) return (b / 1073741824).toFixed(2) + ' GB';
          return (b / 1099511627776).toFixed(2) + ' TB';
        }
        const startTime = Date.now();
        const BAR_W = 24;
        let lastPct = -1;
        const onProgress = (downloaded, total) => {
          const pct = downloaded / total;
          if (Math.floor(pct * 10) > Math.floor(lastPct * 10) || pct >= 1) {
            lastPct = pct;
            const speed = downloaded / ((Date.now() - startTime) / 1000);
            const bar = '█'.repeat(Math.round(pct * BAR_W)) + '░'.repeat(BAR_W - Math.round(pct * BAR_W));
            process.stdout.write('\r[' + bar + '] ' + formatBytes(downloaded) + '/' + formatBytes(total) + ' ' + Math.round(pct * 100) + '% ' + formatBytes(speed) + '/s   \r');
          }
        };

        const res = await downloadFile(name, outputDir, onProgress);
        process.stdout.write('\n');
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log('Downloaded: ' + name + ' (' + formatBytes(res.data.size || 0) + ') in ' + elapsed + 's → ' + res.data.saved);
        break;
      }

      case 'batch-download': {
        const raw = args.slice(1);
        if (raw.length === 0) {
          printError('At least one file name required');
          process.exit(1);
        }

        let concurrency = 1;
        let outputDir = '.';
        let showHelp = false;

        // Parse flags: -o <dir>, -c <N>, --search <pattern>, --help
        const names = [];
        for (let i = 0; i < raw.length; i++) {
          const arg = raw[i];
          if (arg === '-o' && i + 1 < raw.length) { outputDir = raw[++i]; }
          else if (arg === '-c' && i + 1 < raw.length) { concurrency = parseInt(raw[++i], 10) || 1; }
          else if (arg === '--search' && i + 1 < raw.length) {
            // Search server for matching files
            const pattern = raw[++i];
            process.stdout.write('Searching for: ' + pattern + '\n');
            const res = await request('GET', '/api/files?search=' + encodeURIComponent(pattern) + '&limit=100');
            if (res.status >= 400) { printError('Search failed: ' + res.status); process.exit(1); }
            const files = res.data.files || [];
            if (files.length === 0) { console.log('No files found matching: ' + pattern); process.exit(0); }
            for (const f of files) names.push(f.filename);
            console.log('Found ' + files.length + ' file(s)\n');
          }
          else if (arg === '--help') { showHelp = true; }
          else { names.push(arg); }
        }

        if (showHelp || names.length === 0) {
          console.log('Usage: share-tool batch-download [-c N] [-o <dir>] [--search <pattern>] <name1> [name2] ...\n');
          console.log('Options:');
          console.log('  -c N        Concurrent downloads (default: 1, max: 10)');
          console.log('  -o <dir>    Output directory (default: current dir)');
          console.log('  --search    Search for files by pattern, then download all matches');
          console.log('  --help      Show this help');
          process.exit(showHelp ? 0 : 1);
        }

        concurrency = Math.min(Math.max(concurrency, 1), 10);
        console.log('Downloading ' + names.length + ' file(s) to ' + outputDir + '/ (concurrency=' + concurrency + ')\n');
        const cliFs = require('fs');
        if (!cliFs.existsSync(outputDir)) cliFs.mkdirSync(outputDir, { recursive: true });

        // Progress bar helpers
        const BAR_W = 24;
        function renderBar(pct) {
          const filled = Math.round(pct * BAR_W);
          return '[' + '█'.repeat(filled) + '░'.repeat(BAR_W - filled) + ']';
        }
        function formatBytes(b) {
          if (b < 1024) return b + ' B';
          if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
          if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
          if (b < 1099511627776) return (b / 1073741824).toFixed(2) + ' GB';
          return (b / 1099511627776).toFixed(2) + ' TB';
        }

        let success = 0, failed = 0;
        const results = new Array(names.length).fill(null);
        let overallDone = 0;

        // Process in concurrency-sized batches
        for (let batchStart = 0; batchStart < names.length; batchStart += concurrency) {
          const batch = names.slice(batchStart, batchStart + concurrency);
          const batchPromises = batch.map(async (name, idx) => {
            const globalIdx = batchStart + idx;
            const startTime = Date.now();
            let lastPct = -1;

            const progressCallback = (downloaded, total) => {
              const pct = downloaded / total;
              if (Math.floor(pct * 10) > Math.floor(lastPct * 10) || pct >= 1) {
                lastPct = pct;
                const speed = downloaded / ((Date.now() - startTime) / 1000);
                process.stdout.write('\r  [' + name.padEnd(30) + '] ' + renderBar(pct) + ' ' + Math.round(pct * 100) + '% ' + formatBytes(speed) + '/s  ');
              }
            };

            process.stdout.write('  ▼ ' + name + '\n');
            try {
              const res = await downloadFile(name, outputDir, progressCallback);
              if (res.status < 400) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                const size = formatBytes(res.data.size || 0);
                results[globalIdx] = { name, status: 'success', size, elapsed };
                process.stdout.write('\r  ✓ ' + name + ' ' + size + ' in ' + elapsed + 's\n');
              } else {
                results[globalIdx] = { name, status: 'failed', statusCode: res.status };
                process.stdout.write('\r  ✗ ' + name + ' FAILED (' + res.status + ')\n');
              }
            } catch (e) {
              results[globalIdx] = { name, status: 'error', message: e.message };
              process.stdout.write('\r  ✗ ' + name + ' ERROR: ' + e.message + '\n');
            }
          });

          await Promise.all(batchPromises);
          overallDone += batch.length;
        }

        for (const r of results) {
          if (r && r.status === 'success') success++;
          else failed++;
        }
        console.log('\nDone: ' + success + ' succeeded, ' + failed + ' failed');
        process.exit(failed > 0 ? 1 : 0);
        break;
      }

      case 'delete': {
        const name = args[1];
        if (!name) {
          printError('File name required');
          process.exit(1);
        }
        const res = await request('DELETE', `/delete/${encodeURIComponent(name)}`);
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        printJson(res.data);
        break;
      }

      case 'copy': {
        const source = args[1];
        const dest = args[2];
        if (!source || !dest) {
          printError('Usage: copy <sourceFilename> <newFilename>');
          process.exit(1);
        }
        const res = await request('POST', '/api/file-copy', {
          body: JSON.stringify({ sourceFilename: source, newFilename: dest })
        });
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        printJson(res.data);
        break;
      }

      case 'rename': {
        const oldName = args[1];
        const newName = args[2];
        if (!oldName || !newName) {
          printError('Usage: rename <oldFilename> <newFilename>');
          process.exit(1);
        }
        const res = await request('POST', '/api/file-rename/' + encodeURIComponent(oldName), {
          body: JSON.stringify({ newName })
        });
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        printJson(res.data);
        break;
      }

      case 'search': {
        const queryParts = args.slice(1);
        const longFlag = queryParts.includes('-l') || queryParts.includes('--long');
        const cleanQuery = queryParts.filter(a => !a.startsWith('-')).join(' ');
        if (!cleanQuery) {
          printError('Search query required');
          process.exit(1);
        }
        const res = await request('GET', `/api/search?q=${encodeURIComponent(cleanQuery)}`);
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        if (longFlag) {
          const files = res.data.results || res.data.files || res.data || [];
          if (files.length === 0) { console.log('No results.'); break; }
          console.log(`Results for "${cleanQuery}":\n`);
          const nameW = 40;
          for (const f of files) {
            const name = f.filename || f.name || '';
            const size = formatSize(f.size || 0);
            const score = f.score || 0;
            const tags = f.tags || '';
            const truncated = name.length > nameW - 1 ? name.slice(0, nameW-2) + '..' : name;
            console.log(`  ${truncated.padEnd(nameW)} ${size.padStart(8)}  ${tags ? '🏷 ' + tags : ''}`);
          }
          console.log(`\n${files.length} result(s)`);
        } else {
          printJson(res.data);
        }
        break;
      }

      case 'token': {
        const config = getConfig();
        const sub = args[1];
        if (sub === 'refresh') {
          // Token refresh: prefer /api/auth/refresh with stored refresh token,
          // fall back to /api/auth/login with static token if no refresh token
          const refreshToken = config.refreshToken;
          const staticToken = config.shareToken || config.token;

          function doRefresh(refreshTokenToUse, useRefreshEndpoint) {
            const path = useRefreshEndpoint ? '/api/auth/refresh' : '/api/auth/login';
            const body = useRefreshEndpoint
              ? JSON.stringify({ refreshToken: refreshTokenToUse })
              : JSON.stringify({ password: staticToken });
            const req = http.request({
              hostname: 'localhost', port: 18790, path,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(useRefreshEndpoint ? {} : { 'x-auth-token': staticToken }) }
            }, (res) => {
              let data = '';
              res.on('data', d => data += d);
              res.on('end', () => {
                try {
                  const json = JSON.parse(data);
                  if (json.success) {
                    console.log('New dynamic token:', json.token);
                    console.log('Refresh token:', json.refreshToken);
                    console.log('Expires at:', new Date(json.expiresAt * 1000).toLocaleString());
                    saveConfig({ ...config, token: json.token, refreshToken: json.refreshToken });
                    console.log('Config updated.');
                  } else if (!useRefreshEndpoint) {
                    // refresh endpoint failed without fallback, give up
                    console.log('Token refresh failed:', json.error);
                    process.exit(1);
                  } else {
                    // refresh token expired/invalid, fall back to static token login
                    console.log('Refresh token expired, re-authenticating with static token...');
                    doRefresh(null, false);
                  }
                } catch (e) {
                  console.log('Response parse error:', e.message);
                  process.exit(1);
                }
              });
            }).on('error', (e) => {
              console.log('Cannot connect to server:', e.message);
              process.exit(1);
            });
            req.end(body);
          }

          if (!refreshToken && !staticToken) {
            console.log('No token found. Run: share-tool token');
            process.exit(1);
          }
          if (refreshToken) {
            doRefresh(refreshToken, true);
          } else {
            doRefresh(null, false);
          }
          return; // async, don't fall through
        }
        if (config.shareToken || config.token) {
          console.log('Current token:', config.shareToken || config.token);
        } else {
          console.log('No token configured in', CONFIG_PATH);
        }
        break;
      }

      case 'share': {
        const text = args.slice(1).join(' ');
        if (!text) {
          printError('Text required to share');
          process.exit(1);
        }
        // 生成唯一文件名
        const timestamp = Date.now();
        const filename = `text_${timestamp}.txt`;
        // 先上传文本内容
        const uploadRes = await request('POST', '/api/upload', {
          body: JSON.stringify({ filename, content: Buffer.from(text).toString('base64'), type: 'text' }),
          contentType: 'application/json'
        });
        if (uploadRes.status >= 400) {
          printError(`Upload failed: ${uploadRes.status}`);
          printJson(uploadRes.data);
          process.exit(1);
        }
        // 再创建分享链接
        const shareRes = await request('POST', '/api/share/create', {
          body: JSON.stringify({ filename }),
          contentType: 'application/json'
        });
        if (shareRes.status >= 400) {
          printError(`Share failed: ${shareRes.status}`);
          printJson(shareRes.data);
          process.exit(1);
        }
        printJson(shareRes.data);
        break;
      }
      case 'share-link': {
        // share-tool share-link <filename> [--expires=7d] [--max-downloads=10] [--password=<pwd>]
        const filename = args[1];
        if (!filename) {
          printError('Usage: share-tool share-link <filename> [--expires=7d] [--max-downloads=10] [--password=<pwd>]');
          process.exit(1);
        }
        const expiresDays = parseInt(args.find(a => a.startsWith('--expires='))?.split('=')[1]) || 0;
        const maxDownloads = parseInt(args.find(a => a.startsWith('--max-downloads='))?.split('=')[1]) || 0;
        const password = args.find(a => a.startsWith('--password='))?.split('=')[1] || '';
        const body = {};
        if (expiresDays > 0) body.expiryHours = expiresDays * 24;
        if (maxDownloads > 0) body.maxDownloads = maxDownloads;
        if (password) body.password = password;
        const res = await request('POST', '/api/share/create', {
          body: JSON.stringify({ filename, ...body })
        });
        if (res.status >= 400) {
          printError('Failed: ' + (res.data?.error || res.status));
          process.exit(1);
        }
        const d = res.data;
        const url = d.url || (getServerUrl().replace(/\/+$/, '') + '/s/' + d.code);
        console.log('Share link created:');
        console.log('  URL:  ' + url);
        console.log('  Code: ' + d.code);
        if (d.passwordRequired) console.log('  Note: Password required to access');
        if (d.expiresAt) console.log('  Expires: ' + new Date(d.expiresAt * 1000).toLocaleString());
        break;
      }

      case 'upload-dir': {
        const dirPath = args[1];
        if (!dirPath) {
          printError('Directory path required');
          process.exit(1);
        }
        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
          printError(`Not a directory: ${dirPath}`);
          process.exit(1);
        }
        const files = fs.readdirSync(dirPath).filter(f => {
          const stat = fs.statSync(path.join(dirPath, f));
          return stat.isFile() && !f.startsWith('.');
        });
        if (files.length === 0) {
          console.log('No files found in directory');
          process.exit(0);
        }
        console.log(`Uploading ${files.length} files from ${dirPath}...`);
        let success = 0, failed = 0;
        for (const file of files) {
          const fullPath = path.join(dirPath, file);
          process.stdout.write(`  ${file}... `);
          const res = await uploadFile(fullPath);
          if (res.status < 400) {
            console.log('OK');
            success++;
          } else {
            console.log(`FAILED (${res.status})`);
            failed++;
          }
        }
        console.log(`\nDone: ${success} succeeded, ${failed} failed`);
        process.exit(failed > 0 ? 1 : 0);
        break;
      }

      case 'batch-rename': {
        // Parse: rename <old1> <new1> [old2 new2 ...]
        const names = args.slice(1);
        if (names.length < 2 || names.length % 2 !== 0) {
          printError('Usage: batch-rename <old1> <new1> [old2 new2 ...]');
          process.exit(1);
        }
        const renames = [];
        for (let i = 0; i < names.length; i += 2) {
          renames.push({ oldFilename: names[i], newFilename: names[i + 1] });
        }
        const res = await request('POST', '/api/file-rename-batch', {
          body: JSON.stringify({ renames })
        });
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        const { success, failed, results, errors } = res.data;
        console.log(`Renamed ${success.length} file(s), ${errors.length} failed`);
        if (errors.length > 0) {
          errors.forEach(e => console.log(`  FAIL: ${e.oldFilename} - ${e.error}`));
        }
        process.exit(errors.length > 0 ? 1 : 0);
        break;
      }

      case 'batch-delete': {
        const names = args.slice(1);
        if (names.length === 0) {
          printError('At least one file name required');
          process.exit(1);
        }
        console.log(`Deleting ${names.length} files...`);
        let success = 0, failed = 0;
        for (const name of names) {
          process.stdout.write(`  ${name}... `);
          const res = await request('DELETE', `/delete/${encodeURIComponent(name)}`);
          if (res.status < 400) {
            console.log('OK');
            success++;
          } else {
            console.log(`FAILED (${res.status})`);
            failed++;
          }
        }
        console.log(`\nDone: ${success} succeeded, ${failed} failed`);
        process.exit(failed > 0 ? 1 : 0);
        break;
      }

      case 'batch-tag': {
        // Usage: share-tool batch-tag <add|remove|set> <tag> [file1 file2 ...]
        // Or: share-tool batch-tag <tag> [file1 file2 ...] (defaults to add)
        const subCmd = args[1];
        if (!subCmd) {
          printError('Usage: share-tool batch-tag <add|remove|set> <tag> [files...]\n  Or: share-tool batch-tag <tag> [files...] (default: add)');
          process.exit(1);
        }
        let action, tag, files;
        const knownActions = ['add', 'remove', 'set'];
        if (knownActions.includes(subCmd)) {
          action = subCmd;
          tag = args[2];
          files = args.slice(3);
        } else {
          // subCmd is actually the tag
          action = 'add';
          tag = subCmd;
          files = args.slice(2);
        }
        if (!tag) {
          printError('Tag name required');
          process.exit(1);
        }
        if (files.length === 0) {
          printError('At least one file name required');
          process.exit(1);
        }
        console.log(`${action.toUpperCase()} tag "${tag}" on ${files.length} files...`);
        const res = await request('PUT', '/api/file-tags/batch', {
          body: JSON.stringify({ files, action, tags: tag })
        });
        if (res.status >= 400 || !res.data.success) {
          printError(`Batch tag failed: ${res.data.error || res.status}`);
          process.exit(1);
        }
        console.log(`Done: ${res.data.updated} updated, ${res.data.failed} failed (total: ${res.data.total})`);
        process.exit(res.data.failed > 0 ? 1 : 0);
        break;
      }

      case 'list-tags': {
        const res = await request('GET', '/api/tags');
        if (res.status >= 400 || !res.data.success) {
          printError(`Failed to list tags: ${res.data.error || res.status}`);
          process.exit(1);
        }
        const tags = res.data.tags || [];
        if (tags.length === 0) {
          console.log('No tags found.');
        } else {
          console.log(`Tags (${tags.length}):`);
          tags.forEach(t => console.log('  ' + t));
        }
        process.exit(0);
        break;
      }

      case 'sync': {
        console.log('Connecting to sync server...');
        try {
          const ws = await connectSyncWs();
          console.log('Connected. Syncing...');
          const pullResult = await syncPull();
          const manifest = loadManifest();
          if (pullResult.payload && pullResult.payload.logs && pullResult.payload.logs.length > 0) {
            console.log(`Pulled ${pullResult.payload.logs.length} change(s) from server.`);
            for (const log of pullResult.payload.logs) {
              console.log(`  [${log.action}] ${log.filename || '(no name)'}`);
              await applyRemoteChange(log, (msg) => console.log('    ' + msg));
              // Update manifest
              if (log.action === 'delete') {
                delete manifest.files[log.filename];
              } else if (log.action === 'rename') {
                delete manifest.files[log.oldFilename];
                manifest.files[log.newFilename] = { hash: log.hash, size: log.size };
              } else {
                manifest.files[log.filename] = { hash: log.hash, size: log.size };
              }
            }
            manifest.lastSync = Math.floor(Date.now() / 1000);
            saveManifest(manifest);
          } else {
            console.log('No new changes from server.');
          }
          console.log('Sync complete.');
        } catch (err) {
          printError(`Sync failed: ${err.message}`);
          process.exit(1);
        }
        break;
      }

      case 'sync-watch': {
        console.log('Starting sync watch mode...');
        try {
          // Load or bootstrap manifest
          let manifest = loadManifest();
          const isNew = Object.keys(manifest.files).length === 0;
          if (isNew) {
            console.log('No local manifest found. Fetching server file list...');
            manifest = await buildManifestFromServer();
            if (!manifest) throw new Error('Failed to fetch server file list');
            saveManifest(manifest);
            console.log(`Manifest created: ${Object.keys(manifest.files).length} files synced.`);
          } else {
            console.log(`Loaded manifest: ${Object.keys(manifest.files).length} files tracked.`);
            // Do a full sync pull on startup
            const pullResult = await syncPull();
            if (pullResult.payload && pullResult.payload.logs && pullResult.payload.logs.length > 0) {
              for (const log of pullResult.payload.logs) {
                await applyRemoteChange(log, (msg) => console.log('  ' + msg));
              }
              // Update manifest lastSync
              manifest.lastSync = Math.floor(Date.now() / 1000);
              saveManifest(manifest);
              console.log(`Synced ${pullResult.payload.logs.length} change(s).`);
            }
          }

          // Connect WebSocket for real-time updates
          const ws = await connectSyncWs();
          console.log('Connected. Watching for real-time changes...');
          console.log(`Sync directory: ${SYNC_DIR}`);
          console.log('Press Ctrl+C to stop.\n');

          // Override handleWsMessage to apply changes in real-time
          const origHandler = wsClient.listeners('message')[0];
          wsClient.removeAllListeners('message');
          wsClient.on('message', async (data) => {
            try {
              const msg = JSON.parse(data.toString());
              const { type, payload } = msg;
              // Real-time file changes from server broadcast
              if (['file_create', 'file_update', 'file_delete', 'file_rename'].includes(type)) {
                const now = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
                console.log(`[${now}] ${type}: ${payload.filename}`);
                await applyRemoteChange(payload, (evMsg) => console.log('    ' + evMsg));
                // Update manifest
                if (type === 'file_delete') {
                  delete manifest.files[payload.filename];
                } else if (type === 'file_rename') {
                  delete manifest.files[payload.oldFilename];
                  manifest.files[payload.newFilename] = { hash: payload.hash, size: payload.size };
                } else {
                  manifest.files[payload.filename] = { hash: payload.hash, size: payload.size };
                }
                manifest.lastSync = Math.floor(Date.now() / 1000);
                saveManifest(manifest);
              } else {
                // Pass to original handler for other message types
                if (origHandler) origHandler(data);
              }
            } catch (e) {}
          });

          // Keep alive — wait forever
          await new Promise(() => {});
        } catch (err) {
          printError(`Sync watch failed: ${err.message}`);
          process.exit(1);
        }
        break;
      }

      case 'recent': {
        const limit = parseInt(args[0]) || 10;
        const res = await request('GET', `/api/list?sort=updated_at&order=desc&limit=${limit}`);
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          process.exit(1);
        }
        const files = res.data.files || [];
        if (files.length === 0) {
          console.log('No files found.');
        } else {
          console.log(`Recent ${files.length} file(s):`);
          files.forEach((f, i) => {
            const date = new Date((f.updatedAt || f.time) / 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            const size = formatSize(f.size || 0);
            const star = f.starred ? '⭐ ' : '   ';
            console.log(`  ${star}${f.name} (${size}) - ${date}`);
          });
        }
        break;
      }

      case 'find': {
        if (!args[0]) {
          printError('Usage: share-tool find <query> [--tag=<tag>] [--type=text|file] [--limit=<n>]');
          process.exit(1);
        }
        // Parse flags
        let query = '';
        let tag = '';
        let typeFilter = '';
        let limit = 50;
        for (const arg of args.slice(1)) {
          if (arg.startsWith('--tag=')) tag = arg.slice(6);
          else if (arg.startsWith('--type=')) typeFilter = arg.slice(6);
          else if (arg.startsWith('--limit=')) limit = parseInt(arg.slice(8)) || 50;
          else if (!arg.startsWith('--')) query += (query ? ' ' : '') + arg;
        }
        query = args[0] + (query ? ' ' + query : '');
        const params = new URLSearchParams({ q: query, limit });
        if (tag) params.set('tags', tag);
        if (typeFilter) params.set('type', typeFilter);
        const res = await request('GET', `/api/search?${params}`);
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          process.exit(1);
        }
        const results = res.data.files || res.data.results || [];
        if (results.length === 0) {
          console.log('No files found.');
        } else {
          console.log(`Found ${results.length} file(s):`);
          results.forEach((f, i) => {
            const score = f.score !== undefined ? ` [score:${f.score}]` : '';
            const tags = f.tags ? ` [${f.tags}]` : '';
            console.log(`  ${i + 1}. ${f.name || f.filename}${tags}${score}`);
          });
        }
        break;
      }

      case 'status': {
        let res;
        try {
          res = await request('GET', '/api/health');
        } catch (e) {
          console.log('❌ Server offline or unreachable');
          process.exit(1);
        }
        if (res.status >= 500) {
          console.log('❌ Server error: ' + res.status);
          process.exit(1);
        }
        if (res.status >= 400) {
          console.log('⚠️  Server returned: ' + res.status);
          process.exit(1);
        }
        const h = res.data;
        console.log('✅ Server online');
        console.log('   Version: ' + (h.version || 'unknown'));
        console.log('   URL:     ' + getServerUrl());
        if (h.uptime) {
          const days = Math.floor(h.uptime / 86400);
          const hh = Math.floor((h.uptime % 86400) / 3600);
          const mm = Math.floor((h.uptime % 3600) / 60);
          const ss = Math.round(h.uptime % 60);
          console.log('   Uptime:  ' + (days > 0 ? days + 'd ' : '') + hh + 'h ' + mm + 'm ' + ss + 's');
        }
        // Fetch stats
        try {
          const statsRes = await request('GET', '/api/db/stats');
          if (statsRes.status < 400 && statsRes.data.success) {
            const s = statsRes.data;
            console.log('   Files:   ' + (s.fileCount || 0));
            console.log('   Storage: ' + formatSize(s.totalSize || 0));
            if (s.shareLinks !== undefined) console.log('   Shares:  ' + s.shareLinks);
          }
        } catch (_) {}
        break;
      }
      case 'open': {
        const url = getServerUrl();
        const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        console.log('Opening: ' + url);
        require('child_process').spawn(openCmd, [url], { detached: true, stdio: 'ignore' }).unref();
        break;
      }

      case 'serve': {
        // Start share-tool server in foreground mode
        const serverPath = path.join(__dirname, 'server.js');
        const lang = (process.env.LANG || '').toLowerCase();
        const isZh = lang.includes('zh');
        console.log(isZh ? '启动 ShareTool 服务器...' : 'Starting ShareTool server...');
        console.log(isZh ? '按 Ctrl+C 停止服务器' : 'Press Ctrl+C to stop server');
        const child = spawn('node', [serverPath, ...args.slice(1)], {
          stdio: 'inherit',
          cwd: __dirname
        });
        child.on('exit', (code) => process.exit(code || 0));
        break;
      }

      case 'log': {
        // share-tool log [--limit=50] [--action=<action>] [--ip=<ip>] [--date=YYYY-MM-DD] [-f|--follow]
        const follow = args.includes('-f') || args.includes('--follow');
        const limit = follow ? 20 : (parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || 50);
        const action = args.find(a => a.startsWith('--action='))?.split('=')[1] || '';
        const ip = args.find(a => a.startsWith('--ip='))?.split('=')[1] || '';
        const date = args.find(a => a.startsWith('--date='))?.split('=')[1] || '';
        let endpoint = '/api/audit/logs?limit=' + limit;
        if (action) endpoint += '&action=' + encodeURIComponent(action);
        if (ip) endpoint += '&ip=' + encodeURIComponent(ip);
        if (date) endpoint += '&date=' + encodeURIComponent(date);
        const fmtTime = ts => {
          const d = new Date(ts * 1000);
          return d.toISOString().replace('T', ' ').slice(0, 19);
        };
        if (follow) {
          let lastTimestamp = 0;
          console.log('Following audit logs... (Ctrl+C to stop)');
          const interval = setInterval(async () => {
            try {
              const res = await request('GET', endpoint + '&since=' + lastTimestamp);
              if (res.status >= 400) return;
              const logs = res.data.logs || [];
              for (const l of logs) {
                const ts = l.timestamp || 0;
                if (ts > lastTimestamp) lastTimestamp = ts;
                const act = (l.action || '').padEnd(20);
                const details = (l.details || '').slice(0, 80);
                console.log(fmtTime(ts) + '  ' + act + '  ' + details);
              }
            } catch (_) {}
          }, 3000);
          process.on('SIGINT', () => { clearInterval(interval); process.exit(0); });
        } else {
          const res = await request('GET', endpoint);
          if (res.status >= 400) {
            printError('Server error: ' + res.status);
            process.exit(1);
          }
          const logs = res.data.logs || [];
          if (logs.length === 0) {
            console.log('No audit logs found.');
            break;
          }
          console.log('=== Audit Logs (' + logs.length + ') ===');
          for (const l of logs) {
            const act = (l.action || '').padEnd(20);
            const time = fmtTime(l.timestamp);
            const details = (l.details || '').slice(0, 60);
            console.log(time + '  ' + act + '  ' + details + (l.details && l.details.length > 60 ? '...' : ''));
          }
          if (res.data.stats) {
            const s = res.data.stats;
            console.log('\n=== Summary ===');
            console.log('Total: ' + s.total + '  |  Today: ' + s.todayCount);
          }
        }
        break;
      }
      case 'stats': {
        const res = await request('GET', '/api/dashboard');
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          process.exit(1);
        }
        const s = res.data;
        console.log('=== Dashboard Stats ===');
        console.log(`Files:      ${s.fileCount || 0}`);
        console.log(`Storage:    ${formatSize(s.totalSize || 0)}`);
        console.log(`Starred:    ${s.starredCount || 0}`);
        console.log(`Trash:      ${s.trashCount || 0}`);
        console.log(`Shares:     ${s.shareCount || 0}`);
        console.log(`Devices:    ${s.deviceCount || 0}`);
        console.log(`Tokens:     ${s.tokenCount || 0}`);
        if (s.syncStatus) {
          console.log(`Sync:       ${s.syncStatus.lastSync || 'Never'}`);
          console.log(`  Peers:   ${s.syncStatus.peerCount || 0}`);
          console.log(`  Status:  ${s.syncStatus.status || 'unknown'}`);
        }
        if (s.versions) {
          console.log(`Versions:   ${s.versions.totalVersions || 0}`);
          console.log(`  Storage: ${formatSize(s.versions.totalVersionSize || 0)}`);
        }

        // Also fetch system stats
        const sysRes = await request('GET', '/api/system/stats');
        if (sysRes.status < 400 && sysRes.data && sysRes.data.success) {
          const m = sysRes.data.memory;
          const c = sysRes.data.cpu;
          const p = sysRes.data.process;
          const d = sysRes.data.disk;
          const fmtMem = b => (b / 1024 / 1024).toFixed(0) + ' MB';
          const fmtDisk = b => (b / 1024 / 1024 / 1024).toFixed(1) + ' GB';
          console.log('\n=== System Stats ===');
          if (m) {
            console.log(`Heap:       ${fmtMem(m.heapUsed)} / ${fmtMem(m.heapTotal)} (${Math.round((m.heapUsed / m.heapTotal) * 100)}%)`);
            console.log(`RSS:        ${fmtMem(m.rss)}`);
            console.log(`System:     ${Math.round((m.systemUsed / m.systemTotal) * 100)}% used (${fmtMem(m.systemFree)} free)`);
          }
          if (c) {
            const days = Math.floor(p.uptime / 86400);
            const hh = Math.floor((p.uptime % 86400) / 3600);
            const mm = Math.floor((p.uptime % 3600) / 60);
            const ss = Math.round(p.uptime % 60);
            const upStr = (days > 0 ? days + 'd ' : '') + hh + 'h ' + mm + 'm ' + ss + 's';
            console.log(`CPU:        ${c.cores} cores · load ${c.loadavg1m.toFixed(2)} (1m) / ${c.loadavg5m.toFixed(2)} (5m) / ${c.loadavg15m.toFixed(2)} (15m)`);
            if (d) console.log(`Disk:       ${fmtDisk(d.used)} / ${fmtDisk(d.total)} (${Math.round((d.free / d.total) * 100)}% free)`);
            console.log(`Uptime:     ${upStr}`);
            console.log(`Node:       ${p.nodeVersion} on ${p.platform}`);
          }
        }
        break;
      }

      case 'export': {
        let outputDir = args.indexOf('-o') !== -1 ? args[args.indexOf('-o') + 1] : process.cwd();
        console.log(`Exporting files to: ${outputDir}`);
        const listRes = await request('GET', '/api/list?limit=10000');
        if (listRes.status >= 400) {
          printError(`Server error: ${listRes.status}`);
          process.exit(1);
        }
        const files = listRes.data.files || [];
        if (files.length === 0) {
          console.log('No files to export.');
          break;
        }
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        let exported = 0;
        let errors = 0;
        for (const f of files) {
          const name = f.filename || f.name;
          const contentRes = await new Promise((resolve) => {
            const serverUrl = getServerUrl();
            const parsedUrl = parseUrl(serverUrl, `/content/${encodeURIComponent(name)}`);
            const isHttps = parsedUrl.protocol === 'https:';
            const client = isHttps ? https : http;
            const token = getToken();
            const reqOptions = {
              hostname: parsedUrl.hostname,
              port: parsedUrl.port || (isHttps ? 443 : 80),
              path: parsedUrl.pathname,
              method: 'GET',
              headers: token ? { 'x-auth-token': token } : {}
            };
            const req = client.request(reqOptions, (res) => {
              const chunks = [];
              res.on('data', c => chunks.push(c));
              res.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve({ status: res.statusCode, data: buf });
              });
            });
            req.on('error', () => resolve({ status: 0, data: null }));
            req.end();
          });
          if (contentRes.status === 200 && contentRes.data) {
            const outPath = path.join(outputDir, name);
            const dir = path.dirname(outPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(outPath, contentRes.data);
            exported++;
            process.stdout.write(`\rExported ${exported}/${files.length}: ${name}`);
          } else {
            errors++;
            process.stdout.write(`\rError ${contentRes.status}: ${name}`);
          }
        }
        console.log(`\nDone: ${exported} exported, ${errors} errors.`);
        break;
      }

      case 'config': {
        const subCommand = args[1];
        const config = getConfig();
        if (!subCommand) {
          // Show all config
          console.log(`Config file: ${CONFIG_PATH}`);
          if (Object.keys(config).length === 0) {
            console.log('(no config set)');
          } else {
            console.log(JSON.stringify(config, null, 2));
          }
          break;
        }
        switch (subCommand) {
          case 'get': {
            const key = args[2];
            if (!key) {
              printError('Key required: config get <key>');
              process.exit(1);
            }
            const val = config[key];
            if (val === undefined) {
              console.log(`${key}  (not set)`);
            } else {
              console.log(`${key} = ${val}`);
            }
            break;
          }
          case 'set': {
            const key = args[2];
            const value = args[3];
            if (!key || value === undefined) {
              printError('Usage: config set <key> <value>');
              process.exit(1);
            }
            saveConfig({ [key]: value });
            console.log(`${key} = ${value}`);
            break;
          }
          case 'unset': {
            const key = args[2];
            if (!key) {
              printError('Key required: config unset <key>');
              process.exit(1);
            }
            const current = getConfig();
            if (current[key] === undefined) {
              console.log(`${key}  (not set, nothing to remove)`);
            } else {
              const { [key]: _, ...rest } = current;
              const dir = path.dirname(CONFIG_PATH);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(CONFIG_PATH, JSON.stringify(rest, null, 2), 'utf8');
              console.log(`Removed ${key}`);
            }
            break;
          }
          case 'reset': {
            if (fs.existsSync(CONFIG_PATH)) {
              fs.unlinkSync(CONFIG_PATH);
            }
            console.log('Config reset to empty');
            break;
          }
          default:
            printError(`Unknown config subcommand: ${subCommand}`);
            process.exit(1);
        }
        break;
      }

      case 'history': {
        if (args.includes('--clear')) {
          saveHistory([]);
          console.log('History cleared.');
          break;
        }
        const hist = getHistory();
        if (hist.length === 0) {
          console.log('No history yet.');
          break;
        }
        hist.forEach((h, i) => {
          const d = new Date(h.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
          console.log(`${String(i + 1).padStart(3, ' ')}  ${d}  ${h.cmd}`);
        });
        break;
      }

      case 'trash': {
        // trash [list|restore|delete|empty]
        const sub = args[1] || 'list';
        if (sub === 'list') {
          const res = await request('GET', '/api/trash');
          if (res.status >= 400) { printError('Failed: ' + res.status); process.exit(1); }
          const { trash } = res.data;
          if (!trash || trash.length === 0) { console.log('Trash is empty.'); break; }
          console.log(`Trash (${trash.length} item(s)):`);
          trash.forEach(t => {
            const d = new Date(t.deleted_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            const exp = new Date(t.expires_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            console.log(`  [${t.id}] ${t.filename} — deleted ${d}, expires ${exp}`);
          });
        } else if (sub === 'empty') {
          const res = await request('DELETE', '/api/trash');
          if (res.status >= 400) { printError('Failed: ' + res.status); process.exit(1); }
          console.log('Trash emptied.');
        } else if (sub === 'restore' || sub === 'delete') {
          const id = parseInt(args[2]);
          if (!id) { printError('Usage: share-tool trash ' + sub + ' <id>'); process.exit(1); }
          const res = sub === 'restore'
            ? await request('POST', '/api/trash/' + id + '/restore')
            : await request('DELETE', '/api/trash/' + id);
          if (res.status >= 400) { printError('Failed: ' + res.status); process.exit(1); }
          console.log(sub === 'restore' ? 'Restored.' : 'Deleted permanently.');
        } else {
          printError('Usage: share-tool trash [list|restore <id>|delete <id>|empty]');
          process.exit(1);
        }
        break;
      }

      case 'share-list': {
        // List all active share links
        const res = await request('GET', '/api/share/list');
        if (res.status >= 400) { printError('Failed: ' + res.status); process.exit(1); }
        const links = res.data.links || [];
        if (links.length === 0) { console.log('No active share links.'); break; }
        console.log(`Share links (${links.length}):`);
        links.forEach(l => {
          const exp = l.expires_at ? new Date(l.expires_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : 'never';
          const dl = l.download_count !== undefined ? ` (${l.download_count} downloads)` : '';
          const pwd = (l.hasPassword || l.password) ? ' 🔒' : '';
          console.log(`  ${l.code}${pwd} → ${l.filename} — expires ${exp}${dl}`);
          console.log(`    ${l.url}`);
        });
        break;
      }

      case 'tags': {
        const res = await request('GET', '/api/tags/list');
        if (res.status >= 400) { printError('Failed: ' + res.status); process.exit(1); }
        const tags = res.data.tags || [];
        if (tags.length === 0) { console.log('No tags found.'); break; }
        const maxCount = Math.max(...tags.map(t => t.count));
        const nameW = Math.max(...tags.map(t => (t.tag || '').length)) + 2;
        console.log(`Tags (${tags.length}):\n`);
        for (const t of tags) {
          const barLen = maxCount > 0 ? Math.round((t.count / maxCount) * 20) : 0;
          const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
          const name = (t.tag || '').padEnd(nameW);
          console.log(`  ${name}${bar}  ${t.count}`);
        }
        break;
      }

      case 'share-delete': {
        const code = args[0];
        if (!code) {
          printError('Usage: share-tool share-delete <code>');
          process.exit(1);
        }
        const res = await request('DELETE', '/api/share/delete/' + code);
        if (res.status >= 400) {
          printError('Delete failed: ' + (res.data?.error || res.status));
          process.exit(1);
        }
        console.log('Deleted share link: ' + code);
        break;
      }

      case 'share-extend': {
        // share-tool share-extend <code> [hours] — extend expiration (default: 168h = 7 days)
        const code = args[0];
        const hours = parseInt(args[1]) || 168;
        if (!code) {
          printError('Usage: share-tool share-extend <code> [hours]');
          process.exit(1);
        }
        const res = await request('PUT', '/api/share/batch', { codes: [code], expiryHours: hours });
        if (res.status >= 400) {
          printError('Extend failed: ' + (res.data?.error || res.status));
          process.exit(1);
        }
        const newExp = new Date(Date.now() + hours * 3600000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        console.log('Extended: ' + code + ' → expires ' + newExp);
        break;
      }

      case 'share-password': {
        // share-tool share-password <code> [password] — set password (omit password to remove)
        const code = args[0];
        const password = args[1]; // undefined means remove
        if (!code) {
          printError('Usage: share-tool share-password <code> [password]');
          process.exit(1);
        }
        const res = await request('PUT', '/api/share/batch', { codes: [code], password: password || null });
        if (res.status >= 400) {
          printError('Set password failed: ' + (res.data?.error || res.status));
          process.exit(1);
        }
        console.log(password ? 'Password set for: ' + code : 'Password removed for: ' + code);
        break;
      }

      case 'diff': {
        // Usage: share-tool diff <filename> [v1_timestamp] [v2_timestamp]
        // Without timestamps: shows version list to pick from
        const filename = args[1];
        if (!filename) {
          printError('Usage: share-tool diff <filename> [v1_timestamp] [v2_timestamp]');
          process.exit(1);
        }
        // First get version list
        const versionsRes = await request('GET', '/api/file-versions/' + encodeURIComponent(filename));
        if (versionsRes.status >= 400) {
          printError(`Failed to get versions: ${versionsRes.status}`);
          process.exit(1);
        }
        const { versions } = versionsRes.data;
        if (!versions || versions.length === 0) {
          console.log('No version history found.');
          break;
        }
        if (versions.length === 1) {
          console.log('Only one version available. Need at least 2 versions to diff.');
          break;
        }
        if (!args[2] || !args[3]) {
          // Show version list for selection
          console.log(`Version history for "${filename}":`);
          versions.forEach((v, i) => {
            const d = new Date(v.created_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            const size = v.size != null ? ` (${v.size} bytes)` : '';
            console.log(`  ${i + 1}. [${v.created_at}] ${d}${size}`);
          });
          console.log('\nUsage to diff: share-tool diff <filename> <v1_timestamp> <v2_timestamp>');
          break;
        }
        const v1 = parseInt(args[2]);
        const v2 = parseInt(args[3]);
        const diffRes = await request('GET', '/api/file-versions/' + encodeURIComponent(filename) + '/diff?v1=' + v1 + '&v2=' + v2);
        if (diffRes.status >= 400) {
          printError(`Diff failed: ${diffRes.status}`);
          printJson(diffRes.data);
          process.exit(1);
        }
        const { diff } = diffRes.data;
        console.log(`Diff: ${filename} (${v1} → ${v2})`);
        diff.forEach(d => {
          const prefix = d.op === '+' ? '  +' : d.op === '-' ? '  -' : '   ';
          console.log(`${prefix} ${String(d.line).padStart(4)} | ${d.content}`);
        });
        break;
      }

      case 'duplicates': {
        const subCmd = args[1];
        const res = await request('GET', '/api/duplicates');
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          process.exit(1);
        }
        const { count, duplicates } = res.data;

        if (subCmd === 'delete') {
          // share-tool duplicates delete <groupId>
          const groupId = parseInt(args[2]);
          if (isNaN(groupId) || groupId < 1 || groupId > duplicates.length) {
            printError(`Invalid group ID. Choose 1-${duplicates.length}`);
            process.exit(1);
          }
          const group = duplicates[groupId - 1];
          // Keep the first file, delete the rest
          const toDelete = group.files.slice(1);
          let deleted = 0;
          for (const f of toDelete) {
            const delRes = await request('DELETE', `/api/file/${encodeURIComponent(f.filename)}`);
            if (delRes.status < 400) deleted++;
          }
          console.log(`Deleted ${deleted} of ${toDelete.length} duplicate file(s) from group ${groupId} (kept: ${group.files[0].filename})`);
          break;
        }

        if (subCmd === 'keep') {
          // share-tool duplicates keep <groupId> <filenameToKeep>
          const groupId = parseInt(args[2]);
          const filenameToKeep = args[3];
          if (isNaN(groupId) || groupId < 1 || groupId > duplicates.length) {
            printError(`Invalid group ID. Choose 1-${duplicates.length}`);
            process.exit(1);
          }
          if (!filenameToKeep) {
            printError('Usage: share-tool duplicates keep <groupId> <filename>');
            process.exit(1);
          }
          const group = duplicates[groupId - 1];
          const toDelete = group.files.filter(f => f.filename !== filenameToKeep);
          let deleted = 0;
          for (const f of toDelete) {
            const delRes = await request('DELETE', `/api/file/${encodeURIComponent(f.filename)}`);
            if (delRes.status < 400) deleted++;
          }
          console.log(`Deleted ${deleted} duplicate(s), kept: ${filenameToKeep}`);
          break;
        }

        // Default: list duplicates
        if (count === 0) {
          console.log('No duplicate files found.');
          break;
        }
        console.log(`Found ${count} duplicate group(s):\n`);
        duplicates.forEach((group, i) => {
          console.log(`Group ${i + 1} (${group.count} files, hash=${group.hash.slice(0, 12)}...)`);
          group.files.forEach(f => {
            const size = formatSize(f.size || 0);
            const date = f.updated_at ? new Date(f.updated_at * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
            console.log(`  - ${f.filename}  ${size.padStart(10)}  ${date}`);
          });
          console.log('');
        });
        console.log('Tip: share-tool duplicates delete <groupId>  # keep first, delete rest');
        console.log('     share-tool duplicates keep <groupId> <filename>  # keep specific file');
        break;
      }

      case 'share-info': {
        // share-tool share-info <code>
        const code = args[1];
        if (!code) {
          printError('Usage: share-tool share-info <code>');
          process.exit(1);
        }
        const res = await request('GET', `/api/share/${code}`);
        if (res.status === 404) {
          printError('Share link not found or expired');
          process.exit(1);
        }
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          process.exit(1);
        }
        const d = res.data;
        const url = getServerUrl().replace(/\/+$/, '') + '/s/' + code;
        console.log('Share Link Info:');
        console.log('  URL:      ' + url);
        console.log('  Code:     ' + code);
        console.log('  File:     ' + (d.filename || d.file?.filename || 'unknown'));
        if (d.hasPassword) console.log('  Password: yes');
        if (d.expiresAt) {
          const expDate = new Date(d.expiresAt * 1000);
          const remaining = Math.max(0, expDate - Date.now());
          const hours = Math.floor(remaining / 3600000);
          console.log(`  Expires:  ${expDate.toLocaleString()} (${hours}h remaining)`);
        } else {
          console.log('  Expires:  never');
        }
        if (d.maxDownloads) {
          console.log(`  Max downloads: ${d.downloads || 0} / ${d.maxDownloads}`);
        } else {
          console.log('  Max downloads: unlimited');
        }
        if (d.downloads > 0) console.log('  Total downloads: ' + d.downloads);
        break;
      }

      case 'top': {
        // share-tool top [n] — show largest files
        const limit = parseInt(args[1]) || 10;
        const res = await request('GET', `/api/files?sort=size&limit=${limit}`);
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          process.exit(1);
        }
        const files = res.data.files || [];
        if (files.length === 0) {
          console.log('No files found.');
          break;
        }
        const maxSize = Math.max(...files.map(f => f.size || 0));
        console.log(`Top ${files.length} largest files:\n`);
        files.forEach((f, i) => {
          const size = f.size || 0;
          const barLen = maxSize > 0 ? Math.round((size / maxSize) * 20) : 0;
          const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
          const sizeStr = formatSize(size).padStart(10);
          const date = f.updated_at ? new Date(f.updated_at * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
          console.log(`  ${String(i + 1).padStart(2)}. ${sizeStr}  ${bar}  ${f.filename}  ${date}`);
        });
        break;
      }

      case 'renew-cert': {
        const opts = {
          hostname: parsed.hostname, port: parsed.port,
          path: '/api/admin/renew-cert', method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Length': 0 }
        };
        const preq = https.request(opts, (pres) => {
          let data = '';
          pres.on('data', d => data += d);
          pres.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.success) {
                console.log(json.message);
              } else {
                printError(json.error || 'Renew failed');
              }
            } catch { printError('Invalid response'); }
          });
        });
        preq.on('error', e => printError(`Request failed: ${e.message}`));
        preq.end();
        break;
      }

      default:
        printError(`Unknown command: ${command}`);
        console.log('Run without args to see full command list');
        process.exit(1);
    }
  } catch (err) {
    printError(err.message);
    process.exit(1);
  }
}

main();
