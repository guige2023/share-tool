# ShareTool 开发计划

## 背景与目标

产品定位：**跨设备剪贴板同步 + 文件自动传送**，覆盖 Win/Mac（真正自动同步）+ iOS/Android 网页（扫码即用、半自动剪贴板）。

目标架构分三层：
- **Core Server**：`sharetool` Go 单二进制，负责设备发现、传输、历史、Web UI、API
- **Native Agent**：macOS/Windows 后台托盘，负责系统剪贴板监听、写入、通知、开机启动
- **Mobile Web/PWA**：iOS/Android 免安装入口，负责扫码、文件上传下载、手动剪贴板、分享入口

---

## 第一阶段：核心同步修复（P0）

### P0-1：mDNS 设备发现 — peers 注册修复

**问题**：`main.go:54` 的 mDNS callback 调 `server.RegisterPeer()`，但 `server.peers` map 的实际注册逻辑需确认；更重要的是，只有收到 SRV record 才触发 callback，但 query 端也需要能解析 PTR 并跟进查询。

**修复文件**：`go/internal/discovery/mdns.go`、`go/internal/server/peers_api.go`、`go/main.go`

**改动**：
1. `mdns.go` 的 `sendQuery()` 发送 PTR query，解析 response 中的 instance name，再发送 SRV+TXT query 获取 port 和 name
2. 收到 SRV record 时，构造完整 peer info 并调用 callback（已有）
3. `main.go` 的 callback 中用 `server.RegisterPeer(ip, port, name)` 注册，确保 peers map 正确写入
4. 添加 `handlePeerRegister` API endpoint（POST `/api/peers`）支持手动注册备用
5. 添加定期清理 stale peers（超过 2 分钟未更新的 peers 删除）

**验证**：两台机器运行 server，通过 mDNS 互相发现，`GET /api/peers` 能看到对方。

---

### P0-2：剪贴板转发回包计数正确性

**问题**：`clipboard_api.go:277` 的 `go wg.Wait()` 在 `forwarded` 统计前，理论上已正确，但发现端对端 forward 成功率极低时需要确认不是 waitgroup 并发 bug。

**代码检查结果**：实际上代码结构正确，`wg.Wait()` 在 `json.NewEncoder(w).Encode` 之前调用。但 Reviewer 指出的可能是：当 peers 为空时，`peerList` 是空 slice，`for` 循环不会启动，`wg.Wait()` 立即返回，`forwarded = 0` —— 这其实是正确的行为，sender 会收到 `forwarded: 0`，但这不代表错误。

**真正的问题**：需要确认当所有 peer 都失败时返回的 `Forwarded` 计数是否准确（应该为 0 但 success 仍为 true）。

**验证**：添加 `/api/clipboard/history` endpoint，查看 entry 是否正确存储和转发。

---

### P0-3：图片/文件 Blob URL 跨设备可访问性

**问题（核心 bug）**：`handleClipboardPost` 保存大图片为 blob，设置 `entry.BlobURL = "/api/blobs?id=xxx"`（相对路径），`forwardClipboardToPeer` 把这个相对 URL 随 payload 发送给 peer。Peer 收到后在自己的 server 上请求 `/api/blobs?id=xxx`，但 blob 存在源 server 上，导致 404。

**修复文件**：`go/internal/server/clipboard_api.go`

**改动**：
1. `forwardClipboardToPeer` 构造**完整 URL**：`fmt.Sprintf("http://%s:%d% s", peer.IP, peer.Port, entry.BlobURL)` → 发送的是 `http://192.168.1.x:18793/api/blobs?id=xxx`
2. 但更好的方案（长远）：blob 不走相对 URL，直接把 blob data 作为 multipart 或 base64 嵌入 forwarded payload（避免跨 server HTTP 请求）
3. 小图片（<512KB）：`entry.Text = base64`，直接随 payload 发送，不需要额外 fetch
4. `handleClipboardReceive` 中 `req.BlobURL` 指向源 server URL，直接 fetch 即可（已有逻辑，需要验证）

**验证**：从 Mac 发送图片到 Windows，Windows 端能正确显示图片。

---

### P0-4：Files 类型 — 统一协议 + 实际文件上传

**问题**：Windows `ClipboardService.cs` 把文件剪贴板编码为换行符分隔的文件名字符串，服务端没有实际文件上传，peer 收到的是无意义的本地路径列表。

**修复文件**：`go/internal/server/clipboard_api.go`、`app/ShareTool/ClipboardSync/ClipboardService.cs`

