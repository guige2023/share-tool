# ShareTool

本地局域网文件/文字分享工具，支持 Web UI 和命令行操作。

## 功能特性

- 文字分享 - 输入文字、代码快速分享
- 文件上传 - 支持任意文件类型，保持原文件名
- 一键下载 - 批量下载所有文件到指定目录
- 进度显示 - 下载进度实时显示
- 命令行支持 - 完整的 REST API，支持 curl 操作
- 开机自启 - 配置为 Mac 开机自动启动服务

## 快速启动

### 手动启动

```bash
# 启动服务
node /Users/guige/share-tool/server.js

# 或使用后台运行
nohup node /Users/guige/share-tool/server.js &
```

### 开机自动启动

```bash
# 加载 launchd 服务（一次性）
launchctl load /Users/guige/Library/LaunchAgents/com.share-tool.plist

# 卸载服务
launchctl unload /Users/guige/Library/LaunchAgents/com.share-tool.plist
```

服务将在每次 Mac 开机后自动启动。

## 访问地址

- 本地访问: http://localhost:18790
- 局域网访问: http://<你的IP>:18790

## Web UI 使用

### 分享文字

1. 在"分享文字"区域输入内容
2. 点击"分享"按钮
3. 内容将保存并显示在"最近分享"列表中

### 上传文件

1. 点击"上传文件"区域或拖拽文件到此处
2. 文件将保持原文件名上传
3. 上传完成会显示成功提示

### 下载文件

1. 在"下载目录"设置保存路径
2. 点击"保存"按钮
3. 点击"一键下载全部"批量下载所有文件
4. 也可单独点击每个文件的"下载"按钮

### 删除文件

- **删除指定文件**: 点击文件旁边的"删除"按钮
- **删除1周前**: 点击"删除1周前"批量删除
- **删除1月前**: 点击"删除1月前"批量删除
- **删除所有**: 点击"删除所有"清空全部

## 命令行使用

所有命令需要携带认证 Token:
```bash
TOKEN="35e7438f1e72356ebc6d4e839881cc35233ee01ec81d5af6"
```

### 1. 查看文件列表

```bash
curl http://localhost:18790/api/list \
  -H "x-auth-token: $TOKEN"
```

### 2. 上传文字

```bash
curl -X POST http://localhost:18790/api/upload \
  -H "Content-Type: application/json" \
  -H "x-auth-token: $TOKEN" \
  -d '{"filename":"note.txt","content":"Hello World","type":"text"}'
```

### 3. 上传文件（Base64）

```bash
# 先将文件转为 Base64
CONTENT=$(base64 -i /path/to/file.png)

curl -X POST http://localhost:18790/api/upload \
  -H "Content-Type: application/json" \
  -H "x-auth-token: $TOKEN" \
  -d '{"filename":"file.png","content":"'"$CONTENT"'","type":"file"}'
```

### 4. 读取最新文字

```bash
curl http://localhost:18790/api/latest/text \
  -H "x-auth-token: $TOKEN"
```

### 5. 读取指定文件内容

```bash
curl http://localhost:18790/api/content/文件名 \
  -H "x-auth-token: $TOKEN"
```

### 6. 下载文件

```bash
curl -o saveas.txt \
  http://localhost:18790/download/文件名
```

### 7. 一键下载到本地目录（服务端）

```bash
curl -X POST http://localhost:18790/api/download-one \
  -H "Content-Type: application/json" \
  -H "x-auth-token: $TOKEN" \
  -d '{"filename":"文件.txt","downloadDir":"/Users/guige/Downloads"}'
```

### 8. 设置下载目录

```bash
curl -X POST http://localhost:18790/api/config \
  -H "Content-Type: application/json" \
  -H "x-auth-token: $TOKEN" \
  -d '{"downloadDir":"/Users/guige/Downloads/ShareTool"}'
```

### 9. 删除指定文件

```bash
curl -X DELETE \
  "http://localhost:18790/api/file/文件名" \
  -H "x-auth-token: $TOKEN"
```

### 10. 删除1周前的文件

```bash
curl -X DELETE \
  "http://localhost:18790/api/delete-old?days=7" \
  -H "x-auth-token: $TOKEN"
```

### 11. 删除1月前的文件

```bash
curl -X DELETE \
  "http://localhost:18790/api/delete-old?days=30" \
  -H "x-auth-token: $TOKEN"
```

### 12. 删除所有文件

```bash
curl -X DELETE \
  http://localhost:18790/api/delete-all \
  -H "x-auth-token: $TOKEN"
```

## 配置文件

配置文件位于: `~/.share-tool/config.json`

```json
{
  "downloadDir": "/Users/guige/Downloads/ShareTool",
  "lastSync": null
}
```

## 文件存储

文件存储在: `~/.share-tool/files/`

## 注意事项

- 默认 Token: `35e7438f1e72356ebc6d4e839881cc35233ee01ec81d5af6`
- 生产环境请修改 `AUTH_TOKEN` 或通过环境变量 `SHARE_TOKEN` 设置
- 建议修改默认 Token 以确保安全

## 联系方式

### 免费 OpenClaw 和 AI 交流群

![微信群二维码](微信群二维码.jpg)

### 微信公众号

![微信公众号](微信公众号.jpg)
