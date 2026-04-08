# Hermes + OpenClaw 双系统部署

## 2026-04-07 安装记录

---

## 一、背景与关系分析

### 两个系统的定位

| 系统 | 架构 | 擅长领域 |
|------|------|----------|
| **OpenClaw** | Node.js + 插件体系 | 消息渠道集成（飞书、QQ）、任务协调 |
| **Hermes** | Python + Agent 框架 | 代码开发、终端操作、工程任务 |

### 核心发现：两者完全独立

**关键点**：Hermes 有自己原生的飞书适配器，不是依赖 OpenClaw 的通道。

```
┌─────────────────────────────────────────────────────────┐
│                      飞书服务器                          │
│              msg-frontier.feishu.cn                     │
└───────────────────────┬─────────────────────────────────┘
                        │
          ┌─────────────┴─────────────┐
          │                           │
          ▼                           ▼
┌─────────────────────┐    ┌─────────────────────┐
│   Hermes Gateway     │    │    OpenClaw         │
│   (hermes 进程)      │    │    (openclaw 进程)   │
│                     │    │                     │
│  原生 feishu WS     │    │  Node.js 插件 +      │
│  直连飞书服务器      │    │  Lark SDK           │
└─────────────────────┘    └─────────────────────┘
```

### 共享 vs 独立

| 资源 | 共享情况 | 说明 |
|------|----------|------|
| **工作空间** | ✅ 共享 | `~/.openclaw/workspace` 两边都能访问 |
| **文件** | ✅ 共享 | 生成的文件互相可见 |
| **记忆/Memory** | ❌ 独立 | 各有各的记忆系统 |
| **飞书通道** | ❌ 独立 | 各自独立连接飞书 |
| **API Key** | ✅ 可以共用 | 同一套 MiniMax Key |

### 实际使用场景

```
你在飞书发消息
        │
        ▼
   ┌────────┐     ┌────────┐
   │ Hermes │     │ OpenClaw│
   │ ✅ 会回 │     │ ✅ 也会回│
   └────────┘     └────────┘
```

**可能问题**：同一飞书消息可能被两个系统都回复，造成重复。

**解决方案**：
- 只保留一个系统的飞书连接
- 或者接受双通道的存在（有时候也有好处）

---

## 二、安装步骤

### OpenClaw（已有，跳过）

```bash
# 安装
npm install -g openclaw

# 启动
openclaw gateway --port 18789 --force &
```

### Hermes 安装

```bash
# 通过 uvx 安装（无需手动 clone）
uvx hermes-ai/hermes-agent

# 指定版本
uvx hermes-ai/hermes-agent@0.7.0
```

---

## 三、MiniMax API 配置（关键调试经验）

### 遇到的问题

#### 问题 1: 404 Not Found

```
API call failed (attempt 1/3): NotFoundError [HTTP 404]
Endpoint: https://api.minimaxi.com/anthropic
Model: minimax/MiniMax-M2.7-highspeed
```

**原因**：使用了 `provider: custom`，导致走错了 API 路径。

#### 问题 2: 401 Authentication Error

```
AuthenticationError [HTTP 401]
Endpoint: https://api.minimax.io/anthropic
```

**原因**：
1. Hermes 默认用 `api.minimax.io`，但应该用 `api.minimaxi.com`
2. 没有正确设置 API Key

### 正确配置

#### 1. 修改 ~/.hermes/config.yaml

```yaml
model:
  default: MiniMax-M2.7-highspeed
  provider: minimax      # 注意：不是 custom！
```

#### 2. 修改 ~/.hermes/.env

```bash
MINIMAX_API_KEY=你的API密钥
MINIMAX_BASE_URL=https://api.minimaxi.com/anthropic
```

#### 3. 完整 .env 示例

```
MESSAGING_CWD=/Users/guige/.openclaw/workspace
HERMES_GATEWAY_TOKEN=35e7438f1e72356ebc6d4e839881cc35233ee01ec81d5af6
HERMES_MAX_ITERATIONS=90
MINIMAX_API_KEY=sk-cp-yPFIVOd3ANJwWoVD2t5054qgtYLUo17dHgM9oeb9XfRqLmKxzWwpCABgBbE6QvJKq15Z2YHcufaZHLP2DeSua_ANU9gZs_tk_x0__fzn7GsxNtKF5IywXgQ
MINIMAX_BASE_URL=https://api.minimaxi.com/anthropic
```

