/**
 * ShareTool db.js 单元测试
 * 使用内存数据库隔离测试
 */

const path = require('path');
const os = require('os');

// 测试配置：使用临时数据库
const TEST_DB_DIR = path.join(os.tmpdir(), 'sharetool-test-' + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test.db');
const TEST_CONFIG_DIR = TEST_DB_DIR;
const TEST_CONFIG_PATH = path.join(TEST_CONFIG_DIR, 'config.json');

// 设置测试环境变量
process.env.SHARE_TOOL_DB_DIR = TEST_DB_DIR;
process.env.SHARE_TOOL_CONFIG_DIR = TEST_CONFIG_DIR;
process.env.SHARE_TOOL_CONFIG_PATH = TEST_CONFIG_PATH;

// 创建临时目录
const fs = require('fs');
if (!fs.existsSync(TEST_DB_DIR)) {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
}

// 加载 db 模块（会使用环境变量指向测试数据库）
const db = require('../db');

beforeAll(() => {
  // 确保数据库初始化完成
  db.initDatabase();
});

afterAll(() => {
  // 清理测试数据库
  try {
    const { getDb } = require('../db');
    const testDb = getDb();
    testDb.close();
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  } catch (e) {
    // ignore
  }
});

beforeEach(() => {
  // 每个测试前清空 files 表
  try {
    const { getDb } = require('../db');
    const testDb = getDb();
    testDb.exec('DELETE FROM files');
    testDb.exec('DELETE FROM sync_log');
    testDb.exec('DELETE FROM audit_log');
    testDb.exec('DELETE FROM tokens');
    testDb.exec('DELETE FROM devices');
    testDb.exec('DELETE FROM share_links');
  } catch (e) {
    // ignore
  }
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
    db.updateFile(created.id, 'new content');
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
    // 应该按相关性排序
    expect(results[0].filename).toContain('java');
  });

  test('searchFiles 标签过滤', () => {
    const f1 = db.addFile('doc1.txt', 'content', 'text');
    const f2 = db.addFile('doc2.txt', 'content', 'text');
    db.updateFile(f1.id, 'content', null, 'important,work');
    db.updateFile(f2.id, 'content', null, 'personal');

    const results = db.searchFiles('', 'important');
    expect(results.length).toBeGreaterThanOrEqual(1);
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
    const token = db.generateToken();
    expect(token).toBeDefined();
    expect(token.length).toBeGreaterThan(20);
  });

  test('validateToken 验证有效 token', () => {
    const token = db.generateToken();
    const valid = db.validateToken(token);
    expect(valid).toBe(true);
  });

  test('validateToken 拒绝无效 token', () => {
    const valid = db.validateToken('invalid-token-xyz');
    expect(valid).toBe(false);
  });

  test('refreshToken 刷新 token', () => {
    const oldToken = db.generateToken();
    const newToken = db.refreshToken(oldToken);
    expect(newToken).toBeDefined();
    expect(newToken).not.toBe(oldToken);
    expect(db.validateToken(oldToken)).toBe(false);
    expect(db.validateToken(newToken)).toBe(true);
  });

  test('revokeToken 撤销 token', () => {
    const token = db.generateToken();
    db.revokeToken(token);
    expect(db.validateToken(token)).toBe(false);
  });
});

describe('分享链接', () => {
  test('saveShareLink 创建分享链接', () => {
    db.addFile('share-test.txt', 'content', 'text');
    const share = db.saveShareLink({ filename: 'share-test.txt', expiresAt: null });
    expect(share.code).toBeDefined();
    expect(share.code.length).toBe(6);
  });

  test('saveShareLink 密码哈希', () => {
    db.addFile('pwd-test.txt', 'content', 'text');
    const share = db.saveShareLink({ filename: 'pwd-test.txt', password: 'secret123', expiresAt: null });
    expect(share.hasPassword).toBe(true);
    // 不应返回明文密码
    expect(share._passwordHash).not.toBe('secret123');
  });

  test('getShareLink 获取分享链接', () => {
    db.addFile('get-share.txt', 'content', 'text');
    const created = db.saveShareLink({ filename: 'get-share.txt', expiresAt: null });
    const retrieved = db.getShareLink(created.code);
    expect(retrieved.filename).toBe('get-share.txt');
  });

  test('verifyPassword 密码验证', () => {
    db.addFile('verify-pwd.txt', 'content', 'text');
    const share = db.saveShareLink({ filename: 'verify-pwd.txt', password: 'test1234', expiresAt: null });
    // 通过 getShareLink 获取哈希
    const retrieved = db.getShareLink(share.code);
    const valid = db.verifyPassword('test1234', retrieved._passwordHash);
    expect(valid).toBe(true);
  });

  test('deleteShareLink 删除分享链接', () => {
    db.addFile('del-share.txt', 'content', 'text');
    const share = db.saveShareLink({ filename: 'del-share.txt', expiresAt: null });
    db.deleteShareLink(share.code);
    expect(db.getShareLink(share.code)).toBeUndefined();
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
    db.recordRateLimitAttempt('test:succ:789', true); // success
    const result = db.checkRateLimit('test:succ:789');
    expect(result.attempts).toBe(0);
    expect(result.remaining).toBe(5);
  });

  test('checkRateLimit 锁定状态', () => {
    // 模拟连续失败 5 次
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
    expect(hash.includes(':')).toBe(true); // salt:hash 格式
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
    // 旧格式：直接存储明文密码
    const valid = db.verifyPassword('plaintext', 'plaintext');
    expect(valid).toBe(true);
    // 新格式：hash
    const hash = db.hashPassword('hashed');
    const valid2 = db.verifyPassword('hashed', hash);
    expect(valid2).toBe(true);
  });
});
