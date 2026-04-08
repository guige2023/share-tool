#!/usr/bin/env node
/**
 * ShareTool - SQLite 数据层
 * 提供文件、设备、同步、Token、审计日志的持久化
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = path.join(os.homedir(), '.share-tool', 'share-tool.db');

let db = null;

function getDb() {
  if (!db) {
    const dbDir = path.dirname(DB_PATH);
    const fs = require('fs');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

// ============================================================
// 初始化数据库
// ============================================================
function initDatabase() {
  const db = getDb();

  // 文件表
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      filename     TEXT    NOT NULL UNIQUE,
      content      TEXT,
      type         TEXT    NOT NULL DEFAULT 'file',
      size         INTEGER NOT NULL DEFAULT 0,
      hash         TEXT,
      tags         TEXT    DEFAULT '',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // 设备表（用于多设备同步）
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id    TEXT    NOT NULL UNIQUE,
      device_name  TEXT,
      ip           TEXT,
      port         INTEGER DEFAULT 18790,
      last_seen    INTEGER NOT NULL DEFAULT (unixepoch()),
      is_online    INTEGER NOT NULL DEFAULT 1
    )
  `);

  // 同步日志表（增量同步用）
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id      INTEGER,
      filename     TEXT,
      action       TEXT    NOT NULL,
      hash         TEXT,
      timestamp    INTEGER NOT NULL DEFAULT (unixepoch()),
      device_id    TEXT,
      synced       INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL
    )
  `);

  // Token 表（动态 Token + 刷新机制）
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token         TEXT    NOT NULL UNIQUE,
      refresh_token TEXT,
      device_id     TEXT,
      expires_at    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // 审计日志表
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT    NOT NULL,
      details     TEXT,
      ip          TEXT,
      token       TEXT,
      timestamp   INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // 索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_log_timestamp ON sync_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_sync_log_synced ON sync_log(synced);
    CREATE INDEX IF NOT EXISTS idx_tokens_token ON tokens(token);
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
  `);

  console.log('[DB] Database initialized at', DB_PATH);
  return db;
}

// ============================================================
// 文件操作
// ============================================================
const FILE_FIELDS = 'id, filename, content, type, size, hash, tags, created_at, updated_at';

function addFile(filename, content, type = 'file', hash = null) {
  const db = getDb();
  const size = content ? Buffer.byteLength(content, 'utf8') : 0;
  if (!hash) {
    hash = content ? crypto.createHash('md5').update(content).digest('hex') : null;
  }
  try {
    const stmt = db.prepare(`
      INSERT INTO files (filename, content, type, size, hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `);
    const result = stmt.run(filename, content || null, type, size, hash);
    
    // 记录同步日志
    addSyncLog(null, filename, 'create', hash);
    
    return { id: result.lastInsertRowid, filename, hash, size };
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed')) {
      // 文件已存在，更新
      return updateFileByName(filename, { content, type, hash });
    }
    throw e;
  }
}

function getFileByName(filename) {
  const db = getDb();
  const row = db.prepare(`SELECT ${FILE_FIELDS} FROM files WHERE filename = ?`).get(filename);
  return row;
}

function getFile(id) {
  const db = getDb();
  return db.prepare(`SELECT ${FILE_FIELDS} FROM files WHERE id = ?`).get(id);
}

function listFiles(limit = 100, offset = 0) {
  const db = getDb();
  const files = db.prepare(`
    SELECT ${FILE_FIELDS} FROM files
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  
  const total = db.prepare('SELECT COUNT(*) as count FROM files').get().count;
  return { files, total };
}

function updateFileByName(filename, updates) {
  const db = getDb();
  const existing = getFileByName(filename);
  if (!existing) return null;

  const fields = [];
  const values = [];
  
  if (updates.content !== undefined) {
    fields.push('content = ?');
    values.push(updates.content);
    fields.push('size = ?');
    values.push(Buffer.byteLength(updates.content, 'utf8'));
    fields.push('hash = ?');
    values.push(crypto.createHash('md5').update(updates.content).digest('hex'));
  }
  if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type); }
  if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(updates.tags); }
  
  fields.push('updated_at = unixepoch()');
  values.push(filename);

  const stmt = db.prepare(`UPDATE files SET ${fields.join(', ')} WHERE filename = ?`);
  stmt.run(...values);

  const updated = getFileByName(filename);
  addSyncLog(updated.id, filename, 'update', updated.hash);
  return updated;
}

function updateFile(id, updates) {
  const db = getDb();
  const existing = getFile(id);
  if (!existing) return null;

  const fields = [];
  const values = [];
  
  if (updates.content !== undefined) {
    fields.push('content = ?');
    values.push(updates.content);
    fields.push('size = ?');
    values.push(Buffer.byteLength(updates.content, 'utf8'));
    fields.push('hash = ?');
    values.push(crypto.createHash('md5').update(updates.content).digest('hex'));
  }
  if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type); }
  if (updates.tags !== undefined) { fields.push('tags = ?'); values.push(updates.tags); }
  if (updates.filename !== undefined) { fields.push('filename = ?'); values.push(updates.filename); }
  
  fields.push('updated_at = unixepoch()');
  values.push(id);

  const stmt = db.prepare(`UPDATE files SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  const updated = getFile(id);
  if (updated) {
    addSyncLog(updated.id, updated.filename, 'update', updated.hash);
  }
  return updated;
}

function deleteFileByName(filename) {
  const db = getDb();
  const existing = getFileByName(filename);
  if (!existing) return false;
  
  addSyncLog(existing.id, filename, 'delete', existing.hash);
  db.prepare('DELETE FROM files WHERE filename = ?').run(filename);
  return true;
}

function deleteFile(id) {
  const db = getDb();
  const existing = getFile(id);
  if (!existing) return false;
  
  addSyncLog(existing.id, existing.filename, 'delete', existing.hash);
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  return true;
}

function deleteOldFiles(days) {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  
  const oldFiles = db.prepare('SELECT * FROM files WHERE created_at < ?').all(cutoff);
  for (const f of oldFiles) {
    addSyncLog(f.id, f.filename, 'delete', f.hash);
  }
  
  const result = db.prepare('DELETE FROM files WHERE created_at < ?').run(cutoff);
  return { deleted: result.changes, files: oldFiles };
}

function deleteAllFiles() {
  const db = getDb();
  const allFiles = db.prepare('SELECT * FROM files').all();
  for (const f of allFiles) {
    addSyncLog(f.id, f.filename, 'delete', f.hash);
  }
  db.prepare('DELETE FROM files').run();
  return { deleted: allFiles.length };
}

function searchFiles(query, tags = null) {
  const db = getDb();
  let sql = `SELECT ${FILE_FIELDS} FROM files WHERE 1=1`;
  const params = [];
  
  if (query) {
    sql += ` AND (filename LIKE ? OR content LIKE ?)`;
    params.push(`%${query}%`, `%${query}%`);
  }
  if (tags) {
    const tagList = tags.split(',').map(t => t.trim());
    for (const tag of tagList) {
      sql += ` AND tags LIKE ?`;
      params.push(`%${tag}%`);
    }
  }
  
  sql += ` ORDER BY created_at DESC LIMIT 100`;
  return db.prepare(sql).all(...params);
}

function getFilesByHashSince(hash, timestamp) {
  const db = getDb();
  return db.prepare(`
    SELECT ${FILE_FIELDS} FROM files
    WHERE hash != ? AND updated_at > ?
    ORDER BY updated_at ASC
  `).all(hash, timestamp);
}

function getFileCount() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) as count FROM files').get().count;
}

// ============================================================
// 设备管理
// ============================================================
function registerDevice(deviceId, deviceName, ip, port = 18790) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO devices (device_id, device_name, ip, port, last_seen, is_online)
    VALUES (?, ?, ?, ?, unixepoch(), 1)
    ON CONFLICT(device_id) DO UPDATE SET
      device_name = excluded.device_name,
      ip = excluded.ip,
      port = excluded.port,
      last_seen = unixepoch(),
      is_online = 1
  `);
  stmt.run(deviceId, deviceName, ip, port);
  return getDevice(deviceId);
}

function getDevice(deviceId) {
  const db = getDb();
  return db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
}

function listDevices() {
  const db = getDb();
  return db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all();
}

function setDeviceOffline(deviceId) {
  const db = getDb();
  db.prepare('UPDATE devices SET is_online = 0 WHERE device_id = ?').run(deviceId);
}

function setDeviceOnline(deviceId) {
  const db = getDb();
  db.prepare('UPDATE devices SET is_online = 1, last_seen = unixepoch() WHERE device_id = ?').run(deviceId);
}

function touchDevice(deviceId) {
  const db = getDb();
  db.prepare('UPDATE devices SET last_seen = unixepoch(), is_online = 1 WHERE device_id = ?').run(deviceId);
}

function getOnlineDevices() {
  const db = getDb();
  return db.prepare('SELECT * FROM devices WHERE is_online = 1').all();
}

function cleanupStaleDevices(minutesOffline = 5) {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - minutesOffline * 60;
  db.prepare('UPDATE devices SET is_online = 0 WHERE last_seen < ?').run(cutoff);
}

// ============================================================
// 同步日志
// ============================================================
function addSyncLog(fileId, filename, action, hash, deviceId = null) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO sync_log (file_id, filename, action, hash, timestamp, device_id, synced)
    VALUES (?, ?, ?, ?, unixepoch(), ?, 0)
  `);
  stmt.run(fileId, filename, action, hash, deviceId);
}

function getUnsyncedLogs(since = 0) {
  const db = getDb();
  return db.prepare(`
    SELECT sl.*, f.filename, f.content, f.type, f.size, f.hash as current_hash
    FROM sync_log sl
    LEFT JOIN files f ON sl.file_id = f.id OR sl.filename = f.filename
    WHERE sl.timestamp > ? AND sl.synced = 0
    ORDER BY sl.timestamp ASC
  `).all(since);
}

function markLogsSynced(ids) {
  const db = getDb();
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE sync_log SET synced = 1 WHERE id IN (${placeholders})`).run(...ids);
}

function getSyncStatus() {
  const db = getDb();
  const unsynced = db.prepare('SELECT COUNT(*) as count FROM sync_log WHERE synced = 0').get().count;
  const total = db.prepare('SELECT COUNT(*) as count FROM sync_log').get().count;
  return { unsynced, total };
}

// ============================================================
// Token 管理
// ============================================================
function generateToken(deviceId = null, expiresInSeconds = 86400) {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

  // 删除旧 Token
  if (deviceId) {
    db.prepare('DELETE FROM tokens WHERE device_id = ?').run(deviceId);
  }

  const stmt = db.prepare(`
    INSERT INTO tokens (token, refresh_token, device_id, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(token, refreshToken, deviceId, expiresAt);

  return { token, refreshToken, expiresAt };
}

function validateToken(token) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tokens WHERE token = ?').get(token);
  if (!row) return null;
  
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) {
    db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
    return null;
  }
  
  return row;
}

function refreshToken(refreshToken) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tokens WHERE refresh_token = ?').get(refreshToken);
  if (!row) return null;

  const newToken = crypto.randomBytes(32).toString('hex');
  const newRefreshToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days

  db.prepare(`
    UPDATE tokens SET token = ?, refresh_token = ?, expires_at = ?
    WHERE refresh_token = ?
  `).run(newToken, newRefreshToken, expiresAt, refreshToken);

  return { token: newToken, refreshToken: newRefreshToken, expiresAt };
}

function revokeToken(token) {
  const db = getDb();
  db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
}

function revokeAllTokens() {
  const db = getDb();
  db.prepare('DELETE FROM tokens').run();
}

// ============================================================
// 审计日志
// ============================================================
function addAuditLog(action, details = null, ip = null, token = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (action, details, ip, token, timestamp)
    VALUES (?, ?, ?, ?, unixepoch())
  `).run(action, details, ip, token);
}

function listAuditLogs(limit = 100, offset = 0) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function getAuditStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM audit_log').get().count;
  const today = Math.floor(new Date().setHours(0,0,0,0) / 1000);
  const todayCount = db.prepare('SELECT COUNT(*) as count FROM audit_log WHERE timestamp >= ?').get(today).count;
  return { total, todayCount };
}

// ============================================================
// 迁移旧文件（从文件系统迁移到数据库）
// ============================================================
function migrateFromFileSystem(shareDir) {
  const fs = require('fs');
  const db = getDb();
  
  if (!fs.existsSync(shareDir)) return { migrated: 0 };

  const files = fs.readdirSync(shareDir);
  let migrated = 0;

  for (const filename of files) {
    const filePath = path.join(shareDir, filename);
    const stat = fs.statSync(filePath);
    
    if (stat.isFile()) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const type = isTextFile(filename) ? 'text' : 'file';
        addFile(filename, content, type);
        migrated++;
      } catch (e) {
        // 二进制文件或其他问题，跳过
      }
    }
  }

  console.log(`[DB] Migrated ${migrated} files from ${shareDir}`);
  return { migrated };
}

function isTextFile(filename) {
  const textExts = ['.txt','.js','.py','.json','.md','.html','.css','.log','.xml','.yaml','.yml','.sh','.c','.cpp','.h','.java','.go','.rs','.sql','.toml','.ini','.cfg','.conf'];
  return textExts.some(ext => filename.endsWith(ext)) || !filename.includes('.');
}

module.exports = {
  initDatabase,
  getDb,
  // 文件
  addFile, getFile, getFileByName, listFiles, updateFile, updateFileByName,
  deleteFile, deleteFileByName, deleteOldFiles, deleteAllFiles,
  searchFiles, getFilesByHashSince, getFileCount,
  // 设备
  registerDevice, getDevice, listDevices, setDeviceOffline, setDeviceOnline,
  touchDevice, getOnlineDevices, cleanupStaleDevices,
  // 同步
  addSyncLog, getUnsyncedLogs, markLogsSynced, getSyncStatus,
  // Token
  generateToken, validateToken, refreshToken, revokeToken, revokeAllTokens,
  // 审计
  addAuditLog, listAuditLogs, getAuditStats,
  // 迁移
  migrateFromFileSystem
};
