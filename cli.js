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
    const parsedUrl = parseUrl(serverUrl, '/upload');
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const token = getToken();
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);

    const boundary = crypto.randomBytes(16).toString('hex');
    let body = `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
    body += `Content-Type: application/octet-stream\r\n\r\n`;
    body += fileContent;
    body += `\r\n--${boundary}--`;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
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
    console.log('Commands: list, upload <file>, download <name> [-o dir], delete <name>, search <query>, token, share <text>');
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

      default:
        printError(`Unknown command: ${command}`);
        console.log('Commands: list, upload <file>, download <name> [-o dir], delete <name>, search <query>, token, share <text>');
        process.exit(1);
    }
  } catch (err) {
    printError(err.message);
    process.exit(1);
  }
}

main();
