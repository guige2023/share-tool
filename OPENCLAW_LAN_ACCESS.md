# OpenClaw 局域网访问配置

## 1. TLS/HTTPS 配置

OpenClaw 要求局域网访问必须使用 HTTPS（HTTP 会提示 "control ui requires device identity"）。

### 步骤一：生成自签名证书

```bash
mkdir -p ~/.openclaw/tls
openssl req -x509 -newkey rsa:2048 \
  -keyout ~/.openclaw/tls/key.pem \
  -out ~/.openclaw/tls/cert.pem \
  -days 365 -nodes \
  -subj "/CN=OpenClaw"
```

### 步骤二：修改配置文件

编辑 `~/.openclaw/openclaw.json`，在 `gateway` 部分添加 TLS 配置：

```json
"gateway": {
  "port": 18789,
  "mode": "local",
  "bind": "lan",
  "tls": {
    "enabled": true,
    "keyPath": "/Users/guige/.openclaw/tls/key.pem",
    "certPath": "/Users/guige/.openclaw/tls/cert.pem"
  },
  "controlUi": {
    "allowedOrigins": [
      "https://192.168.1.192:18789",
      "https://localhost:18789"
    ]
  },
  "auth": {
    "mode": "token",
    "token": "35e7438f1e72356ebc6d4e839881cc35233ee01ec81d5af6"
  }
}
```

**注意**：将 `192.168.1.192` 替换为实际的局域网 IP 地址。

### 步骤三：重启服务

```bash
# 停止现有服务
pkill -9 openclaw

# 重新启动
openclaw gateway --port 18789 --force &
```

### 步骤四：验证

```bash
# 本地测试
curl -k https://localhost:18789/

# 局域网测试
curl -k https://192.168.1.192:18789/
```

## 2. 批准配对请求

当从局域网设备访问时，会显示 "pairing required"。需要手动批准该设备。

### 方法一：使用 CLI 命令（可能不可用）

```bash
openclaw pairing list
openclaw pairing approve <requestId>
```

### 方法二：手动修改设备文件

#### 第一步：查看待批准的设备

```bash
cat ~/.openclaw/devices/pending.json
```

输出格式：
```json
{
  "requestId-xxx": {
    "requestId": "requestId-xxx",
    "deviceId": "deviceId-xxx",
    "publicKey": "xxx",
    "platform": "Win32",
    "clientId": "openclaw-control-ui",
    "clientMode": "webchat",
    "role": "operator",
    "roles": ["operator"],
    "scopes": ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],
    "remoteIp": "192.168.1.7",
    "ts": 1234567890
  }
}
```

#### 第二步：批准设备

```bash
node -e "
const fs = require('fs');
const crypto = require('crypto');

const pending = JSON.parse(fs.readFileSync('/Users/guige/.openclaw/devices/pending.json', 'utf8'));
const requestId = Object.keys(pending)[0];
const device = pending[requestId];

// 生成令牌
const token = crypto.randomBytes(32).toString('base64url');

// 创建已配对条目
const pairedEntry = {
  deviceId: device.deviceId,
  publicKey: device.publicKey,
  platform: device.platform,
  clientId: device.clientId,
  clientMode: device.clientMode,
  role: device.role,
  roles: device.roles,
  scopes: device.scopes,
  approvedScopes: device.scopes,
  tokens: {
    operator: {
      token: token,
      role: 'operator',
      scopes: device.scopes,
      createdAtMs: Date.now()
    }
  },
  createdAtMs: Date.now(),
  approvedAtMs: Date.now()
};

// 读取当前已配对设备
const paired = JSON.parse(fs.readFileSync('/Users/guige/.openclaw/devices/paired.json', 'utf8'));
paired[device.deviceId] = pairedEntry;

// 写入文件
fs.writeFileSync('/Users/guige/.openclaw/devices/paired.json', JSON.stringify(paired, null, 2));
fs.writeFileSync('/Users/guige/.openclaw/devices/pending.json', JSON.stringify({}));

console.log('已批准设备:', device.deviceId);
console.log('令牌:', token);
"
```

批准后，局域网设备刷新页面即可正常使用。

## 3. 相关文件路径

| 用途 | 路径 |
|------|------|
| 配置文件 | `~/.openclaw/openclaw.json` |
| TLS 证书 | `~/.openclaw/tls/cert.pem` |
| TLS 密钥 | `~/.openclaw/tls/key.pem` |
| 待批准设备 | `~/.openclaw/devices/pending.json` |
| 已批准设备 | `~/.openclaw/devices/paired.json` |
| 网关日志 | `~/.openclaw/logs/gateway.log` |
| 错误日志 | `~/.openclaw/logs/gateway.err.log` |

## 4. 常见问题

### Q: 提示 "control ui requires device identity"
A: 这是因为没有配置 TLS。需要按照本文档第一步配置 HTTPS。

### Q: 提示 "pairing required"
A: 设备未批准。按照本文档第二步批准设备。

### Q: 提示 "origin not allowed"
A: `controlUi.allowedOrigins` 中未包含该来源地址。修改配置文件添加即可。

### Q: 自签名证书不被信任
A: 在浏览器访问时选择"继续前往（不安全）"，或者将证书导入系统受信任根证书。
