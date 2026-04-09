module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: ['db.js', 'crypto.js'],
  coverageThreshold: {
    // Start low, increase as tests grow
    global: { branches: 20, functions: 20, lines: 20, statements: 20 }
  },
  testTimeout: 10000,
};
