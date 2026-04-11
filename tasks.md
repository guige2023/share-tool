# ShareTool Go 重写开发任务书

## 1. Project Context & Goals

ShareTool 是一个**极简局域网分享工具**，核心理念：
- **极致轻量**：单二进制，零依赖，<20MB 内存
- **零配置**：./sharetool 直接跑，无需任何设置
- **绝对信任**：局域网内无认证、无密码、无 PIN，即连即用
- **大文件支持**：HTTP Range 断点续传，不限文件大小
- **AI Agent 友好**：规范 REST API，curl / wget 直接调用

### 现状分析

当前存在一个 Node.js 版本（~/.share-tool/），有严重过度设计问题：
- ❌ SQLite 依赖（背离轻量原则）
- ❌ Token 认证（背离零信任原则）
- ❌ 自签名 HTTPS（每次访问要点"继续前往"）
- ❌ npm 依赖树（背离单二进制原则）
- ❌ mDNS 未实现
- ❌ 大量假功能（API 存在但返回值报错）

本次任务：用 Go 从零按 ROADMAP Phase A 重写，实现真正可用的 MVP。

---

## 2. Tech Stack

- **Backend**：Go 1.21+，标准库 `net/http`，不用 Gin/Echo 等框架
- **Frontend**：原生 HTML5 + Vanilla JS，无任何框架
- **存储**：文件系统存文件，内存存文本剪贴板（可选 JSON 持久化）
- **打包**：`//go:embed` 将前端打进二进制，一行 `go build` 出单个可执行文件
- **依赖**：**零外部依赖**（不用 mdns 库，用纯 Go /dev/udp 实现 mDNS 广播）

---

## 3. 项目结构

```
sharetool/                          # Go module root
├── go.mod
├── go.sum
├── main.go                         # 入口：CLI 解析、启动 server
├── internal/
│   ├── server/
│   │   ├── server.go              # HTTP mux、路由注册、embed 挂载
│   │   ├── file_api.go            # 文件上传/下载（Range 支持）
│   │   └── text_api.go            # 文本剪贴板（内存 + 可选 JSON 持久化）
│   ├── storage/
│   │   └── storage.go             # 文件元数据管理（内存索引，无 SQLite）
│   └── discovery/
│       └── mdns.go                # mDNS 局域网广播（纯 Go 实现）
└── web/
    └── index.html                 # Web UI（打包进二进制）
```

---

## 4. API 设计（必须精确实现）

### 4.1 文本分享

**POST /api/text**
- Request: `{"content": "string"}`
- Response: `{"success": true}`

**GET /api/text/latest**
- Response: `{"content": "string", "timestamp": 1712345678000}` （Unix 毫秒）

---

### 4.2 文件分享

**GET /api/files**
- Response:
```json
{
  "files": [
    {
      "name": "report.pdf",
      "size": 1048576,
      "createdAt": 1712345678000,
      "updatedAt": 1712345678000
    }
  ]
}
```

**PUT /api/files/:filename**
- 支持流式写入磁盘（不缓冲整个文件到内存）
- 支持 `Content-Range: bytes START-END/TOTAL` 实现断点续传
- 无 Content-Range 时视为完整文件覆盖
- URL 编码文件名安全处理（拒绝 `..` 路径穿越）
- Response: `{"success": true, "size": 1048576}`

**GET /api/files/:filename**
- 使用 `http.ServeContent` Serve 文件（自动处理 Range、ETag、Last-Modified）
- 支持 `Accept-Ranges: bytes`
- URL 编码文件名安全处理
- 无认证，任何设备可下载

**DELETE /api/files/:filename**
- Response: `{"success": true}`

---

### 4.3 分享链接（Phase B 预留，当前不实现）

当前 MVP **不实现**分享链接、二维码、密码保护等功能。这些是 Phase B 的特性。

---

## 5. 各模块实现要求

### 5.1 main.go

```go
package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"sharetool/internal/discovery"
	"sharetool/internal/server"
)

func main() {
	port := flag.Int("port", 18790, "Port to run the server on")
	dir := flag.String("dir", "./shared", "Directory to store and share files")
	flag.Parse()

	// Create shared directory if not exists
	if err := os.MkdirAll(*dir, 0755); err != nil {
		log.Fatalf("Failed to create share directory: %v", err)
	}

	// Start mDNS broadcast in background
	go func() {
		if err := discovery.Start(*port); err != nil {
			log.Printf("mDNS broadcast failed: %v (non-fatal)", err)
		}
	}()

	// Setup HTTP router
	router := server.SetupRouter(*dir)

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("ShareTool running on http://0.0.0.0%s", addr)
	log.Printf("Sharing directory: %s", *dir)

	if err := router.Run(addr); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
```