### 配置要点

| 配置项 | 错误值 | 正确值 |
|--------|--------|--------|
| provider | `custom` | `minimax` |
| base_url | `https://api.minimax.io/anthropic` | `https://api.minimaxi.com/anthropic` |
| model | `MiniMax-M2.7` | `MiniMax-M2.7-highspeed` |

---

## 四、双系统启动与停止

### 启动 OpenClaw

```bash
openclaw gateway --port 18789 --force &
```

### 启动 Hermes

```bash
hermes
```

后台运行：
```bash
nohup hermes > ~/.hermes/logs/hermes.log 2>&1 &
```

### 停止服务

```bash
# 停止 OpenClaw
pkill -9 openclaw

# 停止 Hermes（找到进程 kill）
ps aux | grep hermes
kill <pid>
```

### 查看状态

```bash
# OpenClaw 日志
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log

# Hermes 日志
tail -f ~/.hermes/logs/hermes.log

# 检查进程
ps aux | grep openclaw | grep -v grep
ps aux | grep hermes | grep -v grep
```

---

## 五、双系统互补用法

### 分工建议

| 任务类型 | 推荐系统 | 原因 |
|----------|----------|------|
| 飞书消息处理 | 均可 | 两者都能接收 |
| 代码开发 | **Hermes** | 工具集更丰富 |
| 终端操作 | **Hermes** | 原生支持更好 |
| 飞书文档操作 | **OpenClaw** | 插件更完善 |
| 文件管理 | 均可 | 共享工作空间 |

### 互备份示例

**当 OpenClaw 出问题时**：
让 Hermes 帮忙排查：
```bash
# 查看 OpenClaw 日志
tail -100 ~/.openclaw/logs/gateway.log

# 检查配置
cat ~/.openclaw/openclaw.json

# 重启 OpenClaw
pkill -9 openclaw
openclaw gateway --port 18789 --force &
```

**当 Hermes 出问题时**：
让 OpenClaw 帮忙排查。

---

## 六、相关文件路径

| 用途 | 路径 |
|------|------|
| Hermes 配置 | `~/.hermes/config.yaml` |
| Hermes 环境变量 | `~/.hermes/.env` |
| Hermes 日志 | `~/.hermes/logs/hermes.log` |
| Hermes Gateway 日志 | `~/.hermes/logs/gateway.log` |
| Hermes sessions | `~/.hermes/sessions/` |
| Hermes memories | `~/.hermes/memories/` |
| OpenClaw 配置 | `~/.openclaw/openclaw.json` |
| OpenClaw 日志 | `/tmp/openclaw/openclaw-YYYY-MM-DD.log` |
| 共享工作空间 | `~/.openclaw/workspace/` |

---

## 七、调试命令汇总

### 日志查看

```bash
# OpenClaw 最新错误
grep -i "error\|fatal" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -20

# OpenClaw 飞书通道状态
grep "feishu\[default\]" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -10

# Hermes 飞书连接状态
grep -i "feishu\|lark\|connected" ~/.hermes/logs/gateway.log | tail -20

# Hermes API 调用错误
grep -i "error\|401\|404\|401" ~/.hermes/logs/hermes.log | tail -20
```

### 配置检查

```bash
# 查看 Hermes 模型配置
grep -A5 "model:" ~/.hermes/config.yaml

# 查看 Hermes API Key 是否设置
grep "MINIMAX" ~/.hermes/.env

# 查看 OpenClaw 飞书配置
grep -A10 "feishu" ~/.openclaw/openclaw.json
```

### 进程管理

```bash
# 查看所有相关进程
ps aux | grep -E "openclaw|hermes" | grep -v grep

# 检查端口占用
lsof -i :18789
```

---

## 八、升级建议

参考文章经验：