**改动**：
1. 统一 `FileMeta` 结构：`name`、`size`、`sha256`、`blob_url`、`mime`
2. Windows/macOS 客户端在检测到文件剪贴板时，先将文件上传到 `POST /api/uploads` 获取 `blob_id`，再将 `FileMeta[]` 随 clipboard 一起发送
3. `forwardClipboardToPeer` 携带 `entry.Files`（包含 `blob_url`）转发给 peer
4. Peer 收到后从源 server 下载各文件的 blob

**验证**：从 Mac 复制文件到剪贴板，Windows 能收到并下载该文件。

---

## 第二阶段：自动同步机制（P1）

### P1-1：桌面端剪贴板变更监听（替代轮询）

**问题**：Windows `ClipboardService.cs` 每 2 秒轮询 `/api/clipboard/latest`，macOS Swift 也是轮询。应该监听系统剪贴板变更事件。

**Windows 改动**：`ClipboardService.cs`
- 用 `AddClipboardFormatListener` Win32 API 监听剪贴板变更（WM_CLIPBOARDUPDATE）
- 检测到变更后，立即 `POST /api/clipboard` 发送最新内容
- 保留轮询作为 fallback（当监听失败时）

**macOS 改动**：`ClipboardService.swift`
- 用 `NSPasteboard.changeCount` 轮询（但降低频率到 5 秒），或用 `CGEventTap` 监听 pasteboard 变更
- 更好的方案：macOS 没有直接的剪贴板变更通知 API，需要靠轮询

**Server 端改动**：
- 添加 WebSocket 或 SSE 推送：`GET /api/clipboard/stream` 返回 SSE，server 有新 clipboard entry 时主动推送
- 桌面端优先用 SSE 接收，失败则降级到轮询

**文件**：`app/ShareTool/ClipboardSync/ClipboardService.cs`、`app/ShareTool/ClipboardSync/TrayAppContext.cs`（或对应 macOS 文件）

---

### P1-2：Loop Prevention 增强

**问题**：当前 `handleClipboardReceive` 有 basic loop prevention（基于 `entry_id` 和 2 秒时间窗口），但不够严格：peer A 收到后写入本地剪贴板，macOS 剪贴板监听检测到变更又发回 server，server 又 forward 给所有 peer（包括 A），A 会收到自己的 entry。

**修复**：
1. `ClipboardEntry` 已有 `DeviceID` 字段，收到时检查 `DeviceID == instanceName` 直接 skip
2. `lastWrittenEntry` 在写入本地剪贴板后更新，2 秒内收到相同 `entry_id` 的来自其他 peer 的 entry 也 skip
3. 客户端在收到 `DeviceID == 自己` 的推送时不写入系统剪贴板

---

### P1-3：桌面端模式开关

添加 UI 设置（托盘菜单或 Settings JSON）：
- `auto_sync_text`: true/false
- `auto_sync_image`: true/false
- `auto_sync_files`: true/false
- `send_hotkey`: 快捷键触发发送
- `receive_confirm`: 收到后是否弹出确认

---

## 第三阶段：文件极速传输（P1）

### P1-4：严格断点续传

**问题**：`file_api.go:171` 只解析 Content-Range 起点，无总大小校验、无 chunk hash、无 bitmap 记录、无原子 rename。

**新增 Upload Session 机制**：

**新 API**：
```
POST   /api/uploads          创建 upload session，返回 { upload_id, upload_url }
PUT    /api/uploads/:id/chunks/:index  上传单个 chunk，带 x-chunk-sha256 header
GET    /api/uploads/:id/status  查询已收 chunk bitmap + 状态
DELETE /api/uploads/:id       取消 session
```

**服务端改动**（`go/internal/server/upload_api.go`）：
1. `UploadSession` 结构： `{id, filename, total_size, total_chunks, chunk_size, chunks_received map[int]bool, temp_path, created_at}`
2. `PUT /chunks/:index`：验证 `upload_id` session 存在，解析 `Content-Range` 获取 chunk offset 和 size，保存 chunk 到 `uploads/session_id/chunk_N`，记录 bitmap
3. 所有 chunk 收完后，校验 `total_sha256`（客户端在创建 session 时提供），通过后 `os.Rename` 临时目录到最终路径（原子操作）
4. `GET /status`：返回 `{received: [0,2,3], total: 10}`
5. 并发保护：同一 `upload_id` 加锁
6. 清理：启动时删除超过 7 天的 stale sessions

**客户端改动**：
- 文件 >5MB 用 chunked 上传（默认 1MB/chunk），并发 3 个 chunk
- 失败重试 3 次后暂停，用户可手动继续
- 多文件下载用 zip stream（`archive/zip`），不要逐个触发浏览器下载

---

## 第四阶段：移动端体验（P2）

### P2-1：iOS/Android PWA

