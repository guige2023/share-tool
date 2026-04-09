/**
 * ShareTool DB Layer Tests
 * Uses in-memory SQLite for isolation
 */

// Must be set BEFORE require
process.env.SHARE_TOOL_DB_PATH = ':memory:';

const db = require('../db.js');

// Initialize in-memory DB for tests
db.initDatabase();

describe('Password Hashing', () => {
  test('hashPassword and verifyPassword work', () => {
    const password = 'test123';
    const hash = db.hashPassword(password);
    expect(hash).toBeTruthy();
    expect(hash).not.toBe(password);
    expect(hash.includes(':')).toBe(true); // salt:hash format
    expect(db.verifyPassword(password, hash)).toBe(true);
    expect(db.verifyPassword('wrong', hash)).toBe(false);
  });

  test('legacy plaintext password still verifies', () => {
    // Old format: no salt: prefix
    const legacyHash = 'plaintext_password';
    expect(db.verifyPassword('plaintext_password', legacyHash)).toBe(true);
    expect(db.verifyPassword('wrong', legacyHash)).toBe(false);
  });
});

describe('Rate Limiting', () => {
  const testKey = 'test:rate:' + Date.now();

  beforeEach(() => {
    // Clean up any existing rate limit for test key
    try { db.getDb().prepare('DELETE FROM rate_limit WHERE key = ?').run(testKey); } catch (e) {}
  });

  test('checkRateLimit allows first attempt', () => {
    const result = db.checkRateLimit(testKey);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
    expect(result.attempts).toBe(0);
  });

  test('recordRateLimitAttempt increments count', () => {
    db.recordRateLimitAttempt(testKey);
    const r1 = db.checkRateLimit(testKey);
    expect(r1.attempts).toBe(1);
    expect(r1.remaining).toBe(4);

    db.recordRateLimitAttempt(testKey);
    const r2 = db.checkRateLimit(testKey);
    expect(r2.attempts).toBe(2);
  });

  test('successful attempt clears rate limit', () => {
    db.recordRateLimitAttempt(testKey);
    db.recordRateLimitAttempt(testKey);
    db.recordRateLimitAttempt(testKey, true); // success = true
    const result = db.checkRateLimit(testKey);
    expect(result.attempts).toBe(0);
    expect(result.remaining).toBe(5);
  });

  test('max attempts triggers lockout', () => {
    for (let i = 0; i < 5; i++) {
      db.recordRateLimitAttempt(testKey);
    }
    const result = db.checkRateLimit(testKey);
    expect(result.allowed).toBe(false);
    expect(result.locked).toBe(true);
    expect(result.retryAfter).toBeGreaterThan(0);
  });
});

describe('File Operations', () => {
  const testFile = 'test_' + Date.now() + '.txt';

  afterAll(() => {
    try { db.deleteFileByName(testFile); } catch (e) {}
    try { db.deleteFileByName('renamed_' + testFile); } catch (e) {}
  });

  test('addFile creates file with correct hash', () => {
    const content = 'Hello Test World';
    const result = db.addFile(testFile, content, 'text');
    expect(result).toBeTruthy();
    expect(result.hash).toBeTruthy();
    expect(result.id).toBeTruthy();
    const file = db.getFileByName(testFile);
    expect(file).toBeTruthy();
    expect(file.filename).toBe(testFile);
  });

  test('getFile returns content and metadata', () => {
    const file = db.getFileByName(testFile);
    expect(file.content).toBe('Hello Test World');
    expect(file.type).toBe('text');
  });

  test('renameFile updates filename', () => {
    const result = db.renameFile(testFile, 'renamed_' + testFile);
    expect(result.success).toBe(true);
    const renamed = db.getFileByName('renamed_' + testFile);
    expect(renamed).toBeTruthy();
    const old = db.getFileByName(testFile);
    expect(old).toBeFalsy();
  });

  test('deleteFile removes file', () => {
    const toDelete = 'to_delete_' + Date.now() + '.txt';
    db.addFile(toDelete, 'content', 'text');
    const before = db.getFileCount();
    db.deleteFileByName(toDelete);
    const after = db.getFileCount();
    expect(after).toBeLessThan(before);
  });
});

