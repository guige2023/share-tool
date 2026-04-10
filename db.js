#!/usr/bin/env node
/**
 * ShareTool - SQLite 数据层
 * 提供文件、设备、同步、Token、审计日志的持久化
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DB_PATH = process.env.SHARE_TOOL_DB_PATH || path.join(os.homedir(), '.share-tool', 'share-tool.db');
const SCHEMA_VERSION = 6; // 当前 Schema 版本

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
  const [salt, storedHash] = stored.split(':');
  const inputHash = crypto.scryptSync(password, salt, PASSWORD_HASH_LEN).toString('hex');
  // 使用 timingSafeEqual 防止计时攻击（Buffer 长度相同：64 char hex = 32 bytes）
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(inputHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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

  // 如果是全新数据库（version=1 且无任何表），初始化 v1 基础结构
  // 必须在迁移之前做，避免对空表执行 ALTER
  const tableCount = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().c;
  if (tableCount <= 1) {
    initSchemaV1(db);
    initSchemaV2(db);
    initSchemaV3(db);
    initSchemaV4(db);
    initSchemaV5(db);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    console.log('[DB] Fresh database initialized (v1-v5 schema)');
    return;
  }

  // 获取当前 Schema 版本
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  let currentVersion = row ? parseInt(row.value, 10) : 1;

  console.log(`[DB] Schema version: ${currentVersion} → ${SCHEMA_VERSION}`);

  // 执行迁移
  if (currentVersion < SCHEMA_VERSION) {
    runMigrations(db, currentVersion);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    currentVersion = SCHEMA_VERSION;
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
      starred      INTEGER NOT NULL DEFAULT 0,
      position     INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Migration: add starred column if not exists
  try {
    db.exec(`ALTER TABLE files ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`);
  } catch (e) {
    // Column may already exist in older dbs
  }

  // Migration: add position column if not exists
  try {
    db.exec(`ALTER TABLE files ADD COLUMN position INTEGER NOT NULL DEFAULT 0`);
  } catch (e) {
    // Column may already exist in older dbs
  }

  // 文件版本历史表
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_versions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id      INTEGER NOT NULL,
      filename     TEXT    NOT NULL,
      content      TEXT,
      size         INTEGER NOT NULL DEFAULT 0,
      hash         TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_file_versions_file_id ON file_versions(file_id)`);

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

  // 搜索历史表（持久化到数据库，支持多设备同步）
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      query       TEXT    NOT NULL,
      user_id     TEXT,
      timestamp   INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id, timestamp DESC)');

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

  // 标签颜色/图标表
  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_colors (
      tag        TEXT PRIMARY KEY,
      color      TEXT NOT NULL,
      emoji      TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_used  INTEGER
    )
  `);

  // 懒迁移：确保 last_used 列存在（已有数据库兼容性）
  try {
    db.prepare('SELECT last_used FROM tag_colors LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE tag_colors ADD COLUMN last_used INTEGER');
  }

  // 标签统计表（维护每个标签的文件数量）
  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_stats (
      tag      TEXT PRIMARY KEY,
      count    INTEGER NOT NULL DEFAULT 0
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

function initSchemaV3(db) {
  // v3 新增：rate_limit 表（暴力破解防护）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        key           TEXT    NOT NULL UNIQUE,
        attempts      INTEGER NOT NULL DEFAULT 0,
        locked_until  INTEGER,
        last_attempt  INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    console.log('[DB] Migrated: rate_limit table');
  } catch (e) {
    if (!e.message.includes('duplicate table')) throw e;
  }

  // v3 新增：idx_files_filename 索引（搜索优化）
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_files_filename ON files(filename)');
    console.log('[DB] Migrated: idx_files_filename index');
  } catch (e) {
    if (!e.message.includes('duplicate index')) throw e;
  }
}

function initSchemaV4(db) {
  // v4 新增：分片上传临时表
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS upload_chunks (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        upload_id        TEXT    NOT NULL UNIQUE,
        filename         TEXT    NOT NULL,
        total_chunks     INTEGER NOT NULL,
        file_hash        TEXT,
        size             INTEGER,
        received_chunks  TEXT    NOT NULL DEFAULT '[]',
        created_at       INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    console.log('[DB] Migrated: upload_chunks table');
  } catch (e) {
    if (!e.message.includes('duplicate table')) throw e;
  }
}

function initSchemaV5(db) {
  // v5 新增：回收站表
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trash (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id     INTEGER NOT NULL,
        filename    TEXT    NOT NULL,
        content     TEXT,
        size        INTEGER NOT NULL DEFAULT 0,
        type        TEXT    NOT NULL DEFAULT 'file',
        hash        TEXT,
        deleted_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at  INTEGER NOT NULL DEFAULT (unixepoch() + 2592000)
      )
    `);
    console.log('[DB] Migrated: trash table');
  } catch (e) {
    if (!e.message.includes('duplicate table')) throw e;
  }

  // file_versions 表（可能在旧数据库中缺失）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_versions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id      INTEGER NOT NULL,
        filename     TEXT    NOT NULL,
        content      TEXT,
        size         INTEGER NOT NULL DEFAULT 0,
        hash         TEXT,
        created_at   INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_file_versions_file_id ON file_versions(file_id)`);
    console.log('[DB] Migrated: file_versions table');
  } catch (e) {
    if (!e.message.includes('duplicate table')) throw e;
  }

  // 修复旧数据库缺少的列
  const alterStatements = [
    `ALTER TABLE files ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE files ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0`,
  ];
  for (const sql of alterStatements) {
    try { db.exec(sql); console.log('[DB] Altered: ' + sql.split('ADD COLUMN ')[1]); } catch (e) { /* ignore */ }
  }
}

