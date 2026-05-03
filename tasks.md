# ShareTool 开发任务

## 当前进行中

### S1-win-autosend: Windows 自动发送 — Timer 替代 HiddenClipboardWindow

**问题**: `HiddenClipboardWindow` 的 `WM_CLIPBOARDUPDATE` 消息机制在托盘 App 场景下失效（可能因无消息循环或权限问题），导致剪贴板变更无法被事件驱动捕获。

**修复文件**: `app/ShareTool/ClipboardSync/ClipboardService.cs`

**方案**: 保留 `HiddenClipboardWindow` + `AddClipboardFormatListener` 作为主路径，但对其做健壮性保护：若 `AddClipboardFormatListener` 返回 `false`（注册失败），或窗口消息在 5 秒内未收到任何 `WM_CLIPBOARDUPDATE`，则自动降级到 `Timer` + `GetClipboardSequenceNumber` 轮询（间隔 500ms）。

**验收**: 在 Windows 上复制任意内容，1 秒内托盘 App 自动发送到服务器，托盘菜单历史同步更新。

---

### S2-win-sent-count: 发送通知不显示"设备 0 个"

**问题**: `OnSent?.Invoke(this, (result?.forwarded ?? 0, null))` 当 peers 为空时 `forwarded = 0`，但通知仍显示"已发送设备 0 个"，体验误导。

**修复文件**: `app/ShareTool/ClipboardSync/ClipboardService.cs` (L293)

**方案**: 修改 `OnSent` 触发逻辑——当 `forwarded == 0` 时，第二个参数改为 `"sent"`（表示仅发送到服务器，未跨设备）；`forwarded > 0` 时才传 `null` 并让调用方显示实际数量。

或更简单：修改 `Program.cs` 中 `OnSent` 处理逻辑，当 `Count == 0` 时显示"已发送至服务器"，`Count > 0` 时显示"已发送至 N 台设备"。

**验收**: 无 peers 时托盘通知显示"剪贴板已发送"或"已发送至服务器"，不显示"0"。

---

### S3-history-empty: Windows 剪贴板历史为空

**问题**: `Program.cs:286` 调用 `GET /api/clipboard` (POST 端点)，URL 错误导致历史获取失败。

**修复文件**: `app/ShareTool/ClipboardSync/Program.cs` (L286)

```csharp
// 旧
var resp = await client.GetAsync($"{url}/api/clipboard");

// 新
var resp = await client.GetAsync($"{url}/api/clipboard/history");
```

同时验证 Go 端 `GET /api/clipboard/history` 是否返回正确的 `ClipboardHistoryResponse` 结构。

**验收**: Windows 托盘菜单"剪贴板历史"能显示最近 15 条记录。

---

## 全部问题（已修复）

### P0 核心同步问题

- [x] **mdns.go: advertiseLoop() 未被调用** — Start() 中调用了 d.advertiseLoop()
- [x] **clipboard_api.go: peers map 并发修改** — peer snapshot 模式（读取时复制切片）
- [x] **clipboard_api.go: ClipboardRequest.BlobURL 缺失** — 已添加 blob_url 字段
- [x] **clipboard_api.go: handleClipboardReceive 不获取 blob** — 通过 forwardClient.Get(blobURL) 获取
- [x] **clipboard_api.go: handleClipboardPeersSend peer snapshot** — 同理修复
- [x] **clipboard_api.go: handleClipboardReceive 处理文件 blob** — 遍历 req.Files[*].BlobURL 下载并保存到磁盘
- [x] **Models.cs: ClipboardRequest 缺 blob_url/from/@type** — 已添加
- [x] **ClipboardService.cs: 文件剪贴板无 blob 上传** — DetectClipboardTypeAsync + blob upload
- [x] **ClipboardService.cs: 接收文件不写剪贴板** — DownloadFilesAndSetClipboard
- [x] **ClipboardManager.swift: 文件剪贴板无 blob 上传** — sendFilesClipboard 先上传 blob
- [x] **Program.cs: ContextMenuStrip 死锁** — BeginInvoke 跨线程 marshal
- [x] **ClipboardSync.csproj: System.Drawing.Common 缺失** — 已添加
- [x] **Node.js 旧实现** — 已删除

### P1 结构问题

- [x] **Windows C# CI build: ContextMenu/MenuItem 找不到**
  - 修复：net10.0-windows + ContextMenuStrip/ToolStripMenuItem 重写 Program.cs
  - 验证：CI 通过

- [x] **Windows 轮询改为事件驱动**
  - 问题：AddClipboardFormatListener 需要窗口句柄，IntPtr.Zero 导致 fallback 轮询
  - 修复：新增 HiddenClipboardWindow (NativeWindow 子类)，off-screen WS_EX_TOOLWINDOW 窗口
  - 结果：Windows 托盘 app 现在用事件驱动的 WM_CLIPBOARDUPDATE，macOS 用 NSPasteboard.changeCount，两端一致

- [x] **mDNS peer 注册** — main.go 中 mDNS Start() 回调调用 server.RegisterPeer()
- [x] **forwarded 计数不准确** — wg.Wait() 同步等待后返回
- [x] **桌面端轮询改推送** — SSE /api/push 端点实现，macOS Swift 和 Windows C# 都已连接
- [x] **大文件断点续传** — upload_api.go: chunk hash 校验、bitmap、atomic rename
- [x] **iOS/Android 后台自动剪贴板** — 系统限制，产品策略明确（半自动模式）

### 待后续优化（非阻塞）

- [ ] **HTTPS 自签证书** — iOS/Android 浏览器强警告。可选方案：Let's Encrypt、mkcert、用户手动配置
- [ ] **手动部署文档** — 如何在树莓派/Linux 盒子上部署 Go 服务器二进制

## 构建产物

```
dist/
├── sharetool_darwin_arm64       # Go macOS ARM64
├── sharetool_darwin_amd64       # Go macOS Intel
├── sharetool_windows_amd64.exe # Go Windows
├── sharetool_linux_amd64       # Go Linux
└── ShareToolClipboardSync.exe   # Windows C# 托盘 App (159KB)
```

## GitHub Actions

所有平台自动构建：
- Go 服务器：darwin/arm64, darwin/amd64, windows/amd64, linux/amd64
- Windows C# 托盘：.NET 10 + ContextMenuStrip
- 制品下载：`gh run download <id> --name sharetool-server-binaries`
- 制品下载：`gh run download <id> --name sharetool-windows-app`
