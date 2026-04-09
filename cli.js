#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const readline = require('readline');
const crypto = require('crypto');

const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.share-tool', 'config.json');
const DEFAULT_URL = 'http://localhost:18790';

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

function uploadFile(filePath) {
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
    console.log('  batch-delete <name1> [name2] ...  Delete multiple files');
    console.log('  search <query> Search files');
    console.log('  share <text>   Share text snippet');
    console.log('  sync           Trigger sync push');
    console.log('  stats          Show storage stats');
    console.log('  token          Show current token');
    process.exit(1);
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

      case 'search': {
        const query = args.slice(1).join(' ');
        if (!query) {
          printError('Search query required');
          process.exit(1);
        }
        const res = await request('GET', `/search?q=${encodeURIComponent(query)}`);
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
        const res = await request('POST', '/share', {
          body: JSON.stringify({ text }),
          contentType: 'application/json'
        });
        if (res.status >= 400) {
          printError(`Server error: ${res.status}`);
          printJson(res.data);
          process.exit(1);
        }
        printJson(res.data);
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
