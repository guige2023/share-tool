#!/bin/bash
# ShareTool 重启脚本
# 用法: ./restart.sh

set -e

echo "🔄 ShareTool 重启脚本"
echo "===================="

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 查找并停止现有进程
echo -e "${YELLOW}1. 检查现有进程...${NC}"
PID=$(pgrep -f "share-tool/server.js" || true)
if [ -n "$PID" ]; then
    echo "   发现运行中的进程 (PID: $PID)，正在停止..."
    kill $PID 2>/dev/null || true
    sleep 2
    # 强制终止如果还在运行
    if ps -p $PID > /dev/null 2>&1; then
        echo "   强制终止进程..."
        kill -9 $PID 2>/dev/null || true
    fi
    echo -e "${GREEN}   ✓ 已停止${NC}"
else
    echo "   没有发现运行中的进程"
fi

# 等待端口释放
echo -e "${YELLOW}2. 等待端口释放...${NC}"
for port in 18790 18791 18792 18793; do
    while lsof -i :$port > /dev/null 2>&1; do
        sleep 1
    done
done
echo -e "${GREEN}   ✓ 端口已释放${NC}"

# 检查数据库
echo -e "${YELLOW}3. 检查数据库...${NC}"
DB_PATH="$HOME/.share-tool/share-tool.db"
if [ -f "$DB_PATH" ]; then
    echo "   数据库存在: $DB_PATH"
    # 检查 search_history 表
    if command -v sqlite3 &> /dev/null; then
        HAS_TABLE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='search_history';" 2>/dev/null || echo "0")
        if [ "$HAS_TABLE" = "0" ]; then
            echo -e "${YELLOW}   ⚠ search_history 表缺失，尝试修复...${NC}"
            sqlite3 "$DB_PATH" "CREATE TABLE IF NOT EXISTS search_history (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, user_id TEXT, timestamp INTEGER NOT NULL DEFAULT (unixepoch()));" 2>/dev/null || true
            sqlite3 "$DB_PATH" "CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id, timestamp DESC);" 2>/dev/null || true
            echo -e "${GREEN}   ✓ 数据库表已修复${NC}"
        else
            echo -e "${GREEN}   ✓ 数据库表正常${NC}"
        fi
    fi
else
    echo "   数据库不存在，将自动创建"
fi

# 启动服务
echo -e "${YELLOW}4. 启动 ShareTool...${NC}"
nohup node server.js > share-tool.log 2> share-tool.err.log &
NEW_PID=$!
echo "   新进程 PID: $NEW_PID"

# 等待服务启动
echo -e "${YELLOW}5. 等待服务就绪...${NC}"
sleep 3

# 检查服务是否成功启动
MAX_RETRY=10
RETRY=0
while [ $RETRY -lt $MAX_RETRY ]; do
    if curl -sk https://localhost:18793/ -o /dev/null 2>/dev/null || \
       curl -s http://localhost:18790/ -o /dev/null 2>/dev/null; then
        echo -e "${GREEN}   ✓ 服务已就绪${NC}"
        break
    fi
    RETRY=$((RETRY + 1))
    echo "   等待中... ($RETRY/$MAX_RETRY)"
    sleep 2
done

if [ $RETRY -eq $MAX_RETRY ]; then
    echo -e "${RED}   ✗ 服务启动可能失败，请检查日志${NC}"
    exit 1
fi

# 获取网络信息
echo ""
echo -e "${GREEN}✅ ShareTool 已成功启动！${NC}"
echo "===================="
echo "进程 PID: $NEW_PID"
echo ""
echo "访问地址:"
echo "  • HTTP:  http://localhost:18790"
echo "  • HTTPS: https://localhost:18793 (推荐)"
echo "  • WebSocket: ws://localhost:18791"
echo ""
echo "日志文件:"
echo "  • 标准输出: $(pwd)/share-tool.log"
echo "  • 错误日志: $(pwd)/share-tool.err.log"
echo ""
echo "停止命令: kill $NEW_PID"