function initSchemaV6(db) {
  // v6 新增：标签统计表 tag_stats
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tag_stats (
        tag      TEXT PRIMARY KEY,
        count    INTEGER NOT NULL DEFAULT 0
      )
    `);
    console.log('[DB] Migrated: tag_stats table');
  } catch (e) {
    if (!e.message.includes('duplicate table')) throw e;
  }
  // 从现有数据初始化 tag_stats
  try {
    const rows = db.prepare('SELECT tags FROM files WHERE tags IS NOT NULL AND tags != ""').all();
    const counts = {};
    for (const row of rows) {
      for (const t of row.tags.split(',').map(s => s.trim()).filter(Boolean)) {
        counts[t] = (counts[t] || 0) + 1;
      }
    }
    const stmt = db.prepare('INSERT OR REPLACE INTO tag_stats (tag, count) VALUES (?, ?)');
    for (const [tag, count] of Object.entries(counts)) {
      stmt.run(tag, count);
    }
    console.log(`[DB] Initialized tag_stats with ${Object.keys(counts).length} tags`);
  } catch (e) { /* already initialized or no tags */ }
  // 修复旧数据库 tag_colors 表缺少的 emoji 列
  try {
    db.exec("ALTER TABLE tag_colors ADD COLUMN emoji TEXT");
    console.log('[DB] Altered: tag_colors.emoji');
  } catch (e) { /* column already exists or table missing */ }
}

function runMigrations(db, fromVersion) {
  console.log(`[DB] Running migrations from v${fromVersion} to v${SCHEMA_VERSION}`);
  for (let v = fromVersion + 1; v <= SCHEMA_VERSION; v++) {
    if (v === 2) {
      initSchemaV2(db);
    } else if (v === 3) {
      initSchemaV3(db);
    } else if (v === 4) {
      initSchemaV4(db);
    } else if (v === 5) {
      initSchemaV5(db);
    } else if (v === 6) {
      initSchemaV6(db);
    }
    console.log(`[DB] Migration to v${v} complete`);
  }
}

// ============================================================
// 文件操作
// ============================================================
const FILE_FIELDS = 'id, filename, content, type, size, hash, tags, encrypted, starred, position, created_at, updated_at';

// Security helper: validate filename against path traversal
function validateFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.length > 255) return false;  // 文件名过长
  if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\') || filename.includes('\x00')) return false;
  return true;
}

function addFile(filename, content, type = 'file', hash = null, encrypted = false) {
  // Security: reject path traversal attempts
  if (!validateFilename(filename)) throw new Error('Invalid filename');
  const db = getDb();
  const size = content ? Buffer.byteLength(content, 'utf8') : 0;
  if (!hash) {
    hash = content ? crypto.createHash('md5').update(content).digest('hex') : null;
  }
  try {
    // 新文件 position = 当前最大 + 1
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM files').get().m;
    const contentType = type === 'text' ? 'text/plain' : 'application/octet-stream';
    const stmt = db.prepare(`
      INSERT INTO files (filename, content, type, size, hash, encrypted, content_type, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `);
    const result = stmt.run(filename, content || null, type, size, hash, encrypted ? 1 : 0, contentType, maxPos + 1);
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

// 设置文件排序位置（批量）
// positions: [{id, position}, ...]
function setFilePositions(positions) {
  const db = getDb();
  const stmt = db.prepare('UPDATE files SET position = ? WHERE id = ?');
  const updateMany = db.transaction((items) => {
    for (const { id, position } of items) {
      stmt.run(position, id);
    }
  });
  updateMany(positions);
  return true;
}

function listFiles(limit = 100, offset = 0, sort = 'created_at', order = 'DESC', folder = null, starred = false) {
  const db = getDb();
  const safeOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const safeSort = ['created_at', 'updated_at', 'filename', 'size', 'type', 'tags', 'position'].includes(sort) ? sort : 'created_at';

  // Build WHERE clause
  const conditions = [];
  const params = [];
  if (folder) { conditions.push('filename LIKE ? ESCAPE ?'); params.push(folder + '/%', '\\'); }
  if (starred) { conditions.push('starred = 1'); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const files = db.prepare(`
    SELECT ${FILE_FIELDS} FROM files
    ${where}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM files ${where}`).get(...params).count;
  return { files, total };
}

function toggleStar(filename) {
  const db = getDb();
  const file = db.prepare('SELECT id, starred FROM files WHERE filename = ?').get(filename);
  if (!file) return { success: false, error: 'File not found' };
  const newStarred = file.starred ? 0 : 1;
  db.prepare('UPDATE files SET starred = ?, updated_at = unixepoch() WHERE id = ?').run(newStarred, file.id);
  return { success: true, starred: newStarred };
}

function updateFileByName(filename, updates) {
  const db = getDb();
  const existing = getFileByName(filename);
  if (!existing) return null;

  const fields = [];
  const values = [];

  if (updates.content !== undefined) {
    // 保存当前版本到历史（仅当内容真正变化时）
    if (existing.content !== undefined && existing.content !== updates.content) {
      saveFileVersion(existing.id, existing.filename, existing.content, existing.size, existing.hash);
    }
    fields.push('content = ?');
    values.push(updates.content);
    fields.push('size = ?');
    values.push(Buffer.byteLength(updates.content, 'utf8'));
    fields.push('hash = ?');
    values.push(crypto.createHash('md5').update(updates.content).digest('hex'));
  }
  if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type); }
  if (updates.tags !== undefined) {
    updateTagStats(existing.tags, updates.tags);
    fields.push('tags = ?');
    values.push(updates.tags);
  }
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
    if (existing.content !== undefined && existing.content !== updates.content) {
      saveFileVersion(existing.id, existing.filename, existing.content, existing.size, existing.hash);
    }
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

function moveToTrash(filename) {
  const db = getDb();
  const existing = getFileByName(filename);
  if (!existing) return false;
  // 软删除：写入 trash 表，30天后自动清理
  db.prepare(`
    INSERT INTO trash (file_id, filename, content, size, type, hash, deleted_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch() + 2592000)
  `).run(existing.id, existing.filename, existing.content, existing.size, existing.type, existing.hash);
  addSyncLog(existing.id, filename, 'delete', existing.hash, null, existing.size);
  db.prepare('DELETE FROM files WHERE filename = ?').run(filename);
  return true;
}

function deleteFileByName(filename) {
  // 软删除到回收站
  return moveToTrash(filename);
}

// 永久删除（不经过回收站）
function permanentlyDeleteFile(filename) {
  const db = getDb();
  const existing = getFileByName(filename);
  if (!existing) return false;
  addSyncLog(existing.id, filename, 'delete', existing.hash, null, existing.size);
  updateTagStats(existing.tags, null);
  db.prepare('DELETE FROM files WHERE filename = ?').run(filename);
  return true;
}

function listTrash(limit = 100) {
  const db = getDb();
  return db.prepare('SELECT * FROM trash ORDER BY deleted_at DESC LIMIT ?').all(limit);
}

function restoreFromTrash(trashId) {
  const db = getDb();
  const item = db.prepare('SELECT * FROM trash WHERE id = ?').get(trashId);
  if (!item) return { success: false, error: 'Trash item not found' };
  // 检查原文件名是否已存在（可能被占用）
  const conflict = getFileByName(item.filename);
  if (conflict) return { success: false, error: '文件名已存在，请先删除或重命名现有文件' };
  // 恢复文件
  db.prepare(`
    INSERT INTO files (filename, content, size, type, hash, tags, encrypted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '', 0, unixepoch(), unixepoch())
  `).run(item.filename, item.content, item.size, item.type, item.hash);
  db.prepare('DELETE FROM trash WHERE id = ?').run(trashId);
  return { success: true, filename: item.filename };
}

function permanentlyDeleteTrash(trashId) {
  const db = getDb();
  db.prepare('DELETE FROM trash WHERE id = ?').run(trashId);
}

function cleanupExpiredTrash() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  return db.prepare('DELETE FROM trash WHERE expires_at < ?').run(now);
}

function renameFile(oldFilename, newFilename) {
  if (!validateFilename(oldFilename) || !validateFilename(newFilename)) return { success: false, error: '无效的文件名' };
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

// 前缀删除（用于虚拟文件夹删除）
function deleteFilesByPrefix(prefix) {
  const db = getDb();
  const pattern = prefix.endsWith('/') ? prefix + '%' : prefix + '/%';
  const result = db.prepare("DELETE FROM files WHERE filename LIKE ?").run(pattern);
  return { deleted: result.changes };
}

// 前缀重命名（用于虚拟文件夹重命名）
function renameFilesByPrefix(oldPrefix, newPrefix) {
  if (!validateFilename(oldPrefix) || !validateFilename(newPrefix)) return { renamed: 0, error: '无效的文件夹名' };
  const db = getDb();
  const oldPattern = oldPrefix.endsWith('/') ? oldPrefix + '%' : oldPrefix + '/%';
  const newPatternPrefix = newPrefix.endsWith('/') ? newPrefix : newPrefix + '/';
  // Find all matching files
  const files = db.prepare("SELECT id, filename FROM files WHERE filename LIKE ?").all(oldPattern);
  let renamed = 0;
  for (const f of files) {
    const newFilename = newPatternPrefix + f.filename.slice(oldPrefix.endsWith('/') ? oldPrefix.length : (oldPrefix.length + 1));
    db.prepare("UPDATE files SET filename = ? WHERE id = ?").run(newFilename, f.id);
    renamed++;
  }
  return { renamed };
}

// 移动文件到新路径（不生成副本，类似 rename 但保持 ID 和 created_at）
function moveFile(sourceFilename, destFilename) {
  if (!validateFilename(sourceFilename) || !validateFilename(destFilename)) return { success: false, error: '无效的文件名' };
  const db = getDb();
  const source = getFileByName(sourceFilename);
  if (!source) return { success: false, error: '源文件不存在' };

  // 检查目标是否已存在
  const conflict = getFileByName(destFilename);
  if (conflict) return { success: false, error: '目标文件名已存在' };

  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE files SET filename = ?, updated_at = ? WHERE filename = ?').run(destFilename, now, sourceFilename);

  // 记录同步日志
  const updated = getFileByName(destFilename);
  if (updated) {
    addSyncLog(updated.id, destFilename, 'rename', updated.hash, null, updated.size);
  }

  return { success: true, oldFilename: sourceFilename, newFilename: destFilename, hash: source.hash, size: source.size };
}

// 前缀移动（用于虚拟文件夹移动）
function moveFilesByPrefix(sourcePrefix, destPrefix) {
  if (!validateFilename(sourcePrefix) || !validateFilename(destPrefix)) return { moved: 0, error: '无效的文件夹名' };
  const db = getDb();
  const oldPattern = sourcePrefix.endsWith('/') ? sourcePrefix + '%' : sourcePrefix + '/%';
  const newPatternPrefix = destPrefix.endsWith('/') ? destPrefix : destPrefix + '/';
  const oldPrefixLen = sourcePrefix.endsWith('/') ? sourcePrefix.length : sourcePrefix.length + 1;
  const files = db.prepare("SELECT id, filename FROM files WHERE filename LIKE ?").all(oldPattern);
  let moved = 0;
  for (const f of files) {
    const newFilename = newPatternPrefix + f.filename.slice(oldPrefixLen);
    db.prepare("UPDATE files SET filename = ?, updated_at = unixepoch() WHERE id = ?").run(newFilename, f.id);
    moved++;
  }
  return { moved };
}

// 复制文件（生成新副本，不修改原文件）
function copyFile(sourceFilename, newFilename) {
  const db = getDb();
  const source = getFileByName(sourceFilename);
  if (!source) return { success: false, error: '源文件不存在' };

  // 检查目标文件名是否已存在
  const conflict = getFileByName(newFilename);
  if (conflict) return { success: false, error: '目标文件名已存在' };

  // 插入新记录，内容/哈希/size 相同，但 filename 和时间戳不同
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO files (filename, content, type, size, hash, created_at, updated_at, tags, encrypted, content_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    newFilename,
    source.content,
    source.type,
    source.size,
    source.hash,
    source.created_at,  // 保留源文件的创建时间
    now,                // 但更新时间是复制时刻
    source.tags,
    source.encrypted || 0,
    source.content_type || 'application/octet-stream'
  );

  const newId = result.lastInsertRowid;

  // 记录同步日志
  addSyncLog(newId, newFilename, 'create', source.hash, null, source.size);

  return { success: true, id: newId, filename: newFilename, hash: source.hash, size: source.size };
}

// 前缀复制（用于虚拟文件夹复制）
function copyFilesByPrefix(sourcePrefix, destPrefix) {
  const db = getDb();
  const pattern = sourcePrefix.endsWith('/') ? sourcePrefix + '%' : sourcePrefix + '/%';
  const files = db.prepare("SELECT id, filename, content, type, size, hash, created_at, tags, starred, encrypted FROM files WHERE filename LIKE ?").all(pattern);
  const now = Math.floor(Date.now() / 1000);
  let copied = 0;
  for (const f of files) {
    const newFilename = destPrefix.endsWith('/') ? destPrefix + f.filename.slice(sourcePrefix.length) : destPrefix + '/' + f.filename.slice(sourcePrefix.endsWith('/') ? sourcePrefix.length : (sourcePrefix.length + 1));
    db.prepare(`INSERT INTO files (filename, content, type, size, hash, created_at, updated_at, tags, encrypted, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newFilename, f.content, f.type, f.size, f.hash, f.created_at, now, f.tags, f.encrypted || 0, f.content_type || 'application/octet-stream');
    copied++;
  }
  return { copied };
}

