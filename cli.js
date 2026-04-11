#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const readline = require('readline');
const crypto = require('crypto');

const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.share-tool', 'config.json');
const HISTORY_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.share-tool', 'history');
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
  return new Promise((resolve, reject) => {
    const serverUrl = getServerUrl();
    const parsedUrl = parseUrl(serverUrl, endpoint);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const token = getToken();
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

    if (options.body) {
      req.write(options.body);
    }
    req.end();
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
    console.log('  download <name> [-o dir]  Download a file');
    console.log('  delete <name>  Delete a file');
    console.log('  copy <src> <dest>  Copy a file to a new name');
    console.log('  rename <old> <new>  Rename a file');
    console.log('  batch-delete <name1> [name2] ...  Delete multiple files');
    console.log('  batch-download <name1> [name2] .. Download multiple files [-o <dir>]');
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
    console.log('  sync           Trigger sync push');
    console.log('  status         Check if server is online');
    console.log('  open           Open server URL in browser');
    console.log('  log [--limit=n] [--action=x] [--date=YYYY-MM-DD] [-f]  Show audit logs (-f: follow)');
    console.log('  stats          Show storage stats');
    console.log('  recent [n]     Show recently modified files (default: 10)');
    console.log('  trash [list|restore <id>|delete <id>|empty]  Manage trash');
    console.log('  share-list     List all active share links');
    console.log('  share-delete <code>  Delete a share link');
    console.log('  share-extend <code> [hours]  Extend expiry (default 168h)');
    console.log('  share-password <code> [pwd]  Set/remove password');
    console.log('  diff <filename> [v1] [v2]  Compare file versions');
    console.log('  export [-o dir]  Export all files to local directory');
    console.log('  token          Show current token');
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
        const names = args.slice(1);
        if (names.length === 0) {
          printError('At least one file name required');
          process.exit(1);
        }
        let outputDir = '.';
        const oIndex = names.indexOf('-o');
        if (oIndex !== -1) {
          if (oIndex + 1 >= names.length) { printError('-o requires output directory'); process.exit(1); }
          outputDir = names[oIndex + 1];
          names.splice(oIndex, 2);
        }
        if (names.length === 0) { printError('No files specified'); process.exit(1); }
        console.log('Downloading ' + names.length + ' file(s) to ' + outputDir + '/...\n');
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
        let overallDone = 0;
        for (const name of names) {
          const startTime = Date.now();
          let fileDone = false;
          let lastPct = -1;

          const progressCallback = (downloaded, total, fname) => {
            const pct = downloaded / total;
            if (Math.floor(pct * 10) > Math.floor(lastPct * 10) || pct >= 1) {
              lastPct = pct;
              const speed = downloaded / ((Date.now() - startTime) / 1000);
              process.stdout.write('\r  ' + renderBar(pct) + ' ' + formatBytes(downloaded) + '/' + formatBytes(total) + ' ' + Math.round(pct * 100) + '% ' + formatBytes(speed) + '/s   \n');
            }
            fileDone = true;
          };

          process.stdout.write('  ▼ ' + name + '\n');
          try {
            const res = await downloadFile(name, outputDir, progressCallback);
            if (res.status < 400) {
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              const size = formatBytes(res.data.size || 0);
              console.log('  ✓ ' + name + ' ' + size + ' in ' + elapsed + 's\n');
              success++;
            } else {
              console.log('  ✗ ' + name + ' FAILED (' + res.status + ')\n');
              failed++;
            }
          } catch (e) {
            console.log('  ✗ ' + name + ' ERROR: ' + e.message + '\n');
            failed++;
          }
          overallDone++;
        }
        console.log('Done: ' + success + ' succeeded, ' + failed + ' failed');
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
        console.log('Triggering sync...');
        const res = await request('POST', '/api/sync/push', { body: '{}', contentType: 'application/json' });
        if (res.status >= 400) {
          printError(`Sync failed: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        printJson(res.data);
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
        const res = await request('GET', '/api/duplicates');
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          process.exit(1);
        }
        const { count, duplicates } = res.data;
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