---

### 5.2 internal/server/server.go

```go
package server

import (
	"embed"
	"io/fs"
	"net/http"

	"sharetool/internal/server/file_api"
	"sharetool/internal/server/text_api"
)

//go:embed all:../../web
var webAssets embed.FS

func SetupRouter(sharedDir string) *http.ServeMux {
	mux := http.NewServeMux()

	// Text API
	mux.HandleFunc("POST /api/text", text_api.HandlePost)
	mux.HandleFunc("GET /api/text/latest", text_api.HandleLatest)

	// File API
	mux.HandleFunc("GET /api/files", file_api.HandleList(sharedDir))
	mux.HandleFunc("PUT /api/files/{name...}", file_api.HandlePut(sharedDir))
	mux.HandleFunc("GET /api/files/{name...}", file_api.HandleGet(sharedDir))
	mux.HandleFunc("DELETE /api/files/{name...}", file_api.HandleDelete(sharedDir))

	// Serve embedded web UI
	webRoot, _ := fs.Sub(webAssets, "web")
	mux.Handle("/", http.FileServer(http.FS(webRoot)))

	return mux
}
```

**注意**：Go 1.22+ 才支持 `HandleFunc("METHOD /path", handler)` 精确路由匹配。  
若使用 Go 1.21，用 `http.MethodPost + "/api/text"` 分开注册：

```go
mux.HandleFunc("/api/text", func(w http.ResponseWriter, r *http.Request) {
    if r.Method == http.MethodPost { text_api.HandlePost(w, r) }
})
```

---

### 5.3 internal/server/file_api.go

```go
package file_api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"sharetool/internal/storage"
)

// HandleList returns file listing
func HandleList(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		files, err := storage.ListFiles(sharedDir)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"files": files})
	}
}

// HandlePut handles file upload with Range support for resume
func HandlePut(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := filepath.Base(r.PathValue("name"))
		if name == "" || strings.Contains(name, "..") {
			http.Error(w, "Invalid filename", 400)
			return
		}

		fpath := filepath.Join(sharedDir, name)
		offset := int64(0)

		// Parse Content-Range for resume
		if cr := r.Header.Get("Content-Range"); cr != "" {
			// Format: "bytes START-END/TOTAL"
			if n, err := parseContentRangeStart(cr); err == nil {
				offset = n
				f, err := os.OpenFile(fpath, os.O_CREATE|os.O_WRONLY, 0644)
				if err != nil {
					http.Error(w, err.Error(), 500)
					return
				}
				f.Seek(offset, io.SeekStart)
				io.Copy(f, r.Body)
				f.Close()
				fi, _ := os.Stat(fpath)
				w.WriteHeader(http.StatusOK)
				json.NewEncoder(w).Encode(map[string]any{"success": true, "size": fi.Size(), "offset": offset})
				return
			}
		}

		// Full file write
		f, err := os.Create(fpath)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer f.Close()
		io.Copy(f, r.Body)
		fi, _ := os.Stat(fpath)
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]any{"success": true, "size": fi.Size()})
	}
}

// HandleGet serves file with Range support
func HandleGet(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := filepath.Base(r.PathValue("name"))
		if name == "" || strings.Contains(name, "..") {
			http.Error(w, "Invalid filename", 400)
			return
		}
		fpath := filepath.Join(sharedDir, name)
		f, err := os.Open(fpath)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		fi, _ := f.Stat()
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		http.ServeContent(w, r, name, fi.ModTime(), f)
	}
}

// HandleDelete removes a file
func HandleDelete(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := filepath.Base(r.PathValue("name"))
		if name == "" || strings.Contains(name, "..") {
			http.Error(w, "Invalid filename", 400)
			return
		}
		fpath := filepath.Join(sharedDir, name)
		if err := os.Remove(fpath); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"success": true})
	}
}

// parseContentRangeStart extracts the start offset from Content-Range header
func parseContentRangeStart(cr string) (int64, error) {
	// "bytes START-END/TOTAL"
	parts := strings.Split(strings.TrimPrefix(cr, "bytes "), "-")
	if len(parts) != 2 {
		return 0, nil
	}
	var start int64
	fmt.Sscanf(parts[0], "%d", &start)
	return start, nil
}
```