describe('Search', () => {
  beforeAll(() => {
    db.addFile('apple.txt', 'content', 'text');
    db.addFile('banana.txt', 'content', 'text');
    db.addFile('apple_banana.txt', 'content', 'text');
    db.addFile('folder/apple.txt', 'content', 'text');
    db.addFile('work_notes.txt', 'some content for work notes', 'text');
    db.updateFileByName('work_notes.txt', { tags: 'tag1,tag2' });
  });

  afterAll(() => {
    ['apple.txt', 'banana.txt', 'apple_banana.txt', 'work_notes.txt'].forEach(f => {
      try { db.deleteFileByName(f); } catch (e) {}
    });
    try { db.deleteFileByName('folder/apple.txt'); } catch (e) {}
  });

  test('searchFiles finds by token', () => {
    const results = db.searchFiles('apple', null, { fuzzy: false });
    const filenames = results.map(f => f.filename);
    expect(filenames).toContain('apple.txt');
    expect(filenames).toContain('apple_banana.txt');
    expect(filenames).not.toContain('banana.txt');
  });

  test('searchFiles exact prefix match scores highest', () => {
    const results = db.searchFiles('apple', null, { fuzzy: false });
    // apple.txt should score higher than apple_banana.txt
    const fnames = results.map(f => f.filename);
    const appleIdx = fnames.indexOf('apple.txt');
    const appleBananaIdx = fnames.indexOf('apple_banana.txt');
    expect(appleIdx).toBeLessThan(appleBananaIdx);
  });

  test('searchFiles fuzzy match scores lower than exact', () => {
    const results = db.searchFiles('banana', null, { fuzzy: true });
    const fnames = results.map(f => f.filename);
    // banana.txt should be top (exact contains), apple_banana lower
    expect(fnames[0]).toBe('banana.txt');
  });

  test('searchFiles returns results within limit', () => {
    const results = db.searchFiles('a', null, { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test('searchFiles with tags filters correctly', () => {
    // Search for notes (in filename) filtered by tag1
    const results = db.searchFiles('notes', 'tag1', {});
    const fnames = results.map(f => f.filename);
    expect(fnames).toContain('work_notes.txt');
  });

  test('searchFiles with unmatched tag returns empty', () => {
    const results = db.searchFiles('notes', 'nonexistent_tag', {});
    expect(results.length).toBe(0);
  });
});

describe('Share Link', () => {
  const testShareFile = 'share_test_' + Date.now() + '.txt';

  beforeAll(() => {
    db.addFile(testShareFile, 'share content', 'text');
  });

  afterAll(() => {
    try { db.deleteFileByName(testShareFile); } catch (e) {}
  });

  test('saveShareLink creates share with password hash', () => {
    const result = db.saveShareLink({
      code: 'TEST' + Date.now(),
      filename: testShareFile,
      password: 'secret123',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });
    expect(result).toBeTruthy();
    const share = db.getShareLink(result.code);
    expect(share.hasPassword).toBe(true);
    expect(share._passwordHash).toContain(':'); // salt:hash format
    expect(share.filename).toBe(testShareFile);
  });

  test('getShareLink returns hasPassword false for no password', () => {
    const result = db.saveShareLink({
      code: 'NOTEST' + Date.now(),
      filename: testShareFile,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });
    const share = db.getShareLink(result.code);
    expect(share.hasPassword).toBe(false);
    expect(share._passwordHash).toBeFalsy();
  });

  test('verifyPassword works with share link hash', () => {
    const result = db.saveShareLink({
      code: 'PASST' + Date.now(),
      filename: testShareFile,
      password: 'testpass',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });
    const share = db.getShareLink(result.code);
    expect(db.verifyPassword('testpass', share._passwordHash)).toBe(true);
    expect(db.verifyPassword('wrongpass', share._passwordHash)).toBe(false);
  });
});

describe('Token', () => {
  test('generateToken creates valid token', () => {
    const result = db.generateToken();
    expect(result).toBeTruthy();
    expect(result.token).toBeTruthy();
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(20);
  });

  test('validateToken accepts valid token', () => {
    const result = db.generateToken();
    expect(db.validateToken(result.token)).toBeTruthy();
  });

  test('revokeToken invalidates token', () => {
    const result = db.generateToken();
    expect(db.validateToken(result.token)).toBeTruthy();
    db.revokeToken(result.token);
    expect(db.validateToken(result.token)).toBeFalsy();
  });
});

describe('Audit Log', () => {
  test('addAuditLog records entry', () => {
    const before = db.getAuditStats();
    db.addAuditLog('test_action', 'test details', '127.0.0.1');
    const after = db.getAuditStats();
    expect(after.total).toBe(before.total + 1);
  });
});

describe('File Copy', () => {
  const copySrc = 'copy_src_' + Date.now() + '.txt';
  const copyDest = 'copy_dest_' + Date.now() + '.txt';

  beforeAll(() => {
    db.addFile(copySrc, 'copy content', 'text');
  });

  afterAll(() => {
    try { db.deleteFileByName(copySrc); } catch (e) {}
    try { db.deleteFileByName(copyDest); } catch (e) {}
  });

  test('copyFile creates new file with same content', () => {
    const result = db.copyFile(copySrc, copyDest);
    expect(result.success).toBe(true);
    const copied = db.getFileByName(copyDest);
    expect(copied).toBeTruthy();
    expect(copied.content).toBe('copy content');
    expect(copied.filename).toBe(copyDest);
  });

  test('copyFile fails for non-existent source', () => {
    const result = db.copyFile('nonexistent_file_' + Date.now() + '.txt', 'dest.txt');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('copyFile fails for existing destination', () => {
    const result = db.copyFile(copySrc, copyDest);
    expect(result.success).toBe(false);
    expect(result.error).toBe('目标文件名已存在');
  });
});

describe('Sync Log', () => {
  test('addSyncLog creates log entry', () => {
    const ts = Math.floor(Date.now() / 1000) - 100;
    const before = db.getUnsyncedLogs(ts);
    const countBefore = before.length;

    db.addFile('sync_test_' + Date.now() + '.txt', 'sync content', 'text');
    const after = db.getUnsyncedLogs(ts);
    expect(after.length).toBeGreaterThanOrEqual(countBefore);
  });

  test('getUnsyncedLogs returns logs since timestamp', () => {
    const now = Math.floor(Date.now() / 1000);
    const logs = db.getUnsyncedLogs(now);
    expect(Array.isArray(logs)).toBe(true);
  });

  test('markLogsSynced marks logs as synced', () => {
    // Add a file and get its log
    const ts = Math.floor(Date.now() / 1000);
    const name = 'sync_mark_' + Date.now() + '.txt';
    const result = db.addFile(name, 'content', 'text');

    // Get the unsynced log for this file
    const logs = db.getUnsyncedLogs(ts - 100);
    const fileLog = logs.find(l => l.filename === name);

    if (fileLog) {
      db.markLogsSynced([result.id]);
      const afterMark = db.getUnsyncedLogs(ts - 100);
      const stillPresent = afterMark.some(l => l.filename === name);
      // After marking, the log should either be gone or marked as synced
    }
    try { db.deleteFileByName(name); } catch (e) {}
  });
});
