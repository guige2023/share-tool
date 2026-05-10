# ShareTool

局域网文件与文本分享工具，支持剪贴板同步、局域网设备发现、分享链接等功能。

## 功能特性

### 文件分享
- **拖拽上传** — 拖拽或点击选择文件/文件夹
- **文件夹支持** — 自动压缩为 zip 上传
- **分片断点续传** — 大文件 2MB 分片上传
- **批量操作** — 文件列表支持全选、多选批量删除
- **极速下载** — 单文件直接下载，多文件打包下载
- **QR 码分享** — 点击页眉 QR 图标弹出大图，手机扫码访问
- **分享链接** — 生成带提取码的分享链接，支持二维码
- **请求链接** — 他人可通过链接向上传文件到指定目录

### 文本分享
- **历史记录** — 所有文本永久保存，按时间倒序展示
- **一键清空** — 顶部清空全部按钮
- **单条管理** — 每条记录独立复制、删除

### 剪贴板同步（跨设备）
- **全局快捷键** — macOS 菜单栏一键发送剪贴板
- **文字/图片/文件** — 自动识别剪贴板内容类型并传输
- **收到即填充** — 其他设备收到后自动写入本地剪贴板
- **历史记录** — 最多 50 条，持久化到磁盘
- **多设备同步** — 同一局域网内所有在线设备自动收到

### 局域网设备发现
- **mDNS Service Discovery** — 自动发现同网络 ShareTool 实例
- **TCP 端口扫描** — 扫描 18793 端口发现局域网设备
- **设备列表** — 查看所有发现和手动添加的设备
- **设备管理** — 手动添加/删除设备，查看在线状态

### 高级功能
- **标签系统** — 为文件添加颜色标签
- **虚拟文件夹** — 按标签分组文件
- **收藏文件** — 收藏重要文件
- **回收站** — 删除文件暂存回收站
- **WebDAV 支持** — 支持 WebDAV 协议访问

## 快速启动

### macOS
```bash
# 安装包位于 dist/ShareTool-macos.zip
# 解压后双击 ShareTool.app 即可运行
```

### Windows
```bash
# 安装包位于 dist/win-gui/
# 运行 ShareTool.exe 即可
```

### Go 服务端（命令行）
```bash
cd go
go build -o sharetool .

# 运行
./sharetool -name "我的Mac" -dir ~/share

# 参数说明
# -name    实例名称（显示在设备列表）
# -dir     共享目录（默认 ./shared）
# -port    HTTPS 端口（默认 18793）
# -http    HTTP 端口（默认 18790，自动跳转 HTTPS）
# -readonly 只读模式
```

## 访问方式

- **本机访问** — `https://localhost:18793`
- **局域网访问** — `https://192.168.1.x:18793`
- **扫码访问** — 点击页眉 QR 图标，用微信/相机扫码

## API 文档

### 文件 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/files` | 列出所有文件 |
| POST | `/api/upload` | 上传文件（multipart） |
| PUT | `/api/files/:name` | 更新文件（支持断点续传） |
| GET | `/api/files/:name` | 下载文件 |
| DELETE | `/api/files/:name` | 删除文件 |
| DELETE | `/api/files` | 批量删除 |

### 分享 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/share/create` | 创建分享链接 |
| GET | `/api/share/list` | 列出分享 |
| DELETE | `/api/share/delete/:code` | 删除分享 |
| POST | `/api/share/renew/:code` | 续期分享 |
| GET | `/api/share/qr/:code` | 获取分享二维码 |
| GET | `/api/share/content/:code` | 下载分享内容 |

### 文本 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/text` | 分享文本 |
| GET | `/api/text` | 获取文本历史 |
| DELETE | `/api/text?id=:id` | 删除单条 |
| DELETE | `/api/text?all=true` | 清空全部 |

### 剪贴板 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/clipboard` | 获取剪贴板历史 |
| POST | `/api/clipboard` | 发送剪贴板内容 |
| GET | `/api/clipboard/latest` | 获取最新条目 |
| DELETE | `/api/clipboard` | 清空历史 |

### 设备发现 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/devices` | 获取设备列表 |
| GET | `/api/devices/check?ip=&port=` | 检测设备在线状态 |
| POST | `/api/peers` | 注册设备 |
| DELETE | `/api/peers` | 移除设备 |
| POST | `/api/scan/trigger` | 触发局域网扫描 |
| GET | `/api/scan/status` | 获取扫描状态 |

### 其他 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/info` | 服务信息 |
| GET | `/api/qr?url=` | 生成二维码 |
| GET | `/openapi.json` | OpenAPI 规范 |
| GET | `/tools.json` | AI Agent 工具定义 |
| GET | `/` | Web UI |

## 项目结构

```
share-tool/
├── go/                          # Go 服务端
│   ├── main.go                  # 程序入口
│   ├── go.mod / go.sum          # 依赖
│   ├── internal/
│   │   ├── server/              # HTTP 服务
│   │   │   ├── server.go       # 路由、SPA、CORS
│   │   │   ├── file_api.go     # 文件操作
│   │   │   ├── file_api_v2.go  # 文件高级功能（标签、收藏等）
│   │   │   ├── text_api.go     # 文本分享
│   │   │   ├── clipboard_api.go # 剪贴板同步
│   │   │   ├── share_api.go    # 分享链接
│   │   │   ├── peers_api.go    # 节点管理
│   │   │   ├── devices_api.go  # 设备管理
│   │   │   ├── scan_api.go     # 局域网扫描
│   │   │   └── web/            # Web UI
│   │   └── discovery/           # mDNS 发现服务
│   │       ├── mdns.go         # mDNS 客户端
│   │       └── advertiser.go   # mDNS 服务广播
│   └── web/                     # Web UI 源码
├── app/                         # 客户端应用
│   ├── ShareTool/              # macOS 菜单栏 App (Swift)
│   │   └── Sources/
│   │       ├── main.swift
│   │       ├── AppDelegate.swift
│   │       ├── StatusBarController.swift
│   │       └── ClipboardManager.swift
│   └── ShareTool/ClipboardSync/ # Windows 托盘程序 (.NET)
│       ├── ClipboardService.cs
│       ├── Discovery.cs
│       └── TrayIconManager.cs
├── dist/                        # 编译产物
│   ├── ShareTool-macos.zip     # macOS 安装包
│   └── win-gui/                # Windows 安装包
└── README.md
```

## 编译打包

### Go 服务端

```bash
# macOS
cd go && go build -o ../sharetool .

# Windows
GOOS=windows GOARCH=amd64 go build -o sharetool.exe .
```

### macOS App

需要 Xcode 或 swiftc：

```bash
cd app
swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk \
  -target arm64-apple-macosx26.0 \
  -o ShareTool.app ShareTool/Sources/*.swift
```

### Windows App

```bash
cd app/ShareTool/ClipboardSync
dotnet build -c Release
dotnet publish -c Release -r win-x64 -o ../../dist/win-gui
```

## 客户端下载

| 平台 | 安装包 |
|------|--------|
| macOS | `dist/ShareTool-macos.zip` |
| Windows | `dist/win-gui/` |

## 截图

![微信](微信公众号.jpg)

## 许可证

MIT