1. **不要追新**：主环境保持稳定版本，测试环境先试新版本
2. **等一天**：测试环境跑一天没问题再升级主环境
3. **Coding Plan**：养 OpenClaw 建议买套餐，按量计费成本很高

---

## 九、常见 Hermes 指令

### 启动与运行

```bash
# 启动交互式对话
hermes

# 单次查询（执行后退出）
hermes --query "你是谁"

# 指定模型
hermes --model minimax/MiniMax-M2.7-highspeed

# 恢复之前的会话
hermes --resume <session_id>

# 后台运行
nohup hermes > ~/.hermes/logs/hermes.log 2>&1 &
```

### 查看信息

```bash
# 列出所有可用工具
hermes --list_tools

# 列出所有工具集
hermes --list_toolsets

# 查看版本
hermes --version
```

### 工具集与技能

```bash
# 启用特定工具集（如 terminal、code_execution）
hermes --toolsets terminal,code_execution

# 预加载特定技能
hermes --skills healthcheck,cron-automation

# 启动 gateway 模式（监听消息）
hermes --gateway
```

### Hermes Cron 任务（内置定时任务）

在 Hermes 对话中，可以直接使用 cronjob 工具：

```
# 创建定时任务
/cron create <name> <schedule> <task>

# 列出定时任务
/cron list

# 查看任务状态
/cron status <job_id>

# 删除任务
/cron delete <job_id>
```

或在对话中让 Hermes 执行：
```
帮我创建一个定时任务，每小时检查一次 OpenClaw 的状态
```

---

## 十、OpenClaw 监控方案

### 方案一：使用 Hermes cronjob 监控 OpenClaw

Hermes 内置 `cronjob` 工具，可以创建定时任务来监控 OpenClaw。

#### 创建监控任务

在 Hermes 对话中发送：

```
帮我创建一个定时任务，名字叫 openclaw-monitor，每小时检查一次 OpenClaw 的状态：
1. 检查 openclaw 进程是否在运行
2. 检查最新日志是否有 ERROR 或 fatal
3. 如果发现问题，通过飞书发送通知给我（用户256918）
4. 如果一切正常，发送简短的"状态正常"报告
```

#### 监控任务示例 Prompt

```
# 角色
你是一个监控系统，负责检查 OpenClaw 的健康状态。

# 检查步骤
1. 运行 `ps aux | grep openclaw | grep -v grep` 检查进程
2. 运行 `tail -20 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep -i "error\|fatal"` 检查错误
3. 运行 `tail -5 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log` 获取最后日志时间

# 判断标准
- 如果 openclaw 进程不存在 → 发送"严重警告：OpenClaw 进程已停止"
- 如果有 ERROR 或 fatal → 发送"检测到错误，需要关注"并附上错误摘要
- 如果一切正常 → 发送"OpenClaw 状态正常 ✓"

# 输出
发送到飞书给我（用户256918）
```

### 方案二：使用 OpenClaw 内置 cron

OpenClaw 也有自己的 cron 系统：

```bash
# 查看 cron 命令
openclaw cron --help

# 列出定时任务
openclaw cron list

# 添加定时任务（需要查看具体语法）
openclaw cron add --help
```

### 方案三：使用 macOS launchd 监控

创建定时检查脚本：

```bash
#!/bin/bash
# check_openclaw.sh

# 检查进程
if ! pgrep -f "openclaw-gateway" > /dev/null; then
    echo "OpenClaw 进程不存在，尝试重启..."
    openclaw gateway --port 18789 --force &
    # 可以添加飞书通知
fi

# 检查日志错误
ERROR_COUNT=$(grep -c "ERROR\|fatal" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null || echo 0)
if [ "$ERROR_COUNT" -gt 5 ]; then
    echo "检测到大量错误: $ERROR_COUNT 次"
    # 可以添加飞书通知
fi
```

配合 cron 或 launchd 定时执行。

### 推荐方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| **Hermes cronjob** | 可用自然语言配置，灵活 | 需要 Hermes 运行 |
| **OpenClaw cron** | 原生集成 | 配置稍复杂 |
| **macOS cron/launchd** | 系统级，可靠性高 | 需要写脚本 |

