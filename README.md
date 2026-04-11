# ShareTool

本地局域网文件与文本分享工具，Go 编写，单一二进制文件，零依赖。

## 功能特性

### 文件分享
- **拖拽上传** — 拖拽或点击选择文件，支持大文件分片断点续传（2MB 分片）
- **批量操作** — 文件列表支持全选、多选批量删除（电脑端可用）
- **极速下载** — 单文件直接下载，多文件逐个下载
- **QR 码** — 页眉图标点击弹出大图二维码，手机扫码直接访问

### 文本分享
- **历史记录** — 所有文本永久保存，按时间倒序展示，最多 200 条
- **一键清空** — 顶部"清空全部"按钮，一键清除所有历史
- **单条管理** — 每条记录独立复制、删除按钮

### 访问方式
- **本机访问** — `http://localhost:18790`
- **局域网访问** — `http://192.168.1.x:18790`（IP 自动检测）
- **扫码访问** — 点击页眉 QR 图标，用微信/相机扫码

## 快速启动

```bash
# 下载最新 release 二进制（Linux/macOS/Windows）
# 或直接编译
cd go
go build -o sharetool .

# 运行（默认端口 18790）
./sharetool

# 指定端口和共享目录
./sharetool -port 8080 -dir /tmp/share

# 指定实例名称
./sharetool -name "我的Mac"
```

服务启动后，共享目录默认为 `./shared`，首次自动创建。

## 命令行示例

```bash
# 上传文件
curl -T report.pdf http://localhost:18790/api/files/report.pdf

# 列出文件
curl http://localhost:18790/api/files

# 下载文件
curl -O http://localhost:18790/api/files/report.pdf

# 上传文本
curl -X POST http://localhost:18790/api/text \
  -H 'Content-Type: application/json' \
  -d '{"content":"会议记录：今天下午3点同步"}'

# 查看文本历史
curl http://localhost:18790/api/text

# 删除单条文本
curl -X DELETE 'http://localhost:18790/api/text?id=a1b2c3d4'

# 清空全部文本
curl -X DELETE 'http://localhost:18790/api/text?all=true'

# 批量删除文件
curl -X DELETE http://localhost:18790/api/files \
  -H 'Content-Type: application/json' \
  -d '{"names":["old.pdf","temp.txt"]}'

# 获取二维码图片
curl -o qr.png 'http://localhost:18790/api/qr?url=http://192.168.1.10:18790'
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
| GET | `/openapi.json` | OpenAPI 3.0 规范 |
| GET | `/tools.json` | AI Agent 工具定义 |
| GET | `/` | Web UI 主页 |

## AI Agent 调用

ShareTool 暴露 AI 可读的 `/tools.json` 端点，支持 AI Agent 自动化操作。

**注册方式**：Agent 读取 `GET /tools.json`，获取所有可用工具定义后，通过对应 HTTP API 执行。

**可用工具**：

| 工具名 | 说明 | 调用方式 |
|--------|------|----------|
| `share_text` | 分享文本到局域网 | `POST /api/text` |
| `get_text_history` | 获取文本历史 | `GET /api/text` |
| `delete_text_entry` | 删除单条历史 | `DELETE /api/text?id=...` |
| `clear_text_history` | 清空全部历史 | `DELETE /api/text?all=true` |
| `list_files` | 列出文件 | `GET /api/files` |
| `upload_file` | 上传文件 | `PUT /api/files/:name` |
| `download_file` | 下载文件 | `GET /api/files/:name` |
| `batch_delete_files` | 批量删除 | `DELETE /api/files` + JSON body |

**示例**：Agent 发现文件列表中有过期文件，执行清理：

```bash
# Agent 决定调用 batch_delete_files
curl -X DELETE http://192.168.1.10:18790/api/files \
  -H 'Content-Type: application/json' \
  -d '{"names":["2024-旧报告.pdf","tmp_cache.bin"]}'
```

## Web UI 操作

打开 `http://localhost:18790`（或局域网 IP）：

- **文件页** — 拖拽上传 / 点击上传，文件列表全选多选批量删除
- **剪贴板页** — 发送文本，查看历史记录，每条独立复制/删除，顶部一键清空
- **QR 码** — 页眉右侧 QR 图标，点击弹出大图，手机扫码访问

## 项目结构

```
share-tool/
├── go/
│   ├── main.go                    # 程序入口，命令行解析
│   ├── internal/
│   │   ├── server/
│   │   │   ├── server.go           # HTTP 路由、SPA fallback
│   │   │   ├── file_api.go        # 文件上传/下载/删除/批量删除
│   │   ├── text_api.go            # 文本历史（数组结构，最多200条）
│   │   └── web/index.html         # Web UI（嵌入二进制）
│   └── web/index.html             # Web UI 源码（同步用）
├── cmd/                           # 预留扩展命令
├── README.md
└── LICENSE
```

## 编译打包

```bash
cd go
go build -o sharetool .
# 输出单一二进制，无外部依赖
```

## 注意事项

- 无需 Token 认证，适用于可信局域网环境
- 共享目录默认为 `./shared`，首次启动自动创建
- 二进制文件约 9MB，静态编译，无运行时依赖
- QR 码由后端 `github.com/skip2/go-qrcode` 生成，纯 Go 实现
