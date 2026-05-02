# ShareTool 修复与开发计划

基于审查意见制定，目标是实现"快速自动跨设备分享剪贴板 + 文件自动传送 + iOS 网页/Android/Win/Mac 全覆盖"。

---

## 第一阶段：核心同步修复（P0）

### 1.1 mDNS 设备发现 → peers 注册
**文件**: `go/internal/discovery/mdns.go:132`

**问题**: 只发 mDNS query，几乎没有实现标准 service advertise/response；发现 peer 只 log，没有注册进 `server.peers`。

**修复**:
- 实现标准 mDNS/Bonjour service advertise：注册 `_sharetool._tcp` 服务，广播本机 device_id、port、hostname
- 实现 service response handler：解析对端回应，提取 device_id 和地址
- 发现 peer 后自动写入 `server.peers` map（key = device_id）
- 定期刷新：每 30s 重播广告，每 60s 重新查询

**验收**: 两台同局域网设备运行后，`/api/devices` 返回对方；`server.peers` 非空。

### 1.2 剪贴板转发回包计数正确
**文件**: `go/internal/server/clipboard_api.go:244` + `:277`

**问题**: goroutine 转发后 `go wg.Wait()` 不等待完成就返回，`forwarded` 常常是 0，发送端误判。

**修复**:
- `wg.Wait()` 去掉 `go` 前缀，主 goroutine 等待所有转发完成
- 收集每个 peer 的转发结果（成功/失败/超时）
- 返回准确的 `forwarded` 设备列表和每个设备的 HTTP 状态码

**验收**: `POST /api/clipboard` 响应 JSON 中 `forwarded` 字段与实际成功转发数一致。

### 1.3 统一剪贴板协议（图片/文件）
**文件**: `go/internal/server/clipboard_api.go:337`

**问题**:
- 发送图片时 base64 存磁盘并清空 `entry.Content`，再转发空 content
- 接收端 `ClipboardRequest` 没有 `file_path` 字段，却把 `req.Content` 当 file path
- 结果对端既拿不到数据，也拿不到 URL

**修复**:
- 统一协议字段：`entry_id`、`device_id`、`type`、`mime`、`text`、`files[]`（文件元数据列表）、`blob_url`、`sha256`
- 图片/文件不塞 JSON base64 转发，改成：
  1. 先调用 `POST /api/uploads` 上传 blob（返回 `upload_id`、`blob_url`）
  2. 把 `blob_url` + metadata 推进对端
  3. 对端按 URL 拉取
- 接收端 `ClipboardRequest` 增加 `blob_url` 字段

**验收**: 发送一张图片到另一台设备，对端收到可下载的原始图片文件。

### 1.4 files 类型真正传文件
**文件**: `ClipboardService.cs:217` + Swift 端

**问题**: Windows 把文件剪贴板编码成换行字符串，macOS 用 JSON 文件名，协议不统一，没有上传内容。

**修复**:
- 统一 `files[]` 字段结构：`{name, size, mime, sha256, blob_url}`
- 发送时：检测到文件列表 → 先上传每个文件到 `/api/uploads` → 得到 blob_url → 构建 `files[]` metadata → 发送剪贴板消息
- 接收时：解析 `files[]` → 展示文件名列表 → 用户点击后通过 `blob_url` 下载
- 不再依赖本地路径

**验收**: 从一台设备发送一个 PDF 文件到另一台，对方收到原始 PDF。

---

## 第二阶段：桌面端"自动"同步

### 2.1 剪贴板变更监听（替代轮询）
**文件**: `ClipboardService.cs` + Swift `ClipboardManager.swift`

**问题**: Windows 每 2s 轮询 `/api/clipboard/latest`，macOS 也轮询，没有 WebSocket/SSE 推送。

**修复**:
- **Windows**: 用 `AddClipboardFormatListener` API 监听系统剪贴板变更（change count），变更时立即发送
- **macOS**: 用 `NSPasteboard.changeCount` 监听变更，检测到变化立即发送
- **服务端**: 维护每个设备的 `last_change_count`，变更才推送，避免空轮询
- 轮询作为 fallback：每 30s 无推送时轮询一次

**验收**: 在 A 电脑复制，B 电脑 3s 内自动收到（无手动刷新）。

### 2.2 WebSocket/SSE 推送（替代纯轮询）
**文件**: `go/internal/server/clipboard_api.go` + `ClipboardManager.swift`

**修复**:
- 新增 `GET /api/events` SSE endpoint：打开后等待服务端事件流
- 事件类型：`clipboard_update`、`device_online`、`device_offline`、`file_ready`
- 客户端收到 `clipboard_update` 后立即拉取最新内容写入本地剪贴板
- 断线重连：指数退避（1s, 2s, 4s, max 30s）

**验收**: 服务端推送后，客户端 1s 内收到新剪贴板内容。

### 2.3 模式开关
**文件**: Web UI + macOS UI

**功能**:
- `auto_sync_text`: 自动同步文本（开/关）
- `auto_sync_images`: 自动同步图片（开/关）
- `auto_sync_files`: 自动同步文件（开/关）
- `receive_confirm`: 接收前确认（开/关）
- `hotkey_only`: 仅快捷键发送（开/关）

**验收**: Web UI 展示开关，可实时切换。

