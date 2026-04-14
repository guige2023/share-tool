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
const SCHEMA_VERSION = 22; // v22: virtual_folders.quota_bytes

// HTML escape for FTS5 storage (prevents XSS when highlight() injects <mark> into filenames)
function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    db.pragma('auto_vacuum = INCREMENTAL');
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
    initSchemaV6(db);
    initSchemaV7(db);
    initSchemaV8(db);
    initSchemaV9(db);   // v9: FTS5 full-text search index
    initSchemaV10(db); // v10: unused (no-op)
    initSchemaV11(db); // v11: share_links.view_count
    initSchemaV12(db); // v12: files.starred
    initSchemaV13(db); // v13: share_links theme columns
    initSchemaV14(db); // v14: folder_tags + tag_definitions
    initSchemaV15(db); // v15: request_link_files table
    initSchemaV16(db); // v16: no-op (SQLite durability hardening was applied in initDb)
    initSchemaV17(db); // v17: file notes
    initSchemaV18(db); // v18: share_links.label
    initSchemaV19(db); // v19: share_link_stats table
    initSchemaV20(db); // v20: virtual_folders.password_hash
    initSchemaV21(db); // v21: sync_conflicts table
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    console.log('[DB] Fresh database initialized (v1-v20 schema)');
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

  // 虚拟文件夹表
  db.exec(`
    CREATE TABLE IF NOT EXISTS virtual_folders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      description TEXT    DEFAULT '',
      color       TEXT    DEFAULT '#667eea',
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // 虚拟文件夹-文件关联表
  db.exec(`
    CREATE TABLE IF NOT EXISTS virtual_folder_files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id   INTEGER NOT NULL,
      file_id     INTEGER NOT NULL,
      added_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (folder_id) REFERENCES virtual_folders(id) ON DELETE CASCADE,
      FOREIGN KEY (file_id)   REFERENCES files(id)       ON DELETE CASCADE,
      UNIQUE(folder_id, file_id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vf_folder ON virtual_folder_files(folder_id);
    CREATE INDEX IF NOT EXISTS idx_vf_file   ON virtual_folder_files(file_id);
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
      is_online    INTEGER NOT NULL DEFAULT 1,
      last_sync_at INTEGER,
      synced_files INTEGER DEFAULT 0
    )
  `);
  
  // 迁移：为 devices 表添加缺失的 last_sync_at 和 synced_files 列（如果表已存在）
  try {
    db.prepare("SELECT last_sync_at FROM devices LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE devices ADD COLUMN last_sync_at INTEGER; ALTER TABLE devices ADD COLUMN synced_files INTEGER DEFAULT 0;");
  }

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

  // 文件访问日志表（记录每个文件的浏览/下载）
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_access_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id    INTEGER NOT NULL,
      action     TEXT    NOT NULL,
      ip         TEXT,
      timestamp  INTEGER NOT NULL DEFAULT (unixepoch())
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

  // 通知表
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      message     TEXT,
      read        INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
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

  // 文件收集链接表（公开上传页面）
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_links (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT    NOT NULL UNIQUE,
      name          TEXT    NOT NULL,
      target_folder TEXT    NOT NULL DEFAULT '',
      password      TEXT,
      max_uploads   INTEGER,
      upload_count  INTEGER NOT NULL DEFAULT 0,
      expires_at    INTEGER,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by    TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_request_links_code ON request_links(code)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_request_links_active ON request_links(active)`);

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
    CREATE INDEX IF NOT EXISTS idx_file_access_log_file_id ON file_access_log(file_id);
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
    const rows = db.prepare("SELECT tags FROM files WHERE tags IS NOT NULL AND tags != ''").all();
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

function initSchemaV7(db) {
  // v7 修复：trash 表存储 tags（恢复时需要）
  try {
    db.exec("ALTER TABLE trash ADD COLUMN tags TEXT DEFAULT ''");
    console.log('[DB] Migrated: trash.tags column');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }
}

function initSchemaV8(db) {
  // v8 新增：virtual_folders.position（拖拽排序）
  try {
    db.exec("ALTER TABLE virtual_folders ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
    console.log('[DB] Migrated: virtual_folders.position column');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }
}

function initSchemaV10(db) {
  // v10: unused — skipped after v9 refactor (kept for migration compat)
}

function initSchemaV11(db) {
  // v11: add view_count to share_links for tracking link opens
  try {
    db.exec(`ALTER TABLE share_links ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0`);
    console.log('[DB] Migrated: share_links.view_count');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('[DB] share_links.view_count already exists');
    } else {
      console.error('[DB] view_count migration failed:', e.message);
    }
  }
}

function initSchemaV12(db) {
  // v12: add starred column to files
  try {
    db.exec(`ALTER TABLE files ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`);
    console.log('[DB] Migrated: files.starred');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('[DB] files.starred already exists, skipping');
    } else {
      console.warn('[DB] Migration v12 failed:', e.message);
    }
  }
}

function initSchemaV13(db) {
  // v13: add theme columns to share_links
  try {
    db.exec(`ALTER TABLE share_links ADD COLUMN theme_bg TEXT`);
    db.exec(`ALTER TABLE share_links ADD COLUMN theme_color TEXT`);
    db.exec(`ALTER TABLE share_links ADD COLUMN brand_text TEXT`);
    console.log('[DB] Migrated: share_links theme columns');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('[DB] share_links theme columns already exist, skipping');
    } else {
      console.warn('[DB] Migration v13 failed:', e.message);
    }
  }
}

function initSchemaV14(db) {
  // v14: folder_tags + tag_definitions tables
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tag_definitions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL UNIQUE,
        color      TEXT    NOT NULL DEFAULT '#e0e7ff',
        icon       TEXT    NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS folder_tags (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_path TEXT    NOT NULL,
        tag_id     INTEGER NOT NULL,
        added_at   INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (tag_id) REFERENCES tag_definitions(id) ON DELETE CASCADE,
        UNIQUE(folder_path, tag_id)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_folder_tags_path ON folder_tags(folder_path)`);
    console.log('[DB] Migrated: folder_tags + tag_definitions tables');
  } catch (e) {
    console.warn('[DB] Migration v14 failed:', e.message);
  }
}

function initSchemaV15(db) {
  // v15: request_link_files table for tracking which files were uploaded via request links
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS request_link_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_link_id INTEGER NOT NULL,
        file_id INTEGER NOT NULL,
        uploaded_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (request_link_id) REFERENCES request_links(id) ON DELETE CASCADE,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rlf_request_link ON request_link_files(request_link_id)`);
    console.log('[DB] Migrated: request_link_files table');
  } catch (e) {
    console.warn('[DB] Migration v15 failed:', e.message);
  }
}

function initSchemaV16(db) {
  // v16: no-op — SQLite durability hardening (auto_vacuum, busy_timeout, synchronous) applied in initDb
}

function initSchemaV17(db) {
  // v17: file notes column
  try {
    db.exec(`ALTER TABLE files ADD COLUMN notes TEXT DEFAULT ''`);
    console.log('[DB] Migrated: notes column on files');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('[DB] Notes column already exists');
    } else {
      console.warn('[DB] Migration v17 failed:', e.message);
    }
  }
}

function initSchemaV18(db) {
  // v18: share_links.label — custom display name
  try {
    db.exec(`ALTER TABLE share_links ADD COLUMN label TEXT DEFAULT ''`);
    console.log('[DB] Migrated: share_links.label');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('[DB] share_links.label already exists');
    } else {
      console.warn('[DB] Migration v18 failed:', e.message);
    }
  }
}

function initSchemaV19(db) {
  // v19: share_link_stats — daily view/download counts per share link
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS share_link_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_code TEXT NOT NULL,
        day TEXT NOT NULL,
        views INTEGER DEFAULT 0,
        downloads INTEGER DEFAULT 0,
        UNIQUE(share_code, day)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sls_share_day ON share_link_stats(share_code, day)`);
    console.log('[DB] Migrated: share_link_stats table');
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('[DB] share_link_stats already exists');
    } else {
      console.warn('[DB] Migration v19 failed:', e.message);
    }
  }
}

function initSchemaV20(db) {
  // v20: virtual_folders.password_hash — password-protect virtual folders
  try {
    db.exec(`ALTER TABLE virtual_folders ADD COLUMN password_hash TEXT DEFAULT NULL`);
    console.log('[DB] Migrated: virtual_folders.password_hash');
  } catch (e) {
    if (e.message.includes('duplicate column') || e.message.includes('already exists')) {
      console.log('[DB] virtual_folders.password_hash already exists');
    } else {
      console.warn('[DB] Migration v20 failed:', e.message);
    }
  }
}

function initSchemaV21(db) {
  // v21: sync_conflicts table — track file sync conflicts for resolution
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_conflicts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        filename        TEXT    NOT NULL,
        local_hash      TEXT,
        remote_hash     TEXT,
        local_content   TEXT,
        remote_content  TEXT,
        local_device_id TEXT,
        remote_device_id TEXT,
        detected_at     INTEGER DEFAULT (unixepoch()),
        resolved        INTEGER DEFAULT 0,
        resolution      TEXT    DEFAULT NULL,
        resolved_at     INTEGER DEFAULT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sc_filename ON sync_conflicts(filename)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sc_resolved ON sync_conflicts(resolved)`);
    console.log('[DB] Migrated: sync_conflicts table');
  } catch (e) {
    console.warn('[DB] Migration v21 failed:', e.message);
  }
}

function initSchemaV22(db) {
  // v22: add quota_bytes to virtual_folders
  try {
    db.exec(`ALTER TABLE virtual_folders ADD COLUMN quota_bytes INTEGER DEFAULT 0`);
    console.log('[DB] Migrated: virtual_folders.quota_bytes');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('[DB] v22 column already exists, skipping');
    } else {
      console.warn('[DB] Migration v22 failed:', e.message);
    }
  }
}

