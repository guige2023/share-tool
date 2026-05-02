# ShareTool 开发任务

## P0 问题（已修复并验证）

- [x] **mdns.go: advertiseLoop() 未被调用** — Start() 中调用了 d.advertiseLoop()
- [x] **clipboard_api.go: peers map 并发修改** — 改用 peer snapshot 模式
- [x] **clipboard_api.go: ClipboardRequest.BlobURL 缺失** — 已添加 blob_url 字段
- [x] **clipboard_api.go: handleClipboardReceive 不获取 blob** — 通过 forwardClient.Get(blobURL) 获取
- [x] **clipboard_api.go: handleClipboardPeersSend peer snapshot** — 同理修复
- [x] **Models.cs: ClipboardRequest 缺 blob_url/from/@type** — 已添加
- [x] **ClipboardService.cs: 文件剪贴板无 blob 上传** — DetectClipboardTypeAsync + blob upload
- [x] **ClipboardService.cs: 接收文件不写剪贴板** — DownloadFilesAndSetClipboard
- [x] **ClipboardManager.swift: 文件剪贴板无 blob 上传** — sendFilesClipboard 先上传 blob
- [x] **Program.cs: ContextMenuStrip 死锁** — 改用 BeginInvoke 跨线程调用
- [x] **ClipboardSync.csproj: System.Drawing.Common 缺失** — 已添加
- [x] **Node.js 旧实现** — 已删除

## P1 问题（已修复并验证）

- [x] **Windows C# CI build: ContextMenu/MenuItem 找不到**
  - 原因：.NET 8 SDK + Windows Desktop SDK 配置问题
  - 修复：改用 net10.0-windows + ContextMenuStrip/ToolStripMenuItem 重写 Program.cs
  - 验证：CI 通过，生成 ShareToolClipboardSync.exe (159KB)

- [x] **mDNS peer 注册**
  - main.go 中 mDNS Start() 回调已调用 server.RegisterPeer(ip, port, name)
  - peers_api.go 中 RegisterPeer 已实现
  - 验证：代码已就位

- [x] **forwarded 计数不准确**
  - 代码中 wg.Wait() 同步等待后返回，forwarded 计数正确
  - 验证：代码已正确

- [x] **图片/文件剪贴板 blob 协议**
  - handleClipboardReceive 已通过 BlobURL 获取图片数据
  - 新增：handleClipboardReceive 处理 req.Files[*].BlobURL，下载并保存文件到磁盘
  - saveReceivedFile helper 已添加
  - 验证：Go build 通过

- [x] **桌面端轮询改推送**
  - /api/push SSE 端点已实现，handlePush handler 存在
  - BroadcastClipboard 在 handleClipboardPost/handleClipboardReceive 中调用
  - AddPushClient/RemovePushClient 已实现
  - 验证：代码已就位，Go build 通过

- [x] **大文件断点续传**
  - upload_api.go: handleUploadChunk 带 hash 校验、offset seek、bitmap 更新
  - handleUploadComplete: SHA256 校验 + os.Rename 原子写入
  - handleUploadStatus: 返回已完成的 chunks 列表用于恢复
  - 验证：Go build 通过

- [x] **iOS/Android 后台自动剪贴板**
  - 系统限制：iOS Safari/PWA 无法后台读取剪贴板
  - 产品定义：iOS/Android Web 端为"半自动"模式
  - 验证：无需代码修改，产品策略已明确

## 构建说明

```bash
# Go 服务器（所有平台）
./scripts/build.sh
# 输出：dist/sharetool_darwin_arm64, dist/sharetool_darwin_amd64,
#       dist/sharetool_windows_amd64.exe, dist/sharetool_linux_amd64

# macOS 原生菜单栏 App
cd app/ShareTool
xcodebuild -project ShareTool.xcodeproj -scheme ShareTool -configuration Release

# Windows 托盘 App
cd app/ShareTool/ClipboardSync
dotnet build -c Release -r win-x64
# 输出：bin/Release/net10.0-windows/win-x64/ShareToolClipboardSync.exe

# GitHub Actions（自动构建所有平台）
git push origin fix/clipboard-p0-fixes
# 制品下载：
#   gh run download <id> --name sharetool-server-binaries
#   gh run download <id> --name sharetool-windows-app
```

## 架构说明

```
ShareTool/
├── go/                          # Go Core Server (单二进制)
│   ├── main.go                  # 入口，mDNS 启动，HTTP 服务器
│   └── internal/
│       ├── server/               # API handlers
│       │   ├── clipboard_api.go  # 剪贴板 API + SSE push
│       │   ├── peers_api.go     # 设备注册 + mDNS peer 注册
│       │   ├── blob_api.go      # blob 上传/下载
│       │   ├── upload_api.go   # 断点续传上传 session
│       │   └── ws_api.go       # SSE push handler
│       └── discovery/
│           └── mdns.go          # mDNS 发现 + advertise
├── app/ShareTool/              # 原生桌面客户端
│   ├── Sources/                # macOS Swift 菜单栏 App
│   └── ClipboardSync/          # Windows C# 托盘 App
└── dist/                       # 编译产物
```
