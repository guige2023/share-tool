# ShareTool

本地局域网文件与文本分享工具，Go 编写，单一二进制文件，零依赖。

## 功能特性

### 剪贴板同步（跨设备）
- **全局快捷键** — macOS `Cmd+Shift+V`，Windows `Win+Shift+S`，一键发送剪贴板到所有设备
- **文字/图片/文件** — 自动识别剪贴板内容类型并传输
- **收到即填充** — 其他设备收到后自动写入本地剪贴板并弹通知
- **历史记录** — 最多 50 条，TTL 24h，持久化到磁盘（服务重启不丢失）
- **多设备同步** — 同一局域网内所有在线设备自动收到

### 文件分享
- **拖拽上传** — 拖拽或点击选择文件/文件夹，支持大文件分片断点续传（2MB 分片）
- **批量操作** — 文件列表支持全选、多选批量删除（电脑端可用）
- **极速下载** — 单文件直接下载，多文件逐个下载
- **QR 码** — 页眉图标点击弹出大图二维码，手机扫码直接访问

### 文本分享
- **历史记录** — 所有文本永久保存，按时间倒序展示，最多 200 条
- **一键清空** — 顶部"清空全部"按钮，一键清除所有历史
- **单条管理** — 每条记录独立复制、删除按钮

### 访问方式
- **HTTPS 访问（推荐）** — `https://localhost:18793`（本机）或 `https://192.168.1.x:18793`（局域网）
- **HTTP 自动跳转** — `http://localhost:18790` → 自动跳转到 HTTPS
- **扫码访问** — 点击页眉 QR 图标，用微信/相机扫码

## 快速启动

```bash
# 编译（从 go/ 目录构建，产物输出到项目根目录）
cd go
go build -o ../sharetool .

# 运行（默认端口 18793 HTTPS + 18790 HTTP 跳转）
./sharetool

# 指定共享目录和实例名称
./sharetool -name "我的Mac" -dir ~/share

# 只读模式（禁止上传和删除）
./sharetool -readonly
```

服务启动后，共享目录默认为 `./shared`，首次自动创建。

**使用 launchd 开机自启（macOS）：**

```bash
# 注册服务（需要 sudo）
sudo launchctl load ~/Library/LaunchAgents/com.share-tool.plist

# 卸载服务
sudo launchctl unload ~/Library/LaunchAgents/com.share-tool.plist
```

## 命令行示例

```bash
# 上传文件（multipart 表单，推荐方式）
curl -sk -X POST https://localhost:18793/api/upload \
  -F "file=@/path/to/report.pdf"

# 上传到子目录
curl -sk -X POST https://localhost:18793/api/upload \
  -F "file=@/path/to/report.pdf" \
  -F "path=docs"

# 列出文件
curl -sk https://localhost:18793/api/files

# 下载文件
curl -sk -O https://localhost:18793/api/files/report.pdf

# 上传文本
curl -sk -X POST https://localhost:18793/api/text \
  -H 'Content-Type: application/json' \
  -d '{"content":"会议记录：今天下午3点同步"}'

# 查看文本历史
curl -sk https://localhost:18793/api/text

# 删除单条文本
curl -sk -X DELETE 'https://localhost:18793/api/text?id=a1b2c3d4'

# 清空全部文本
curl -sk -X DELETE 'https://localhost:18793/api/text?all=true'

# 批量删除文件
curl -sk -X DELETE https://localhost:18793/api/files \
  -H 'Content-Type: application/json' \
  -d '{"names":["old.pdf","temp.txt"]}'

# 获取二维码图片
curl -sk -o qr.png 'https://localhost:18793/api/qr?url=https://192.168.1.10:18793'
```

## API 列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/files` | 列出所有文件 |
| PUT | `/api/files/:name` | 上传文件（支持 Content-Range 断点续传） |
| GET | `/api/files/:name` | 下载文件 |
| DELETE | `/api/files/:name` | 删除单个文件 |
| DELETE | `/api/files` | 批量删除（body: `{"names":["a","b"]}`） |
| POST | `/api/text` | 分享文本 |
| GET | `/api/text` | 获取文本历史列表 |
| DELETE | `/api/text?id=:id` | 删除单条历史 |
| DELETE | `/api/text?all=true` | 清空全部历史 |
| GET | `/api/qr?url=:url` | 生成二维码 PNG（256×256） |
| GET | `/api/clipboard` | 获取剪贴板历史（最多 50 条） |
| POST | `/api/clipboard` | 发送剪贴板内容（自动转发给所有 peers） |
| GET | `/api/clipboard/latest` | 获取最新剪贴板条目 |
| DELETE | `/api/clipboard` | 清空剪贴板历史 |
| GET | `/api/clipboard/file?path=images/xxx.png` | 下载历史图片文件 |
| GET | `/openapi.json` | OpenAPI 3.0 规范 |
| GET | `/tools.json` | AI Agent 工具定义 |
| GET | `/` | Web UI 主页 |

