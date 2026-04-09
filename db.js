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
const SCHEMA_VERSION = 2; // 当前 Schema 版本

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
// 密码哈希（使用 scrypt 防暴力破解，比 SHA-256 更安全）
// 存储格式: salt:hash（以冒号分隔）
// ============================================================
const PASSWORD_SALT_LEN = 16;
const PASSWORD_HASH_LEN = 32;

function hashPassword(password) {
  if (!password) return null;
  const salt = crypto.randomBytes(PASSWORD_SALT_LEN).toString('hex');
  const hash = crypto.scryptSync(password, salt, PASSWORD_HASH_LEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!password || !stored) return false;
  // 兼容旧明文密码（无冒号格式）
  if (!stored.includes(':')) return password === stored;
  const [salt, hash] = stored.split(':');
  const inputHash = crypto.scryptSync(password, salt, PASSWORD_HASH_LEN).toString('hex');
  return hash === inputHash;
}

// ============================================================
// Schema 版本管理
// ============================================================
function initDatabase() {
  const db = getDb();

  // 元数据表（KV 表，用于 Schema 版本等配置）
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // 获取当前 Schema 版本
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  let currentVersion = row ? parseInt(row.value, 10) : 1;

  console.log(`[DB] Schema version: ${currentVersion} → ${SCHEMA_VERSION}`);

  // 执行迁移
  if (currentVersion < SCHEMA_VERSION) {
    runMigrations(db, currentVersion);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    currentVersion = SCHEMA_VERSION;
  }

  // 如果是全新数据库（version=1 且无任何表），初始化 v1 基础结构
  const tableCount = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().c;
  if (tableCount <= 1) {
    initSchemaV1(db);
    initSchemaV2(db);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
  } else if (currentVersion === 1) {
    // 已有旧数据但未迁移，补齐 v2 字段
    initSchemaV2(db);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', 2);
  }

  console.log('[DB] Database ready at', DB_PATH);
  return db;
}

function initSchemaV1(db) {
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
      encrypted    INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // 设备表
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

  // 同步日志表
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

  // Token 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      token                TEXT    NOT NULL UNIQUE,
      refresh_token        TEXT,
      refresh_token_expires_at INTEGER,
      device_id            TEXT,
      expires_at           INTEGER NOT NULL,
      created_at           INTEGER NOT NULL DEFAULT (unixepoch())
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

  // 速率限制表（防暴力破解）
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      key           TEXT    NOT NULL UNIQUE,
      attempts      INTEGER NOT NULL DEFAULT 0,
      locked_until  INTEGER,
      last_attempt  INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // 分享链接表
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_links (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT    NOT NULL UNIQUE,
      filename      TEXT    NOT NULL,
      is_text       INTEGER NOT NULL DEFAULT 0,
      password      TEXT,
      expires_at    INTEGER NOT NULL,
      max_downloads INTEGER,
      download_count INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by    TEXT
    )
  `);

  // 标签颜色表
  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_colors (
      tag        TEXT PRIMARY KEY,
      color      TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // 添加索引：文件名（搜索）、创建时间（排序）
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at);
    CREATE INDEX IF NOT EXISTS idx_files_filename ON files(filename);
    CREATE INDEX IF NOT EXISTS idx_sync_log_timestamp ON sync_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_sync_log_synced ON sync_log(synced);
    CREATE INDEX IF NOT EXISTS idx_tokens_token ON tokens(token);
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_share_links_code ON share_links(code);
  `);

  console.log('[DB] Schema v1 initialized');
}

