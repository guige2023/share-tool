# ShareTool 完整修复与开发计划

## 状态

- 文档版本: v2
- 更新时间: 2026-05-02
- 审查来源: 专家代码审查反馈

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
│       │   ├── clipboard_api.go     # 剪贴板 API（问题最多）
│       │   ├── file_api.go         # 文件 API（Range 残缺）
│       │   ├── peers_api.go        # peer 注册（内存 map）
│       │   └── sse_api.go          # SSE 推送
│       ├── discovery/
│       │   └── mdns.go             # mDNS 发现（半残）
│       └── storage/
│           └── storage.go
├── app/ShareTool/
│   ├── Sources/                     # macOS Swift 菜单栏 App
│   └── ClipboardSync/              # Windows C# 托盘
│       └── ClipboardService.cs     # 轮询 2s（自动监听未完成）
├── web/                            # Vue SPA 前端
├── public/                         # 静态资源
└── tasks.md / jobs.md / PLAN.md  # 任务追踪文档
```

### 1.2 九大问题根因定位

| 优先级 | # | 问题 | 根因文件 | 根因代码行 | 关键问题 |
|--------|---|------|----------|-----------|---------|
| **P0** | 1 | mDNS 发现后 peers 为空 | `mdns.go` + `main.go` | `mdns.go:132-173`, `main.go:56` | `handlePacket` 只解析 query 不解析响应；callback 写 log 但 RegisterPeer 可能未传参 |
| **P0** | 2 | `forwarded` 计数不准确 | `clipboard_api.go` | `clipboard_api.go:301` | `wg.Wait()` 已修复（已同步等待），但并发写 `forwarded` 仍有竞态 |
| **P0** | 3 | 图片/文件跨设备断裂 | `clipboard_api.go` | `clipboard_api.go:54-61`, `clipboard_api.go:412-427` | `ClipboardRequest` 无 `BlobURL` 字段；接收端用 `Content` 当 blob_url 语义混乱 |
| **P1** | 4 | files 类型只传路径字符串 | `ClipboardService.cs:217`, `ClipboardManager.swift:109-114` | 编码成换行字符串或 JSON 文件名列表，不是真实文件内容 | |
| **P1** | 5 | 桌面端轮询非事件驱动 | `ClipboardService.cs:34-39`, `ClipboardManager.swift:228-232` | 2-3s 轮询 latest，非 AddClipboardFormatListener / NSPasteboard.changeCount | |
| **P2** | 6 | iOS 无法后台自动同步 | 系统限制 | - | Safari/PWA 不能无手势读写剪贴板；网页端只做手动入口 |
| **P2** | 7 | 自签 HTTPS 证书警告 | `main.go` | CN 用 IP，浏览器强警告 | 局域网工具默认 HTTP 即可 |
| **P3** | 8 | 断点续传不严格 | `file_api.go` | `file_api.go:171-209` | 无 session、无 chunk hash、无 bitmap、无原子 rename |
| **P3** | 9 | 两套架构并存 | 根目录 | `server.js`, `routes/` | Node 旧实现拖慢迭代 |

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
│  NSPasteboard       │     │  AddClipboardFormat     │
│  .changeCount 监听  │     │  Listener 监听         │
│  菜单栏托盘        │     │  托盘图标              │
│  SSE 推送接收       │     │  SSE 推送接收          │
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

### 2.3 传输决策树

```
发送方剪贴板内容
    │
    ├─ type=text ──────────────────────────────────→ 直接 POST /api/clipboard {text: "..."}
    │
    ├─ type=image ─────────────────────────────────→ 先 POST /api/blobs (base64)
    │                                                    返回 blob_url
    │                                                  → POST /api/clipboard {type:image, blob_url, sha256}
    │
    └─ type=files ──────────────────────────────────→ 对每个文件：
                                                           POST /api/blobs (分段流)
                                                           收集所有 blob_url + sha256
                                                         → POST /api/clipboard {type:files, files:[...]}
