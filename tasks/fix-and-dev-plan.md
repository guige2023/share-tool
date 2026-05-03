# ShareTool 修复与开发计划

基于审查意见制定，目标是实现"快速自动跨设备分享剪贴板 + 文件自动传送 + iOS 网页/Android/Win/Mac 全覆盖"。

---

## 第一阶段：核心同步修复（✅ 已完成）

### 1.1 mDNS 设备发现 → peers 注册 ✅
**文件**: `go/internal/discovery/mdns.go` + `go/main.go` + `go/internal/server/peers_api.go`

**已实现**:
- `main.go:56` mDNS callback 调用 `server.RegisterPeer(ip, port, name)`
- `peers_api.go:25` `RegisterPeer()` 将 peer 写入 `server.peers` map
- `handlePacket()` 解析 SRV 记录并触发 callback
- 定期刷新：30s 重播广告，60s 重新查询

**验收**: 两台同局域网设备运行后，`/api/peers` 返回对方；`server.peers` 非空。

### 1.2 剪贴板转发回包计数正确 ✅
**文件**: `go/internal/server/clipboard_api.go:287-311`

**已实现**:
- `wg.Wait()` 在主 goroutine 等待，不使用 `go wg.Wait()`
- 每个 goroutine 使用 `defer wg.Done()` 保证计数
- `forwarded` 字段准确返回成功转发数

**验收**: `POST /api/clipboard` 响应 JSON 中 `forwarded` 字段与实际成功转发数一致。

### 1.3 统一剪贴板协议（图片/文件）✅
**文件**: `go/internal/server/clipboard_api.go`

**已实现**:
- `ClipboardRequest` 含 `BlobURL`、`Files[]`、`EntryID` 字段
- 图片/文件通过 `POST /api/blobs` 上传 blob，接收端拉取
- `handleClipboardReceive` 会从 `BlobURL` 拉取内容写入本地剪贴板
- 统一协议字段：`entry_id`、`device_id`、`type`、`mime`、`text`、`files[]`、`blob_url`、`sha256`

**验收**: 发送一张图片到另一台设备，对端收到可下载的原始图片文件。

### 1.4 files 类型真正传文件 ✅
**文件**: `ClipboardService.cs:280-309` + `ClipboardManager.swift:367-426`

**已实现**:
- Windows: 检测文件剪贴板 → 上传每个文件到 `/api/blobs` → 构建 `FileMeta[]` → 发送剪贴板消息
- macOS: 同上，上传到 blob 后通过 `files[]` metadata 发送
- 接收端通过 `blob_url` 下载原始文件，不再依赖本地路径

**验收**: 从一台设备发送一个 PDF 文件到另一台，对方收到原始 PDF。

---

## 第二阶段：桌面端"自动"同步（✅ 已完成）

### 2.1 剪贴板变更监听（替代轮询）✅
**文件**: `ClipboardService.cs:59-96` + `ClipboardManager.swift:144-174`

**已实现**:
- **Windows**: `AddClipboardFormatListener` API，变更时立即发送；fallback 到 2s 轮询
- **macOS**: `NSPasteboard.changeCount` 每 0.3s 检查，变更立即发送
- 轮询仅作 fallback，不再是主路径

**验收**: 在 A 电脑复制，B 电脑 3s 内自动收到（无手动刷新）。

### 2.2 WebSocket/SSE 推送（替代纯轮询）✅
**文件**: `go/internal/server/ws_api.go` + `go/internal/server/clipboard_api.go:727-780`

**已实现**:
- `GET /api/push` SSE endpoint，事件类型：`clipboard`、`ping`
- `BroadcastClipboard` 推送到所有连接的 SSE 客户端
- 断线自动重连（macOS 3s 退避，Windows 同样）
- 25s keep-alive ping

**验收**: 服务端推送后，客户端 1s 内收到新剪贴板内容。

### 2.3 模式开关 ✅
**文件**: `ClipboardService.cs:74-79` + `ClipboardManager.swift:74-79`

**已实现**:
- `SyncSettings`: `autoSend`、`autoSyncText`、`autoSyncImage`、`autoSyncFiles`
- 每个同步方向独立控制

**验收**: Web UI / 客户端可控制各类型同步开关。

### 2.4 Loop Prevention ✅
**文件**: `go/internal/server/clipboard_api.go:388-398` + `ClipboardService.cs:139-152` + `ClipboardManager.swift:218-237`

**已实现**:
- 每个 entry 带 `entry_id`（设备 + 时间戳 UUID）
- 写入本地剪贴板后标记 `lastWrittenEntryID`
- 写入后 2s 内不回传（防回音）
- 相同 `entry_id` 跳过重复写入

---

## 第三阶段：文件极速传输