function initSchemaV2(db) {
  // v2 新增：sync_log.size_bytes（同步文件大小）
  try {
    db.exec("ALTER TABLE sync_log ADD COLUMN size_bytes INTEGER DEFAULT 0");
    console.log('[DB] Migrated: sync_log.size_bytes');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }

  // v2 新增：share_links.description（链接描述）
  try {
    db.exec("ALTER TABLE share_links ADD COLUMN description TEXT DEFAULT ''");
    console.log('[DB] Migrated: share_links.description');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }

  // v2 新增：tokens.refresh_token_expires_at
  try {
    db.exec("ALTER TABLE tokens ADD COLUMN refresh_token_expires_at INTEGER");
    console.log('[DB] Migrated: tokens.refresh_token_expires_at');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }

  // v2 新增：devices.preferred_sync_strategy
  try {
    db.exec("ALTER TABLE devices ADD COLUMN preferred_sync_strategy TEXT DEFAULT 'incremental'");
    console.log('[DB] Migrated: devices.preferred_sync_strategy');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }

  // v2 新增：files.content_type（MIME 类型）
  try {
    db.exec("ALTER TABLE files ADD COLUMN content_type TEXT DEFAULT 'application/octet-stream'");
    console.log('[DB] Migrated: files.content_type');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }
}

function runMigrations(db, fromVersion) {
  console.log(`[DB] Running migrations from v${fromVersion} to v${SCHEMA_VERSION}`);
  for (let v = fromVersion + 1; v <= SCHEMA_VERSION; v++) {
    if (v === 2) {
      initSchemaV2(db);
    }
    console.log(`[DB] Migration to v${v} complete`);
  }
}

// ============================================================
// 文件操作
// ============================================================
const FILE_FIELDS = 'id, filename, content, type, size, hash, tags, encrypted, created_at, updated_at';