### 2.4 Loop Prevention
**问题**: 同一 `entry_id` 不重复写入，写入系统剪贴板后短时间内不再回传。

**修复**:
- 每个 entry 带 `entry_id`（设备 + 时间戳 UUID）
- 写入本地剪贴板后，标记 `last_written_id`，收到相同 `entry_id` 跳过
- 写入后 2s 内不回传（防回音）

---

## 第三阶段：文件极速传输

### 3.1 Upload Session + Chunked Upload
**文件**: `go/internal/server/file_api.go:171`

**问题**: 只解析 Content-Range 起点，没有 upload session、chunk 校验、总大小校验、并发保护、断点查询、临时文件原子 rename。

**修复**:
- `POST /api/uploads` 创建 upload session，返回 `upload_id`
- `PUT /api/uploads/:id/chunks/:index` 上传单个 chunk（带 `Content-Range: bytes {start}-{end}/{total}`）
- 每个 chunk 带 hash（`X-Chunk-SHA256`），服务端记录已接收 bitmap
- `GET /api/uploads/:id/status` 查询上传状态（已收 chunks bitmap，可恢复）
- chunk 大小：512KB，上传并发数：3-6
- 完成后校验总 hash，原子 rename 临时文件

**验收**: 上传 100MB 文件，中断后从断点继续，最终文件 SHA256 一致。

### 3.2 Web UI 多文件并发 + 续传
**文件**: `go/internal/server/web/`

**修复**:
- 上传页面并发 3-6 个 chunk
- 展示上传进度条、速度、剩余时间
- 暂停/继续按钮
- 失败自动重试（最多 3 次）
- 多文件下载用 zip stream（不逐个触发浏览器下载）

### 3.3 临时文件清理
**修复**:
- 未完成的 upload session：7 天后清理
- `PUT /api/uploads/:id/abort` 立即删除临时文件

---

## 第四阶段：移动端体验

### 4.1 iOS Web / PWA
**问题**: iOS Safari/PWA 不能后台读取系统剪贴板，不能无用户手势自动写剪贴板。

**定位**: 扫码即用、文件快速传、文本/剪贴板半自动、一键复制/粘贴。

**功能**:
- PWA 安装入口（manifest.json + Service Worker）
- Share Sheet 入口："粘贴并发送"
- 扫码配对（扫描服务器上的二维码）
- "复制最新"：拉取最新剪贴板内容，一键复制
- "上传照片/文件"：选择文件上传到服务器，生成下载链接
- 手动"粘贴发送"：读取本地剪贴板内容，手动发送给其他设备

**不做承诺**: 后台自动剪贴板同步（iOS 系统限制）。

### 4.2 Android Web / PWA
**定位**: 同 iOS，但比 iOS 多一些 Clipboard API 能力。

**额外能力**（Android 13+）:
- 可在用户授权后读写系统剪贴板
- Web Share Target：接收来自其他 App 的分享内容
- 后台能力仍受 Android 10+ 限制，App 需在前台

**不做承诺**: 真正后台自动剪贴板同步需要原生 App。

### 4.3 HTTPS / 证书
**文件**: `go/main.go:129`

**问题**: 自签证书，iOS/Android 强警告，PWA/Clipboard API/Service Worker/mDNS 能力被影响。

**修复**:
- 局域网工具：提供安装 CA 证书的指引页面（首次访问时弹出）
- 长期方案：考虑 Let's Encrypt（需要 443 端口或 DNS 验证）
- 短期方案：在 Web UI 显示"信任此设备"按钮，引导用户安装证书

---

## 第五阶段：架构统一

### 5.1 移除 Node.js 旧实现
**文件**: 根目录 `server.js`, `routes/*`, `package.json`

**现状**: Node 服务和 Go 服务功能重复，协议不一致。

**决策**: Go 为核心，Node 旧实现归档为 `legacy-node/` 目录。

**操作**:
1. 创建 `legacy-node/` 目录
2. 移动 `server.js`, `routes/`, `package.json`, `node_modules/`（如存在）到 `legacy-node/`
3. 更新 `.gitignore`，排除 `legacy-node/node_modules/`
4. 更新 README 说明

**验收**: 根目录不再有 `server.js`，`go/` 为唯一后端。

---

## 文件清单

| 文件 | 优先级 | 负责人 | 阶段 |
|------|--------|--------|------|
| `go/internal/discovery/mdns.go` | P0 | Go | P1 |
| `go/internal/server/clipboard_api.go` | P0 | Go | P1 |
| `go/internal/server/file_api.go` | P1 | Go | P1 |
| `ClipboardService.cs` | P0 | C# | P1 |
| `ClipboardManager.swift` | P0 | Swift | P1 |
| `go/internal/server/events.go` (新增 SSE) | P1 | Go | P2 |
| Web UI (upload/controls) | P1 | TS/HTML | P2 |
| `go/main.go` (证书) | P2 | Go | P4 |
| `legacy-node/` (归档) | P2 | - | P5 |

---

## 依赖关系

```
P1 (mDNS + clipboard API fix)
  ↓
P2 (SSE push + 桌面端监听)
  ↓
P3 (chunked upload + file transfer)
  ↓
P4 (mobile web/PWA)
  ↓
P5 (archive Node.js)
```

P1 是所有后续阶段的基础，必须先完成。
