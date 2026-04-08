#!/usr/bin/env node
/**
 * ShareTool - AES-256-GCM 端到端加密
 * 使用 Web Crypto API / Node.js crypto
 * 加密过程完全在客户端完成，服务器不存储密码
 */

const crypto = require('crypto');

// AES-256-GCM
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;  // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32; // 256-bit
const ITERATIONS = 100000;

/**
 * 从密码派生 AES-256 key
 * @param {string} password - 用户密码
 * @param {Buffer} salt - 盐值
 * @returns {Buffer} 256-bit key
 */
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * 加密数据
 * @param {string|Buffer} plaintext - 原始数据
 * @param {string} password - 加密密码
 * @returns {Buffer} 加密数据 (salt + iv + authTag + ciphertext)
 */
function encrypt(plaintext, password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });
  
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  // 格式: salt(16) + iv(12) + authTag(16) + ciphertext
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * 解密数据
 * @param {Buffer} encryptedData - 加密数据
 * @param {string} password - 解密密码
 * @returns {Buffer|null} 解密后数据，失败返回 null
 */
function decrypt(encryptedData, password) {
  try {
    const salt = encryptedData.subarray(0, SALT_LENGTH);
    const iv = encryptedData.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const authTag = encryptedData.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = encryptedData.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    
    const key = deriveKey(password, salt);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH
    });
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    return null;  // 密码错误或数据损坏
  }
}

/**
 * 加密文件内容
 * @param {Buffer} fileContent - 文件内容
 * @param {string} password - 密码
 * @returns {Buffer} 加密后内容
 */
function encryptFile(fileContent, password) {
  return encrypt(fileContent, password);
}

/**
 * 解密文件内容
 * @param {Buffer} encryptedContent - 加密内容
 * @param {string} password - 密码
 * @returns {Buffer|null} 解密后内容
 */
function decryptFile(encryptedContent, password) {
  return decrypt(encryptedContent, password);
}

/**
 * 验证密码是否正确（不解密数据）
 * @param {Buffer} encryptedData - 加密数据
 * @param {string} password - 待验证密码
 * @returns {boolean} 密码是否正确
 */
function verifyPassword(encryptedData, password) {
  const decrypted = decrypt(encryptedData, password);
  return decrypted !== null;
}

/**
 * 获取加密文件的元信息（不解密内容）
 * @param {Buffer} encryptedData - 加密数据
 * @returns {object|null} { salt, iv, authTag, ciphertextLength }
 */
function getEncryptionInfo(encryptedData) {
  if (encryptedData.length < SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH) {
    return null;
  }
  return {
    salt: encryptedData.subarray(0, SALT_LENGTH).toString('hex'),
    iv: encryptedData.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH).toString('hex'),
    authTagLength: AUTH_TAG_LENGTH,
    ciphertextLength: encryptedData.length - SALT_LENGTH - IV_LENGTH - AUTH_TAG_LENGTH,
    totalLength: encryptedData.length
  };
}

module.exports = {
  encrypt,
  decrypt,
  encryptFile,
  decryptFile,
  verifyPassword,
  getEncryptionInfo,
  ALGORITHM,
  KEY_LENGTH,
  IV_LENGTH,
  SALT_LENGTH
};