function addFile(filename, content, type = 'file', hash = null, encrypted = false) {
  const db = getDb();
  const size = content ? Buffer.byteLength(content, 'utf8') : 0;
  if (!hash) {
    hash = content ? crypto.createHash('md5').update(content).digest('hex') : null;
  }
  try {
    const contentType = type === 'text' ? 'text/plain' : 'application/octet-stream';
    const stmt = db.prepare(`
      INSERT INTO files (filename, content, type, size, hash, encrypted, content_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `);
    const result = stmt.run(filename, content || null, type, size, hash, encrypted ? 1 : 0, contentType);
    const fileId = result.lastInsertRowid;

    // 记录同步日志（使用真实的 fileId）
    addSyncLog(fileId, filename, 'create', hash, null, size);

    return { id: fileId, filename, hash, size, encrypted };
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed')) {
      // 文件已存在，更新
      return updateFileByName(filename, { content, type, hash, encrypted });
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
  if (updates.encrypted !== undefined) { fields.push('encrypted = ?'); values.push(updates.encrypted ? 1 : 0); }

  fields.push('updated_at = unixepoch()');
  values.push(filename);

  const stmt = db.prepare(`UPDATE files SET ${fields.join(', ')} WHERE filename = ?`);
  stmt.run(...values);

  const updated = getFileByName(filename);
  addSyncLog(updated.id, filename, 'update', updated.hash, null, updated.size);
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
  if (updates.encrypted !== undefined) { fields.push('encrypted = ?'); values.push(updates.encrypted ? 1 : 0); }

  fields.push('updated_at = unixepoch()');
  values.push(id);

  const stmt = db.prepare(`UPDATE files SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  const updated = getFile(id);
  if (updated) {
    addSyncLog(updated.id, updated.filename, 'update', updated.hash, null, updated.size);
  }
  return updated;
}

function deleteFileByName(filename) {
  const db = getDb();
  const existing = getFileByName(filename);
  if (!existing) return false;

  addSyncLog(existing.id, filename, 'delete', existing.hash, null, existing.size);
  db.prepare('DELETE FROM files WHERE filename = ?').run(filename);
  return true;
}

function renameFile(oldFilename, newFilename) {
  const db = getDb();
  const existing = getFileByName(oldFilename);
  if (!existing) return { success: false, error: '文件不存在' };
  
  // 检查新文件名是否已存在
  const conflict = getFileByName(newFilename);
  if (conflict) return { success: false, error: '文件名已存在' };
  
  // 重命名
  const oldId = existing.id;
  db.prepare('UPDATE files SET filename = ?, updated_at = unixepoch() WHERE filename = ?').run(newFilename, oldFilename);
  
  // 记录同步日志
  const updated = getFileByName(newFilename);
  if (updated) {
    addSyncLog(updated.id, newFilename, 'rename', updated.hash, null, updated.size);
  }
  
  return { success: true, oldFilename, newFilename, hash: updated ? updated.hash : null };
}

function deleteFile(id) {
  const db = getDb();
  const existing = getFile(id);
  if (!existing) return false;
  
  addSyncLog(existing.id, existing.filename, 'delete', existing.hash, null, existing.size);
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  return true;
}

function deleteOldFiles(days) {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

  const oldFiles = db.prepare('SELECT * FROM files WHERE created_at < ?').all(cutoff);
  for (const f of oldFiles) {
    addSyncLog(f.id, f.filename, 'delete', f.hash, null, f.size);
  }
  
  const result = db.prepare('DELETE FROM files WHERE created_at < ?').run(cutoff);
  return { deleted: result.changes, files: oldFiles };
}

function deleteAllFiles() {
  const db = getDb();
  const allFiles = db.prepare('SELECT * FROM files').all();
  for (const f of allFiles) {
    addSyncLog(f.id, f.filename, 'delete', f.hash, null, f.size);
  }
  db.prepare('DELETE FROM files').run();
  return { deleted: allFiles.length };
}

/**
 * 智能分词 - 分离中英文混合查询词
 * 中文按字符切分，英文按空格/特殊字符切分
 */
function tokenizeQuery(query) {
  if (!query || !query.trim()) return [];
  const tokens = [];
  // Chinese characters (Unicode range 4E00-9FFF)
  const chinese = query.match(/[\u4e00-\u9fff]/g) || [];
  tokens.push(...chinese);
  // English words (alphanumeric + underscore)
  const english = query.match(/[a-zA-Z0-9_]{2,}/g) || [];
  tokens.push(...english.map(w => w.toLowerCase()));
  return tokens.filter(t => t.length > 0);
}

/**
 * 模糊评分搜索 - 基于 tokens 的加权匹配
 * 优先级: 文件名开头匹配 > 文件名包含 > tags包含 > 分数降序
 */
function searchFiles(query, tags = null, opts = {}) {
  const db = getDb();
  const { limit = 100, fuzzy = true } = opts;

  if (!query && !tags) {
    return db.prepare(`SELECT ${FILE_FIELDS} FROM files ORDER BY created_at DESC LIMIT ?`).all(limit);
  }

  const queryTokens = tokenizeQuery(query);

  // 如果没有查询词，只有标签过滤：直接用 SQLite
  if (queryTokens.length === 0 && tags) {
    const tagList = tags.split(',').map(t => t.trim().toLowerCase());
    const tagConditions = tagList.map(() => `LOWER(tags) LIKE ?`).join(' AND ');
    const tagParams = tagList.map(t => `%${t}%`);
    return db.prepare(`SELECT ${FILE_FIELDS} FROM files WHERE ${tagConditions} ORDER BY created_at DESC LIMIT ?`)
      .all(...tagParams, limit);
  }

  // 有查询词：先用 SQLite LIKE 过滤候选集（避免全表扫描）
  // 对每个 token 构建 OR 条件，减少内存中处理的文件数
  let candidateFiles;
  if (queryTokens.length > 0) {
    // 构建 OR 条件：任一 token 匹配即入选（宽泛初筛）
    const conditions = queryTokens.flatMap(token => [
      `LOWER(filename) LIKE ?`,
      `LOWER(tags) LIKE ?`
    ]);
    const params = queryTokens.flatMap(token => [`%${token}%`, `%${token}%`]);
    // 限制候选集上限，避免 LIKE %% 全表扫描返回过多结果
    const candidateLimit = 500;
    candidateFiles = db.prepare(
      `SELECT ${FILE_FIELDS} FROM files WHERE ${conditions.join(' OR ')} LIMIT ?`
    ).all(...params, candidateLimit);
  } else {
    candidateFiles = db.prepare(`SELECT ${FILE_FIELDS} FROM files`).all();
  }

  if (queryTokens.length === 0 && !tags) {
    return candidateFiles.slice(0, limit);
  }

  // Score each candidate
  const scored = candidateFiles.map(f => {
    let score = 0;
    const filename = (f.filename || '').toLowerCase();
    const fileTags = (f.tags || '').toLowerCase();

    for (const token of queryTokens) {
      // Exact filename prefix match (highest)
      if (filename.startsWith(token)) {
        score += 100;
      }
      // Filename exact match
      else if (filename === token) {
        score += 90;
      }
      // Filename contains (fuzzy)
      else if (fuzzy && filename.includes(token)) {
        score += 60;
      }
      // Tag exact match
      else if (fileTags.includes(token)) {
        score += 40;
      }
      // Char-by-char fuzzy for Chinese
      else if (fuzzy && token.length === 1 && filename.includes(token)) {
        score += 10;
      }
    }

    // Tag filter
    if (tags) {
      const tagList = tags.split(',').map(t => t.trim().toLowerCase());
      const hasAllTags = tagList.every(t => fileTags.includes(t));
      if (!hasAllTags) return null;
      score += 30; // tag filter bonus
    }

    if (score > 0) {
      return { ...f, score };
    }
    return null;
  }).filter(Boolean);

  // Sort: score desc, then time desc
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.created_at - a.created_at;
  });

  return scored.slice(0, limit);
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

function getTotalStorageSize() {
  const db = getDb();
  const row = db.prepare('SELECT COALESCE(SUM(size), 0) as total FROM files').get();
  return row.total;
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
function addSyncLog(fileId, filename, action, hash, deviceId = null, sizeBytes = 0) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO sync_log (file_id, filename, action, hash, timestamp, device_id, synced, size_bytes)
    VALUES (?, ?, ?, ?, unixepoch(), ?, 0, ?)
  `);
  stmt.run(fileId, filename, action, hash, deviceId, sizeBytes);
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
  const unsyncedSize = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) as size FROM sync_log WHERE synced = 0').get().size;
  return { unsynced, total, unsyncedSize };
}

