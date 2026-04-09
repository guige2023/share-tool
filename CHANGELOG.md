# Changelog

All notable changes to ShareTool will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [v1.0.0] - 2026-04-09

### Added
- **Routes module split**: `server.js` refactored into `routes/` directory (api.js, files.js, share.js)
- **Structured logging**: pino JSON logger with TTY color output, LOG_LEVEL env var control
- **Docker support**: Multi-stage Dockerfile (node:22-alpine) + docker-compose.yml with healthcheck
- **Error boundaries**: Global uncaughtException/unhandledRejection handling with gracefulShutdown
- **Jest test suite**: 33 unit tests covering files, tokens, share links, audit logs, rate limiting, password hashing

### Security
- **CORS fix**: Origin allowlist instead of wildcard (`*`), supports localhost/192.168.x/10.x
- **Share code password hashing**: scrypt hash storage (salt:hash format), backward compatible with plaintext
- **XSS audit**: escapeHtml() applied to all innerHTML injections (search history, device list, audit log, QR modal, search suggestions, share links)
- **Rate limiting**: 5 attempts / 15-minute window, 5-minute lockout for share code password brute-force protection

### Performance
- **Search optimization**: SQLite LIKE pre-filter (max 500 candidates) before JS scoring/sort, idx_files_filename index
- **Tag filter**: Direct SQLite LIKE without JS overhead

### Fixed
- **P0 sync bugs**: addFile now records real fileId in sync_log; sync_push broadcasts actual file data; file_delete/file_rename handlers added
- **CLI upload path**: /upload → /api/upload
- **MAX_TS scope**: validateShareCode() reference fix
- **CLI const assignment**: let body instead of const body

---

## [v0.42.0] - 2026-04-09
### Fixed
- Jest test suite: 33 tests now passing

## [v0.41.2] - 2026-04-09
### Added
- Docker multi-stage build, docker-compose.yml, .dockerignore

## [v0.41.1] - 2026-04-09
### Added
- pino structured logging with LOG_LEVEL control
- Error boundary: uncaughtException → gracefulShutdown(1)

## [v0.41.0] - 2026-04-09
### Added
- Jest test framework with 26 unit tests
- SCHEMA v3: rate_limit table + idx_files_filename

## [v0.40.0] - 2026-04-09
### Added
- HTML page extracted as module-level constant
- Search result count display

## [v0.39.0] - 2026-04-09
### Fixed
- Search relevance field: _score → score
- Search empty state: "未找到匹配结果"

## [v0.38.0] - 2026-04-09
### Added
- Tag management system: /api/tags/list, rename, delete, color picker
- Tag management modal in settings panel

## [v0.37.0] - 2026-04-09
### Added
- Mobile-first responsive improvements
- iOS safe-area inset, 16px min font for inputs, touch-action optimization
- Modal class-based show/hide (classList.add('show'))

## [v0.36.2] - 2026-04-09
### Performance
- searchFiles: SQLite LIKE candidate pre-filter (500 max) → JS scoring
- idx_files_filename index

## [v0.36.1] - 2026-04-09
### Security
- Rate limiting for share code password verification (5 attempts / 15min, 5min lockout)
- rate_limit table: key, attempts, locked_until, last_attempt

## [v0.36.0] - 2026-04-09
### Security
- XSS audit: 8 locations fixed (search history, device list, audit log, QR errors, suggestions, share links)

## [v0.35.0] - 2026-04-09
### Security
- CORS origin allowlist (localhost + 192.168.x/10.x/172.16-31.x)
- Share code password scrypt hashing (salt:hash format, backward compatible)

### Fixed
- P0 multi-device sync: addFile fileId in sync_log, sync_push broadcasts real data, file_delete/file_rename handlers

## [v0.34.2] - 2026-04-09
### Fixed
- CLI upload endpoint: /upload → /api/upload

## [v0.34.1] - 2026-04-09
### Fixed
- MAX_TS scope in validateShareCode()
- CLI const body assignment
- CLI list endpoint path
