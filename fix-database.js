#!/usr/bin/env node
/**
 * ShareTool 数据库修复脚本
 * 修复 Schema 初始化不完整的问题
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const DB_PATH = process.env.SHARE_TOOL_DB_PATH || path.join(os.homedir(), '.share-tool', 'share-tool.db');
const SCHEMA_VERSION = 8;

console.log('[FixDB] Database path:', DB_PATH);

let db;
try {
  db = new Database(DB_PATH);
} catch (e) {
  console.error('[FixDB] Failed to open database:', e.message);
  process.exit(1);
}

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 获取当前 schema 版本
const getCurrentVersion = () => {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    return row ? parseInt(row.value, 10) : 1;
  } catch {
    return 1;
  }
};

// 检查表是否存在
const tableExists = (tableName) => {
  const result = db.prepare(
    "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(tableName);
  return result.c > 0;
};

// 检查列是否存在
const columnExists = (tableName, columnName) => {
  try {
    db.prepare(`SELECT ${columnName} FROM ${tableName} LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
};

console.log('[FixDB] Checking database schema...');

// 修复 1: 确保 search_history 表存在
if (!tableExists('search_history')) {
  console.log('[FixDB] Creating missing table: search_history');
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      query       TEXT    NOT NULL,
      user_id     TEXT,
      timestamp   INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id, timestamp DESC)');
}

// 修复 2: 确保 virtual_folders.position 列存在
if (tableExists('virtual_folders') && !columnExists('virtual_folders', 'position')) {
  console.log('[FixDB] Adding missing column: virtual_folders.position');
  try {
    db.exec("ALTER TABLE virtual_folders ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
  } catch (e) {
    if (!e.message.includes('duplicate column')) {
      console.error('[FixDB] Error adding position column:', e.message);
    }
  }
}

// 修复 3: 确保 trash.tags 列存在（v7 迁移）
if (tableExists('trash') && !columnExists('trash', 'tags')) {
  console.log('[FixDB] Adding missing column: trash.tags');
  try {
    db.exec("ALTER TABLE trash ADD COLUMN tags TEXT DEFAULT ''");
  } catch (e) {
    if (!e.message.includes('duplicate column')) {
      console.error('[FixDB] Error adding tags column:', e.message);
    }
  }
}

// 修复 4: 更新 schema_version
const currentVersion = getCurrentVersion();
console.log(`[FixDB] Current schema version: ${currentVersion}`);

if (currentVersion < SCHEMA_VERSION) {
  console.log(`[FixDB] Updating schema version to ${SCHEMA_VERSION}`);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
}

// 验证修复结果
console.log('\n[FixDB] Verification:');
console.log('  - search_history table:', tableExists('search_history') ? '✓' : '✗');
console.log('  - virtual_folders.position:', columnExists('virtual_folders', 'position') ? '✓' : '✗');
console.log('  - trash.tags:', columnExists('trash', 'tags') ? '✓' : '✗');

const finalVersion = getCurrentVersion();
console.log(`  - schema_version: ${finalVersion}`);

db.close();

if (finalVersion === SCHEMA_VERSION) {
  console.log('\n[FixDB] ✓ Database schema is now up to date!');
  process.exit(0);
} else {
  console.log('\n[FixDB] ⚠ Database may still have issues');
  process.exit(1);
}