```

---

## 3. Phase 0：紧急修复（P0）

**目标**：修复后跨设备剪贴板同步从"完全不可用"变为"基础可用"。

---

### P0-F1: mDNS 设备发现 + peer 注册

**问题**：`mdns.go` 的 `handlePacket` 只解析 mDNS query，不解析 response；peer 回调只 log 未注册。

**修复文件**：`go/internal/discovery/mdns.go` + `go/main.go`

#### 改动 1: `mdns.go` — 完善响应解析

当前 `handlePacket` 只检查 `hdr.ANCOUNT > 0`，但没有真正解析 Answer 记录中的 SRV/TXT：

```go
// 旧代码 (handlePacket，约 L60-80)
if (hdr.Flags & 0x8000) != 0 && hdr.ANCOUNT > 0 {
    d.handlePacket(buf[:n], src) // 只有 log，没有解析
}

// 新代码：真正解析 Answer 中的 SRV 记录获取 port
func (d *Discovery) handleResponse(buf []byte, src *net.UDPAddr) {
    // 解析 DNS 回答部分，提取 SRV record
    // SRV 格式: _service._proto.name. TTL CLASS SRV PRIORITY WEIGHT PORT target
    offset := 12 // DNS header is 12 bytes
    for i := 0; i < int(hdr.QDCOUNT); i++ {
        // Skip question section
        name, newOffset, _ := parseMdnsName(buf, offset)
        _ = name
        offset = newOffset + 4 // skip QTYPE + QCLASS
    }

    // Now parse ANCOUNT answers
    for i := 0; i < int(hdr.ANCOUNT); i++ {
        name, offset, _ := parseMdnsName(buf, offset)
        if !strings.HasSuffix(name, "_sharetool._tcp.local.") {
            // Skip unrelated answers
            offset = skipRecord(buf, offset)
            continue
        }
        // Parse record type (2 bytes) + class (2 bytes) + TTL (4 bytes) + RDLENGTH (2 bytes)
        recType := binary.BigEndian.Uint16(buf[offset:])
        offset += 4 // type + class
        offset += 4 // TTL
        rdLen := binary.BigEndian.Uint16(buf[offset:])
        offset += 2

        if recType == 33 { // SRV record
            // Parse SRV: priority(2) + weight(2) + port(2) + target(n)
            offset += 4 // skip priority + weight
            port := binary.BigEndian.Uint16(buf[offset:])
            offset += 2
            target, _, _ := parseMdnsName(buf, offset)
            offset += rdLen - 6

            peer := Peer{
                IP:   src.IP.String(),
                Port: int(port),
                Name: strings.TrimSuffix(target, "."),
            }
            d.onDiscover(peer)
        } else {
            offset += int(rdLen)
        }
    }
}
```

#### 改动 2: `mdns.go` — 定期发送 query 并注册自身

```go
// 旧：只发一次 announcement
// 新：定期 query + 自己 advertise
func (d *Discovery) Start(onDiscover func(Peer)) error {
    d.onDiscover = onDiscover

    // 定期查询
    ticker := time.NewTicker(30 * time.Second)
    go func() {
        d.sendQuery()
        for {
            select {
            case <-ticker.C:
                d.sendQuery()
            case <-d.done:
                ticker.Stop()
                return
            }
        }
    }()

    // 同时 advertise 自己
    go d.advertiseSelf()

    return d.readLoop()
}

func (d *Discovery) advertiseSelf() {
    // 每 60s 广播一次 SRV record 声明自己
    // 用 Miekg/dns 或纯手写 mDNS response packet
}
```

#### 改动 3: `main.go` — callback 传递完整信息

```go
// 现有代码已调用 server.RegisterPeer，但 peer.Name 可能为空
// 需要在 mDNS 解析时从 TXT record 或 SRV target 提取 instance name
```

**验收标准**：两台设备运行 `./sharetool`，日志显示 `[mDNS] Discovered peer: 192.168.x.x:18793`，`/api/peers` 返回对方设备。

---

### P0-F2: `forwarded` 并发计数修复

**问题**：`clipboard_api.go:289` 的 `forwarded++` 在 goroutine 内，有竞态；且 `peers` 在遍历中被 `delete`。

**修复文件**：`go/internal/server/clipboard_api.go` (L271-308)

```go
// 旧代码
go func(k string, p Peer) {
    defer wg.Done()
    if err := forwardClipboardToPeer(p, entry); err != nil {
        peersMu.Lock()
        delete(peers, k)  // 遍历中修改 map
        peersMu.Unlock()
    } else {
        mu.Lock()
        forwarded++  // 竞态
        mu.Unlock()
        // ...
    }
}(key, peer)