function initSchemaV9(db) {
  // v9 新增：FTS5 全文搜索索引
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        filename,
        tags,
        content='files',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      )
    `);
    console.log('[DB] Migrated: files_fts FTS5 virtual table');

    // 重建索引：填充现有数据（用 JS 遍历避免 SQL escapeHtml UDF 依赖）
    const existingFiles = db.prepare('SELECT id, filename, tags FROM files').all();
    if (existingFiles.length > 0) {
      const insertFts = db.prepare('INSERT INTO files_fts(rowid, filename, tags) VALUES (?, ?, ?)');
      for (const f of existingFiles) {
        insertFts.run(f.id, escapeHtml(f.filename), f.tags || '');
      }
    }
    console.log('[DB] FTS5 index seeded with existing files (' + existingFiles.length + ' rows)');

    // 创建触发器：insert（用 SQLite REPLACE 模拟 escapeHtml，避免 JS UDF 依赖）
    const ftsEscape = function(col) {
      return `REPLACE(REPLACE(REPLACE(${col}, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')`;
    };
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS files_fts_insert AFTER INSERT ON files BEGIN
        INSERT INTO files_fts(rowid, filename, tags) VALUES (NEW.id, ${ftsEscape('NEW.filename')}, COALESCE(NEW.tags, ''));
      END
    `);
    // 创建触发器：delete
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS files_fts_delete AFTER DELETE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, filename, tags) VALUES('delete', OLD.id, ${ftsEscape('OLD.filename')}, COALESCE(OLD.tags, ''));
      END
    `);
    // 创建触发器：update
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS files_fts_update AFTER UPDATE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, filename, tags) VALUES('delete', OLD.id, ${ftsEscape('OLD.filename')}, COALESCE(OLD.tags, ''));
        INSERT INTO files_fts(rowid, filename, tags) VALUES (NEW.id, ${ftsEscape('NEW.filename')}, COALESCE(NEW.tags, ''));
      END
    `);
    console.log('[DB] FTS5 triggers created');
  } catch (e) {
    console.error('[DB] FTS5 migration failed:', e.message);
    throw e;
  }
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
    } else if (v === 7) {
      initSchemaV7(db);
    } else if (v === 8) {
      initSchemaV8(db);
    } else if (v === 9) {
      initSchemaV9(db);
    } else if (v === 10) {
      initSchemaV10(db);
    } else if (v === 11) {
      initSchemaV11(db);
    } else if (v === 12) {
      initSchemaV12(db);
    } else if (v === 13) {
      initSchemaV13(db);
    } else if (v === 14) {
      initSchemaV14(db);
    } else if (v === 15) {
      initSchemaV15(db);
    } else if (v === 16) {
      // v16: no schema change (SQLite durability hardening was applied in initDb)
    } else if (v === 17) {
      initSchemaV17(db);
    } else if (v === 18) {
      initSchemaV18(db);
    } else if (v === 19) {
      // v19: no-op
    } else if (v === 20) {
      initSchemaV20(db);
    } else if (v === 21) {
      initSchemaV21(db);
    } else if (v === 22) {
      initSchemaV22(db);
    }
    console.log(`[DB] Migration to v${v} complete`);
  }
}

// ============================================================
// FTS5 全文搜索
// ============================================================
function searchFilesFTS(query, tags = null, opts = {}) {
  const db = getDb();
  const { limit = 100, offset = 0, tagMatch = 'all', size_min, size_max, date_from, date_to, type, starred, mode = 'normal' } = opts;
  // glob/regex mode: FTS5 cannot handle these patterns — return null to trigger fallback
  if (mode !== 'normal') return null;

  // 检查 FTS5 表是否存在
  try {
    db.prepare("SELECT COUNT(*) FROM files_fts").get();
  } catch (e) {
    return null; // FTS5 不可用，返回 null 让调用方 fallback
  }

  // 无查询词且无过滤条件：直接走列表
  if (!query && !tags && !size_min && !size_max && !date_from && !date_to && !type && starred == null) {
    return db.prepare(`SELECT ${FILE_LIST_FIELDS} FROM files ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
  }

  const tokens = tokenizeQuery(query);
  const fetchLimit = limit + offset; // fetch enough to cover offset

  // 构建 FTS5 MATCH 表达式
  let ftsResults = [];
  if (tokens.length > 0) {
    const ftsQuery = tokens.map(t => `"${t.replace(/"/g, '""')}*`).join(' OR ');
    try {
      // FTS5 highlight() returns filename with matching terms wrapped in <mark> tags
      ftsResults = db.prepare(`
        SELECT f.*, bm25(files_fts) as fts_rank,
               highlight(files_fts, 1, '<mark class="search-highlight">', '</mark>') as highlighted_name
        FROM files_fts
        JOIN files f ON f.id = files_fts.rowid
        WHERE files_fts MATCH ?
        ORDER BY fts_rank
        LIMIT ?
      `).all(ftsQuery, fetchLimit * 2);
    } catch (e) {
      ftsResults = [];
    }
  } else {
    ftsResults = db.prepare(`SELECT ${FILE_LIST_FIELDS} FROM files ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(fetchLimit, 0);
  }

  // 无任何过滤：直接返回（已带 offset）
  if (!tags && !size_min && !size_max && !date_from && !date_to && !type && starred == null) {
    return ftsResults.slice(offset, offset + limit);
  }

  // 后置过滤：标签 + size + date + type（filter 之后 slice）
  const tagList = tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : [];
  return ftsResults.filter(f => {
    const fileTags = (f.tags || '').toLowerCase();

    // 标签过滤
    if (tagList.length > 0) {
      if (tagMatch === 'any') {
        if (!tagList.some(t => fileTags.includes(t))) return false;
      } else {
        if (!tagList.every(t => fileTags.includes(t))) return false;
      }
    }

    // 大小过滤
    if (size_min != null && f.size < size_min) return false;
    if (size_max != null && f.size > size_max) return false;

    // 日期过滤
    if (date_from != null && f.created_at < date_from) return false;
    if (date_to != null && f.created_at > date_to) return false;

    // 类型过滤（按数据库 type 字段：text/image/file）
    if (type) {
      const filterTypes = Array.isArray(type) ? type : [type];
      if (!filterTypes.includes(f.type)) return false;
    }

    // 星标过滤
    if (starred === true && !f.starred) return false;
    if (starred === false && f.starred) return false;

    return true;
  }).slice(offset, offset + limit);
}

// ============================================================
// 文件操作
// ============================================================
const FILE_FIELDS = 'id, filename, content, type, size, hash, tags, encrypted, starred, position, created_at, updated_at, content_type';
const FILE_LIST_FIELDS = 'id, filename, type, size, hash, tags, encrypted, starred, position, created_at, updated_at, content_type';

// MIME type detection from filename extension
const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.txt': 'text/plain',
};

function detectMimeType(filename) {
  const lower = filename.toLowerCase();
  for (const [ext, mime] of Object.entries(MIME_TYPES)) {
    if (lower.endsWith(ext)) return mime;
  }
  return 'application/octet-stream';
}

// Security helper: validate filename against path traversal
function validateFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.length > 255) return false;  // 文件名过长
  if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\') || filename.includes('\x00')) return false;
  return true;
}

function addFile(filename, content, type = 'file', hash = null, encrypted = false, requestLinkId = null) {
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
    const contentType = type === 'text' ? 'text/plain' : detectMimeType(filename);
    const stmt = db.prepare(`
      INSERT INTO files (filename, content, type, size, hash, encrypted, content_type, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `);
    const result = stmt.run(filename, content || null, type, size, hash, encrypted ? 1 : 0, contentType, maxPos + 1);
    const fileId = result.lastInsertRowid;

    // 记录同步日志（使用真实的 fileId）
    addSyncLog(fileId, filename, 'create', hash, null, size);

    // Track file in request_link_files if uploaded via a request link
    if (requestLinkId !== null) {
      db.prepare(`INSERT INTO request_link_files (request_link_id, file_id) VALUES (?, ?)`).run(requestLinkId, fileId);
    }

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

function listFiles(limit = 100, offset = 0, sort = 'created_at', order = 'DESC', folder = null, starred = false, tags = null, typeFilter = null, tagMatch = 'OR') {
  const db = getDb();
  const safeOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const safeSort = ['created_at', 'updated_at', 'filename', 'size', 'type', 'tags', 'position', 'starred'].includes(sort) ? sort : 'created_at';

  // Build WHERE clause
  const conditions = [];
  const params = [];
  if (folder) { conditions.push('filename LIKE ? ESCAPE ?'); params.push(folder + '/%', '\\'); }
  if (starred) { conditions.push('starred = 1'); }
  if (typeFilter) {
    // typeFilter now maps to MIME-based filtering
    const typeMap = {
      text: "type = 'text'",
      image: "content_type LIKE 'image/%'",
      video: "content_type LIKE 'video/%'",
      audio: "content_type LIKE 'audio/%'",
      pdf: "content_type = 'application/pdf'",
      document: "content_type LIKE 'application/vnd%' OR content_type LIKE 'application/ms%' OR content_type = 'application/vnd.openxmlformats-officedocument%'",
      doc: "content_type LIKE 'application/vnd%' OR content_type LIKE 'application/ms%' OR content_type = 'application/vnd.openxmlformats-officedocument%'",
      archive: "content_type LIKE 'application/zip' OR content_type LIKE 'application/x-rar%' OR content_type LIKE 'application/x-7z%' OR content_type LIKE 'application/x-tar%' OR content_type LIKE 'application/gzip'"
    };
    // typeFilter can be a single string or an array of strings (multi-select)
    const filterTypes = Array.isArray(typeFilter) ? typeFilter : (typeFilter ? [typeFilter] : []);
    const typeConditions = filterTypes.map(function(t) { return typeMap[t]; }).filter(Boolean);
    if (typeConditions.length > 0) {
      conditions.push('(' + typeConditions.join(' OR ') + ')');
    }
  }
  if (tags) {
    // tagMatch: 'OR' (any tag) or 'AND' (all tags must be present)
    const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
    if (tagList.length > 0) {
      const joinOp = tagMatch === 'AND' ? ' AND ' : ' OR ';
      const tagConditions = tagList.map(() => 'LOWER(tags) LIKE ?').join(joinOp);
      conditions.push('(' + tagConditions + ')');
      tagList.forEach(tag => params.push('%' + tag.toLowerCase() + '%'));
    }
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  // Single query with window function: get files + total count in one round-trip
  const files = db.prepare(`
    SELECT ${FILE_LIST_FIELDS}, COUNT(*) OVER() as _total FROM files
    ${where}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = files.length > 0 ? (files[0]._total || 0) : 0;
  // Strip internal _total field before returning
  files.forEach(f => { delete f._total; });
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

function getStarredFiles() {
  const db = getDb();
  return db.prepare('SELECT * FROM files WHERE starred = 1 AND type = ? ORDER BY updated_at DESC').all('file');
}

// ============================================================
// 虚拟文件夹
// ============================================================
function createVirtualFolder(name, description = '', color = '#667eea') {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM virtual_folders WHERE name = ?').get(name);
  if (existing) return { success: false, error: 'Folder name already exists' };
  const result = db.prepare('INSERT INTO virtual_folders (name, description, color) VALUES (?, ?, ?)')
    .run(name, description, color);
  return { success: true, id: result.lastInsertRowid, name, description, color };
}

function listVirtualFolders() {
  const db = getDb();
  const folders = db.prepare('SELECT * FROM virtual_folders ORDER BY position ASC, created_at DESC').all();
  // Batch count + total size: single query with GROUP BY instead of N separate queries
  const stats = db.prepare(`
    SELECT vff.folder_id, COUNT(*) as count, COALESCE(SUM(f.size), 0) as totalSize
    FROM virtual_folder_files vff
    JOIN files f ON f.id = vff.file_id
    GROUP BY vff.folder_id
  `).all();
  const statsMap = {};
  stats.forEach(s => { statsMap[s.folder_id] = { count: s.count, totalSize: s.totalSize }; });
  return folders.map(f => ({
    ...f,
    file_count: statsMap[f.id] ? statsMap[f.id].count : 0,
    total_size: statsMap[f.id] ? statsMap[f.id].totalSize : 0,
    has_password: !!f.password_hash
  }));
}

function getVirtualFolderSize(folderId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(f.size), 0) as totalSize
    FROM virtual_folder_files vff
    JOIN files f ON f.id = vff.file_id
    WHERE vff.folder_id = ?
  `).get(folderId);
  return { file_count: row ? row.count : 0, total_size: row ? row.totalSize : 0 };
}

function getVirtualFolder(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM virtual_folders WHERE id = ?').get(id);
}

function deleteVirtualFolder(id) {
  const db = getDb();
  db.prepare('DELETE FROM virtual_folders WHERE id = ?').run(id);
  return { success: true };
}

function setVirtualFolderPassword(folderId, password) {
  const db = getDb();
  const hash = password ? hashPassword(password) : null;
  db.prepare('UPDATE virtual_folders SET password_hash = ? WHERE id = ?').run(hash, folderId);
  return { success: true };
}

function verifyVirtualFolderPassword(folderId, inputPwd) {
  const db = getDb();
  const row = db.prepare('SELECT password_hash FROM virtual_folders WHERE id = ?').get(folderId);
  if (!row) return false;
  if (!row.password_hash) return true; // No password set — always allow
  return verifyPassword(inputPwd, row.password_hash);
}

function addFileToVirtualFolder(folderId, fileId) {
  const db = getDb();
  try {
    db.prepare('INSERT INTO virtual_folder_files (folder_id, file_id) VALUES (?, ?)').run(folderId, fileId);
    return { success: true };
  } catch (e) {
    if (e.message.includes('UNIQUE')) return { success: false, error: 'File already in this folder' };
    throw e;
  }
}

function removeFileFromVirtualFolder(folderId, fileId) {
  const db = getDb();
  db.prepare('DELETE FROM virtual_folder_files WHERE folder_id = ? AND file_id = ?').run(folderId, fileId);
  return { success: true };
}

function getVirtualFolderFiles(folderId, limit = 100) {
  const db = getDb();
  return db.prepare(`
    SELECT f.${FILE_LIST_FIELDS}, v.added_at
    FROM virtual_folder_files v
    JOIN files f ON f.id = v.file_id
    WHERE v.folder_id = ?
    ORDER BY v.added_at DESC
    LIMIT ?
  `).all(folderId, limit);
}

function isFileInVirtualFolder(folderId, fileId) {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM virtual_folder_files WHERE folder_id = ? AND file_id = ?').get(folderId, fileId);
  return !!row;
}

function updateVirtualFolder(id, updates) {
  const db = getDb();
  const fields = [];
  const values = [];
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.color !== undefined) { fields.push('color = ?'); values.push(updates.color); }
  if (updates.quota_bytes !== undefined) { fields.push('quota_bytes = ?'); values.push(updates.quota_bytes); }
  if (fields.length === 0) return { success: false, error: 'No fields to update' };
  values.push(id);
  db.prepare(`UPDATE virtual_folders SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return { success: true };
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
  if (updates.content !== undefined) {
    // Re-detect MIME type when content changes
    fields.push('content_type = ?');
    values.push(existing.type === 'text' ? 'text/plain' : detectMimeType(existing.filename));
  }
  if (updates.tags !== undefined) {
    updateTagStats(existing.tags, updates.tags);
    fields.push('tags = ?');
    values.push(updates.tags);
  }
  if (updates.encrypted !== undefined) { fields.push('encrypted = ?'); values.push(updates.encrypted ? 1 : 0); }
  if (updates.starred !== undefined) { fields.push('starred = ?'); values.push(updates.starred ? 1 : 0); }
  if (updates.notes !== undefined) { fields.push('notes = ?'); values.push(updates.notes || ''); }

  fields.push('updated_at = unixepoch()');
  values.push(filename);

  const stmt = db.prepare(`UPDATE files SET ${fields.join(', ')} WHERE filename = ?`);
  stmt.run(...values);
  const updated = getFileByName(filename);
  addSyncLog(updated.id, filename, 'update', updated.hash, null, updated.size);
  return updated;
}

function getFileNotes(filename) {
  const file = getFileByName(filename);
  return file ? (file.notes || '') : '';
}

function updateFileNotes(filename, notes) {
  const db = getDb();
  db.prepare(`UPDATE files SET notes = ?, updated_at = unixepoch() WHERE filename = ?`).run(notes || '', filename);
  return { success: true, notes: notes || '' };
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
  if (updates.starred !== undefined) { fields.push('starred = ?'); values.push(updates.starred ? 1 : 0); }
  if (updates.notes !== undefined) { fields.push('notes = ?'); values.push(updates.notes || ''); }

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
  const result = db.prepare(`
    INSERT INTO trash (file_id, filename, content, size, type, hash, tags, deleted_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch() + 2592000)
  `).run(existing.id, existing.filename, existing.content, existing.size, existing.type, existing.hash, existing.tags || '');
  addSyncLog(existing.id, filename, 'delete', existing.hash, null, existing.size);
  db.prepare('DELETE FROM files WHERE filename = ?').run(filename);
  return result.lastInsertRowid;
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

// 批量删除文件（进回收站）
function deleteFiles(filenames) {
  const db = getDb();
  if (!Array.isArray(filenames) || filenames.length === 0) return { deleted: 0, failed: 0, errors: [] };
  const errors = [];
  let deleted = 0;
  const now = Math.floor(Date.now() / 1000);
  const expireAt = now + 2592000; // 30天

  // 单事务批量处理
  const transaction = db.transaction(() => {
    for (const filename of filenames) {
      try {
        const existing = getFileByName(filename);
        if (!existing) {
          errors.push({ filename, error: '文件不存在' });
          continue;
        }
        // 软删除：写入 trash 表
        db.prepare(`
          INSERT INTO trash (file_id, filename, content, size, type, hash, tags, deleted_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(existing.id, existing.filename, existing.content, existing.size, existing.type, existing.hash, existing.tags || '', now, expireAt);
        // 写 sync_log
        addSyncLog(existing.id, filename, 'delete', existing.hash, null, existing.size);
        // 从 files 表删除
        db.prepare('DELETE FROM files WHERE filename = ?').run(filename);
        // 更新标签统计
        updateTagStats(existing.tags, null);
        deleted++;
      } catch (e) {
        errors.push({ filename, error: e.message });
      }
    }
  });

  try {
    transaction();
  } catch (e) {
    errors.push({ error: e.message });
  }

  return { deleted, failed: filenames.length - deleted, errors };
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
  // 恢复文件（保留 tags，从 trash 中取出）
  const tags = item.tags || '';
  db.prepare(`
    INSERT INTO files (filename, content, size, type, hash, tags, encrypted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, unixepoch(), unixepoch())
  `).run(item.filename, item.content, item.size, item.type, item.hash, tags);
  // 恢复标签统计
  if (tags) updateTagStats(null, tags);
  db.prepare('DELETE FROM trash WHERE id = ?').run(trashId);
  return { success: true, filename: item.filename };
}

function permanentlyDeleteTrash(trashId) {
  const db = getDb();
  const item = db.prepare('SELECT * FROM trash WHERE id = ?').get(trashId);
  if (!item) return { success: false, error: 'Item not found' };
  // 更新标签统计
  if (item.tags) updateTagStats(item.tags, null);
  db.prepare('DELETE FROM trash WHERE id = ?').run(trashId);
  return { success: true, filename: item.filename };
}

function emptyTrash(cutoff = null) {
  const db = getDb();
  let items;
  if (cutoff !== null) {
    items = db.prepare('SELECT * FROM trash WHERE deleted_at < ?').all(cutoff);
  } else {
    items = db.prepare('SELECT * FROM trash').all();
  }
  for (const item of items) {
    if (item.tags) updateTagStats(item.tags, null);
  }
  let result;
  if (cutoff !== null) {
    result = db.prepare('DELETE FROM trash WHERE deleted_at < ?').run(cutoff);
  } else {
    result = db.prepare('DELETE FROM trash').run();
  }
  return { success: true, deleted: result.changes };
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

// 批量重命名
// pattern 支持: {name} {ext} {n} {n2} {n3} {date}
function batchRenameFiles(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    return { renamed: 0, errors: [] };
  }
  const results = [];
  const errors = [];
  const usedNames = new Set();

  for (let i = 0; i < operations.length; i++) {
    const { oldFilename, newFilename } = operations[i];
    if (!validateFilename(oldFilename) || !validateFilename(newFilename)) {
      errors.push({ oldFilename, error: '无效的文件名' });
      continue;
    }
    // 检查目标名是否已存在（排除自己）
    if (oldFilename !== newFilename) {
      const conflict = getFileByName(newFilename);
      if (conflict) {
        errors.push({ oldFilename, newFilename, error: '文件名已存在' });
        continue;
      }
      if (usedNames.has(newFilename)) {
        errors.push({ oldFilename, newFilename, error: '批量内重名冲突' });
        continue;
      }
    }
    // 执行重命名
    const existing = getFileByName(oldFilename);
    if (!existing) {
      errors.push({ oldFilename, error: '文件不存在' });
      continue;
    }
    const db = getDb();
    const oldId = existing.id;
    db.prepare('UPDATE files SET filename = ?, updated_at = unixepoch() WHERE id = ?').run(newFilename, oldId);
    const updated = getFileByName(newFilename);
    if (updated) {
      addSyncLog(updated.id, newFilename, 'rename', updated.hash, null, updated.size);
    }
    usedNames.add(newFilename);
    results.push({ oldFilename, newFilename });
  }

  return { renamed: results.length, errors };
}

// 解析重命名 pattern，返回 {base, ext} 给前端预览用
function parseRenamePattern(pattern, filename, index) {
  const lastDot = filename.lastIndexOf('.');
  const base = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  const ext = lastDot > 0 ? filename.slice(lastDot) : '';
  const now = new Date();
  const pad = (n, len) => String(index + 1).padStart(len, '0');
  const dateStr = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');

  return pattern
    .replace(/\{name\}/g, base)
    .replace(/\{ext\}/g, ext)
    .replace(/\{n\}/g, String(index + 1))
    .replace(/\{n2\}/g, pad(1, 2))
    .replace(/\{n3\}/g, pad(1, 3))
    .replace(/\{date\}/g, dateStr);
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

  // 记录同步日志：metadata 存源文件名，供客户端 applyIncrementalChanges 使用
  const updated = getFileByName(destFilename);
  if (updated) {
    addSyncLog(updated.id, destFilename, 'rename', updated.hash, null, updated.size,
      JSON.stringify({ oldFilename: sourceFilename }));
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
      const result = db.prepare(`
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
      const newId = result.lastInsertRowid;
      // 记录同步日志
      addSyncLog(newId, destFilename, 'create', source.hash, null, source.size);
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
 * 从 tokens 构建 FTS5 MATCH 查询字符串
 * 英文 token 用前缀匹配（token*），中文 token 用精确匹配
 */
function buildFtsQuery(tokens) {
  if (!tokens || tokens.length === 0) return null;
  // FTS5: terms joined with OR, single-char use exact phrase, longer use prefix
  const parts = tokens.map(t => {
    if (t.length >= 2) {
      return t + '*';  // FTS5 prefix match
    }
    return '"' + t + '"';  // exact phrase
  });
  return parts.join(' OR ');
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
  const { limit = 100, offset = 0, fuzzy = true, size_min, size_max, date_from, date_to, tagMatch = 'all', content, type, starred, mode = 'normal' } = opts;

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
    // 按数据库 type 字段精确匹配（与 FTS5 searchFilesFTS 行为一致）
    extraConditions.push(`type = ?`);
    extraParams.push(type);
  }
  if (starred === true) {
    extraConditions.push(`starred = 1`);
  }
  const extraWhere = extraConditions.length > 0 ? ' AND ' + extraConditions.join(' AND ') : '';

  if (!query && !tags && !content && !extraWhere) {
    return db.prepare(`SELECT ${FILE_FIELDS} FROM files ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
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

  // Glob/regex matching helper
  function globToRegex(glob) {
    // Convert glob pattern (*, ?, [abc], **) to regex
    // ** matches any path segment (including /)
    let regex = glob
      .replace(/[.+^$|()[\]{}\\]/g, '\\$&')  // escape regex special chars except * and ?
      .replace(/\*\*/g, '\x00PATH\x00')       // placeholder for **
      .replace(/\*/g, '[^/]*')                // * = any char except /
      .replace(/\x00PATH\x00/g, '.*')          // ** = any char including /
      .replace(/\?/g, '.');                   // ? = any single char
    return new RegExp('^' + regex + '$', 'i');
  }
  function matchFilenameGlob(filename, pattern) {
    try { return globToRegex(pattern).test(filename); } catch (e) { return false; }
  }
  function matchFilenameRegex(filename, pattern) {
    try { return new RegExp(pattern, 'i').test(filename); } catch (e) { return false; }
  }
  function matchFilename(filename) {
    if (!query) return true;
    if (mode === 'glob') return matchFilenameGlob(filename, query);
    if (mode === 'regex') return matchFilenameRegex(filename, query);
    // normal mode: handled by token scoring
    return true;
  }
  // For normal mode, keep using tokens; for glob/regex, skip token scoring
  const useTokens = (mode === 'normal' && queryTokens.length > 0);
  // For glob/regex with a query, force fetching all files (skip FTS5 query building)
  if ((mode === 'glob' || mode === 'regex') && query) {
    // Bypass FTS5 entirely — fetch candidates from DB and filter in-memory
    const allParams = [...extraParams];
    const whereExtra = extraConditions.length > 0 ? 'WHERE ' + extraConditions.join(' AND ') : 'WHERE 1=1';
    const candidates = db.prepare(`SELECT ${FILE_LIST_FIELDS} FROM files ${whereExtra} ORDER BY created_at DESC LIMIT ?`).all(...allParams, candidateLimit);
    const matched = candidates.filter(function(f) {
      if (!matchFilename(f.filename)) return false;
      // tags filter still applies
      if (tags) {
        const fileTags = (f.tags || '').toLowerCase().split(',').map(function(t) { return t.trim(); }).filter(Boolean);
        const tagList = tags.split(',').map(function(t) { return t.trim().toLowerCase(); });
        const matches = tagMatch === 'any' ? tagList.some(function(t) { return fileTags.includes(t); }) : tagList.every(function(t) { return fileTags.includes(t); });
        if (!matches) return false;
      }
      return true;
    });
    return matched.slice(offset, offset + limit);
  }

  // 如果没有查询词，只有标签过滤 + size/date：直接用 SQLite
  if (queryTokens.length === 0 && tags && !contentQuery) {
    const tagList = tags.split(',').map(t => t.trim().toLowerCase());
    const tagJoin = tagMatch === 'any' ? ' OR ' : ' AND ';
    const tagConditions = tagList.map(() => `LOWER(tags) LIKE ?`).join(tagJoin);
    const tagParams = tagList.map(t => `%${t}%`);
    return db.prepare(`SELECT ${FILE_LIST_FIELDS} FROM files WHERE ${tagConditions}${extraWhere} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...tagParams, ...extraParams, limit, offset);
  }

  // 有查询词：先用 FTS5 全文索引过滤候选集（避免全表扫描）
  // FTS5 MATCH 查询：英文前缀匹配（token*），中文精确匹配（"字"）
  // tags/content 仍用 LIKE 辅助过滤
  const candidateLimit = limit + offset + 100;
  let candidateFiles;
  if (useTokens || tags || contentQuery) {
    const ftsQuery = buildFtsQuery(queryTokens);
    let rawCandidates = [];

    if (ftsQuery) {
      // 尝试 FTS5 全文索引
      try {
        rawCandidates = db.prepare(`
          SELECT f.id, f.filename, f.tags, f.size, f.type, f.hash,
                 f.created_at, f.updated_at, f.parent_id, f.starred, f.encrypted,
                 f.content_type, f.birthtime, f.device_name,
                 bm25(files_fts) as fts_rank,
                 highlight(files_fts, 1, '<mark class="search-highlight">', '</mark>') as highlighted_name
          FROM files_fts
          JOIN files f ON f.id = files_fts.rowid
          WHERE files_fts MATCH ?
          ORDER BY fts_rank
          LIMIT ?
        `).all(ftsQuery, candidateLimit);
      } catch (e) {
        // FTS5 表不存在（如测试环境），回退到 LIKE
        rawCandidates = [];
      }
    }

    // FTS5 不可用或无结果：用 LIKE 回退
    if (rawCandidates.length === 0) {
      const conditions = [];
      const params = [];
      for (const token of queryTokens) {
        conditions.push(`(LOWER(filename) LIKE ? OR LOWER(tags) LIKE ?)`);
        params.push(`%${token}%`, `%${token}%`);
      }
      if (tags) {
        const tagList = tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        tagList.forEach(t => {
          conditions.push(`LOWER(tags) LIKE ?`);
          params.push(`%${t}%`);
        });
      }
      if (contentQuery) conditions.push(`type = 'text'`);
      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      candidateFiles = db.prepare(
        `SELECT ${FILE_LIST_FIELDS} FROM files ${whereClause}${extraWhere} ORDER BY created_at DESC LIMIT ?`
      ).all(...params, ...extraParams, candidateLimit);
    } else {
      // FTS5 有结果：过滤 + 后续评分
      candidateFiles = rawCandidates;
    }
  } else {
    candidateFiles = db.prepare(
      `SELECT ${FILE_LIST_FIELDS} FROM files${extraWhere} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...extraParams, limit + offset, offset);
  }

  if (!queryTokens.length && !tags && !contentQuery) {
    // candidateFiles already has offset+limit applied via SQL above, return as-is
    return candidateFiles;
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

    // Content search: content 列不在 FILE_LIST_FIELDS 中，需要按 id 单独加载
    if (contentQuery) {
      // 只加载需要的文件的 content，避免全量加载
      const fileContent = db.prepare('SELECT content FROM files WHERE id = ?').get(f.id);
      const lcContent = ((fileContent && fileContent.content) || '').toLowerCase();
      const lcContentQuery = contentQuery.toLowerCase();
      if (!lcContent.includes(lcContentQuery)) {
        return null; // 内容不匹配，直接过滤
      }
      // 内容匹配加分：精确匹配高分，模糊包含低分
      if (lcContent.startsWith(lcContentQuery)) {
        score += 80;
      } else if (lcContent.includes(' ' + lcContentQuery) || lcContent.includes('\n' + lcContentQuery)) {
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

  return scored.slice(offset, offset + limit);
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
  // 自动保留最近10个版本，删除更旧的
  pruneFileVersions(fileId, 10);
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

function pruneAllFileVersions(keepCount = 10) {
  // 清理所有文件的旧版本（每个文件保留最近 keepCount 个）
  const db = getDb();
  const fileIds = db.prepare('SELECT DISTINCT file_id FROM file_versions').all().map(r => r.file_id);
  let totalPruned = 0;
  for (const { file_id } of fileIds) {
    totalPruned += pruneFileVersions(file_id, keepCount);
  }
  return totalPruned;
}

// ============================================================
// 重复文件检测
// ============================================================
function findDuplicates() {
  const db = getDb();
  // Find hashes appearing more than once (exclude null hashes and deleted files)
  const dupes = db.prepare(`
    SELECT hash, COUNT(*) as count,
      GROUP_CONCAT(filename, '|||') as filenames,
      GROUP_CONCAT(id, '|||') as ids,
      GROUP_CONCAT(COALESCE(size, 0), '|||') as sizes,
      GROUP_CONCAT(COALESCE(created_at, 0), '|||') as created_ats,
      GROUP_CONCAT(COALESCE(virtual_folder, ''), '|||') as virtual_folders
    FROM files
    WHERE hash IS NOT NULL AND hash != '' AND deleted = 0
    GROUP BY hash
    HAVING count > 1
    ORDER BY count DESC
  `).all();

  return dupes.map(row => {
    const filenames = row.filenames.split('|||');
    const ids = row.ids.split('|||');
    const sizes = (row.sizes || '').split('|||').map(Number);
    const createdAts = (row.created_ats || '').split('|||').map(Number);
    const totalSize = sizes.reduce((a, b) => a + b, 0);
    return {
      hash: row.hash,
      count: row.count,
      totalSize,
      wastedSpace: totalSize - (sizes[0] || 0),
      files: filenames.map((filename, i) => ({
        id: parseInt(ids[i]),
        filename,
        size: sizes[i] || 0,
        created_at: createdAts[i] || 0
      }))
    };
  });
}

function getRecentFiles(limit = 100) {
  const db = getDb();
  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 100), 500);
  return db.prepare(`
    SELECT ${FILE_LIST_FIELDS} FROM files
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(safeLimit);
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

// 文件类型分布统计
function getStorageStats() {
  const db = getDb();
  // 3 queries: totals (1 row), byType (1 row per type), byDay (1 row per day)
  // Total: 3 queries (was 7 — eliminated 4 per-range COUNT queries)
  const totals = db.prepare('SELECT COUNT(*) as totalFiles, COALESCE(SUM(size), 0) as totalSize FROM files').get();

  const byType = db.prepare(`
    SELECT
      CASE
        WHEN content_type LIKE 'image/%' THEN 'image'
        WHEN content_type LIKE 'video/%' THEN 'video'
        WHEN content_type LIKE 'audio/%' THEN 'audio'
        WHEN content_type LIKE 'application/pdf' THEN 'pdf'
        WHEN content_type LIKE 'application/vnd%' THEN 'document'
        WHEN content_type LIKE 'text/%' THEN 'text'
        WHEN content_type IS NULL OR content_type = '' THEN 'other'
        ELSE 'other'
      END as category,
      COUNT(*) as count,
      COALESCE(SUM(size), 0) as size
    FROM files
    GROUP BY category
    ORDER BY size DESC
  `).all();

  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const byDay = db.prepare(`
    SELECT
      date(created_at, 'unixepoch') as day,
      COUNT(*) as file_count,
      COALESCE(SUM(size), 0) as total_size
    FROM files
    WHERE created_at >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(sevenDaysAgo);

  // Single query for all size ranges (replaces 4 separate COUNT queries)
  const sr = db.prepare(`
    SELECT
      SUM(CASE WHEN size < 1048576 THEN 1 ELSE 0 END) as lt_1mb_count,
      SUM(CASE WHEN size < 1048576 THEN COALESCE(size,0) ELSE 0 END) as lt_1mb_size,
      SUM(CASE WHEN size >= 1048576 AND size < 10485760 THEN 1 ELSE 0 END) as sz_1_10mb_count,
      SUM(CASE WHEN size >= 1048576 AND size < 10485760 THEN COALESCE(size,0) ELSE 0 END) as sz_1_10mb_size,
      SUM(CASE WHEN size >= 10485760 AND size < 104857600 THEN 1 ELSE 0 END) as sz_10_100mb_count,
      SUM(CASE WHEN size >= 10485760 AND size < 104857600 THEN COALESCE(size,0) ELSE 0 END) as sz_10_100mb_size,
      SUM(CASE WHEN size >= 104857600 THEN 1 ELSE 0 END) as ge_100mb_count,
      SUM(CASE WHEN size >= 104857600 THEN COALESCE(size,0) ELSE 0 END) as ge_100mb_size
    FROM files
  `).get();

  const topFiles = db.prepare(`
    SELECT id, filename, size, content_type, virtual_folder
    FROM files
    WHERE deleted = 0
    ORDER BY size DESC
    LIMIT 10
  `).all();

  // Monthly trend: last 12 months
  const twelveMonthsAgo = Math.floor(Date.now() / 1000) - 365 * 86400;
  const byMonth = db.prepare(`
    SELECT
      strftime('%Y-%m', created_at, 'unixepoch') as month,
      COUNT(*) as file_count,
      COALESCE(SUM(size), 0) as total_size
    FROM files
    WHERE created_at >= ?
    GROUP BY month
    ORDER BY month ASC
  `).all(twelveMonthsAgo);

  // VF usage breakdown
  const vfRows = db.prepare(`
    SELECT
      COALESCE(NULLIF(virtual_folder, ''), '(root)') as folder,
      COUNT(*) as file_count,
      COALESCE(SUM(size), 0) as total_size
    FROM files
    WHERE deleted = 0
    GROUP BY folder
    ORDER BY total_size DESC
  `).all();

  return {
    totalFiles: totals.totalFiles || 0,
    totalSize: totals.totalSize || 0,
    byType,
    byDay,
    topFiles,
    sizeRanges: [
      { label: '< 1MB',   count: sr.lt_1mb_count || 0,       size: sr.lt_1mb_size || 0 },
      { label: '1-10MB',  count: sr.sz_1_10mb_count || 0,     size: sr.sz_1_10mb_size || 0 },
      { label: '10-100MB', count: sr.sz_10_100mb_count || 0,   size: sr.sz_10_100mb_size || 0 },
      { label: '>= 100MB', count: sr.ge_100mb_count || 0,     size: sr.ge_100mb_size || 0 }
    ]
  };
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

function deleteDevice(deviceId) {
  const db = getDb();
  db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
}

function cleanupStaleDevices(minutesOffline = 5) {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - minutesOffline * 60;
  db.prepare('UPDATE devices SET is_online = 0 WHERE last_seen < ?').run(cutoff);
}

// 更新设备的最后同步时间和同步计数
function updateDeviceSyncStats(deviceId, syncedCount = 1) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE devices
    SET last_sync_at = ?, synced_files = synced_files + ?
    WHERE device_id = ?
  `).run(now, syncedCount, deviceId);
}

// 重置设备的同步计数
function resetDeviceSyncCount(deviceId) {
  const db = getDb();
  db.prepare('UPDATE devices SET synced_files = 0 WHERE device_id = ?').run(deviceId);
}

// 获取设备的同步状态详情
function getDeviceSyncInfo(deviceId) {
  const db = getDb();
  const device = db.prepare('SELECT device_id, device_name, is_online, last_seen, last_sync_at, synced_files FROM devices WHERE device_id = ?').get(deviceId);
  if (!device) return null;
  const pending = db.prepare(
    'SELECT COUNT(*) as count FROM sync_log WHERE (device_id = ? OR device_id IS NULL) AND synced = 0'
  ).get(deviceId).count;
  return { ...device, pending_sync: pending };
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
// Sync Conflict Management
// ============================================================

function addSyncConflict(filename, localHash, remoteHash, localContent, remoteContent, localDeviceId, remoteDeviceId) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO sync_conflicts (filename, local_hash, remote_hash, local_content, remote_content, local_device_id, remote_device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(filename, localHash, remoteHash, localContent, remoteContent, localDeviceId, remoteDeviceId);
  return db.prepare('SELECT * FROM sync_conflicts WHERE id = last_insert_rowid()').get();
}

function getUnresolvedConflicts() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM sync_conflicts WHERE resolved = 0 ORDER BY detected_at DESC
  `).all();
}

function getConflicts(limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM sync_conflicts ORDER BY detected_at DESC LIMIT ?
  `).all(limit);
}

function resolveConflict(conflictId, resolution, winningContent) {
  const db = getDb();
  // resolution: 'keep_local' | 'keep_remote' | 'keep_both'
  db.prepare(`
    UPDATE sync_conflicts SET resolved = 1, resolution = ?, resolved_at = unixepoch() WHERE id = ?
  `).run(resolution, conflictId);

  // Apply the winning content to the file
  if (winningContent !== null && winningContent !== undefined) {
    const conflict = db.prepare('SELECT filename FROM sync_conflicts WHERE id = ?').get(conflictId);
    if (conflict) {
      const existing = db.getFileByName(conflict.filename);
      if (existing) {
        db.updateFileByName(conflict.filename, { content: winningContent });
      } else {
        db.addFile(conflict.filename, winningContent, 'text');
      }
    }
  }
  return { success: true };
}

function dismissConflict(conflictId) {
  const db = getDb();
  db.prepare('DELETE FROM sync_conflicts WHERE id = ?').run(conflictId);
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

// 清理过期 rate_limit 记录（锁定已过期 或 窗口期已过的记录）
function cleanupRateLimit() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const WINDOW = 900; // 15分钟窗口
  // 删除：已过期锁定 OR 超过窗口期未使用的记录
  const result = db.prepare(
    'DELETE FROM rate_limit WHERE locked_until < ? OR (locked_until IS NULL AND last_attempt < ?)'
  ).run(now, now - WINDOW);
  return result.changes;
}

// 清理过期的未完成分片上传（24小时前的未完成上传）
function cleanupIncompleteUploads() {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const result = db.prepare('DELETE FROM upload_chunks WHERE created_at < ?').run(cutoff);
  return result.changes;
}

// 清理过期的搜索历史（90天前）
function cleanupSearchHistory() {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - 90 * 86400;
  const result = db.prepare('DELETE FROM search_history WHERE timestamp < ?').run(cutoff);
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
// 文件访问日志
// ============================================================
function addFileAccessLog(fileId, action, ip = null) {
  const db = getDb();
  db.prepare('INSERT INTO file_access_log (file_id, action, ip) VALUES (?, ?, ?)').run(fileId, action, ip);
}

function getFileAccessLog(fileId, limit = 50) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT fal.*, f.filename
    FROM file_access_log fal
    LEFT JOIN files f ON fal.file_id = f.id
    WHERE fal.file_id = ?
    ORDER BY fal.timestamp DESC
    LIMIT ?
  `).all(fileId, limit);
  return rows;
}

function getMostAccessedFiles(limit = 20, since = null) {
  const db = getDb();
  const cond = since ? 'WHERE fal.timestamp >= ?' : '';
  const params = since ? [since, limit] : [limit];
  return db.prepare(`
    SELECT fal.file_id, f.filename, COUNT(*) as access_count,
           MAX(fal.timestamp) as last_access,
           SUM(CASE WHEN fal.action = 'view' THEN 1 ELSE 0 END) as view_count,
           SUM(CASE WHEN fal.action = 'download' THEN 1 ELSE 0 END) as download_count
    FROM file_access_log fal
    LEFT JOIN files f ON fal.file_id = f.id
    ${cond}
    GROUP BY fal.file_id
    ORDER BY access_count DESC
    LIMIT ?
  `).all(...params);
}

// Global activity log across all files (for admin dashboard)
function getActivityLog(limit = 200, action = null, since = null) {
  const db = getDb();
  const conditions = [];
  const params = [];
  if (action) { conditions.push('fal.action = ?'); params.push(action); }
  if (since) { conditions.push('fal.timestamp >= ?'); params.push(since); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit);
  return db.prepare(`
    SELECT fal.*, f.filename, f.size as file_size
    FROM file_access_log fal
    LEFT JOIN files f ON fal.file_id = f.id
    ${where}
    ORDER BY fal.timestamp DESC
    LIMIT ?
  `).all(...params);
}

function getFileAccessStats(filename) {
  const db = getDb();
  const file = getFileByName(filename);
  if (!file) return null;

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_access,
      SUM(CASE WHEN action = 'view' THEN 1 ELSE 0 END) as view_count,
      SUM(CASE WHEN action = 'download' THEN 1 ELSE 0 END) as download_count
    FROM file_access_log WHERE file_id = ?
  `).get(file.id);

  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
  const daily = db.prepare(`
    SELECT
      date(timestamp, 'unixepoch') as day,
      COUNT(*) as count,
      SUM(CASE WHEN action = 'view' THEN 1 ELSE 0 END) as views,
      SUM(CASE WHEN action = 'download' THEN 1 ELSE 0 END) as downloads
    FROM file_access_log
    WHERE file_id = ? AND timestamp >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(file.id, thirtyDaysAgo);

  const recent = db.prepare(`
    SELECT timestamp, action, device_id
    FROM file_access_log
    WHERE file_id = ?
    ORDER BY timestamp DESC
    LIMIT 20
  `).all(file.id);

  return {
    totalAccess: totals.total_access || 0,
    viewCount: totals.view_count || 0,
    downloadCount: totals.download_count || 0,
    daily: daily,
    recent: recent
  };
}

// ============================================================
// 最近访问文件
// ============================================================
function getRecentlyAccessedFiles(limit = 50) {
  const db = getDb();
  // Return unique files by file_id ordered by most recent access, joined with file metadata
  const files = db.prepare(`
    SELECT DISTINCT f.${FILE_LIST_FIELDS}, fal.timestamp as last_accessed_at
    FROM file_access_log fal
    JOIN files f ON fal.file_id = f.id
    ORDER BY fal.timestamp DESC
    LIMIT ?
  `).all(limit);
  return files;
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

// ============================================================
// 速率限制查询（管理 UI）
// ============================================================
function listRateLimits(limit = 100) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  // 返回所有有尝试记录的（包含已过期需要清理的）
  return db.prepare(`
    SELECT key, attempts, locked_until, last_attempt,
      CASE
        WHEN locked_until IS NOT NULL AND locked_until > ? THEN 'locked'
        WHEN locked_until IS NOT NULL AND locked_until <= ? THEN 'expired'
        WHEN attempts >= ? THEN 'warn'
        ELSE 'active'
      END as status,
      ? - attempts as remaining,
      ? - last_attempt as seconds_ago
    FROM rate_limit
    WHERE attempts > 0
    ORDER BY
      CASE WHEN locked_until > ? THEN 1 ELSE 0 END DESC,
      attempts DESC,
      last_attempt DESC
    LIMIT ?
  `).all(now, now, RATE_LIMIT_CONFIG.maxAttempts, RATE_LIMIT_CONFIG.maxAttempts, now, now, limit);
}

function deleteRateLimit(key) {
  const db = getDb();
  const info = db.prepare('DELETE FROM rate_limit WHERE key = ?').run(key);
  return info.changes > 0;
}

// ============================================================
// 通知系统
// ============================================================
function addNotification(type, title, message = null) {
  const db = getDb();
  db.prepare('INSERT INTO notifications (type, title, message) VALUES (?, ?, ?)').run(type, title, message);
  return db.prepare('SELECT * FROM notifications WHERE id = last_insert_rowid()').get();
}

function getNotifications(limit = 50, offset = 0) {
  const db = getDb();
  return db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
}

function getUnreadNotificationCount() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) as count FROM notifications WHERE read = 0').get().count;
}

function markNotificationsRead(ids = null) {
  const db = getDb();
  if (ids === null) {
    db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
  } else {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE notifications SET read = 1 WHERE id IN (${placeholders})`).run(...ids);
  }
}

function clearNotifications(ids = null) {
  const db = getDb();
  if (ids === null) {
    db.prepare('DELETE FROM notifications').run();
  } else {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM notifications WHERE id IN (${placeholders})`).run(...ids);
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

function deleteSearchHistoryItem(query) {
  const db = getDb();
  db.prepare('DELETE FROM search_history WHERE query = ?').run(query);
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
    INSERT INTO share_links (code, filename, is_text, password, expires_at, max_downloads, download_count, description, created_by, theme_bg, theme_color, brand_text, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    shareData.createdBy || null,
    shareData.themeBg || null,
    shareData.themeColor || null,
    shareData.brandText || null,
    shareData.label || ''
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
    createdBy: shareData.createdBy || null,
    themeBg: shareData.themeBg || null,
    themeColor: shareData.themeColor || null,
    brandText: shareData.brandText || null,
    label: shareData.label || ''
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
    viewCount: row.view_count,
    description: row.description || '',
    createdAt: row.created_at * 1000,
    createdBy: row.created_by,
    _passwordHash: row.password,  // 内部使用，验证时比对
    themeBg: row.theme_bg || null,
    themeColor: row.theme_color || null,
    brandText: row.brand_text || null,
    label: row.label || ''
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

  if (updates.themeBg !== undefined) {
    fields.push('theme_bg = ?');
    values.push(updates.themeBg || null);
  }

  if (updates.themeColor !== undefined) {
    fields.push('theme_color = ?');
    values.push(updates.themeColor || null);
  }

  if (updates.brandText !== undefined) {
    fields.push('brand_text = ?');
    values.push(updates.brandText || null);
  }

  if (updates.label !== undefined) {
    fields.push('label = ?');
    values.push(updates.label || '');
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
  const link = db.prepare('SELECT max_downloads, download_count FROM share_links WHERE code = ?').get(code);
  if (!link) return { allowed: false, reason: 'not_found' };
  if (link.max_downloads && link.download_count >= link.max_downloads) {
    return { allowed: false, reason: 'max_exceeded', maxDownloads: link.max_downloads, downloadCount: link.download_count };
  }
  db.prepare('UPDATE share_links SET download_count = download_count + 1 WHERE code = ?').run(code);
  return { allowed: true };
}

function incrementShareLinkViewCount(code) {
  const db = getDb();
  db.prepare('UPDATE share_links SET view_count = view_count + 1 WHERE code = ?').run(code);
}

function renewShareLink(code, expiresAtSeconds) {
  const db = getDb();
  const MAX_TS = Math.floor(32503680000000 / 1000); // year 3000
  const exp = expiresAtSeconds > 0 ? expiresAtSeconds : MAX_TS;
  const result = db.prepare('UPDATE share_links SET expires_at = ? WHERE code = ?').run(exp, code);
  return result.changes > 0;
}

function getExpiringShareLinks(days = 7) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const future = now + days * 86400;
  const rows = db.prepare(
    "SELECT code, filename, expires_at, view_count, download_count, max_downloads, has_password, created_at FROM share_links WHERE expires_at > ? AND expires_at <= ? AND expires_at > 0 ORDER BY expires_at ASC"
  ).all(now, future);
  return rows.map(r => ({
    code: r.code,
    filename: r.filename,
    expiresAt: r.expires_at * 1000,
    expiresInDays: Math.ceil((r.expires_at * 1000 - Date.now()) / 86400000),
    viewCount: r.view_count,
    downloadCount: r.download_count,
    maxDownloads: r.max_downloads,
    hasPassword: !!r.has_password,
    createdAt: r.created_at * 1000,
  }));
}

function listShareLinks(filename = null) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let rows;
  if (filename) {
    rows = db.prepare('SELECT * FROM share_links WHERE filename = ? ORDER BY created_at DESC LIMIT 100').all(filename);
  } else {
    rows = db.prepare('SELECT * FROM share_links ORDER BY created_at DESC LIMIT 100').all();
  }
  return rows.map(row => ({
    code: row.code,
    filename: row.filename,
    is_text: row.is_text === 1,
    hasPassword: !!row.password,
    expires_at: row.expires_at,
    expiresAt: row.expires_at * 1000,
    expired: row.expires_at > 0 && row.expires_at < now,
    max_downloads: row.max_downloads,
    maxDownloads: row.max_downloads,
    download_count: row.download_count,
    downloadCount: row.download_count,
    view_count: row.view_count,
    viewCount: row.view_count,
    description: row.description || '',
    created_at: row.created_at,
    createdAt: row.created_at * 1000,
    created_by: row.created_by,
    createdBy: row.created_by,
    themeBg: row.theme_bg || null,
    themeColor: row.theme_color || null,
    brandText: row.brand_text || null
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

function getShareStats() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const total = db.prepare('SELECT COUNT(*) as c FROM share_links').get().c;
  const active = db.prepare('SELECT COUNT(*) as c FROM share_links WHERE (expires_at = 0 OR expires_at > ?)').get(now).c;
  const expired = total - active;
  const withPassword = db.prepare('SELECT COUNT(*) as c FROM share_links WHERE password IS NOT NULL AND password != ""').get().c;
  const totalViews = db.prepare('SELECT COALESCE(SUM(view_count), 0) as s FROM share_links').get().s;
  const totalDownloads = db.prepare('SELECT COALESCE(SUM(download_count), 0) as s FROM share_links').get().s;
  const withMaxDl = db.prepare('SELECT COUNT(*) as c FROM share_links WHERE max_downloads > 0').get().c;
  const atMaxDl = db.prepare('SELECT COUNT(*) as c FROM share_links WHERE max_downloads > 0 AND download_count >= max_downloads').get().c;

  // Top files by views
  const topByViews = db.prepare('SELECT filename, view_count, download_count, expires_at FROM share_links ORDER BY view_count DESC LIMIT 10').all();

  // Top files by downloads
  const topByDownloads = db.prepare('SELECT filename, download_count, view_count, expires_at FROM share_links ORDER BY download_count DESC LIMIT 10').all();

  return {
    total, active, expired, withPassword,
    totalViews, totalDownloads,
    withMaxDl, atMaxDl,
    topByViews: topByViews.map(r => ({
      filename: r.filename,
      views: r.view_count,
      downloads: r.download_count,
      expired: r.expires_at > 0 && r.expires_at < now
    })),
    topByDownloads: topByDownloads.map(r => ({
      filename: r.filename,
      downloads: r.download_count,
      views: r.view_count,
      expired: r.expires_at > 0 && r.expires_at < now
    }))
  };
}

function getExpiringShares(days = 7) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const future = now + days * 86400;
  const rows = db.prepare(
    'SELECT code, filename, expires_at, view_count, download_count FROM share_links WHERE expires_at > ? AND expires_at <= ? ORDER BY expires_at ASC'
  ).all(now, future);
  return rows.map(r => ({
    code: r.code,
    filename: r.filename,
    expiresAt: r.expires_at * 1000,
    daysLeft: Math.ceil((r.expires_at - now) / 86400),
    views: r.view_count,
    downloads: r.download_count
  }));
}

// ============================================================
// 文件收集链接（公开上传页面）
// ============================================================
function generateRequestCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 10; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRequestLink(opts = {}) {
  const db = getDb();
  // 懒建表：已有数据库兼容性
  db.exec(`CREATE TABLE IF NOT EXISTS request_links (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    target_folder TEXT    NOT NULL DEFAULT '',
    password      TEXT,
    max_uploads   INTEGER,
    upload_count  INTEGER NOT NULL DEFAULT 0,
    expires_at    INTEGER,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    created_by    TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_request_links_code ON request_links(code)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_request_links_active ON request_links(active)`);
  const code = generateRequestCode();
  const now = Math.floor(Date.now() / 1000);
  // 默认 30 天过期
  const expiresAt = opts.expiresInDays ? now + opts.expiresInDays * 86400 : null;
  const hashedPassword = opts.password ? hashPassword(opts.password) : null;
  const stmt = db.prepare(`
    INSERT INTO request_links (code, name, target_folder, password, max_uploads, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(code, opts.name || '文件收集', opts.targetFolder || '', hashedPassword, opts.maxUploads || null, expiresAt, opts.createdBy || null);
  return { id: result.lastInsertRowid, code };
}

function getRequestLink(code) {
  const db = getDb();
  const row = db.prepare('SELECT id, code, name, target_folder, max_uploads, upload_count, expires_at, active, created_at, created_by, password FROM request_links WHERE code = ?').get(code);
  if (!row) return null;
  // Exclude password from return but keep has_password indicator
  // Build result explicitly to never include password hash
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    target_folder: row.target_folder,
    max_uploads: row.max_uploads,
    upload_count: row.upload_count,
    expires_at: row.expires_at,
    active: row.active,
    created_at: row.created_at,
    created_by: row.created_by,
    has_password: row.password ? 1 : 0,
  };
}

function verifyRequestLinkPassword(code, inputPwd) {
  const db = getDb();
  const row = db.prepare('SELECT password FROM request_links WHERE code = ?').get(code);
  if (!row) return false;
  if (!row.password) return true; // no password required
  return verifyPassword(inputPwd, row.password);
}

function incrementRequestLinkUpload(code) {
  const db = getDb();
  const result = db.prepare('UPDATE request_links SET upload_count = upload_count + 1 WHERE code = ?').run(code);
  if (result.changes === 0) return null; // code not found
  const row = db.prepare('SELECT upload_count FROM request_links WHERE code = ?').get(code);
  return row ? row.upload_count : 0;
}

function getRequestLinkFiles(requestLinkId) {
  const db = getDb();
  return db.prepare(`
    SELECT f.*, rlf.uploaded_at
    FROM files f
    JOIN request_link_files rlf ON f.id = rlf.file_id
    WHERE rlf.request_link_id = ?
    ORDER BY rlf.uploaded_at DESC
  `).all(requestLinkId);
}

function deleteRequestLinkFile(requestLinkId, fileId) {
  const db = getDb();
  // Verify the file belongs to this request link
  const file = db.prepare(`SELECT f.* FROM request_link_files rlf JOIN files f ON f.id = rlf.file_id WHERE rlf.request_link_id = ? AND rlf.file_id = ?`).get(requestLinkId, fileId);
  if (!file) return false;
  // Delete from request_link_files first (FK constraint)
  db.prepare(`DELETE FROM request_link_files WHERE request_link_id = ? AND file_id = ?`).run(requestLinkId, fileId);
  // Delete the actual file (soft-delete to trash)
  deleteFile(fileId);
  return true;
}

function toggleRequestLinkActive(code, active) {
  const db = getDb();
  db.prepare('UPDATE request_links SET active = ? WHERE code = ?').run(active ? 1 : 0, code);
}

function updateRequestLink(code, updates = {}) {
  const db = getDb();
  const allowed = ['name', 'password', 'max_uploads', 'expires_in_days', 'target_folder', 'active'];
  const setClauses = [];
  const params = [];

  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    params.push(updates.name);
  }
  if (updates.password !== undefined) {
    setClauses.push('password = ?');
    params.push(updates.password ? hashPassword(updates.password) : null);
  }
  if (updates.max_uploads !== undefined) {
    setClauses.push('max_uploads = ?');
    params.push(updates.max_uploads);
  }
  if (updates.expires_in_days !== undefined) {
    setClauses.push('expires_at = ?');
    if (updates.expires_in_days === null || updates.expires_in_days === 0) {
      params.push(null);
    } else {
      params.push(Math.floor(Date.now() / 1000) + updates.expires_in_days * 86400);
    }
  }
  if (updates.target_folder !== undefined) {
    setClauses.push('target_folder = ?');
    params.push(updates.target_folder);
  }
  if (updates.active !== undefined) {
    setClauses.push('active = ?');
    params.push(updates.active ? 1 : 0);
  }

  if (setClauses.length === 0) return false;
  params.push(code);
  const result = db.prepare('UPDATE request_links SET ' + setClauses.join(', ') + ' WHERE code = ?').run(...params);
  return result.changes > 0;
}

function deleteRequestLink(code) {
  const db = getDb();
  db.prepare('DELETE FROM request_links WHERE code = ?').run(code);
}

function listRequestLinks(createdBy = null) {
  const db = getDb();
  const fields = 'id, code, name, target_folder, max_uploads, upload_count, expires_at, active, created_at, created_by, CASE WHEN password IS NOT NULL THEN 1 ELSE 0 END AS has_password';
  let rows;
  if (createdBy) {
    rows = db.prepare(`SELECT ${fields} FROM request_links WHERE created_by = ? ORDER BY created_at DESC`).all(createdBy);
  } else {
    rows = db.prepare(`SELECT ${fields} FROM request_links ORDER BY created_at DESC`).all();
  }
  return rows;
}

function cleanupExpiredRequestLinks() {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare('DELETE FROM request_links WHERE expires_at < ? AND expires_at IS NOT NULL').run(now);
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

function clearAuditLogs(daysToKeep = 90) {
  return cleanupAuditLog(daysToKeep);
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
  const trashCount = db.prepare('SELECT COUNT(*) as c FROM trash').get().c;
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
    trashCount,
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

  // 分享链接分析
  const totalViews = db.prepare('SELECT COALESCE(SUM(view_count), 0) as c FROM share_links').get().c;
  const totalDownloads = db.prepare('SELECT COALESCE(SUM(download_count), 0) as c FROM share_links').get().c;
  const todayViews = db.prepare('SELECT COUNT(*) as c FROM share_links WHERE created_at >= ?').get(today).c;
  const weekDownloads = db.prepare('SELECT COUNT(*) as c FROM share_links WHERE created_at >= ?').get(thisWeek).c;
  const topLinks = db.prepare(`
    SELECT code, filename, view_count, download_count, expires_at,
           (view_count + download_count) as total_count
    FROM share_links
    ORDER BY total_count DESC
    LIMIT 10
  `).all();

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
  const unsyncedSize = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) as s FROM sync_log WHERE synced=0').get().s;
  const todaySyncLogs = db.prepare('SELECT COUNT(*) as c FROM sync_log WHERE timestamp >= ?').get(today).c;

  // 按虚拟文件夹存储分布（TOP 8）
  const byFolder = db.prepare(`
    SELECT vf.name, vf.color, COUNT(vff.file_id) as file_count, COALESCE(SUM(f.size), 0) as size
    FROM virtual_folders vf
    LEFT JOIN virtual_folder_files vff ON vf.id = vff.folder_id
    LEFT JOIN files f ON f.id = vff.file_id
    GROUP BY vf.id
    ORDER BY size DESC
    LIMIT 8
  `).all();

  // Top 10 最大文件
  const topLargest = db.prepare(`
    SELECT filename, size, type, updated_at
    FROM files
    ORDER BY size DESC
    LIMIT 10
  `).all();

  // 近30天月度趋势（每周统计）
  const monthlyTrend = [];
  for (let w = 3; w >= 0; w--) {
    const weekStart = now - (w + 1) * oneWeek;
    const weekEnd = now - w * oneWeek;
    const count = db.prepare('SELECT COUNT(*) as c FROM files WHERE created_at >= ? AND created_at < ?').get(weekStart, weekEnd).c;
    const delCount = db.prepare('SELECT COUNT(*) as c FROM trash WHERE deleted_at >= ? AND deleted_at < ?').get(weekStart, weekEnd).c;
    const weekLabel = w === 0 ? '本周' : w === 1 ? '上周' : (w === 2 ? '3周前' : '4周前');
    monthlyTrend.push({ label: weekLabel, added: count, deleted: delCount });
  }

  // 每日趋势（近7天，每天显示新增+删除）
  const dailyTrend = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = now - (i + 1) * oneDay;
    const dayEnd = now - i * oneDay;
    const added = db.prepare('SELECT COUNT(*) as c FROM files WHERE created_at >= ? AND created_at < ?').get(dayStart, dayEnd).c;
    const deleted = db.prepare('SELECT COUNT(*) as c FROM trash WHERE deleted_at >= ? AND deleted_at < ?').get(dayStart, dayEnd).c;
    const date = new Date(dayStart * 1000);
    const label = (date.getMonth() + 1) + '/' + date.getDate();
    dailyTrend.push({ label, added, deleted });
  }

  // 热门文件 TOP 10（按访问次数）
  const topAccessed = db.prepare(`
    SELECT fal.file_id, f.filename, COUNT(*) as access_count,
           MAX(fal.timestamp) as last_access,
           SUM(CASE WHEN fal.action = 'view' THEN 1 ELSE 0 END) as view_count,
           SUM(CASE WHEN fal.action = 'download' THEN 1 ELSE 0 END) as download_count,
           f.size, f.type
    FROM file_access_log fal
    LEFT JOIN files f ON fal.file_id = f.id
    GROUP BY fal.file_id
    ORDER BY access_count DESC
    LIMIT 10
  `).all();

  // 最后同步时间
  const lastSync = db.prepare('SELECT MAX(timestamp) as ts FROM sync_log').get().ts;

  return {
    files: { total: totalFiles, text: textFiles, binary: binaryFiles, starred: starredFiles, trash: trashCount },
    storage: { total: totalSize },
    byType,
    byExt,
    byFolder,
    topLargest,
    activity: { today: filesToday, week: filesThisWeek, month: filesThisMonth, dailyNew },
    shares: { active: activeShares, total: totalShares, withPassword: sharesWithPwd },
    shareAnalytics: { totalViews, totalDownloads, todayViews, weekDownloads, topLinks },
    devices: { total: totalDevices, online: onlineDevices },
    tokens: { total: totalTokens, active: activeTokens },
    audit: { total: auditTotal, today: auditToday },
    sync: { unsynced, unsyncedSize, todaySyncLogs, lastSync },
    monthlyTrend,
    dailyTrend,
    topAccessed
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

// ── SQLite 在线备份 ─────────────────────────────────────────
function backupDb() {
  const db = getDb();
  const fs = require('fs');
  const backupDir = path.join(path.dirname(DB_PATH), 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(backupDir, `share-tool-${timestamp}.db`);

  // Use better-sqlite3's backup() API
  const dest = new (require('better-sqlite3'))(backupPath);
  db.backup(dest, (err) => {
    dest.close();
    if (err) {
      console.error('[DB] Backup failed:', err.message);
    } else {
      console.log('[DB] Backup saved to:', backupPath);
    }
  });

  return backupPath;
}

// ============================================================
// 标签颜色
// ============================================================
const TAG_COLOR_PRESETS = [
  '#667eea', '#f59e0b', '#10b981', '#ef4444', '#3b82f6',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316'
];

// ── Smart tag suggestions based on file type/name ──────────────────────
function suggestTags(filename, mime) {
  const tags = [];
  const lower = (filename || '').toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() : '';

  // Type-based tags
  if (!mime || mime === 'application/octet-stream') mime = detectMimeType(filename);
  if (mime) {
    if (mime.startsWith('image/')) tags.push('图片', 'image');
    else if (mime.startsWith('video/')) tags.push('视频', 'video');
    else if (mime.startsWith('audio/')) tags.push('音频', 'audio');
    else if (mime === 'application/pdf') tags.push('文档', 'pdf');
    else if (mime.startsWith('text/')) tags.push('文本', 'text');
    else if (mime.includes('spreadsheet') || mime.includes('excel') || ext === 'xls' || ext === 'xlsx') tags.push('表格', 'excel');
    else if (mime.includes('presentation') || mime.includes('powerpoint') || ext === 'ppt' || ext === 'pptx') tags.push('演示', 'ppt');
    else if (mime.includes('document') || mime.includes('word') || ext === 'doc' || ext === 'docx') tags.push('文档', 'word');
    else if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar') || mime.includes('gz') || ext === 'zip' || ext === '7z' || ext === 'tar' || ext === 'gz') tags.push('压缩包', 'archive');
    else if (mime.includes('javascript') || mime.includes('typescript') || ext === 'js' || ext === 'ts' || ext === 'py' || ext === 'java' || ext === 'cpp' || ext === 'c' || ext === 'go' || ext === 'rs') tags.push('代码', 'code');
  }

  // Name-based tags
  if (/^IMG_\d|photo|camera|截图|screenshot|capture/i.test(lower)) tags.push('照片', 'photo');
  if (/backup|备份|副本|副本|copy/i.test(lower)) tags.push('备份', 'backup');
  if (/draft|草稿|初稿/i.test(lower)) tags.push('草稿', 'draft');
  if (/temp|tmp|临时/i.test(lower)) tags.push('临时', 'temp');
  if (/important|重要|保密|secret|private/i.test(lower)) tags.push('重要', 'important');
  if (/report|报告|总结|周报|月报|年报/i.test(lower)) tags.push('报告', 'report');
  if (/invoice|发票|账单|收据/i.test(lower)) tags.push('财务', 'finance');
  if (/202[0-9]|20[0-9][0-9]/i.test(lower)) tags.push('年度', 'annual');

  // Deduplicate while preserving order
  const seen = new Set();
  return tags.filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });
}

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
  const rows = db.prepare("SELECT tags FROM files WHERE tags IS NOT NULL AND tags != ''").all();
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
  const rows = db.prepare("SELECT tags FROM files WHERE tags IS NOT NULL AND tags != ''").all();
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

function cleanupOrphanTags() {
  // 删除 tag_stats 中所有 count=0 的标签
  const db = getDb();
  const orphans = db.prepare('SELECT tag FROM tag_stats WHERE count = 0').all();
  db.prepare('DELETE FROM tag_stats WHERE count = 0').run();
  return { deleted: orphans.length };
}

// ============================================================
// 文件夹标签 (folder_tags)
// ============================================================

// 获取一个文件夹的所有标签（含颜色/图标）
function getFolderTags(folderPath) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT td.id, td.name, td.color, td.icon
    FROM folder_tags ft
    JOIN tag_definitions td ON td.id = ft.tag_id
    WHERE ft.folder_path = ?
    ORDER BY td.name
  `).all(folderPath);
  return rows;
}

// 设置文件夹的标签（替换模式）
function setFolderTags(folderPath, tagIds) {
  const db = getDb();
  db.prepare('DELETE FROM folder_tags WHERE folder_path = ?').run(folderPath);
  for (const tagId of tagIds) {
    db.prepare('INSERT OR IGNORE INTO folder_tags (folder_path, tag_id) VALUES (?, ?)').run(folderPath, tagId);
  }
}

// 添加单个标签到文件夹
function addFolderTag(folderPath, tagId) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO folder_tags (folder_path, tag_id) VALUES (?, ?)').run(folderPath, tagId);
}

// 移除单个标签
function removeFolderTag(folderPath, tagId) {
  const db = getDb();
  db.prepare('DELETE FROM folder_tags WHERE folder_path = ? AND tag_id = ?').run(folderPath, tagId);
}

// 获取所有标签定义（供标签管理器使用）
function getAllTagDefinitions() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT td.*,
      (SELECT COUNT(*) FROM folder_tags ft WHERE ft.tag_id = td.id) as folder_count
    FROM tag_definitions td
    ORDER BY td.name
  `).all();
  return rows;
}

// 创建标签定义
function createTagDefinition(name, color = '#e0e7ff', icon = '') {
  const db = getDb();
  try {
    const result = db.prepare('INSERT INTO tag_definitions (name, color, icon) VALUES (?, ?, ?)').run(name, color, icon);
    return { id: result.lastInsertRowid, name, color, icon };
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return db.prepare('SELECT * FROM tag_definitions WHERE name = ?').get(name);
    }
    throw e;
  }
}

// 更新标签定义
function updateTagDefinition(id, fields) {
  const db = getDb();
  const allowed = ['name', 'color', 'icon'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`).join(', ');
  if (!sets) return false;
  const values = Object.keys(fields).filter(k => allowed.includes(k)).map(k => fields[k]);
  db.prepare(`UPDATE tag_definitions SET ${sets} WHERE id = ?`).run(...values, id);
  return true;
}

// 删除标签定义
function deleteTagDefinition(id) {
  const db = getDb();
  db.prepare('DELETE FROM folder_tags WHERE tag_id = ?').run(id);
  db.prepare('DELETE FROM tag_definitions WHERE id = ?').run(id);
}

// 获取指定标签关联的虚拟文件夹
function getVirtualFoldersByTag(tagId) {
  const db = getDb();
  // Get VF records where the VF's name matches a folder_path in folder_tags for this tag
  return db.prepare(`
    SELECT vf.id, vf.name, vf.description, vf.color, vf.position, vf.created_at,
      (SELECT COUNT(*) FROM virtual_folder_files vff WHERE vff.folder_id = vf.id) AS file_count
    FROM virtual_folders vf
    JOIN folder_tags ft ON ft.folder_path = vf.name
    WHERE ft.tag_id = ?
    ORDER BY vf.position ASC, vf.created_at DESC
  `).all(tagId);
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

// ============================================================
// 数据导入导出（完整备份/恢复）
// ============================================================

/**
 * 导出所有数据为 JSON（不含审计日志和 token）
 * @returns {object} { files, share_links, tags, tag_colors, version }
 */
function exportAllData() {
  const db = getDb();
  const files = db.prepare('SELECT * FROM files ORDER BY id').all();
  const shareLinks = db.prepare('SELECT * FROM share_links').all();
  // 分享链接密码是哈希，导出时会标注已加密
  const tagColors = db.prepare('SELECT * FROM tag_colors').all();
  const searchHistory = db.prepare('SELECT * FROM search_history ORDER BY timestamp DESC LIMIT 500').all();
  const fileVersions = db.prepare(`
    SELECT fv.* FROM file_versions fv
    JOIN files f ON fv.file_id = f.id
    ORDER BY fv.created_at DESC
    LIMIT 1000
  `).all();

  // 清除敏感字段
  const safeShareLinks = shareLinks.map(l => ({
    ...l,
    password: l.password ? '[HASHED]' : null  // 密码哈希不可逆，标记为已哈希
  }));

  return {
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    files,
    shareLinks: safeShareLinks,
    tagColors,
    searchHistory,
    fileVersions
  };
}

/**
 * 导入数据（可选择合并或覆盖）
 * @param {object} data - exportAllData() 返回的数据
 * @param {string} mode - 'merge'（合并）或 'replace'（替换）
 */
function importAllData(data, mode = 'merge') {
  const db = getDb();

  if (mode === 'replace') {
    // 全量替换：先清空再导入
    db.exec('DELETE FROM file_versions');
    db.exec('DELETE FROM search_history');
    db.exec('DELETE FROM share_links');
    db.exec('DELETE FROM files');
    db.exec('DELETE FROM tag_colors');
  }

  // 导入文件
  let filesImported = 0;
  for (const file of (data.files || [])) {
    try {
      // 使用 INSERT OR REPLACE：文件名冲突则覆盖
      db.prepare(`
        INSERT OR REPLACE INTO files (id, filename, content, type, size, hash, tags, encrypted, starred, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        file.id, file.filename, file.content, file.type, file.size, file.hash,
        file.tags || '', file.encrypted ? 1 : 0, file.starred ? 1 : 0,
        file.position || 0, file.created_at, file.updated_at
      );
      filesImported++;
    } catch (e) {
      // 忽略单个文件错误
    }
  }

  // 导入分享链接（密码为 [HASHED] 时保留原密码）
  let linksImported = 0;
  for (const link of (data.shareLinks || [])) {
    try {
      // 密码字段为 [HASHED] 时表示保持数据库现有值
      const password = link.password === '[HASHED]' ? null : link.password;
      db.prepare(`
        INSERT OR REPLACE INTO share_links
          (code, filename, password, expires_at, created_at, downloads, max_downloads, views)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        link.code, link.filename, password,
        link.expires_at, link.created_at,
        link.downloads || 0, link.max_downloads || null, link.views || 0
      );
      linksImported++;
    } catch (e) {
      // 忽略
    }
  }

  // 导入标签颜色
  for (const tc of (data.tagColors || [])) {
    try {
      db.prepare('INSERT OR REPLACE INTO tag_colors (tag, color, emoji) VALUES (?, ?, ?)')
        .run(tc.tag, tc.color, tc.emoji || null);
    } catch (e) {
      // 忽略
    }
  }

  // 导入搜索历史
  for (const sh of (data.searchHistory || [])) {
    try {
      db.prepare('INSERT OR IGNORE INTO search_history (query, timestamp) VALUES (?, ?)')
        .run(sh.query, sh.timestamp);
    } catch (e) {
      // 忽略
    }
  }

  return { filesImported, linksImported, mode };
}

module.exports = {
  initDatabase,
  getDb,
  // 密码
  hashPassword, verifyPassword,
  // 文件
  addFile, getFile, getFileByName, toggleStar, getStarredFiles, listFiles, updateFile, updateFileByName,
  deleteFile, deleteFileByName, deleteFiles, renameFile, batchRenameFiles, parseRenamePattern, deleteOldFiles, deleteAllFiles,
  deleteFilesByPrefix, renameFilesByPrefix, moveFile, moveFilesByPrefix, copyFile, copyFilesByPrefix, batchMove, batchCopy, getFilesByPrefix,
  setFilePositions,
  searchFiles, searchFilesFTS, getFilesByHashSince, getFileCount, getTotalStorageSize, getStorageStats, getFolderSize, getAllFolderSizes, findDuplicates, getRecentFiles,
  // 设备
  registerDevice, getDevice, listDevices, setDeviceOffline, setDeviceOnline,
  touchDevice, getOnlineDevices, deleteDevice, cleanupStaleDevices,
  updateDeviceSyncStats, resetDeviceSyncCount, getDeviceSyncInfo,
  // 同步
  addSyncLog, getUnsyncedLogs, markLogsSynced, getSyncStatus,
  suggestTags,
  // Token
  generateToken, validateToken, refreshToken, revokeToken, revokeAllTokens,
  // 审计
  addAuditLog, listAuditLogs, getAuditStats, exportAuditLogsCSV, addFileAccessLog, getFileAccessLog, getMostAccessedFiles, getRecentlyAccessedFiles, getFileAccessStats,
  // 速率限制
  checkRateLimit, recordRateLimitAttempt, getRateLimitConfig, setRateLimitConfig, listRateLimits, deleteRateLimit,
  // 通知
  addNotification, getNotifications, getUnreadNotificationCount, markNotificationsRead, clearNotifications,
  // 搜索历史
  addSearchHistory, getSearchHistory, clearSearchHistory, deleteSearchHistoryItem, getPopularSearches,
  // 分享链接
  saveShareLink, getShareLink, updateShareLink, deleteShareLink, incrementShareLinkDownload, incrementShareLinkViewCount,
  listShareLinks, cleanupExpiredShareLinks, getShareStats, getExpiringShares, renewShareLink, getExpiringShareLinks,
  // 虚拟文件夹
  createVirtualFolder, listVirtualFolders, getVirtualFolder, deleteVirtualFolder, updateVirtualFolder, getVirtualFolderSize,
  addFileToVirtualFolder, removeFileFromVirtualFolder, getVirtualFolderFiles, isFileInVirtualFolder,
  // 文件收集链接
  createRequestLink, getRequestLink, verifyRequestLinkPassword,
  toggleRequestLinkActive, updateRequestLink, deleteRequestLink, listRequestLinks,
  incrementRequestLinkUpload, cleanupExpiredRequestLinks,
  getRequestLinkFiles, deleteRequestLinkFile,
  // 迁移
  migrateFromFileSystem,
  // 清理
  cleanupExpiredTokens, cleanupRateLimit, cleanupIncompleteUploads, cleanupSearchHistory,
  // DB 健康
  cleanupSyncLog, cleanupAuditLog, clearAuditLogs, getDbStats, getSystemStats, getDashboardStats, runVacuum, checkDbIntegrity, backupDb,
  // 标签颜色
  getTagColor, setTagColor, getAllTagColors, getSuggestedColor, deleteTagColor, touchTag,
  getTagEmoji, setTagEmoji,  getAllTags, getAllTagsWithStats, ensureTagStats, renameTagGlobally, deleteTagFromAllFiles, mergeTags, cleanupOrphanTags,
  // 文件夹标签
  getFolderTags, setFolderTags, addFolderTag, removeFolderTag,
  getAllTagDefinitions, createTagDefinition, updateTagDefinition, deleteTagDefinition, getVirtualFoldersByTag,
  // 垃圾桶
  moveToTrash, permanentlyDeleteFile, listTrash, restoreFromTrash, permanentlyDeleteTrash, emptyTrash, cleanupExpiredTrash,
  // 文件版本历史
  saveFileVersion, listFileVersions, getFileVersion, getFileVersionCount, deleteFileVersion, pruneFileVersions, pruneAllFileVersions,
  // 分片上传
  initChunkUpload, getChunkUpload, addChunkReceived, getChunkUploadStatus, deleteChunkUpload, getIncompleteUpload,
  // 导入导出
  exportAllData, importAllData
};
