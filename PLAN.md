# ShareTool 完整修复与开发计划

## 状态

- 文档版本: v3
- 更新时间: 2026-05-03
- 审查来源: 专家代码审查反馈 + 当前问题追踪

## 审查结论摘要

项目方向正确，架构设计合理。核心问题集中于 9 个，分 3 个优先级。最紧迫的是 **P0-1 mDNS peers 注册**、**P0-2 forwarded 计数** 和 **P0-3 图片/文件协议断裂**，这三处直接决定"跨设备自动同步"是否真实可用。

---

## 1. 现状分析

### 1.1 项目结构

```
share-tool/
├── go/                              # Go Core Server（主线）
│   ├── main.go                      # CLI 入口
│   └── internal/
│       ├── server/
│       │   ├── server.go            # HTTP mux, CORS, embed
│       │   ├── clipboard_api.go     # 剪贴板 API
│       │   ├── file_api.go         # 文件 API（Range 残缺）
│       │   ├── peers_api.go        # peer 注册（内存 map）
│       │   └── sse_api.go          # SSE 推送
│       ├── discovery/
│       │   └── mdns.go             # mDNS 发现（已完善）
│       └── storage/
│           └── storage.go
├── app/ShareTool/
│   ├── Sources/                     # macOS Swift 菜单栏 App
│   └── ClipboardSync/              # Windows C# 托盘
│       ├── Program.cs               # 托盘主程序
│       ├── ClipboardService.cs      # 剪贴板监控 + SSE 推送
│       └── Models.cs                # 数据模型
├── web/                            # Vue SPA 前端（规划中）
├── public/                         # 静态资源
└── tasks.md / jobs.md / PLAN.md  # 任务追踪文档
```

### 1.2 九大问题根因定位（已全部处理）

| 优先级 | # | 问题 | 状态 | 根因文件 |
|--------|---|------|------|---------|
| **P0** | 1 | mDNS 发现后 peers 为空 | 已修复 | `mdns.go` advertiseLoop 调用 |
| **P0** | 2 | `forwarded` 计数不准确 | 已修复 | `clipboard_api.go` peer snapshot |
| **P0** | 3 | 图片/文件跨设备断裂 | 已修复 | `ClipboardRequest.BlobURL` 字段 |
| **P1** | 4 | files 类型只传路径字符串 | 已修复 | blob upload + FileMeta 数组 |
| **P1** | 5 | 桌面端轮询非事件驱动 | 已修复 | HiddenClipboardWindow + NSPasteboard |
| **P2** | 6 | iOS 无法后台自动同步 | 已知限制 | 产品策略：半自动模式 |
| **P2** | 7 | 自签 HTTPS 证书警告 | 待优化 | 默认 HTTP 即可 |
| **P3** | 8 | 断点续传不严格 | 已修复 | upload session + chunk hash |
| **P3** | 9 | 两套架构并存 | 已修复 | Node.js 已删除 |

### 1.3 当前阻塞问题（S1-S3）

| ID | 问题 | 根因 | 修复文件 |
|----|------|------|---------|
| S1-win-autosend | Windows 自动发送失效 | HiddenClipboardWindow WM_CLIPBOARDUPDATE 消息机制在托盘 App 无消息循环 | ClipboardService.cs |
| S2-win-sent-count | 显示"已发送设备 0 个" | forwarded == 0 时通知文案误导 | ClipboardService.cs + Program.cs |
| S3-history-empty | Windows 剪贴板历史为空 | URL 错误：`/api/clipboard` 应为 `/api/clipboard/history` | Program.cs L286 |

---

## 2. 目标架构

### 2.1 三层架构

```
┌─────────────────────────────────────────────────────┐
│                  Mobile Web/PWA                      │
│   iOS Safari + Android Chrome (免安装, 扫码即用)       │
│   Share Sheet 入口 / 手动粘贴 / 文件上传下载           │
└────────────────────────┬────────────────────────────┘
                         │ HTTP/WebSocket
                         ▼
┌─────────────────────────────────────────────────────┐
│              Go Core Server (单二进制)                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ mDNS     │ │ 传输引擎   │ │ Web UI   │            │
│  │ 设备发现  │ │ clipboard│ │ (SPA)    │            │
│  │ + peer   │ │ 文件     │ │          │            │
│  │ 注册     │ │ 推送     │ │          │            │
│  └──────────┘ └──────────┘ └──────────┘            │
│                                                      │
│  SSE 推送 ← 实时推送新剪贴板事件                      │
│  统一协议: entry_id, device_id, type, mime,          │
│            text, files[], blob_url, sha256            │
└────────────────────────┬────────────────────────────┘
                         │ 局域网 HTTP
          ┌──────────────┴──────────────┐
          ▼                             ▼
┌─────────────────────┐     ┌─────────────────────────┐
│  macOS Native Agent │     │  Windows Native Agent    │
│  NSPasteboard       │     │  HiddenClipboardWindow  │
│  .changeCount 监听  │     │  AddClipboardFormat     │
│  菜单栏托盘        │     │  Listener (fallback:    │
│  SSE 推送接收       │     │  Timer polling)        │
│                     │     │  托盘图标              │
└─────────────────────┘     └─────────────────────────┘
```