// 新代码：先收集所有 peer 快照，串行处理失败删除
peersMu.RLock()
peerList := make([]Peer, 0, len(peers))
for _, p := range peers {
    if p.IP == instanceIP && p.Port == instancePort {
        continue
    }
    peerList = append(peerList, p)
}
peersMu.RUnlock()

// 逐个转发，失败才删除（不在遍历中修改）
for _, p := range peerList {
    wg.Add(1)
    go func(peer Peer) {
        defer wg.Done()
        if err := forwardClipboardToPeer(peer, entry); err != nil {
            // 删除失败的 peer（单独加锁）
            peersMu.Lock()
            key := fmt.Sprintf("%s:%d", peer.IP, peer.Port)
            delete(peers, key)
            peersMu.Unlock()
        } else {
            mu.Lock()
            forwarded++
            mu.Unlock()
        }
    }(p)
}
wg.Wait()
```

**验收标准**：`forwarded` 返回值准确匹配实际成功转发数量；在无 peers 时返回 0。

---

### P0-F3: 图片/文件剪贴板协议修复

**问题**：`ClipboardRequest` 缺少 `BlobURL` 字段；接收端用 `Content` 字段同时承载"文本内容"和"blob 下载 URL"两种语义，混乱。

**修复文件**：`go/internal/server/clipboard_api.go`

#### 改动 1: `ClipboardRequest` 增加 `BlobURL`

```go
// 旧
type ClipboardRequest struct {
    Type      string     `json:"type"`
    Content   string     `json:"content"` // text OR base64 image
    From      string     `json:"from"`
    Timestamp int64      `json:"timestamp"`
    EntryID   string     `json:"entry_id,omitempty"`
    Files     []FileMeta `json:"files,omitempty"`
}

// 新
type ClipboardRequest struct {
    Type      string     `json:"type"`
    Content   string     `json:"content"`        // text content (type=text)
    From      string     `json:"from"`
    Timestamp int64      `json:"timestamp"`
    EntryID   string     `json:"entry_id,omitempty"`
    BlobURL   string     `json:"blob_url,omitempty"` // 接收图片/文件时的下载 URL
    Files     []FileMeta `json:"files,omitempty"`    // type=files 时完整文件列表
}
```

#### 改动 2: `handleClipboardPost` — 发送逻辑

```go
// 发送图片时：小图（<512KB）直接 base64 随 content 发送；
// 大图（>=512KB）先 POST /api/blobs，再用 blob_url 发送给 peers
// 已经在 blob 逻辑中存在（blobStore.Save），只需确保转发时携带 blob_url
// 确认 forwardClipboardToPeer 已传递 entry.BlobURL（已实现）
```

#### 改动 3: `handleClipboardReceive` — 接收逻辑

```go
// 旧逻辑（混乱）
blobURL := req.Content // backward compat
if blobURL == "" {
    blobURL = req.Content  // 自己赋值给自己，无意义
}

// 新逻辑：优先用 BlobURL，否则用 Content
targetContent := req.Content
if req.BlobURL != "" {
    // 通过 blob_url 下载真实内容
    blobResp, err := forwardClient.Get(req.BlobURL)
    if err == nil && blobResp.StatusCode == 200 {
        data, _ := io.ReadAll(blobResp.Body)
        blobResp.Body.Close()
        targetContent = base64.StdEncoding.EncodeToString(data)
    }
}

// 写入剪贴板时使用 targetContent
```

**验收标准**：发送一张 1MB 图片到另一台设备，对端收到并能正确渲染。

---

## 4. Phase 1：核心同步重构（P1）

### P1-F4: 统一剪贴板协议 v2（Windows/macOS 客户端适配）

**修复文件**：
- `app/ShareTool/ClipboardSync/ClipboardService.cs`
- `app/ShareTool/Sources/ClipboardManager.swift`

**改动**：

```csharp
// ClipboardService.cs — 接收推送时的处理
// 旧：用 Content 当文件路径
// 新：用 BlobURL 下载，或用 Files 数组
if (!string.IsNullOrEmpty(entry.BlobUrl))
{
    // 下载 blob
    var bytes = await client.GetByteArrayAsync(entry.BlobUrl);
    // 根据 mime 类型写入剪贴板
}
```

### P1-F5: macOS 剪贴板变更监听

**修复文件**：`app/ShareTool/Sources/ClipboardManager.swift`

**问题**：Swift 用 3s 轮询 `latest`，应该用 `NSPasteboard.changeCount`。

```swift
// 旧
Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { _ in
    self.pollLatest()
}

