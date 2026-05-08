# ShareTool Clipboard Sync - Specification

## 1. Concept & Vision

局域网剪贴板同步：按下快捷键，当前设备的剪贴板内容（文字/图片/文件）自动发送到所有在线设备，其他设备收到后自动填充剪贴板并弹通知。

核心原则：极简、极速、无感知。

## 2. Architecture

### 2.1 Go Server (sharetool)
剪贴板 API：
- `POST /api/clipboard` — 接收剪贴板内容，存储到本地历史，转发给所有已注册 peers
- `GET /api/clipboard` — 获取完整剪贴板历史（最多 50 条，TTL 24h）
- `GET /api/clipboard/latest` — 获取最新剪贴板条目
- `DELETE /api/clipboard` — 清空历史
- `GET /api/clipboard/file?path=images/xxx.png` — 下载历史图片文件
- `POST /api/clipboard/receive` — peer 间转发（内部使用）

磁盘持久化：
- `~/.sharetool/clipboard/history.json` — 历史记录（服务重启不丢失）
- `~/.sharetool/clipboard/images/` — 图片文件
- `~/.sharetool/clipboard/files/` — 文件

Payload 结构：
```json
{
  "type": "text" | "image" | "files",
  "content": "string (text string, base64 image, or JSON array of filenames)",
  "from": "device-name",
  "timestamp": 1234567890
}
```

### 2.2 ClipboardEntry 数据结构
```go
type ClipboardEntry struct {
    ID        string `json:"id"`
    Type      string `json:"type"`       // "text" | "image" | "files"
    Content   string `json:"content"`    // text string, base64 image, or JSON ["file1","file2"]
    From      string `json:"from"`       // sender device name
    Timestamp int64  `json:"timestamp"`
    FilePath  string `json:"file_path,omitempty"` // for images received via file
}
```

### 2.3 Peers 注册机制
- 已有 `/api/peers` 注册机制（mDNS 自动发现）
- 新设备启动时注册自己
- 发送剪贴板时，POST 到所有已注册 peer 的 `/api/clipboard/receive`
- 使用 HTTP POST 直接发送到对端，无需经过中转服务器
- 使用 `sync.Mutex` + `sync.WaitGroup` 确保所有转发 goroutine 完成后才返回

### 2.4 macOS Python Helper (clipboard_helper.py)
**这是 macOS 热键处理的实际入口**（`Cmd+Shift+V`）。

路径：`~/Library/Application Support/ShareTool/helpers/clipboard_helper.py`

架构：
- CGEvent Tap 监听全局热键（后台线程运行 CFRunLoop）
- 轮询 `/api/clipboard` 检测来自其他设备的剪贴板
- 收到后写入本地剪贴板并弹 macOS 通知

**关键 bug 修复（2026-04-13）**：
1. `NSPasteboard.pasteboardWithName_('general')` 在 Python 中是**独立 pasteboard 实例**，与系统 pasteboard（`pbcopy`/`pbpaste` 用的）**完全隔离**。修复：read 用 `pbpaste` subprocess，write 用 `pbcopy` subprocess，images/files 才用 NSPasteboard
2. Carbon `RegisterEventHotKey`（Swift App）和 CGEvent tap（Python）**并发竞态**：Swift 先读剪贴板修改 `LAST_SENT_CONTENT`，helper 后读发现未变导致跳过发送。修复：禁用 Swift 热键监听，Python helper 独占处理热键

LaunchAgent 自启：`~/Library/LaunchAgents/com.sharetool.clipboard-helper.plist`

### 2.5 macOS Menu Bar App (Swift)
**已禁用热键监听**，仅负责菜单栏状态显示和 Web UI 入口。

- 菜单栏图标（NSStatusItem）+ 右键菜单
- 轮询 `/api/clipboard` 检测新内容并显示通知
- 剪贴板历史子菜单（最近 10 条）
- 热键处理交由 Python helper 独占

### 2.6 Windows Tray App (C#)
路径：`app/ShareTool/ClipboardSync/`

