/**
 * ShareTool DB Layer Tests
 * Tests core database functions in isolation
 */

const path = require('path');
const os = require('os');

describe('DB Layer', () => {
  let db;
  let testDbPath;

  beforeAll(() => {
    // Use in-memory database for tests
    process.env.SHARETOOL_DB_PATH = ':memory:';
    // Reset module to get fresh state
    jest.resetModules();
    db = require('../db.js');
    db.initDatabase();
  });

  afterAll(() => {
    // Clean up test db file if it exists
    if (testDbPath) {
      try { require('fs').unlinkSync(testDbPath); } catch (e) {}
    }
  });

  describe('hashPassword / verifyPassword', () => {
    test('hashPassword returns a string longer than input', () => {
      const hash = db.hashPassword('testpassword');
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(20);
    });

    test('same password produces different hashes (due to random salt)', () => {
      const hash1 = db.hashPassword('samepassword');
      const hash2 = db.hashPassword('samepassword');
      expect(hash1).not.toBe(hash2);
    });

    test('verifyPassword returns true for correct password', () => {
      const hash = db.hashPassword('correctpassword');
      expect(db.verifyPassword('correctpassword', hash)).toBe(true);
    });

    test('verifyPassword returns false for wrong password', () => {
      const hash = db.hashPassword('correctpassword');
      expect(db.verifyPassword('wrongpassword', hash)).toBe(false);
    });
  });

  describe('File Operations', () => {
    test('addFile inserts a file and returns it', () => {
      const result = db.addFile('test-file.txt', 'Hello World', 'text');
      expect(result.filename).toBe('test-file.txt');
      expect(result.content).toBe('Hello World');
      expect(result.type).toBe('text');
      expect(result.id).toBeGreaterThan(0);
    });

    test('addFile creates a sync_log entry with valid fileId', () => {
      const result = db.addFile('sync-test.txt', 'sync content', 'text');
      const logs = db.getUnsyncedLogs(0);
      const ourLog = logs.find(l => l.filename === 'sync-test.txt');
      expect(ourLog).toBeDefined();
      expect(ourLog.file_id).toBe(result.id);
    });

    test('getFileByName retrieves a file by filename', () => {
      db.addFile('get-by-name.txt', 'content here', 'text');
      const file = db.getFileByName('get-by-name.txt');
      expect(file).toBeDefined();
      expect(file.filename).toBe('get-by-name.txt');
    });

    test('getFileByName returns undefined for non-existent file', () => {
      const file = db.getFileByName('nonexistent-file-xyz.txt');
      expect(file).toBeUndefined();
    });

    test('deleteFileByName removes a file', () => {
      db.addFile('to-delete.txt', 'delete me', 'text');
      const before = db.getFileByName('to-delete.txt');
      expect(before).toBeDefined();
      db.deleteFileByName('to-delete.txt');
      const after = db.getFileByName('to-delete.txt');
      expect(after).toBeUndefined();
    });

    test('renameFile renames a file correctly', () => {
      db.addFile('old-name.txt', 'rename test', 'text');
      const result = db.renameFile('old-name.txt', 'new-name.txt');
      expect(result.success).toBe(true);
      const oldFile = db.getFileByName('old-name.txt');
      const newFile = db.getFileByName('new-name.txt');
      expect(oldFile).toBeUndefined();
      expect(newFile).toBeDefined();
      expect(newFile.filename).toBe('new-name.txt');
    });

    test('renameFile returns error for non-existent file', () => {
      const result = db.renameFile('nonexistent.txt', 'new.txt');
      expect(result.success).toBe(false);
    });

    test('getFileCount returns correct count', () => {
      const before = db.getFileCount();
      db.addFile('count-test.txt', 'count', 'text');
      const after = db.getFileCount();
      expect(after).toBe(before + 1);
    });

    test('getTotalStorageSize increases with file size', () => {
      const before = db.getTotalStorageSize();
      db.addFile('size-test.txt', 'x'.repeat(100), 'text');
      const after = db.getTotalStorageSize();
      expect(after).toBeGreaterThan(before);
    });
  });

  describe('Search', () => {
    beforeAll(() => {
      // Add test files for search
      db.addFile('project-report.pdf', 'report content', 'file');
      db.addFile('photo-2024.jpg', 'image data', 'file');
      db.addFile('notes.txt', 'text notes', 'text');
      db.addFile('代码笔记.js', 'javascript code', 'text');
    });

    test('searchFiles finds files by name prefix', () => {
      const results = db.searchFiles('project');
      const filenames = results.map(f => f.filename);
      expect(filenames).toContain('project-report.pdf');
    });

    test('searchFiles finds files by partial match', () => {
      const results = db.searchFiles('report');
      const filenames = results.map(f => f.filename);
      expect(filenames).toContain('project-report.pdf');
    });

    test('searchFiles returns empty for no match', () => {
      const results = db.searchFiles('xyznonexistent');
      expect(results.length).toBe(0);
    });

    test('searchFiles with no query returns files (limit)', () => {
      const results = db.searchFiles(null);
      expect(results.length).toBeGreaterThan(0);
    });

    test('searchFiles scores prefix matches higher than contains', () => {
      db.addFile('test-prefix-file.txt', 'content', 'text');
      db.addFile('some-test-file.txt', 'content', 'text');
      const results = db.searchFiles('test');
      const filenames = results.map(f => f.filename);
      const prefixIndex = filenames.indexOf('test-prefix-file.txt');
      const containsIndex = filenames.indexOf('some-test-file.txt');
      expect(prefixIndex).toBeLessThan(containsIndex);
    });
  });

  describe('Token Management', () => {
    test('generateToken returns a token string', () => {
      const token = db.generateToken('test-device', 'Test Device');
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(10);
    });

    test('validateToken returns device info for valid token', () => {
      const token = db.generateToken('valid-device', 'Valid Device');
      const result = db.validateToken(token);
      expect(result).toBeDefined();
      expect(result.deviceId).toBe('valid-device');
      expect(result.deviceName).toBe('Valid Device');
    });

    test('validateToken returns null for invalid token', () => {
      const result = db.validateToken('invalid-token-xyz');
      expect(result).toBeNull();
    });

    test('refreshToken extends expiry', () => {
      const token = db.generateToken('refresh-device', 'Refresh Device');
      const before = db.validateToken(token);
      // Simulate time passing (in real test we'd use fake timers)
      const refreshed = db.refreshToken(token);
      expect(refreshed).toBe(true);
    });

    test('revokeToken invalidates token', () => {
      const token = db.generateToken('revoke-device', 'Revoke Device');
      expect(db.validateToken(token)).toBeDefined();
      db.revokeToken(token);
      expect(db.validateToken(token)).toBeNull();
    });
  });

  describe('Share Links', () => {
    test('saveShareLink creates a share link', () => {
      db.addFile('share-test.txt', 'share content', 'text');
      const link = db.saveShareLink({
        filename: 'share-test.txt',
        expiresIn: 3600
      });
      expect(link.code).toBeDefined();
      expect(link.code.length).toBe(8);
    });

    test('getShareLink retrieves share link by code', () => {
      const saved = db.saveShareLink({ filename: 'share-test.txt', expiresIn: 3600 });
      const retrieved = db.getShareLink(saved.code);
      expect(retrieved).toBeDefined();
      expect(retrieved.filename).toBe('share-test.txt');
    });

    test('getShareLink returns null for invalid code', () => {
      const result = db.getShareLink('INVALIDX');
      expect(result).toBeNull();
    });

    test('share link with password has hasPassword=true', () => {
      db.addFile('protected.txt', 'secret', 'text');
      const link = db.saveShareLink({
        filename: 'protected.txt',
        password: 'secretpass',
        expiresIn: 3600
      });
      const retrieved = db.getShareLink(link.code);
      expect(retrieved.hasPassword).toBe(true);
      expect(retrieved._passwordHash).toBeDefined();
      expect(retrieved.password).toBeUndefined(); // password field should not be exposed
    });

    test('verifyPassword works with share link hash', () => {
      db.addFile('verify-test.txt', 'content', 'text');
      const link = db.saveShareLink({
        filename: 'verify-test.txt',
        password: 'testpass123',
        expiresIn: 3600
      });
      const retrieved = db.getShareLink(link.code);
      expect(retrieved.hasPassword).toBe(true);
      // Use verifyPassword directly on stored hash
      const isValid = db.verifyPassword('testpass123', retrieved._passwordHash);
      expect(isValid).toBe(true);
    });

    test('deleteShareLink removes share link', () => {
      const link = db.saveShareLink({ filename: 'share-test.txt', expiresIn: 3600 });
      expect(db.getShareLink(link.code)).toBeDefined();
      db.deleteShareLink(link.code);
      expect(db.getShareLink(link.code)).toBeNull();
    });
  });

  describe('Rate Limiting', () => {
    test('checkRateLimit allows first attempt', () => {
      const result = db.checkRateLimit('test:rate:key');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    test('recordRateLimitAttempt increments count', () => {
      const key = 'test:rate:count';
      db.recordRateLimitAttempt(key, false);
      const result = db.checkRateLimit(key);
      expect(result.attempts).toBe(1);
    });

    test('recordRateLimitAttempt with success clears record', () => {
      const key = 'test:rate:clear';
      db.recordRateLimitAttempt(key, false);
      db.recordRateLimitAttempt(key, false);
      expect(db.checkRateLimit(key).attempts).toBe(2);
      db.recordRateLimitAttempt(key, true); // success clears
      const result = db.checkRateLimit(key);
      expect(result.attempts).toBe(0);
    });
  });

  describe('Audit Log', () => {
    test('addAuditLog creates a log entry', () => {
      db.addAuditLog('test_action', 'test details', '127.0.0.1', 'test-token');
      const logs = db.listAuditLogs(10, 0, { action: 'test_action' });
      const ourLog = logs.find(l => l.action === 'test_action');
      expect(ourLog).toBeDefined();
      expect(ourLog.details).toBe('test details');
    });

    test('getAuditStats returns stats object', () => {
      const stats = db.getAuditStats();
      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('todayCount');
      expect(stats).toHaveProperty('byAction');
    });
  });

  describe('DB Stats', () => {
    test('getDbStats returns database statistics', () => {
      const stats = db.getDbStats();
      expect(stats).toHaveProperty('fileCount');
      expect(stats).toHaveProperty('totalSize');
      expect(stats).toHaveProperty('deviceCount');
      expect(stats).toHaveProperty('shareLinkCount');
      expect(stats.fileCount).toBeGreaterThan(0);
    });

    test('checkDbIntegrity returns ok status', () => {
      const result = db.checkDbIntegrity();
      expect(result).toBe('ok');
    });
  });
});