// 批量移动文件到目标文件夹（单事务）
function batchMove(filenames, destFolder) {
  const db = getDb();
  const results = [];
  const now = Math.floor(Date.now() / 1000);

  // 先预检所有文件
  for (const filename of filenames) {
    const source = getFileByName(filename);
    if (!source) {
      results.push({ filename, success: false, error: '源文件不存在' });
      return { success: false, results, error: '部分文件不存在' };
    }
    const basename = filename.split('/').pop();
    const destFilename = (destFolder ? destFolder + '/' : '') + basename;
    if (filename === destFilename) {
      results.push({ filename, success: false, error: '源和目标相同' });
      return { success: false, results, error: '源和目标相同' };
    }
    const conflict = getFileByName(destFilename);
    if (conflict) {
      results.push({ filename, success: false, error: `目标文件 ${destFilename} 已存在` });
      return { success: false, results, error: `目标文件 ${destFilename} 已存在` };
    }
  }

  // 全部预检通过，执行移动
  db.exec('BEGIN TRANSACTION');
  try {
    for (const filename of filenames) {
      const basename = filename.split('/').pop();
      const destFilename = (destFolder ? destFolder + '/' : '') + basename;
      db.prepare('UPDATE files SET filename = ?, updated_at = ? WHERE filename = ?').run(destFilename, now, filename);
      const updated = getFileByName(destFilename);
      if (updated) {
        addSyncLog(updated.id, destFilename, 'rename', updated.hash, null, updated.size);
      }
      results.push({ filename, destFilename, success: true });
    }
    db.exec('COMMIT');
    return { success: true, results };
  } catch (e) {
    db.exec('ROLLBACK');
    return { success: false, results, error: e.message };
  }
}