---

### 5.4 internal/server/text_api.go

```go
package text_api

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

var (
	latest    = ""
	updatedAt int64 = 0
	mu        sync.RWMutex
)

// HandlePost writes new text content
func HandlePost(w http.ResponseWriter, r *http.Request) {
	var req struct{ Content string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	mu.Lock()
	latest = req.Content
	updatedAt = time.Now().UnixMilli()
	mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// HandleLatest returns the latest text
func HandleLatest(w http.ResponseWriter, r *http.Request) {
	mu.RLock()
	c, t := latest, updatedAt
	mu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"content":    c,
		"timestamp": t,
	})
}
```

---

### 5.5 internal/storage/storage.go

```go
package storage

import (
	"os"
	"path/filepath"
	"sort"
	"time"
)

type FileInfo struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

func ListFiles(dir string) ([]FileInfo, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []FileInfo
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, FileInfo{
			Name:      e.Name(),
			Size:      fi.Size(),
			CreatedAt: fi.ModTime().UnixMilli(),
			UpdatedAt: fi.ModTime().UnixMilli(),
		})
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].UpdatedAt > files[j].UpdatedAt
	})
	return files, nil
}
```

---

### 5.6 internal/discovery/mdns.go（纯 Go 实现，零依赖）

```go
package discovery

import (
	"bytes"
	"encoding/binary"
	"log"
	"net"
	"time"
)

// Start broadcasts a mDNS announcement over UDP port 5353
// This is a simple one-shot broadcast on startup to announce the service.
// For full mDNS responder behavior, a dedicated library would be needed,
// but this lightweight approach works for most LAN environments.
func Start(port int) error {
	addr, err := net.ResolveUDPAddr("udp4", "255.255.255.255:5353")
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 5353})
	if err != nil {
		return err
	}
	defer conn.Close()

	// Enable broadcast
	conn.SetWriteBuffer(1024)
	conn.SetBroadcast(true)

	// Build a minimal mDNS query packet (service discovery probe)
	// We use a simple approach: broadcast our presence to the LAN
	msg := buildMdnsAnnounce(port)
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, err = conn.WriteToUDP(msg, addr)
	if err != nil {
		return err
	}
	log.Printf("[mDNS] Announced sharetool on port %d", port)
	return nil
}

func buildMdnsAnnounce(port int) []byte {
	// Simplified mDNS announcement packet
	// In production, use miekg/dns for proper mDNS/DNS-SD
	var buf bytes.Buffer
	// mDNS header (12 bytes)
	binary.Write(&buf, binary.BigEndian, uint16(0))    // Transaction ID
	binary.Write(&buf, binary.BigEndian, uint16(0x8400)) // Flags: response, recursion desired
	binary.Write(&buf, binary.BigEndian, uint16(0))   // QDCOUNT
	binary.Write(&buf, binary.BigEndian, uint16(1))   // ANCOUNT (1 answer)
	binary.Write(&buf, binary.BigEndian, uint16(0))   // NSCOUNT
	binary.Write(&buf, binary.BigEndian, uint16(0))   // ARCOUNT
	return buf.Bytes()
}
```

**注意**：上述 mDNS 实现是简化版，仅用于宣告自己存在。  
如需完整 mDNS 服务发现（让其他设备自动看到服务），后续 Phase B 集成 `github.com/miekg/dns` 或用 Go 标准库 `net` 的 UDP 多播实现。

---

## 6. Web UI 要求（web/index.html）

完全用原生 HTML + CSS + Vanilla JS 实现，打包进二进制。

### 6.1 功能列表

**文本剪贴板**
- 文本输入框 + 发送按钮 → POST /api/text
- 每 3 秒轮询 GET /api/text/latest 更新显示

**文件上传**
- 拖拽区域（#dropzone）支持 drag & drop
- 文件选择 input（可多选）
- **分片上传**：File.slice(START, END) 每块 2MB，PUT 带 Content-Range
- 断点续传：上传中断后刷新页面重新选择同一文件，从断点继续
- 进度条显示（#progressBar）
- 上传完成后自动刷新文件列表