// ============================================================
// Token 管理
// ============================================================
function generateToken(deviceId = null, expiresInSeconds = 86400) {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiresInSeconds;
  const refreshExpiresAt = now + 86400 * 30;  // Refresh Token 30天

  // 删除旧 Token
  if (deviceId) {
    db.prepare('DELETE FROM tokens WHERE device_id = ?').run(deviceId);
  }

  const stmt = db.prepare(`
    INSERT INTO tokens (token, refresh_token, refresh_token_expires_at, device_id, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(token, refreshToken, refreshExpiresAt, deviceId, expiresAt);

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
  if (!row) return { success: false, error: 'Invalid refresh token' };

  const now = Math.floor(Date.now() / 1000);
  // 检查 refresh token 本身是否过期（默认30天）
  if (row.refresh_token_expires_at && row.refresh_token_expires_at < now) {
    return { success: false, error: 'Refresh token expired' };
  }

  const newToken = crypto.randomBytes(32).toString('hex');
  const newRefreshToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = now + 86400 * 7;  // 新 Access Token 7天
  const refreshExpiresAt = now + 86400 * 30;  // 新 Refresh Token 30天

  db.prepare(`
    UPDATE tokens SET token = ?, refresh_token = ?, expires_at = ?, refresh_token_expires_at = ?
    WHERE refresh_token = ?
  `).run(newToken, newRefreshToken, expiresAt, refreshExpiresAt, refreshToken);

  return { success: true, token: newToken, refreshToken: newRefreshToken, expiresAt };
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
// Token 清理（删除过期 Token）
// ============================================================
function cleanupExpiredTokens() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(now);
  if (result.changes > 0) {
    console.log(`[DB] Cleaned up ${result.changes} expired tokens`);
  }
  return result.changes;
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

function listAuditLogs(limit = 100, offset = 0, filters = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (filters.action) {
    conditions.push('action = ?');
    params.push(filters.action);
  }
  if (filters.ip) {
    conditions.push('ip LIKE ?');
    params.push('%' + filters.ip + '%');
  }
  if (filters.since) {
    conditions.push('timestamp >= ?');
    params.push(filters.since);
  }
  if (filters.until) {
    conditions.push('timestamp <= ?');
    params.push(filters.until);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) as count FROM audit_log ' + where).get(...params).count;
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

  return { rows, total, limit, offset };
}

function getAuditStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM audit_log').get().count;
  const today = Math.floor(new Date().setHours(0,0,0,0) / 1000);
  const todayCount = db.prepare('SELECT COUNT(*) as count FROM audit_log WHERE timestamp >= ?').get(today).count;
  // 按 action 类型统计
  const byAction = db.prepare('SELECT action, COUNT(*) as count FROM audit_log GROUP BY action ORDER BY count DESC').all();
  return { total, todayCount, byAction };
}

// ============================================================
// 速率限制（防暴力破解）
// ============================================================
// 策略：共享 token 限速（同一 IP/分享码组合）
const RATE_LIMIT_CONFIG = {
  maxAttempts: 5,      // 最多尝错次数
  lockoutSeconds: 300, // 锁定时长（5分钟）
  windowSeconds: 900   // 时间窗口（15分钟），超出后计数重置
};

function checkRateLimit(key) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT * FROM rate_limit WHERE key = ?').get(key);
  
  if (!row) return { allowed: true, attempts: 0, remaining: RATE_LIMIT_CONFIG.maxAttempts };
  
  // 已锁定
  if (row.locked_until && now < row.locked_until) {
    return {
      allowed: false,
      locked: true,
      attempts: row.attempts,
      remaining: 0,
      retryAfter: row.locked_until - now
    };
  }
  
  // 锁定已过期，重置计数
  if (row.locked_until && now >= row.locked_until) {
    db.prepare('UPDATE rate_limit SET attempts = 0, locked_until = NULL, last_attempt = ? WHERE key = ?').run(now, key);
    return { allowed: true, attempts: 0, remaining: RATE_LIMIT_CONFIG.maxAttempts };
  }
  
  // 窗口期外，重置计数
  if (now - row.last_attempt > RATE_LIMIT_CONFIG.windowSeconds) {
    db.prepare('UPDATE rate_limit SET attempts = 0, last_attempt = ? WHERE key = ?').run(now, key);
    return { allowed: true, attempts: 0, remaining: RATE_LIMIT_CONFIG.maxAttempts };
  }
  
  // 窗口期内
  return {
    allowed: row.attempts < RATE_LIMIT_CONFIG.maxAttempts,
    attempts: row.attempts,
    remaining: Math.max(0, RATE_LIMIT_CONFIG.maxAttempts - row.attempts)
  };
}

function recordRateLimitAttempt(key, success = false) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  
  if (success) {
    // 成功，清除记录
    db.prepare('DELETE FROM rate_limit WHERE key = ?').run(key);
    return;
  }
  
  const row = db.prepare('SELECT * FROM rate_limit WHERE key = ?').get(key);
  if (!row) {
    db.prepare('INSERT INTO rate_limit (key, attempts, last_attempt) VALUES (?, 1, ?)').run(key, now);
  } else {
    const newAttempts = row.attempts + 1;
    const lockedUntil = newAttempts >= RATE_LIMIT_CONFIG.maxAttempts ? now + RATE_LIMIT_CONFIG.lockoutSeconds : null;
    db.prepare('UPDATE rate_limit SET attempts = ?, locked_until = ?, last_attempt = ? WHERE key = ?')
      .run(newAttempts, lockedUntil, now, key);
  }
}

function exportAuditLogsCSV(filters = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (filters.action) {
    conditions.push('action = ?');
    params.push(filters.action);
  }
  if (filters.ip) {
    conditions.push('ip LIKE ?');
    params.push('%' + filters.ip + '%');
  }
  if (filters.since) {
    conditions.push('timestamp >= ?');
    params.push(filters.since);
  }
  if (filters.until) {
    conditions.push('timestamp <= ?');
    params.push(filters.until);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY timestamp DESC`).all(...params);

  const header = 'ID,Action,Details,IP,Token,Timestamp\n';
  const csvRows = rows.map(r => {
    const ts = new Date(r.timestamp * 1000).toISOString();
    return `${r.id},"${(r.action||'').replace(/"/g,'""')}","${(r.details||'').replace(/"/g,'""')}","${r.ip||''}","${(r.token||'').replace(/"/g,'""')}",${ts}`;
  }).join('\n');

  return header + csvRows;
}

