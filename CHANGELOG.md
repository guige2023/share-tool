# Changelog

All notable changes to ShareTool will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [v2.87] - 2026-04-10

### Added
- **Image lightbox prev/next navigation**: Arrow keys (←/→) navigate between images in lightbox mode; prev/next buttons visible when multiple images

## [v2.86] - 2026-04-10

### Added
- **'m' keyboard shortcut**: Opens quick text note / share dialog
- **Keyboard shortcuts help modal**: Complete list of all shortcuts displayed on `?` key

### Fixed
- **Remove duplicate getFileIcon**: Code cleanup, reduced redundancy

## [v2.85] - 2026-04-10

### Fixed
- **Dark mode video background**: Use `--bg-modal` CSS variable instead of hardcoded black

## [v2.84] - 2026-04-10

### Added
- **PWA install prompt**: `beforeinstallprompt` event banner, "安装应用" button in settings
- **PWA offline file cache**: GET /api/file/ /s/ /d/ routes cached via CacheStorage
- **CLI `recent` command**: `recent [n]` shows recently modified files

### Fixed
- **PWA install button dark mode**: Use `var(--text-inverse)` instead of hardcoded `#fff`

## [v2.82-2.83] - 2026-04-10

### Added
- **PWA manifest.json**: Standalone display mode, icon-192.png / icon-512.png, service worker
- **PWA offline support**: File content cached via CacheStorage API
- **Service stability hardening**: Error handlers on HTTP/HTTPS servers, WebSocket server, heartbeat, sync scheduler, hourly/daily cleanup timers

## [v2.80-2.81] - 2026-04-10

### Added
- **Dark mode deep polish**: Modal backdrop, QR modal overlay, toast, filter-tab all use CSS variables

### Fixed
- **Hardcoded `#fff` colors**: 5 locations changed to `var(--text-inverse)` for dark mode compatibility

## [v2.78-2.79] - 2026-04-10

### Added
- **HTTPS certificate auto-renewal**: 30-day threshold, daily scheduled check, `/api/admin/renew-cert` endpoint
- **HTTPS status UI**: Days-until-expiry display in settings, renewal button (shown when ≤30 days)
- **CLI `rename` command**: `rename <old> <new>`
- **CLI `list-tags` command**: Lists all unique tags from server files

## [v2.77] - 2026-04-10

### Added
- **Markdown preview enhancements**: Auto-generated TOC (h1/h2/h3), click-to-scroll; code block copy button (hover, 2s feedback); task list checkboxes with accent-color; external link image interaction (cursor:pointer + hover opacity)

## [v2.75-2.76] - 2026-04-10

### Added
- **Search UX improvements**: Direct tag search from suggestions (shows all files with tag if no match); deduplicated suggestions; "未找到结果" empty state; tag bar updates after search
- **HTTPS cert days display**: Shows days remaining with warning color when ≤30

### Fixed
- **`refreshToken` bugfix**: AUTH_TOKEN assignment was breaking the reference

## [v2.74] - 2026-04-10

### Added
- **Batch tag operations UI**: `batchAddTag` uses single `/api/file-tags/batch` call instead of N API calls
- **Tag filter bar**: Clear button (`clearTagFilter()`), manage entry (⚙ → showTagManager)

## [v2.72-2.73] - 2026-04-10

### Added
- **Code syntax highlighting**: `hljs.highlightAll()` after Markdown preview; github-dark theme; light mode color overrides
- **Markdown TOC**: Auto-generate from h1/h2/h3, click-to-scroll
- **Code block copy button**: Hover reveals copy button, 2s "已复制" feedback

## [v2.70-2.71] - 2026-04-10

### Added
- **Mobile UX improvements**: `viewport-fit=cover` for iOS notch/Dynamic Island; safe-area CSS padding (header/main/container)
- **Long-press to rename**: 500ms hold without movement triggers `startInlineRename`; swipe cancels hold timer

## [v2.68-2.69] - 2026-04-10

### Added
- **Inline audio/video player**: `loadMediaPlayer()` lazy-loads players into file list; supports mp3/wav/ogg/aac/flac/m4a/mp4/webm/avi/mov/mkv
- **Service stability**: Error handlers on HTTP/HTTPS/WS servers, all schedulers wrapped in try-catch

## [v2.66-2.67] - 2026-04-10

### Added
- **Keyboard shortcuts**: j/k navigate, x toggle select, c copy link, n upload, Delete remove, Esc blur input, ? help
- **Audio/video/PDF modal routing**: Click opens full-screen modal
- **File preview modal routing**: handleFileItemClick routes to openMediaModal/openPdfModal appropriately

## [v2.64-2.65] - 2026-04-10

### Added
- **PWA manifest**: icon-192.png/icon-512.png, standalone display mode, installable
- **Service worker (inline)**: All logic in HTML, no separate sw.js needed