**文件列表**
- 页面加载时 GET /api/files 获取列表
- 按 updatedAt 倒序排列
- 每行：文件名、大小、更新时间、操作按钮（查看/下载/删除）
- 支持按文件名搜索（前端过滤）

**下载**
- 点击文件名或下载按钮 → GET /api/files/:name
- 直接下载，不经前端中转（浏览器原生下载）

---

### 6.2 UI 布局（极简）

```
+----------------------------------+
|  ShareTool           [IP:Port]   |  ← Header
+----------------------------------+
|  [Text Input............] [Send] |  ← 文本分享
+----------------------------------+
|  Latest: "..." (3秒前)          |  ← 文本展示
+----------------------------------+
|  [+ 选择文件] 或 拖拽到此处     |  ← 文件上传区
|  [#######-----] 50%             |  ← 进度条
+----------------------------------+
|  文件列表              [刷新]   |
|  ┌─────────────────────────────┐|
|  │ report.pdf  2.3MB  刚刚 [下]│|
|  │ data.zip    10MB   2分钟前  │|
|  └─────────────────────────────┘|
+----------------------------------+
```

---

## 7. 实现检查清单

- [ ] `go mod init sharetool`
- [ ] 创建目录结构 `internal/server/`, `internal/storage/`, `internal/discovery/`, `web/`
- [ ] 实现 `main.go` 入口
- [ ] 实现 `internal/storage/storage.go`（文件索引，内存维护）
- [ ] 实现 `internal/server/text_api.go`（文本读写）
- [ ] 实现 `internal/server/file_api.go`（文件 CRUD + Range）
- [ ] 实现 `internal/server/server.go`（路由 + embed）
- [ ] 实现 `internal/discovery/mdns.go`（mDNS 广播）
- [ ] 编写 `web/index.html`（文本 + 文件上传 + 列表 + 进度条）
- [ ] `go build -o sharetool .`
- [ ] `./sharetool` 启动测试
- [ ] 验证文本 POST/GET（curl）
- [ ] 验证小文件上传/下载（curl + 浏览器）
- [ ] 验证大文件（>100MB）断点续传（PUT with Content-Range）
- [ ] 验证多设备访问（手机/其他电脑）

---

## 8. Phase B 预留接口（当前不实现）

以下为 Phase B 扩展预留，API 设计应便于后续扩展：

```go
// Phase B: 分享链接
// POST /api/share/create  → 生成带短码的分享链接
// GET  /api/share/:code   → 无认证下载（临时访问）

// Phase B: ZIP 批量下载
// GET  /api/download-all  → 打包所有文件为 ZIP

// Phase B: CLI 工具
// sharetool push <file>    → 上传到局域网广播的服务
// sharetool pull <name>    → 从局域网下载文件
```

---

## 9. 关键技术要点

### 断点续传原理

```
客户端切片上传：
  File.slice(0, 2097152)   → PUT /api/files/big.zip
                              Header: Content-Range: bytes 0-2097151/10485760
                              Response: {"success": true, "offset": 2097152}

  File.slice(2097152, ...) → PUT /api/files/big.zip
                              Header: Content-Range: bytes 2097152-4194303/10485760
                              ...

服务端追加写入（Seek 到 offset）：
  f, _ := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0644)
  f.Seek(offset, io.SeekStart)  // 跳到断点
  io.Copy(f, r.Body)            // 追加写入
```

### Go embed 注意事项

```go
//go:embed all:../../web
// 此指令必须在 package 内的全局变量上使用
// all: 表示递归嵌入目录下所有文件
// 路径相对于当前 .go 文件所在目录
```

### 文件名安全

所有文件名必须：
1. 用 `filepath.Base()` 提取纯文件名（去掉目录部分）
2. 拒绝包含 `..` 的路径穿越攻击
3. 直接 `os.Create(filepath.Join(sharedDir, name))` 不存在竞争条件

---

## 10. 预期输出

成功构建后，运行 `./sharetool` 输出：

```
2024/06/01 10:00:00 ShareTool running on http://0.0.0.0:18790
2024/06/01 10:00:00 Sharing directory: ./shared
2024/06/01 10:00:00 [mDNS] Announced sharetool on port 18790
```

浏览器打开 `http://localhost:18790` 即可使用 Web UI。