// 批量复制文件到目标文件夹（单事务）
function batchCopy(filenames, destFolder) {
  const db = getDb();
  const results = [];
  const now = Math.floor(Date.now() / 1000);

  // 预检所有文件
  for (const filename of filenames) {
    const source = getFileByName(filename);
    if (!source) {
      results.push({ filename, success: false, error: '源文件不存在' });
      return { success: false, results, error: '部分文件不存在' };
    }
    const basename = filename.split('/').pop();
    const destFilename = (destFolder ? destFolder + '/' : '') + basename;
    if (filename === destFilename) {
      results.push({ filename, success: false, error: '源和目标相同' });
      return { success: false, results, error: '源和目标相同' };
    }
    const conflict = getFileByName(destFilename);
    if (conflict) {
      results.push({ filename, success: false, error: `目标文件 ${destFilename} 已存在` });
      return { success: false, results, error: `目标文件 ${destFilename} 已存在` };
    }
  }

  // 全部预检通过，执行复制
  db.exec('BEGIN TRANSACTION');
  try {
    for (const filename of filenames) {
      const source = getFileByName(filename);
      const basename = filename.split('/').pop();
      const destFilename = (destFolder ? destFolder + '/' : '') + basename;
      db.prepare(`
        INSERT INTO files (filename, content, type, size, hash, created_at, updated_at, tags, encrypted, content_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        destFilename,
        source.content,
        source.type,
        source.size,
        source.hash,
        source.created_at,
        now,
        source.tags,
        source.encrypted || 0,
        source.content_type || 'application/octet-stream'
      );
      results.push({ filename, destFilename, success: true });
    }
    db.exec('COMMIT');
    return { success: true, results };
  } catch (e) {
    db.exec('ROLLBACK');
    return { success: false, results, error: e.message };
  }
}

// 按前缀获取所有文件（用于文件夹打包下载）
function getFilesByPrefix(prefix) {
  const db = getDb();
  const pattern = prefix.endsWith('/') ? prefix + '%' : prefix + '/%';
  return db.prepare(
    `SELECT filename, content, type, size, hash, created_at, tags, content_type
     FROM files WHERE filename LIKE ? ORDER BY filename`
  ).all(pattern);
}

function deleteFile(id) {
  const db = getDb();
  const existing = getFile(id);
  if (!existing) return false;
  // 软删除到回收站
  db.prepare(`
    INSERT INTO trash (file_id, filename, content, size, type, hash, deleted_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch() + 2592000)
  `).run(existing.id, existing.filename, existing.content, existing.size, existing.type, existing.hash);
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
  const { limit = 100, fuzzy = true, size_min, size_max, date_from, date_to, tagMatch = 'all', content, type } = opts;

  // 构建 size 和 date 的 SQL 过滤条件
  const extraConditions = [];
  const extraParams = [];
  if (size_min != null) {
    extraConditions.push('size >= ?');
    extraParams.push(parseInt(size_min));
  }
  if (size_max != null) {
    extraConditions.push('size <= ?');
    extraParams.push(parseInt(size_max));
  }
  if (date_from != null) {
    extraConditions.push('created_at >= ?');
    extraParams.push(parseInt(date_from));
  }
  if (date_to != null) {
    extraConditions.push('created_at <= ?');
    extraParams.push(parseInt(date_to));
  }
  if (type) {
    extraConditions.push(`LOWER(filename) LIKE ?`);
    extraParams.push(`%.${type.toLowerCase()}`);
  }
  const extraWhere = extraConditions.length > 0 ? ' AND ' + extraConditions.join(' AND ') : '';

  if (!query && !tags && !content && !extraWhere) {
    return db.prepare(`SELECT ${FILE_FIELDS} FROM files ORDER BY created_at DESC LIMIT ?`).all(limit);
  }

  // 解析 content: 搜索词（opts.content 优先，query 内联 content: 作后备）
  let contentQuery = null;
  let cleanQuery = query;
  if (content) {
    contentQuery = content;
  } else {
    const contentMatch = query.match(/content:(\S+)/);
    if (contentMatch) {
      contentQuery = contentMatch[1];
      cleanQuery = query.replace(/content:\S+/g, '').replace(/\s+/g, ' ').trim();
    }
  }

  const queryTokens = tokenizeQuery(cleanQuery);

  // 如果没有查询词，只有标签过滤 + size/date：直接用 SQLite
  if (queryTokens.length === 0 && tags && !contentQuery) {
    const tagList = tags.split(',').map(t => t.trim().toLowerCase());
    const tagJoin = tagMatch === 'any' ? ' OR ' : ' AND ';
    const tagConditions = tagList.map(() => `LOWER(tags) LIKE ?`).join(tagJoin);
    const tagParams = tagList.map(t => `%${t}%`);
    return db.prepare(`SELECT ${FILE_FIELDS} FROM files WHERE ${tagConditions}${extraWhere} ORDER BY created_at DESC LIMIT ?`)
      .all(...tagParams, ...extraParams, limit);
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
      `SELECT ${FILE_FIELDS} FROM files WHERE ${conditions.join(' OR ')}${extraWhere} LIMIT ?`
    ).all(...params, ...extraParams, candidateLimit);
  } else if (contentQuery && !queryTokens.length && !tags) {
    // 只有 content: 搜索：搜所有 text 类型文件
    candidateFiles = db.prepare(
      `SELECT ${FILE_FIELDS} FROM files WHERE type = 'text'${extraWhere} ORDER BY created_at DESC LIMIT ?`
    ).all(...extraParams, limit);
  } else {
    candidateFiles = db.prepare(`SELECT ${FILE_FIELDS} FROM files${extraWhere}`).all(...extraParams);
  }

  if (queryTokens.length === 0 && !tags && !contentQuery) {
    return candidateFiles.slice(0, limit);
  }

  // Score each candidate
  const scored = candidateFiles.map(f => {
    let score = 0;
    const filename = (f.filename || '').toLowerCase();
    const fileTags = (f.tags || '').toLowerCase();
    const content = (f.content || '').toLowerCase();

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

    // Tag filter: AND (all tags) or OR (any tag)
    if (tags) {
      const tagList = tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
      const hasAllTags = tagList.every(t => fileTags.includes(t));
      const hasAnyTag = tagList.some(t => fileTags.includes(t));
      if (tagMatch === 'any') {
        if (!hasAnyTag) return null;
        score += 30 * Math.min(tagList.filter(t => fileTags.includes(t)).length, 3); // bonus per matched tag
      } else {
        if (!hasAllTags) return null;
        score += 30;
      }
    }

    // Content search: 文件内容包含匹配
    if (contentQuery) {
      const lcContentQuery = contentQuery.toLowerCase();
      if (!content.includes(lcContentQuery)) {
        return null; // 内容不匹配，直接过滤
      }
      // 内容匹配加分：精确匹配高分，模糊包含低分
      if (content.startsWith(lcContentQuery)) {
        score += 80;
      } else if (content.includes(' ' + lcContentQuery) || content.includes('\n' + lcContentQuery)) {
        score += 50;
      } else {
        score += 30;
      }
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

// ============================================================
// 文件版本历史
// ============================================================
function saveFileVersion(fileId, filename, content, size, hash) {
  const db = getDb();
  db.prepare(`
    INSERT INTO file_versions (file_id, filename, content, size, hash, created_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
  `).run(fileId, filename, content, size, hash);
}

function listFileVersions(fileId, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT id, file_id, filename, size, hash, created_at
    FROM file_versions
    WHERE file_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(fileId, limit);
}

function getFileVersion(versionId) {
  const db = getDb();
  return db.prepare('SELECT * FROM file_versions WHERE id = ?').get(versionId);
}

function deleteFileVersion(versionId) {
  const db = getDb();
  db.prepare('DELETE FROM file_versions WHERE id = ?').run(versionId);
}

function getFileVersionCount(fileId) {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) as count FROM file_versions WHERE file_id = ?').get(fileId).count;
}

function pruneFileVersions(fileId, keepCount = 10) {
  // 保留最近 keepCount 个版本，删除更旧的
  const db = getDb();
  const oldVersions = db.prepare(`
    SELECT id FROM file_versions
    WHERE file_id = ?
    ORDER BY created_at DESC
    LIMIT -1 OFFSET ?
  `).all(fileId, keepCount);
  for (const v of oldVersions) {
    db.prepare('DELETE FROM file_versions WHERE id = ?').run(v.id);
  }
  return oldVersions.length;
}

// ============================================================
// 重复文件检测
// ============================================================
function findDuplicates() {
  const db = getDb();
  // 找 hash 出现2次以上的文件（忽略 null hash）
  const dupes = db.prepare(`
    SELECT hash, COUNT(*) as count, GROUP_CONCAT(filename, '|||') as filenames, GROUP_CONCAT(id, '|||') as ids
    FROM files
    WHERE hash IS NOT NULL AND hash != ''
    GROUP BY hash
    HAVING count > 1
    ORDER BY count DESC
  `).all();

  return dupes.map(row => {
    const filenames = row.filenames.split('|||');
    const ids = row.ids.split('|||');
    return {
      hash: row.hash,
      count: row.count,
      files: filenames.map((filename, i) => ({ id: parseInt(ids[i]), filename }))
    };
  });
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

// 获取虚拟文件夹大小（所有前缀匹配的文件累计大小）
function getFolderSize(folderPrefix) {
  const db = getDb();
  if (!folderPrefix) return getTotalStorageSize();
  const prefix = folderPrefix.endsWith('/') ? folderPrefix : folderPrefix + '/';
  const row = db.prepare('SELECT COALESCE(SUM(size), 0) as total FROM files WHERE filename LIKE ?').get(prefix + '%');
  return row.total;
}

// 获取所有顶级虚拟文件夹的大小
function getAllFolderSizes() {
  const db = getDb();
  const files = db.prepare('SELECT filename, size FROM files').all();
  const folderSizes = new Map();

  for (const f of files) {
    const name = f.filename;
    if (!name.includes('/')) continue; // 根目录文件
    const topFolder = name.split('/')[0];
    if (!folderSizes.has(topFolder)) folderSizes.set(topFolder, 0);
    folderSizes.set(topFolder, folderSizes.get(topFolder) + f.size);
  }

  return Array.from(folderSizes.entries()).map(([name, size]) => ({ name, size }));
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

function getRateLimitConfig() {
  return { ...RATE_LIMIT_CONFIG };
}

function setRateLimitConfig(overrides) {
  if (typeof overrides.maxAttempts === 'number' && overrides.maxAttempts > 0) {
    RATE_LIMIT_CONFIG.maxAttempts = overrides.maxAttempts;
  }
  if (typeof overrides.lockoutSeconds === 'number' && overrides.lockoutSeconds > 0) {
    RATE_LIMIT_CONFIG.lockoutSeconds = overrides.lockoutSeconds;
  }
  if (typeof overrides.windowSeconds === 'number' && overrides.windowSeconds > 0) {
    RATE_LIMIT_CONFIG.windowSeconds = overrides.windowSeconds;
  }
}

function addSearchHistory(query, userId = null) {
  const db = getDb();
  db.prepare('INSERT INTO search_history(query, user_id) VALUES(?, ?)').run(query, userId);
  // 只保留最近 100 条
  db.prepare('DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY timestamp DESC LIMIT 100)').run();
}

function getSearchHistory(userId = null, limit = 10) {
  const db = getDb();
  if (userId) {
    return db.prepare('SELECT query, timestamp FROM search_history WHERE user_id = ? GROUP BY query ORDER BY MAX(timestamp) DESC LIMIT ?').all(userId, limit);
  }
  return db.prepare('SELECT query, MAX(timestamp) as ts FROM search_history GROUP BY query ORDER BY ts DESC LIMIT ?').all(limit);
}

function clearSearchHistory(userId = null) {
  const db = getDb();
  if (userId) {
    db.prepare('DELETE FROM search_history WHERE user_id = ?').run(userId);
  } else {
    db.prepare('DELETE FROM search_history').run();
  }
}

function getPopularSearches(limit = 5) {
  const db = getDb();
  // Returns the most frequently searched queries (all users, all time)
  return db.prepare(
    'SELECT query, COUNT(*) as count FROM search_history WHERE length(query) >= 2 GROUP BY query ORDER BY count DESC LIMIT ?'
  ).all(limit);
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
  const limit = filters.limit || 100000;
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ?`).all(...params, limit);

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
  // expiresAt: 0/undefined/null → MAX_TS（永不过期）
  const MAX_TS_SECONDS = Math.floor(32503680000000 / 1000); // 32503680000
  const expiresAtSecs = shareData.expiresAt
    ? Math.floor(shareData.expiresAt / 1000)
    : MAX_TS_SECONDS;
  stmt.run(
    shareData.code,
    shareData.filename,
    shareData.isText ? 1 : 0,
    hashedPassword,
    expiresAtSecs,
    shareData.maxDownloads || null,
    0,
    shareData.description || '',
    shareData.createdBy || null
  );
  // 返回完整对象（包含 hasPassword 和内部 _passwordHash）
  return {
    code: shareData.code,
    filename: shareData.filename,
    isText: !!shareData.isText,
    hasPassword: !!hashedPassword,
    _passwordHash: hashedPassword,
    expiresAt: expiresAtSecs * 1000,
    maxDownloads: shareData.maxDownloads || null,
    description: shareData.description || '',
    createdBy: shareData.createdBy || null
  };
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

function updateShareLink(code, updates) {
  const db = getDb();
  const MAX_TS_SECONDS = Math.floor(32503680000000 / 1000);
  const existing = getShareLink(code);
  if (!existing) return { success: false, error: 'Share link not found' };

  const fields = [];
  const values = [];

  if (updates.expiresAt !== undefined) {
    const expiresAtSecs = updates.expiresAt === 0 || updates.expiresAt === null
      ? MAX_TS_SECONDS
      : Math.floor(updates.expiresAt / 1000);
    fields.push('expires_at = ?');
    values.push(expiresAtSecs);
  }

  if (updates.maxDownloads !== undefined) {
    fields.push('max_downloads = ?');
    values.push(updates.maxDownloads || null);
  }

  if (updates.password !== undefined) {
    // null means no password, string means set password
    fields.push('password = ?');
    values.push(updates.password ? hashPassword(updates.password) : null);
  }

  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description || '');
  }

  if (fields.length === 0) {
    return { success: false, error: 'No fields to update' };
  }

  values.push(code);
  db.prepare(`UPDATE share_links SET ${fields.join(', ')} WHERE code = ?`).run(...values);
  return { success: true };
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

function cleanupAuditLog(daysToKeep = 90) {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - daysToKeep * 86400;
  const result = db.prepare('DELETE FROM audit_log WHERE timestamp < ?').run(cutoff);
  if (result.changes > 0) {
    console.log(`[DB] Cleaned up ${result.changes} old audit_log entries`);
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

function getSystemStats() {
  const os = require('os');
  const fs = require('fs');
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const uptime = process.uptime();
  const loadavg = os.loadavg();

  // Disk usage (Node.js 18+)
  let diskUsage = null;
  try {
    // Try statfs (Node 18+)
    const stat = fs.statfsSync ? fs.statfsSync(DB_PATH) : null;
    if (stat) {
      const diskTotal = stat.bsize * stat.blocks;
      const diskFree = stat.bsize * stat.bfree;
      diskUsage = { total: diskTotal, free: diskFree, used: diskTotal - diskFree };
    }
  } catch (e) {}

  // Node version + platform
  const nodeVersion = process.version;
  const platform = os.platform() + ' ' + os.release();

  // CPU cores
  const cpuCores = os.cpus().length;

  return {
    memory: {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      systemTotal: totalMem,
      systemFree: freeMem,
      systemUsed: totalMem - freeMem
    },
    cpu: {
      cores: cpuCores,
      loadavg1m: loadavg[0],
      loadavg5m: loadavg[1],
      loadavg15m: loadavg[2]
    },
    process: {
      uptime,
      nodeVersion,
      platform
    },
    disk: diskUsage
  };
}

function getDashboardStats() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const oneDay = 86400, oneWeek = 604800, oneMonth = 2592000;

  // 文件统计
  const totalFiles = db.prepare('SELECT COUNT(*) as c FROM files').get().c;
  const textFiles = db.prepare("SELECT COUNT(*) as c FROM files WHERE type='text'").get().c;
  const binaryFiles = totalFiles - textFiles;
  const starredFiles = db.prepare('SELECT COUNT(*) as c FROM files WHERE starred=1').get().c;
  const trashCount = db.prepare('SELECT COUNT(*) as c FROM trash').get().c;

  // 存储大小
  const totalSize = db.prepare('SELECT COALESCE(SUM(size), 0) as s FROM files').get().s;

  // 按类型分布
  const byType = db.prepare(`
    SELECT type, COUNT(*) as count, COALESCE(SUM(size), 0) as size
    FROM files GROUP BY type ORDER BY count DESC
  `).all();

  // 按后缀分布（TOP 10）
  const byExt = db.prepare(`
    SELECT
      CASE
        WHEN INSTR(filename, '.') > 0 THEN LOWER(SUBSTR(filename, INSTR(filename, '.') + 1))
        ELSE 'no_ext'
      END as ext,
      COUNT(*) as count
    FROM files
    GROUP BY ext
    ORDER BY count DESC
    LIMIT 10
  `).all();

  // 时间维度
  const today = now - oneDay;
  const thisWeek = now - oneWeek;
  const thisMonth = now - oneMonth;

  const filesToday = db.prepare('SELECT COUNT(*) as c FROM files WHERE created_at >= ?').get(today).c;
  const filesThisWeek = db.prepare('SELECT COUNT(*) as c FROM files WHERE created_at >= ?').get(thisWeek).c;
  const filesThisMonth = db.prepare('SELECT COUNT(*) as c FROM files WHERE created_at >= ?').get(thisMonth).c;

  // 最近7天每日新增文件（用于图表）
  const dailyNew = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = now - (i + 1) * oneDay;
    const dayEnd = now - i * oneDay;
    const count = db.prepare('SELECT COUNT(*) as c FROM files WHERE created_at >= ? AND created_at < ?').get(dayStart, dayEnd).c;
    const date = new Date(dayStart * 1000);
    dailyNew.push({
      date: `${date.getMonth() + 1}/${date.getDate()}`,
      count
    });
  }

  // 活跃分享链接
  const activeShares = db.prepare(`
    SELECT COUNT(*) as c FROM share_links
    WHERE (expires_at IS NULL OR expires_at > ?)
  `).get(now).c;
  const totalShares = db.prepare('SELECT COUNT(*) as c FROM share_links').get().c;
  const sharesWithPwd = db.prepare('SELECT COUNT(*) as c FROM share_links WHERE password_hash IS NOT NULL').get().c;

  // 设备
  const totalDevices = db.prepare('SELECT COUNT(*) as c FROM devices').get().c;
  const onlineDevices = db.prepare('SELECT COUNT(*) as c FROM devices WHERE is_online=1').get().c;

  // Token
  const totalTokens = db.prepare('SELECT COUNT(*) as c FROM tokens').get().c;
  const activeTokens = db.prepare('SELECT COUNT(*) as c FROM tokens WHERE expires_at > ?').get(now).c;

  // 审计日志
  const auditTotal = db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c;
  const auditToday = db.prepare('SELECT COUNT(*) as c FROM audit_log WHERE timestamp >= ?').get(today).c;

  // 同步状态
  const unsynced = db.prepare('SELECT COUNT(*) as c FROM sync_log WHERE synced=0').get().c;

  return {
    files: { total: totalFiles, text: textFiles, binary: binaryFiles, starred: starredFiles, trash: trashCount },
    storage: { total: totalSize },
    byType,
    byExt,
    activity: { today: filesToday, week: filesThisWeek, month: filesThisMonth, dailyNew },
    shares: { active: activeShares, total: totalShares, withPassword: sharesWithPwd },
    devices: { total: totalDevices, online: onlineDevices },
    tokens: { total: totalTokens, active: activeTokens },
    audit: { total: auditTotal, today: auditToday },
    sync: { unsynced }
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
  db.prepare(`INSERT OR REPLACE INTO tag_colors (tag, color, updated_at, last_used) VALUES (?, ?, unixepoch(), unixepoch())`).run(tag, color);
  return { tag, color };
}

function getAllTagColors() {
  const db = getDb();
  return db.prepare('SELECT tag, color, emoji, last_used FROM tag_colors ORDER BY COALESCE(last_used, 0) DESC, updated_at DESC').all();
}

function getSuggestedColor(tag) {
  // 根据 tag 名称生成一致性颜色（不依赖已有颜色表）
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_COLOR_PRESETS[Math.abs(hash) % TAG_COLOR_PRESETS.length];
}

// 更新标签最近使用时间（标签被添加到文件时调用）
function touchTag(tag) {
  const db = getDb();
  db.prepare('INSERT INTO tag_colors (tag, color, updated_at, last_used) VALUES (?, ?, unixepoch(), unixepoch()) ON CONFLICT(tag) DO UPDATE SET last_used = unixepoch()').run(tag, getSuggestedColor(tag));
}

function getTagEmoji(tag) {
  const db = getDb();
  const row = db.prepare('SELECT emoji FROM tag_colors WHERE tag = ?').get(tag);
  return row ? row.emoji : null;
}

function setTagEmoji(tag, emoji) {
  const db = getDb();
  // 确保 color 也存在（INSERT OR REPLACE 需要所有 NOT NULL 列有值）
  const existing = db.prepare('SELECT color FROM tag_colors WHERE tag = ?').get(tag);
  if (existing) {
    db.prepare('UPDATE tag_colors SET emoji = ?, updated_at = unixepoch(), last_used = unixepoch() WHERE tag = ?').run(emoji, tag);
  } else {
    const color = getSuggestedColor(tag);
    db.prepare('INSERT INTO tag_colors (tag, color, emoji, updated_at, last_used) VALUES (?, ?, ?, unixepoch(), unixepoch())').run(tag, color, emoji);
  }
  return { tag, emoji };
}

function deleteTagColor(tag) {
  const db = getDb();
  db.prepare('DELETE FROM tag_colors WHERE tag = ?').run(tag);
}

// 从所有文件提取所有不重复的标签
function getAllTags() {
  const db = getDb();
  const rows = db.prepare('SELECT tags FROM files WHERE tags IS NOT NULL AND tags != ""').all();
  const tagSet = new Set();
  for (const row of rows) {
    const tags = row.tags.split(',').map(t => t.trim()).filter(Boolean);
    tags.forEach(t => tagSet.add(t));
  }
  return Array.from(tagSet).sort();
}

// 重建标签统计（全量扫描 files 表，用于初始化或修复）
function rebuildTagStats() {
  const db = getDb();
  const rows = db.prepare('SELECT tags FROM files WHERE tags IS NOT NULL AND tags != ""').all();
  const counts = {};
  for (const row of rows) {
    for (const t of row.tags.split(',').map(s => s.trim()).filter(Boolean)) {
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  db.prepare('DELETE FROM tag_stats').run();
  const stmt = db.prepare('INSERT OR REPLACE INTO tag_stats (tag, count) VALUES (?, ?)');
  for (const [tag, count] of Object.entries(counts)) {
    stmt.run(tag, count);
  }
  return Object.keys(counts).length;
}

// 增量更新标签统计（addFile/updateFile/deleteFile 时调用）
function updateTagStats(oldTags, newTags) {
  const db = getDb();
  const diff = (tags) => tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const oldList = diff(oldTags);
  const newList = diff(newTags);

  // 删掉的标签计数-1
  for (const t of oldList) {
    if (!newList.includes(t)) {
      db.prepare('UPDATE tag_stats SET count = count - 1 WHERE tag = ? AND count > 0').run(t);
    }
  }
  // 新增的标签计数+1
  for (const t of newList) {
    if (!oldList.includes(t)) {
      db.prepare('INSERT INTO tag_stats (tag, count) VALUES (?, 1) ON CONFLICT(tag) DO UPDATE SET count = count + 1').run(t);
    }
  }
}

// 获取所有标签及使用次数（使用 tag_stats 表，O(1) 而非全表扫描）
function getAllTagsWithStats() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ts.tag, ts.count, tc.color, tc.emoji, tc.last_used
    FROM tag_stats ts
    LEFT JOIN tag_colors tc ON tc.tag = ts.tag
    WHERE ts.count > 0
    ORDER BY ts.count DESC
  `).all();
  return rows.map(r => ({ tag: r.tag, count: r.count, color: r.color, emoji: r.emoji, last_used: r.last_used }));
}

// 确保 tag_stats 初始化（懒加载，在 getAllTagsWithStats 首次调用时）
function ensureTagStats() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM tag_stats').get().c;
  if (count === 0) {
    rebuildTagStats();
  }
}

// 批量重命名标签（SQL 直接替换，避免 listFiles 100 条限制）
function renameTagGlobally(oldTag, newTag) {
  // 校验标签名（防止 LIKE 注入和无效字符）
  if (!oldTag || !newTag || oldTag.includes(',') || newTag.includes(',')) {
    return { updated: 0, error: 'Invalid tag name' };
  }
  // 转义 LIKE 特殊字符（% 和 _）
  const escapeLike = (s) => String(s).replace(/[%_]/g, (c) => c === '%' ? '\\%' : '\\_');
  const db = getDb();
  const rows = db.prepare("SELECT id, tags FROM files WHERE tags LIKE ? ESCAPE '\\'").all('%' + escapeLike(oldTag) + '%');
  let updated = 0;
  for (const row of rows) {
    const tags = row.tags.split(',').map(s => s.trim());
    const idx = tags.indexOf(oldTag);
    if (idx !== -1) {
      tags[idx] = newTag;
      db.prepare("UPDATE files SET tags = ?, updated_at = unixepoch() WHERE id = ?").run(tags.join(','), row.id);
      updated++;
    }
  }
  // 更新 tag_stats：如果 newTag 已存在则合并，否则直接重命名
  const oldStat = db.prepare('SELECT count FROM tag_stats WHERE tag = ?').get(oldTag);
  const oldCount = oldStat ? oldStat.count : 0;
  const newStat = db.prepare('SELECT count FROM tag_stats WHERE tag = ?').get(newTag);
  if (newStat) {
    db.prepare('UPDATE tag_stats SET count = count + ? WHERE tag = ?').run(updated, newTag);
    if (oldCount > 0) db.prepare('DELETE FROM tag_stats WHERE tag = ?').run(oldTag);
  } else {
    if (oldCount > 0) {
      db.prepare('UPDATE tag_stats SET tag = ? WHERE tag = ?').run(newTag, oldTag);
    }
  }
  return { updated };
}

// 批量删除标签（从所有文件移除）
function deleteTagFromAllFiles(tag) {
  const db = getDb();
  const rows = db.prepare("SELECT id, tags FROM files WHERE tags LIKE ?").all('%' + tag + '%');
  let updated = 0;
  for (const row of rows) {
    const tags = row.tags.split(',').map(s => s.trim()).filter(s => s !== tag);
    db.prepare("UPDATE files SET tags = ?, updated_at = unixepoch() WHERE id = ?").run(tags.join(',') || null, row.id);
    updated++;
  }
  db.prepare('UPDATE tag_stats SET count = 0 WHERE tag = ?').run(tag);
  return { updated };
}

function mergeTags(sources, target) {
  // 将所有 source 标签合并到 target（从每个文件的标签列表中移除 source，加入 target）
  const db = getDb();
  const allTags = [target, ...sources];

  // 找到所有包含任一 source 标签的文件
  const conditions = sources.map(() => `tags LIKE ?`).join(' OR ');
  const params = sources.map(s => `%${s}%`);
  const rows = db.prepare(`SELECT id, tags FROM files WHERE ${conditions}`).all(...params);

  let updated = 0;
  for (const row of rows) {
    const fileTags = row.tags ? row.tags.split(',').map(s => s.trim()).filter(Boolean) : [];

    // 检查是否包含任何 source 标签
    const hasSource = fileTags.some(t => sources.includes(t));
    if (!hasSource) continue;

    // 移除所有 source 标签，加入 target（如果还没有）
    const newTags = fileTags.filter(t => !sources.includes(t));
    if (!newTags.includes(target)) {
      newTags.push(target);
    }

    const newTagsStr = newTags.join(',');
    db.prepare("UPDATE files SET tags = ?, updated_at = unixepoch() WHERE id = ?").run(newTagsStr, row.id);
    updated++;
  }

  // 清理被合并的 source 标签的 tag_stats
  for (const src of sources) {
    db.prepare('UPDATE tag_stats SET count = 0 WHERE tag = ?').run(src);
    // 将 color 从 source 转移到 target（如果 target 还没有 color）
    const srcColor = db.getTagColor(src);
    const tgtColor = db.getTagColor(target);
    if (srcColor && !tgtColor) {
      db.setTagColor(target, srcColor);
    }
    db.deleteTagColor(src);
  }

  return { updated };
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

// ============================================================
// 分片上传管理
// ============================================================
function initChunkUpload(uploadId, filename, totalChunks, fileHash = null, size = 0) {
  if (!validateFilename(filename)) throw new Error('Invalid filename');
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO upload_chunks (upload_id, filename, total_chunks, file_hash, size, received_chunks) VALUES (?, ?, ?, ?, ?, '[]')`)
    .run(uploadId, filename, totalChunks, fileHash, size);
}

function getChunkUpload(uploadId) {
  const db = getDb();
  return db.prepare('SELECT * FROM upload_chunks WHERE upload_id = ?').get(uploadId);
}

function addChunkReceived(uploadId, chunkIndex) {
  const db = getDb();
  const row = db.prepare('SELECT received_chunks FROM upload_chunks WHERE upload_id = ?').get(uploadId);
  if (!row) return null;
  let received = JSON.parse(row.received_chunks || '[]');
  if (!received.includes(chunkIndex)) {
    received.push(chunkIndex);
    received.sort((a, b) => a - b);
    db.prepare('UPDATE upload_chunks SET received_chunks = ? WHERE upload_id = ?').run(JSON.stringify(received), uploadId);
  }
  return received;
}

function getChunkUploadStatus(uploadId) {
  const db = getDb();
  const row = db.prepare('SELECT filename, total_chunks, received_chunks FROM upload_chunks WHERE upload_id = ?').get(uploadId);
  if (!row) return null;
  const received = JSON.parse(row.received_chunks || '[]');
  return { filename: row.filename, totalChunks: row.total_chunks, receivedChunks: received };
}

function deleteChunkUpload(uploadId) {
  const db = getDb();
  db.prepare('DELETE FROM upload_chunks WHERE upload_id = ?').run(uploadId);
}

// 获取某个文件名的未完成上传（用于断点续传）
function getIncompleteUpload(filename) {
  const db = getDb();
  const row = db.prepare(
    'SELECT upload_id, filename, total_chunks, received_chunks FROM upload_chunks WHERE filename = ? ORDER BY created_at DESC LIMIT 1'
  ).get(filename);
  if (!row) return null;
  const received = JSON.parse(row.received_chunks || '[]');
  return { ...row, receivedChunks: received };
}

module.exports = {
  initDatabase,
  getDb,
  // 密码
  hashPassword, verifyPassword,
  // 文件
  addFile, getFile, getFileByName, toggleStar, listFiles, updateFile, updateFileByName,
  deleteFile, deleteFileByName, renameFile, deleteOldFiles, deleteAllFiles,
  deleteFilesByPrefix, renameFilesByPrefix, moveFile, moveFilesByPrefix, copyFile, copyFilesByPrefix, batchMove, batchCopy, getFilesByPrefix,
  setFilePositions,
  searchFiles, getFilesByHashSince, getFileCount, getTotalStorageSize, getFolderSize, getAllFolderSizes, findDuplicates,
  // 设备
  registerDevice, getDevice, listDevices, setDeviceOffline, setDeviceOnline,
  touchDevice, getOnlineDevices, cleanupStaleDevices,
  // 同步
  addSyncLog, getUnsyncedLogs, markLogsSynced, getSyncStatus,
  // Token
  generateToken, validateToken, refreshToken, revokeToken, revokeAllTokens,
  // 审计
  addAuditLog, listAuditLogs, getAuditStats, exportAuditLogsCSV,
  // 速率限制
  checkRateLimit, recordRateLimitAttempt, getRateLimitConfig, setRateLimitConfig,
  // 搜索历史
  addSearchHistory, getSearchHistory, clearSearchHistory, getPopularSearches,
  // 分享链接
  saveShareLink, getShareLink, updateShareLink, deleteShareLink, incrementShareLinkDownload,
  listShareLinks, cleanupExpiredShareLinks,
  // 迁移
  migrateFromFileSystem,
  // 清理
  cleanupExpiredTokens,
  // DB 健康
  cleanupSyncLog, cleanupAuditLog, getDbStats, getSystemStats, getDashboardStats, runVacuum, checkDbIntegrity,
  // 标签颜色
  getTagColor, setTagColor, getAllTagColors, getSuggestedColor, deleteTagColor, touchTag,
  getTagEmoji, setTagEmoji, getAllTags, getAllTagsWithStats, renameTagGlobally, deleteTagFromAllFiles, mergeTags,
  // 回收站
  moveToTrash, permanentlyDeleteFile, listTrash, restoreFromTrash, permanentlyDeleteTrash, cleanupExpiredTrash,
  // 文件版本历史
  saveFileVersion, listFileVersions, getFileVersion, getFileVersionCount, deleteFileVersion, pruneFileVersions,
  // 分片上传
  initChunkUpload, getChunkUpload, addChunkReceived, getChunkUploadStatus, deleteChunkUpload, getIncompleteUpload
};