### 2.2 统一剪贴板协议（Protocol v2）

```json
// ClipboardEntry v2
{
  "entry_id": "abc123def456",
  "device_id": "Mac-mini.local",
  "type": "text" | "image" | "files",
  "mime": "text/plain" | "image/png" | "application/pdf",
  "text": "hello world",
  "files": [
    {
      "name": "report.pdf",
      "size": 1048576,
      "sha256": "abc123...",
      "blob_url": "/api/blobs/abc123",
      "mime": "application/pdf"
    }
  ],
  "blob_url": "/api/blobs/xyz789",
  "sha256": "xyz789...",
  "from": "Mac-mini",
  "timestamp": 1713001234567
}
```

---

## 3. 当前任务（S1-S3）

### S1-win-autosend: Windows 自动发送 — Timer 替代/保护 HiddenClipboardWindow

**问题**: `HiddenClipboardWindow` 的 `WM_CLIPBOARDUPDATE` 消息机制在托盘 App 场景下可能失效（无消息循环或权限问题），导致剪贴板变更无法被事件驱动捕获。

**修复文件**: `app/ShareTool/ClipboardSync/ClipboardService.cs`

**方案**: 对 HiddenClipboardWindow + AddClipboardFormatListener 做健壮性保护：
1. 尝试调用 `AddClipboardFormatListener(_hiddenWindow.Handle)`
2. 若返回 `false` 或 5 秒内未收到任何 `WM_CLIPBOARDUPDATE`，自动降级到 `Timer` + `GetClipboardSequenceNumber` 轮询（间隔 500ms）
3. Timer 轮询中发现序列号变化才触发发送，避免空转

**关键代码改动**:
```csharp
// 现状: Start() 中创建 HiddenClipboardWindow 并注册 AddClipboardFormatListener
// 新增: 若 AddClipboardFormatListener 失败，启用 PollingTimer
private System.Threading.Timer? _pollingTimer;
private const int PollingIntervalMs = 500;

private void StartPollingFallback()
{
    _lastClipboardSequenceNumber = GetClipboardSequenceNumber();
    _pollingTimer = new System.Threading.Timer(_ =>
    {
        var seq = GetClipboardSequenceNumber();
        if (seq != _lastClipboardSequenceNumber)
        {
            _lastClipboardSequenceNumber = seq;
            OnClipboardUpdate();
        }
    }, null, PollingIntervalMs, PollingIntervalMs);
}
```

**验收**: 在 Windows 上复制任意内容，1 秒内托盘 App 自动发送到服务器，托盘菜单历史同步更新。

---

### S2-win-sent-count: 发送通知不显示"设备 0 个"

**问题**: `OnSent?.Invoke(this, (result?.forwarded ?? 0, null))` 当 peers 为空时 `forwarded = 0`，但通知仍显示"已发送设备 0 个"，体验误导。

**修复文件**: `app/ShareTool/ClipboardSync/Program.cs` (OnSent 处理)

**方案**: 修改 `OnSent` 处理逻辑——当 `Count == 0` 时显示"已发送至服务器"，`Count > 0` 时显示"已发送至 N 台设备"。

```csharp
// 旧
ShowNotification("剪贴板已发送", "服务器已接收");

// 新
if (result.Count == 0)
    ShowNotification("剪贴板已发送", "已发送至服务器");
else
    ShowNotification("剪贴板已发送", $"已发送至 {result.Count} 台设备");
```

**验收**: 无 peers 时托盘通知显示"已发送至服务器"，不显示"0"。

---

### S3-history-empty: Windows 剪贴板历史为空

**问题**: `Program.cs:286` 调用 `GET /api/clipboard` (POST 端点)，URL 错误导致历史获取失败。

**修复文件**: `app/ShareTool/ClipboardSync/Program.cs` (L286)

**验证 Go 端**: 确认 `GET /api/clipboard/history` 返回格式：
```go
// go/internal/server/clipboard_api.go
type ClipboardHistoryResponse struct {
    Entries []ClipboardEntry `json:"entries"`
}
```

