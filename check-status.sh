#!/bin/bash
# ShareTool 状态检查脚本
# 用法: ./check-status.sh

echo "📊 ShareTool 状态检查"
echo "===================="
echo ""

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 检查进程
echo "1. 进程状态"
echo "-----------"
PID=$(pgrep -f "share-tool/server.js" || true)
if [ -n "$PID" ]; then
    echo -e "状态: ${GREEN}运行中${NC} (PID: $PID)"
    ps -o pid,pcpu,pmem,etime,command -p $PID 2>/dev/null | tail -1
else
    echo -e "状态: ${RED}未运行${NC}"
fi
echo ""

# 检查端口
echo "2. 端口监听"
echo "-----------"
for port in 18790 18791 18792 18793; do
    if lsof -i :$port > /dev/null 2>&1; then
        echo -e "端口 $port: ${GREEN}监听中${NC}"
    else
        echo -e "端口 $port: ${RED}未监听${NC}"
    fi
done
echo ""

# 测试 HTTP 服务
echo "3. 服务响应测试"
echo "---------------"
HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" https://localhost:18793/ 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "307" ] || [ "$HTTP_CODE" = "302" ]; then
    echo -e "HTTPS (18793): ${GREEN}正常${NC} (HTTP $HTTP_CODE)"
else
    echo -e "HTTPS (18793): ${YELLOW}异常${NC} (HTTP $HTTP_CODE)"
fi

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:18790/ 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "307" ] || [ "$HTTP_CODE" = "302" ]; then
    echo -e "HTTP (18790): ${GREEN}正常${NC} (HTTP $HTTP_CODE)"
else
    echo -e "HTTP (18790): ${YELLOW}异常${NC} (HTTP $HTTP_CODE)"
fi
echo ""

# 检查日志
echo "4. 最近日志"
echo "-----------"
if [ -f "share-tool.log" ]; then
    echo "最后 5 条日志:"
    tail -5 share-tool.log | sed 's/^/  /'
else
    echo "日志文件不存在"
fi
echo ""

# 检查错误
echo "5. 错误统计"
echo "-----------"
if [ -f "share-tool.log" ]; then
    ERROR_COUNT=$(grep -c '"level":50' share-tool.log 2>/dev/null || echo "0")
    echo "日志中错误数量: $ERROR_COUNT"
    
    if [ "$ERROR_COUNT" -gt 0 ]; then
        echo ""
        echo "最近错误:"
        grep '"level":50' share-tool.log 2>/dev/null | tail -3 | sed 's/^/  /'
    fi
else
    echo "无法统计"
fi
echo ""

# 数据库检查
echo "6. 数据库状态"
echo "-------------"
DB_PATH="$HOME/.share-tool/share-tool.db"
if [ -f "$DB_PATH" ]; then
    DB_SIZE=$(ls -lh "$DB_PATH" | awk '{print $5}')
    echo "数据库大小: $DB_SIZE"
    echo "数据库路径: $DB_PATH"
else
    echo -e "数据库: ${RED}不存在${NC}"
fi
echo ""

# 总结
echo "7. 总结"
echo "-------"
if [ -n "$PID" ]; then
    echo -e "服务状态: ${GREEN}✅ 正常运行${NC}"
    echo ""
    echo "访问地址:"
    echo "  • Web 界面: https://localhost:18793"
    echo "  • Web 界面: http://localhost:18790"
else
    echo -e "服务状态: ${RED}❌ 未运行${NC}"
    echo ""
    echo "启动命令:"
    echo "  cd $(pwd) && node server.js"
    echo "  或: ./restart.sh"
fi
