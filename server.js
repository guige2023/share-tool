#!/usr/bin/env node
/**
 * ShareTool - 本地局域网文件/文字分享服务
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 18790;
const SHARE_DIR = path.join(os.homedir(), '.share-tool', 'files');
const CONFIG_FILE = path.join(os.homedir(), '.share-tool', 'config.json');
const AUTH_TOKEN = process.env.SHARE_TOKEN || '35e7438f1e72356ebc6d4e839881cc35233ee01ec81d5af6';
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

if (!fs.existsSync(SHARE_DIR)) {
  fs.mkdirSync(SHARE_DIR, { recursive: true });
}

const DEFAULT_CONFIG = {
  downloadDir: path.join(os.homedir(), 'Downloads', 'ShareTool'),
  lastSync: null
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch (e) {}
  return DEFAULT_CONFIG;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
if (!fs.existsSync(config.downloadDir)) {
  fs.mkdirSync(config.downloadDir, { recursive: true });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token, authorization');
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ShareTool</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
.container { max-width: 800px; margin: 0 auto; padding: 24px; }
header { text-align: center; margin-bottom: 32px; }
h1 { font-size: 32px; font-weight: 700; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 8px; }
.subtitle { color: #64748b; font-size: 14px; }
.hero { background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px; padding: 24px; margin-bottom: 24px; border: 1px solid #334155; }
.hero-content { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
.hero-text { flex: 1; min-width: 200px; }
.hero-title { font-size: 18px; font-weight: 600; color: #e2e8f0; margin-bottom: 12px; }
.hero-desc { font-size: 13px; color: #94a3b8; line-height: 1.6; margin-bottom: 8px; }
.hero-features { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.hero-feature { background: rgba(102, 126, 234, 0.15); padding: 4px 10px; border-radius: 20px; font-size: 11px; color: #667eea; }
.hero-qr { flex-shrink: 0; text-align: center; }
.hero-qr img { width: 120px; height: 120px; border-radius: 8px; border: 2px solid #334155; background: white; }
.hero-qr-tip { font-size: 11px; color: #64748b; margin-top: 8px; }
.hero-url { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.hero-url input { flex: 1; padding: 8px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; color: #667eea; font-size: 12px; }
.hero-url .btn-copy { padding: 8px 12px; background: #334155; border: none; border-radius: 8px; color: #e2e8f0; cursor: pointer; font-size: 12px; }
.card { background: #1e293b; border-radius: 16px; padding: 24px; margin-bottom: 20px; border: 1px solid #334155; }
.section-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #94a3b8; display: flex; align-items: center; gap: 8px; }
.section-title::before { content: ''; width: 4px; height: 16px; background: linear-gradient(180deg, #667eea, #764ba2); border-radius: 2px; }
textarea { width: 100%; padding: 14px; background: #0f172a; border: 1px solid #334155; border-radius: 10px; color: #e2e8f0; font-size: 14px; margin-bottom: 12px; resize: vertical; min-height: 100px; font-family: inherit; }
textarea:focus { outline: none; border-color: #667eea; }
input[type="text"] { width: 100%; padding: 12px 14px; background: #0f172a; border: 1px solid #334155; border-radius: 10px; color: #e2e8f0; font-size: 14px; margin-bottom: 12px; }
input:focus { outline: none; border-color: #667eea; }
.btn { padding: 12px 20px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; border-radius: 10px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; }
.btn:hover { opacity: 0.9; transform: translateY(-1px); }
.btn:active { transform: translateY(0); }
.btn-secondary { background: #334155; }
.btn-danger { background: #dc2626; }
.btn-warning { background: #d97706; }
.btn-sm { padding: 8px 14px; font-size: 13px; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; }
.file-upload-area { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; background: #0f172a; border: 2px dashed #334155; border-radius: 12px; cursor: pointer; transition: all 0.2s; text-align: center; }
.file-upload-area:hover { border-color: #667eea; background: #1a2744; }
.file-upload-area input { position: absolute; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.file-upload-area .icon { font-size: 40px; margin-bottom: 12px; }
.file-upload-area .text { color: #64748b; font-size: 14px; }
.file-upload-area .hint { color: #475569; font-size: 12px; margin-top: 8px; }
.file-list { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.file-item { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px; background: #0f172a; border-radius: 10px; border: 1px solid #334155; gap: 12px; }
.file-content { flex: 1; min-width: 0; }
.file-preview { background: #1e293b; border-radius: 8px; padding: 12px; margin-top: 8px; max-height: 150px; overflow: auto; white-space: pre-wrap; font-size: 12px; color: #94a3b8; border: 1px solid #334155; word-break: break-all; }
.file-name { font-weight: 500; color: #e2e8f0; word-break: break-all; font-size: 14px; }
.file-meta { font-size: 12px; color: #64748b; margin-top: 4px; }
.file-actions { display: flex; gap: 8px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.empty { text-align: center; padding: 30px; color: #64748b; }
.alert { padding: 12px 16px; border-radius: 10px; margin-bottom: 16px; font-size: 14px; display: none; }
.alert-success { background: rgba(34, 197, 94, 0.15); border: 1px solid #22c55e; color: #4ade80; }
.alert-error { background: rgba(220, 38, 38, 0.15); border: 1px solid #dc2626; color: #f87171; }
.alert-info { background: rgba(59, 130, 246, 0.15); border: 1px solid #3b82f6; color: #60a5fa; }
.alert.show { display: block; }
.code-box { background: #0f172a; padding: 14px; border-radius: 10px; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; color: #4ade80; margin: 8px 0; overflow-x: auto; border: 1px solid #334155; white-space: pre-wrap; word-break: break-all; }
.cmd-section { margin-bottom: 16px; }
.cmd-label { color: #fbbf24; font-size: 13px; margin-bottom: 4px; }
.progress-bar { width: 100%; height: 8px; background: #334155; border-radius: 4px; overflow: hidden; margin-top: 8px; }
.progress-bar .fill { height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); transition: width 0.3s; }
.batch-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.setting-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.setting-row label { color: #94a3b8; font-size: 14px; min-width: 80px; }
.setting-row input { flex: 1; margin-bottom: 0; }
@media (max-width: 500px) {
  .container { padding: 16px; }
  .actions { flex-direction: column; }
  .btn { width: 100%; text-align: center; }
  .file-actions { justify-content: flex-start; }
  .setting-row { flex-direction: column; align-items: stretch; }
  .setting-row label { min-width: auto; }
  .hero-content { flex-direction: column; }
  .hero-qr { order: -1; }
  .hero-url { flex-direction: column; }
}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>ShareTool</h1>
    <p class="subtitle" id="serverInfo">加载中...</p>
  </header>

  <div class="hero">
    <div class="hero-content">
      <div class="hero-text">
        <div class="hero-title">📡 局域网文件/文字分享</div>
        <div class="hero-desc">在同一 WiFi 网络下，扫码即可用手机访问本页面，分享文字或文件。</div>
        <div class="hero-features">
          <span class="hero-feature">📝 文字分享</span>
          <span class="hero-feature">📁 文件上传</span>
          <span class="hero-feature">⬇️ 一键下载</span>
          <span class="hero-feature">📱 扫码访问</span>
        </div>
        <div class="hero-url">
          <input type="text" id="shareUrl" readonly value="">
          <button class="btn-copy" onclick="copyUrl()">复制</button>
        </div>
      </div>
      <div class="hero-qr">
        <img id="qrCode" src="" alt="QR Code">
        <div class="hero-qr-tip">手机扫码访问</div>
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
    <div class="batch-actions">
      <button class="btn btn-sm" onclick="downloadAll()">一键下载全部</button>
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
    <div class="section-title">命令行使用</div>

    <div class="cmd-section">
      <div class="cmd-label">1. 查看文件列表</div>
      <div class="code-box">curl http://${LOCAL_IP}:${PORT}/api/list \\
  -H "x-auth-token: ${AUTH_TOKEN}"</div>
    </div>

    <div class="cmd-section">
      <div class="cmd-label">2. 上传文字</div>
      <div class="code-box">curl -X POST http://${LOCAL_IP}:${PORT}/api/upload \\
  -H "Content-Type: application/json" \\
  -H "x-auth-token: ${AUTH_TOKEN}" \\
  -d '{"filename":"note.txt","content":"Hello World","type":"text"}'</div>
    </div>

    <div class="cmd-section">
      <div class="cmd-label">3. 上传文件（Base64）</div>
      <div class="code-box"># 先将文件转为 Base64
CONTENT=$(base64 -i /path/to/file.png)

curl -X POST http://${LOCAL_IP}:${PORT}/api/upload \\
  -H "Content-Type: application/json" \\
  -H "x-auth-token: ${AUTH_TOKEN}" \\
  -d '{"filename":"file.png","content":"'"$CONTENT"'","type":"file"}'</div>
    </div>

    <div class="cmd-section">
      <div class="cmd-label">4. 读取最新文字</div>
      <div class="code-box">curl http://${LOCAL_IP}:${PORT}/api/latest/text \\
  -H "x-auth-token: ${AUTH_TOKEN}"</div>
    </div>

    <div class="cmd-section">
      <div class="cmd-label">5. 读取指定文件内容</div>
      <div class="code-box">curl http://${LOCAL_IP}:${PORT}/api/content/文件名 \\
  -H "x-auth-token: ${AUTH_TOKEN}"</div>
    </div>

    <div class="cmd-section">
      <div class="cmd-label">6. 下载文件</div>
      <div class="code-box">curl -o saveas.txt \\
  http://${LOCAL_IP}:${PORT}/download/文件名</div>
    </div>

    <div class="cmd-section">
      <div class="cmd-label">7. 一键下载到本地目录（服务端）</div>
      <div class="code-box">curl -X POST http://${LOCAL_IP}:${PORT}/api/download-one \\
  -H "Content-Type: application/json" \\
  -H "x-auth-token: ${AUTH_TOKEN}" \\
  -d '{"filename":"文件.txt","downloadDir":"/Users/guige/Downloads"}'</div>
    </div>

    <div class="cmd-section">
      <div class="cmd-label">8. 设置下载目录</div>
      <div class="code-box">curl -X POST http://${LOCAL_IP}:${PORT}/api/config \\
  -H "Content-Type: application/json" \\
  -H "x-auth-token: ${AUTH_TOKEN}" \\
  -d '{"downloadDir":"/Users/guige/Downloads/ShareTool"}'</div>
    </div>

    <div class="cmd-section">
      <div class="cmd-label">9. 删除指定文件</div>
      <div class="code-box">curl -X DELETE \\
  "http://${LOCAL_IP}:${PORT}/api/file/文件名" \\
  -H "x-auth-token: ${AUTH_TOKEN}"</div>
    </div>

    <div class="cmd-section">
      <div class="cmd-label">10. 删除1周前的文件</div>
      <div class="code-box">curl -X DELETE \\
  "http://${LOCAL_IP}:${PORT}/api/delete-old?days=7" \\
  -H "x-auth-token: ${AUTH_TOKEN}"</div>
    </div>

    <div class="cmd-section">
      <div class="cmd-label">11. 删除1月前的文件</div>
      <div class="code-box">curl -X DELETE \\
  "http://${LOCAL_IP}:${PORT}/api/delete-old?days=30" \\
  -H "x-auth-token: ${AUTH_TOKEN}"</div>
    </div>

    <div class="cmd-section">
      <div class="cmd-label">12. 删除所有文件</div>
      <div class="code-box">curl -X DELETE \\
  http://${LOCAL_IP}:${PORT}/api/delete-all \\
  -H "x-auth-token: ${AUTH_TOKEN}"</div>
    </div>
  </div>
</div>

<script>
const API = '';
const TOKEN = '${AUTH_TOKEN}';
let currentFiles = [];
let config = {};

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

async function loadConfig() {
  // 从 localStorage 加载客户端配置
  const localDownloadDir = localStorage.getItem('shareTool_downloadDir') || '';
  document.getElementById('downloadDir').value = localDownloadDir;
  config.downloadDir = localDownloadDir;
}

async function saveDownloadDir() {
  const dir = document.getElementById('downloadDir').value.trim();
  localStorage.setItem('shareTool_downloadDir', dir);
  config.downloadDir = dir;
  showAlert('listAlert', '下载目录已保存（仅本机有效）', 'success');
}

async function loadFiles() {
  try {
    const res = await fetch(API + '/api/list', { headers: { 'x-auth-token': TOKEN } });
    const data = await res.json();
    currentFiles = data.files || [];
    const container = document.getElementById('filesContainer');

    if (currentFiles.length === 0) {
      container.innerHTML = '<div class="empty">暂无分享内容</div>';
      return;
    }

    container.innerHTML = '<div class="file-list">' + currentFiles.map(f => {
      const isText = isTextFile(f.name);
      return '<div class="file-item">' +
        '<div class="file-content">' +
          '<div class="file-name">' + escapeHtml(f.name) + '</div>' +
          '<div class="file-meta">' + formatSize(f.size) + ' | ' + new Date(f.time).toLocaleString() + '</div>' +
          (isText ? '<div class="file-preview" id="preview-' + btoaSafe(f.name).substring(0,20) + '"></div>' : '') +
        '</div>' +
        '<div class="file-actions">' +
          '<button class="btn btn-sm" onclick="copyContent(\\'' + encodeURIComponent(f.name) + '\\')">复制</button>' +
          '<button class="btn btn-sm" onclick="downloadFile(\\'' + encodeURIComponent(f.name) + '\\')">下载</button>' +
          '<button class="btn btn-sm btn-danger" onclick="deleteFile(\\'' + encodeURIComponent(f.name) + '\\')">删除</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';

    for (const f of currentFiles) {
      if (isTextFile(f.name) && f.size < 50000) {
        loadPreview(f.name);
      }
    }
  } catch (e) {
    document.getElementById('filesContainer').innerHTML = '<div class="empty">加载失败</div>';
  }
}

function isTextFile(name) {
  const textExts = ['.txt','.js','.py','.json','.md','.html','.css','.log','.xml','.yaml','.yml','.sh','.c','.cpp','.h','.java','.go','.rs','.sql','.toml','.ini','.cfg','.conf'];
  return textExts.some(ext => name.endsWith(ext)) || !name.includes('.');
}

function btoaSafe(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(match, p1) {
    return String.fromCharCode(parseInt(p1, 16));
  }));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadPreview(filename) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), {
      headers: { 'x-auth-token': TOKEN }
    });
    const data = await res.json();
    const el = document.getElementById('preview-' + btoaSafe(filename).substring(0,20));
    if (el && data.content) {
      el.textContent = data.content.substring(0, 300) + (data.content.length > 300 ? '...' : '');
    }
  } catch (e) {}
}

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
      headers: { 'Content-Type': 'application/json', 'x-auth-token': TOKEN },
      body: JSON.stringify({ filename, content, type: 'text' })
    });
    const data = await res.json();
    if (data.success) {
      showAlert('textAlert', '分享成功！', 'success');
      document.getElementById('textContent').value = '';
      loadFiles();
    } else {
      showAlert('textAlert', '失败: ' + data.error, 'error');
    }
  } catch (e) {
    showAlert('textAlert', '失败: ' + e.message, 'error');
  }
}

async function uploadFiles(files) {
  for (const file of files) {
    showAlert('uploadAlert', '上传中: ' + file.name, 'info');
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result.split(',')[1];
      const res = await fetch(API + '/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': TOKEN },
        body: JSON.stringify({ filename: file.name, content: base64, type: 'file', originalName: file.name })
      });
      const data = await res.json();
      if (data.success) {
        showAlert('uploadAlert', '上传成功: ' + file.name, 'success');
        loadFiles();
      } else {
        showAlert('uploadAlert', '失败: ' + data.error, 'error');
      }
    };
    reader.readAsDataURL(file);
  }
}

async function copyContent(filename) {
  try {
    const res = await fetch(API + '/api/content/' + filename, {
      headers: { 'x-auth-token': TOKEN }
    });
    const data = await res.json();
    if (data.content) {
      // 使用兼容方式复制（支持 HTTP）
      const textarea = document.createElement('textarea');
      textarea.value = data.content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        showAlert('listAlert', '内容已复制', 'success');
      } catch (e) {
        // 降级方案：使用 prompt
        prompt('复制内容:', data.content);
      }
      document.body.removeChild(textarea);
    }
  } catch (e) {
    showAlert('listAlert', '复制失败: ' + e.message, 'error');
  }
}

function downloadFile(filename) {
  window.open(API + '/download/' + filename, '_blank');
}

async function deleteFile(filename) {
  if (!confirm('确定删除?')) return;
  try {
    const res = await fetch(API + '/api/file/' + filename, {
      method: 'DELETE',
      headers: { 'x-auth-token': TOKEN }
    });
    const data = await res.json();
    if (data.success) {
      showAlert('listAlert', '已删除', 'success');
      loadFiles();
    } else {
      showAlert('listAlert', '失败: ' + data.error, 'error');
    }
  } catch (e) {
    showAlert('listAlert', '失败: ' + e.message, 'error');
  }
}

async function deleteOld(days) {
  if (!confirm('确定删除 ' + days + ' 天前的所有文件?')) return;
  try {
    const res = await fetch(API + '/api/delete-old?days=' + days, {
      method: 'DELETE',
      headers: { 'x-auth-token': TOKEN }
    });
    const data = await res.json();
    if (data.success) {
      showAlert('listAlert', '已删除 ' + data.deleted + ' 个文件', 'success');
      loadFiles();
    }
  } catch (e) {
    showAlert('listAlert', '失败: ' + e.message, 'error');
  }
}

async function deleteAll() {
  if (!confirm('确定删除所有文件? 此操作不可恢复!')) return;
  try {
    const res = await fetch(API + '/api/delete-all', {
      method: 'DELETE',
      headers: { 'x-auth-token': TOKEN }
    });
    const data = await res.json();
    if (data.success) {
      showAlert('listAlert', '已删除所有文件', 'success');
      loadFiles();
    }
  } catch (e) {
    showAlert('listAlert', '失败: ' + e.message, 'error');
  }
}

async function downloadAll() {
  if (!config.downloadDir) {
    showAlert('listAlert', '请先设置下载目录', 'error');
    return;
  }

  const progressDiv = document.getElementById('downloadProgress');
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');
  progressDiv.style.display = 'block';

  let downloaded = 0, skipped = 0, failed = 0;

  for (let i = 0; i < currentFiles.length; i++) {
    const f = currentFiles[i];
    text.textContent = '下载中 (' + (i+1) + '/' + currentFiles.length + '): ' + f.name;
    fill.style.width = ((i+1) / currentFiles.length * 100) + '%';

    try {
      const res = await fetch(API + '/api/download-one', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': TOKEN },
        body: JSON.stringify({ filename: f.name, downloadDir: config.downloadDir })
      });
      const data = await res.json();
      if (data.downloaded) downloaded++;
      else if (data.skipped) skipped++;
      else failed++;
    } catch (e) {
      failed++;
    }
  }

  text.textContent = '完成! 下载: ' + downloaded + ', 跳过: ' + skipped + ', 失败: ' + failed;
  fill.style.width = '100%';
  setTimeout(() => { progressDiv.style.display = 'none'; }, 3000);
}

function copyUrl() {
  const url = document.getElementById('shareUrl').value;
  const textarea = document.createElement('textarea');
  textarea.value = url;
  document.body.appendChild(textarea);
  textarea.select();
  try { document.execCommand('copy'); alert('链接已复制'); } catch (e) {}
  document.body.removeChild(textarea);
}

// 初始化
const shareUrl = 'http://' + window.location.hostname + ':${PORT}';
document.getElementById('serverInfo').textContent = '局域网访问 ' + shareUrl;
document.getElementById('shareUrl').value = shareUrl;
document.getElementById('qrCode').src = 'https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=' + encodeURIComponent(shareUrl);
document.getElementById('shareTextBtn').addEventListener('click', shareText);
document.getElementById('clearTextBtn').addEventListener('click', () => {
  document.getElementById('textContent').value = '';
});
document.getElementById('fileInput').addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    uploadFiles(Array.from(e.target.files));
  }
});
loadConfig().then(loadFiles);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    setCors(res);
    res.end();
    return;
  }

  setCors(res);

  const cleanPath = pathname.replace(/\/$/, '');

  if (cleanPath === '/' || cleanPath === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (cleanPath === '/api/config') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
      return;
    }
    if (req.method === 'POST') {
      let body = [];
      req.on('data', chunk => body.push(chunk));
      req.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(body).toString());
          if (data.downloadDir) {
            config.downloadDir = data.downloadDir;
            if (!fs.existsSync(config.downloadDir)) {
              fs.mkdirSync(config.downloadDir, { recursive: true });
            }
            saveConfig(config);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  if (cleanPath === '/api/list') {
    const files = fs.readdirSync(SHARE_DIR)
      .map(f => {
        const fp = path.join(SHARE_DIR, f);
        const stats = fs.statSync(fp);
        return { name: f, size: stats.size, time: stats.mtime.toISOString(), isDir: stats.isDirectory() };
      })
      .filter(f => !f.name.startsWith('.'))
      .sort((a, b) => b.time - a.time);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files }));
    return;
  }

  if (cleanPath.startsWith('/api/content/')) {
    const filename = decodeURIComponent(cleanPath.replace('/api/content/', ''));
    const filepath = path.join(SHARE_DIR, filename);
    if (!fs.existsSync(filepath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const content = fs.readFileSync(filepath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content }));
    return;
  }

  if (cleanPath === '/api/latest/text') {
    try {
      const files = fs.readdirSync(SHARE_DIR)
        .filter(f => f.endsWith('.txt') && !f.startsWith('.'))
        .map(f => ({ name: f, time: fs.statSync(path.join(SHARE_DIR, f)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);
      if (files.length > 0) {
        const filepath = path.join(SHARE_DIR, files[0].name);
        const content = fs.readFileSync(filepath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ filename: files[0].name, content }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No text files' }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (cleanPath.startsWith('/api/delete-old') && req.method === 'DELETE') {
    const days = parseInt(cleanPath.replace('/api/delete-old?days=', '')) || 7;
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    try {
      const files = fs.readdirSync(SHARE_DIR);
      let deleted = 0;
      for (const f of files) {
        const fp = path.join(SHARE_DIR, f);
        const stats = fs.statSync(fp);
        if (stats.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          deleted++;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, deleted }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (cleanPath === '/api/delete-all' && req.method === 'DELETE') {
    try {
      const files = fs.readdirSync(SHARE_DIR);
      let deleted = 0;
      for (const f of files) {
        if (!f.startsWith('.')) {
          fs.unlinkSync(path.join(SHARE_DIR, f));
          deleted++;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, deleted }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (cleanPath === '/api/download-one' && req.method === 'POST') {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      try {
        const { filename, downloadDir } = JSON.parse(Buffer.concat(body).toString());
        const srcPath = path.join(SHARE_DIR, filename);
        if (!fs.existsSync(srcPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File not found' }));
          return;
        }
        const destPath = path.join(downloadDir, filename);
        if (fs.existsSync(destPath)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, skipped: true }));
          return;
        }
        fs.copyFileSync(srcPath, destPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, downloaded: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && cleanPath === '/api/upload') {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(body).toString());
        const { filename, content, type, originalName } = data;

        let safeName = originalName || filename;
        if (fs.existsSync(path.join(SHARE_DIR, safeName))) {
          const ext = path.extname(safeName);
          const base = path.basename(safeName, ext);
          safeName = `${base}_${Date.now()}${ext}`;
        }

        const filepath = path.join(SHARE_DIR, safeName);

        if (type === 'text') {
          fs.writeFileSync(filepath, content, 'utf8');
        } else {
          fs.writeFileSync(filepath, Buffer.from(content, 'base64'));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, file: safeName, url: `/download/${safeName}` }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'DELETE' && cleanPath.startsWith('/api/file/')) {
    const filename = decodeURIComponent(cleanPath.replace('/api/file/', ''));
    const filepath = path.join(SHARE_DIR, filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
    return;
  }

  if (cleanPath.startsWith('/download/')) {
    const filename = decodeURIComponent(cleanPath.replace('/download/', ''));
    const filepath = path.join(SHARE_DIR, filename);
    if (!fs.existsSync(filepath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const stats = fs.statSync(filepath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Length': stats.size
    });
    fs.createReadStream(filepath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ShareTool running at http://${LOCAL_IP}:${PORT}`);
  console.log(`Download dir: ${config.downloadDir}`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  saveConfig(config);
  server.close();
  process.exit(0);
});