### Fixed
- **better-sqlite3 rebuild**: Compatible with Node v25.9

## [v2.62-2.63] - 2026-04-10

### Added
- **Batch tag CLI**: `batch-tag add|remove|set <tag> [filenames...]`
- **Enhanced tag API**: `PUT /api/file-tags/:fn?action=add|remove|set`
- **Batch tag API**: `PUT /api/file-tags/batch`

### Tests
- **Jest test suite**: 36 tests covering db layer, 41% coverage

## [v2.60-2.61] - 2026-04-10

### Added
- **Token refresh UI**: `updateTokenDisplay()` shows expiry countdown, warning color when <7 days
- **Drag-and-drop upload fix**: Pass files directly to `uploadFiles()` (was broken before)

## [v2.57-2.59] - 2026-04-10

### Added
- **Code syntax highlighting preview**: highlight.js, 40+ languages, github-dark theme
- **'m' shortcut**: Quick text note / share dialog
- **Token display**: Expiry countdown + warning color

## [v2.54-2.56] - 2026-04-10

### Added
- **Batch operations bar**: Download + Tag + Copy + Delete + Cancel all inline
- **DOMPurify sanitization**: Markdown rendering sanitized, prevents malicious content XSS
- **MCP server auto-token**: Auto-reads token from config file

### Fixed
- **CJS/ESM conflict**: Removed `'type': 'module'` from package.json

## [v2.50-2.53] - 2026-04-10

### Added
- **File preview modal**: Click any file to open full preview modal
- **Inline file rename**: Double-click filename to edit in place
- **Upload queue retry**: Individual retry + retry-all for failed uploads
- **Keyboard shortcuts**: `/` focuses search, Enter submits
- **Upload area drag-over visual feedback**: Drag-over styling on drop zone
- **Tag API fix**: Missing endpoints in routes/api.js implemented

## [v2.45-2.49] - 2026-04-09

### Added
- **Virtual folder navigation**: Navigate via filename paths in the UI
- **Sort preference persistence**: Sort order saved to localStorage
- **Export command (CLI)**: `export [dir]` downloads all server files locally
- **Batch rename API**: `POST /api/file-rename-batch`
- **Tag color picker**: Inline color editing in tag manager

## [v2.40-2.44] - 2026-04-09

### Added
- **Markdown preview modal**: `marked.js` renders Markdown content
- **HTTPS auto-renewal**: 30-day threshold, daily check at startup, CLI `renew-cert`
- **Search enhancements**: Cmd+K focus, keyboard navigation in results, empty-state recent searches
- **Mobile adaptation**: iOS zoom prevention, touch target sizing, safe-area insets

## [v2.26-2.39] - 2026-04-09

### Added
- **Dark mode**: Full dark theme with CSS variable system
- **Mobile dark mode polish**: Inline player backgrounds, modal styling
- **File list sort API**: `GET /api/list?sort=created_at&order=desc&limit=100&offset=0`
- **CLI `config` command**: `share-tool config get|set|unset|reset`
- **Command history tracking**: `history` command in CLI

## [v2.00-2.25] - 2026-04-09

### Added
- **MCP Server**: `mcp-server.mjs` for AI agent integration
- **Structured logging (pino)**: JSON logger with TTY color, LOG_LEVEL env var
- **Docker support**: Dockerfile (node:22-alpine) + docker-compose.yml with healthcheck
- **Error boundaries**: Global uncaughtException/unhandledRejection with gracefulShutdown
- **Jest test suite**: 33+ unit tests covering files, tokens, share links, audit logs, rate limiting, password hashing

---

## [v1.0.0] - 2026-04-09

### Architecture
- **Routes module split**: `server.js` refactored into `routes/` directory (api.js, files.js, share.js)
- **Server version**: v2.0.0

### Security
- **CORS fix**: Origin allowlist instead of wildcard (`*`), supports localhost/192.168.x/10.x
- **Share code password hashing**: scrypt hash storage (salt:hash format), backward compatible with plaintext
- **XSS audit**: escapeHtml() applied to all innerHTML injections (8 locations)
- **Rate limiting**: 5 attempts / 15-minute window, 5-minute lockout for share code password brute-force protection

### Performance
- **Search optimization**: SQLite LIKE pre-filter (max 500 candidates) before JS scoring/sort, idx_files_filename index
- **Tag filter**: Direct SQLite LIKE without JS overhead

### P0 Multi-Device Sync
- addFile now records real fileId in sync_log (was null)
- sync_push broadcasts actual file data to other devices
- file_delete and file_rename WebSocket message handlers added

### CLI
- upload, list, delete, share, copy, rename, search, token, config, export, batch-delete, batch-tag, recent, list-tags, history, renew-cert commands
