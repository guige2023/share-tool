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
  - 完整重写 `TrayAppContext`，支持服务模式和客户端模式
- **验证结果**: Windows 上需 dotnet build 验证

---

## 2026-05-03

### 计划更新: PLAN.md v3 + tasks.md 重构

- **改动文件**: `PLAN.md`, `tasks.md`
- **改动概要**:
  - PLAN.md 升级到 v3，新增 S1/S2/S3 当前阻塞任务章节
  - tasks.md 重构，3 个已完成 P0/P1 问题标记清楚，当前任务独立为 S1-S3
  - 新增 P2-F9（zip stream）和 P3-F10（PWA 入口）待办
  - 清理已完成的 Node.js 旧实现清理记录
- **验证结果**: 文档结构清晰，任务状态明确

### S1-Fix: Windows Timer 轮询健壮性
- **改动文件**: `app/ShareTool/ClipboardSync/ClipboardService.cs`
- **改动概要**:
  - `PollClipboardOnBackground` 中移除不可靠的 `_syncForm.BeginInvoke` UI 线程封送
  - `SendSystemClipboard` 为异步 HTTP 方法，线程安全，直接从 Timer 线程调用
  - 消除 CS4014 fire-and-forget 警告
- **验证结果**: `dotnet build` 通过（0 errors, 8 warnings）

### S2-Fix: 发送通知文案修复
- **改动文件**: `app/ShareTool/ClipboardSync/Program.cs`
- **改动概要**:
  - `OnSent` 通知：`Count == 0` 显示"已发送至服务器"，`Count > 0` 显示"已发送至 N 台设备"
  - 添加 `using System.Threading.Tasks;`
- **验证结果**: `dotnet build` 通过

### S3-Fix: 剪贴板历史启动时加载
- **改动文件**: `app/ShareTool/ClipboardSync/Program.cs`, `app/ShareTool/Sources/StatusBarController.swift`
- **改动概要**:
  - Windows: `StartService()` 中 `InitClipboardService` 后添加 `Task.Delay(3000).ContinueWith(_ => RefreshHistoryAsync())`，等待 Go 服务器完全启动
  - macOS: `setupClipboard()` 中 `startMonitoring()` 后调用 `clipboardManager.loadHistory()`
- **验证结果**: `dotnet build` 通过

### 重新打包
- **改动文件**: `dist/sharetool_darwin_arm64`, `dist/sharetool_windows_amd64.exe`, `dist/ShareTool-windows/ShareToolClipboardSync.exe`
- **改动概要**:
  - Go 服务端：macOS ARM64 + Windows AMD64 新构建
  - Windows C#：自包含 .NET 10 发布（121MB），替换旧框架依赖版本
  - macOS：Swift Package Manager `swift build -c release` 构建 + app bundle + DMG（5.8MB）
- **验证结果**: `go build` + `dotnet publish` + `swift build` 均成功

### macOS Swift 构建修复
- **改动文件**: `app/ShareTool/Sources/StatusBarController.swift`
- **改动概要**:
  - `StatusBarController` extension 未实现 `ClipboardManagerDelegate.didUpdateHistory(_:_:)` 方法
  - SPM 构建失败（xcodebuild 需要 Xcode，但 swift build 不需要）
  - 新增 `didUpdateHistory` 方法：更新本地历史并刷新菜单
- **验证结果**: `swift build -c release` 成功（0 errors, 4 warnings）