```csharp
// 旧
var resp = await client.GetAsync($"{url}/api/clipboard");

// 新
var resp = await client.GetAsync($"{url}/api/clipboard/history");
```

**验收**: Windows 托盘菜单"剪贴板历史"能显示最近 15 条记录。

---

## 4. Phase 1：核心同步重构（P1）— 已完成

### P1-F4: 统一剪贴板协议 v2（Windows/macOS 客户端适配）— 已完成

- `ClipboardRequest` 新增 `BlobURL` 字段
- `handleClipboardReceive` 通过 `forwardClient.Get(req.BlobURL)` 获取 blob 内容
- Windows C# `DownloadFilesAndSetClipboard` 方法实现
- macOS Swift `sendFilesClipboard` 先上传 blob 再发送 FileMeta 数组

### P1-F5: macOS 剪贴板变更监听 — 已完成

- 使用 `NSPasteboard.changeCount` 轮询检测变更（3s 间隔）
- 变更时自动调用 `SendSystemClipboard()`

### P1-F6: Windows 托盘右键菜单重构 — 已完成

- `ContextMenuStrip` 改为原生 `ContextMenu` + `TrackPopupMenu`
- 解决右键死锁问题

### P1-F7: SSE 推送 — 已完成

- `GET /api/clipboard/stream` 端点实现
- macOS Swift 和 Windows C# 均已连接 SSE

---

## 5. Phase 2：文件极速传输（P2）

### P2-F8: 严格断点续传（Upload Session）— 已完成

**新增 API**:
```
POST /api/uploads          → 创建 upload session，返回 upload_id
PUT  /api/uploads/:id/chunks/:index → 上传单个 chunk（带 x-chunk-sha256）
GET  /api/uploads/:id/status → 查询已收到 chunks bitmap
POST /api/uploads/:id/complete → 校验总 hash，原子 rename
DELETE /api/uploads/:id      → 取消上传
```

### P2-F9: 多文件下载 zip stream — 待实现

**新增**: `GET /api/files/archive?files=name1,name2`

```go
// 服务端流式压缩，Content-Type: application/zip
zipWriter := zip.NewWriter(w)
for _, name := range files {
    f, _ := os.Open(filepath.Join(sharedDir, name))
    w, _ := zipWriter.Create(name)
    io.Copy(w, f)
}
zipWriter.Close()
```

---

## 6. Phase 3：移动端体验（P3）

### P3-F10: iOS/Android PWA 入口

**目标**: 扫码即用、文件快速传、文本/剪贴板半自动、一键复制/粘贴。

**不做**:
- 后台自动剪贴板同步（iOS 系统限制，不可行）
- 无用户手势自动写剪贴板

**实现**:
- PWA `manifest.json` + Service Worker（离线缓存）
- Share Sheet 入口（Web Share Target API，Android）
- `navigator.clipboard.readText()` / `navigator.clipboard.writeText()`（需要用户手势触发）
- 扫码配对：显示本机二维码（IP:Port），扫码后自动注册到对端

### P3-F11: HTTPS 方案调整

**方案**: 默认 HTTP 模式。macOS/Windows 原生 App 因是桌面端，可用自签。移动端只用 HTTP。

---

## 7. 实施顺序

```
Week 1: S1-win-autosend (Timer fallback) + S2-win-sent-count
    ↓
Week 2: S3-history-empty + zip stream (P2-F9)
    ↓
Week 3: PWA 入口 (P3-F10) + HTTPS 调整 (P3-F11)
```

---

## 8. 验收标准

| 功能 | 验收条件 |
|------|---------|
| S1 Windows 自动发送 | 复制内容后 1 秒内托盘 App 自动发送，菜单历史更新 |
| S2 发送通知 | 无 peers 时显示"已发送至服务器"，有 peers 时显示设备数量 |
| S3 历史记录 | 托盘菜单"剪贴板历史"显示最近 15 条记录 |
| mDNS 发现 | 两台设备运行 sharetool，日志显示 `Discovered peer`，`/api/peers` 返回对方 |
| 文本跨设备 | 设备 A 复制文本，设备 B 剪贴板自动更新（无需按键） |
| 图片跨设备 | 1MB PNG 从 A 传到 B，B 能正确渲染显示 |
| 文件传输 | 100MB 文件支持断点续传 |
| SSE 推送 | 设备 A 发送后，设备 B 在 500ms 内收到更新（无轮询） |
| Windows 托盘 | 右键托盘图标，菜单 100% 弹出，无死锁 |
| macOS 菜单栏 | 复制内容后 1s 内，菜单栏历史列表更新 |
| iOS Web | Safari 打开页面，点击"粘贴发送"，成功发送到其他设备 |