**产品承诺调整**：
- iOS：打开网页 → 点"粘贴发送"/"复制最新"/"上传照片"/"扫码配对"。**不承诺后台自动剪贴板**（系统限制）
- Android：同上，但可多做一些 Clipboard API（比 iOS 宽松）

**PWA 能力**：
- Web App Manifest：独立图标、standalone 显示
- Service Worker：离线缓存 + 推送通知（需要服务器端配合）
- Web Share Target：接收来自系统分享菜单的文本/文件
- Clipboard API：读写剪贴板（需要用户手势）

**扫码配对**：Web 端用 `navigator.mediaDevices.getUserMedia` 打开摄像头，扫描服务器 Web UI 上显示的 QR 码（含 `device_id`、`server_ip:port`、`peer_token`）。

**路由变更**：
- `/` → 移动端优化的 Web UI（设备列表 + 快捷操作）
- `/web` → 桌面端 Web UI（当前页面）

---

### P2-2：移除 Node.js 旧实现

**问题**：根目录 `node/` 和 `routes/` 包含旧实现，与 Go 服务重复。

**操作**：
1. 确认 `node/` 下无仍在使用的功能（文件上传？WebSocket？历史？）
2. 确认 Go 服务已完整覆盖 Node 实现的 API
3. 将 `node/` 重命名为 `node-legacy/` 或直接删除
4. 更新 README 说明：Go 为单一服务端

---

## 第五阶段：HTTPS 与证书（P2）

### P2-3：自签证书问题

**问题**：`main.go:129` 使用自签 TLS，iOS/Android 浏览器强警告。

**方案选择**：
- **方案 A（推荐）**：局域网工具不用 HTTPS，客户端用 `http://` 直连。在 Web UI 页面显示"仅在信任的网络使用"提示。
- **方案 B**：用 `mkcert` 生成由本地 CA 签发的证书，首次使用时客户端安装 CA 根证书。
- **方案 C**：Let's Encrypt + 域名（需要公网 IP + 域名，超出局域网工具范畴）

**采用方案 A**，并明确产品文档说明：
- 默认 HTTP，适合家庭/办公室局域网
- TLS 选项留给需要外网中转的用户手动配置

---

## 技术债务清理（P1）

### TD-1：Windows 编译警告

当前 CI 警告：
```
warning CS4014: Because this call is not awaited...
warning CS0169: The field '_hwnd' is never used
warning CS0414: The field '_clipboardListenerActive' is assigned but its value is never used
warning CA2024: Do not use 'reader.EndOfStream' in an async method
```

**修复**：
- `ClipboardService.cs:110`：加 `await` 或 `_ =` 显式忽略
- `ClipboardService.cs:33`：移除未使用的 `_hwnd` 字段
- `ClipboardService.cs:35`：移除或使用 `_clipboardListenerActive`
- `ClipboardService.cs:203`：避免在 async 方法中使用 `reader.EndOfStream`

---

## 实施顺序与依赖关系

```
第一阶段（P0）— 核心同步修复
├─ P0-1: mDNS peers 注册（基础依赖）
├─ P0-2: 转发回包计数（无依赖）
├─ P0-3: Blob URL 跨设备可访问（无依赖）
└─ P0-4: Files 统一协议（依赖 P0-3 的 blob 基础设施）

第二阶段（P1）— 自动同步
├─ P1-1: 桌面端剪贴板监听（依赖 P0-1、P0-3）
├─ P1-2: Loop Prevention 增强（依赖 P0-3）
├─ P1-3: 模式开关（无依赖）
└─ P1-4: 严格断点续传（无依赖，可独立做）

第三阶段（P2）— 移动端
├─ P2-1: iOS/Android PWA（依赖 P0-1、P0-3、P0-4、P1-1）
└─ P2-2: 移除 Node 旧实现（无依赖，确认后执行）

技术债务
└─ TD-1: Windows 编译警告（无依赖，随时可做）
```

---

## 优先修复推荐顺序（基于 Reviewer 建议）

1. **P0-3**（Blob URL）+ **P0-1**（mDNS peers）是跨设备同步的前提，先做这两个
2. **P0-4**（Files 协议）依赖 P0-3 的 blob 基础设施
3. **P1-4**（断点续传）可独立做，不影响现有流程
4. **TD-1**（编译警告）CI 一直报，容易修
5. **P1-1**（剪贴板监听）需要较大的客户端改动，放后面

---

## 当前 CI 状态

- `build-go` ✓
- `build-macos-app` ✓
- `build-windows-app` ✓（已修复 `ShareToolEmbedded.exe` 条件嵌入）
- 待修警告：Windows CS4014/CS0169/CS0414/CA2024（TD-1）
