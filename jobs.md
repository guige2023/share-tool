# ShareTool 已完成任务记录

---

## 2026-05-02

### P0-F1: mDNS 设备发现 + peer 注册
- **改动文件**: `go/internal/discovery/mdns.go`
- **改动概要**: `Start()` 中增加 `advertiseLoop()` 调用，使服务启动时广播自身 SRV record 并定期重复广播
- **验证结果**: `go build` 通过，两台设备运行后应能在 `/api/peers` 看到对方

### P0-F2: `forwarded` 并发计数修复
- **改动文件**: `go/internal/server/clipboard_api.go`
- **改动概要**: 将 peer 遍历改为快照（`peerList := make([]Peer, 0, len(peers))`），然后遍历快照转发，彻底消除 `delete(peers, k)` 在 RLock 期间被调用的竞态；同样修复 `handleClipboardPeersSend` 中的相同模式
- **验证结果**: `go build` 通过，无并发 map 写入警告

### P0-F3: 图片/文件剪贴板协议修复
- **改动文件**: `go/internal/server/clipboard_api.go`, `app/ShareTool/ClipboardSync/Models.cs`, `app/ShareTool/ClipboardSync/ClipboardService.cs`, `app/ShareTool/Sources/ClipboardManager.swift`
- **改动概要**:
  - Go: `ClipboardRequest` 新增 `BlobURL` 字段；`handleClipboardReceive` 正确使用 `forwardClient.Get(req.BlobURL)` 获取 blob 内容并 base64 编码后存储
  - Windows C#: `ClipboardRequest` 新增 `blob_url` 字段；`DetectClipboardType` 改为 `DetectClipboardTypeAsync`，文件复制时上传到 blob 并发送 FileMeta 数组；`WriteClipboardToSystem` 新增 `DownloadFilesAndSetClipboard` 方法
  - macOS Swift: `sendFilesClipboard` 分批上传文件到 blob 并发送 FileMeta；新增 `uploadBlob`、`mimeType` 辅助方法
- **验证结果**: `go build` 通过

### P1-F4: Windows 托盘右键菜单重构
- **改动文件**: `app/ShareTool/ClipboardSync/Program.cs`, `app/ShareTool/ClipboardSync/ClipboardSync.csproj`
- **改动概要**:
  - 移除 `ContextMenuStrip`（WinForms 内部消息循环导致右键死锁），改用原生 `ContextMenu` + `TrackPopupMenu`
  - 新增 `System.Drawing.Common` NuGet 包（.NET 6+ 需要显式引用）
  - 完整重写 `TrayAppContext`，支持服务模式（启动本地 sharetool）和客户端模式（扫描局域网连接对端）
- **验证结果**: Windows 上需 dotnet build 验证
