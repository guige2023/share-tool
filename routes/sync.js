/**
 * routes/sync.js - WebSocket-based real-time sync protocol
 * 
 * Devices connect via WebSocket (upgrade from HTTP) to:
 * 1. Register as a device
 * 2. Broadcast file changes (create/update/delete/rename)
 * 3. Push changes to server (sync_push)
 * 4. Receive nudges to pull changes (sync_nudge)
 */

const { WebSocketServer } = require('ws');
const url = require('url');

// Device registry: deviceId -> { ws, lastPing, deviceName }
const devices = new Map();

// Periodic heartbeat cleanup
let heartbeatInterval = null;

function initWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade requests — only for /ws path
  server.on('upgrade', (request, socket, head, callback) => {
    const parsed = new URL(request.url, `https://${request.headers.host}`);
    if (parsed.pathname !== '/ws') {
      socket.destroy();
      return callback && callback(new Error('Only /ws endpoint supported'));
    }
    
    // Auth via token query param: /ws?token=xxx
    const token = parsed.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.token = token;
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    let deviceId = null;
    let isAlive = true;

    ws.on('pong', () => { isAlive = true; });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(ws, msg, (response) => {
          ws.send(JSON.stringify(response));
        }, (broadcastMsg) => {
          broadcastToOthers(broadcastMsg, deviceId);
        }, (devId) => getDeviceWs(devId));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      if (deviceId) {
        const dev = devices.get(deviceId);
        if (dev) dev.isOnline = false;
        devices.delete(deviceId);
        broadcastDeviceList();
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  });

  // Heartbeat: ping all clients every 30s, remove dead ones
  heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  });

  return wss;
}