## AI Agent 调用

ShareTool 暴露 AI 可读的 `/tools.json` 端点，支持 AI Agent 自动化操作。

**标准调用流程**：

```bash
# Step 1: 获取所有工具定义（Agent 注册时调用一次）
curl -sk https://192.168.1.x:18793/tools.json

# Step 2: 调用具体工具（根据 tools.json 中的 input_schema 构造请求）
```

**常用工具调用标准指令**：

```bash
# --- share_text：分享文本到局域网所有设备 ---
curl -sk -X POST https://192.168.1.x:18793/api/text \
  -H 'Content-Type: application/json' \
  -d '{"content":"这里是要分享的文本内容"}'

# --- get_text_history：获取文本分享历史 ---
curl -sk https://192.168.1.x:18793/api/text

# --- delete_text_entry：删除单条文本历史 ---
curl -sk -X DELETE 'https://192.168.1.x:18793/api/text?id=abc123def456'

# --- clear_text_history：清空全部文本历史 ---
curl -sk -X DELETE 'https://192.168.1.x:18793/api/text?all=true'

# --- list_files：列出共享文件 ---
curl -sk https://192.168.1.x:18793/api/files

# --- upload_file：上传文件（multipart 表单） ---
# content: 文件路径（Agent 本地路径）
# path:   可选，子目录名如 "reports"
curl -sk -X POST https://192.168.1.x:18793/api/upload \
  -F "file=@/tmp/example.pdf"

# --- download_file：下载文件到本地 ---
curl -sk -O https://192.168.1.x:18793/api/files/filename.pdf

# --- delete_file：删除单个文件 ---
curl -sk -X DELETE https://192.168.1.x:18793/api/files/old-report.pdf

# --- batch_delete_files：批量删除多个文件 ---
curl -sk -X DELETE https://192.168.1.x:18793/api/files \
  -H 'Content-Type: application/json' \
  -d '{"names":["file1.pdf","file2.txt"]}'

# --- get_qr_code：生成访问二维码（手机扫码访问） ---
curl -sk -o qr.png 'https://192.168.1.x:18793/api/qr?url=https://192.168.1.x:18793'
```

**OpenAPI 规范**：Agent 也可读取 `GET /openapi.json` 获取完整 OpenAPI 3.0 规范，用标准 HTTP 客户端调用。

## Web UI 操作

打开 `https://localhost:18793`（或局域网 IP）：

- **文件页** — 拖拽上传 / 点击上传，支持文件和文件夹，文件列表全选多选批量删除
- **剪贴板页** — 发送文本，查看历史记录，每条独立复制/删除，顶部一键清空
- **QR 码** — 页眉右侧 QR 图标，点击弹出大图，手机扫码访问

## 项目结构

