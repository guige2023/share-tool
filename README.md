# ShareTool

本地局域网文件分享工具，支持 Web UI、分享链接和命令行操作。

## 功能特性

- **文件上传** - 支持拖拽上传，自动去重（按文件内容哈希）
- **文件管理** - 列表查看、搜索、重命名、删除、批量清理
- **一键下载** - 单文件下载或打包成 ZIP 批量下载
- **分享链接** - 生成带密码的分享链接，支持二维码
- **HTTPS 服务** - 自动生成自签名证书，避免浏览器下载警告
- **命令行支持** - 完整的 REST API，支持 curl 操作

## 快速启动

```bash
# 安装依赖
npm install

# 启动服务
node server.js
```

服务启动后会同时监听两个端口：
- `http://localhost:18790` → 自动 301 跳转到 HTTPS
- `https://localhost:18793` → 主服务（首次访问需接受自签名证书）

局域网访问地址：`https://<本机IP>:18793`

## 开机自动启动（macOS）

已配置为 macOS 开机自动启动服务：

```bash
# 查看服务状态
launchctl list | grep com.share-tool

# 手动停止
launchctl stop com.share-tool

# 手动启动
launchctl start com.share-tool

# 卸载开机启动
launchctl unload ~/Library/LaunchAgents/com.share-tool.plist
```

服务日志保存在 `~/.share-tool/logs/` 目录下。

## Web UI 使用

1. 打开 `https://<本机IP>:18793`
2. 在认证弹窗中输入 Token（默认 Token 见下方注意事项）
3. 拖拽文件到上传区域即可上传
4. 点击文件右侧的 **分享** 按钮生成分享链接
5. 点击 **下载** 或顶部的 **下载全部** 获取文件

## API 使用

所有管理 API 需要携带认证 Token：

```bash
TOKEN="your-token-here"
```

### 1. 查看文件列表

```bash
curl -k "https://localhost:18793/api/list" \
  -H "x-auth-token: $TOKEN"
```

### 2. 搜索文件

```bash
curl -k "https://localhost:18793/api/search?q=keyword" \
  -H "x-auth-token: $TOKEN"
```

### 3. 上传文件

```bash
curl -k -X POST "https://localhost:18793/api/upload" \
  -H "x-auth-token: $TOKEN" \
  -F "file=@/path/to/file.png"
```

### 4. 下载单个文件

```bash
curl -k -o file.png \
  "https://localhost:18793/download/file.png" \
  -H "x-auth-token: $TOKEN"
```

### 5. 下载全部（ZIP）

```bash
curl -k -o all.zip \
  "https://localhost:18793/api/download-all" \
  -H "x-auth-token: $TOKEN"
```

### 6. 创建分享链接

```bash
curl -k -X POST "https://localhost:18793/api/share/create" \
  -H "Content-Type: application/json" \
  -H "x-auth-token: $TOKEN" \
  -d '{
    "filename": "file.png",
    "maxDownloads": 10,
    "expireHours": 24,
    "password": "1234"
  }'
```

### 7. 重命名文件

```bash
curl -k -X PUT "https://localhost:18793/api/file/old-name.png" \
  -H "Content-Type: application/json" \
  -H "x-auth-token: $TOKEN" \
  -d '{"newName":"new-name.png"}'
```

### 8. 删除指定文件

```bash
curl -k -X DELETE "https://localhost:18793/api/file/file.png" \
  -H "x-auth-token: $TOKEN"
```

### 9. 删除旧文件

```bash
# 删除 7 天前的文件
curl -k -X DELETE "https://localhost:18793/api/delete-old?days=7" \
  -H "x-auth-token: $TOKEN"
```

### 10. 删除所有文件

```bash
curl -k -X DELETE "https://localhost:18793/api/delete-all" \
  -H "x-auth-token: $TOKEN"
```

### 11. 存储统计

```bash
curl -k "https://localhost:18793/api/storage" \
  -H "x-auth-token: $TOKEN"
```

## 配置文件

配置文件位于：`~/.share-tool/config.json`

首次启动会自动创建，示例：

```json
{
  "shareToken": "your-token-here",
  "uploadMaxSizeMB": 100
}
```

- `shareToken` - 访问认证 Token
- `uploadMaxSizeMB` - 单个文件上传大小限制（默认 100MB）

## 文件存储

- 上传的文件保存在：`~/.share-tool/files/`
- SQLite 数据库保存在：`~/.share-tool/share-tool.db`
- 自签名证书保存在：`~/.share-tool/ssl/`

## 注意事项

- 默认 Token 可在 `~/.share-tool/config.json` 中查看或修改
- 也可通过环境变量 `SHARE_TOKEN` 覆盖默认 Token
- HTTPS 使用自动生成的自签名证书，首次访问时浏览器会提示"不安全"，点击继续即可
- 建议在生产环境或公网使用前修改默认 Token

## 联系方式

### 免费 OpenClaw 和 AI 交流群

![微信群二维码](微信群二维码.jpg)

### 微信公众号

![微信公众号](微信公众号.jpg)