function handleMessage(ws, msg, reply, broadcast, getWsForDevice) {
  const { type, payload = {} } = msg;
  const db = require('../db');

  switch (type) {
    case 'register': {
      // { deviceId, deviceName }
      const { deviceId, deviceName } = payload;
      if (!deviceId) return reply({ type: 'register_ack', success: false, error: 'deviceId required' });
      
      ws.deviceId = deviceId;
      devices.set(deviceId, { ws, deviceName: deviceName || 'Unknown', isOnline: true, lastSeen: Date.now() });
      broadcastDeviceList();
      
      // Send current file list as initial state
      const files = db.listFiles(500);
      reply({ type: 'register_ack', success: true, deviceId, files });
      break;
    }

    case 'sync_push': {
      // { changes: [{action, filename, content, hash, type, base_hash}] }
      // base_hash: the hash the device last saw (used for conflict detection)
      const { changes = [] } = payload;
      const processed = [];
      const conflicts = [];

      for (const change of changes) {
        if (change.action === 'create' || change.action === 'update') {
          const existing = db.getFileByName(change.filename);
          let result;

          // Conflict detection: if file exists and base_hash is provided,
          // check if server has a newer version the device hasn't seen
          if (existing && change.base_hash) {
            if (change.base_hash !== existing.hash) {
              // Server has a different version than what device saw — potential conflict
              // Only flag as conflict if the incoming change also differs from what server has
              // (i.e., both sides independently modified the same file)
              if (change.hash !== existing.hash) {
                // CONFLICT: both remote server and local device modified the file
                const conflict = db.addSyncConflict(
                  change.filename,
                  change.hash,           // local_hash: what device is trying to push
                  existing.hash,         // remote_hash: what server currently has
                  change.content,        // local_content
                  existing.content,      // remote_content
                  ws.deviceId,          // local_device_id
                  null                   // remote_device_id (unknown)
                );
                conflicts.push({
                  action: change.action,
                  filename: change.filename,
                  conflictId: conflict.id,
                  localHash: change.hash,
                  remoteHash: existing.hash,
                  localContent: change.content ? '(binary)' : null,  // Don't send full content in ack
                  remoteContent: existing.content ? '(binary)' : null,
                });
                continue; // Skip processing this change until conflict is resolved
              }
            }
          }

          if (existing) {
            db.updateFileByName(change.filename, { content: change.content, type: change.type || existing.type });
            result = db.getFileByName(change.filename);
          } else {
            result = db.addFile(change.filename, change.content, change.type || 'text');
          }
          if (result) {
            processed.push({ action: change.action, id: result.id, filename: result.filename });
            // Log to sync_log for cross-device consistency
            db.addSyncLog(result.id, result.filename, change.action, result.hash, ws.deviceId, result.size || 0);
          }
        } else if (change.action === 'delete') {
          const existing = db.getFileByName(change.filename);
          if (existing) {
            db.deleteFileByName(change.filename);
            processed.push({ action: 'delete', id: existing.id, filename: change.filename });
            db.addSyncLog(existing.id, existing.filename, 'delete', existing.hash, ws.deviceId, existing.size || 0);
          }
        } else if (change.action === 'rename') {
          const { oldFilename, newFilename } = change;
          const result = db.renameFile(oldFilename, newFilename);
          if (result.success) {
            const existing = db.getFileByName(newFilename);
            processed.push({ action: 'rename', oldFilename, newFilename, id: existing ? existing.id : null });
            db.addSyncLog(existing ? existing.id : null, newFilename, 'rename', existing ? existing.hash : null, ws.deviceId, existing ? (existing.size || 0) : 0);
          }
        }
      }

      const response = { type: 'sync_ack', processed, conflicts };
      if (conflicts.length > 0) response.warning = 'Conflicts detected — resolve before retry';
      reply(response);

      // Broadcast to other WebSocket devices
      for (const p of processed) {
        broadcast({
          type: p.action === 'create' ? 'file_create' : p.action === 'delete' ? 'file_delete' : 'file_update',
          payload: p
        });
      }
      // Also notify SSE clients (web UI) so they refresh file list
      if (processed.length > 0 && global.broadcastSSE) {
        global.broadcastSSE({ type: 'files_changed' });
      }
      break;
    }

    case 'sync_request': {
      // Pull all unsynced changes since lastSyncTs
      const { since = 0 } = payload;
      const logs = db.getUnsyncedLogs(since);
      reply({ type: 'sync_response', payload: { logs } });
      break;
    }

    case 'sync_nudge': {
      // Another device nudged us — pull changes from server
      const lastSyncTs = payload.lastSyncTs || 0;
      const logs = db.getUnsyncedLogs(lastSyncTs);
      if (logs.length > 0) {
        reply({ type: 'sync_response', payload: { logs } });
      } else {
        reply({ type: 'sync_ack', payload: { pulled: 0 } });
      }
      break;
    }

    case 'ping': {
      reply({ type: 'pong', payload: { ts: Date.now() } });
      break;
    }

    default:
      reply({ type: 'error', error: `Unknown message type: ${type}` });
  }
}

function broadcastToOthers(msg, excludeDeviceId) {
  const data = JSON.stringify(msg);
  for (const [devId, dev] of devices) {
    if (devId !== excludeDeviceId && dev.ws.readyState === 1 /* OPEN */) {
      dev.ws.send(data);
    }
  }
}

function broadcastToAll(msg) {
  const data = JSON.stringify(msg);
  for (const [, dev] of devices) {
    if (dev.ws.readyState === 1) {
      dev.ws.send(data);
    }
  }
}

function getDeviceWs(deviceId) {
  const dev = devices.get(deviceId);
  return dev && dev.ws.readyState === 1 ? dev.ws : null;
}

function broadcastDeviceList() {
  const list = [];
  for (const [id, dev] of devices) {
    list.push({ deviceId: id, deviceName: dev.deviceName, isOnline: dev.isOnline });
  }
  broadcastToAll({ type: 'device_list', payload: { devices: list } });
}

module.exports = { initWebSocketServer };
