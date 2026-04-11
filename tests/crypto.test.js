/**
 * ShareTool Crypto Tests
 * Tests AES-256-GCM encryption/decryption
 */

const crypto = require('../crypto.js');

describe('Crypto Layer', () => {
  describe('encrypt / decrypt', () => {
    test('encrypt returns a Buffer', () => {
      const encrypted = crypto.encrypt('hello world', 'password123');
      expect(Buffer.isBuffer(encrypted)).toBe(true);
      expect(encrypted.length).toBeGreaterThan(16 + 12 + 16); // salt + iv + authTag minimum
    });

    test('decrypt returns Buffer for correct password', () => {
      const original = 'Hello, World! 你好世界！';
      const encrypted = crypto.encrypt(original, 'testpassword');
      const decrypted = crypto.decrypt(encrypted, 'testpassword');
      expect(Buffer.isBuffer(decrypted)).toBe(true);
      expect(decrypted.toString('utf8')).toBe(original);
    });

    test('decrypt returns original plaintext Buffer', () => {
      const original = Buffer.from('binary data \x00\xff\xfe');
      const encrypted = crypto.encrypt(original, 'testpassword');
      const decrypted = crypto.decrypt(encrypted, 'testpassword');
      expect(Buffer.isBuffer(decrypted)).toBe(true);
      expect(decrypted.equals(original)).toBe(true);
    });

    test('decrypt with wrong password returns null', () => {
      const encrypted = crypto.encrypt('secret', 'correctpassword');
      expect(crypto.decrypt(encrypted, 'wrongpassword')).toBeNull();
    });

    test('same plaintext produces different ciphertext (random IV)', () => {
      const encrypted1 = crypto.encrypt('same text', 'password');
      const encrypted2 = crypto.encrypt('same text', 'password');
      expect(encrypted1.equals(encrypted2)).toBe(false);
    });

    test('empty string can be encrypted and decrypted', () => {
      const encrypted = crypto.encrypt('', 'password');
      const decrypted = crypto.decrypt(encrypted, 'password');
      expect(Buffer.isBuffer(decrypted)).toBe(true);
      expect(decrypted.toString('utf8')).toBe('');
    });

    test('unicode characters survive round-trip', () => {
      const originals = [
        '中文测试',
        '🎉🎊🎈',
        'emoji 😎 and text',
        '한국어',
        'العربية',
      ];
      for (const original of originals) {
        const encrypted = crypto.encrypt(original, 'password');
        const decrypted = crypto.decrypt(encrypted, 'password');
        expect(decrypted.toString('utf8')).toBe(original);
      }
    });
  });

  describe('encryptFile / decryptFile', () => {
    test('encryptFile returns encrypted Buffer with format header', () => {
      const fileContent = Buffer.from('file content here');
      const encrypted = crypto.encryptFile(fileContent, 'filepass');
      expect(Buffer.isBuffer(encrypted)).toBe(true);
      expect(encrypted.length).toBeGreaterThan(fileContent.length);
    });

    test('decryptFile returns original Buffer', () => {
      const original = Buffer.from('original file content with binary \x00\x01\x02');
      const encrypted = crypto.encryptFile(original, 'filepass');
      const decrypted = crypto.decryptFile(encrypted, 'filepass');
      expect(Buffer.isBuffer(decrypted)).toBe(true);
      expect(decrypted.equals(original)).toBe(true);
    });

    test('decryptFile with wrong password returns null', () => {
      const encrypted = crypto.encryptFile(Buffer.from('data'), 'correct');
      expect(crypto.decryptFile(encrypted, 'wrong')).toBeNull();
    });
  });

  describe('verifyPassword', () => {
    test('verifyPassword returns true for correct password', () => {
      const encrypted = crypto.encrypt('test', 'mypassword');
      expect(crypto.verifyPassword(encrypted, 'mypassword')).toBe(true);
    });

    test('verifyPassword returns false for wrong password', () => {
      const encrypted = crypto.encrypt('test', 'correctpassword');
      expect(crypto.verifyPassword(encrypted, 'wrongpassword')).toBe(false);
    });
  });

  describe('getEncryptionInfo', () => {
    test('returns info object from encrypted data', () => {
      const encrypted = crypto.encrypt('test data', 'password');
      const info = crypto.getEncryptionInfo(encrypted);
      expect(info).toHaveProperty('salt');
      expect(info).toHaveProperty('iv');
      expect(info).toHaveProperty('authTagLength');
      expect(info).toHaveProperty('ciphertextLength');
      expect(info.salt.length).toBe(32); // hex encoded 16-byte salt
    });

    test('returns null for data shorter than minimum header size', () => {
      const result = crypto.getEncryptionInfo(Buffer.from('too short'));
      expect(result).toBeNull();
    });
  });

  describe('Export constants', () => {
    test('exports ALGORITHM, KEY_LENGTH, IV_LENGTH, SALT_LENGTH', () => {
      expect(crypto.ALGORITHM).toBe('aes-256-gcm');
      expect(crypto.KEY_LENGTH).toBe(32);
      expect(crypto.IV_LENGTH).toBe(12);
      expect(crypto.SALT_LENGTH).toBe(16);
    });
  });
});
