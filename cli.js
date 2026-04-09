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
    console.log(`📡 断点续传: ${fileName} (${receivedChunks.length}/${totalChunks} 已上传)`);
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
    console.log(`⬆️  开始上传: ${fileName} (${chunkCount} 个分片)`);
  }

  // 2. 上传缺失的分片
  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
  for (let i = 0; i < totalChunks; i++) {
    if (receivedChunks.includes(i)) continue; // 跳过已上传的

    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalSize);
    const chunkContent = fileContent.slice(start, end).toString('base64');

    const chunkRes = await request('POST', '/api/upload/chunk', {
      body: JSON.stringify({ uploadId, chunkIndex: i, content: chunkContent })
    });

    if (chunkRes.status !== 200 || !chunkRes.data.success) {
      throw new Error(`分片 ${i} 上传失败: ${chunkRes.data.error || chunkRes.status}`);
    }
    process.stdout.write(`\r   进度: ${i + 1}/${totalChunks} 分片`);
  }
  console.log('\r   进度: 100%');

  // 3. 完成上传
  const completeRes = await request('POST', '/api/upload/complete', {
    body: JSON.stringify({ uploadId })
  });
  if (completeRes.status !== 200 || !completeRes.data.success) {
    throw new Error(`完成上传失败: ${completeRes.data.error}`);
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

function downloadFile(name, outputDir) {
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
      res.pipe(writeStream);

      writeStream.on('finish', () => {
        resolve({ status: res.statusCode, data: { saved: outputPath } });
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
    console.log('  list           List all files');
    console.log('  upload <file>  Upload a single file');
    console.log('  upload-dir <dir>  Upload all files in a directory');
    console.log('  download <name> [-o dir]  Download a file');
    console.log('  delete <name>  Delete a file');
    console.log('  copy <src> <dest>  Copy a file to a new name');
    console.log('  batch-delete <name1> [name2] ...  Delete multiple files');
    console.log('  batch-tag <tag> [files...]        Add tag to files (alias: share-tool batch-tag add <tag> [files])');
    console.log('  batch-tag remove <tag> [files]   Remove tag from files');
    console.log('  batch-tag set <tag> [files]       Set (replace) tag on files');
    console.log('  search <query> Search files');
    console.log('  share <text>   Share text snippet');
    console.log('  sync           Trigger sync push');
    console.log('  stats          Show storage stats');
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
        const res = await request('GET', '/api/list');
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        printJson(res.data);
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
        const res = await downloadFile(name, outputDir);
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        printJson(res.data);
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

      case 'search': {
        const query = args.slice(1).join(' ');
        if (!query) {
          printError('Search query required');
          process.exit(1);
        }
        const res = await request('GET', `/api/search?q=${encodeURIComponent(query)}`);
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        printJson(res.data);
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

      case 'stats': {
        const res = await request('GET', '/api/db/stats');
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          process.exit(1);
        }
        const s = res.data;
        console.log(`Files:    ${s.fileCount || 0}`);
        console.log(`Storage:  ${((s.totalSize || 0) / 1024).toFixed(1)} KB`);
        console.log(`Tokens:   ${s.tokenCount || 0}`);
        console.log(`Shares:   ${s.shareCount || 0}`);
        console.log(`Devices:  ${s.deviceCount || 0}`);
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