- Win32 `RegisterHotKey`（`Win+Shift+S`）
- `Clipboard.SetText` / `Clipboard.GetText` 读写剪贴板
- HTTP 客户端发送到 peers
- Windows Toast Notification

## 3. API Design

### POST /api/clipboard
**功能**: 接收并转发剪贴板内容到所有已注册 peers，同时存储到本地历史

Request:
```json
{
  "type": "text",
  "content": "Hello from Mac",
  "from": "Mac-mini",
  "timestamp": 1713001234567
}
```

Response:
```json
{
  "success": true,
  "id": "abc123",
  "forwarded": 2  // number of peers forwarded to, -1 if no server running
}
```

### GET /api/clipboard
Response:
```json
{
  "entries": [
    {
      "id": "abc123",
      "type": "text",
      "content": "Hello",
      "from": "Mac-mini",
      "timestamp": 1713001234567
    }
  ]
}
```

### GET /api/clipboard/latest
Response:
```json
{
  "entry": {
    "id": "abc123",
    "type": "text",
    "content": "Hello",
    "from": "Mac-mini",
    "timestamp": 1713001234567
  }
}
```

### DELETE /api/clipboard
清空历史记录。

## 4. UI/UX

### macOS Menu Bar
- 菜单栏图标 + 右键菜单
- 菜单项：剪贴板历史子菜单、打开 Web UI、打开共享文件夹、退出
- 状态栏显示当前 IP

### Windows Tray
- 托盘图标 + 右键菜单
- 菜单项：发送剪贴板、打开 Web UI、设置、自动启动、退出
- 气泡通知显示「收到来自 XX 的剪贴板」

## 5. Hotkeys

| 平台 | 快捷键 | 处理方式 |
|------|--------|---------|
| macOS | Cmd+Shift+V | Python helper CGEvent tap（独占） |
| Windows | Win+Shift+S | Win32 RegisterHotKey |

## 6. Security
- 仅发送到同一局域网内已注册 peers
- Content-Type 验证
- 内容大小限制：text 1MB，image 10MB
- 路径穿越防护（已有）

## 7. File清单

### Go Server
- `go/internal/server/clipboard_api.go` — 完整实现（含磁盘持久化、peer 转发）
- `go/internal/server/server.go` — 注册路由
- `go/internal/server/openapi.go` — 更新 schema
- `go/internal/server/peers_api.go` — peer 注册和存储

### macOS Python Helper
- `~/Library/Application Support/ShareTool/helpers/clipboard_helper.py`

### macOS App (Swift)
- `app/ShareTool/Sources/StatusBarController.swift` — 菜单栏集成（热键已禁用）
- `app/ShareTool/Sources/ClipboardManager.swift` — 剪贴板读写逻辑
- `app/ShareTool/Sources/HotkeyManager.swift` — Carbon 热键（已禁用）
- `app/ShareTool/Sources/AppDelegate.swift` — 入口
- `app/ShareTool/Sources/main.swift` — NSApplication.run()
- `Package.swift` — Swift PM 配置（macOS App 需要 Xcode 编译）
- `Info.plist` — LSUIElement=true

### Windows App
- `app/ShareTool/ClipboardSync/` — C# WinForms 托盘程序

## 8. 构建说明

### Go Server
```bash
cd go && go build -o ../sharetool .
```

### macOS App
**需要 Xcode**（Swift PM 无法构建 macOS .app bundle）：
```bash
cd app/ShareTool
xcodebuild -project ShareTool.xcodeproj -scheme ShareTool -configuration Release build
```

### Windows App
```bash
cd app/ShareTool/ClipboardSync
dotnet build -c Release
```

### Python Helper
```bash
# 手动启动
python3 ~/Library/Application\ Support/ShareTool/helpers/clipboard_helper.py

# 开机自启（安装 LaunchAgent）
launchctl load ~/Library/LaunchAgents/com.sharetool.clipboard-helper.plist
```