### 3.1 Upload Session + Chunked Upload ✅ 后端
**文件**: `go/internal/server/upload_api.go`

**已实现**:
- `POST /api/uploads` 创建 upload session，返回 `session_id`
- `PUT /api/uploads/:id/chunks/:index` 上传单个 chunk（带 `X-Chunk-SHA256`）
- `GET /api/uploads/:id/status` 查询已收 chunks bitmap，可恢复
- chunk 大小：2MB
- 完成后校验总 SHA256，原子 rename 临时文件

### 3.2 Web UI 并发上传 + 续传 + zip 下载 ✅
**文件**: `go/internal/server/web/index.html`

**已实现**:
- 并发 3 个 chunk 上传（CONCURRENCY=3）
- 每个 chunk 最多 3 次重试
- 续传支持：先查 `/api/uploads/:id/status` 获取已上传 chunks
- 暂停/继续按钮（设置 cancelled 标志）
- 失败展示错误信息
- 批量多文件 zip stream 下载（`GET /api/blobs/download?ids=...`）

**验收**: 上传 100MB 文件，中断后从断点继续，最终 SHA256 一致。

### 3.3 临时文件清理 ✅
**文件**: `go/internal/server/upload_api.go`

**已实现**:
- `InitUploadCleanup()` 后台 goroutine，每 1 小时检查一次
- 7 天未活动的 active session 清理（删除临时文件）
- 完成的 session 5 分钟后自动从内存移除

**验收**: 后台任务日志显示已清理的 stale sessions 数量。

---

## 第四阶段：移动端体验

### 4.1 iOS/Android PWA + Share Sheet 入口 ✅
**文件**: `go/internal/server/web/manifest.json` + `go/internal/server/web/sw.js` + `go/internal/server/web/index.html`

**已实现**:
- `manifest.json`: `share_target`（接收系统分享）、`file_handlers`
- Service Worker: 离线缓存 + 后台同步上传队列（IndexedDB）
- Web Share Target 处理：检测 URL 参数 `?title=&text=&url=`，显示"来自分享"横幅，一键发送
- PWA 安装入口已配置

**不做承诺**: iOS 后台自动剪贴板同步（系统限制）。

### 4.2 HTTPS 证书引导页 ✅
**文件**: `go/internal/server/server.go` + `go/internal/server/web/cert-guide.html`

**已实现**:
- `GET /cert-guide` 路由（内嵌 HTML 页面）
- Web UI header 添加"🔐证书"链接
- 包含 iOS Safari、Android Chrome、macOS Safari/Chrome、Windows Chrome/Edge 的证书安装步骤

**验收**: 点击 header 的"证书"链接 → 显示各平台安装指南。

---

## 第五阶段：架构统一（✅ 已完成）

### 5.1 移除 Node.js 旧实现 ✅
**状态**: Node.js 旧实现（`server.js`, `routes/`, `package.json`）已在之前 merge 时删除。`go/` 为唯一后端。

**验收**: 根目录不再有 `server.js`，`go/` 为唯一后端。

---

## 文件清单

| 文件 | 状态 | 阶段 |
|------|------|------|
| `go/internal/discovery/mdns.go` | ✅ 已实现 | P1 |
| `go/internal/server/clipboard_api.go` | ✅ 已实现 | P1 |
| `go/internal/server/peers_api.go` | ✅ 已实现 | P1 |
| `ClipboardService.cs` | ✅ 已实现 | P1/P2 |
| `ClipboardManager.swift` | ✅ 已实现 | P1/P2 |
| `go/internal/server/ws_api.go` | ✅ 已实现 | P2 |
| `go/internal/server/upload_api.go` | ✅ 已实现（P3.1 + P3.3） | P3 |
| `go/internal/server/server.go` | ✅ 已实现（P4.2） | P4 |
| `go/internal/server/web/index.html` | ✅ 已实现（P3.2 + P4.1） | P3/P4 |
| `go/internal/server/web/manifest.json` | ✅ 已实现（P4.1） | P4 |
| `go/internal/server/web/sw.js` | ✅ 已实现（P4.1） | P4 |
| `go/internal/server/web/cert-guide.html` | ✅ 新增（P4.2） | P4 |
| `legacy-node/`（归档）| ✅ Node.js 旧实现已删除 | P5 |

---

## 依赖关系（已完成）

```
✅ P1 (mDNS + clipboard API)      ─── 已完成
✅ P2 (SSE push + 桌面端监听)     ─── 已完成
✅ P3 (chunked upload + file transfer) ─── 已完成
✅ P4 (mobile web/PWA + 证书)    ─── 已完成
✅ P5 (archive Node.js)          ─── 已完成
```

所有阶段均已完成。
