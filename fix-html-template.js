#!/usr/bin/env node
/**
 * ShareTool HTML 模板修复脚本
 * 修复 HTML_PAGE 中的 T() 调用未被渲染的问题
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
console.log('[FixHTML] 已创建备份:', BACKUP_FILE);

// 检查问题
const hasProblem = content.includes("' + T('") || content.includes("') + '");

if (!hasProblem) {
  console.log('[FixHTML] 无需修复，模板格式正确');
  process.exit(0);
}

console.log('[FixHTML] 发现问题：模板中包含未执行的 T() 调用');

// 修复方法：将 const HTML_PAGE = `...` 改为函数
// 找到 HTML_PAGE 的定义位置
const htmlPageMatch = content.match(/const HTML_PAGE = `([\s\S]*?)`;/);

if (!htmlPageMatch) {
  console.error('[FixHTML] 无法找到 HTML_PAGE 定义');
  process.exit(1);
}

let htmlTemplate = htmlPageMatch[1];

// 替换 ' + T('key') + ' 为 ${T('key')}
htmlTemplate = htmlTemplate.replace(/' \+ T\('([^']+)'\) \+ '/g, '${T(\'$1\')}');
htmlTemplate = htmlTemplate.replace(/' \+ T\('([^']+)',\s*([^)]+)\) \+ '/g, '${T(\'$1\', $2)}');

// 同样处理双引号版本
htmlTemplate = htmlTemplate.replace(/" \+ T\("([^"]+)"\) \+ "/g, '${T("$1")}');

// 处理 .replace() 链式调用
// ' + T('ui.heroTitle').replace('文件/文字', ' / ') + '
htmlTemplate = htmlTemplate.replace(
  /' \+ (T\('[^']+'\)\.replace\([^)]+\)) \+ '/g,
  '${$1}'
);

// 重新组装
const newHtmlPageDef = `function renderHtmlPage() {
  // 服务器端渲染 T() 调用
  return \`${htmlTemplate}\`;
}

// 为了兼容性，保留 HTML_PAGE 作为函数引用
const HTML_PAGE = renderHtmlPage();`;

content = content.replace(/const HTML_PAGE = `[\s\S]*?`;/, newHtmlPageDef);

// 写入修复后的文件
fs.writeFileSync(SERVER_FILE, content);

console.log('[FixHTML] ✓ 修复完成');
console.log('[FixHTML] 请重启服务以应用更改');
console.log('');
console.log('重启命令:');
console.log('  kill $(pgrep -f "share-tool/server.js") && node server.js');