// 新：CFRunLoopSource 监听 changeCount
class ClipboardMonitor {
    private var lastChangeCount: Int = 0

    func start() {
        let mask = (1 << NSPasteboard.ChangeCount)
        CFRunLoopAddSource(
            CFRunLoopGetCurrent(),
            CGSocketCreateRunLoopSource(kCGSessionID, socket, 0)!,
            .commonModes
        )
    }
}
```

### P1-F6: Windows 托盘右键菜单重构（紧急修复 ContextMenuStrip 死锁）

**修复文件**：`app/ShareTool/ClipboardSync/Program.cs`

**问题**：右键托盘图标有时无响应，原因是 `ContextMenuStrip` 的 `TrackPopupMenuEx` 在 `_hiddenForm.CreateControl()` 触发的消息循环中和 WinForms 内部菜单系统死锁。

**解决方案**：换用原生 `ContextMenu` + `TrackPopupMenu`，完全绕开 WinForms 菜单：

```csharp
// 旧：ContextMenuStrip（会触发 WinForms 内部消息循环）
_contextMenuStrip = new ContextMenuStrip();
_contextMenuStrip.Items.Add(...);
_notifyIcon.ContextMenuStrip = _contextMenuStrip;

// 新：原生 ContextMenu + TrackPopupMenu（无 WinForms 消息循环干扰）
_contextMenu = new ContextMenu();
_contextMenu.MenuItems.Add(...);
_notifyIcon.ContextMenu = _contextMenu;
// 右键点击时由 WndProc 中的 NM_RBUTTONDOWN 触发
```

### P1-F7: WebSocket/SSE 推送替代轮询

**修复文件**：`go/internal/server/server.go` + `go/internal/server/sse_api.go`

**新增 SSE endpoint**：`GET /api/clipboard/stream`

```go
// sse_api.go
type SSEServer struct {
    clients map[string]chan<- ClipboardEntry
    mu      sync.RWMutex
}

