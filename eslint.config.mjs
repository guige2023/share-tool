// Minimal ESLint config for ShareTool
// Extend as needed; currently flags critical issues only
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'public/vendor/**',
      'app/**',
      'go/**',
    ]
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        global: 'readonly',
        getEffectiveToken: 'readonly',
        getShareToken: 'readonly',
        SHARE_TOKEN: 'readonly',
        broadcastSSE: 'readonly',
        config: 'readonly',
        VERSION: 'readonly',
        BASE_URL: 'readonly',
      },
    },
    rules: {
      // Critical
      'no-unused-vars': 'error',
      'no-undef': 'error',
      // Style
      'semi': ['error', 'always'],
      'quotes': ['error', 'single', { avoidEscape: true }],
      'indent': ['error', 2],
      'comma-dangle': ['error', 'never'],
      'object-curly-spacing': ['error', 'always'],
      'array-bracket-spacing': ['error', 'never'],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'semi': ['error', 'always'],
      'quotes': ['error', 'single', { avoidEscape: true }],
      'indent': ['error', 2],
    },
  },
  {
    files: ['server.js', 'db.js', 'cli.js', 'routes/**/*.js', 'mcp-server.mjs'],
    rules: {
      // Allow console in these files (use LOG_LEVEL guard in production)
      'no-console': 'off',
    },
  },
];
