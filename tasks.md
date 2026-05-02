# ShareTool 开发任务

## 状态说明

### P0 问题（已修复）

- [x] **mdns.go: advertiseLoop() 未被调用** — Start() 中调用了 advertiseLoop() 进行自广播
- [x] **clipboard_api.go: peers map 并发修改** — 改用 peer snapshot 模式（读取时复制切片）
- [x] **clipboard_api.go: ClipboardRequest.BlobURL 缺失** — 已添加 blob_url 字段
- [x] **clipboard_api.go: handleClipboardReceive 不获取 blob** — 现在通过 forwardClient.Get(blobURL) 获取
- [x] **clipboard_api.go: handleClipboardPeersSend peer snapshot** — 同理修复
- [x] **Models.cs: ClipboardRequest 缺 blob_url** — 已添加
- [x] **Models.cs: ClipboardEntry 缺 from/@type** — 已添加
- [x] **ClipboardService.cs: 文件剪贴板编码错误** — 现在通过 blob upload 下载文件并写入剪贴板
- [x] **ClipboardService.cs: 下载后写文件剪贴板** — DownloadFilesAndSetClipboard 方法
- [x] **ClipboardManager.swift: 文件剪贴板无 blob 上传** — sendFilesClipboard 现在先上传 blob
- [x] **Program.cs: ContextMenuStrip 死锁** — 改用 native ContextMenu
- [x] **ClipboardSync.csproj: System.Drawing.Common 缺失** — 已添加

### P1 问题（待完成）

- [ ] **Windows C# build: ContextMenu/MenuItem WinForms 类型找不到**
  - GitHub Actions Windows runner 有 .NET SDK 10 预装，与 .NET 8 SDK 的 Windows Desktop SDK 冲突
  - 已在 CI 中尝试：UseWindowsForms、FrameworkReference、Windows SDK 版本指定，均无效
  - **临时方案**：Windows 端用已编译的 .exe（见 dist/），或手动在 Windows 机器上构建
  - **根本修复**：需要安装 .NET 8 Windows Desktop SDK 或使用纯净的 .NET 8-only 环境

- [ ] **mDNS peer 注册** — 当前发现 peer 后只是 log，没有注册到 server.peers
  - 需要在发现 peer 后调用 server.RegisterPeer()
  - 需要 server.RegisterPeer() 方法

- [ ] **forwarded 计数不准确** — wg.Wait() 在返回后才执行，实际 forwarded 总是 0
  - 需要同步等待 goroutine 完成后再返回

- [ ] **图片/文件剪贴板跨设备传输** — blob 协议已建立但接收端 handleClipboardReceive 需验证

- [ ] **桌面端轮询改推送** — 当前每 2 秒 poll /api/clipboard/latest，应改用 SSE/WebSocket 推送

- [ ] **大文件断点续传** — upload_api.go 有基础框架，但缺少 chunk 校验、临时文件原子 rename、bitmap 完成记录

- [ ] **iOS/Android 后台自动剪贴板** — 系统限制无法实现，Web 端只能半自动

### Node.js 旧实现（已删除）

- [x] server.js, routes/, tests/, package.json — 已删除
- [x] 确认 Go 为唯一后端核心

## 构建说明

```bash
# Go 服务器（所有平台）
./scripts/build.sh
# 输出：dist/sharetool_darwin_arm64, dist/sharetool_darwin_amd64,
#       dist/sharetool_windows_amd64.exe, dist/sharetool_linux_amd64

# macOS 原生菜单栏 App
cd app/ShareTool
xcodebuild -project ShareTool.xcodeproj -scheme ShareTool -configuration Release

# Windows 托盘 App（需要在 Windows 上构建）
cd app/ShareTool/ClipboardSync
dotnet build -c Release -r win-x64
# 依赖：.NET 8.0 SDK + Windows Desktop SDK

# GitHub Actions（Go 服务器全平台构建 + Windows C# 托盘 App）
git push origin fix/clipboard-p0-fixes
# 制品下载：gh run download <run-id> --name sharetool-server-binaries
```
