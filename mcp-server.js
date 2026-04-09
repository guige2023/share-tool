#!/usr/bin/env node

/**
 * ShareTool MCP Server
 *
 * Implements the Model Context Protocol (MCP) to expose ShareTool's
 * file sharing capabilities as tools for AI agents.
 *
 * Communication: JSON-RPC 2.0 over stdio
 */

import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';
import { URL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Configuration
// Try environment variable first, then fallback to config file
let SHARE_TOKEN = process.env.SHARE_TOKEN || '';

// Fallback: Read from ~/.share-tool/config.json
if (!SHARE_TOKEN) {
  const homeDir = process.env.HOME || dirname(fileURLToPath(import.meta.url));
  const configPath = join(homeDir, '.share-tool', 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      SHARE_TOKEN = config.shareToken || '';
    } catch (e) {
      // Ignore parse errors
    }
  }
}

const SHARE_HTTP_PORT = parseInt(process.env.SHARE_HTTP_PORT || '18790', 10);
const SHARE_HTTPS_PORT = parseInt(process.env.SHARE_HTTPS_PORT || '18793', 10);
const SHARE_HOST = process.env.SHARE_HOST || 'localhost';
const USE_HTTPS = process.env.SHARE_USE_HTTPS !== 'false'; // Default to HTTPS
const BASE_URL = USE_HTTPS
  ? `https://${SHARE_HOST}:${SHARE_HTTPS_PORT}`
  : `http://${SHARE_HOST}:${SHARE_HTTP_PORT}`;

// MCP Protocol constants
const MCP_PROTOCOL_VERSION = '2024-11-05';

// Tool definitions
const TOOL_DEFINITIONS = [
  {
    name: 'list_files',
    description: 'List all files with optional filtering and pagination',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results to return (default 100)' },
        offset: { type: 'number', description: 'Number of results to skip' },
        sort: { type: 'string', description: 'Sort field: created_at, name, size' },
        order: { type: 'string', description: 'Sort order: ASC or DESC' },
        folder: { type: 'string', description: 'Filter by virtual folder path prefix' }
      }
    }
  },
  {
    name: 'upload_file',
    description: 'Upload a file or text content to ShareTool',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Name of the file' },
        content: { type: 'string', description: 'Base64 encoded file content' },
        type: { type: 'string', enum: ['file', 'text'], description: 'Content type: file or text' },
        tags: { type: 'string', description: 'Comma-separated tags for the file' }
      },
      required: ['filename', 'content']
    }
  },
  {
    name: 'get_file',
    description: 'Download and retrieve file content',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Name of the file to retrieve' }
      },
      required: ['filename']
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file from ShareTool',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Name of the file to delete' }
      },
      required: ['filename']
    }
  },
  {
    name: 'search_files',
    description: 'Search files by name or tags with fuzzy matching',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        tags: { type: 'string', description: 'Comma-separated tags to filter by' }
      },
      required: ['query']
    }
  },
  {
    name: 'create_share_link',
    description: 'Create a share link for a file with optional password and expiry',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Name of the file to share' },
        expiryHours: { type: 'number', description: 'Hours until link expires' },
        maxDownloads: { type: 'number', description: 'Maximum number of downloads allowed' },
        password: { type: 'string', description: 'Password to protect the share link' },
        description: { type: 'string', description: 'Description for the share link' }
      },
      required: ['filename']
    }
  },
  {
    name: 'get_share_link',
    description: 'Access a share link and retrieve its content',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Share link code' },
        password: { type: 'string', description: 'Password if link is protected' }
      },
      required: ['code']
    }
  },
  {
    name: 'get_storage_info',
    description: 'Get storage statistics (file count, total size)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_share_links',
    description: 'List all active share links',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'delete_share_link',
    description: 'Delete a share link',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Share link code to delete' }
      },
      required: ['code']
    }
  },
  {
    name: 'get_db_stats',
    description: 'Get database statistics and health info',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_audit_logs',
    description: 'Query audit logs for actions',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number of log entries' },
        action: { type: 'string', description: 'Filter by action type' },
        since: { type: 'string', description: 'ISO timestamp to filter from' },
        until: { type: 'string', description: 'ISO timestamp to filter until' }
      }
    }
  },
  {
    name: 'encrypt_content',
    description: 'Encrypt content with a password using AES-256-GCM',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Text content to encrypt' },
        password: { type: 'string', description: 'Encryption password' }
      },
      required: ['content', 'password']
    }
  },
  {
    name: 'decrypt_content',
    description: 'Decrypt content that was encrypted with encrypt_content',
    inputSchema: {
      type: 'object',
      properties: {
        encrypted: { type: 'string', description: 'Base64 encoded encrypted content' },
        password: { type: 'string', description: 'Decryption password' }
      },
      required: ['encrypted', 'password']
    }
  },
  {
    name: 'list_tags',
    description: 'List all tags with file counts',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'rename_file',
    description: 'Rename a file',
    inputSchema: {
      type: 'object',
      properties: {
        oldFilename: { type: 'string', description: 'Current file name' },
        newFilename: { type: 'string', description: 'New file name' }
      },
      required: ['oldFilename', 'newFilename']
    }
  },
  {
    name: 'update_file_tags',
    description: 'Update tags for a file',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Name of the file' },
        tags: { type: 'string', description: 'Comma-separated new tags' }
      },
      required: ['filename', 'tags']
    }
  },
  {
    name: 'get_devices',
    description: 'List all registered devices on the network',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_sync_status',
    description: 'Get synchronization status',
    inputSchema: { type: 'object', properties: {} }
  }
];

