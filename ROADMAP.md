# ShareTool 极简局域网分享工具 - 迭代开发计划

本文件旨在指导 ShareTool 的开发。核心理念为：**极致轻量、零配置、无缝跨端、AI 友好、大文件无限制**。放弃所有局域网内的安全防御机制，将性能和系统资源占用优化到极致。

---

## 1. 核心定位与功能特性

- **极致轻量与极简部署**：核心服务端编译为单文件可执行程序（零依赖），内存占用极低（<20MB），CPU 闲置消耗接近 0。

- **绝对信任与零配置**：去掉所有密码、PIN码和接收确认机制。局域网内设备自由访问，即连即用。

- **大文件与断点续传**：突破文件大小限制。底层支持 HTTP Range 请求和分片上传，网络波动断开后随时无缝续传。

- **全渠道无缝覆盖**：
  - **Mac/Windows**：后台静默运行系统托盘程序。
  - **手机/平板**：无需安装 App，自动发现或扫码直接通过 Web UI 访问。
  - **终端 (CLI)**：原生提供命令行工具进行极速收发。
  - **AI Agent 友好**：提供极其规范清晰的 REST API，OpenClaw、Hermes 等 AI 代理可通过标准 HTTP 协议或 Shell 脚本无缝调用。

---

## 2. 架构选型与系统设计（不设限的轻量化）

为了达到"极低资源占用"，需抛弃传统臃肿的技术栈：

- **核心服务 (Core Server)**：推荐使用 Go (Golang)。自带极高性能的 HTTP 服务器，跨平台编译极其方便，单二进制文件即可运行。

- **设备发现 (Discovery)**：集成 mDNS/UDP 广播，实现局域网内"免输 IP"自动发现。

- **数据存储**：放弃 SQLite。为了更轻量，直接使用纯文本的 JSON 或纯内存维护索引（启动时扫描本地共享目录即可），不引入数据库引擎带来的额外开销。

- **桌面端 (Desktop Wrapper)**：使用 Tauri (或 Go 自带的轻量系统托盘库 systray)。只负责展示系统托盘图标、快捷键绑定和启动/关闭 Core Server。

- **Web 前端**：使用原生 HTML/JS/CSS，或极简的 Preact，打包进 Go 的二进制文件中，无需分离部署。

---

## 3. 核心 API 设计（面向终端与 AI Agent）

API 设计遵循极致简单的 RESTful 风格，AI Agent 能够仅凭一套 OpenAPI 描述或简单的 curl 命令就完成对本机的控制。

### 3.1 文本与剪贴板流转

**分享文本**
```http
POST /api/text
```
- 请求：`{ "content": "hello world" }`
- 响应：`{ "id": "t1", "status": "success" }`

**获取最新文本**
```http
GET /api/text/latest
```
- 响应：`{ "content": "hello world", "time": "..." }`

### 3.2 大文件与断点续传 API

**上传文件（支持分片与追加，实现断点续传）**
```http
PUT /api/files/:filename
```
- 头部：`Content-Range: bytes 0-1048575/2097152` (标准 HTTP 范围请求)
- 说明：AI Agent 也可以直接用普通的 `POST /api/upload` 传小文件。

**下载文件（原生支持断点续传）**
```http
GET /api/files/:filename
```
- 说明：服务端自动响应 `Accept-Ranges: bytes`。客户端或下载工具（如 wget, aria2）请求时带上 `Range: bytes=500-` 即可实现断线续传。

**获取文件列表**
```http
GET /api/files
```
- 响应：`[ { "name": "data.csv", "size": 102455, "url": "http://192.168.1.10:8080/api/files/data.csv" } ]`

---

## 4. AI Agent 集成指南 (供 OpenClaw / Hermes 消费)

在工具中直接内置一个供 AI Agent 读取的接口，使 LLM 能自动理解如何使用你的电脑进行文件吞吐：

### 向外分享内容（供 Agent 写入结果）

```bash
# Agent 生成了一段长代码，一键挂载到局域网
curl -X POST http://127.0.0.1:8080/api/text -d '{"content": "import pandas as pd..."}'

# Agent 产出了一个数据分析报告，一键分享
curl -T report.pdf http://127.0.0.1:8080/api/files/report.pdf
```

### 获取局域网内容（供 Agent 读取输入）

```bash
# Agent 获取局域网发来的最新指令/文本
curl http://127.0.0.1:8080/api/text/latest

# Agent 读取局域网内投递的文件进行处理
curl -O http://127.0.0.1:8080/api/files/task_data.zip
```

---

## 5. 目录结构设计 (以单体化部署为目标)

```
sharetool/
├── main.go                 # 服务入口、路由注册
├── server/
│   ├── handlers.go         # API 处理逻辑 (上传/下载/文本)
│   ├── range_transfer.go   # 断点续传核心逻辑处理
│   └── discovery.go        # mDNS 局域网广播与发现
├── cli/
│   └── cmd.go              # 本地终端命令行工具逻辑 (sharetool push / sharetool pull)
├── web/
│   ├── index.html          # 极简 Web UI（手机/平板访问入口）
│   └── app.js              # 包含断点续传的前端逻辑
└── desktop/                # (可选) Tauri 或系统托盘的简单封装
    └── tray.go             # 托盘图标、开机自启、快捷键
```

---

## 6. 分阶段迭代路线

### 阶段 A：极速核心与 API (MVP)

**目标**：跑通极其稳定、轻量级的后台服务，以及 CLI 工具和 AI Agent 的调用闭环。

**功能**：
- 搭建基础 HTTP Server（Go 实现）。
- 实现 GET/PUT `/api/files`，完美支持 HTTP Header 的 Range 范围读写（断点续传核心）。
- 实现 `/api/text` 文本剪贴板接口。
- 将 Web UI 静态文件打包进二进制程序中。

**交付**：一个能在 Mac/Windows/Linux 终端直接运行的单体二进制文件（例如 `./sharetool serve`），占用内存十几兆。

### 阶段 B：跨端体验优化 (Web + Mobile 访问)

**目标**：不用写一行移动端代码，搞定手机和平板。

**功能**：
- 实现局域网 mDNS 广播（服务启动时广播自己的 IP 和端口）。
- 完善 Web 页面：自适应移动端布局，支持手机浏览器直接选择相册大文件/视频上传（前端使用 `File.slice()` 分块上传避免手机内存崩溃）。
- 在 Web 面板上显示局域网内其他运行该工具的设备列表。

### 阶段 C：桌面端静默与快捷体验

**目标**：让工具像系统原生服务一样无感存在。

**功能**：
- 包装桌面托盘（Windows 右下角，Mac 顶部状态栏）。
- 支持注册系统级全局快捷键（例如按 Alt+Space 直接将当前选中的文件/剪贴板文字推送到局域网）。
- 一键设置开机自启（后台静默启动核心服务）。

### 阶段 D：AI 深度集成

**目标**：将工具标准化，作为大语言模型（LLM）的外部能力。

**功能**：
- 输出标准的 OpenAPI/Swagger `schema.json`，直接提供给 Hermes / OpenClaw 作为 Tool 注册。
- 允许 AI Agent 通过 API 直接拉取指定局域网设备上的工作目录文件，处理后再推送回去。