// ============================================================
// 分享链接
// ============================================================
function saveShareLink(shareData) {
  const db = getDb();
  // 密码哈希存储（兼容无密码场景）
  const hashedPassword = shareData.password ? hashPassword(shareData.password) : null;
  const stmt = db.prepare(`
    INSERT INTO share_links (code, filename, is_text, password, expires_at, max_downloads, download_count, description, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    shareData.code,
    shareData.filename,
    shareData.isText ? 1 : 0,
    hashedPassword,
    Math.floor(shareData.expiresAt / 1000),
    shareData.maxDownloads,
    0,
    shareData.description || '',
    shareData.createdBy || null
  );
  return shareData;
}

function getShareLink(code) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM share_links WHERE code = ?').get(code);
  if (!row) return null;
  return {
    code: row.code,
    filename: row.filename,
    isText: row.is_text === 1,
    hasPassword: !!row.password,  // 只返回是否有密码，不暴露哈希
    expiresAt: row.expires_at * 1000,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    description: row.description || '',
    createdAt: row.created_at * 1000,
    createdBy: row.created_by,
    _passwordHash: row.password  // 内部使用，验证时比对
  };
}

function deleteShareLink(code) {
  const db = getDb();
  db.prepare('DELETE FROM share_links WHERE code = ?').run(code);
}

function incrementShareLinkDownload(code) {
  const db = getDb();
  db.prepare('UPDATE share_links SET download_count = download_count + 1 WHERE code = ?').run(code);
}

function listShareLinks() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM share_links ORDER BY created_at DESC LIMIT 100').all();
  return rows.map(row => ({
    code: row.code,
    filename: row.filename,
    isText: row.is_text === 1,
    password: !!row.password,
    expiresAt: row.expires_at * 1000,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    description: row.description || '',
    createdAt: row.created_at * 1000,
    createdBy: row.created_by
  }));
}

function cleanupExpiredShareLinks() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare('DELETE FROM share_links WHERE expires_at < ?').run(now);
  if (result.changes > 0) {
    console.log(`[DB] Cleaned up ${result.changes} expired share links`);
  }
  return result.changes;
}

// ============================================================
// 同步日志清理 + DB 健康检查
// ============================================================
function cleanupSyncLog(daysToKeep = 7) {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - daysToKeep * 86400;
  // 只删除已同步且超过保留期的日志
  const result = db.prepare('DELETE FROM sync_log WHERE synced = 1 AND timestamp < ?').run(cutoff);
  if (result.changes > 0) {
    console.log(`[DB] Cleaned up ${result.changes} old sync_log entries`);
  }
  return result.changes;
}

function getDbStats() {
  const db = getDb();
  const fileCount = db.prepare('SELECT COUNT(*) as c FROM files').get().c;
  const deviceCount = db.prepare('SELECT COUNT(*) as c FROM devices').get().c;
  const syncLogCount = db.prepare('SELECT COUNT(*) as c FROM sync_log').get().c;
  const unsyncedCount = db.prepare('SELECT COUNT(*) as c FROM sync_log WHERE synced = 0').get().c;
  const tokenCount = db.prepare('SELECT COUNT(*) as c FROM tokens').get().c;
  const auditCount = db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c;
  const shareLinkCount = db.prepare('SELECT COUNT(*) as c FROM share_links').get().c;
  const totalSize = db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM files').get().s;
  const unsyncedSize = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) as s FROM sync_log WHERE synced = 0').get().s;

  // DB file size
  let dbSize = 0;
  try {
    const fs = require('fs');
    const stats = fs.statSync(DB_PATH);
    dbSize = stats.size;
  } catch (e) {}

  return {
    files: fileCount,
    devices: deviceCount,
    syncLog: syncLogCount,
    unsynced: unsyncedCount,
    unsyncedSize,
    tokens: tokenCount,
    auditLog: auditCount,
    shareLinks: shareLinkCount,
    totalSize,
    dbSize
  };
}

function runVacuum() {
  const db = getDb();
  db.exec('VACUUM');
  console.log('[DB] VACUUM completed');
}

function checkDbIntegrity() {
  const db = getDb();
  const result = db.prepare('PRAGMA integrity_check').get();
  return result.integrity_check;
}

// ============================================================
// 标签颜色
// ============================================================
const TAG_COLOR_PRESETS = [
  '#667eea', '#f59e0b', '#10b981', '#ef4444', '#3b82f6',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316'
];

function getTagColor(tag) {
  const db = getDb();
  const row = db.prepare('SELECT color FROM tag_colors WHERE tag = ?').get(tag);
  return row ? row.color : null;
}

function setTagColor(tag, color) {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO tag_colors (tag, color, updated_at) VALUES (?, ?, unixepoch())`).run(tag, color);
  return { tag, color };
}