func (s *SSEServer) HandleStream(w http.ResponseWriter, r *http.Request) {
    deviceID := r.URL.Query().Get("device_id")

    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")

    ch := make(chan ClipboardEntry, 10)
    s.AddClient(deviceID, ch)
    defer s.RemoveClient(deviceID)

    flusher, _ := w.(http.Flusher)

    // Send heartbeat every 30s
    heartbeat := time.NewTicker(30 * time.Second)
    defer heartbeat.Stop()

    for {
        select {
        case entry := <-ch:
            data, _ := json.Marshal(entry)
            fmt.Fprintf(w, "event: clipboard\ndata: %s\n\n", data)
            flusher.Flush()
        case <-heartbeat.C:
            fmt.Fprintf(w, ": heartbeat\n\n")
            flusher.Flush()
        case <-r.Context().Done():
            return
        }
    }
}
```

---

## 5. Phase 2：文件极速传输（P2）

### P2-F8: 严格断点续传（Upload Session）

**修复文件**：`go/internal/server/file_api.go`

**问题**：当前 `PUT /files/:name` 只解析 Content-Range 起点写入，无 session 管理、无 chunk 校验。

**新增 API**：

```
POST /api/uploads          → 创建 upload session，返回 upload_id
PUT  /api/uploads/:id/chunks/:index → 上传单个 chunk（带 x-chunk-sha256）
GET  /api/uploads/:id/status → 查询已收到 chunks bitmap
POST /api/uploads/:id/complete → 校验总 hash，原子 rename
DELETE /api/uploads/:id      → 取消上传
```

**Chunk 格式**：
```
Header: x-chunk-sha256: <sha256-hex>
Body: chunk binary data
```

**Session 存储**：
```go
type UploadSession struct {
    ID        string            // upload UUID
    Filename  string            // 原始文件名
    TotalSize int64             // 总大小
    ChunkSize int64             // chunk 大小（默认 1MB）
    TotalHash string            // 最终 SHA256（可选，客户端可先传）
    Received  map[int]bool      // bitmap: chunk index → 是否收到
    TempPath  string            // 临时文件路径
    CreatedAt time.Time
    UpdatedAt time.Time
}
```

**服务端写入**：
1. `POST /api/uploads`：创建 session，写入 `~/.sharetool/uploads/sessions/:id.json`
2. `PUT /api/uploads/:id/chunks/:index`：追加写入临时文件，更新 bitmap
3. `POST /api/uploads/:id/complete`：读取临时文件，校验 SHA256，`os.Rename` 原子移到 `shared/`
4. 超时清理：7 天未完成的 session 自动删除

### P2-F9: 多文件下载 zip stream

**问题**：多文件下载时逐个触发浏览器下载。

**新增**：`GET /api/files/archive?files=name1,name2`

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

**目标**：扫码即用、文件快速传、文本/剪贴板半自动、一键复制/粘贴。

**不做**：
- 后台自动剪贴板同步（iOS 系统限制，不可行）
- 无用户手势自动写剪贴板

**实现**：
- PWA `manifest.json` + Service Worker（离线缓存）
- Share Sheet 入口（Web Share Target API，Android）
- `navigator.clipboard.readText()` / `navigator.clipboard.writeText()`（需要用户手势触发）
- 扫码配对：显示本机二维码（IP:Port），扫码后自动注册到对端

### P3-F11: HTTPS 方案调整

**问题**：自签证书在 iOS/Android 浏览器强警告，影响 PWA/Service Worker/mDNS。

**方案**：默认 HTTP 模式。macOS/Windows 原生 App 因是桌面端，可用自签。移动端只用 HTTP。

```go
// main.go
// 移除 --https 标志的自动证书生成逻辑
// 默认 :18793 HTTP
// --local-https 仅用于本机调试（localhost）
```

---

## 7. Phase 4：架构清理（P4）

### P4-F12: 移除 Node.js 旧实现

**待清理文件/目录**：
- `server.js`
- `routes/`
- `helpers/clipboard_helper.py`（已由 Swift 替代）
- 根目录其他 Node 相关文件

**保留可迁移能力**：
- `public/` 目录（静态资源）
- SQLite 旧数据（可选迁移脚本）

### P4-F13: Go module 整理

```
go/
├── main.go
├── go.mod / go.sum
└── internal/
    ├── server/
    │   ├── server.go
    │   ├── clipboard_api.go
    │   ├── clipboard_api_test.go   # 新增单元测试
    │   ├── file_api.go
    │   ├── file_api_test.go       # 新增单元测试
    │   ├── peers_api.go
    │   ├── sse_api.go             # 新增
    │   └── blob_api.go            # 新增（从 clipboard_api 拆分）
    ├── discovery/
    │   ├── mdns.go
    │   └── mdns_test.go           # 新增单元测试
    └── storage/
        └── storage.go
```

---

## 8. 实施顺序与依赖

```
Week 1-2: P0-F1 (mDNS) + P0-F3 (clipboard 协议)
    ↓
Week 3:   P0-F2 (forwarded 计数) + P1-F6 (Windows 托盘修复)
    ↓
Week 4:   P1-F4 (协议 v2 客户端适配) + P1-F5 (macOS changeCount)
    ↓
Week 5-6: P1-F7 (SSE 推送) + P2-F8 (Upload Session)
    ↓
Week 7:   P2-F9 (zip stream) + P3-F10 (PWA)
    ↓
Week 8:   P4-F12 (Node 清理) + P4-F13 (测试覆盖)
```

---

## 9. 验收标准

| 功能 | 验收条件 |
|------|---------|
| mDNS 发现 | 两台设备运行 sharetool，日志显示 `Discovered peer`，`/api/peers` 返回对方 |
| 文本跨设备 | 设备 A 复制文本，设备 B 剪贴板自动更新（无需按键） |
| 图片跨设备 | 1MB PNG 从 A 传到 B，B 能正确渲染显示 |
| 文件传输 | 100MB 文件支持断点续传，模拟断网 50% 后恢复下载 |
| SSE 推送 | 设备 A 发送后，设备 B 在 500ms 内收到更新（无轮询） |
| Windows 托盘 | 右键托盘图标，菜单 100% 弹出，无死锁 |
| macOS 菜单栏 | 复制内容后 1s 内，菜单栏历史列表更新 |
| iOS Web | Safari 打开页面，点击"粘贴发送"，成功发送到其他设备 |
| PWA | 添加到主屏幕，离线状态下仍可查看历史记录 |