```
share-tool/
├── go/
│   ├── main.go                    # 程序入口，命令行解析
│   ├── go.mod / go.sum           # Go 模块依赖
│   ├── internal/
│   │   ├── server/
│   │   │   ├── server.go           # HTTP/HTTPS 路由、SPA fallback、mDNS
│   │   │   ├── file_api.go        # 文件上传/下载/删除/批量删除
│   │   │   ├── text_api.go        # 文本历史（数组结构，最多200条）
│   │   │   ├── clipboard_api.go   # 剪贴板同步 API（含磁盘持久化、peer 转发）
│   │   │   ├── peers_api.go       # 节点发现（mDNS）
│   │   │   ├── tools_schema.go    # AI 工具定义 JSON
│   │   │   ├── openapi.go         # OpenAPI 3.0 规范
│   │   │   └── web/index.html     # Web UI（嵌入二进制）
│   │   └── web/index.html         # Web UI 源码（修改后需同步到 internal/）
├── app/
│   ├── Package.swift              # Swift PM 配置（macOS App 需要 Xcode 编译）
│   └── ShareTool/
│       ├── ShareTool.xcodeproj    # Xcode 项目
│       ├── Sources/
│       │   ├── main.swift          # NSApplication.run() 入口
│       │   ├── AppDelegate.swift   # App 代理，菜单栏初始化
│       │   ├── StatusBarController.swift  # 菜单栏 UI（热键已禁用，由 Python helper 处理）
│       │   ├── ClipboardManager.swift     # 剪贴板读写 + API 轮询
│       │   └── HotkeyManager.swift        # Carbon 热键（已禁用）
│       ├── ClipboardSync/          # Windows C# 托盘程序
│       └── Info.plist              # LSUIElement=true（无 Dock 图标）
├── helpers/
│   └── clipboard_helper.py        # Python 全局热键监听（macOS 实际热键处理入口）
├── shared/                         # 共享文件目录（运行时创建）
├── sharetool                       # 编译产物（macOS amd64）
├── sharetool_darwin_arm64          # 编译产物（macOS ARM64）
├── sharetool_linux_amd64           # 编译产物（Linux）
├── sharetool_windows_amd64.exe    # 编译产物（Windows）
├── ShareTool-macos.dmg             # macOS DMG 安装包（含 Go server）
├── ShareTool-macos-clipboard.dmg   # macOS DMG（含 Go server + Python helper）
├── README.md
├── CLIPBOARD_SPEC.md              # 剪贴板同步详细规格
├── tasks.md                       # 开发任务书
└── ROADMAP.md                     # 产品路线图
```

## 编译打包

### Go Server（跨平台核心服务）

```bash
# 编译 macOS 版本（amd64）
cd go
go build -o ../sharetool_darwin_amd64 .

# 编译 macOS ARM64 (Apple Silicon)
GOOS=darwin GOARCH=arm64 go build -o ../sharetool_darwin_arm64 .

# 编译 Linux
GOOS=linux GOARCH=amd64 go build -o ../sharetool_linux_amd64 .

# 编译 Windows
GOOS=windows GOARCH=amd64 go build -o ../sharetool_windows_amd64.exe .
```

### macOS App（菜单栏状态栏程序）

使用 Swift Package Manager 构建（无需 Xcode）：

```bash
cd app
swift build -c release

# 构建产物在 .build/release/，手动打包为 .app
# 或使用 Xcode 打开 Package.swift 进行图形界面编译
```

### Python Helper（macOS 全局热键，必须安装）

```bash
# 安装辅助工具
cp -r helpers ~/Library/Application\ Support/ShareTool/helpers/

# 启动（需要辅助功能权限）
python3 ~/Library/Application\ Support/ShareTool/helpers/clipboard_helper.py
```

### 制作 macOS DMG 安装包

```bash
# 1. 打包 Go server + Python helper 到临时目录
STAGING="/tmp/ShareTool_Package"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING"

cp go 构建产物和 helpers/ 目录...
cp -a ShareTool.app "$STAGING/"

# 2. 创建 DMG（UDZO 压缩格式）
hdiutil create -volname "ShareTool" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  ~/Desktop/ShareTool_v2.0.dmg
```

## 发布版本

### v2.0（2026-04-13）— 剪贴板同步修复版

**修复内容：**
- 修复 macOS Python Helper 剪贴板读取 bug（pbpaste/pbcopy subprocess 替换 NSPasteboard 隔离问题）
- 修复 CGEvent tap 竞态条件（热键回调延迟 600ms + retry 机制）
- 修复 Carbon 热键和 Python CGEvent 并发冲突（Swift HotKeyManager 已禁用）
- 200 次自动化测试：181 成功，11 合法跳过（内容未变），0 异常

**下载：**
- macOS: `ShareTool-macos-clipboard.dmg`（含 Go server + Python helper）
- Windows: `ShareTool-windows/ShareToolClipboardSync.exe`（托盘程序）

## 注意事项

- 无需 Token 认证，适用于可信局域网环境
- 共享目录默认为 `./shared`，首次启动自动创建
- 二进制文件约 10MB，静态编译，无运行时依赖
- QR 码由后端 `github.com/skip2/go-qrcode` 生成，纯 Go 实现
- macOS 上使用 HTTPS（端口 18793），HTTP（端口 18790）自动跳转