function getAllTagColors() {
  const db = getDb();
  return db.prepare('SELECT tag, color FROM tag_colors ORDER BY updated_at DESC').all();
}

function getSuggestedColor(tag) {
  // 根据 tag 名称生成一致性颜色（不依赖已有颜色表）
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_COLOR_PRESETS[Math.abs(hash) % TAG_COLOR_PRESETS.length];
}

function deleteTagColor(tag) {
  const db = getDb();
  db.prepare('DELETE FROM tag_colors WHERE tag = ?').run(tag);
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
        addFile(filename, content, type, null, false);
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
  // 密码
  hashPassword, verifyPassword,
  // 文件
  addFile, getFile, getFileByName, listFiles, updateFile, updateFileByName,
  deleteFile, deleteFileByName, renameFile, deleteOldFiles, deleteAllFiles,
  searchFiles, getFilesByHashSince, getFileCount, getTotalStorageSize,
  // 设备
  registerDevice, getDevice, listDevices, setDeviceOffline, setDeviceOnline,
  touchDevice, getOnlineDevices, cleanupStaleDevices,
  // 同步
  addSyncLog, getUnsyncedLogs, markLogsSynced, getSyncStatus,
  // Token
  generateToken, validateToken, refreshToken, revokeToken, revokeAllTokens,
  // 审计
  addAuditLog, listAuditLogs, getAuditStats,
  // 速率限制
  checkRateLimit, recordRateLimitAttempt,
  // 分享链接
  saveShareLink, getShareLink, deleteShareLink, incrementShareLinkDownload,
  listShareLinks, cleanupExpiredShareLinks,
  // 迁移
  migrateFromFileSystem,
  // 清理
  cleanupExpiredTokens,
  // DB 健康
  cleanupSyncLog, getDbStats, runVacuum, checkDbIntegrity,
  // 标签颜色
  getTagColor, setTagColor, getAllTagColors, getSuggestedColor, deleteTagColor
};