// Helper: Make HTTP/HTTPS request to ShareTool server
function makeRequest(method, path, body = null, queryParams = {}) {
  return new Promise((resolve, reject) => {
    // Build URL with query params
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'x-auth-token': SHARE_TOKEN,
        'Content-Type': 'application/json'
      },
      // Reject unauthorized certs (for self-signed certs)
      rejectUnauthorized: false
    };

    // Skip Content-Type for GET/DELETE requests without body
    if (!body && (method === 'GET' || method === 'DELETE')) {
      delete options.headers['Content-Type'];
    }

    // Use http or https depending on configuration
    const client = USE_HTTPS ? https : http;

    const req = client.request(options, (res) => {
      let data = '';

      // Handle streaming responses (like batch-download)
      if (res.headers['content-type'] === 'application/zip' ||
          res.headers['content-type'] === 'application/octet-stream') {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            success: true,
            contentType: res.headers['content-type'],
            content: buffer.toString('base64'),
            size: buffer.length
          });
        });
        res.on('error', reject);
        return;
      }

      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          // Try to parse as JSON
          if (data.startsWith('{') || data.startsWith('[')) {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } else {
            // Return as text
            resolve({ success: true, data });
          }
        } catch (e) {
          // Not JSON, return as text
          resolve({ success: true, data });
        }
      });
    });

    req.on('error', (e) => {
      reject(new Error(`Request failed: ${e.message}`));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Execute a tool by name
async function executeTool(name, args) {
  switch (name) {
    case 'list_files':
      return makeRequest('GET', '/api/list', null, args);

    case 'upload_file':
      return makeRequest('POST', '/api/upload', {
        filename: args.filename,
        content: args.content,
        type: args.type || 'file',
        tags: args.tags
      });

    case 'get_file':
      return makeRequest('GET', `/api/content/${encodeURIComponent(args.filename)}`);

    case 'delete_file':
      return makeRequest('DELETE', `/api/file/?filename=${encodeURIComponent(args.filename)}`);

    case 'search_files':
      return makeRequest('GET', '/api/search', null, {
        q: args.query,
        tags: args.tags
      });

    case 'create_share_link':
      return makeRequest('POST', '/api/share/create', {
        filename: args.filename,
        expiryHours: args.expiryHours,
        maxDownloads: args.maxDownloads,
        password: args.password,
        description: args.description
      });

    case 'get_share_link':
      return makeRequest('GET', `/s/${args.code}${args.password ? `?pwd=${args.password}` : ''}`);

    case 'get_storage_info':
      return makeRequest('GET', '/api/storage');

    case 'list_share_links':
      return makeRequest('GET', '/api/share/list');

    case 'delete_share_link':
      return makeRequest('DELETE', `/api/share/delete/${args.code}`);

    case 'get_db_stats':
      return makeRequest('GET', '/api/db/stats');

    case 'get_audit_logs':
      return makeRequest('GET', '/api/audit/logs', null, args);

    case 'encrypt_content':
      return makeRequest('POST', '/api/encrypt', {
        content: args.content,
        password: args.password
      });

    case 'decrypt_content':
      return makeRequest('POST', '/api/decrypt', {
        encrypted: args.encrypted,
        password: args.password
      });

    case 'list_tags':
      return makeRequest('GET', '/api/tags/list');

    case 'rename_file':
      return makeRequest('POST', `/api/file-rename/${encodeURIComponent(args.oldFilename)}`, {
        newFilename: args.newFilename
      });

    case 'update_file_tags':
      return makeRequest('PUT', `/api/file-tags/${encodeURIComponent(args.filename)}`, {
        tags: args.tags
      });

    case 'get_devices':
      return makeRequest('GET', '/api/devices');

    case 'get_sync_status':
      return makeRequest('GET', '/api/sync/status');

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Send JSON-RPC response
function sendResponse(response) {
  process.stdout.write(JSON.stringify(response) + '\n');
}

// Send JSON-RPC error
function sendError(id, error) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32603,
      message: error.message || 'Internal error'
    }
  }) + '\n');
}

// Handle incoming JSON-RPC message
function handleMessage(request) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'share-tool',
            version: '2.53.0'
          }
        }
      });
      break;

    case 'initialized':
      // Client finished initialization, nothing to do
      break;

    case 'shutdown':
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: { success: true }
      });
      process.exit(0);
      break;

    case 'tools/list':
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOL_DEFINITIONS
        }
      });
      break;

    case 'tools/call':
      pendingOperations++;
      executeTool(params.name, params.arguments || {})
        .then((result) => {
          pendingOperations--;
          sendResponse({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            }
          });
        })
        .catch((error) => {
          pendingOperations--;
          sendError(id, error);
        });
      break;

    default:
      sendError(id, new Error(`Method not found: ${method}`));
  }
}

// Main: Read lines from stdin and process as JSON-RPC messages
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

let pendingOperations = 0;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const request = JSON.parse(trimmed);
    handleMessage(request);
  } catch (e) {
    // Ignore malformed lines
  }
});

rl.on('close', () => {
  // Don't exit immediately if there are pending async operations
  const checkExit = () => {
    if (pendingOperations === 0) {
      process.exit(0);
    } else {
      setTimeout(checkExit, 100);
    }
  };
  checkExit();
});

// Handle stdin errors gracefully
process.stdin.on('error', () => {
  process.exit(0);
});