**推荐**：使用 **Hermes cronjob**，因为可以直接用自然语言描述任务，而且 Hermes 有飞书发送能力。

---

## 十一、Hermes 特色工具（与 OpenClaw 互补）

### 1. 多 Agent 协作（核心互补）

| 技能 | 用途 |
|------|------|
| `multi-agent-team-software-development` | 协调多个专业 Agent 并行开发（前端/后端/核心） |
| `loop-operator` | 持续监控、循环操作、异常检测 |
| `delegation` | Spawn 子 agent 处理复杂子任务 |

**与 OpenClaw 互补**：OpenClaw 擅长协调，Hermes 可以构建多 Agent 团队并行工作。

### 2. 自动化与监控

| 技能 | 用途 |
|------|------|
| `cronjob` | 定时任务调度（刚才用的） |
| `automation-workflows` | 自动化工作流 |
| `batch-tools` | 批量处理工具 |
| `healthcheck` | 安全审计和健康检查 |

### 3. 开发增强

| 技能 | 用途 |
|------|------|
| `code-reviewer` | 代码审查 |
| `build-error-resolver` | 构建错误自动修复 |
| `e2e-runner` | 端到端测试 |
| `tdd-guide` | 测试驱动开发指导 |
| `refactor-cleaner` | 重构和死代码清理 |
| `architect` | 软件架构设计 |

### 4. 智能搜索与记忆

| 技能 | 用途 |
|------|------|
| `session_search` | 搜索历史对话 |
| `memory` | 跨会话持久记忆 |
| `multi-search-cn` | 中文网络搜索 |

### 5. 平台集成（比 OpenClaw 更多）

Hermes 支持更多消息平台：
- Telegram、Discord、Slack
- WhatsApp、Signal
- 企业微信（WeCom）
- 钉钉（DingTalk）
- Home Assistant（智能家居）

### 6. 创意与媒体

| 技能 | 用途 |
|------|------|
| `image_gen` | 图片生成 |
| `browser-use` | 浏览器自动化 |
| `web` | 网页内容提取 |

### 7. 完整工具集列表

```
# 查看所有可用工具集
hermes --list_toolsets

# 常用工具集
hermes --toolsets terminal,code_execution,file  # 基础开发
hermes --toolsets browser,web                   # 网页相关
hermes --toolsets delegation,moa                # 多 Agent
```

### 推荐的互补组合

| 场景 | OpenClaw 负责 | Hermes 负责 |
|------|--------------|-------------|
| **多 Agent 开发** | 任务协调 | 多 Agent 团队编排 |
| **代码质量** | 飞书通知结果 | 代码审查 + TDD |
| **自动化监控** | 定时触发 | 状态检查 + 通知 |
| **持续迭代** | 任务分配 | 团队并行开发 |
| **错误修复** | 问题汇总 | 自动排查修复 |

### 使用示例

让 Hermes 进行代码审查：
```
帮我用 code-reviewer 技能审查 ~/.openclaw/workspace/ 下的代码
```

让 Hermes 启动多 Agent 开发：
```
使用 multi-agent-team-software-development 技能，启动一个3人 Agent 团队
```

让 Hermes 检查 OpenClaw 安全：
```
使用 healthcheck 技能检查 OpenClaw 的安全配置
```

---

## 九、常见问题

### Q: Hermes 飞书消息没有回复

A: 检查 Hermes Gateway 是否在运行，以及飞书连接状态：
```bash
tail -20 ~/.hermes/logs/gateway.log | grep -i "feishu\|connected"
```

### Q: OpenClaw 崩溃后如何恢复

A:
```bash
pkill -9 openclaw
openclaw gateway --port 18789 --force &
sleep 5
tail -10 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log
```

### Q: 两个系统都回复同一消息

A: 这是正常的，因为两者都有独立的飞书连接。可以选择：
1. 停掉一个系统的飞书连接
2. 接受双通道（有时候也有冗余备份的好处）

### Q: 如何让 Hermes 使用 OpenClaw 的记忆

A: 目前两者记忆是独立的。但工作空间共享，可以在 OpenClaw 中存储信息让 Hermes 读取。
