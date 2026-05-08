# ShareTool Go 迁移路线图

> **决策**：废弃 Node.js 后端，全面转向 Go 实现。Node.js 代码进入维护冻结期，仅修复严重安全漏洞，新功能只在 Go 端开发。

---

## 一、为什么选 Go

| 维度 | Node.js 现状 | Go 现状 |
|------|-------------|---------|
| **架构** | 单体脚本（server.js 1272行 + db.js 4755行），演进失控 | 已模块化（internal/server/*、internal/discovery/*） |
| **部署** | 需要 node_modules（~12MB+），跨平台依赖复杂 | 单二进制文件，静态编译，零依赖 |
| **资源** | 内存占用高，V8 引擎对文件服务不友好 | 内存占用低，goroutine 适合高并发文件传输 |
| **安全** | CORS 逻辑混乱、路径遍历风险、uncaughtException 不退出 | 已有 rawMux 路径遍历防御、标准 HTTP timeout |
| **前端** | 服务端渲染 HTML 字符串（500+行内联在 server.js） | 已使用 `embed` 嵌入静态资源，SPA fallback 正确 |

**核心优势**：Go 端已经具备了正确的架构骨架（自定义路由、安全中间件、mDNS 发现、静态资源嵌入），只需要把 Node.js 的业务逻辑逐步移植过去。

---

## 二、功能对比：Go 已实现 vs 待移植

### Go 端已实现 ✅
- [x] HTTP/HTTPS 双端口服务（HTTP 自动跳转 HTTPS）
- [x] 自签名证书自动生成（RSA 2048，10 年有效期）
- [x] 文件上传（multipart + Content-Range 断点续传）
- [x] 文件下载（Range 支持）
- [x] 文件删除 + 批量删除
- [x] 文本分享（增删查，内存存储）
- [x] 剪贴板同步（hub/client 模式，持久化到磁盘）
- [x] Peer 发现（mDNS + UDP 广播）
- [x] QR 码生成
- [x] OpenAPI / AI Tools 定义
- [x] 静态 Web UI 嵌入（`//go:embed`）
- [x] 路径遍历防御（rawMux + SecurityMiddleware 双层）
- [x] Graceful Shutdown（signal + context timeout）

### 需要从 Node.js 移植到 Go 📦
- [ ] **SQLite 数据库层**（最重要）
  - 文件元数据管理（替代直接读文件系统）
  - FTS5 全文搜索
  - 标签系统 + 虚拟文件夹
  - 文件版本历史
  - 回收站（trash）
- [ ] **认证系统**
  - 静态 Token（SHARE_TOKEN）
  - 动态 Token（设备级）
  - Token 轮换（rotate）
- [ ] **分享链接系统**
  - 分享码生成（code）
  - 过期时间 / 最大下载次数
  - 密码保护
  - 访问统计
- [ ] **请求收集链接**（Request Link）
- [ ] **审计日志**（Audit Log）
- [ ] **设备管理**
  - 在线/离线状态
  - 设备 Token 绑定
  - 同步状态
- [ ] **WebSocket / SSE**
  - 实时文件变更推送
  - 剪贴板实时同步
- [ ] **WebDAV 服务**
- [ ] **存储分析**
  - 重复文件检测
  - 存储统计
  - 清理向导
- [ ] **i18n 后端支持**
- [ ] **MCP Server**

---

## 三、技术选型

### 数据库：SQLite（CGO-free）

```go
import "modernc.org/sqlite" // 纯 Go 实现，无需 CGO
```

- 与 Node.js 的 `better-sqlite3` 数据文件格式 100% 兼容
- 支持 FTS5、JSON1、WAL 模式
- 静态编译无额外依赖

**不选 `mattn/go-sqlite3` 的原因**：需要 CGO，跨平台交叉编译复杂。

### 路由：继续基于自定义 `rawMux`

当前 `rawMux` 已经足够轻量且安全（有路径遍历防御），不需要引入 Gin/Echo 等重型框架。保持零外部依赖是项目的核心优势。

### 日志：标准库 `log` + `slog`

Go 1.21+ 的 `slog` 已足够替代 Node.js 的 `pino`。保持无外部依赖。

```go
import "log/slog"

var logger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelInfo,
}))
```

### 配置：环境变量 + JSON 配置文件

与 Node.js 端保持一致，配置文件路径 `~/.share-tool/config.json`。

---

## 四、迁移阶段规划

### Phase 0：Node.js 端冻结（立即执行）

1. 在 `package.json` 中添加 `"deprecated": true` 标记
2. 在 README 顶部添加警告：
   ```markdown
   > ⚠️ **Node.js 后端已冻结维护**，请使用 Go 版本：`cd go && go build`
   ```
3. 将 Node.js 源码移入 `legacy/nodejs/` 目录（保留备份，便于参考）
4. 根目录的 `server.js`、`db.js`、`routes/`、`cli.js` 等全部移入 `legacy/`

> **原则**：冻结期间，Node.js 端只接受安全补丁，不接受新功能。

---

### Phase 1：数据库层移植（优先级 P0）

这是整个迁移的基石。Node.js 端的 `db.js` 有 4755 行，包含 24 个 schema 版本迁移。

**目标文件**：
```
go/internal/db/
├── db.go           # 连接管理 + 初始化
├── schema.go       # Schema 定义（合并 v1-v24 为干净的初始 schema）
├── files.go        # 文件元数据 CRUD
├── search.go       # FTS5 搜索
├── shares.go       # 分享链接
├── tags.go         # 标签 + 虚拟文件夹
├── audit.go        # 审计日志
├── devices.go      # 设备管理
└── tokens.go       # Token 管理
```

**关键策略**：
- **不照搬 24 个迁移版本**，而是将当前 v24 的完整 schema 作为 Go 端的初始 schema
- 迁移数据：直接复用 `~/.share-tool/share-tool.db` 文件（格式兼容）
- 逐步替换：先让 Go 端读写同一个 db 文件，验证功能正确后再删除 Node.js

**最小可用 schema（Go 端初始）**：
```sql
-- 文件表（含所有历史迁移中的列）
CREATE TABLE files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    content TEXT,
    type TEXT NOT NULL DEFAULT 'file',
    size INTEGER NOT NULL DEFAULT 0,
    hash TEXT,
    tags TEXT DEFAULT '',
    encrypted INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    content_type TEXT,
    virtual_folder TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- FTS5 虚拟表（全文搜索）
CREATE VIRTUAL TABLE files_fts USING fts5(
    filename, tags, content='files', content_rowid='id'
);

-- 分享链接表
CREATE TABLE share_links (
    code TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    is_text INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    expires_at INTEGER,
    max_downloads INTEGER,
    download_count INTEGER NOT NULL DEFAULT 0,
    description TEXT DEFAULT '',
    label TEXT,
    view_count INTEGER NOT NULL DEFAULT 0,
    theme_color TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 设备表
CREATE TABLE devices (
    device_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ip TEXT,
    port INTEGER DEFAULT 18793,
    token TEXT,
    last_seen INTEGER,
    last_sync_at INTEGER,
    synced_files INTEGER DEFAULT 0,
    online INTEGER NOT NULL DEFAULT 1
);

-- 审计日志
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT,
    token TEXT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 剪贴板历史（替代 JSON 文件）
CREATE TABLE clipboard_history (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    content TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_path TEXT,
    from_device TEXT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch())
);
```

---

### Phase 2：API 路由移植（按优先级分批）

#### 批次 A：核心文件 API（P0，1 周内）

将当前的 `file_api.go` 从文件系统读写改为数据库读写：

| 当前 Go 实现 | 需要改为 |
|-------------|---------|
| `listFiles(dir)` → 读文件系统 | `db.ListFiles()` → 读 SQLite |
| `handleFileUpload` → 保存到磁盘 | 保存到磁盘 + 写入 `files` 表 |
| `handleFileGet` → `http.ServeFile` | 保持 `http.ServeFile`，但添加访问日志 |
| `handleFileDelete` → `os.Remove` | `os.Remove` + `db.DeleteFile()` |

新增端点：
- `GET /api/content/{filename}` — 文件内容预览
- `GET /api/search?q=...` — 全文搜索
- `GET /api/search/suggest` — 搜索建议

#### 批次 B：认证 + 安全（P0，1 周内）

新增 `internal/middleware/auth.go`：

```go
package middleware

func AuthMiddleware(db *db.DB) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            token := r.Header.Get("x-auth-token")
            if token == "" {
                // 检查 Bearer
                auth := r.Header.Get("Authorization")
                if strings.HasPrefix(auth, "Bearer ") {
                    token = strings.TrimPrefix(auth, "Bearer ")
                }
            }
            
            // 验证静态 Token
            if token == cfg.ShareToken {
                next.ServeHTTP(w, r)
                return
            }
            
            // 验证动态 Token
            if db.ValidateToken(token) {
                next.ServeHTTP(w, r)
                return
            }
            
            http.Error(w, `{"error":"Unauthorized"}`, 401)
        })
    }
}
```

修改 `SetupRouter`，对敏感端点应用 `AuthMiddleware`。

#### 批次 C：分享链接 + 收集链接（P1，2 周内）

移植 `routes/share.js` 到 Go：
- `POST /api/shares` — 创建分享
- `GET /s/{code}` — 分享码访问
- `GET /api/shares` — 列表
- `DELETE /api/shares/{code}` — 删除
- 请求收集链接（Request Link）全功能

#### 批次 D：高级功能（P2，2-4 周）

- 标签管理（Tag CRUD、自动标签建议）
- 虚拟文件夹（Virtual Folders）
- 文件版本历史
- 回收站（Trash + 自动清理）
- 审计日志（Audit Log）
- 存储统计 / 重复文件检测
- 设备管理（在线状态、Token 绑定）

#### 批次 E：实时通信（P2，1-2 周）

- **SSE（Server-Sent Events）**：`GET /api/events`
  - 替代 Node.js 的 WebSocket，更轻量，天然支持 HTTP/2
  - 推送事件：`files_changed`、`clipboard_received`、`device_online`
- **WebSocket**（如剪贴板实时同步需要双向通信）

#### 批次 F：WebDAV + MCP（P3，按需）

- WebDAV 服务 (`/dav`)
- MCP Server（Model Context Protocol）

---

### Phase 3：前端剥离（P1，与 Phase 2 并行）

**当前问题**：Node.js 的 `server.js` 里内嵌了 500+ 行 HTML。

**目标**：前端完全作为静态资源，由 Go 的 `embed` 提供。

**步骤**：
1. 将 `server.js` 中的 `renderPage()` HTML 提取到 `go/internal/server/web/index.html`
2. 将 inline CSS 提取到 `go/internal/server/web/styles.css`
3. 将 inline JS 提取到 `go/internal/server/web/app.js`
4. Go 端已通过 `//go:embed all:web` 嵌入，无需修改服务器代码

**SPA 路由**：
当前 `serveIndexFallback` 已正确实现——静态文件存在则直接服务，否则 fallback 到 `index.html`。

---

### Phase 4：CLI 工具（P2）

Node.js 有 `cli.js`（2253 行），Go 端需要等价的命令行工具。

**方案**：使用 Go 的 `flag` + `cobra`（可选），提供：
```bash
./sharetool              # 启动服务（默认）
./sharetool -dir ~/share # 指定共享目录
./sharetool -readonly    # 只读模式
./sharetool -name "MyMac" # 设置实例名
```

当前 `main.go` 已实现基础 flag，足够使用。不需要引入 cobra（保持零外部依赖）。

---

## 五、Node.js 代码处置方案

### 文件迁移清单

```bash
# 创建 legacy 目录
mkdir -p legacy/nodejs legacy/docs

# 移动 Node.js 后端代码
mv server.js db.js cli.js mcp-server.mjs constants.js crypto.js legacy/nodejs/
mv routes/ legacy/nodejs/
mv tests/ legacy/nodejs/
mv public/ legacy/nodejs/        # 前端资源后续复制到 go/internal/server/web/

# 移动 Node.js 构建产物
mv package.json package-lock.json jest.config.js eslint.config.mjs legacy/nodejs/

# 保留文档
cp README.md ROADMAP.md CLIPBOARD_SPEC.md tasks.md legacy/docs/
```

### 根目录保留文件

```
share-tool/
├── go/                          # Go 后端（唯一活跃代码）
│   ├── main.go
│   ├── internal/
│   │   ├── server/
│   │   ├── discovery/
│   │   └── db/                  # 新增：SQLite 数据层
│   └── web/                     # 前端静态资源（从 public/ 迁移）
├── app/                         # macOS Swift App（不受影响）
├── legacy/
│   ├── nodejs/                  # 冻结的 Node.js 代码
│   └── docs/                    # 备份文档
├── shared/                      # 共享文件目录
├── cert.pem / key.pem           # SSL 证书
└── README.md                    # 更新后的 README（以 Go 为主）
```

---

## 六、数据迁移策略

### SQLite 数据库

Node.js 和 Go 使用**完全相同的 SQLite 文件格式**。Go 端使用 `modernc.org/sqlite` 可以直接打开 `~/.share-tool/share-tool.db`。

**步骤**：
1. Go 端开发时，指定相同的数据库路径：`SHARE_TOOL_DB_PATH=~/.share-tool/share-tool.db`
2. Schema 初始化和迁移在 Go 端重新实现（基于 v24 的完整 schema，不需要 24 个迁移步骤）
3. 用户从 Node.js 切换到 Go 时，数据库文件**无需任何转换**

### 剪贴板历史

Node.js 将剪贴板存储在 SQLite 中，Go 当前存储在 `~/.sharetool/clipboard/history.json`。

**迁移方案**：
- 将 Go 的剪贴板存储也改为 SQLite（复用同一个 db 文件）
- 或者写一个一次性迁移脚本，将 JSON 导入 SQLite

---

## 七、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Go SQLite 性能不如 better-sqlite3 | 中 | better-sqlite3 优势在同步 API，Go 的 `database/sql` + `modernc.org/sqlite` 性能足够；如瓶颈明显可换回 `mattn/go-sqlite3`（需要 CGO） |
| 前端代码依赖 Node.js 的 inline HTML | 高 | Phase 3 提取 HTML 到静态文件，Go 的 `embed` 已就绪 |
| 24 个 schema 版本迁移逻辑复杂 | 中 | 不移植迁移历史，直接从 v24 schema 开始 |
| 开发期间双端并行修改 | 高 | **严格执行冻结**：Node.js 端只修致命 bug，新需求必须在 Go 端实现 |
| macOS App 调用的是 Node.js | 高 | 检查 `app/` 目录下的调用方式，改为调用 `sharetool` 二进制 |
| WebDAV 功能复杂 | 低 | 放到最后批次，必要时可暂时不移植 |

---

## 八、立即执行的 Checklist

- [ ] 将 `server.js` 中的客户端 JS（1160-1203 行）**删除**（这是架构混乱的标志）
- [ ] 在 README 顶部添加 Node.js 废弃警告
- [ ] 创建 `legacy/` 目录，将 Node.js 源码移入
- [ ] 在 Go 端添加 `internal/db/` 包，实现 SQLite 连接管理
- [ ] 将 `public/` 中的前端资源复制到 `go/internal/server/web/`
- [ ] 验证 Go 端 `go build` 后，单二进制文件运行正常
- [ ] 更新 `app/` 中的启动逻辑（如需要），改为调用 Go 二进制而非 `node server.js`

---

## 九、预期收益

1. **部署**：一个 10MB 二进制文件，无需 `npm install`，无需 `node_modules`
2. **启动速度**：Go 启动毫秒级，Node.js 需要加载 V8 + 模块解析
3. **资源占用**：Go 运行时内存通常 <50MB，Node.js 容易 >100MB
4. **跨平台编译**：`GOOS=windows GOARCH=amd64 go build` 一行搞定
5. **静态类型**：编译期捕获类型错误，减少运行时 bug
6. **架构清晰**：前后端彻底分离，前端是纯静态 SPA，后端是纯 API 服务
