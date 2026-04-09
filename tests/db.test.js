/**
 * ShareTool db.js 单元测试
 * 使用共享测试数据库（~/.share-tool/）
 * 每个测试前清理相关表
 */

const path = require('path');
const os = require('os');

// 使用生产 DB 路径（测试环境共享）
process.env.SHARE_TOOL_DB_DIR = path.join(os.homedir(), '.share-tool');
process.env.SHARE_TOOL_CONFIG_DIR = path.join(os.homedir(), '.share-tool');
process.env.SHARE_TOOL_CONFIG_PATH = path.join(os.homedir(), '.share-tool', 'config.json');

const db = require('../db');

beforeAll(() => {
  db.initDatabase();
  db.getDb(); // 触发初始化
});

beforeEach(() => {
  // 每个测试前清空相关表（保留结构）
  const testDb = db.getDb();
  const tables = ['files', 'sync_log', 'audit_log', 'tokens', 'devices', 'share_links', 'rate_limit'];
  for (const t of tables) {
    try { testDb.exec(`DELETE FROM ${t}`); } catch(e) {}
  }
});

afterAll(() => {
  try { db.getDb().close(); } catch(e) {}
});

describe('文件操作', () => {
  test('addFile 创建文件', () => {
    const result = db.addFile('test.txt', 'hello world', 'text');
    expect(result.id).toBeDefined();
    expect(result.hash).toBeDefined();
    expect(result.size).toBe(11);
  });

  test('addFile 记录 sync_log', () => {
    const result = db.addFile('sync-test.txt', 'content', 'text');
    const logs = db.getUnsyncedLogs(0);
    const fileLog = logs.find(l => l.filename === 'sync-test.txt');
    expect(fileLog).toBeDefined();
    expect(fileLog.action).toBe('create');
    expect(fileLog.file_id).toBe(result.id);
  });

  test('getFile 获取文件', () => {
    const created = db.addFile('get-test.txt', 'get content', 'text');
    const file = db.getFile(created.id);
    expect(file.filename).toBe('get-test.txt');
    expect(file.content).toBe('get content');
  });

  test('getFileByName 按文件名获取', () => {
    db.addFile('by-name.txt', 'content', 'text');
    const file = db.getFileByName('by-name.txt');
    expect(file).toBeDefined();
    expect(file.content).toBe('content');
  });

  test('updateFile 更新文件', () => {
    const created = db.addFile('update.txt', 'old', 'text');
    db.updateFile(created.id, { content: 'new content' });
    const updated = db.getFile(created.id);
    expect(updated.content).toBe('new content');
  });

  test('deleteFileByName 删除文件', () => {
    db.addFile('delete-me.txt', 'content', 'text');
    const deleted = db.deleteFileByName('delete-me.txt');
    expect(deleted).toBe(true);
    expect(db.getFileByName('delete-me.txt')).toBeUndefined();
  });

  test('renameFile 重命名文件', () => {
    const created = db.addFile('old-name.txt', 'content', 'text');
    const result = db.renameFile('old-name.txt', 'new-name.txt');
    expect(result.success).toBe(true);
    expect(db.getFileByName('old-name.txt')).toBeUndefined();
    expect(db.getFileByName('new-name.txt')).toBeDefined();
  });

  test('renameFile 记录 sync_log', () => {
    db.addFile('rename-log.txt', 'content', 'text');
    db.renameFile('rename-log.txt', 'renamed.txt');
    const logs = db.getUnsyncedLogs(0);
    const renameLog = logs.find(l => l.filename === 'renamed.txt' && l.action === 'rename');
    expect(renameLog).toBeDefined();
  });

  test('listFiles 列出文件', () => {
    db.addFile('file1.txt', 'c1', 'text');
    db.addFile('file2.txt', 'c2', 'text');
    const { files, total } = db.listFiles();
    expect(total).toBeGreaterThanOrEqual(2);
  });

  test('searchFiles 搜索文件', () => {
    db.addFile('javascript-notes.txt', 'js content', 'text');
    db.addFile('python-script.py', 'py content', 'text');
    db.addFile('java-code.java', 'java content', 'text');

    const results = db.searchFiles('java');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test('getFileCount 文件计数', () => {
    const before = db.getFileCount();
    db.addFile('count1.txt', 'c', 'text');
    db.addFile('count2.txt', 'c', 'text');
    const after = db.getFileCount();
    expect(after - before).toBe(2);
  });

  test('getTotalStorageSize 存储大小', () => {
    const before = db.getTotalStorageSize();
    db.addFile('size.txt', 'hello', 'text');
    const after = db.getTotalStorageSize();
    expect(after - before).toBe(5);
  });
});

describe('Token 管理', () => {
  test('generateToken 生成 token', () => {
    const result = db.generateToken();
    expect(result.token).toBeDefined();
    expect(result.token.length).toBeGreaterThan(20);
  });

  test('validateToken 验证有效 token', () => {
    const result = db.generateToken();
    const valid = db.validateToken(result.token);
    expect(valid).not.toBe(null);
    expect(valid.token).toBe(result.token);
  });

  test('validateToken 拒绝无效 token', () => {
    const valid = db.validateToken('invalid-token-xyz');
    expect(valid).toBe(null);
  });

  test('refreshToken 刷新 token', () => {
    const result = db.generateToken();
    const oldToken = result.token;
    const refreshResult = db.refreshToken(result.refreshToken);
    expect(refreshResult.success).toBe(true);
    expect(refreshResult.token).not.toBe(oldToken);
    expect(db.validateToken(oldToken)).toBe(null);
    expect(db.validateToken(refreshResult.token)).not.toBe(null);
  });

  test('revokeToken 撤销 token', () => {
    const result = db.generateToken();
    db.revokeToken(result.token);
    expect(db.validateToken(result.token)).toBe(null);
  });
});

describe('分享链接', () => {
  test('saveShareLink 创建分享链接', () => {
    db.addFile('share-test.txt', 'content', 'text');
    const share = db.saveShareLink({ filename: 'share-test.txt', expiresAt: null, code: 'TEST01' });
    expect(share.code).toBeDefined();
    expect(share.code.length).toBe(6);
  });

  test('saveShareLink 密码哈希', () => {
    db.addFile('pwd-test.txt', 'content', 'text');
    const share = db.saveShareLink({ filename: 'pwd-test.txt', password: 'secret123', expiresAt: null, code: 'TEST02' });
    expect(share.hasPassword).toBe(true);
    expect(share._passwordHash).not.toBe('secret123');
  });

  test('getShareLink 获取分享链接', () => {
    db.addFile('get-share.txt', 'content', 'text');
    const created = db.saveShareLink({ filename: 'get-share.txt', expiresAt: null, code: 'TEST03' });
    const retrieved = db.getShareLink(created.code);
    expect(retrieved.filename).toBe('get-share.txt');
  });

  test('verifyPassword 密码验证', () => {
    db.addFile('verify-pwd.txt', 'content', 'text');
    const share = db.saveShareLink({ filename: 'verify-pwd.txt', password: 'test1234', expiresAt: null, code: 'TEST04' });
    const retrieved = db.getShareLink(share.code);
    const valid = db.verifyPassword('test1234', retrieved._passwordHash);
    expect(valid).toBe(true);
  });

  test('deleteShareLink 删除分享链接', () => {
    db.addFile('del-share.txt', 'content', 'text');
    const share = db.saveShareLink({ filename: 'del-share.txt', expiresAt: null, code: 'TEST05' });
    db.deleteShareLink(share.code);
    expect(db.getShareLink(share.code)).toBeNull();
  });
});

describe('审计日志', () => {
  test('addAuditLog 记录审计日志', () => {
    db.addAuditLog('test_action', 'test details', '127.0.0.1');
    const { rows: logs } = db.listAuditLogs(10);
    const log = logs.find(l => l.action === 'test_action');
    expect(log).toBeDefined();
    expect(log.details).toBe('test details');
  });

  test('listAuditLogs 分页', () => {
    for (let i = 0; i < 5; i++) {
      db.addAuditLog(`action_${i}`, `details ${i}`, '127.0.0.1');
    }
    const { rows: logs } = db.listAuditLogs(3, 0);
    expect(logs.length).toBe(3);
  });

  test('getAuditStats 统计', () => {
    db.addAuditLog('stat_test', 'details', '127.0.0.1');
    const stats = db.getAuditStats();
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.todayCount).toBeGreaterThanOrEqual(1);
  });
});

describe('速率限制', () => {
  test('checkRateLimit 初始允许', () => {
    const result = db.checkRateLimit('test:key:123');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
  });

  test('recordRateLimitAttempt 失败计数', () => {
    db.recordRateLimitAttempt('test:fail:456', false);
    db.recordRateLimitAttempt('test:fail:456', false);
    const result = db.checkRateLimit('test:fail:456');
    expect(result.attempts).toBe(2);
    expect(result.remaining).toBe(3);
  });

  test('recordRateLimitAttempt 成功清除', () => {
    db.recordRateLimitAttempt('test:succ:789', false);
    db.recordRateLimitAttempt('test:succ:789', false);
    db.recordRateLimitAttempt('test:succ:789', true);
    const result = db.checkRateLimit('test:succ:789');
    expect(result.attempts).toBe(0);
    expect(result.remaining).toBe(5);
  });

  test('checkRateLimit 锁定状态', () => {
    for (let i = 0; i < 5; i++) {
      db.recordRateLimitAttempt('test:lock', false);
    }
    const result = db.checkRateLimit('test:lock');
    expect(result.allowed).toBe(false);
    expect(result.locked).toBe(true);
    expect(result.remaining).toBe(0);
  });
});

describe('密码哈希', () => {
  test('hashPassword 哈希并可验证', () => {
    const hash = db.hashPassword('mysecretpassword');
    expect(hash).not.toBe('mysecretpassword');
    expect(hash.includes(':')).toBe(true);
  });

  test('verifyPassword 正确密码', () => {
    const hash = db.hashPassword('verifyme');
    const valid = db.verifyPassword('verifyme', hash);
    expect(valid).toBe(true);
  });

  test('verifyPassword 错误密码', () => {
    const hash = db.hashPassword('correct');
    const valid = db.verifyPassword('wrong', hash);
    expect(valid).toBe(false);
  });

  test('verifyPassword 兼容旧明文', () => {
    const valid = db.verifyPassword('plaintext', 'plaintext');
    expect(valid).toBe(true);
    const hash = db.hashPassword('hashed');
    const valid2 = db.verifyPassword('hashed', hash);
    expect(valid2).toBe(true);
  });
});
