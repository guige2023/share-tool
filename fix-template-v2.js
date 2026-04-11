#!/usr/bin/env node
/**
 * ShareTool HTML 模板修复脚本 V2
 * 将 ' + T('key') + ' 替换为 ${T('key')}
 */

const fs = require('fs');
const path = require('path');

const SERVER_FILE = path.join(__dirname, 'server.js');
const BACKUP_FILE = path.join(__dirname, 'server.js.backup.' + Date.now());

console.log('[FixHTML] 开始修复 HTML 模板...');

// 读取 server.js
let content = fs.readFileSync(SERVER_FILE, 'utf8');

// 创建备份
fs.writeFileSync(BACKUP_FILE, content);
console.log('[FixHTML] 已创建备份:', path.basename(BACKUP_FILE));

// 统计修复前的数量
const beforeCount = (content.match(/' \+ T\(/g) || []).length;
console.log('[FixHTML] 发现', beforeCount, '处需要修复');

if (beforeCount === 0) {
  console.log('[FixHTML] 无需修复');
  process.exit(0);
}

// 替换模式：' + T('...') + ' -> ${T('...')}
// 注意：需要处理单引号、双引号、以及带有 .replace() 的调用

// 第一步：处理简单情况 ' + T('key') + '
let fixed = content.replace(/' \+ T\('([^']+)'\) \+ '/g, "\${T('$1')}");

// 第二步：处理带 params 的情况 ' + T('key', {...}) + '
fixed = fixed.replace(/' \+ T\('([^']+)',\s*(\{[^}]*\}\})\) \+ '/g, "\${T('$1', $2)}");

// 第三步：处理 .replace() 链式调用
// ' + T('key').replace('a', 'b') + '
fixed = fixed.replace(
  /' \+ (T\('[^']+'\)(?:\.replace\([^)]+\))*) \+ '/g,
  "\${$1}"
);

// 第四步：处理双引号版本
fixed = fixed.replace(/" \+ T\("([^"]+)"\) \+ "/g, "\${T(\"$1\")}");

// 统计修复后的数量
const afterCount = (fixed.match(/' \+ T\(/g) || []).length;
const fixedCount = beforeCount - afterCount;

console.log('[FixHTML] 已修复', fixedCount, '处');

if (afterCount > 0) {
  console.log('[FixHTML] 警告：仍有', afterCount, '处未修复（可能是复杂情况）');
}

// 写入修复后的文件
fs.writeFileSync(SERVER_FILE, fixed);

console.log('[FixHTML] ✓ 修复完成');
console.log('');
console.log('重启命令:');
console.log('  kill $(pgrep -f "share-tool/server.js") && sleep 2 && node server.js');
