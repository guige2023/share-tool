#!/usr/bin/env node
/**
 * ShareTool v2 - 局域网文件/文字分享服务
 * 特性: SQLite 数据库 / WebSocket 实时同步 / 设备发现 / 动态 Token / HTTPS / 审计日志
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const cryptoModule = require('./crypto');

// 内部模块
const db = require('./db');

// WebSocket 服务器
const { WebSocketServer } = require('ws');
// UDP 设备发现
const dgram = require('dgram');
// 批量打包
const archiver = require('archiver');

// 结构化日志
const pino = require('pino');
const LOG_LEVEL = (function() {
  const envLevel = process.env.SHARETOOL_LOG_LEVEL;
  if (envLevel && ['trace','debug','info','warn','error','fatal'].includes(envLevel)) return envLevel;
  return 'info';
})();
const logger = pino({
  level: LOG_LEVEL,
  transport: process.stdout.isTTY ? {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' }
  } : undefined,
  base: { service: 'sharetool', pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ============================================================
// 常量配置
// ============================================================
const MAX_TS = 32503680000000; // 3000-01-01，永久不过期的时间戳
const PORT = 18790;
const HTTPS_PORT = 18793; // HTTPS 端口
const WS_PORT = 18791;  // WebSocket 专用端口
const DISCOVERY_PORT = 18792; // UDP 广播发现端口
const BROADCAST_INTERVAL = 5000; // 5秒广播一次

const SHARE_DIR = path.join(os.homedir(), '.share-tool', 'files');
const CONFIG_FILE = path.join(os.homedir(), '.share-tool', 'config.json');
const SSL_DIR = path.join(os.homedir(), '.share-tool', 'ssl');

// ============================================================
// i18n - 国际化翻译（默认简体中文，英文为备用）
// ============================================================
const I18N = {
  // 语言映射
  LANG_MAP: { 'zh': 'zh', 'en': 'en', 'zh-CN': 'zh', 'en-US': 'en' },
  DEFAULT_LANG: 'zh',

  // 翻译数据
  zh: {
    // 操作结果
    'msg.copied': '已复制',
    'ui.copy': '复制',
    'msg.copy.failed': '复制失败',
    'msg.delete.failed': '删除失败:',
    'msg.rename.failed': '重命名失败',
    'msg.update.failed': '更新失败',
    'msg.link.copied': '链接已复制',
    'msg.share.failed': '获取分享链接失败',
    'msg.deleted': '已删除',
    'msg.renamed': '已重命名',
    'msg.loading': '加载中',
    'msg.retry': '重试',
    'msg.clear': '清除',
    'msg.retry.all': '重试全部',
    'msg.close': '关闭',
    'msg.cancel': '取消',
    'msg.confirm': '确认',
    'msg.optional': '可选',
    'msg.confirmDelete': '确定删除 {name}？',
    'ui.confirmDelete': '确定删除',
    'msg.confirmDeleteAll': '确定删除所有文件?',
    'msg.confirmDeleteSelected': '确定删除选中的 {n} 个文件?',
    'msg.confirmDeleteDays': '确定删除 {n} 天前的文件?',
    'msg.copiedToClipboard': '✓ 链接已复制到剪贴板',
    'msg.textShareSuccess': '✓ 文字分享成功',
    'msg.textShareFailed': '失败:',
    'msg.uploadSuccess': '上传成功',
    'msg.uploadFailed': '重试失败:',
    'msg.uploaded': '已上传',
    'msg.uploadFail': '，失败',
    'msg.contentCopied': '内容已复制',
    'msg.copyContent': '复制内容:',
    'msg.movedTo': '已移动 {n} 个文件到 {dest}',
    'msg.moveFailedN': '移动失败 {n} 个文件',
    'file.inputMoveFolderPrefix': '请输入目标虚拟文件夹前缀（如 work/docs/）：\n选中的 {n} 个文件将被移动到此目录下',
    'msg.pasted': '✓ 图片已粘贴上传:',
    'msg.noFileSelected': '请先选择文件',
    'msg.batchPackUnavailable': '批量打包不可用，正在逐个打开下载...',
    'msg.downloadFailed': '下载失败:',
    'msg.batchDownloadSuccess': '批量下载成功',
    'msg.batchDownloadFailed': '批量下载失败:',
    'msg.downloadDirSaved': '下载目录已保存（仅本机有效）',
    'msg.noContent': '暂无分享内容',
    'msg.getFailed': '获取失败',
    'msg.tokenRefreshed': '已刷新',
    'msg.linkCopied': '✓ 链接已复制',
    'msg.createShareFailed': '创建分享链接失败',
    'msg.invalidFilename': '文件名无效',
    'msg.shareFailed': '分享失败',
    'msg.deletedN': '已删除 {n} 个文件',
    'msg.copiedN': '已复制 {n} 个文件',
    'msg.copyFailedN': '已复制 {n} 个文件，{m} 个失败',
    'msg.copiedTo': '已复制 {n} 个文件到 {dest}',
    'msg.batchStarred': '已收藏 {n} 个文件',
    'file.invalidName': '文件名无效',
    'file.retry': '重试',
    'file.storage': '存储',
    'file.httpsDisabled': 'HTTPS 未启用',
    'file.httpsLanSkip': '局域网可跳过',
    'file.checkFailed': '检测失败',


    // 文件状态
    'file.deleted': '已删除',
    'file.unavailable': '文件不可用',
    'file.download': '下载',
    'file.preview': '预览',
    'file.rename': '重命名',
    'file.delete': '删除',
    'file.copy': '复制',
    'file.copyContent': '复制内容',
    'file.share': '分享',
    'file.files': '文件',
    'file.view': '查看',
    'file.play': '播放',
    'file.history': '历史',
    'file.info': '详情',
    'file.addTag': '添加标签',
    'file.dblclickRename': '双击重命名',
    'file.enterFolder': '点击进入文件夹',
    'file.previewPdf': '预览PDF',
    'file.previewMd': '预览MD',
    'file.orText': '或',
    'file.pasteHint': '可直接 Ctrl+V 粘贴图片或文件',
    'file.selected': '已选择',
    'file.noContent': '暂无分享内容',
    'file.uploadOrShare': '上传文件或分享文字开始使用',
    'file.upload': '上传文件',
    'file.shareText': '分享文字',
    'file.textShare': '文字分享',
    'file.share': '分享',
    'file.copyLink': '复制链接',
    'file.twoQR': '二维码',
    'file.noFiles': '天',
    'file.numFiles': '个文件',

    // 设备
    'device.server': '服务器',
    'device.notConnected': '未连接',
    'device.connected': '已连接',
    'device.devices': '设备',
    'device.lan': '局域网',
    'device.lanFile': '局域网文件',
    'device.discovery': '设备发现',
    'device.firstLaunch': '首次启动',
    'device.start': '启动',
    'device.syncOnline': '同步在线',
    'device.connection': '连接',
    'device.noOnlineDevices': '暂无在线设备',
    'device.discovering': '正在发现设备...',
    'device.wsConnected': 'WS 已连接',
    'device.wsDisconnected': 'WS 未连接',
    'device.syncPending': '项待同步',
    'device.syncing': '同步中',
    'device.online': '同步在线',

    // 同步
    'sync.incSync': '📥 增量同步 {n} 项',
    'sync.newFileReceived': '📤 收到新文件:',
    'sync.remoteDeleted': '🗑 远程删除了文件',
    'sync.remoteRenamed': '✏️ 远程重命名:',
    'sync.remoteMoved': '📁 远程移动了文件:',
    'sync.syncSuccess': '✅ 同步成功:',
    'sync.conflictResolved': '🔄 冲突解决: 已重命名文件保留双方版本',
    'sync.discovered': '📡 发现',
    'sync.pendingChanges': '项待同步变更，开始拉取...',
    'sync.incSyncChange': '应用增量同步变更',
    'sync.diffUpdate': '差异更新',
    'sync.newFile': '收到新文件',
    'sync.remoteRename': '远程重命名',
    'sync.conflict': '冲突',
    'sync.conflictResolve': '冲突解决',
    'sync.keepLocal': '保留本地版本',
    'sync.keepRemote': '接受远程版本',
    'sync.keepBoth': '保留两个版本',
    'sync.later': '稍后处理',
    'sync.localVersion': '本地版本',
    'sync.remoteVersion': '远程版本',
    'sync.fileConflict': '文件冲突',
    'sync.conflictDesc': '文件 {name} 在两台设备上被同时修改',
    'sync.localKept': '已保留本地版本',
    'sync.remoteKept': '已接受远程版本',
    'sync.multiVersionNote': '需要服务器支持多版本存储',

    // 分享
    'share.link': '分享链接',
    'share.expired': '已过期',
    'share.neverExpire': '永不过期',
    'share.manualRenew': '手动续期',
    'share.password': '密码',
    'share.lifetime': '有效期',
    'share.copyLink': '复制链接',
    'share.qrCode': '二维码',
    'share.downloads': '次下载',
    'share.linkCopied': '✓ 链接已复制',
    'share.linkCopyFailed': '复制失败',
    'share.email': '📧 邮件',
    'share.emailSubject': '与你分享',
    'share.emailBody': '我通过 ShareTool 向你分享了文件',
    'share.emailVia': '—— via ShareTool',
    'share.confirmDelete': '确定删除此分享链接？',
    'share.deleteExpired': '🗑 清理过期',
    'share.confirmDeleteExpired': '确定删除所有过期分享链接？',
    'share.noExpired': '没有过期分享链接',
    'share.deletedExpired': '个过期链接已删除',
    'share.editLink': '编辑分享链接',
    'share.leaveBlank': '留空则不修改密码',
    'share.deleted': '已删除',
    'share.deleteFailed': '删除失败:',
    'share.neverExpire': '永不过期',
    'share.expired': '已过期',
    'share.daysLeft': '剩余',
    'share.day': '天',
    'share.unlimited': '不限制',
    'share.noPassword': '不设置密码',
    'share.create': '创建链接',
    'share.manage': '管理分享链接',
    'share.createNew': '创建分享链接',
    'share.getLinkFailed': '获取分享链接失败',
    'share.24h': '24小时',
    'share.3days': '3天',
    'share.7days': '7天（默认）',
    'share.30days': '30天',
    'share.never': '永不过期',
    'share.downloadLimit': '下载次数限制（可选）',
    'share.passwordOptional': '密码保护（可选）',
    'share.passwordStrength': '密码强度',
    'share.passwordWeak': '弱（建议8位以上含数字）',
    'share.passwordMedium': '中',
    'share.passwordStrong': '强',
    'share.description': '备注',
    'share.descriptionPlaceholder': '给链接加个备注（可选）',
    'share.linkCreateFailed': '创建分享链接失败',
    'share.successCreated': '✓ 分享链接已创建',
    'share.batchCreate': '🔗 批量创建分享（{n}个）',
    'share.batchResult': '✓ 成功创建{n}个分享，失败{m}个',
    'share.failed': '分享失败:',
    'share.generateFirst': '请先生成分享链接',

    // 管理
    'admin.config': '配置',
    'admin.settings': '设置',
    'admin.audit': '审计日志',
    'admin.tagMgmt': '标签管理',
    'admin.tags': '标签',
    'admin.noTags': '暂无标签',
    'admin.audit': '审计日志',
    'admin.auditTitle': '📊 审计日志',
    'admin.todayOps': '今日操作',
    'admin.totalOps': '总操作',
    'admin.lastOp': '最后操作',
    'admin.noLogs': '暂无日志记录',
    'admin.viewAudit': '查看审计日志',
    'admin.settings': '设置',
    'admin.accessToken': '访问 Token',
    'admin.changeToken': '更换Token',
    'admin.refresh': '刷新',
    'admin.https': 'HTTPS 状态',
    'admin.httpsEnabled': '✅ HTTPS 已启用',
    'admin.httpsDisabled': '⚠️ HTTPS 未启用',
    'admin.checkFailed': '检测失败',

    'admin.httpsExpire': '到期:',
    'admin.httpsDays': '天)',
    'admin.httpsLan': '局域网可跳过',
    'admin.renew': '手动续期',
    'admin.renewing': '续期中...',
    'admin.renewed': '证书已续期',
    'admin.renewFailed': '续期失败:',
    'admin.renewReqFailed': '续期请求失败',
    'admin.unknown': '未知错误',
    'admin.tokenRefreshed': 'Token 已刷新',
    'admin.expired': '已过期',
    'admin.refreshed': '已刷新',
    'admin.refreshFailed': '刷新失败:',
    'admin.refreshFail': '刷新失败',
    'admin.configSaved': '配置已保存',
    'admin.saveFailed': '保存失败:',
    'admin.saveReqFailed': '保存请求失败',
    'admin.none': '(无)',
    'admin.tokenUpdated': 'Token 更新成功',
    'admin.updateFailed': '更新失败:',
    'admin.updateFail': '更新失败',
    'admin.rateLimit': '暴力破解防护',
    'admin.rateLimitConfig': '配置',
    'admin.loaded': '加载中...',
    'admin.getFailed': '获取日志失败',
    'admin.exported': '审计日志已导出',
    'admin.opts': '可选',
    'admin.actionBreakdown': '操作分布',
    'ui.all': '全部',
    'share.noLinks': '暂无分享链接',

    // 收藏
    'fav.favorite': '收藏',
    'fav.favorites': '收藏管理',
    'fav.addFav': '添加收藏',
    'fav.removeFav': '取消收藏',
    'fav.noFavorites': '暂无收藏',
    'fav.goTo': '跳到',
    'fav.removed': '已移除收藏',

    // 错误
    'err.unknown': '未知错误',
    'err.failed': '失败',
    'err.genFailed': '生成失败',
    'err.reqFailed': '请求失败',
    'err.notFound': '未找到',
    'err.browserNotSupport': '您的浏览器不支持',
    'err.getLinkFailed': '获取分享链接失败',

    // 标签
    'tag.manager': '标签管理',
    'tag.rename': '重命名',
    'tag.delete': '删除',
    'tag.merge': '合并',
    'tag.mergeHint': '选择要合并的标签（将合并到目标标签）',
    'tag.mergeTarget': '合并到：',
    'tag.mergeConfirm': '确认合并',
    'tag.mergeSuccess': '已合并 {n} 个文件到 {target}',
    'tag.mergeFailed': '合并失败',
    'tag.mergeSelectFirst': '请先选择要合并的标签',
    'tag.mergeNoTarget': '请先选择一个目标标签',
    'tag.inputName': '请输入标签名称（多个用逗号分隔）:',
    'tag.added': '已为 {n} 个文件添加标签',
    'tag.addFailed': '批量添加失败:',
    'tag.colorChanged': '颜色已更新',
    'tag.batchColorChanged': '已更新 {n} 个标签颜色',
    'tag.clickChangeColor': '点击修改颜色',
    'tag.changeColor': '批量改颜色',
    'tag.selected': '已选择',
    'tag.confirmBatchDelete': '确认删除这 {n} 个标签？',
    'tag.batchDeleted': '已删除 {n} 个标签',
    'tag.doubleClickRename': '双击重命名',
    'tag.viewFiles': '点击查看使用该标签的文件',
    'tag.count': '个',
    'tag.iconChanged': '图标已更新',
    'tag.changeIcon': '修改图标',
    'tag.iconChangeFailed': '图标更新失败',
    'tag.inputHint': '输入标签，多个用逗号分隔',
    'tag.color': '颜色',
    'tag.renamePrompt': '将标签 "{old}" 重命名为：',
    'tag.renameSuccess': '已重命名，更新了 {n} 个文件',
    'tag.renameFailed': '重命名失败',
    'tag.confirmDelete': '确定删除标签 "{name}"？将从所有文件中移除。',
    'tag.removed': '已删除，从 {n} 个文件中移除',
    'tag.removedLabel': '已移除标签',
    'tag.removePrompt': '请输入要移除的标签名称:',
    'tag.removedN': '已从 {n} 个文件移除标签',
    'tag.removeFailed': '批量移除标签失败:',

    // 版本历史
    'ver.history': '历史版本',
    'ver.restore': '恢复',
    'ver.confirmRestore': '确定要恢复到这个版本吗？当前内容会作为新版本保存。',
    'ver.restored': '已恢复到版本',
    'ver.restoreFailed': '恢复失败:',
    'ver.confirmDelete': '确定要删除这个版本吗？',
    'ver.noVersions': '暂无历史版本',
    'ver.loadFailed': '加载版本失败',
    'ver.backToList': '← 返回列表',
    'ver.empty': '(空)',

    // 文件操作
    'file.inputNewName': '输入新文件名:',
    'file.inputFolderName': '输入新文件夹名称:',
    'file.renamed': '已重命名',
    'file.renameFailed': '重命名失败:',
    'file.deleted': '已删除',
    'file.deleteFailed': '删除失败:',
    'file.inputFolderPrefix': '请输入目标虚拟文件夹前缀（如 work/backup/）:\n选中的 {n} 个文件将被复制到此目录下',
    'file.copied': '已复制',
    'file.copiedCount': '已复制 {n} 个文件，{e} 个失败',
    'file.copyDest': '个文件到',
    'file.versionRestore': '已恢复到版本',
    'file.skipAlreadyLoaded': '已有内容，跳过',
    'file.storage': '存储:',
    'file.storageNone': '存储: --',

    // 音频/视频
    'media.browserNotSupportAudio': '您的浏览器不支持音频播放',
    'media.browserNotSupportVideo': '您的浏览器不支持视频播放',
    'media.tableOfContents': '目录',
    'media.audio': '音频',
    'media.video': '视频',

    // 搜索
    'search.noResults': '未找到结果',
    'search.found': '找到',
    'search.results': '个结果',
    'search.failed': '搜索失败',
    'search.inputContent': '请输入内容',
    'search.historyClear': '✕清除',
    'search.manage': '⚙管理',

    // 设备
    'device.device': '设备:',
    'device.allFiles': '📁 全部文件',
    'device.fileCount': '个文件',

    // PWA
    'pwa.addToHome': '添加到主屏幕，离线也能访问',
    'pwa.install': '安装',
    'pwa.fileUpload': '上传文件',
    'pwa.shareText': '分享文字',

    // UI 状态文本
    'ui.connecting': '连接中',
    'ui.loading': '加载中...',
    'ui.wsDisconnected': 'WS 未连接',
    'ui.syncOffline': '同步离线',
    'ui.devices': '设备',
    'ui.heroTitle': '局域网文件/文字分享',
    'ui.heroDesc': '同一 WiFi 网络下扫码访问，支持多设备同步。',
    'ui.textShare': '文字分享',
    'ui.fileUpload': '上传文件',
    'ui.multiDeviceSync': '多设备同步',
    'ui.searchFilter': '搜索过滤',
    'ui.mobileAdapt': '移动适配',
    'ui.pasteHint': '可直接 Ctrl+V 粘贴图片或文件',
    'ui.share': '分享',
    'ui.clear': '清空',
    'ui.close': '关闭',
    'fileInfo.basic': '基本信息',
    'fileInfo.tags': '标签',
    'fileInfo.share': '分享链接',
    'fileInfo.size': '大小',
    'fileInfo.type': '类型',
    'fileInfo.hash': '哈希',
    'fileInfo.encrypted': '加密',
    'fileInfo.created': '创建时间',
    'fileInfo.updated': '修改时间',
    'fileInfo.versions': '历史版本',
    'fileInfo.shareCount': '活跃链接',
    'fileInfo.noShares': '暂无分享链接',
    'fileInfo.yes': '是',
    'fileInfo.no': '否',
    'fileInfo.loading': '加载中...',
    'fileInfo.copyHash': '复制哈希',
    'fileInfo.openVersions': '查看历史',
    'ui.copyLink': '复制链接',
    'ui.qrCode': '二维码',
    'ui.shareQR': '分享二维码',
    'ui.textareaPlaceholder': '输入文字、代码或粘贴内容...',
    'ui.toggleTheme': '切换主题',
    'ui.fileUpload': '上传文件',
    'ui.dragDropHint': '拖拽文件到此处上传',
    'ui.orUseButtons': '或继续使用下方按钮',
    'ui.clickOrDrag': '点击或拖拽文件到此处',
    'ui.supportFolderUpload': '支持文件和文件夹上传',
    'ui.recentShares': '最近分享',
    'ui.searchPlaceholder': '搜索文件名...',
    'ui.filterByTag': '标签筛选',
    'ui.searchTags': '搜索标签...',
    'ui.clearFilter': '清除筛选',
    'ui.noFiles': '暂无分享内容',
    'ui.noFilesHint': '上传文件或分享文字开始使用',
    'ui.selectAll': '全选',
    'ui.deleteSelected': '删除选中',
    'ui.noResults': '未找到匹配结果',
    'ui.tryOtherKeywords': '尝试其他关键词或清除筛选',
    'ui.items': '个文件',
    'ui.page': '第',
    'ui.of': '页，共',
    'ui.search': '搜索',
    'ui.filterAll': '全部',
    'ui.tagMatchAll': '匹配全部标签',
    'ui.tagMatchAny': '匹配任一标签',
    'ui.tagMatch': '标签',
    'ui.tagMatchHint': '点击切换标签匹配模式：AND（全部）或 OR（任一）',
    'ui.filterStarred': '收藏',
    'ui.filterText': '文字',
    'ui.filterFile': '文件',
    'ui.selectedN': '已选择 {n} 个文件',
    'ui.batchDownload': '下载',
    'ui.batchTag': '标签',
    'ui.batchRemoveTag': '移除标签',
    'ui.batchStar': '收藏',
    'ui.batchRename': '重命名',
    'ui.batchCopy': '复制',
    'ui.batchMove': '移动',
    'ui.batchDelete': '删除',
    'ui.batchCancel': '取消',
    'ui.remove': '移除',
    'ui.files': '个文件',
    'ui.sortBy': '排序',
    'ui.sortNewest': '最新优先',
    'ui.sortOldest': '最旧优先',
    'ui.sortNameAZ': '名称 A-Z',
    'ui.sortNameZA': '名称 Z-A',
    'ui.sortLargest': '最大优先',
    'ui.sortSmallest': '最小优先',
    'ui.sortTypeAZ': '类型 A-Z',
    'ui.sortTypeZA': '类型 Z-A',
    'sort.byCount': '按使用量',
    'sort.alpha': '按名称',
    'sort.byColor': '按颜色',
    'sort.byRecent': '最近使用',
    'tags.empty': '暂无标签',
    'ui.sortTagAZ': '标签 A-Z',
    'ui.sortTagZA': '标签 Z-A',
    'ui.sortMostDownloaded': '下载最多',
    'ui.sortLeastDownloaded': '下载最少',
    'ui.sortManual': '手动',
    'ui.allFiles': '所有文件',
    'ui.trash': '回收站',
    'ui.trashEmpty': '清空回收站',
    'ui.trashRestore': '恢复',
    'ui.trashPermanentDelete': '永久删除',
    'ui.trashExpiresIn': '{n} 天后自动删除',
    'ui.trashEmptyConfirm': '确定清空回收站？此操作不可恢复！',
    'ui.trashEmptyTitle': '回收站（30天后自动清理）',
    'ui.trashEmptyInfo': '选中项目将被永久删除',
    'ui.trashEmptySuccess': '已清空回收站',
    'ui.trashRestoreSuccess': '已恢复到: ',
    'ui.trashRestoreFailed': '恢复失败',
    'ui.trashDeleteSuccess': '已永久删除',
    'ui.trashNoItems': '回收站为空',
    'ui.noResults': '未找到匹配结果',
    'ui.tryOtherKeywords': '试试其他关键词或清除筛选',
    'ui.shortcuts': '快捷键',
    'ui.shortcutHelp': '? 查看快捷键',
    'ui.shortcutNewUpload': 'N 上传文件',
    'ui.shortcutSearch': '/ 搜索',
    'ui.shortcutCopyLink': 'C 复制链接',
    'ui.shortcutToggleFav': 'F 收藏筛选',
    'ui.shortcutToggleSelect': 'X 选中/取消',
    'ui.shortcutTagSelected': 'T 批量标签',
    'ui.shortcutOpenFocused': 'Enter 打开文件',
    'ui.shortcutRefresh': 'R 刷新',
    'ui.shortcutClose': 'Esc 关闭',
    'ui.shortcutMoveFocus': 'J/K 上下移动焦点',
    'ui.shortcutDeleteFocused': 'Del 删除焦点项',
    'ui.shortcutTextNote': 'M 文字笔记',
    'ui.shortcutSelectAll': 'A 全选/取消全选',
    'ui.shortcutStarFocused': 'S 收藏当前文件',
    'ui.shortcutGoRoot': 'G 回到根目录',
    'ui.shortcutImageNav': '← → 图片左右切换',
    'ui.listView': '列表视图',
    'ui.gridView': '网格视图',
    'ui.resultsFound': '找到 {n} 个结果',
    'ui.save': '保存',
    'ui.saved': '已保存',
    'ui.saveFailed': '保存失败',
    'ui.edit': '编辑',
    'ui.downloadDir': '下载目录',
    'ui.remoteUpload': '远程下载',
    'ui.download': '下载',
    'ui.deleteAll': '删除全部',
    'ui.delete1Week': '删除1周前',
    'ui.delete1Month': '删除1月前',
    'ui.confirmDeleteAll': '确定删除所有文件?',
    'ui.confirmDeleteSelected': '确定删除选中的 {n} 个文件?',
    'ui.confirmDeleteDays': '确定删除 {n} 天前的所有文件?',
    'ui.unknown': '未知',
    'pwa.installTitle': '安装应用',
    'pwa.installDesc': '安装后可获得更好的使用体验',
    'admin.checking': '检查中...',
    'admin.daysLeft': '剩余 {n} 天',
    'msg.failed': '失败',
    'msg.inputRequired': '请输入内容',
    'file.textShareSuccess': '文字分享成功',
    'file.linkCopied': '链接已复制',
    'file.noFileSelected': 'Please select a file first',
    'share.createFailed': '创建分享失败',
  },

  en: {
    'msg.copied': 'Copied',
    'ui.copy': 'Copy',
    'msg.copy.failed': 'Copy failed',
    'msg.delete.failed': 'Delete failed',
    'msg.rename.failed': 'Rename failed',
    'msg.update.failed': 'Update failed',
    'msg.link.copied': 'Link copied',
    'msg.share.failed': 'Failed to get share link',
    'msg.deleted': 'Deleted',
    'msg.renamed': 'Renamed',
    'msg.loading': 'Loading',
    'msg.retry': 'Retry',
    'msg.clear': 'Clear',
    'msg.retry.all': 'Retry all',
    'msg.close': 'Close',
    'msg.cancel': 'Cancel',
    'msg.confirm': 'Confirm',
    'msg.optional': 'optional',

    // 文件状态
    'file.deleted': 'Deleted',
    'file.unavailable': 'File unavailable',
    'file.download': 'Download',
    'file.preview': 'Preview',
    'file.rename': 'Rename',
    'file.delete': 'Delete',
    'file.copy': 'Copy',
    'file.copyContent': 'Copy content',
    'file.share': 'Share',
    'file.files': 'Files',
    'file.view': 'View',
    'file.play': 'Play',
    'file.history': 'History',
    'file.info': 'Info',
    'file.addTag': 'Add tag',
    'file.dblclickRename': 'Double-click to rename',
    'file.enterFolder': 'Click to enter folder',
    'tag.viewFiles': 'Click to view files with this tag',
    'tag.count': '',
    'file.previewPdf': 'Preview PDF',
    'file.previewMd': 'Preview MD',
    'file.orText': 'or',
    'file.pasteHint': 'Paste images or files with Ctrl+V',
    'file.selected': 'selected',
    'file.noContent': 'No content yet',
    'file.uploadOrShare': 'Upload files or share text to get started',
    'file.upload': 'Upload file',
    'file.shareText': 'Share text',
    'file.textShare': 'Text share',
    'file.copyLink': 'Copy link',
    'file.twoQR': 'QR Code',
    'file.noFiles': 'days',
    'file.numFiles': 'files',

    // 设备
    'device.server': 'Server',
    'device.notConnected': 'Not connected',
    'device.connected': 'Connected',
    'device.devices': 'Devices',
    'device.lan': 'LAN',
    'device.lanFile': 'LAN Files',
    'device.discovery': 'Device discovery',
    'device.firstLaunch': 'First launch',
    'device.start': 'Start',
    'device.syncOnline': 'Sync online',
    'device.connection': 'Connection',
    'device.noOnlineDevices': 'No online devices',
    'device.discovering': 'Discovering devices...',
    'device.wsConnected': 'WS Connected',
    'device.wsDisconnected': 'WS Disconnected',
    'device.syncPending': 'pending sync',
    'device.syncing': 'Syncing',
    'device.online': 'Sync online',
    'device.device': 'Device:',
    'device.allFiles': '📁 All files',
    'device.fileCount': 'files',

    // 同步
    'sync.incSync': 'Incremental sync',
    'sync.incSyncChange': 'Apply incremental sync changes',
    'sync.diffUpdate': 'Diff update',
    'sync.newFile': 'New file received',
    'sync.remoteRename': 'Remote rename',
    'sync.conflict': 'Conflict',
    'sync.conflictResolve': 'Conflict resolution',
    'sync.keepLocal': 'Keep local version',
    'sync.keepRemote': 'Accept remote version',
    'sync.keepBoth': 'Keep both versions',
    'sync.later': 'Later',
    'sync.localVersion': 'Local version',
    'sync.remoteVersion': 'Remote version',
    'sync.fileConflict': 'File conflict',
    'sync.conflictDesc': 'File {name} was modified simultaneously on two devices',
    'sync.localKept': 'Local version kept',
    'sync.remoteKept': 'Remote version accepted',
    'sync.multiVersionNote': 'Requires server multi-version storage support',
    'sync.newFileReceived': '📤 New file received:',
    'sync.remoteDeleted': '🗑 File deleted remotely',
    'sync.remoteRenamed': '✏️ Renamed remotely:',
    'sync.remoteMoved': '📁 Moved remotely:',
    'sync.syncSuccess': '✅ Sync success:',
    'sync.conflictResolved': '🔄 Conflict resolved: renamed files kept both versions',
    'sync.discovered': '📡 Discovered',
    'sync.pendingChanges': ' pending changes, pulling...',

    // 分享
    'share.link': 'Share link',
    'share.expired': 'Expired',
    'share.neverExpire': 'Never expires',
    'share.manualRenew': 'Manual renew',
    'share.password': 'Password',
    'share.lifetime': 'Lifetime',
    'share.copyLink': 'Copy link',
    'share.qrCode': 'QR Code',
    'share.downloads': 'downloads',
    'share.linkCopied': '✓ Link copied',
    'share.linkCopyFailed': 'Copy failed',
    'share.email': '📧 Email',
    'share.emailSubject': 'Sharing with you',
    'share.emailBody': 'I shared a file with you via ShareTool',
    'share.emailVia': '—— via ShareTool',
    'share.confirmDelete': 'Delete this share link?',
    'share.deleteExpired': '🗑 Clear expired',
    'share.confirmDeleteExpired': 'Delete all expired share links?',
    'share.noExpired': 'No expired share links',
    'share.deletedExpired': 'expired links deleted',
    'share.editLink': 'Edit share link',
    'share.leaveBlank': 'Leave blank to keep current password',
    'share.deleted': '✓ Deleted',
    'share.deleteFailed': 'Delete failed',
    'share.daysLeft': 'Remaining',
    'share.day': 'days',
    'share.unlimited': 'Unlimited',
    'share.noPassword': 'No password',
    'share.create': 'Create link',
    'share.manage': 'Manage share links',
    'share.createNew': 'Create share link',
    'share.getLinkFailed': 'Failed to get share link',
    'share.24h': '24 hours',
    'share.3days': '3 days',
    'share.7days': '7 days (default)',
    'share.30days': '30 days',
    'share.never': 'Never',
    'share.downloadLimit': 'Download limit (optional)',
    'share.passwordOptional': 'Password protection (optional)',
    'share.passwordStrength': 'Password strength',
    'share.passwordWeak': 'Weak (8+ chars with numbers recommended)',
    'share.passwordMedium': 'Medium',
    'share.passwordStrong': 'Strong',
    'share.description': 'Description',
    'share.descriptionPlaceholder': 'Add a note (optional)',
    'share.linkCreateFailed': 'Failed to create share link',
    'share.successCreated': '✓ Share link created',
    'share.batchCreate': '🔗 Batch Create Share ({n} files)',
    'share.batchResult': '✓ Created {n} share links, {m} failed',
    'share.failed': 'Share failed:',
    'share.generateFirst': 'Please generate a share link first',
    'share.noLinks': 'No share links',

    // 管理
    'admin.config': 'Config',
    'admin.settings': 'Settings',
    'admin.audit': 'Audit log',
    'admin.tagMgmt': 'Tag management',
    'admin.tags': 'Tags',
    'admin.noTags': 'No tags',
    'admin.auditTitle': '📊 Audit Log',
    'admin.todayOps': 'Today',
    'admin.totalOps': 'Total',
    'admin.lastOp': 'Last op',
    'admin.noLogs': 'No log records',
    'admin.viewAudit': 'View audit log',
    'admin.accessToken': 'Access Token',
    'admin.changeToken': 'Change Token',
    'admin.refresh': 'Refresh',
    'admin.https': 'HTTPS Status',
    'admin.httpsEnabled': '✅ HTTPS Enabled',
    'admin.httpsDisabled': '⚠️ HTTPS Disabled',
    'admin.checkFailed': 'Check failed',

    'admin.httpsExpire': 'Expires:',
    'admin.httpsDays': 'days)',
    'admin.httpsLan': 'Skip for LAN',
    'admin.renew': 'Renew',
    'admin.renewing': 'Renewing...',
    'admin.renewed': 'Certificate renewed',
    'admin.renewFailed': 'Renew failed:',
    'admin.renewReqFailed': 'Renew request failed',
    'admin.unknown': 'Unknown error',
    'admin.tokenRefreshed': 'Token refreshed',
    'admin.expired': 'Expired',
    'admin.refreshed': 'Refreshed',
    'admin.refreshFailed': 'Refresh failed:',
    'admin.refreshFail': 'Refresh failed',
    'admin.configSaved': 'Config saved',
    'admin.saveFailed': 'Save failed:',
    'admin.saveReqFailed': 'Save request failed',
    'admin.none': '(none)',
    'admin.tokenUpdated': 'Token updated',
    'admin.updateFailed': 'Update failed:',
    'admin.updateFail': 'Update failed',
    'admin.rateLimit': 'Brute-force protection',
    'admin.rateLimitConfig': 'Configure',
    'admin.loaded': 'Loading...',
    'admin.getFailed': 'Failed to get logs',
    'admin.exported': 'Audit log exported',
    'admin.opts': 'optional',
    'admin.actionBreakdown': 'Action Breakdown',
    'ui.all': 'All',

    // 收藏
    'fav.favorite': 'Favorite',
    'fav.favorites': 'Favorites Manager',
    'fav.addFav': 'Add favorite',
    'fav.removeFav': 'Remove favorite',
    'fav.noFavorites': 'No favorites yet',
    'fav.goTo': 'Go to',
    'fav.removed': 'Removed from favorites',

    // 错误
    'err.unknown': 'Unknown error',
    'err.failed': 'Failed',
    'err.genFailed': 'Generation failed',
    'err.reqFailed': 'Request failed',
    'err.notFound': 'Not found',
    'err.browserNotSupport': 'Your browser does not support',
    'err.getLinkFailed': 'Failed to get share link',

    // 标签
    'tag.manager': 'Tag management',
    'tag.inputHint': 'Enter tags, comma separated',
    'tag.color': 'Color',
    'tag.rename': 'Rename',
    'tag.delete': 'Delete',
    'tag.merge': 'Merge',
    'tag.mergeHint': 'Select tags to merge (will be merged into target)',
    'tag.mergeTarget': 'Merge into:',
    'tag.mergeConfirm': 'Confirm merge',
    'tag.mergeSuccess': 'Merged {n} files into {target}',
    'tag.mergeFailed': 'Merge failed',
    'tag.mergeSelectFirst': 'Please select tags to merge first',
    'tag.mergeNoTarget': 'Please select a target tag first',
    'tag.inputName': 'Enter tag name (multiple separated by comma):',
    'tag.added': 'Added tag to {n} files',
    'tag.addFailed': 'Batch add failed:',
    'tag.colorChanged': 'Color updated',
    'tag.batchColorChanged': 'Batch color updated for {n} tags',
    'tag.clickChangeColor': 'Click to change color',
    'tag.doubleClickRename': 'Double-click to rename',
    'tag.viewFiles': 'Click to view files with this tag',
    'tag.count': '',
    'tag.iconChanged': 'Icon updated',
    'tag.changeIcon': 'Change icon',
    'tag.iconChangeFailed': 'Failed to update icon',
    'tag.renamePrompt': 'Rename tag "{old}" to:',
    'tag.renameSuccess': 'Renamed, updated {n} files',
    'tag.renameFailed': 'Rename failed',
    'tag.confirmDelete': 'Delete tag "{name}"? Will be removed from all files.',
    'tag.removed': 'Removed, from {n} files',
    'tag.removedLabel': 'Tag removed',
    'tag.removePrompt': 'Enter tag name to remove:',
    'tag.removedN': 'Removed tag from {n} files',
    'tag.removeFailed': 'Batch remove tag failed:',
    'tag.noneToRemove': 'No tags to remove',

    // 版本历史
    'ver.history': 'Version history',
    'ver.restore': 'Restore',
    'ver.confirmRestore': 'Restore to this version? Current content will be saved as new version.',
    'ver.restored': 'Restored to version',
    'ver.restoreFailed': 'Restore failed:',
    'ver.confirmDelete': 'Delete this version?',
    'ver.noVersions': 'No version history',
    'ver.loadFailed': 'Failed to load versions',
    'ver.backToList': '← Back to list',
    'ver.empty': '(empty)',

    // 文件操作
    'file.inputNewName': 'Enter new filename:',
    'file.inputFolderName': 'Enter new folder name:',
    'file.renamed': 'Renamed',
    'file.renameFailed': 'Rename failed:',
    'file.deleted': 'Deleted',
    'file.deleteFailed': 'Delete failed:',
    'file.inputFolderPrefix': 'Enter target virtual folder prefix (e.g. work/backup/):\n{n} files will be copied to this directory',
    'file.copied': 'Copied',
    'file.copiedCount': 'Copied {n} files, {e} failed',
    'file.copyDest': 'files to',
    'file.versionRestore': 'Restored to version',
    'file.skipAlreadyLoaded': 'Already loaded, skip',
    'file.storage': 'Storage:',
    'file.storageNone': 'Storage: --',

    // 音频/视频
    'media.browserNotSupportAudio': 'Your browser does not support audio playback',
    'media.browserNotSupportVideo': 'Your browser does not support video playback',
    'media.tableOfContents': 'Contents',
    'media.audio': 'Audio',
    'media.video': 'Video',

    // 搜索
    'search.noResults': 'No results found',
    'search.found': 'Found',
    'search.results': 'results',
    'search.failed': 'Search failed',
    'search.inputContent': 'Please enter content',
    'search.historyClear': '✕Clear',
    'search.manage': '⚙Manage',

    // PWA
    'pwa.addToHome': 'Add to home screen, access offline',
    'pwa.install': 'Install',
    'pwa.fileUpload': 'Upload file',
    'pwa.shareText': 'Share text',

    // UI status texts
    'ui.connecting': 'Connecting',
    'ui.loading': 'Loading...',
    'ui.wsDisconnected': 'WS Disconnected',
    'ui.syncOffline': 'Sync offline',
    'ui.devices': 'Devices',
    'ui.heroTitle': 'LAN File & Text Sharing',
    'ui.heroDesc': 'Scan QR code on the same WiFi network, multi-device sync supported.',
    'ui.textShare': 'Text Share',
    'ui.fileUpload': 'File Upload',
    'ui.multiDeviceSync': 'Multi-device Sync',
    'ui.searchFilter': 'Search & Filter',
    'ui.mobileAdapt': 'Mobile Support',
    'ui.pasteHint': 'Paste images or files with Ctrl+V',
    'ui.share': 'Share',
    'ui.clear': 'Clear',
    'ui.close': 'Close',
    'fileInfo.basic': 'Basic Info',
    'fileInfo.tags': 'Tags',
    'fileInfo.share': 'Share Links',
    'fileInfo.size': 'Size',
    'fileInfo.type': 'Type',
    'fileInfo.hash': 'Hash',
    'fileInfo.encrypted': 'Encrypted',
    'fileInfo.created': 'Created',
    'fileInfo.updated': 'Modified',
    'fileInfo.versions': 'Version History',
    'fileInfo.shareCount': 'Active Links',
    'fileInfo.noShares': 'No share links',
    'fileInfo.yes': 'Yes',
    'fileInfo.no': 'No',
    'fileInfo.loading': 'Loading...',
    'fileInfo.copyHash': 'Copy Hash',
    'fileInfo.openVersions': 'View History',
    'ui.confirmDelete': 'Confirm delete',
    'ui.copyLink': 'Copy Link',
    'ui.qrCode': 'QR Code',
    'ui.shareQR': 'Share QR Code',
    'ui.textareaPlaceholder': 'Enter text, code or paste content...',
    'ui.toggleTheme': 'Toggle theme',
    'ui.fileUpload': 'File Upload',
    'ui.dragDropHint': 'Drag & drop files here to upload',
    'ui.orUseButtons': 'or use the buttons below',
    'ui.clickOrDrag': 'Click or drag files here',
    'ui.supportFolderUpload': 'Supports file and folder upload',
    'ui.recentShares': 'Recent Shares',
    'ui.searchPlaceholder': 'Search filenames...',
    'ui.filterByTag': 'Filter by tag',
    'ui.searchTags': 'Search tags...',
    'ui.clearFilter': 'Clear filter',
    'ui.noFiles': 'No shared content yet',
    'ui.noFilesHint': 'Upload files or share text to get started',
    'ui.selectAll': 'Select all',
    'ui.deleteSelected': 'Delete selected',
    'ui.noResults': 'No matching results',
    'ui.tryOtherKeywords': 'Try other keywords or clear filter',
    'ui.items': 'items',
    'ui.page': 'Page',
    'ui.of': 'of',
    'ui.search': 'Search',
    'ui.filterAll': 'All',
    'ui.tagMatchAll': 'Match all tags',
    'ui.tagMatchAny': 'Match any tag',
    'ui.tagMatch': 'Tag',
    'ui.tagMatchHint': 'Click to toggle tag match mode: AND (all) or OR (any)',
    'ui.filterStarred': 'Starred',
    'ui.filterText': 'Text',
    'ui.filterFile': 'File',
    'ui.selectedN': '{n} files selected',
    'ui.batchDownload': 'Download',
    'ui.batchTag': 'Tag',
    'ui.batchRemoveTag': 'Remove tag',
    'ui.batchStar': 'Star',
    'ui.batchRename': 'Rename',
    'ui.batchCopy': 'Copy',
    'ui.batchMove': 'Move',
    'ui.batchDelete': 'Delete',
    'ui.batchCancel': 'Cancel',
    'ui.remove': 'Remove',
    'ui.files': 'files',
    'ui.sortBy': 'Sort',
    'ui.sortNewest': 'Newest first',
    'ui.sortOldest': 'Oldest first',
    'ui.sortNameAZ': 'Name A-Z',
    'ui.sortNameZA': 'Name Z-A',
    'ui.sortLargest': 'Largest first',
    'ui.sortSmallest': 'Smallest first',
    'ui.sortTypeAZ': 'Type A-Z',
    'ui.sortTypeZA': 'Type Z-A',
    'sort.byCount': 'By count',
    'sort.alpha': 'By name',
    'sort.byColor': 'By color',
    'sort.byRecent': 'Recent',
    'tags.empty': 'No tags yet',
    'ui.sortTagAZ': 'Tag A-Z',
    'ui.sortTagZA': 'Tag Z-A',
    'ui.sortMostDownloaded': 'Most downloaded',
    'ui.sortLeastDownloaded': 'Least downloaded',
    'ui.sortManual': 'Manual',
    'ui.allFiles': 'All files',
    'ui.trash': 'Trash',
    'ui.trashEmpty': 'Empty Trash',
    'ui.trashRestore': 'Restore',
    'ui.trashPermanentDelete': 'Delete Forever',
    'ui.trashExpiresIn': 'Auto-deletes in {n} days',
    'ui.trashEmptyConfirm': 'Empty trash? This cannot be undone!',
    'ui.trashEmptyTitle': 'Trash (auto-cleanup after 30 days)',
    'ui.trashEmptyInfo': 'Selected items will be permanently deleted',
    'ui.trashEmptySuccess': 'Trash emptied',
    'ui.trashRestoreSuccess': 'Restored: ',
    'ui.trashRestoreFailed': 'Restore failed',
    'ui.trashDeleteSuccess': 'Permanently deleted',
    'ui.trashNoItems': 'Trash is empty',
    'ui.shortcuts': 'Shortcuts',
    'ui.shortcutHelp': '? View shortcuts',
    'ui.shortcutNewUpload': 'N Upload file',
    'ui.shortcutSearch': '/ Search',
    'ui.shortcutCopyLink': 'C Copy link',
    'ui.shortcutToggleFav': 'F Favorite filter',
    'ui.shortcutToggleSelect': 'X Toggle select',
    'ui.shortcutTagSelected': 'T Batch tag',
    'ui.shortcutOpenFocused': 'Enter Open file',
    'ui.shortcutRefresh': 'R Refresh',
    'ui.shortcutClose': 'Esc Close',
    'ui.shortcutMoveFocus': 'J/K Move focus',
    'ui.shortcutDeleteFocused': 'Del Delete focused',
    'ui.shortcutTextNote': 'M Text note',
    'ui.shortcutSelectAll': 'A Select all',
    'ui.shortcutStarFocused': 'S Star focused',
    'ui.shortcutGoRoot': 'G Go to root',
    'ui.shortcutImageNav': '← → Image nav',
    'ui.listView': 'List view',
    'ui.gridView': 'Grid view',
    'ui.resultsFound': '{n} results found',
    'ui.save': 'Save',
    'ui.saved': 'Saved',
    'ui.saveFailed': 'Save failed',
    'ui.edit': 'Edit',
    'ui.downloadDir': 'Download dir',
    'ui.remoteUpload': 'Remote Download',
    'ui.download': 'Download',
    'ui.deleteAll': 'Delete all',
    'ui.delete1Week': 'Delete 1 week ago',
    'ui.delete1Month': 'Delete 1 month ago',
    'ui.confirmDeleteAll': 'Delete all files?',
    'ui.confirmDeleteSelected': 'Delete {n} selected files?',
    'ui.confirmDeleteDays': 'Delete all files older than {n} days?',
    'ui.unknown': 'Unknown',
    'pwa.installTitle': 'Install App',
    'pwa.installDesc': 'Install for better experience',
    'admin.checking': 'Checking...',
    'admin.daysLeft': '{n} days left',
    'msg.failed': 'Failed',
    'msg.inputRequired': 'Please enter content',
    'file.textShareSuccess': 'Text shared successfully',
    'file.linkCopied': 'Link copied',
    'share.createFailed': 'Failed to create share',

    // 文件状态
    'file.files': 'Files',
    'file.view': 'View',
    'file.play': 'Play',
    'file.history': 'History',
    'file.info': 'Info',
    'file.addTag': 'Add tag',
    'file.dblclickRename': 'Double-click to rename',
    'file.enterFolder': 'Click to enter folder',
    'tag.viewFiles': 'Click to view files with this tag',
    'tag.count': '',
    'file.previewPdf': 'Preview PDF',
    'file.previewMd': 'Preview MD',
    'file.orText': 'or',
    'file.pasteHint': 'Paste images or files with Ctrl+V',

    // 设备
    'device.discovering': 'Discovering devices...',
    'device.wsConnected': 'WS Connected',
    'device.wsDisconnected': 'WS Disconnected',
    'device.syncPending': 'pending sync',
    'device.syncing': 'Syncing',
    'device.online': 'Sync online',

    // 同步
    'sync.keepRemote': 'Accept remote version',
    'sync.keepBoth': 'Keep both versions',
    'sync.later': 'Later',
    'sync.localVersion': 'Local version',
    'sync.remoteVersion': 'Remote version',
    'sync.fileConflict': 'File conflict',
    'sync.conflictDesc': 'File {name} was modified simultaneously on two devices',
    'sync.localKept': 'Local version kept',
    'sync.remoteKept': 'Remote version accepted',
    'sync.multiVersionNote': 'Requires server multi-version storage support',
    'sync.newFileReceived': '📤 New file received:',
    'sync.remoteDeleted': '🗑 File deleted remotely',
    'sync.remoteRenamed': '✏️ Renamed remotely:',
    'sync.remoteMoved': '📁 Moved remotely:',
    'sync.syncSuccess': '✅ Sync success:',
    'sync.conflictResolved': '🔄 Conflict resolved: renamed files kept both versions',
    'sync.discovered': '📡 Discovered',
    'sync.pendingChanges': ' pending changes, pulling...',

    // 分享
    'share.copyLink': 'Copy link',
    'share.qrCode': 'QR Code',
    'share.downloads': 'downloads',
    'share.linkCopied': '✓ Link copied',
    'share.linkCopyFailed': 'Copy failed',
    'share.email': '📧 Email',
    'share.emailSubject': 'Sharing with you',
    'share.emailBody': 'I shared a file with you via ShareTool',
    'share.emailVia': '—— via ShareTool',
    'share.confirmDelete': 'Delete this share link?',
    'share.deleteExpired': '🗑 Clear expired',
    'share.confirmDeleteExpired': 'Delete all expired share links?',
    'share.noExpired': 'No expired share links',
    'share.deletedExpired': 'expired links deleted',
    'share.deleted': '✓ Deleted',
    'share.deleteFailed': 'Delete failed',
    'share.daysLeft': 'Remaining',
    'share.day': 'days',
    'share.unlimited': 'Unlimited',
    'share.noPassword': 'No password',
    'share.create': 'Create link',
    'share.manage': 'Manage share links',
    'share.createNew': 'Create share link',
    'share.getLinkFailed': 'Failed to get share link',
    'share.24h': '24 hours',
    'share.3days': '3 days',
    'share.7days': '7 days (default)',
    'share.30days': '30 days',
    'share.never': 'Never',
    'share.downloadLimit': 'Download limit (optional)',
    'share.passwordOptional': 'Password protection (optional)',
    'share.passwordStrength': 'Password strength',
    'share.passwordWeak': 'Weak (8+ chars with numbers recommended)',
    'share.passwordMedium': 'Medium',
    'share.passwordStrong': 'Strong',
    'share.description': 'Description',
    'share.descriptionPlaceholder': 'Add a note (optional)',
    'share.linkCreateFailed': 'Failed to create share link',
    'share.successCreated': '✓ Share link created',
    'share.batchCreate': '🔗 Batch Create Share ({n} files)',
    'share.batchResult': '✓ Created {n} share links, {m} failed',
    'share.failed': 'Share failed:',
    'share.generateFirst': 'Please generate a share link first',

    // 管理
    'admin.auditTitle': '📊 Audit Log',
    'admin.todayOps': 'Today',
    'admin.totalOps': 'Total',
    'admin.lastOp': 'Last op',
    'admin.noLogs': 'No log records',
    'admin.viewAudit': 'View audit log',
    'admin.accessToken': 'Access Token',
    'admin.changeToken': 'Change Token',
    'admin.refresh': 'Refresh',
    'admin.https': 'HTTPS Status',
    'admin.httpsEnabled': '✅ HTTPS Enabled',
    'admin.httpsDisabled': '⚠️ HTTPS Disabled',
    'admin.httpsExpire': 'Expires:',
    'admin.httpsDays': 'days)',
    'admin.httpsLan': 'Skip for LAN',
    'admin.renew': 'Renew',
    'admin.renewing': 'Renewing...',
    'admin.renewed': 'Certificate renewed',
    'admin.renewFailed': 'Renew failed:',
    'admin.renewReqFailed': 'Renew request failed',
    'admin.unknown': 'Unknown error',
    'admin.tokenRefreshed': 'Token refreshed',
    'admin.refreshFailed': 'Refresh failed:',
    'admin.refreshFail': 'Refresh failed',
    'admin.configSaved': 'Config saved',
    'admin.saveFailed': 'Save failed:',
    'admin.saveReqFailed': 'Save request failed',
    'admin.none': '(none)',
    'admin.tokenUpdated': 'Token updated',
    'admin.updateFailed': 'Update failed:',
    'admin.updateFail': 'Update failed',
    'admin.rateLimit': 'Brute-force protection',
    'admin.rateLimitConfig': 'Configure',
    'admin.loaded': 'Loading...',
    'admin.getFailed': 'Failed to get logs',
    'admin.exported': 'Audit log exported',
    'admin.opts': 'optional',
    'admin.actionBreakdown': 'Action Breakdown',
    'ui.all': 'All',

    // 收藏
    'fav.favorite': 'Favorite',
    'fav.favorites': 'Favorites Manager',
    'fav.addFav': 'Add favorite',
    'fav.removeFav': 'Remove favorite',
    'fav.noFavorites': 'No favorites yet',
    'fav.goTo': 'Go to',
    'fav.removed': 'Removed from favorites',

    // 错误
    'err.unknown': 'Unknown error',
    'err.failed': 'Failed',
    'err.genFailed': 'Generation failed',
    'err.reqFailed': 'Request failed',
    'err.notFound': 'Not found',
    'err.browserNotSupport': 'Your browser does not support',
    'err.getLinkFailed': 'Failed to get share link',

    // 标签
    'tag.manager': 'Tag management',
    'tag.inputHint': 'Enter tags, comma separated',
    'tag.color': 'Color',
    'tag.rename': 'Rename',
    'tag.delete': 'Delete',
    'tag.merge': 'Merge',
    'tag.mergeHint': 'Select tags to merge (will be merged into target)',
    'tag.mergeTarget': 'Merge into:',
    'tag.mergeConfirm': 'Confirm merge',
    'tag.mergeSuccess': 'Merged {n} files into {target}',
    'tag.mergeFailed': 'Merge failed',
    'tag.mergeSelectFirst': 'Please select tags to merge first',
    'tag.mergeNoTarget': 'Please select a target tag first',
    'tag.inputName': 'Enter tag name (multiple separated by comma):',
    'tag.added': 'Added tag to {n} files',
    'tag.addFailed': 'Batch add failed:',
    'tag.colorChanged': 'Color updated',
    'tag.batchColorChanged': 'Batch color updated for {n} tags',
    'tag.clickChangeColor': 'Click to change color',
    'tag.doubleClickRename': 'Double-click to rename',
    'tag.viewFiles': 'Click to view files with this tag',
    'tag.count': '',
    'tag.iconChanged': 'Icon updated',
    'tag.changeIcon': 'Change icon',
    'tag.iconChangeFailed': 'Failed to update icon',
    'tag.renamePrompt': 'Rename tag "{old}" to:',
    'tag.renameSuccess': 'Renamed, updated {n} files',
    'tag.renameFailed': 'Rename failed',
    'tag.confirmDelete': 'Delete tag "{name}"? Will be removed from all files.',
    'tag.removed': 'Removed, from {n} files',
    'tag.removedLabel': 'Tag removed',
    'tag.removePrompt': 'Enter tag name to remove:',
    'tag.removedN': 'Removed tag from {n} files',
    'tag.removeFailed': 'Batch remove tag failed:',
    'tag.noneToRemove': 'No tags to remove',

    // 版本历史
    'ver.history': 'Version history',
    'ver.restore': 'Restore',
    'ver.confirmRestore': 'Restore to this version? Current content will be saved as new version.',
    'ver.restored': 'Restored to version',
    'ver.restoreFailed': 'Restore failed:',
    'ver.confirmDelete': 'Delete this version?',
    'ver.noVersions': 'No version history',
    'ver.loadFailed': 'Failed to load versions',
    'ver.backToList': '← Back to list',
    'ver.empty': '(empty)',

    // 文件操作
    'file.inputNewName': 'Enter new filename:',
    'file.inputFolderName': 'Enter new folder name:',
    'file.renamed': 'Renamed',
    'file.renameFailed': 'Rename failed:',
    'file.deleted': 'Deleted',
    'file.deleteFailed': 'Delete failed:',
    'file.inputFolderPrefix': 'Enter target virtual folder prefix (e.g. work/backup/):\n{n} files will be copied to this directory',
    'file.copied': 'Copied',
    'file.copiedCount': 'Copied {n} files, {e} failed',
    'file.copyDest': 'files to',
    'file.versionRestore': 'Restored to version',
    'file.storage': 'Storage:',
    'file.storageNone': 'Storage: --',

    // 音频/视频
    'media.browserNotSupportAudio': 'Your browser does not support audio playback',
    'media.browserNotSupportVideo': 'Your browser does not support video playback',
    'media.tableOfContents': 'Contents',

    // 搜索
    'search.noResults': 'No results found',
    'search.found': 'Found',
    'search.results': 'results',
    'search.failed': 'Search failed',
    'search.inputContent': 'Please enter content',
    'search.historyClear': '✕Clear',
    'search.manage': '⚙Manage',

    // 设备
    'device.device': 'Device:',
    'device.allFiles': '📁 All files',
    'device.fileCount': 'files',

    // PWA
    'pwa.addToHome': 'Add to home screen, access offline',
    'pwa.install': 'Install',
    'pwa.fileUpload': 'Upload file',
    'pwa.shareText': 'Share text',

    // 补充的 msg keys
    'msg.linkCopied': 'Link copied',
    'msg.createShareFailed': 'Failed to create share link',
    'msg.invalidFilename': 'Invalid filename',
    'msg.shareFailed': 'Share failed',
    'msg.deletedN': '{n} files deleted',
    'msg.copiedN': '{n} files copied',
    'msg.copyFailedN': '{n} copied, {m} failed',
    'msg.copiedTo': '{n} files copied to {dest}',
    'msg.batchStarred': '{n} files starred',
    'msg.confirmDelete': 'Confirm delete {name}?',
    'msg.confirmDeleteAll': 'Delete all files?',
    'msg.confirmDeleteDays': 'Delete files older than {n} days?',
    'msg.confirmDeleteSelected': 'Delete {n} selected files?',
    'msg.contentCopied': 'Content copied',
    'msg.copiedToClipboard': 'Link copied to clipboard',
    'msg.copyContent': 'Copy content:',
    'msg.movedTo': 'Moved {n} files to {dest}',
    'msg.moveFailedN': '{n} files failed to move',
    'file.inputMoveFolderPrefix': 'Enter target virtual folder prefix (e.g. work/docs/):\n{n} files will be moved to this directory',
    'msg.noContent': 'No content',
    'msg.getFailed': 'Failed to get',
    'msg.uploadSuccess': 'Upload successful',
    'msg.uploaded': 'Uploaded',
    'msg.uploadFailed': 'Retry failed:',
    'msg.pasted': 'Image pasted: ',
    'msg.tokenRefreshed': 'Refreshed',
    'msg.batchDownloadFailed': 'Batch download failed',
    'msg.batchDownloadSuccess': 'Batch download successful',
    'msg.batchPackUnavailable': 'Batch pack unavailable, opening one by one...',
    'msg.downloadDirSaved': 'Download dir saved (local only)',
    'msg.invalidUrl': 'Please enter a valid URL',
    'msg.downloading': 'Downloading...',
    'msg.downloadFailed': 'Download failed',

    // 补充的 file keys
    'file.checkFailed': 'Check failed',
    'file.httpsDisabled': 'HTTPS disabled',
    'file.httpsLanSkip': 'Skip on LAN',
    'file.invalidName': 'Invalid filename',
    'file.noFileSelected': 'No file selected',
    'file.retry': 'Retry',
    'msg.noFileSelected': 'Please select a file first',
    'msg.textShareFailed': 'Failed:',
    'msg.textShareSuccess': 'Text shared successfully',
    'msg.uploadFail': 'Retry failed:',
  },

  // 翻译函数
  t(key, lang = null, params = null) {
    const detectLang = lang || this.detectLang();
    let translated = this[detectLang]?.[key] ?? this[this.DEFAULT_LANG][key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        translated = translated.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
      }
    }
    return translated;
  },

  detectLang() {
    if (typeof navigator !== 'undefined' && navigator.language) {
      const lang = this.LANG_MAP[navigator.language] || this.LANG_MAP[navigator.language.split('-')[0]];
      if (lang) return lang;
    }
    return this.DEFAULT_LANG;
  }
};

// 快速翻译别名
function T(key, params) { return I18N.t(key, null, params); }

// ============================================================
// Token 配置（从环境变量或配置文件读取，无硬编码）
// ============================================================
function getShareToken() {
  // 优先从环境变量读取
  if (process.env.SHARE_TOKEN) {
    return process.env.SHARE_TOKEN;
  }
  // 从配置文件读取
  if (config.shareToken) {
    return config.shareToken;
  }
  // 首次启动：生成随机 token 并保存
  const newToken = crypto.randomBytes(32).toString('hex');
  config.shareToken = newToken;
  saveConfig();
  logger.info('[ShareTool] 首次启动，已生成新 Token:', newToken.substring(0, 8) + '***');
  return newToken;
}

let SHARE_TOKEN = ''; // 延迟初始化
const TOKEN_EXPIRES_IN = 7 * 86400; // 7天

// 本机信息
const DEVICE_ID = crypto.createHash('md5').update(os.hostname() + os.homedir()).digest('hex');
const DEVICE_NAME = os.hostname();
// File icon utilities (moved up for routeCtx availability)
function getFileIcon(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const icons = {
    // Documents
    pdf: '📕', doc: '📘', docx: '📘', rtf: '📘', odt: '📘',
    xls: '📗', xlsx: '📗', csv: '📊', ods: '📗',
    ppt: '📙', pptx: '📙', odp: '📙',
    txt: '📄', log: '📄', ini: '📄', cfg: '📄', conf: '📄',
    md: '📝', markdown: '📝', rst: '📝',
    // Config & Data
    json: '📋', jsonc: '📋', toml: '⚙️', yaml: '⚙️', yml: '⚙️',
    xml: '🌐', html: '🌐', htm: '🌐', xhtml: '🌐',
    css: '🎨', scss: '🎨', sass: '🎨', less: '🎨',
    // Code - Web & Script
    js: '💻', mjs: '💻', cjs: '💻', ts: '💻',
    jsx: '⚛️', tsx: '⚛️',
    vue: '💚', svelte: '🧡',
    py: '🐍', pyw: '🐍',
    rb: '💎', erb: '💎',
    php: '🐘',
    pl: '🐪', pm: '🐪',
    lua: '🌙',
    go: '🔵', rs: '🦀', zig: '⚡',
    java: '☕', class: '☕', jar: '☕', kotlin: '🟣',
    swift: '🍎', objectivec: 'Ⓜ️',
    cs: '🔷', fs: '🔷',
    c: '🔧', cpp: '🔧', cc: '🔧', cxx: '🔧', h: '🔧', hpp: '🔧',
    scala: '🔴', clj: '🍃', hs: '🟣', elm: '🟢', elixir: '💜', ex: '💜', exs: '💜',
    erl: '🔵', hrl: '🔵', lfe: '🔵',
    r: '📊', R: '📊',
    dart: '🎯', julia: '🔴', jl: '🔴',
    stata: '📊', sas: '📊',
    // Shell & DevOps
    sh: '🖥️', bash: '🖥️', zsh: '🖥️', fish: '🐟',
    ps1: '🟦', psm1: '🟦',
    bat: '🟩', cmd: '🟩',
    dockerfile: '🐳', dockerignore: '🐳',
    makefile: '🔨', mk: '🔨',
    terraform: '🏗️', tf: '🏗️', tfvars: '🏗️',
    // Images
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    bmp: '🖼️', tiff: '🖼️', tif: '🖼️', ico: '🖼️', heic: '🖼️', avif: '🖼️',
    // Audio
    mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵',
    m4a: '🎵', opus: '🎵', wma: '🎵', alac: '🎵',
    // Video
    mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', webm: '🎬',
    flv: '🎬', wmv: '🎬', m4v: '🎬', mpg: '🎬', mpeg: '🎬',
    // Archives
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    bz2: '📦', xz: '📦', zst: '📦', lz4: '📦',
    tgz: '📦', tbz2: '📦', txz: '📦',
    dmg: '📦', pkg: '📦', deb: '📦', rpm: '📦', apk: '📦',
    // Executables & System
    exe: '⚙️', msi: '⚙️', msc: '⚙️',
    dll: '⚙️', so: '⚙️', dylib: '⚙️', a: '⚙️', o: '⚙️',
    // Fonts
    ttf: '🔤', otf: '🔤', woff: '🔤', woff2: '🔤', eot: '🔤',
    // Database
    sql: '🗃️', db: '🗃️', sqlite: '🗃️', mdb: '🗃️', accdb: '🗃️',
    // Certificate & Key
    pem: '🔐', crt: '🔐', cer: '🔐', der: '🔐', p12: '🔐', pfx: '🔐', key: '🔐',
    env: '🔑', gitignore: '🔑', gitattributes: '🔑',
    // Book & Notes
    epub: '📚', mobi: '📚', azw: '📚', azw3: '📚',
    fb2: '📚', djvu: '📚', oxps: '📚', xps: '📚',
    // Design
    psd: '🎨', ai: '🎨', sketch: '🎨', fig: '🎨',
    xd: '🎨', indd: '🎨',
    // 3D
    obj: '📐', fbx: '📐', stl: '📐', gltf: '📐', glb: '📐', blend: '📐',
    // Binary & Disk
    bin: '💾', img: '💾', iso: '💾', vdi: '💾', vmdk: '💾',
    // Torrent
    torrent: '📡',
    // Shortcut
    lnk: '🔗', url: '🔗',
  };
  return icons[ext] || '📄';
}

function isImageFile(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return ['jpg','jpeg','png','gif','webp','svg','bmp','ico','avif'].includes(ext);
}

const LOCAL_IP = (() => {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
})();

// 全局状态
let config = {};
let AUTH_TOKEN = ''; // 延迟初始化，供 HTML_PAGE 模板使用
let wsClients = new Map(); // deviceId -> WebSocket
let syncClients = new Set(); // 所有同步客户端
let httpServer = null;
let wsServer = null;
let udpServer = null;
let broadcastTimer = null;

// ============================================================
// 速率限制（时间窗口桶）
// ============================================================
// API 精细化限流：基于端点评级 + 时间窗口桶（内存 Map，进程重启即重置）
// 评分：heavy(重) < write(写) < read(读)
// 免认证请求（anonymous）使用更严格的限制
const rateLimitMap = new Map(); // ip -> Map<endpoint -> {timestamps[]}>

// 端点评级配置：heaviest < write < read
const RATE_TIERS = {
  '/api/upload':              { tier: 'heavy',  anon: 5,  auth: 20 },  // 重操作
  '/api/search':              { tier: 'heavy',  anon: 5,  auth: 20 },  // 重操作
  '/api/file/reorder':       { tier: 'write',  anon: 10, auth: 40 },  // 排序操作
  '/api/share/create':        { tier: 'write',  anon: 10, auth: 40 },  // 写操作
  '/api/share/access':        { tier: 'share',  anon: 5,  auth: 40 },  // 特殊：防暴力
  '/api/files':               { tier: 'read',   anon: 30, auth: 120 },  // 读操作
  '/api/folder-sizes':       { tier: 'read',   anon: 30, auth: 120 }   // 读操作
};
const RATE_WINDOW_MS = 60 * 1000; // 60秒窗口

function getRateLimit(ip, endpoint, isAuth) {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;

  // 查端点配置
  let cfg = RATE_TIERS[endpoint];
  if (!cfg) cfg = { tier: 'read', anon: 30, auth: 120 }; // 默认读操作限制
  const max = isAuth ? cfg.auth : cfg.anon;

  // 确保数据结构
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, new Map());
  const endpointMap = rateLimitMap.get(ip);
  if (!endpointMap.has(endpoint)) endpointMap.set(endpoint, []);

  const timestamps = endpointMap.get(endpoint);
  // 清理过期记录
  while (timestamps.length > 0 && timestamps[0] < windowStart) timestamps.shift();

  const remaining = Math.max(0, max - timestamps.length);
  if (timestamps.length >= max) {
    return { allowed: false, retryAfter: 60, remaining: 0, total: max, tier: cfg.tier };
  }

  timestamps.push(now);
  return { allowed: true, remaining: remaining - 1, total: max, tier: cfg.tier };
}

function checkGlobalRateLimit(ip) {
  // 兼容旧调用（authRequired 内部使用）
  return getRateLimit(ip, 'ALL', false);
}

// ============================================================
// 上传大小限制
// ============================================================
function getUploadMaxSize() {
  // 优先从环境变量读取
  if (process.env.UPLOAD_MAX_SIZE_MB) {
    return parseInt(process.env.UPLOAD_MAX_SIZE_MB) * 1024 * 1024;
  }
  // 从配置文件读取
  const maxMB = config.uploadMaxSizeMB || 100;
  return maxMB * 1024 * 1024;
}

// ============================================================
// WebDAV 服务器
// ============================================================
const WEBDAV_PREFIX = '/webdav';
const DAV_NS = 'DAV:';

function isWebDAVRequest(pathname) {
  return pathname.startsWith(WEBDAV_PREFIX + '/') || pathname === WEBDAV_PREFIX;
}

function parseWebDAVDepth(header) {
  if (header === 'infinity') return 'infinity';
  if (header === '0') return 0;
  if (header === '1') return 1;
  return 1; // 默认 depth=1
}

function webdavPropfind(files, prefix = '') {
  const responses = files.map(f => {
    const href = prefix + '/' + encodeURIPath(f.filename);
    return `<?xml version="1.0" encoding="UTF-8"?>
<d:response xmlns:d="DAV:">
  <d:href>${href}</d:href>
  <d:propstat>
    <d:prop>
      <d:displayname>${escapeXml(f.filename)}</d:displayname>
      <d:getcontentlength>${f.size}</d:getcontentlength>
      <d:getcontenttype>${f.type === 'text' ? 'text/plain' : 'application/octet-stream'}</d:getcontenttype>
      <d:resourcetype>${f.type === 'folder' ? '<d:collection/>' : '<d:file/>'}</d:resourcetype>
      <d:creationdate>${new Date(f.created_at * 1000).toISOString()}</d:creationdate>
      <d:getlastmodified>${new Date(f.updated_at * 1000).toGMTString()}</d:getlastmodified>
      <d:getetag>"${f.hash || ''}"</d:getetag>
      <d:supportedlock/>
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`;
  }).join('\n');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
${responses}
</d:multistatus>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function encodeURIPath(path) {
  return path.split('/').map(p => encodeURIComponent(p)).join('/');
}

function handleWebDAV(req, res, pathname, query) {
  const path = pathname.slice(WEBDAV_PREFIX.length);
  const depth = parseWebDAVDepth(req.headers.depth || '1');
  
  // OPTIONS - Return DAV support
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'DAV': '1, 2',
      'Allow': 'OPTIONS, GET, PUT, DELETE, MKCOL, MOVE, COPY, PROPFIND, PROPPATCH',
      'Content-Length': 0
    });
    res.end();
    return true;
  }
  
  // PROPFIND - List directory contents
  if (req.method === 'PROPFIND') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const allFiles = db.listFiles(1000, 0).files;
      // 根目录
      const rootResponse = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response xmlns:d="DAV:">
    <d:href>${WEBDAV_PREFIX}/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>ShareTool</d:displayname>
        <d:resourcetype><d:collection/></d:resourcetype>
        <d:creationdate>${new Date().toISOString()}</d:creationdate>
        <d:getlastmodified>${new Date().toGMTString()}</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
${allFiles.map(f => `  <d:response xmlns:d="DAV:">
    <d:href>${WEBDAV_PREFIX}/${encodeURIPath(f.filename)}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${escapeXml(f.filename)}</d:displayname>
        <d:getcontentlength>${f.size}</d:getcontentlength>
        <d:getcontenttype>${f.type === 'text' ? 'text/plain' : 'application/octet-stream'}</d:getcontenttype>
        <d:resourcetype>${f.type === 'folder' ? '<d:collection/>' : '<d:file/>'}</d:resourcetype>
        <d:creationdate>${new Date(f.created_at * 1000).toISOString()}</d:creationdate>
        <d:getlastmodified>${new Date(f.updated_at * 1000).toGMTString()}</d:getlastmodified>
        <d:getetag>"${f.hash || ''}"</d:getetag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`).join('\n')}
</d:multistatus>`;
      
      res.writeHead(207, {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(rootResponse)
      });
      res.end(rootResponse);
    });
    return true;
  }
  
  // GET - Download file
  if (req.method === 'GET') {
    const filename = decodeURIComponent(path.slice(1));
    const file = db.getFileByName(filename);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return true;
    }
    if (file.encrypted) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Encrypted files not accessible via WebDAV');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': file.type === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'Content-Length': file.size,
      'ETag': `"${file.hash || ''}"`
    });
    res.end(file.content || '');
    db.addAuditLog('webdav_get', `filename=${filename}`, getClientIp(req));
    return true;
  }
  
  // PUT - Upload/update file
  if (req.method === 'PUT') {
    const filename = decodeURIComponent(path.slice(1));
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const existing = db.getFileByName(filename);
        const type = isTextContent(req.headers['content-type']) ? 'text' : 'file';
        const hash = crypto.createHash('md5').update(body).digest('hex');
        const result = db.addFile(filename, body, type, hash, false);
        db.addAuditLog('webdav_put', `filename=${filename}`, getClientIp(req));
        res.writeHead(existing ? 204 : 201, { 'Location': WEBDAV_PREFIX + '/' + encodeURIPath(filename) });
        res.end();
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(e.message);
      }
    });
    return true;
  }
  
  // DELETE - Delete file
  if (req.method === 'DELETE') {
    const filename = decodeURIComponent(path.slice(1));
    if (db.deleteFileByName(filename)) {
      db.addAuditLog('webdav_delete', `filename=${filename}`, getClientIp(req));
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
    return true;
  }
  
  // MKCOL - Create folder (not supported for flat storage)
  if (req.method === 'MKCOL') {
    res.writeHead(405, { 'Allow': 'DELETE, GET, HEAD, OPTIONS, POST, PROPFIND, PUT' });
    res.end('Method Not Allowed - ShareTool uses flat storage');
    return true;
  }
  
  // MOVE - Move/rename a resource
  if (req.method === 'MOVE') {
    const destHeader = req.headers['destination'];
    if (!destHeader) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Destination header required');
      return true;
    }
    try {
      const destUrl = new URL(destHeader);
      const destPath = decodeURIComponent(destUrl.pathname);
      const destFile = destPath.replace(WEBDAV_PREFIX, '').replace(/^\//, '');
      const srcFile = decodeURIComponent(path.slice(1));
      if (!srcFile || !destFile) {
        res.writeHead(400); res.end('Invalid path'); return true;
      }
      if (srcFile === destFile) { res.writeHead(204); res.end(); return true; }
      const file = db.getFileByName(srcFile);
      if (!file) { res.writeHead(404); res.end(); return true; }
      // Check destination doesn't exist
      if (db.getFileByName(destFile)) {
        res.writeHead(412); res.end('Destination already exists'); return true;
      }
      // Move: delete old, add with new name
      db.addFile(destFile, file.content, file.type, file.size, null, { content_type: file.content_type || 'application/octet-stream' });
      db.deleteFileByName(srcFile);
      db.addAuditLog('webdav_move', `src=${srcFile}, dest=${destFile}`, getClientIp(req));
      res.writeHead(201, { 'Location': WEBDAV_PREFIX + '/' + encodeURIPath(destFile) });
      res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(e.message);
    }
    return true;
  }

  // COPY - Copy a resource
  if (req.method === 'COPY') {
    const destHeader = req.headers['destination'];
    if (!destHeader) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Destination header required');
      return true;
    }
    try {
      const destUrl = new URL(destHeader);
      const destPath = decodeURIComponent(destUrl.pathname);
      const destFile = destPath.replace(WEBDAV_PREFIX, '').replace(/^\//, '');
      const srcFile = decodeURIComponent(path.slice(1));
      if (!srcFile || !destFile) {
        res.writeHead(400); res.end('Invalid path'); return true;
      }
      const file = db.getFileByName(srcFile);
      if (!file) { res.writeHead(404); res.end(); return true; }
      if (db.getFileByName(destFile)) {
        res.writeHead(412); res.end('Destination already exists'); return true;
      }
      db.addFile(destFile, file.content, file.type, file.size, null, { content_type: file.content_type || 'application/octet-stream' });
      db.addAuditLog('webdav_copy', `src=${srcFile}, dest=${destFile}`, getClientIp(req));
      res.writeHead(201, { 'Location': WEBDAV_PREFIX + '/' + encodeURIPath(destFile) });
      res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(e.message);
    }
    return true;
  }
  
  return false; // Not a WebDAV handler
}

function isTextContent(contentType) {
  if (!contentType) return false;
  const textTypes = ['text/', 'application/json', 'application/javascript', 'application/xml'];
  return textTypes.some(t => contentType.includes(t));
}

// ============================================================
// 工具函数
// ============================================================
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // 确保 downloadDir 是绝对路径
      let downloadDir = loaded.downloadDir || path.join(os.homedir(), 'Downloads', 'ShareTool');
      if (!path.isAbsolute(downloadDir)) {
        downloadDir = path.join(os.homedir(), downloadDir);
      }
      // 默认上传大小限制
      const uploadMaxSizeMB = loaded.uploadMaxSizeMB || 100;
      config = { ...{ downloadDir: path.join(os.homedir(), 'Downloads', 'ShareTool'), lastSync: null, deviceId: DEVICE_ID, uploadMaxSizeMB }, downloadDir, ...loaded };
    } else {
      config = { downloadDir: path.join(os.homedir(), 'Downloads', 'ShareTool'), lastSync: null, deviceId: DEVICE_ID, uploadMaxSizeMB: 100 };
    }
  } catch (e) {
    config = { downloadDir: path.join(os.homedir(), 'Downloads', 'ShareTool'), lastSync: null, deviceId: DEVICE_ID, uploadMaxSizeMB: 100 };
  }
  if (!config.deviceId) config.deviceId = DEVICE_ID;
  if (!config.uploadMaxSizeMB) config.uploadMaxSizeMB = 100;
  if (!config.trustedOrigins) config.trustedOrigins = [];  // CORS 信任来源，默认空（仅本地）
  
  // 从环境变量或配置文件读取 token
  SHARE_TOKEN = process.env.SHARE_TOKEN || config.shareToken;
  if (!SHARE_TOKEN) {
    // 首次启动，生成新 token
    SHARE_TOKEN = crypto.randomBytes(32).toString('hex');
    config.shareToken = SHARE_TOKEN;
    saveConfig();
    logger.info('[ShareTool] 首次启动，已生成 Token 并保存到 ' + CONFIG_FILE);
  }
}

function saveConfig() {
  try {
    const cfgDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
    // 确保保存时 downloadDir 是绝对路径
    const saveConfig = { ...config };
    if (saveConfig.downloadDir && !path.isAbsolute(saveConfig.downloadDir)) {
      saveConfig.downloadDir = path.join(os.homedir(), saveConfig.downloadDir);
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(saveConfig, null, 2));
  } catch (e) {
    logger.error({ err: e }, 'Config save failed');
  }
}

function setCors(res, req) {
  const origin = req?.headers['origin'];
  const trusted = config.trustedOrigins || [];
  
  // 如果有 origin 且在信任列表中，使用具体 origin；否则不设置（或降级）
  if (origin && (trusted.includes('*') || trusted.includes(origin) || isLocalhost(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // 无 origin（CLI 请求）不设置 CORS，避免浏览器干扰
  } else {
    // 有 origin 但不在信任列表，降级为不设置，防止泄露敏感信息
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token, x-refresh-token, Authorization, x-requested-with');
  res.setHeader('Access-Control-Expose-Headers', 'x-requested-with');
  // HSTS header for HTTPS connections
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function isLocalhost(origin) {
  return /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
         /^https?:\/\/127\.(\d+)\.(\d+)\.(\d+)(:\d+)?$/.test(origin) ||
         /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(origin) ||  // 局域网 IP
         /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/.test(origin);    // 局域网 IP
}

function sendJson(res, data, status = 200) {
  const json = JSON.stringify(data);
  // gzip: only if client accepts it and payload > 512B
  const acceptGzip = res.req && res.req.headers && res.req.headers['accept-encoding'] || '';
  const shouldCompress = acceptGzip.includes('gzip') && json.length > 512;

  if (shouldCompress) {
    zlib.gzip(Buffer.from(json), (err, buf) => {
      if (!err) {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Vary': 'Accept-Encoding'
        });
        res.end(buf);
      } else {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(json);
      }
    });
  } else {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json);
  }
}

function auth(req) {
  const token = req.headers['x-auth-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return null;
  
  // 验证动态 Token
  const dynamicToken = db.validateToken(token);
  if (dynamicToken) return dynamicToken;
  
  // 验证配置的共享 Token
  if (!SHARE_TOKEN) SHARE_TOKEN = getShareToken();
  if (token === SHARE_TOKEN) return { token: SHARE_TOKEN, isStatic: true };
  return null;
}

function authRequired(req, res) {
  const clientIp = getClientIp(req);
  
  // 检查速率限制
  const rate = checkGlobalRateLimit(clientIp);
  if (!rate.allowed) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(rate.retryAfter || 60),
      'X-RateLimit-Limit': String(rate.total),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000) + (rate.retryAfter || 60))
    });
    res.end(JSON.stringify({ success: false, error: 'Too Many Requests', retryAfter: rate.retryAfter || 60 }));
    return null;
  }
  // 设置 RateLimit headers（即使未超限也返回）
  res.setHeader('X-RateLimit-Limit', String(rate.total));
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(Date.now() / 1000) + 60));
  
  const authData = auth(req);
  if (!authData) {
    db.addAuditLog('auth_failed', `IP: ${clientIp}`, clientIp);
    sendJson(res, { success: false, error: 'Unauthorized' }, 401);
    return null;
  }
  return authData;
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
}

function escapeHtml(str) {
  const div = { textContent: '' };
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// 初始化
// ============================================================
async function init() {
  // 确保目录存在
  if (!fs.existsSync(SHARE_DIR)) {
    fs.mkdirSync(SHARE_DIR, { recursive: true });
  }
  
  // 加载配置
  loadConfig();
  
  // 初始化数据库
  db.initDatabase();
  
  // 注册本机设备
  db.registerDevice(DEVICE_ID, DEVICE_NAME, LOCAL_IP, PORT);
  
  // 确保下载目录存在
  if (!fs.existsSync(config.downloadDir)) {
    fs.mkdirSync(config.downloadDir, { recursive: true });
  }
  
  // 启动 HTTP 服务器
  await startHttpServer();
  
  // 启动 WebSocket 服务器
  startWsServer();
  
  // 启动 UDP 设备发现
  startDiscovery();
  
  // 启动设备心跳
  startHeartbeat();
  
  // 定时同步检查
  startSyncScheduler();
  
  logger.info(`[ShareTool] Device ID: ${DEVICE_ID}`);
  logger.info(`[ShareTool] HTTP: http://${LOCAL_IP}:${PORT}`);
  logger.info(`[ShareTool] WebSocket: ws://${LOCAL_IP}:${WS_PORT}`);
  logger.info(`[ShareTool] Discovery: udp://${LOCAL_IP}:${DISCOVERY_PORT}`);
}

// ============================================================
// HTTPS 证书管理
// ============================================================
const selfsigned = require('selfsigned');
const QRCode = require('qrcode');

function getCertExpiryInfo(certPath) {
  if (!fs.existsSync(certPath)) return null;
  try {
    // 尝试用 openssl 解析证书日期
    const { execSync } = require('child_process');
    try {
      const out = execSync(`openssl x509 -in "${certPath}" -noout -dates`, { encoding: 'utf8' });
      const notAfterMatch = out.match(/notAfter=(.*)/i);
      if (notAfterMatch && notAfterMatch[1]) {
        const expiresAt = new Date(notAfterMatch[1].trim()).getTime() / 1000;
        const now = Math.floor(Date.now() / 1000);
        const daysRemaining = Math.floor((expiresAt - now) / 86400);
        return { valid: expiresAt > now, daysRemaining, expiresAt, note: null };
      }
    } catch (e) {
      // openssl 不可用，使用 mtime fallback
    }
    // Fallback: 使用文件修改时间估算
    const stats = fs.statSync(certPath);
    const age = (Date.now() - stats.mtimeMs) / 1000 / 86400;
    return { valid: age < 365, daysRemaining: Math.floor(365 - age), expiresAt: null, note: 'Using file age (openssl unavailable)' };
  } catch (e) {
    return { valid: false, daysRemaining: 0, expiresAt: null, note: e.message };
  }
}

async function ensureSslCertificates() {
  const certPath = path.join(SSL_DIR, 'cert.pem');
  const keyPath = path.join(SSL_DIR, 'key.pem');

  // 检查证书有效期
  const info = getCertExpiryInfo(certPath);
  if (info && info.valid && info.daysRemaining !== null && info.daysRemaining > 7) {
    logger.info(`[HTTPS] Using existing certificate (expires in ${info.daysRemaining} days)`);
    return true;
  }

  // 证书不存在、已过期或即将过期（<=7天）
  if (info && !info.valid) {
    logger.info(`[HTTPS] Certificate expired, regenerating...`);
  } else if (info && info.daysRemaining !== null) {
    logger.info(`[HTTPS] Certificate expires in ${info.daysRemaining} days, regenerating...`);
  } else {
    logger.info(`[HTTPS] No certificate found, generating...`);
  }

  try {
    if (!fs.existsSync(SSL_DIR)) {
      fs.mkdirSync(SSL_DIR, { recursive: true });
    }

    const { key, cert } = await generateSelfSignedCert();

    fs.writeFileSync(keyPath, key);
    fs.writeFileSync(certPath, cert);

    logger.info('[HTTPS] Self-signed certificate generated');
    logger.info(`[HTTPS] Certificate: ${certPath}`);
    logger.info('[HTTPS] NOTE: Add cert to system trust store for full HTTPS support');
    return true;
  } catch (e) {
    logger.error({ err: e }, 'HTTPS cert generation failed');
    return false;
  }
}

async function generateSelfSignedCert() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  
  const altNames = [
    { type: 2, value: 'localhost' },  // DNS
    { type: 7, value: '127.0.0.1' }    // IP
  ];
  for (const ip of ips) {
    if (ip !== '127.0.0.1') {
      altNames.push({ type: 7, value: ip });
    }
  }
  
  const attrs = [{ name: 'commonName', value: 'ShareTool' }];
  // selfsigned v5 uses notBeforeDate/notAfterDate (days ignored)
  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 1); // 1 year validity
  const pems = await selfsigned.generate(attrs, {
    algorithm: 'sha256',
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }]
  });
  
  logger.info(`[HTTPS] SANs: localhost, 127.0.0.1, ${ips.filter(ip => ip !== '127.0.0.1').join(', ')}`);

  return { key: pems.private, cert: pems.cert };
}

// 自动续期阈值（60天，给足够缓冲时间）
const RENEW_BEFORE_DAYS = 60;

async function renewCertificateIfNeeded(force = false) {
  const certPath = path.join(SSL_DIR, 'cert.pem');
  const keyPath = path.join(SSL_DIR, 'key.pem');

  const info = getCertInfo();
  if (!info) {
    logger.warn('[HTTPS] No certificate found, cannot renew');
    return false;
  }

  if (!force && !info.isExpired && info.daysRemaining > RENEW_BEFORE_DAYS) {
    logger.info(`[HTTPS] Certificate valid for ${info.daysRemaining} days, no renewal needed`);
    return false;
  }

  logger.info(`[HTTPS] Certificate expires in ${info.daysRemaining} days (${info.validTo}), renewing...`);

  try {
    const pems = await generateSelfSignedCert();

    // 先写临时文件，再原子替换
    const tmpCertPath = certPath + '.new';
    const tmpKeyPath = keyPath + '.new';
    fs.writeFileSync(tmpCertPath, pems.cert, { mode: 0o644 });
    fs.writeFileSync(tmpKeyPath, pems.key, { mode: 0o600 });
    fs.renameSync(tmpCertPath, certPath);
    fs.renameSync(tmpKeyPath, keyPath);

    logger.info('[HTTPS] Certificate renewed successfully');

    // 尝试热重载（如果不支持则下次启动生效）
    if (global.httpServer && global.httpServer.setSecureContext) {
      try {
        global.httpServer.setSecureContext({
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath)
        });
        logger.info('[HTTPS] Hot-reloaded new certificate');
      } catch (e) {
        logger.warn({ err: e }, '[HTTPS] Hot-reload failed, will take effect on restart');
      }
    }

    return true;
  } catch (e) {
    logger.error({ err: e }, '[HTTPS] Certificate renewal failed');
    return false;
  }
}

async function checkAndRenewCertificate(force = false) {
  try {
    return await renewCertificateIfNeeded(force);
  } catch (e) {
    logger.error({ err: e }, '[HTTPS] Certificate check/renew error');
    return false;
  }
}

function getCertInfo() {
  const certPath = path.join(SSL_DIR, 'cert.pem');
  if (!fs.existsSync(certPath)) return null;
  
  try {
    const certPem = fs.readFileSync(certPath, 'utf8');
    const cert = new crypto.X509Certificate(certPem);
    return {
      issuer: cert.issuer.CN || cert.issuer.O || 'ShareTool',
      subject: cert.subject.CN || cert.subject.O || 'ShareTool',
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      fingerprint: cert.fingerprint256.replace(/:/g, '').toLowerCase().substring(0, 16) + '...',
      isExpired: new Date(cert.validTo) < new Date(),
      daysRemaining: Math.ceil((new Date(cert.validTo) - new Date()) / 86400000)
    };
  } catch (e) {
    return null;
  }
}

// ============================================================
// 分享码管理
// ============================================================
const SHARE_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // 排除易混淆字符
const SHARE_CODE_LENGTH = 6;
const SHARE_CODE_EXPIRY_DEFAULT = 7 * 24 * 60 * 60 * 1000; // 7天

function generateShareCode() {
  let code = '';
  const bytes = crypto.randomBytes(SHARE_CODE_LENGTH);
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
    code += SHARE_CODE_CHARS[bytes[i] % SHARE_CODE_CHARS.length];
  }
  return code;
}

function createShareLink(filename, options = {}) {
  const code = generateShareCode();
  const expiresHours = options.expiryHours;
  // expiryHours = 0 表示永不过期（用 MAX_INT 代替 NULL 避免 SQLite schema 迁移）
  const expiresAt = (!expiresHours && expiresHours !== 0)
    ? Date.now() + 168 * 60 * 60 * 1000  // 默认7天
    : (expiresHours === 0 ? MAX_TS : Date.now() + expiresHours * 60 * 60 * 1000);
  const shareData = {
    code,
    filename,
    createdAt: Date.now(),
    expiresAt,
    password: options.password || null,
    maxDownloads: options.maxDownloads || null,
    downloadCount: 0,
    isText: options.isText || false,
    description: options.description || ''
  };

  db.saveShareLink(shareData);
  return shareData;
}

function validateShareCode(code) {
  const shareData = db.getShareLink(code);
  if (!shareData) return null;
  
  // 检查过期（MAX_TS = 永不过期）
  if (shareData.expiresAt && shareData.expiresAt !== MAX_TS && Date.now() > shareData.expiresAt) {
    db.deleteShareLink(code);
    return null;
  }
  
  // 检查下载次数
  if (shareData.maxDownloads && shareData.downloadCount >= shareData.maxDownloads) {
    db.deleteShareLink(code);
    return null;
  }
  
  return shareData;
}

// ============================================================
// HTTP/HTTPS 服务器
// ============================================================
async function startHttpServer() {
  const serverOptions = {
    key: null,
    cert: null,
    https: false
  };

  // 自动生成或加载 SSL 证书
  const certPath = path.join(SSL_DIR, 'cert.pem');
  const keyPath = path.join(SSL_DIR, 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      serverOptions.key = fs.readFileSync(keyPath);
      serverOptions.cert = fs.readFileSync(certPath);
      serverOptions.https = true;
      const info = getCertInfo();
      if (info) {
        logger.info(`[HTTPS] Certificate valid for ${info.daysRemaining} days (expires: ${info.validTo})`);
      }
    } catch (e) {
      logger.error({ err: e }, 'HTTPS cert load failed');
    }
  } else {
    // 自动生成自签名证书
    const generated = await ensureSslCertificates();
    if (generated) {
      serverOptions.key = fs.readFileSync(keyPath);
      serverOptions.cert = fs.readFileSync(certPath);
      serverOptions.https = true;
    }
  }

  const requestHandler = async (req, res) => {
    setCors(res, req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 速率限制检查（跳过静态资源和健康检查）
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    // Skip rate limit for healthcheck, static assets
    if (!['/api/health', '/index', '/favicon'].some(p => pathname.startsWith(p))) {
      const clientIp = getClientIp(req);
      const isAuth = !!(req.headers['x-auth-token'] || parsedUrl.searchParams.get('auth'));
      const rate = getRateLimit(clientIp, pathname, isAuth);
      if (!rate.allowed) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(rate.retryAfter || 60),
          'X-RateLimit-Limit': String(rate.total),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000) + (rate.retryAfter || 60))
        });
        res.end(JSON.stringify({ success: false, error: T('rateLimit.exceeded'), retryAfter: rate.retryAfter || 60 }));
        return;
      }
      res.setHeader('X-RateLimit-Limit', String(rate.total));
      res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(Date.now() / 1000) + 60));
    }

    const query = parsedUrl.searchParams;

    // WebDAV 处理（优先于其他路由）
    if (pathname.startsWith(WEBDAV_PREFIX) || pathname === WEBDAV_PREFIX) {
      const handled = handleWebDAV(req, res, pathname, query);
      if (handled) return;
    }

    // 记录审计日志
    const auditAction = `${req.method} ${pathname}`;

    try {
      // 路由处理
      if (pathname === '/' || pathname === '/index.html') {
        sendHtml(res);
        return;
      }

      // PWA Manifest
      if (pathname === '/manifest.json') {
        const manifest = {
          id: 'sharetool',
          name: 'ShareTool - 局域网文件分享',
          short_name: 'ShareTool',
          description: '局域网文件/文字分享服务，支持多设备同步',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'any',
          background_color: '#0f172a',
          theme_color: '#667eea',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
          ],
          categories: ['productivity', 'utilities'],
          lang: 'zh-CN'
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
        res.end(JSON.stringify(manifest, null, 2));
        return;
      }

      // PWA manifest.json
      if (pathname === '/manifest.json') {
        const manifestPath = path.join(__dirname, 'public', 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
          res.end(fs.readFileSync(manifestPath));
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
        return;
      }

      // PWA Service Worker
      if (pathname === '/sw.js') {
        const sw = `// ShareTool Service Worker v2.0
const CACHE_NAME = 'sharetool-v2';
const STATIC_ASSETS = ['/', '/index.html', '/icon-192.png', '/icon-512.png', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith('sharetool-') && k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.origin !== location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    const isWrite = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method);
    if (isWrite) {
      event.respondWith(
        fetch(request).catch(() => new Response(JSON.stringify({success:false, error:'offline'}), {
          headers: {'Content-Type': 'application/json'}
        }))
      );
      return;
    }
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
          const networkFetch = fetch(request).then(response => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          }).catch(() => cached || new Response(JSON.stringify({success:false, error:'offline'}), {
            headers: {'Content-Type': 'application/json'}
          }));
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(request).then(cached => {
        const networkFetch = fetch(request).then(response => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    )
  );
});
`;
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
        res.end(sw);
        return;
      }

      // PWA Icons
      const iconMatch = pathname.match(/^\/(icon-(\d+)\.png)$/);
      if (iconMatch) {
        const iconPath = path.join(__dirname, iconMatch[1]);
        if (fs.existsSync(iconPath)) {
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=2592000' });
          fs.createReadStream(iconPath).pipe(res);
          return;
        }
      }

      // Docker healthcheck endpoint - no auth required
      if (pathname === '/api/health' && req.method === 'GET') {
        const uptime = Math.floor(process.uptime());
        const memUsage = process.memoryUsage();
        sendJson(res, {
          status: 'ok',
          uptime,
          memory: {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024)
          },
          version: 'v3.48',
        });
        return;
      }

      // Route context - shared dependencies for route handlers
      const routeCtx = {
        db, config, sendJson, sendHtml, authRequired, getClientIp, broadcastChange,
        getUploadMaxSize, getFileIcon, isImageFile, archiver, crypto, cryptoModule,
        SHARE_TOKEN, TOKEN_EXPIRES_IN, DEVICE_ID, LOCAL_IP, PORT,
        saveConfig, ensureSslCertificates, getCertInfo, checkAndRenewCertificate, QRCode,
        fs, path, createShareLink, validateShareCode, escapeHtml,
        execSync: require('child_process').execSync
      };

      // API routes (non-share)
      if (pathname.startsWith('/api/')) {
        const apiRoutes = require('./routes/api');
        if (apiRoutes(req, res, pathname, query, routeCtx)) return;
      }

      // File routes
      const fileRoutes = require('./routes/files');
      if (fileRoutes(req, res, pathname, query, routeCtx)) return;

      // Share routes
      const shareRoutes = require('./routes/share');
      if (shareRoutes(req, res, pathname, query, routeCtx)) return;

      // 未知路由
      sendJson(res, { success: false, error: 'Not found' }, 404);

    } catch (e) {
      // Log full error, return safe message to client
      const safeError = process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : e.message;
      logger.error({ err: e, pathname, method: req.method }, 'HTTP error');
      sendJson(res, { success: false, error: safeError }, 500);
    }
  };

  if (serverOptions.https) {
    httpServer = https.createServer(serverOptions, requestHandler);
    httpServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        logger.error(`[HTTPS] Port ${HTTPS_PORT} already in use - another instance may be running`);
      } else {
        logger.error({ err: e }, '[HTTPS] Server error');
      }
    });
    httpServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      logger.info(`[HTTPS] Server listening on https://${LOCAL_IP}:${HTTPS_PORT}`);
    });

    // 启动时检查证书是否需要续期
    checkAndRenewCertificate().catch(() => {});

    // 每日定时检查证书
    setInterval(() => {
      checkAndRenewCertificate().catch(() => {});
    }, 24 * 60 * 60 * 1000);

    // 同时在 HTTP 端口运行 HTTP（重定向到 HTTPS）
    const redirectHandler = (req, res) => {
      const host = req.headers.host || `localhost:${PORT}`;
      const destination = `https://${host}${req.url}`;
      // 排除 WebSocket 升级请求
      if (req.headers.upgrade === 'websocket') {
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('WebSocket over HTTP not supported, use HTTPS');
        return;
      }
      res.writeHead(301, {
        'Location': destination,
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'Cache-Control': 'no-cache'
      });
      res.end(`Redirecting to ${destination}`);
    };
    const plainServer = http.createServer(redirectHandler);
    plainServer.listen(PORT, '0.0.0.0', () => {
      logger.info(`[HTTP->HTTPS] Redirect server listening on http://${LOCAL_IP}:${PORT} -> https://${LOCAL_IP}:${HTTPS_PORT}`);
    });
  } else {
    httpServer = http.createServer(requestHandler);
    httpServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        logger.error(`[HTTP] Port ${PORT} already in use - another instance may be running`);
      } else {
        logger.error({ err: e }, '[HTTP] Server error');
      }
    });
    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info(`[HTTP] Server listening on http://${LOCAL_IP}:${PORT}`);
      logger.info('[HTTPS] SSL certificates not found, HTTPS disabled');
      logger.info('[HTTPS] Run with SSL_DIR set to enable HTTPS');
    });
  }
}

// ============================================================
// WebSocket 服务器
// ============================================================
function startWsServer() {
  wsServer = new WebSocketServer({ port: WS_PORT });
  
  wsServer.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    logger.info(`[WS] New connection from ${clientIp}`);
    
    ws.isAlive = true;
    ws.deviceId = null;
    
    ws.on('pong', () => { ws.isAlive = true; });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleWsMessage(ws, msg);
      } catch (e) {
        logger.error({ err: e }, 'WS invalid message');
      }
    });
    
    ws.on('close', () => {
      if (ws.deviceId) {
        wsClients.delete(ws.deviceId);
        syncClients.delete(ws);
        db.setDeviceOffline(ws.deviceId);
        broadcastDeviceList();
        logger.info(`[WS] Device ${ws.deviceId} disconnected`);
      }
    });
    
    ws.on('error', (e) => {
      logger.error({ err: e }, 'WS error');
    });
  });

  // 心跳检测
  const heartbeat = setInterval(() => {
    wsServer.clients.forEach((ws) => {
      if (!ws.isAlive) {
        if (ws.deviceId) {
          wsClients.delete(ws.deviceId);
          db.setDeviceOffline(ws.deviceId);
        }
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wsServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      logger.error(`[WS] Port ${WS_PORT} already in use`);
    } else {
      logger.error({ err: e }, '[WS] Server error');
    }
  });

  wsServer.on('close', () => clearInterval(heartbeat));
  
  logger.info(`[WS] WebSocket server on ws://${LOCAL_IP}:${WS_PORT}`);
}

function handleWsMessage(ws, msg) {
  const { type, payload } = msg;
  
  switch (type) {
    case 'register': {
      // 设备注册
      const { deviceId, deviceName, lastSyncTs = 0 } = payload;
      ws.deviceId = deviceId;
      wsClients.set(deviceId, ws);
      syncClients.add(ws);
      db.registerDevice(deviceId, deviceName || deviceId, LOCAL_IP, PORT);
      db.setDeviceOnline(deviceId);

      // 增量同步：只返回 lastSyncTs 之后的变更
      const changes = db.getUnsyncedLogs(lastSyncTs);
      const { files } = db.listFiles(100, 0);

      const syncStatus = db.getSyncStatus();
      ws.send(JSON.stringify({
        type: 'registered',
        payload: {
          deviceId: DEVICE_ID,
          deviceName: DEVICE_NAME,
          files: files.map(f => ({ id: f.id, name: f.filename, size: f.size, time: f.created_at * 1000, type: f.type, hash: f.hash, tags: f.tags })),
          devices: db.listDevices().map(d => ({ deviceId: d.device_id, deviceName: d.device_name, ip: d.ip, isOnline: d.is_online === 1 })),
          syncStatus,  // 当前未同步状态
          // 增量同步数据
          sync: {
            changes,
            serverTs: Math.floor(Date.now() / 1000),  // 本次同步时间戳，客户端下次请求时传回
            totalChanges: changes.length
          }
        }
      }));

      broadcastDeviceList();
      logger.info(`[WS] Device registered: ${deviceId} (${deviceName}), incremental sync: ${changes.length} changes since ${lastSyncTs}`);
      break;
    }

    case 'auth': {
      // 分享链接 Token 认证（用于访问受保护的分享链接）
      const { token } = payload;
      if (token && token === SHARE_TOKEN) {
        ws.isShareAuth = true;
        ws.send(JSON.stringify({ type: 'auth_ok', payload: { message: 'authenticated' } }));
        logger.info(`[WS] Share token auth OK from ${ws._socket?.remoteAddress || 'unknown'}`);
      } else {
        ws.send(JSON.stringify({ type: 'auth_failed', payload: { error: 'invalid token' } }));
        logger.warn(`[WS] Share token auth failed from ${ws._socket?.remoteAddress || 'unknown'}`);
      }
      break;
    }

    case 'sync_request': {
      // 增量同步请求
      const { since = 0, deviceId } = payload;
      const changes = db.getUnsyncedLogs(since);
      ws.send(JSON.stringify({
        type: 'sync_response',
        payload: {
          changes,
          serverTs: Math.floor(Date.now() / 1000),
          totalChanges: changes.length
        }
      }));
      logger.info(`[WS] sync_request from ${ws.deviceId}: ${changes.length} changes since ${since}`);
      break;
    }
    
    case 'sync_push': {
      // 推送本地变更到服务器，再广播给其他设备
      const { changes = [] } = payload;
      const processedIds = [];
      
      for (const change of changes) {
        if (change.action === 'create' || change.action === 'update') {
          const result = db.addFile(change.filename, change.content, change.type || 'file', change.hash);
          processedIds.push(result.id);
          // 广播实际文件数据给其他设备
          broadcastChange({
            type: change.action === 'create' ? 'file_create' : 'file_update',
            filename: change.filename,
            content: change.content,
            fileType: change.type || 'file',
            hash: change.hash || result.hash,
            size: result.size
          }, ws.deviceId);
        } else if (change.action === 'delete') {
          const existing = db.getFileByName(change.filename);
          db.deleteFileByName(change.filename);
          if (existing) processedIds.push(existing.id);
          // 广播删除给其他设备
          broadcastChange({ type: 'file_delete', filename: change.filename }, ws.deviceId);
        } else if (change.action === 'rename') {
          const { oldFilename, newFilename } = change;
          const existing = db.getFileByName(oldFilename);
          if (existing) {
            db.renameFile(oldFilename, newFilename);
            processedIds.push(existing.id);
            // 广播重命名给其他设备
            broadcastChange({ type: 'file_rename', oldFilename, newFilename }, ws.deviceId);
          }
        }
      }
      
      if (processedIds.length > 0) {
        db.markLogsSynced(processedIds);
      }
      
      ws.send(JSON.stringify({ type: 'sync_ack', payload: { processed: changes.length } }));
      break;
    }
    
    case 'file_create': {
      const { filename, content, type, hash, clientTs } = payload;
      const existing = db.getFileByName(filename);
      if (existing) {
        // 文件已存在：hash 相同则幂等忽略，hash 不同则冲突
        if (existing.hash === hash) {
          ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_create', filename, status: 'duplicate', hash } }));
        } else {
          // 冲突：通知双方
          const conflictInfo = { type: 'conflict', payload: { action: 'file_create', filename, localHash: existing.hash, remoteHash: hash, localTs: existing.updated_at, remoteTs: clientTs || 0, serverTs: Math.floor(Date.now() / 1000) } };
          ws.send(JSON.stringify(conflictInfo));
          broadcastChange({ type: 'conflict', action: 'file_create', filename, hash: existing.hash, newHash: hash }, null);
          logger.info(`[Conflict] file_create: ${filename} - local=${existing.hash} remote=${hash}`);
        }
      } else {
        db.addFile(filename, content, type || 'file', hash);
        broadcastChange({ type: 'create', filename, hash }, ws.deviceId);
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_create', filename, status: 'ok', hash } }));
      }
      break;
    }

    case 'file_update': {
      const { filename, content, type, hash, clientTs } = payload;
      const existing = db.getFileByName(filename);
      if (!existing) {
        // 文件不存在，直接创建
        db.addFile(filename, content, type || 'file', hash);
        broadcastChange({ type: 'create', filename, hash }, ws.deviceId);
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_update', filename, status: 'created', hash } }));
      } else if (existing.hash === hash) {
        // hash 相同，幂等忽略
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_update', filename, status: 'duplicate', hash } }));
      } else {
        // 冲突
        const conflictInfo = { type: 'conflict', payload: { action: 'file_update', filename, localHash: existing.hash, remoteHash: hash, localTs: existing.updated_at, remoteTs: clientTs || 0, serverTs: Math.floor(Date.now() / 1000) } };
        ws.send(JSON.stringify(conflictInfo));
        broadcastChange({ type: 'conflict', action: 'file_update', filename, hash: existing.hash, newHash: hash }, null);
        logger.info(`[Conflict] file_update: ${filename} - local=${existing.hash} remote=${hash}`);
      }
      break;
    }

    case 'file_delete': {
      const { filename } = payload;
      const existing = db.getFileByName(filename);
      if (existing) {
        db.deleteFileByName(filename);
        broadcastChange({ type: 'delete', filename }, ws.deviceId);
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_delete', filename, status: 'ok' } }));
      } else {
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_delete', filename, status: 'not_found' } }));
      }
      break;
    }

    case 'file_rename': {
      const { oldFilename, newFilename } = payload;
      const existing = db.getFileByName(oldFilename);
      if (existing) {
        const result = db.renameFile(oldFilename, newFilename);
        if (result.success) {
          broadcastChange({ type: 'rename', oldFilename, newFilename }, ws.deviceId);
          ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_rename', oldFilename, newFilename, status: 'ok' } }));
        } else {
          ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_rename', oldFilename, newFilename, status: 'error', error: result.error } }));
        }
      } else {
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_rename', oldFilename, newFilename, status: 'not_found' } }));
      }
      break;
    }

    case 'conflict_resolve': {
      // 冲突解决：force_remote 接受远程版本覆盖本地，force_local 保留本地版本
      const { filename, resolution, hash, content, type } = payload;
      if (resolution === 'force_remote') {
        if (content !== undefined) {
          const existing = db.getFileByName(filename);
          if (existing) {
            db.updateFileByName(filename, { content, type: type || existing.type, hash });
          } else {
            db.addFile(filename, content, type || 'file', hash);
          }
        }
        broadcastChange({ type: 'file_update', filename, hash }, ws.deviceId);
        logger.info(`[Conflict] Resolved force_remote: ${filename}`);
      } else if (resolution === 'force_local') {
        // 通知其他设备以本地为准（不需要做什么，因为本地没变）
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'conflict_resolve', filename, status: 'kept_local' } }));
        logger.info(`[Conflict] Resolved force_local: ${filename}`);
      } else if (resolution === 'rename_both') {
        // 重命名远程版本：filename → filename_timestamp
        const ts = Date.now();
        const newName = `${filename}.conflict_${ts}`;
        db.renameFile(filename, newName);
        db.addFile(filename, content, type || 'file', hash);
        broadcastChange({ type: 'file_rename', oldFilename: filename, newFilename: newName }, ws.deviceId);
        broadcastChange({ type: 'file_create', filename, hash }, ws.deviceId);
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'conflict_resolve', filename, status: 'renamed', newFilename: filename } }));
        logger.info(`[Conflict] Resolved rename_both: ${filename} → ${newName}`);
      }
      break;
    }

    case 'file_move': {
      const { sourceFilename, destFilename } = payload;
      const result = db.moveFile(sourceFilename, destFilename);
      if (result.success) {
        broadcastChange({ type: 'file_move', oldFilename: sourceFilename, newFilename: destFilename }, ws.deviceId);
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_move', sourceFilename, destFilename, status: 'ok' } }));
      } else {
        ws.send(JSON.stringify({ type: 'sync_ack', payload: { action: 'file_move', sourceFilename, destFilename, status: 'error', error: result.error } }));
      }
      break;
    }

    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong' }));
      if (ws.deviceId) db.touchDevice(ws.deviceId);
      break;
    }
  }
}

function broadcastChange(change, excludeDeviceId = null) {
  const msg = JSON.stringify({ type: 'change', payload: change });
  syncClients.forEach((ws) => {
    if (ws.deviceId !== excludeDeviceId && ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

function broadcastDeviceList() {
  const devices = db.listDevices().map(d => ({
    deviceId: d.device_id,
    deviceName: d.device_name,
    ip: d.ip,
    isOnline: d.is_online === 1
  }));
  const msg = JSON.stringify({ type: 'device_list', payload: { devices } });
  syncClients.forEach((ws) => {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  });
}

// ============================================================
// UDP 设备发现
// ============================================================
function startDiscovery() {
  udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  
  udpServer.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      
      if (data.type === 'discovery') {
        // 收到发现请求，响应本机信息
        const response = JSON.stringify({
          type: 'discovery_response',
          payload: {
            deviceId: DEVICE_ID,
            deviceName: DEVICE_NAME,
            ip: LOCAL_IP,
            port: PORT,
            wsPort: WS_PORT
          }
        });
        udpServer.send(response, rinfo.port, rinfo.address);
      }
      else if (data.type === 'discovery_response') {
        // 收到其他设备响应，注册到数据库
        if (data.payload.deviceId !== DEVICE_ID) {
          db.registerDevice(
            data.payload.deviceId,
            data.payload.deviceName,
            data.payload.ip,
            data.payload.port
          );
          logger.info(`[Discovery] Found device: ${data.payload.deviceName} (${data.payload.ip})`);
        }
      }
    } catch (e) {
      // 忽略无效消息
    }
  });
  
  udpServer.on('error', (e) => {
    logger.error({ err: e }, 'Discovery error');
  });
  
  udpServer.bind(DISCOVERY_PORT, () => {
    udpServer.setBroadcast(true);
    logger.info(`[Discovery] UDP server on port ${DISCOVERY_PORT}`);
    
    // 立即广播一次
    broadcastDiscovery();
    
    // 定时广播
    broadcastTimer = setInterval(broadcastDiscovery, BROADCAST_INTERVAL);
  });
}

function broadcastDiscovery() {
  const msg = JSON.stringify({
    type: 'discovery',
    payload: {
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      ip: LOCAL_IP,
      port: PORT,
      wsPort: WS_PORT
    }
  });
  
  // 广播到同网段所有设备（静默处理 EHOSTUNREACH，单网卡环境正常）
  udpServer.send(msg, DISCOVERY_PORT, '255.255.255.255', (e) => {
    if (e && e.code !== 'EHOSTUNREACH') {
      logger.warn('[Discovery] Broadcast failed: ' + e.message);
    }
  });
}

function startHeartbeat() {
  setInterval(() => {
    try {
      db.touchDevice(DEVICE_ID);
      db.cleanupStaleDevices(5); // 5分钟不活跃视为离线
    } catch (e) {
      logger.error({ err: e }, '[Heartbeat]');
    }
  }, 60000);
}

function startSyncScheduler() {
  // 每分钟检查一次同步状态
  setInterval(() => {
    try {
      const onlineDevices = db.getOnlineDevices().filter(d => d.device_id !== DEVICE_ID);
      const { unsynced, unsyncedSize } = db.getSyncStatus();

      if (onlineDevices.length > 0 && unsynced > 0) {
        logger.info(`[Sync] ${unsynced} unsynced changes (${formatSize(unsyncedSize)}), ${onlineDevices.length} online devices - nudging`);
        // 主动通知在线设备拉取待同步变更
        broadcastChange({ type: 'sync_nudge', pending: unsynced, size: unsyncedSize }, null);
      }
    } catch (e) {
      logger.error({ err: e }, '[SyncScheduler]');
    }
  }, 60000);
  
  // 每小时清理一次过期 Token、分享链接、sync_log、audit_log
  setInterval(() => {
    try {
      db.cleanupExpiredTokens();
      db.cleanupExpiredShareLinks();
      db.cleanupSyncLog(7);  // 保留7天已同步的 sync_log
      db.cleanupAuditLog(90); // 保留90天审计日志
    } catch (e) {
      logger.error({ err: e }, '[Cleanup]');
    }
  }, 3600000);

  // 每天凌晨3点执行 VACUUM（DB碎片整理）
  setInterval(() => {
    try {
      const h = new Date().getHours();
      if (h === 3) {
        logger.info('[DB] Running daily VACUUM...');
        db.runVacuum();
      }
    } catch (e) {
      logger.error({ err: e }, '[Vacuum]');
    }
  }, 3600000);

  // DB 健康检查：每10分钟一次
  setInterval(() => {
    try {
      const stats = db.getDbStats();
      const integrity = db.checkDbIntegrity();
      if (integrity !== 'ok') {
        logger.error('[DB] Integrity check failed: ' + integrity);
      }
      const memUsage = process.memoryUsage();
      logger.info(`[Health] DB: files=${stats.totalFiles}, conn=${stats.connections}, heap=${Math.round(memUsage.heapUsed/1024/1024)}MB`);
    } catch (e) {
      logger.error({ err: e }, '[HealthCheck]');
    }
  }, 600000); // 10 minutes
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>ShareTool</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#667eea" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="ShareTool">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="manifest" href="/manifest.json">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg-primary: #0f172a;
  --bg-secondary: #1e293b;
  --bg-tertiary: #334155;
  --bg-hover: #1e293b;
  --modal-backdrop: rgba(0,0,0,0.7);
  --border-color: #334155;
  --text-primary: #e2e8f0;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --accent-primary: #667eea;
  --accent-secondary: #764ba2;
  --success: #22c55e;
  --success-fg: #4ade80;
  --danger-fg: #f87171;
  --info-fg: #60a5fa;
  --code-fg: #4ade80;
  --danger: #dc2626;
  --warning: #d97706;
  --warning-bg: #78350f;
  --warning-fg: #fef3c7;
}
[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f8fafc;
  --bg-tertiary: #f1f5f9;
  --bg-hover: #e2e8f0;
  --bg-modal: #ffffff;
  --modal-backdrop: rgba(0,0,0,0.5);
  --border-color: #cbd5e1;
  --text-primary: #1e293b;
  --text-secondary: #475569;
  --text-muted: #64748b;
  --accent-primary: #667eea;
  --accent-secondary: #764ba2;
  --success: #22c55e;
  --success-fg: #4ade80;
  --danger-fg: #f87171;
  --info-fg: #60a5fa;
  --code-fg: #4ade80;
  --danger: #dc2626;
  --warning: #d97706;
  --warning-bg: #fef3c7;
  --warning-fg: #1e293b;
  --text-inverse: #fff;
}
[data-theme="dark"] {
  --bg-primary: #0f172a;
  --bg-secondary: #1e293b;
  --bg-tertiary: #334155;
  --bg-hover: #1e293b;
  --bg-modal: #0f172a;
  --border-color: #334155;
  --text-primary: #f1f5f9;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --accent-primary: #667eea;
  --accent-secondary: #764ba2;
  --success: #22c55e;
  --success-fg: #4ade80;
  --danger-fg: #f87171;
  --info-fg: #60a5fa;
  --code-fg: #4ade80;
  --danger: #dc2626;
  --warning: #d97706;
  --warning-bg: #78350f;
  --warning-fg: #fef3c7;
  --text-inverse: #fff;
}
[data-theme="dark"] body { background: var(--bg-primary); }
[data-theme="dark"] .card { background: var(--bg-secondary); border-color: var(--border-color); }
[data-theme="dark"] .hero { background: linear-gradient(135deg, var(--bg-secondary) 0%, var(--bg-primary) 100%); border-color: var(--border-color); }
[data-theme="dark"] input[type="text"], [data-theme="dark"] input[type="search"], [data-theme="dark"] textarea { background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary); }
[data-theme="dark"] .file-item { background: var(--bg-tertiary); border-color: var(--border-color); }
[data-theme="dark"] .file-item:hover { border-color: var(--text-muted); }
[data-theme="light"] .file-item { background: var(--bg-tertiary); border-color: var(--border-color); }
[data-theme="light"] .file-item:hover { border-color: var(--accent-primary); }
[data-theme="dark"] .file-item.selected { background: rgba(102, 126, 234, 0.15); border-color: var(--accent-primary); }
[data-theme="light"] .file-item.selected { background: rgba(102, 126, 234, 0.08); border-color: var(--accent-primary); }
[data-theme="dark"] input[type="checkbox"] { accent-color: var(--accent-primary); }
[data-theme="dark"] ::selection { background: rgba(102, 126, 234, 0.35); color: var(--text-primary); }
[data-theme="light"] ::selection { background: rgba(102, 126, 234, 0.25); color: var(--text-primary); }
[data-theme="dark"] .code-box { background: var(--bg-tertiary); border-color: var(--border-color); color: var(--code-fg); }
[data-theme="light"] .code-box { background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary); }
[data-theme="dark"] .modal-content { background: var(--bg-secondary); border-color: var(--border-color); }
[data-theme="light"] .modal-content { background: var(--bg-secondary); border-color: var(--border-color); }
[data-theme="dark"] .modal-overlay,
[data-theme="dark"] .qr-modal-overlay { background: rgba(0,0,0,0.85); }
[data-theme="light"] .modal-overlay,
[data-theme="light"] .qr-modal-overlay { background: rgba(0,0,0,0.5); }

.modal-overlay,
.qr-modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: var(--modal-backdrop, rgba(0,0,0,0.7));
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.25s ease, visibility 0.25s ease;
}
.modal-overlay.show,
.qr-modal-overlay.show {
  opacity: 1;
  visibility: visible;
}
.modal-content {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 24px;
  max-width: 700px;
  width: 90%;
  max-height: 80vh;
  overflow: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: max(24px, env(safe-area-inset-bottom));
  transform: scale(0.95) translateY(8px);
  transition: transform 0.25s ease, opacity 0.25s ease;
  opacity: 0;
}
.modal-overlay.show .modal-content,
.qr-modal-overlay.show .modal-content {
  transform: scale(1) translateY(0);
  opacity: 1;
}
[data-theme="dark"] .modal-backdrop { background: rgba(0,0,0,0.7); }
[data-theme="dark"] .modal-close { color: var(--text-muted); }
[data-theme="dark"] .modal-close:hover { color: var(--text-primary); }
[data-theme="light"] .modal-close { color: var(--text-muted); }
[data-theme="light"] .modal-close:hover { color: var(--text-primary); }
[data-theme="dark"] .modal-backdrop { background: rgba(0,0,0,0.7); }
[data-theme="light"] .modal-backdrop { background: rgba(0,0,0,0.5); }
[data-theme="dark"] select { background: var(--bg-tertiary); color: var(--text-primary); border-color: var(--border-color); }
[data-theme="light"] select { background: var(--bg-tertiary); color: var(--text-primary); border-color: var(--border-color); }
[data-theme="dark"] ::-webkit-scrollbar { background: var(--bg-secondary); }
[data-theme="dark"] ::-webkit-scrollbar-thumb { background: var(--bg-tertiary); }
[data-theme="dark"] * { scrollbar-width: thin; scrollbar-color: var(--bg-tertiary) var(--bg-secondary); }
[data-theme="light"] ::-webkit-scrollbar { background: var(--bg-secondary); }
[data-theme="light"] ::-webkit-scrollbar-thumb { background: var(--border-color); }
[data-theme="light"] ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
[data-theme="light"] * { scrollbar-width: thin; scrollbar-color: var(--border-color) var(--bg-secondary); }
[data-theme="dark"] .device-item { background: var(--bg-tertiary); border-color: var(--border-color); }
[data-theme="light"] .device-item { background: var(--bg-tertiary); border-color: var(--border-color); }
[data-theme="dark"] .tag-item { background: var(--bg-tertiary); border-color: var(--border-color); }
[data-theme="light"] .tag-item { background: var(--bg-tertiary); border-color: var(--border-color); }
[data-theme="dark"] .status-item { background: var(--bg-secondary); border-color: var(--border-color); color: var(--text-secondary); }
[data-theme="dark"] .progress-bar { background: var(--bg-secondary); }
[data-theme="dark"] .file-upload-area { background: var(--bg-tertiary); border-color: var(--border-color); }
[data-theme="dark"] .file-upload-area:hover { border-color: #8b9dff; background: rgba(102, 126, 234, 0.12); }
[data-theme="dark"] .file-upload-area.drag-over { border-color: #8b9dff; background: rgba(102, 126, 234, 0.2); transform: scale(1.02); }
[data-theme="dark"] .file-preview { background: var(--bg-secondary); border-color: var(--border-color); color: var(--text-secondary); }
[data-theme="light"] .file-preview { background: var(--bg-secondary); border-color: var(--border-color); color: var(--text-secondary); }
[data-theme="dark"] .filter-tab { background: var(--bg-tertiary); color: var(--text-muted); border-color: var(--border-color); }
[data-theme="dark"] .filter-tab:hover { border-color: var(--accent-primary); color: var(--text-primary); }
[data-theme="dark"] .filter-tab.active { background: rgba(102,126,234,0.25); border-color: var(--accent-primary); color: var(--text-primary); }
[data-theme="light"] .filter-tab { background: var(--bg-tertiary); color: var(--text-muted); border-color: var(--border-color); }
[data-theme="light"] .filter-tab:hover { border-color: var(--accent-primary); color: var(--text-primary); }
[data-theme="light"] .filter-tab.active { background: rgba(102,126,234,0.15); border-color: var(--accent-primary); color: var(--accent-primary); }
[data-theme="dark"] .batch-bar { background: var(--bg-tertiary); }
[data-theme="dark"] .batch-bar button { background: var(--accent-primary); color: #fff; }
[data-theme="dark"] .batch-bar button.danger { background: var(--danger); color: #fff; }
[data-theme="light"] .batch-bar { background: var(--bg-tertiary); }
[data-theme="light"] .batch-bar button { background: var(--accent-primary); color: #fff; }
[data-theme="light"] .batch-bar button.danger { background: var(--danger); color: #fff; }

[data-theme="dark"] .sort-bar { color: var(--text-muted); }
[data-theme="light"] .sort-bar { color: var(--text-muted); }
[data-theme="dark"] .tag-filter-bar { color: var(--text-muted); }
[data-theme="dark"] .upload-queue-item { border-color: var(--border-color); color: var(--text-secondary); }
[data-theme="dark"] .share-link-box input { background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary); }
[data-theme="dark"] .tag-filter-btn { color: var(--text-muted); }
[data-theme="dark"] .recent-search-tag { background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-muted); }
[data-theme="dark"] .recent-search-tag:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
[data-theme="light"] .recent-search-tag { background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-muted); }
[data-theme="light"] .recent-search-tag:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
[data-theme="dark"] .file-tag { background: rgba(102,126,234,0.25); color: #a5b4fc; }
[data-theme="light"] .file-tag { background: rgba(102,126,234,0.15); color: var(--accent-primary); }
[data-theme="dark"] .file-tag:hover { opacity: 0.9; }
[data-theme="light"] .file-tag:hover { opacity: 0.9; }
[data-theme="dark"] .view-toggle { background: var(--bg-tertiary); border-color: var(--border-color); }
[data-theme="light"] .view-toggle { background: var(--bg-tertiary); border-color: var(--border-color); }

/* ============================================================ */
/* File Info Side Panel */
/* ============================================================ */
#fileInfoPanel {
  position: fixed;
  top: 0; right: 0;
  width: 320px;
  max-width: 90vw;
  height: 100dvh;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  z-index: 400;
  transform: translateX(100%);
  transition: transform 0.3s ease;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  -webkit-overflow-scrolling: touch;
}
#fileInfoPanel.open {
  transform: translateX(0);
  box-shadow: -4px 0 20px rgba(0,0,0,0.3);
}
.file-info-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  flex-shrink: 0;
}
.file-info-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}
.file-info-close {
  background: none;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: var(--text-muted);
  padding: 4px;
  line-height: 1;
}
.file-info-close:hover { color: var(--text-primary); }
.file-info-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  -webkit-overflow-scrolling: touch;
}
.file-info-section {
  margin-bottom: 20px;
}
.file-info-section-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 8px;
}
.file-info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
}
.file-info-row:last-child { border-bottom: none; }
.file-info-label { color: var(--text-muted); }
.file-info-value {
  color: var(--text-secondary);
  font-family: monospace;
  font-size: 11px;
  text-align: right;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-info-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.file-info-share-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  margin-bottom: 6px;
  font-size: 11px;
}
.file-info-share-url {
  font-family: monospace;
  font-size: 10px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.file-info-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
}

/* iOS Safari 100vh fix: use 100dvh for dynamic viewport height */
/* Theme transition: smooth color changes when switching */
*, *::before, *::after {
  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.15s ease, fill 0.15s ease;
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-primary); color: var(--text-primary); min-height: 100dvh; overscroll-behavior: none; /* prevent pull-to-refresh on mobile */ -webkit-tap-highlight-color: transparent; overflow-x: hidden; }
/* iOS safe-area support for notch/Dynamic Island devices */
header { text-align: center; margin-bottom: 32px; padding: env(safe-area-inset-top) 16px 0; }
main { padding: 0 16px env(safe-area-inset-bottom); overflow-y: auto; -webkit-overflow-scrolling: touch; }
.container { max-width: 900px; margin: 0 auto; padding: 24px 16px; overflow-x: hidden; }
/* Global overflow guard */
#root, #app { overflow-x: hidden; }
h1 { font-size: 32px; font-weight: 700; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 8px; }
.subtitle { color: var(--text-muted); font-size: 14px; }
.status-bar { display: flex; gap: 16px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
.status-item { font-size: 12px; padding: 4px 12px; background: var(--bg-secondary); border-radius: 20px; border: 1px solid var(--border-color); }
.status-item.connected { border-color: var(--success); color: var(--success); }
.status-item.disconnected { border-color: var(--text-muted); color: var(--text-muted); }
.hero { background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px; padding: 24px; margin-bottom: 24px; border: 1px solid var(--border-color); overflow: hidden; }
.hero-content { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
.hero-text { flex: 1; min-width: 200px; }
.hero-title { font-size: 18px; font-weight: 600; color: var(--text-primary); margin-bottom: 12px; }
.hero-desc { font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 8px; }
.hero-features { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.hero-feature { background: rgba(102, 126, 234, 0.15); padding: 4px 10px; border-radius: 20px; font-size: 11px; color: var(--accent-primary); }
.card { background: var(--bg-secondary); border-radius: 16px; padding: 24px; margin-bottom: 20px; border: 1px solid var(--border-color); }
.section-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: var(--text-secondary); display: flex; align-items: center; gap: 8px; }
.section-title::before { content: ''; width: 4px; height: 16px; background: linear-gradient(180deg, #667eea, #764ba2); border-radius: 2px; }
textarea { width: 100%; padding: 14px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 10px; color: var(--text-primary); font-size: 16px; margin-bottom: 12px; resize: vertical; min-height: 100px; font-family: inherit; touch-action: manipulation; }
textarea:focus { outline: none; border-color: var(--accent-primary); }
input[type="text"], input[type="search"], input[type="password"] { width: 100%; padding: 12px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 10px; color: var(--text-primary); font-size: 16px; margin-bottom: 12px; touch-action: manipulation; }
input:focus { outline: none; border-color: var(--accent-primary); }
.btn { padding: 12px 20px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; border-radius: 10px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
.btn:hover { opacity: 0.9; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3); }
.btn:active { opacity: 0.8; transform: translateY(0); box-shadow: none; }
.btn-secondary { background: var(--bg-secondary); color: var(--text-primary); }
.btn-danger { background: var(--danger); }
.btn-warning { background: var(--warning); }
.btn-sm { padding: 8px 14px; font-size: 13px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; }
.file-upload-area { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; background: var(--bg-tertiary); border: 2px dashed var(--border-color); border-radius: 12px; cursor: pointer; transition: all 0.2s; text-align: center; }
.file-upload-area:hover { border-color: var(--accent-primary); background: var(--bg-hover); }
.file-upload-area.drag-over { border-color: var(--accent-primary); background: rgba(102,126,234,0.1); transform: scale(1.02); }
.file-upload-area input { position: absolute; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.file-upload-area .icon { font-size: 40px; margin-bottom: 12px; }
.file-upload-area .text { color: var(--text-muted); font-size: 14px; }
.file-upload-area .hint { color: var(--text-muted); font-size: 12px; margin-top: 8px; }
.file-list { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.file-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }
@media (max-width: 480px) { .file-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; } }
@media (max-width: 360px) { .file-grid { grid-template-columns: 1fr; gap: 6px; } }
.file-grid .file-item { flex-direction: column; align-items: stretch; padding: 16px; min-height: 140px; }
.file-grid .file-content { flex: 1; }
.file-grid .file-name { font-size: 13px; }
.file-grid .file-meta { font-size: 11px; }
.file-grid .file-actions { flex-wrap: wrap; justify-content: flex-start; margin-top: 8px; }
.file-grid .file-actions .btn { font-size: 11px; padding: 8px 6px; min-height: 44px; }
.file-grid .file-tags { margin-top: 6px; }
.file-grid .file-tag { font-size: 10px; padding: 2px 6px; }
.file-grid .file-star { position: absolute; top: 8px; right: 8px; }

/* Drag-and-drop for file reordering */
.file-item[draggable="true"] { cursor: grab; }
.file-item[draggable="true"]:active { cursor: grabbing; }
.file-item.drag-over { outline: 2px dashed var(--accent-primary); outline-offset: -2px; background: rgba(102, 126, 234, 0.08); }
.file-item.dragging { opacity: 0.4; }
.file-item { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px; background: var(--bg-tertiary); border-radius: 10px; border: 1px solid var(--border-color); gap: 12px; touch-action: pan-y; user-select: none; position: relative; overflow: hidden; }
.file-item.focused { outline: 2px solid var(--accent-primary); outline-offset: 1px; }
.file-item:hover { border-color: var(--text-muted); }
.file-item .swipe-actions { position: absolute; right: 0; top: 0; bottom: 0; display: flex; align-items: center; gap: 0; transform: translateX(100%); transition: transform 0.2s ease; }
.file-item .swipe-actions.show { transform: translateX(0); }
.file-item .swipe-btn { height: 100%; padding: 0 20px; border: none; color: white; font-size: 13px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 2px; min-width: 60px; }
.file-item .swipe-btn.delete { background: var(--danger); }
.file-item .swipe-btn.tag { background: var(--warning); }
.file-item .swipe-btn .icon { font-size: 16px; }
/* Long-press context menu (mobile) */
#contextMenu {
  position: fixed;
  z-index: 9999;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 6px 0;
  min-width: 180px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.25);
  display: none;
}
#contextMenu.show { display: block; }
.ctx-item {
  padding: 10px 16px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 0;
  transition: background 0.1s;
}
.ctx-item:hover, .ctx-item:active { background: var(--bg-tertiary); }
.ctx-item.danger { color: var(--danger); }
.ctx-sep { height: 1px; background: var(--border-color); margin: 4px 0; }
.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
  background: transparent;
  display: none;
}
.ctx-backdrop.show { display: block; }
.file-content { flex: 1; min-width: 0; }
.file-preview { background: var(--bg-secondary); border-radius: 8px; padding: 12px; margin-top: 8px; max-height: 150px; overflow: auto; white-space: pre-wrap; font-size: 12px; color: var(--text-secondary); border: 1px solid var(--border-color); word-break: break-all; display: none; }
.file-preview.show { display: block; }
.file-audio-player audio { width: 100%; height: 36px; margin-top: 4px; }
.file-video-wrapper video { width: 100%; max-height: 200px; border-radius: 8px; background: var(--bg-secondary,#000); margin-top: 4px; }
[data-theme="dark"] .file-audio-player audio { filter: invert(0.8); } /* improve contrast on dark bg */
.file-name { font-weight: 500; color: var(--text-primary); word-break: break-all; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.file-name input.inline-rename { font-size: 14px; font-weight: 500; background: var(--bg-tertiary); border: 1px solid var(--accent-primary); border-radius: 4px; color: var(--text-primary); padding: 2px 6px; outline: none; width: 100%; }
.file-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.file-tag { font-size: 10px; padding: 4px 8px; background: rgba(102,126,234,0.2); color: var(--accent-primary); border-radius: 4px; cursor: pointer; transition: all 0.15s; min-height: 24px; /* touch target */ }
.file-tag:hover { opacity: 0.85; }
.file-tag .remove-tag { margin-left: 4px; opacity: 0.6; }
.file-tag .remove-tag:hover { opacity: 1; }
.file-meta { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.file-actions { display: flex; gap: 8px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.empty { text-align: center; padding: 30px; color: var(--text-muted); }
.empty-icon { font-size: 48px; margin-bottom: 12px; opacity: 0.5; }
.empty-text { font-size: 14px; }
.alert { padding: 12px 16px; border-radius: 10px; margin-bottom: 16px; font-size: 14px; display: none; }
.alert-success { background: rgba(34, 197, 94, 0.15); border: 1px solid var(--success); color: var(--success-fg); }
.alert-error { background: rgba(220, 38, 38, 0.15); border: 1px solid var(--danger); color: var(--danger-fg); }
.alert-info { background: rgba(59, 130, 246, 0.15); border: 1px solid var(--info-color, #3b82f6); color: var(--info-fg); }
.alert.show { display: block; }
.code-box { background: var(--bg-tertiary); padding: 14px; border-radius: 10px; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; color: var(--code-fg); margin: 8px 0; overflow-x: auto; border: 1px solid var(--border-color); white-space: pre-wrap; word-break: break-all; }
.progress-bar { width: 100%; height: 8px; background: var(--bg-secondary); border-radius: 4px; overflow: hidden; margin-top: 8px; }
.progress-bar .fill { height: 100%; background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary)); transition: width 0.3s; }
.batch-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.setting-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.setting-row label { color: var(--text-secondary); font-size: 14px; min-width: 80px; }
.setting-row input { flex: 1; margin-bottom: 0; }
.device-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.device-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--bg-tertiary); border-radius: 8px; border: 1px solid var(--border-color); font-size: 13px; }
.device-item .indicator { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
.device-item .indicator.online { background: var(--success); box-shadow: 0 0 8px var(--success); }
.device-item .name { flex: 1; color: var(--text-primary); }
.device-item .ip { color: var(--text-muted); font-family: monospace; }
.search-bar { display: flex; gap: 8px; margin-bottom: 16px; }
.search-bar input { flex: 1; margin-bottom: 0; }
.search-wrapper { position: relative; }
.search-suggestions { position: absolute; top: 100%; left: 0; right: 0; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; margin-top: 4px; z-index: 1000; max-height: 240px; overflow-y: auto; box-shadow: 0 4px 16px rgba(0,0,0,0.15); }
.search-suggestion { padding: 10px 14px; cursor: pointer; font-size: 13px; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
.search-suggestion:hover { background: var(--bg-tertiary); }
.search-suggestion.selected { background: var(--bg-tertiary); outline: 1px solid var(--accent-primary); }
.search-suggestion .suggestion-icon { color: var(--text-muted); font-size: 12px; }
.search-suggestion .suggestion-tag { font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-left: auto; }
.filter-tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.filter-tab { padding: 6px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 20px; font-size: 12px; color: var(--text-muted); cursor: pointer; transition: all 0.2s; }
.filter-tab:hover { border-color: var(--accent-primary); }
.filter-tab.active { background: rgba(102,126,234,0.2); border-color: var(--accent-primary); }
.tab-bar { display: flex; gap: 4px; margin-bottom: 16px; background: var(--bg-tertiary); padding: 4px; border-radius: 10px; }
.tab-item { flex: 1; padding: 10px; text-align: center; font-size: 14px; color: var(--text-muted); border-radius: 8px; cursor: pointer; transition: all 0.2s; }
.tab-item:hover { color: var(--text-primary); }
.tab-item.active { background: var(--bg-secondary); color: var(--accent-primary); font-weight: 500; }
.qr-section { display: none; text-align: center; padding: 16px; background: var(--bg-tertiary); border-radius: 12px; margin-bottom: 16px; }
.qr-section.show { display: block; }
.qr-section canvas { border-radius: 8px; margin: 0 auto 8px; }
.qr-url { font-size: 12px; color: var(--text-muted); word-break: break-all; font-family: monospace; }
.file-checkbox { width: 18px; height: 18px; accent-color: var(--accent-primary); cursor: pointer; flex-shrink: 0; }
.batch-bar { display: none; gap: 8px; align-items: center; padding: 8px 12px; background: var(--bg-tertiary); border-radius: 8px; margin-bottom: 12px; font-size: 13px; flex-wrap: wrap; }
.batch-bar.show { display: flex; }
.batch-bar .batch-count { color: var(--text-muted); flex: 1; min-width: 80px; }
.batch-bar button { padding: 8px 12px; background: var(--accent-primary); border: none; border-radius: 6px; color: white; font-size: 12px; cursor: pointer; transition: opacity 0.15s; white-space: nowrap; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.batch-bar button.danger { background: var(--danger); }
.batch-bar button:disabled { opacity: 0.5; cursor: not-allowed; }
.batch-bar .batch-status { display: none; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 12px; padding: 4px 8px; background: var(--bg-secondary); border-radius: 6px; }
.batch-bar .batch-status.active { display: flex; }
.batch-bar .batch-status .spinner { width: 12px; height: 12px; border: 2px solid var(--border-color); border-top-color: var(--accent-primary); border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 600px) {
  .batch-bar { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; padding: 6px 8px; padding-bottom: max(6px, env(safe-area-inset-bottom)); }
  .batch-bar .batch-count { min-width: 60px; font-size: 12px; }
  .batch-bar button { padding: 5px 8px; font-size: 11px; flex-shrink: 0; }
  .batch-bar .batch-status { font-size: 11px; flex-shrink: 0; }
}

.file-context-menu {
  position: fixed;
  z-index: 10000;
  background: var(--bg-elevated, var(--bg-secondary));
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 4px 0;
  min-width: 160px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.15);
  display: none;
}
.file-context-menu.show { display: block; }
.file-context-menu .ctx-item {
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
  min-height: 44px;
}
.file-context-menu .ctx-item:hover { background: var(--bg-tertiary); }
.file-context-menu .ctx-item.danger { color: var(--danger); }
.file-context-menu .ctx-divider { height: 1px; background: var(--border-color); margin: 4px 0; }
.drop-zone { border: 2px dashed var(--border-color); border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 16px; transition: all 0.2s; color: var(--text-muted); font-size: 13px; }
.drop-zone.drag-over { border-color: var(--accent-primary); background: rgba(102,126,234,0.1); color: var(--accent-primary); }
.drop-zone-icon { font-size: 24px; margin-bottom: 8px; }
.fab { position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px; border-radius: 50%; background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); color: white; border: none; border-radius: 50%; font-size: 24px; cursor: pointer; box-shadow: 0 4px 16px rgba(102,126,234,0.4); z-index: 300; transition: all 0.2s; display: none; /* shown via JS when files exist */ backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.fab:hover { transform: scale(1.1); }
.fab-menu { display: none; position: fixed; bottom: 90px; right: 24px; flex-direction: column; gap: 8px; z-index: 350; }
.fab-menu.show { display: flex; }
.fab-menu .btn { width: 48px; height: 48px; border-radius: 50%; padding: 0; font-size: 18px; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
.file-type-icon { font-size: 16px; margin-right: 6px; }

.tag-filter-btn { cursor: pointer; transition: all 0.2s; }
.search-highlight { background: rgba(102,126,234,0.4); color: var(--text-primary); border-radius: 2px; padding: 0 2px; }
[data-theme="dark"] .search-highlight { background: rgba(102,126,234,0.4); color: var(--text-primary); }
.loading-spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--text-muted); border-top-color: var(--accent-primary); border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.file-item { animation: fadeIn 0.2s ease-out; }
.toast { position: fixed; bottom: max(100px, calc(100px + env(safe-area-inset-bottom))); left: 50%; transform: translateX(-50%); background: var(--bg-secondary); border: 1px solid var(--border-color); padding: 12px 24px; border-radius: 10px; font-size: 14px; z-index: 200; box-shadow: 0 4px 20px rgba(0,0,0,0.3); opacity: 0; transition: opacity 0.3s; max-width: calc(100vw - 48px); text-align: center; word-break: break-word; }
.toast.show { opacity: 1; }
@media (max-width: 768px) {
  .container { max-width: 100%; }
  .modal-content { max-width: 95%; }
  .search-suggestions { max-height: 300px; }
  .file-grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
  .filter-tabs { overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .filter-tabs::-webkit-scrollbar { display: none; }
}

@media (max-width: 500px) {
  .container { padding: 12px; padding-bottom: max(100px, calc(100px + env(safe-area-inset-bottom))); }
  .hero { padding: 16px; }
  .hero-content { display: none; /* hide marketing text on mobile, just show title */ }
  .hero-title { font-size: 15px; }
  .hero-features { display: none; }
  .hero-desc { display: none; }
  .fab-menu { bottom: max(90px, calc(90px + env(safe-area-inset-bottom))); right: 16px; }
  .actions { flex-direction: column; }
  .btn { width: 100%; text-align: center; min-height: 44px; /* touch target */ }
  .file-actions { justify-content: flex-start; flex-wrap: wrap; }
  .file-item { flex-direction: column; min-height: 60px; padding: 16px; }
  .file-item .file-name { font-size: 15px; }
  .file-actions .btn { width: auto; flex: 1; min-width: 60px; text-align: center; font-size: 12px; padding: 10px 10px; min-height: 44px; /* touch target */ }
  .setting-row { flex-direction: column; align-items: stretch; }
  .setting-row label { min-width: auto; }
  .hero-content { flex-direction: column; }
  .hero-url { flex-direction: column; }
  .status-bar { flex-direction: column; align-items: center; }
  .search-bar { flex-direction: column; gap: 8px; }
  .search-bar .btn { width: 100%; min-height: 44px; }
  .search-bar input { min-height: 44px; font-size: 16px; width: 100%; box-sizing: border-box; }
  .search-suggestions { max-height: 60vh; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  #clearSearchBtn { display: inline-block !important; } /* always show clear on mobile */
  .sort-bar select, .share-link-box input, input[type="password"] { font-size: 16px; min-height: 44px; }
  .file-grid { grid-template-columns: 1fr; }
  .file-grid .file-item { flex-direction: column; min-height: auto; }
  .card > div > .btn { width: 100%; margin-bottom: 8px; }
  .card > div > .btn:last-child { margin-bottom: 0; }
  .code-box { font-size: 11px; word-break: break-all; }
  .search-suggestions { max-height: 250px; }
  .qr-section.show { display: block; }
  .conn-status { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted); margin-left: 8px; }
  .conn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
  .conn-dot.connected { background: var(--success); box-shadow: 0 0 4px var(--success); }
  .storage-bar { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-muted); }
  .storage-bar progress { width: 80px; height: 6px; accent-color: var(--accent-primary); }
  .storage-text { font-size: 11px; color: var(--text-muted); }
  .share-link-box { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .share-link-box input { flex: 1; padding: 6px 10px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 16px; font-family: monospace; min-height: 44px; /* prevent iOS zoom */ }
  .share-link-box button { padding: 6px 12px; background: var(--accent-primary); border: none; border-radius: 6px; color: white; font-size: 14px; cursor: pointer; min-height: 44px; /* touch target */ }
  .upload-progress-bar { width: 100%; height: 4px; background: var(--bg-tertiary); border-radius: 2px; margin-top: 8px; overflow: hidden; display: none; }
  .upload-progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary)); border-radius: 2px; transition: width 0.3s; }
  .upload-queue { display: none; margin-top: 8px; max-height: 120px; overflow-y: auto; }
  .upload-queue.show { display: block; }
  .upload-queue-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; color: var(--text-secondary); border-bottom: 1px solid var(--border-color); }
  .upload-queue-item:last-child { border-bottom: none; }
  .upload-queue-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .upload-queue-item .status { font-size: 14px; flex-shrink: 0; }
  .upload-queue-item.done .status { color: var(--success-fg); }
  .upload-queue-item.fail .status { color: var(--danger-fg); }
  .file-star { cursor: pointer; font-size: 16px; color: var(--text-muted); transition: color 0.2s; user-select: none; }
  /* Mobile-only utilities */
  .hide-mobile { display: none; }
  .show-mobile { display: block; }
  /* File info panel: full screen on mobile */
  #fileInfoPanel { width: 100vw; max-width: 100vw; }
  #fileInfoPanel .file-info-header { padding-right: max(16px, env(safe-area-inset-right)); }
  /* Modal: larger on mobile */
  .modal-content { max-width: 95vw; }
  .modal-close { padding: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)); }
  /* Better touch targets */
  .filter-tab, .filter-tab.active { padding: 10px 16px; min-height: 44px; display: inline-flex; align-items: center; }
  .file-star:hover { color: var(--warning); }
  .file-star.starred { color: var(--warning); }
  .notif-badge { position: fixed; top: 12px; right: 12px; background: var(--danger); color: white; border-radius: 50%; width: 20px; height: 20px; font-size: 11px; display: none; align-items: center; justify-content: center; z-index: 400; font-weight: bold; }
  .notif-badge.show { display: flex; }
  .filter-tab .kbd-hint { font-size: 9px; opacity: 0.6; }
}

/* Mobile menu drawer */
#mobileMenuOverlay { background: rgba(0,0,0,0.5); }
#mobileMenuDrawer { transform: translateY(100%); }
#mobileMenuDrawer.open { transform: translateY(0); }
.menu-item { width: 100%; text-align: left; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 10px; padding: 14px 16px; color: var(--text-primary); font-size: 15px; cursor: pointer; transition: background 0.15s; margin-bottom: 6px; display: block; box-sizing: border-box; }
.menu-item:hover { background: var(--bg-primary); }
.menu-item:active { background: var(--accent-primary); color: white; }

@media (min-width: 769px) {
  #menuToggle { display: none !important; }
  #mobileMenuOverlay { display: none !important; }
}

/* Extra small screens (320px - 374px) */
@media (max-width: 374px) {
  .hero-title { font-size: 13px; }
  .hero-desc { display: none; }
  .hero-features { display: none; }
  .container { padding: 8px; padding-bottom: max(100px, calc(100px + env(safe-area-inset-bottom))); }
  .file-item { padding: 12px 8px; }
  .file-item .file-name { font-size: 13px; }
  .file-actions .btn { padding: 8px 6px; font-size: 11px; min-width: 50px; }
  .btn { font-size: 13px; padding: 10px 12px; }
  .filter-tab, .filter-tab.active { padding: 8px 10px; font-size: 12px; }
  .status-bar { gap: 8px; }
  .status-item { font-size: 11px; padding: 3px 8px; }
  .modal-content { max-width: 98vw; }
  .card { padding: 16px 12px; }
  h1 { font-size: 20px; }
  .subtitle { display: none; }
  .section-title { font-size: 14px; }
  .search-bar input { font-size: 15px; }
  .search-suggestion { min-height: 44px; padding: 8px 14px; }
  .fab { width: 44px; height: 44px; font-size: 18px; }
  .fab-menu { bottom: max(80px, calc(80px + env(safe-area-inset-bottom))); right: 12px; }
  .share-link-box input { font-size: 12px; }
  .toast { font-size: 12px; padding: 8px 16px; }
  .notif-badge { width: 16px; height: 16px; font-size: 10px; top: 8px; right: 8px; }
  .conn-status { font-size: 10px; }
  .storage-bar { font-size: 10px; }
  .storage-bar progress { width: 60px; }
  /* File info panel: full screen on tiny screens */
  #fileInfoPanel { height: 100dvh; max-height: 100dvh; border-radius: 0; }
  .modal-content { max-height: 90dvh; }
  .btn-sm { min-height: 44px; display: inline-flex; align-items: center; }
  .btn { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }
}

.fav-filter-btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 14px; font-size: 12px; color: var(--text-muted); cursor: pointer; }
.fav-filter-btn:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
.fav-filter-btn.active { background: rgba(245, 158, 11, 0.15); border-color: var(--warning); color: var(--warning); }
.shortcut-list { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; font-size: 13px; }
.shortcut-key { font-family: monospace; background: var(--bg-tertiary); padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border-color); }
.shortcut-desc { color: var(--text-secondary); align-self: center; }
.paste-hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
.recent-searches { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.recent-search-tag { padding: 3px 8px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 12px; font-size: 11px; color: var(--text-muted); cursor: pointer; }
.recent-search-tag:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
.fab { display: flex; align-items: center; justify-content: center; }
.tab-bar { position: sticky; top: 0; background: var(--bg-tertiary); z-index: 50; margin-bottom: 12px; }
body.modal-open { overflow: hidden; position: fixed; width: 100%; }
.sort-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; font-size: 12px; color: var(--text-muted); flex-wrap: wrap; }
.sort-bar select { padding: 6px 10px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-primary); font-size: 12px; }
.sort-bar select:focus { outline: none; border-color: var(--accent-primary); }
.view-toggle { display: flex; gap: 2px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 8px; padding: 2px; margin-left: auto; }
.view-toggle button { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 6px 10px; border-radius: 6px; font-size: 13px; line-height: 1; transition: all 0.15s; min-height: 36px; min-width: 36px; /* touch target */ }
.view-toggle button:hover { color: var(--text-primary); }
.view-toggle button.active { background: var(--accent-primary); color: var(--text-inverse, #fff); }
.pagination { display: flex; gap: 4px; align-items: center; justify-content: center; margin-top: 16px; }
.pagination button { padding: 6px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-muted); cursor: pointer; font-size: 12px; }
.pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
.pagination button.active { background: rgba(102,126,234,0.2); border-color: var(--accent-primary); color: var(--accent-primary); }
.pagination .page-info { font-size: 12px; color: var(--text-muted); padding: 0 8px; }

.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.modal-title { font-size: 16px; font-weight: 600; color: var(--text-primary); word-break: break-all; }
.modal-close { background: none; border: none; color: var(--text-muted); font-size: 24px; cursor: pointer; }
.modal-close:hover { color: var(--text-primary); }
.modal-body { font-size: 14px; color: var(--text-secondary); line-height: 1.6; white-space: pre-wrap; word-break: break-all; max-height: 60vh; overflow: auto; }
.modal-meta { font-size: 12px; color: var(--text-muted); margin-bottom: 12px; }
.kbd-hint { font-size: 11px; color: var(--text-muted); text-align: center; margin-top: 8px; }
/* Hide keyboard hints on touch devices - they're not relevant */
@media (hover: none) and (pointer: coarse) {
  .kbd-hint { display: none; }
}
.kbd { display: inline-block; padding: 2px 6px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 11px; }
/* Markdown rendered content */
.markdown-body { color: var(--text-primary); line-height: 1.7; }
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4 { color: var(--text-primary); border-bottom: 1px solid var(--border-color); padding-bottom: 4px; margin-top: 1.5em; }
.markdown-body h1 { font-size: 1.5em; } .markdown-body h2 { font-size: 1.25em; } .markdown-body h3 { font-size: 1.1em; }
.markdown-body p { margin: 0.8em 0; }
.markdown-body code { background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; font-family: monospace; color: var(--code-fg); }
.markdown-body pre { background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; overflow-x: auto; margin: 1em 0; position: relative; }
.markdown-body pre code { background: none; padding: 0; color: var(--code-fg); }
.markdown-body blockquote { border-left: 3px solid var(--accent-primary); margin: 1em 0; padding: 4px 12px; color: var(--text-muted); background: var(--bg-tertiary); border-radius: 0 4px 4px 0; }
.markdown-body a { color: var(--accent-primary); }
.markdown-body ul,.markdown-body ol { padding-left: 1.5em; margin: 0.8em 0; }
.markdown-body table { border-collapse: collapse; width: 100%; margin: 1em 0; }
.markdown-body th,.markdown-body td { border: 1px solid var(--border-color); padding: 6px 12px; text-align: left; }
.markdown-body th { background: var(--bg-tertiary); font-weight: 600; }
.markdown-body hr { border: none; border-top: 1px solid var(--border-color); margin: 1.5em 0; }
.markdown-body img { max-width: 100%; border-radius: 4px; }
.markdown-body img[src^="http"] { cursor: pointer; }
.markdown-body img[src^="http"]:hover { opacity: 0.85; }
}
.markdown-body pre code { background: none; padding: 0; color: var(--code-fg); }
.markdown-body pre .copy-btn {
  position: absolute; top: 8px; right: 8px;
  background: var(--bg-primary); border: 1px solid var(--border-color);
  color: var(--text-muted); border-radius: 4px; padding: 2px 8px;
  font-size: 11px; cursor: pointer; opacity: 0; transition: opacity 0.2s;
  z-index: 1;
}
.markdown-body pre:hover .copy-btn { opacity: 1; }
/* Mobile/touch: always show copy button */
@media (hover: none) and (pointer: coarse) {
  .markdown-body pre .copy-btn { opacity: 1; }
}
.markdown-body pre .copy-btn:hover { color: var(--accent-primary); border-color: var(--accent-primary); }
.markdown-body pre .copy-btn.copied { color: var(--success, #10b981); border-color: var(--success, #10b981); }
/* Task list */
.markdown-body input[type="checkbox"] { margin-right: 6px; accent-color: var(--accent-primary); }
/* TOC hover */
.md-toc div:hover { color: var(--accent-secondary); }
.toc-entry { transition: color 0.15s; }
.toc-entry.toc-active { color: var(--accent-secondary) !important; font-weight: 600; }
/* External links in markdown open in new tab */
.markdown-body a[href^="http"] { target: "_blank"; rel: "noopener noreferrer"; }
.markdown-body pre code { background: none; padding: 0; }
/* Override hljs colors for light mode to use softer background */
[data-theme="light"] .hljs { background: var(--bg-tertiary); color: #24292e; }
[data-theme="light"] .hljs-comment,[data-theme="light"] .hljs-quote { color: #6a737d; }
[data-theme="light"] .hljs-keyword,[data-theme="light"] .hljs-selector-tag { color: #d73a49; }
[data-theme="light"] .hljs-string,[data-theme="light"] .hljs-attr { color: #032f62; }
[data-theme="light"] .hljs-number,[data-theme="light"] .hljs-literal { color: #005cc5; }
[data-theme="light"] .hljs-title,[data-theme="light"] .hljs-section { color: #6f42c1; }
[data-theme="light"] .hljs-type,[data-theme="light"] .hljs-class { color: #22863a; }
/* Mobile lightbox nav buttons: larger touch targets */
@media (max-width: 500px) {
  #imgNavPrev, #imgNavNext {
    width: 52px !important;
    height: 52px !important;
    font-size: 26px !important;
  }
}
</style>
</head>
<body>
<!-- Offline Banner -->
<div id="offlineBanner" style="display:none;position:sticky;top:0;z-index:9999;background:var(--warning-bg,#fbbf24);color:var(--warning-fg,#1a1a1a);padding:8px 16px;text-align:center;font-size:13px;font-weight:500;">
  📡 网络已断开，部分功能暂不可用
</div>
<div class="container">
  <header>
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <div>
        <h1>ShareTool<span class="conn-status"><span class="conn-dot" id="connDot"></span><span id="connText">' + T('ui.connecting') + '</span></span></h1>
        <p class="subtitle">' + T('ui.heroTitle').replace('文件/文字', ' / ') + '</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="menuToggle" onclick="toggleMobileMenu()" style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;padding:8px 10px;cursor:pointer;color:var(--text-primary);font-size:18px;line-height:1;" title="Menu">☰</button>
        <button id="themeToggle" onclick="toggleThemeDropdown()" style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 8px 12px; cursor: pointer; color: var(--text-primary); font-size: 18px;" title="' + T('ui.toggleTheme') + '">🌙</button>
      </div>
      <div id="themeDropdown" style="display:none;position:absolute;top:56px;right:16px;z-index:1000;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:12px;padding:12px;min-width:200px;box-shadow:0 8px 24px rgba(0,0,0,0.3);">
        <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary);">主题模式</div>
        <div style="display:flex;gap:6px;margin-bottom:12px;">
          <button id="themeBtn_light" onclick="setTheme('light');closeThemeDropdown();" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;font-size:12px;">☀️ 浅色</button>
          <button id="themeBtn_dark" onclick="setTheme('dark');closeThemeDropdown();" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;font-size:12px;">🌙 深色</button>
          <button id="themeBtn_system" onclick="setTheme('system');closeThemeDropdown();" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;font-size:12px;">🖥️ 自动</button>
        </div>
        <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary);">强调色</div>
        <div id="accentColorPicker" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;"></div>
        <input type="color" id="customAccentColor" value="#667eea" onchange="applyAccentColor(this.value)" style="width:100%;height:32px;border:none;border-radius:6px;cursor:pointer;background:var(--bg-tertiary);">
      </div>
    </div>
    <div class="status-bar">
      <span class="status-item disconnected" id="wsStatus">' + T('ui.wsDisconnected') + '</span>
      <span class="storage-text" id="storageText">' + T('ui.loading') + '</span>
      <span class="status-item disconnected" id="syncStatus">' + T('ui.syncOffline') + '</span>
      <span class="status-item" id="deviceCount">' + T('ui.devices') + ': 0</span>
    </div>
  </header>

  <div class="hero">
    <div class="hero-content">
      <div class="hero-text">
        <div class="hero-title">📡 ' + T('ui.heroTitle') + '</div>
        <div class="hero-desc">' + T('ui.heroDesc') + '</div>
        <div class="hero-features">
          <span class="hero-feature">📝 ' + T('ui.textShare') + '</span>
          <span class="hero-feature">📁 ' + T('ui.fileUpload') + '</span>
          <span class="hero-feature">🔄 ' + T('ui.multiDeviceSync') + '</span>
          <span class="hero-feature">🔍 ' + T('ui.searchFilter') + '</span>
          <span class="hero-feature">📱 ' + T('ui.mobileAdapt') + '</span>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="section-title">' + T('ui.textShare') + '</div>
    <div id="textAlert" class="alert"></div>
    <textarea id="textContent" placeholder="' + T('ui.textareaPlaceholder') + '"></textarea>
    <div class="paste-hint" id="pasteHint">📋 ' + T('ui.pasteHint') + '</div>
    <div class="actions">
      <button class="btn" id="shareTextBtn">' + T('ui.share') + '</button>
      <button class="btn btn-secondary" id="clearTextBtn">' + T('ui.clear') + '</button>
    </div>
    <div class="upload-progress-bar" id="uploadProgressBar">
      <div class="upload-progress-fill" id="uploadProgressFill" style="width:0%"></div>
    </div>
    <div class="upload-queue" id="uploadQueue"></div>
    <div class="share-link-box" id="shareLinkBox" style="display:none;">
      <input type="text" id="shareLinkInput" readonly>
      <button onclick="copyShareLink()">' + T('ui.copyLink') + '</button>
      <button onclick="showShareQRModal()">📷 ' + T('ui.qrCode') + '</button>
    </div>
    <div class="qr-modal-overlay" id="qrModal" onclick="if(event.target===this)closeShareQRModal()">
      <div style="background:var(--bg-primary);border-radius:16px;padding:24px;max-width:360px;width:90%;text-align:center;">
        <div style="font-size:18px;font-weight:600;margin-bottom:16px;">' + T('ui.shareQR') + '</div>
        <div id="qrModalContent" style="display:flex;justify-content:center;margin-bottom:16px;"></div>
        <div id="qrModalUrl" style="font-size:11px;color:var(--text-muted);word-break:break-all;margin-bottom:16px;font-family:monospace;"></div>
        <button class="btn" onclick="closeShareQRModal()" style="width:100%;">' + T('ui.close') + '</button>
      </div>
    </div>

    <div class="qr-modal-overlay" id="versionsModal" onclick="if(event.target===this)closeVersionsModal()">
      <div style="background:var(--bg-primary);border-radius:16px;padding:24px;max-width:560px;width:90%;max-height:80vh;overflow-y:auto;text-align:left;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div style="font-size:18px;font-weight:600;" id="versionsModalTitle">' + T('ver.history') + '</div>
          <button class="btn btn-sm" onclick="closeVersionsModal()">✕</button>
        </div>
        <div id="versionsContent" style="font-size:13px;"></div>
      </div>
    </div>

    <div class="qr-modal-overlay" id="trashModal" onclick="if(event.target===this)closeTrashModal()">
      <div style="background:var(--bg-primary);border-radius:16px;padding:24px;max-width:560px;width:90%;max-height:80vh;overflow-y:auto;text-align:left;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div style="font-size:18px;font-weight:600;">' + T('ui.trashEmptyTitle') + '</div>
          <button class="btn btn-sm" onclick="closeTrashModal()">✕</button>
        </div>
        <div id="trashContent" style="font-size:13px;"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="section-title">' + T('ui.fileUpload') + '</div>
    <div id="uploadAlert" class="alert"></div>
    <div class="drop-zone" id="dropZone">
      <div class="drop-zone-icon">📂</div>
      <div>' + T('ui.dragDropHint') + '</div>
      <div style="font-size:12px;margin-top:4px;">' + T('ui.orUseButtons') + '</div>
    </div>

    <label class="file-upload-area">
      <input type="file" id="fileInput" multiple webkitdirectory>
      <div class="icon">📁</div>
      <div class="text">' + T('ui.clickOrDrag') + '</div>
      <div class="hint">' + T('ui.supportFolderUpload') + '</div>
    </label>
    <div id="uploadList" class="file-list"></div>
  </div>

  <div class="card">
    <div class="section-title">🔗 ' + T('ui.remoteUpload') + '</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <input type="text" id="remoteUrlInput" placeholder="https://example.com/file.zip" style="flex:1;min-width:200px;padding:8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
      <input type="text" id="remoteFilenameInput" placeholder="保存为（可选）" style="width:160px;padding:8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">
      <button class="btn btn-sm" onclick="doRemoteUpload()">⬇️ ' + T('ui.download') + '</button>
    </div>
    <div id="remoteUploadStatus" style="font-size:12px;margin-top:6px;min-height:18px;"></div>
  </div>

  <div class="card">
    <div class="section-title">' + T('ui.recentShares') + '</div>
    <div id="listAlert" class="alert"></div>
    <button class="fav-filter-btn" id="favFilterBtn" onclick="toggleFavFilter()">☆ ' + T('fav.favorite') + '</button>
    <button class="fav-filter-btn" onclick="showFavoritesManager()">☰ ' + T('fav.favorites') + '</button>
    <button class="fav-filter-btn" onclick="showTrashModal()">🗑 ' + T('ui.trash') + '</button>

    <div class="recent-searches" id="recentSearches" style="display:none;"></div>
    <div class="search-wrapper">
    <div class="search-bar">
      <input type="search" id="searchInput" placeholder="' + T('ui.searchPlaceholder') + '" autocomplete="off" onkeydown="if(event.key==='Enter'){event.preventDefault();doSearch()}" onfocus="showSearchHint()" onblur="setTimeout(hideSearchHint,200)">
      <button class="btn btn-sm" onclick="doSearch()">' + T('ui.search') + '</button>
      <button class="btn btn-sm btn-secondary" id="clearSearchBtn" onclick="clearSearch()" style="display:none;">×</button>
    </div>
    <div id="searchHint" style="display:none;font-size:11px;color:var(--text-muted);padding:2px 8px 6px;line-height:1.4;">
      <span style="color:var(--accent-primary);cursor:pointer;" onclick="insertSearchFilter('tag:')">tag:</span> tag &nbsp;
      <span style="color:var(--accent-primary);cursor:pointer;" onclick="insertSearchFilter('size:>1m')">size:</span> &gt;1m &nbsp;
      <span style="color:var(--accent-primary);cursor:pointer;" onclick="insertSearchFilter('date:>yesterday')">date:</span> &gt;date &nbsp;
      <span style="color:var(--accent-primary);cursor:pointer;" onclick="insertSearchFilter('type:pdf')">type:</span> pdf &nbsp;
      <span style="color:var(--accent-primary);cursor:pointer;" onclick="insertSearchFilter('content:')">content:</span> text &nbsp;
      <span style="color:var(--text-muted);">ext:</span> jpg
    </div>
    <div class="search-suggestions" id="searchSuggestions" style="display:none;"></div>
    </div>
    <div class="filter-tabs">
      <span class="filter-tab active" data-filter="all">' + T('ui.filterAll') + '</span>
      <span class="filter-tab" data-filter="starred">' + T('ui.filterStarred') + '</span>
      <span class="filter-tab" data-filter="text">' + T('ui.filterText') + '</span>
      <span class="filter-tab" data-filter="file">' + T('ui.filterFile') + '</span>
    </div>
    <div class="batch-bar" id="batchBar">
      <input type="checkbox" id="selectAllBatch" onchange="toggleSelectAll(this.checked)" style="width:18px;height:18px;cursor:pointer;">
      <span class="batch-count" id="batchCount">' + T('ui.selectedN').replace('{n}', '0') + '</span>
      <span class="batch-status" id="batchStatus"><span class="spinner"></span><span id="batchStatusText"></span></span>
      <div id="batchProgressBar" style="display:none;width:100px;height:6px;background:var(--border-color);border-radius:3px;overflow:hidden;flex-shrink:0;">
        <div id="batchProgressFill" style="height:100%;background:var(--accent-primary);width:0%;transition:width 0.1s;"></div>
      </div>
      <button onclick="batchDownload()">📦 ' + T('ui.batchDownload') + '</button>
      <button onclick="batchAddTagViaModal()">🏷 ' + T('ui.batchTag') + '</button>
      <button onclick="batchRemoveTag()">🏷✕ ' + T('ui.batchRemoveTag') + '</button>
      <button onclick="batchStar()">⭐ ' + T('ui.batchStar') + '</button>
      <button onclick="batchCopy()">📋 ' + T('ui.batchCopy') + '</button>
      <button onclick="batchCreateShare()">🔗 ' + T('share.create') + '</button>
      <button onclick="batchMove()">📁 ' + T('ui.batchMove') + '</button>
      <button onclick="showBatchRenameModal()">✏️ ' + T('ui.batchRename') + '</button>
      <button class="danger" onclick="batchDelete()">🗑 ' + T('ui.batchDelete') + '</button>
      <button class="danger" onclick="clearBatch()">✕ ' + T('ui.batchCancel') + '</button>
    </div>

    <div class="filter-tabs" id="tagFilterBar" style="margin-top:4px;">
      <!-- Dynamic tags will be injected here -->
    </div>
    <div id="breadcrumbBar" style="display:none;padding:6px 0;font-size:12px;margin-bottom:4px;"></div>
    <div class="sort-bar">
      <span>' + T('ui.sortBy') + ':</span>
      <select id="sortSelect" onchange="changeSort(this.value)" style="padding:4px 8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-secondary);color:var(--text-primary);font-size:16px;">
        <option value="manual">' + T('ui.sortManual') + '</option>
        <option value="time_desc">' + T('ui.sortNewest') + ' ▼</option>
        <option value="time_asc">' + T('ui.sortOldest') + ' ▲</option>
        <option value="name_asc">' + T('ui.sortNameAZ') + ' A→Z</option>
        <option value="name_desc">' + T('ui.sortNameZA') + ' Z→A</option>
        <option value="size_desc">' + T('ui.sortLargest') + ' ▼</option>
        <option value="size_asc">' + T('ui.sortSmallest') + ' ▲</option>
        <option value="type_asc">' + T('ui.sortTypeAZ') + ' A→Z</option>
        <option value="type_desc">' + T('ui.sortTypeZA') + ' Z→A</option>
        <option value="tag_asc">' + T('ui.sortTagAZ') + '</option>
        <option value="tag_desc">' + T('ui.sortTagZA') + '</option>
        <option value="download_desc">🔥 ' + T('ui.sortMostDownloaded') + '</option>
        <option value="download_asc">💤 ' + T('ui.sortLeastDownloaded') + '</option>
      </select>
      <span id="fileCount" style="margin-left:auto;"></span>
      <span id="searchResultCount" style="display:none;color:var(--accent-primary);font-weight:500;margin-left:8px;"></span>
      <button id="exportSearchBtn" class="btn btn-sm btn-secondary" style="display:none;margin-left:4px;" onclick="exportSearchResults()">📥 导出</button>
      <div class="view-toggle">
        <button class="active" id="listViewBtn" onclick="setView('list')" title="' + T('ui.listView') + '">☰</button>
        <button id="gridViewBtn" onclick="setView('grid')" title="' + T('ui.gridView') + '">▦</button>
      </div>
    </div>
    <div class="batch-actions">
      <button class="btn btn-sm btn-warning" onclick="deleteOld(7)">' + T('ui.delete1Week') + '</button>
      <button class="btn btn-sm btn-warning" onclick="deleteOld(30)">' + T('ui.delete1Month') + '</button>
      <button class="btn btn-sm btn-danger" onclick="deleteAll()">' + T('ui.deleteAll') + '</button>
      <button class="btn btn-sm" onclick="batchDownload()" id="batchDownloadBtn" style="display:none;">' + T('ui.batchDownload') + ' ( (<span id="batchCountDL">0</span>)</button>
    </div>
    <div class="setting-row">
      <label>' + T('ui.downloadDir') + ':</label>
      <input type="text" id="downloadDir" value="">
      <button class="btn btn-sm" onclick="saveDownloadDir()">' + T('ui.save') + '</button>
    </div>
    <div id="downloadProgress" style="display:none;">
      <div class="progress-bar"><div class="fill" id="progressFill" style="width:0%"></div></div>
      <div id="progressText" style="font-size:12px;color:var(--text-muted,#64748b);margin-top:4px;"></div>
    </div>
    <div id="filesContainer">
      <div class="empty" id="emptyState">
        <div class="empty-icon">📭</div>
        <div class="empty-text">' + T('ui.noFiles') + '</div>
        <div class="empty-text" style="font-size:12px;margin-top:8px;">' + T('ui.noFilesHint') + '</div>
      </div>
    </div>
    <div class="pagination" id="pagination"></div>
  </div>

  <div class="card">
    <div class="section-title">📈 Dashboard</div>
    <div id="dashboardStats" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:8px;"></div>
    <div style="margin-top:8px;">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">📅 7天活动</div>
      <div id="dashboardChart" style="display:flex;align-items:flex-end;gap:4px;height:40px;"></div>
    </div>
    <div style="margin-top:10px;">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">📂 类型分布</div>
      <div id="dashboardTypeChart" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;"></div>
    </div>
    <div style="margin-top:10px;">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">🕐 最近活动</div>
      <div id="dashboardActivityFeed" style="display:flex;flex-direction:column;gap:4px;"></div>
    </div>
  </div>

  <div class="card">
    <div class="section-title">' + T('admin.settings') + '</div>
    <div style="margin-bottom: 12px;">
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">' + T('admin.accessToken') + '</div>
      <div class="code-box" id="currentTokenDisplay" style="font-size:12px;padding:8px 12px;"></div>
      <button class="btn btn-sm" style="margin-top:8px;" onclick="showTokenModal()">' + T('admin.changeToken') + '</button>
      <button class="btn btn-sm btn-secondary" style="margin-top:8px;margin-left:4px;" onclick="refreshToken()">' + T('admin.refresh') + '</button>
    </div>
    <div style="margin-bottom: 12px;">
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">' + T('admin.https') + '</div>
      <div id="httpsStatus" style="font-size:13px;color:var(--text-muted);">' + T('admin.checking') + '</div>
      <div id="httpsRenewBtn" style="margin-top:6px;display:none;">
        <button class="btn btn-sm" onclick="manualRenewCert()">' + T('admin.renew') + '</button>
      </div>
    </div>
    <div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">📊 <span id="adminAuditLabel">' + T('admin.auditTitle').replace('📊 ', '') + '</span></div>
      <button class="btn btn-sm" onclick="showAuditModal()"><span id="adminAuditBtn">' + T('admin.viewAudit') + '</span></button>
    </div>
    <div style="margin-top:12px;">
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">🔗 <span id="adminShareLabel">' + T('share.link').replace('链接', '') + '</span></div>
      <button class="btn btn-sm" onclick="showShareLinksModal()">' + T('share.manage') + '</button>
      <button class="btn btn-sm" onclick="showTagManager()">🏷 <span id="adminTagBtn">' + T('tag.manager') + '</span></button>
    </div>
    <div style="margin-top:12px;">
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">🛡 <span id="adminRateLimitLabel">' + T('admin.rateLimit') + '</span></div>
      <div id="rateLimitStatus" style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">' + T('admin.loaded') + '</div>
      <button class="btn btn-sm" onclick="showRateLimitModal()">' + T('admin.rateLimitConfig') + '</button>
    </div>
  </div>

  <div class="card">
    <div class="section-title">' + T('device.devices') + '</div>
    <div class="device-list" id="deviceList">
      <div class="empty"><div class="empty-icon" style="font-size:32px;">📡</div><div class="empty-text">' + T('device.discovering') + '</div></div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="fileModal" onclick="if(event.target===this)closeModal()">
  <div class="modal-content">
    <div class="modal-header">
      <div class="modal-title" id="modalTitle"></div>
      <button class="modal-close" onclick="closeModal()">x</button>
    </div>
    <div class="modal-meta" id="modalMeta"></div>
    <div class="modal-body" id="modalBody"></div>
    <div class="modal-footer" id="modalFooter" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border-color);"></div>
    <div class="kbd-hint"><span class="kbd">Esc</span> close</div>
  </div>
</div>

<div class="notif-badge" id="notifBadge"></div>
<div id="toast" class="toast"></div>

<div class="ctx-backdrop" id="ctxBackdrop" onclick="hideContextMenu()"></div>
<div id="contextMenu"></div>

<div class="modal-overlay" id="auditModal" onclick="if(event.target===this)closeAuditModal()">
  <div class="modal-content" style="max-width:800px;max-height:85vh;overflow:auto;">
    <div class="modal-header">
      <div class="modal-title">📊 <span id="auditModalTitle">' + T('admin.auditTitle') + '</span></div>
      <button class="modal-close" onclick="closeAuditModal()">x</button>
    </div>
    <div id="auditStats" style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;"></div>
    <!-- Action breakdown chart -->
    <div id="auditChart" style="margin-bottom:16px;display:none;">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-weight:500;">' + T('admin.actionBreakdown') + '</div>
      <div id="auditChartBars" style="display:flex;flex-direction:column;gap:6px;"></div>
    </div>
    <!-- Filters -->
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center;">
      <select id="auditFilterAction" onchange="showAuditModal()" style="padding:6px 10px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);font-size:16px;max-width:160px;">
        <option value="">' + T('ui.all') + '</option>
      </select>
      <input type="date" id="auditFilterDate" onchange="showAuditModal()" style="padding:6px 8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);font-size:16px;">
      <button class="btn btn-sm" onclick="exportAudit('csv')">📥 CSV</button>
      <button class="btn btn-sm" onclick="exportAudit('json')">📥 JSON</button>
    </div>
    <div id="auditLogList" style="font-size:12px;"></div>
  </div>
</div>

<div class="modal-overlay" id="tokenModal" onclick="if(event.target===this)closeTokenModal()">
  <div class="modal-content" style="max-width:400px;">
    <div class="modal-header">
      <div class="modal-title">🔐 <span id="tokenModalTitle">' + T('admin.changeToken') + '</span></div>
      <button class="modal-close" onclick="closeTokenModal()">x</button>
    </div>
    <div style="padding:8px 0;">
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:6px;">' + T('admin.accessToken') + ' (' + T('admin.none') + '):</div>
      <input type="text" id="newTokenInput" placeholder="' + T('admin.opts') + '" style="width:100%;padding:10px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;font-family:monospace;">
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button class="btn" onclick="doSetToken()" style="flex:1;">' + T('msg.confirm') + '</button>
        <button class="btn btn-secondary" onclick="closeTokenModal()">' + T('msg.cancel') + '</button>
      </div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="shareOptionsModal" onclick="if(event.target===this)closeShareOptionsModal()">
  <div class="modal-content" style="max-width:400px;">
    <div class="modal-header">
      <div class="modal-title">🔗 <span id="shareOptionsTitle">' + T('share.create') + '</span></div>
      <button class="modal-close" onclick="closeShareOptionsModal()">x</button>
    </div>
    <div style="padding:8px 0;">
      <input type="hidden" id="shareOptionsFilename">
      <div id="shareOptionsFileName" style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;padding:8px;background:var(--bg-tertiary);border-radius:8px;word-break:break-all;"></div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">' + T('share.lifetime') + '</div>
        <select id="shareExpiryHours" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;">
          <option value="24">' + T('share.24h') + '</option>
          <option value="72">' + T('share.3days') + '</option>
          <option value="168" selected>' + T('share.7days') + '</option>
          <option value="720">' + T('share.30days') + '</option>
          <option value="0">' + T('share.never') + '</option>
        </select>
      </div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">' + T('share.downloadLimit') + '</div>
        <input type="number" id="shareMaxDownloads" placeholder="' + T('admin.none') + '" min="1" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;">
      </div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">' + T('share.passwordOptional') + '</div>
        <input type="password" id="sharePassword" placeholder="' + T('share.noPassword') + '" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;" oninput="updatePasswordStrength(this.value)">
        <div id="sharePasswordStrength" style="font-size:11px;margin-top:4px;height:16px;color:var(--text-muted);"></div>
      </div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">' + T('share.description') + '</div>
        <input type="text" id="shareDescription" placeholder="' + T('share.descriptionPlaceholder') + '" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;">
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn" onclick="doCreateShareLink()" style="flex:1;">' + T('share.create') + '</button>
        <button class="btn btn-secondary" onclick="closeShareOptionsModal()">' + T('msg.cancel') + '</button>
      </div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="shareLinksModal" onclick="if(event.target===this)closeShareLinksModal()">
  <div class="modal-content" style="max-width:600px;max-height:80vh;overflow:auto;">
    <div class="modal-header">
      <div class="modal-title">🔗 <span id="shareLinksTitle">' + T('share.manage') + '</span></div>
      <button id="btnDeleteExpiredShares" class="btn btn-sm" style="font-size:11px;padding:4px 8px;" onclick="deleteExpiredShares()">' + T('share.deleteExpired') + '</button>
      <button class="modal-close" onclick="closeShareLinksModal()">x</button>
    </div>
    <div id="shareLinksList" style="padding:8px 0;"></div>
  </div>
</div>

<div class="modal-overlay" id="editShareLinkModal" onclick="if(event.target===this)closeEditShareLinkModal()">
  <div class="modal-content" style="max-width:400px;">
    <div class="modal-header">
      <div class="modal-title">✏️ ' + T('share.editLink') + '</div>
      <button class="modal-close" onclick="closeEditShareLinkModal()">x</button>
    </div>
    <div style="padding:8px 0;">
      <input type="hidden" id="editShareCode">
      <div id="editShareFilename" style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;padding:8px;background:var(--bg-tertiary);border-radius:8px;word-break:break-all;"></div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">' + T('share.lifetime') + '</div>
        <select id="editShareExpiryHours" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;">
          <option value="24">' + T('share.24h') + '</option>
          <option value="72">' + T('share.3days') + '</option>
          <option value="168">' + T('share.7days') + '</option>
          <option value="720">' + T('share.30days') + '</option>
          <option value="0">' + T('share.never') + '</option>
        </select>
      </div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">' + T('share.downloadLimit') + '</div>
        <input type="number" id="editShareMaxDownloads" placeholder="' + T('admin.none') + '" min="1" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;">
      </div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">' + T('share.passwordOptional') + '</div>
        <input type="password" id="editSharePassword" placeholder="' + T('share.noPassword') + '" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;">
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + T('share.leaveBlank') + '</div>
      </div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">' + T('share.description') + '</div>
        <input type="text" id="editShareDescription" placeholder="' + T('share.descriptionPlaceholder') + '" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;">
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn" onclick="doUpdateShareLink()" style="flex:1;">' + T('ui.save') + '</button>
        <button class="btn btn-secondary" onclick="closeEditShareLinkModal()">' + T('msg.cancel') + '</button>
      </div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="storageModal" onclick="if(event.target===this)closeStorageModal()">
  <div class="modal-content" style="max-width:500px;">
    <div class="modal-header">
      <div class="modal-title">📊 ' + T('admin.storage') + '</div>
      <button class="modal-close" onclick="closeStorageModal()">x</button>
    </div>
    <div id="storageModalBody" style="padding:8px 0;"></div>
  </div>
</div>

<div class="modal-overlay" id="devicesModal" onclick="if(event.target===this)closeDevicesModal()">
  <div class="modal-content" style="max-width:500px;">
    <div class="modal-header">
      <div class="modal-title">📱 ' + T('ui.devices') + '</div>
      <button class="modal-close" onclick="closeDevicesModal()">x</button>
    </div>
    <div id="devicesModalBody" style="padding:8px 0;"></div>
  </div>
</div>

<div class="modal-overlay" id="tagsModal" onclick="if(event.target===this)closeTagsModal()">
  <div class="modal-content" style="max-width:600px;">
    <div class="modal-header">
      <div class="modal-title">🏷️ ' + T('file.tags') + '</div>
      <button class="modal-close" onclick="closeTagsModal()">x</button>
    </div>
    <div style="padding:0 16px 12px;display:flex;gap:8px;align-items:center;">
      <input type="text" id="tagsModalSearch" placeholder="' + T('ui.searchPlaceholder') + '" oninput="filterTagsModal(this.value)"
        style="flex:1;padding:8px 12px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:14px;">
      <select id="tagsModalSort" onchange="sortTagsModal(this.value)"
        style="padding:8px 12px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;min-height:44px;">
        <option value="count">' + T('sort.byCount') + '</option>
        <option value="recent">' + T('sort.byRecent') + '</option>
        <option value="alpha">' + T('sort.alpha') + '</option>
        <option value="color">' + T('sort.byColor') + '</option>
      </select>
    </div>
    <div id="tagsModalBody" style="padding:0 16px 16px;max-height:400px;overflow-y:auto;"></div>
  </div>
</div>

<div class="modal-overlay" id="backupModal" onclick="if(event.target===this)closeBackupModal()">
  <div class="modal-content" style="max-width:500px;">
    <div class="modal-header">
      <div class="modal-title">💾 ' + T('admin.backup') + '</div>
      <button class="modal-close" onclick="closeBackupModal()">x</button>
    </div>
    <div id="backupModalBody" style="padding:8px 0;"></div>
  </div>
</div>

<div class="modal-overlay" id="aboutModal" onclick="if(event.target===this)closeAboutModal()">
  <div class="modal-content" style="max-width:420px;">
    <div class="modal-header">
      <div class="modal-title">ℹ️ ' + T('about.about') + '</div>
      <button class="modal-close" onclick="closeAboutModal()">x</button>
    </div>
    <div style="padding:16px 0;text-align:center;">
      <div style="font-size:48px;margin-bottom:12px;">📡</div>
      <h2 style="margin:0 0 8px;">ShareTool</h2>
      <p style="color:var(--text-muted);margin:0 0 16px;">v3.85</p>
      <p style="font-size:13px;color:var(--text-secondary);">' + T('about.desc') + '</p>
    </div>
    <div id="aboutSystemStats" style="padding:0 16px 16px;font-size:12px;color:var(--text-muted)"></div>
  </div>
</div>

<div class="modal-overlay" id="shortcutModal" onclick="if(event.target===this)closeShortcutModal()">
  <div class="modal-content" style="max-width:400px;">
    <div class="modal-header">
      <div class="modal-title">⌨️ Keyboard Shortcuts</div>
      <button class="modal-close" onclick="closeShortcutModal()">x</button>
    </div>
    <div class="shortcut-list">
      <span class="shortcut-key">j / k</span><span class="shortcut-desc">' + T('ui.shortcutMoveFocus') + '</span>
      <span class="shortcut-key">Enter</span><span class="shortcut-desc">' + T('ui.shortcutOpenFocused') + '</span>
      <span class="shortcut-key">x</span><span class="shortcut-desc">' + T('ui.shortcutToggleSelect') + '</span>
      <span class="shortcut-key">v</span><span class="shortcut-desc">切换网格/列表视图</span>
      <span class="shortcut-key">t</span><span class="shortcut-desc">' + T('ui.shortcutTagSelected') + '</span>
      <span class="shortcut-key">a</span><span class="shortcut-desc">' + T('ui.shortcutSelectAll') + '</span>
      <span class="shortcut-key">s</span><span class="shortcut-desc">' + T('ui.shortcutStarFocused') + '</span>
      <span class="shortcut-key">c</span><span class="shortcut-desc">' + T('ui.shortcutCopyLink') + '</span>
      <span class="shortcut-key">n</span><span class="shortcut-desc">' + T('ui.shortcutNewUpload') + '</span>
      <span class="shortcut-key">m</span><span class="shortcut-desc">' + T('ui.shortcutTextNote') + '</span>
      <span class="shortcut-key">g</span><span class="shortcut-desc">' + T('ui.shortcutGoRoot') + '</span>
      <span class="shortcut-key">Delete</span><span class="shortcut-desc">' + T('ui.shortcutDeleteFocused') + '</span>
      <span class="shortcut-key">f</span><span class="shortcut-desc">' + T('ui.shortcutToggleFav') + '</span>
      <span class="shortcut-key">r</span><span class="shortcut-desc">' + T('ui.shortcutRefresh') + '</span>
      <span class="shortcut-key">/</span><span class="shortcut-desc">' + T('ui.shortcutSearch') + '</span>
      <span class="shortcut-key">Esc</span><span class="shortcut-desc">' + T('ui.shortcutClose') + '</span>
      <span class="shortcut-key">← →</span><span class="shortcut-desc">' + T('ui.shortcutImageNav') + '</span>
      <span class="shortcut-key">?</span><span class="shortcut-desc">' + T('ui.shortcutHelp') + '</span>
    </div>
  </div>
</div>

<div class="modal-overlay" id="tagManagerModal" onclick="if(event.target===this)closeTagManager()">
  <div class="modal-content" style="max-width:480px;max-height:80vh;overflow:auto;">
    <div class="modal-header">
      <div class="modal-title">' + T('tag.manager') + '</div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-sm" onclick="showTagMergeUI()" style="font-size:11px;padding:4px 10px;">' + T('tag.merge') + '</button>
        <button class="modal-close" onclick="closeTagManager()">x</button>
      </div>
    </div>
    <input type="text" id="tagManagerSearch" placeholder="' + T('ui.searchTags') + '" style="width:100%;padding:8px 12px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;min-height:44px;margin-bottom:8px;box-sizing:border-box;" oninput="filterTagManagerList(this.value)">
    <div id="tagBatchBar" style="display:none;background:var(--accent-primary);border-radius:8px;padding:8px 12px;margin-bottom:8px;align-items:center;gap:8px;justify-content:space-between;">
      <span style="font-size:12px;color:white;"></span>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-sm" onclick="openBatchColorPicker()" style="background:rgba(255,255,255,0.2);color:white;border:none;font-size:11px;padding:4px 8px;min-height:32px;">🎨 ' + T('tag.changeColor') + '</button>
        <button class="btn btn-sm btn-danger" onclick="batchDeleteTags()" style="font-size:11px;padding:4px 8px;min-height:32px;">🗑 ' + T('tag.delete') + '</button>
      </div>
    </div>
    <div id="tagMergeUI" style="display:none;background:var(--bg-tertiary);border-radius:8px;padding:12px;margin-bottom:8px;">
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">' + T('tag.mergeHint') + '</div>
      <div id="tagMergeSourceList" style="display:flex;flex-direction:column;gap:6px;max-height:160px;overflow-y:auto;margin-bottom:12px;"></div>
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">' + T('tag.mergeTarget') + '</div>
      <select id="tagMergeTarget" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);font-size:16px;min-height:44px;margin-bottom:10px;box-sizing:border-box;"></select>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-sm btn-secondary" onclick="hideTagMergeUI()">' + T('ui.cancel') + '</button>
        <button class="btn btn-sm" onclick="executeTagMerge()" style="background:var(--accent-primary);color:white;">' + T('tag.mergeConfirm') + '</button>
      </div>
    </div>
    <div id="tagManagerList" style="display:flex;flex-direction:column;gap:8px;"></div>
  </div>
</div>

<!-- Tag Input Modal (mobile-friendly alternative to prompt()) -->
<div class="modal-overlay" id="tagInputModal" onclick="if(event.target===this)closeTagInputModal()">
  <div class="modal-content" style="max-width:400px;max-height:80vh;overflow:auto;">
    <div class="modal-header">
      <div class="modal-title">🏷 <span id="tagInputModalTitle">' + T('file.addTag') + '</span></div>
      <button class="modal-close" onclick="closeTagInputModal()">x</button>
    </div>
    <div style="padding:8px 0;">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;" id="tagInputFileName"></div>
      <!-- Existing tags as removable chips -->
      <div id="tagInputExisting" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;"></div>
      <!-- New tags input -->
      <input type="text" id="tagInputField" placeholder="' + T('tag.inputHint') + '" style="width:100%;padding:12px 14px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;box-sizing:border-box;" autocomplete="off">
      <!-- Tag autocomplete suggestions -->
      <div id="tagInputSuggestions" style="display:none;max-height:120px;overflow-y:auto;border:1px solid var(--border-color);border-radius:8px;margin-top:4px;background:var(--bg-secondary);"></div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + T('tag.inputHint') + '</div>
      <!-- Color picker for new tags -->
      <div style="margin-top:12px;display:flex;align-items:center;gap:8px;">
        <span style="font-size:12px;color:var(--text-muted);">' + T('tag.color') + ':</span>
        <div id="tagInputColorPicker" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;">
        <button class="btn" style="flex:1;" onclick="confirmTagInput()">' + T('ui.save') + '</button>
        <button class="btn btn-secondary" style="flex:1;" onclick="closeTagInputModal()">' + T('ui.cancel') + '</button>
      </div>
    </div>
  </div>
</div>

<!-- Batch Tag Modal -->
<div class="modal-overlay" id="batchTagModal" onclick="if(event.target===this)closeBatchTagModal()">
  <div class="modal-content" style="max-width:440px;max-height:80vh;overflow:auto;">
    <div class="modal-header">
      <div class="modal-title">🏷 <span id="batchTagModalTitle">批量标签</span></div>
      <button class="modal-close" onclick="closeBatchTagModal()">x</button>
    </div>
    <div style="padding:8px 0;">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;" id="batchTagFileCount"></div>
      <div id="batchTagExisting" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;"></div>
      <input type="text" id="batchTagInputField" placeholder="输入标签后按回车" style="width:100%;padding:12px 14px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;box-sizing:border-box;" autocomplete="off">
      <div id="batchTagSuggestions" style="display:none;max-height:120px;overflow-y:auto;border:1px solid var(--border-color);border-radius:8px;margin-top:4px;background:var(--bg-secondary);"></div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">输入后按 Enter 添加 · 点击已有标签可移除</div>
      <div style="margin-top:16px;display:flex;gap:8px;">
        <button class="btn" style="flex:1;" onclick="confirmBatchTagInput()">保存</button>
        <button class="btn btn-secondary" style="flex:1;" onclick="closeBatchTagModal()">取消</button>
      </div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="emojiModal" onclick="if(event.target===this)closeEmojiModal()">
  <div class="modal-content" style="max-width:360px;max-height:80vh;overflow:auto;">
    <div class="modal-header">
      <div class="modal-title">⭐ <span id="emojiModalTitle">' + T('tag.changeIcon') + '</span></div>
      <button class="modal-close" onclick="closeEmojiModal()">x</button>
    </div>
    <div style="padding:8px 0;">
      <div style="text-align:center;margin-bottom:16px;">
        <div id="emojiPreview" style="font-size:48px;margin-bottom:8px;">🏷</div>
        <div style="font-size:13px;color:var(--text-muted);" id="emojiTagName"></div>
      </div>
      <!-- Emoji presets grid -->
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;justify-content:center;" id="emojiPresets"></div>
      <!-- Custom emoji input -->
      <div style="margin-bottom:16px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">Custom emoji:</div>
        <input type="text" id="emojiCustomInput" placeholder="Paste or type emoji" style="width:100%;padding:10px 12px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:24px;text-align:center;box-sizing:border-box;" oninput="updateEmojiPreview(this.value)">
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn" style="flex:1;" onclick="confirmEmojiChange()">' + T('ui.save') + '</button>
        <button class="btn btn-secondary" style="flex:1;" onclick="closeEmojiModal()">' + T('ui.cancel') + '</button>
      </div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="favoritesModal" onclick="if(event.target===this)closeFavoritesManager()">
  <div class="modal-content" style="max-width:480px;max-height:80vh;overflow:auto;">
    <div class="modal-header">
      <div class="modal-title">' + T('fav.favorites') + '</div>
      <button class="modal-close" onclick="closeFavoritesManager()">x</button>
    </div>
    <div id="favoritesManagerList" style="display:flex;flex-direction:column;gap:8px;"></div>
  </div>
</div>

<script>
const API = '';
let AUTH_TOKEN='***';
let REFRESH_TOKEN=null;  // separate refresh token (not sent as x-auth-token)
const WS_URL = 'ws://' + location.hostname + ':${WS_PORT}';
const DEVICE_ID = '${DEVICE_ID}';
const DEVICE_NAME = navigator.platform || 'Unknown';

// Configure marked for safe rendering (marked@9+ API, mangle/headerIds removed in v5+)
if (typeof marked !== 'undefined') {
  marked.use({ breaks: true, gfm: true });
}

let ws = null;
let currentFiles = [];
let config = {};
let currentFilter = 'all';
let currentFolder = null;  // null = root, 'work/docs' = inside folder
let reconnectTimer = null;
let reconnectDelay = 1000;
let isConnected = false;
let currentSort = 'time_desc';
let currentPage = 1;
let currentView = localStorage.getItem('sharetool_view') || 'list';
const PAGE_SIZE = 20;
let showFavoritesOnly = false;
let focusedFileIndex = -1;   // keyboard-navigated file focus
const lastSyncTs = parseInt(localStorage.getItem('sharetool_last_sync') || '0');
const offlineQueue = JSON.parse(localStorage.getItem('sharetool_offline_queue') || '[]');
const TAG_COLOR_PRESETS = ['#667eea','#f59e0b','#10b981','#ef4444','#3b82f6','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316'];
let tagColors = {};  // { tagName: color } from server
let tagEmojis = {};  // { tagName: emoji } from server

// PWA: Register Service Worker
let deferredPrompt = null;
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      logger.info('[SW] registered', reg.scope);
    }).catch(err => {
      logger.info('[SW] registration failed:', err);
    });
    // Restore saved accent color
    const savedAccent = localStorage.getItem('sharetool_accent');
    if (savedAccent) {
      document.documentElement.style.setProperty('--accent-primary', savedAccent);
      const r = parseInt(savedAccent.slice(1,3),16), g = parseInt(savedAccent.slice(3,5),16), b = parseInt(savedAccent.slice(5,7),16);
      const secondary = '#' + [Math.min(r+30,255), Math.min(g+20,255), Math.min(b+40,255)].map(v => v.toString(16).padStart(2,'0')).join('');
      document.documentElement.style.setProperty('--accent-secondary', secondary);
    }
  });
}

// Browser online/offline awareness
window.addEventListener('online', () => {
  const banner = document.getElementById('offlineBanner');
  if (banner) banner.style.display = 'none';
  logger.info('[Network] Online');
});

window.addEventListener('offline', () => {
  const banner = document.getElementById('offlineBanner');
  if (banner) banner.style.display = 'flex';
  const syncStatusEl = document.getElementById('syncStatus');
  if (syncStatusEl) { syncStatusEl.className = 'status-item disconnected'; syncStatusEl.textContent = T('ui.syncOffline'); }
  logger.info('[Network] Offline');
});

// PWA Install Prompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  // Show install prompt if not already installed
  if (!window.matchMedia('(display-mode: standalone)').matches) {
    const prompt = document.getElementById('pwaInstallPrompt');
    if (prompt && !localStorage.getItem('pwaInstallDismissed')) {
      prompt.style.display = 'block';
    }
  }
});

window.addEventListener('appinstalled', () => {
  const prompt = document.getElementById('pwaInstallPrompt');
  if (prompt) prompt.style.display = 'none';
  deferredPrompt = null;
});

function installPWA() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then((choice) => {
    if (choice.outcome === 'accepted') {
      logger.info('[PWA] installed');
    }
    deferredPrompt = null;
  });
}

function dismissPWAInstall() {
  const prompt = document.getElementById('pwaInstallPrompt');
  if (prompt) prompt.style.display = 'none';
  localStorage.setItem('pwaInstallDismissed', Date.now());
}

function toggleMobileMenu() {
  const overlay = document.getElementById('mobileMenuOverlay');
  const drawer = document.getElementById('mobileMenuDrawer');
  if (!overlay || !drawer) return;
  const isOpen = overlay.style.display !== 'none';
  if (isOpen) {
    drawer.style.transform = 'translateY(100%)';
    overlay.style.display = 'none';
  } else {
    overlay.style.display = 'block';
    // Force reflow for transition
    drawer.offsetHeight;
    drawer.style.transform = 'translateY(0)';
  }
}

function toggleFavFilter() {
  showFavoritesOnly = !showFavoritesOnly;
  const btn = document.getElementById('favFilterBtn');
  if (btn) {
    btn.classList.toggle('active', showFavoritesOnly);
    btn.innerHTML = showFavoritesOnly ? '★ ' + T('fav.favorite') : '☆ ' + T('fav.favorite');
  }
  currentPage = 1;
  renderFiles();
  if (window.currentSearchQ) applySearchHighlight(window.currentSearchQ);
}

function applyFavoritesFilter(files) {
  if (!showFavoritesOnly) return files;
  const favs = getFavorites();
  return files.filter(f => favs.includes(f.name));
}

function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

// 冲突解决弹窗
function showConflictDialog(conflict) {
  const { action, filename, localHash, remoteHash, localTs, remoteTs } = conflict;
  const localTime = localTs ? new Date(localTs * 1000).toLocaleString() : T('ui.unknown');
  const remoteTime = remoteTs ? new Date(remoteTs * 1000).toLocaleString() : T('ui.unknown');
  const escapedName = escapeHtml(filename);
  const localHashDisplay = localHash ? localHash.substring(0, 12) + '...' : 'N/A';
  const remoteHashDisplay = remoteHash ? remoteHash.substring(0, 12) + '...' : 'N/A';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = '<div style="background:var(--bg-secondary);border-radius:16px;padding:28px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);border:1px solid var(--border-color);">' +
    '<div style="font-size:20px;font-weight:600;margin-bottom:8px;">⚠️ ' + T('sync.fileConflict') + '</div>' +
    '<div style="color:var(--text-muted);margin-bottom:16px;font-size:13px;">' + T('sync.conflictDesc', null, {name: escapedName}) + '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">' +
      '<div style="background:var(--bg-secondary);border-radius:8px;padding:12px;">' +
        '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">' + T('sync.localVersion') + '</div>' +
        '<div style="font-size:12px;font-family:monospace;word-break:break-all;">' + localHashDisplay + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + localTime + '</div>' +
      '</div>' +
      '<div style="background:var(--bg-secondary);border-radius:8px;padding:12px;">' +
        '<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">' + T('sync.remoteVersion') + '</div>' +
        '<div style="font-size:12px;font-family:monospace;word-break:break-all;">' + remoteHashDisplay + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + remoteTime + '</div>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:8px;">' +
      '<button id="conflict_keep_local" style="padding:10px 16px;background:var(--accent-primary);color:var(--text-inverse);border:none;border-radius:8px;cursor:pointer;font-size:14px;">' + T('sync.keepLocal') + '</button>' +
      '<button id="conflict_keep_remote" style="padding:10px 16px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:8px;cursor:pointer;font-size:14px;">' + T('sync.keepRemote') + '</button>' +
      '<button id="conflict_rename_both" disabled style="padding:10px 16px;background:var(--bg-secondary);color:var(--text-muted);border:1px solid var(--border-color);border-radius:8px;cursor:not-allowed;font-size:14px;opacity:0.6;" title="' + T('sync.multiVersionNote') + '">' + T('sync.keepBoth') + '</button>' +
      '<button id="conflict_cancel" style="padding:10px 16px;background:transparent;color:var(--text-muted);border:none;cursor:pointer;font-size:13px;">' + T('sync.later') + '</button>' +
    '</div>' +
  '</div>';
  document.body.appendChild(overlay);

  overlay.querySelector('#conflict_keep_local').onclick = function() {
    wsSend('conflict_resolve', { filename: filename, resolution: 'force_local' });
    document.body.removeChild(overlay);
    showToast(T('sync.localKept'));
  };
  overlay.querySelector('#conflict_keep_remote').onclick = function() {
    wsSend('conflict_resolve', { filename: filename, resolution: 'force_remote', hash: remoteHash });
    document.body.removeChild(overlay);
    showToast(T('sync.remoteKept'));
  };
  overlay.querySelector('#conflict_cancel').onclick = function() {
    document.body.removeChild(overlay);
  };
  overlay.onclick = function(e) { if (e.target === overlay) document.body.removeChild(overlay); };
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) headers['x-auth-token'] = AUTH_TOKEN;
  return headers;
}

function getApiHeaders(method) {
  return { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' };
}

function showAlert(id, msg, type, show = true) {
  const el = document.getElementById(id);
  el.className = 'alert alert-' + type + (show ? ' show' : '');
  el.textContent = msg;
  if (show) setTimeout(() => { if (el) el.className = 'alert alert-' + type; }, 4000);
}

let _isTouchDevice = null;
function isTouchDevice() {
  if (_isTouchDevice === null) {
    _isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  }
  return _isTouchDevice;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('zh-CN');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Modal scroll lock - prevent background scroll on mobile when modal open
let _scrollPos = 0;
function lockScroll() {
  _scrollPos = window.scrollY;
  document.body.classList.add('modal-open');
  document.body.style.top = '-' + _scrollPos + 'px';
}
function unlockScroll() {
  document.body.classList.remove('modal-open');
  document.body.style.top = '';
  window.scrollTo(0, _scrollPos);
}

function btoaSafe(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(match, p1) {
    return String.fromCharCode(parseInt(p1, 16));
  }));
}

// WebSocket 连接
function connectWS() {
  try {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
    isConnected = true;
    const dot = document.getElementById('connDot');
    const txt = document.getElementById('connText');
    if (dot) dot.classList.add('connected');
    if (txt) txt.textContent = T('device.connected');
    const statusEl = document.getElementById('wsStatus');
    if (statusEl) { statusEl.className = 'status-item connected'; statusEl.textContent = T('device.wsConnected'); }

      logger.info('[WS] Connected');
      isConnected = true;
      reconnectDelay = 1000;
      updateWsStatus(true);
      startPeriodicSync(30000);
      flushOfflineQueue();
      
      ws.send(JSON.stringify({
        type: 'register',
        payload: { deviceId: DEVICE_ID, deviceName: DEVICE_NAME, lastSyncTs }
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {}
    };

    ws.onclose = () => {
    isConnected = false;
    const dot = document.getElementById('connDot');
    const txt = document.getElementById('connText');
    if (dot) dot.classList.remove('connected');
    if (txt) txt.textContent = T('device.notConnected');
    const statusEl = document.getElementById('wsStatus');
    if (statusEl) { statusEl.className = 'status-item disconnected'; statusEl.textContent = T('device.wsDisconnected'); }
    const syncStatusEl = document.getElementById('syncStatus');
    if (syncStatusEl) { syncStatusEl.className = 'status-item disconnected'; syncStatusEl.textContent = T('ui.syncOffline'); }

      logger.info('[WS] Disconnected');
      isConnected = false;
      updateWsStatus(false);
      flushOfflineQueue();
      scheduleReconnect();
    };
    
    ws.onerror = (e) => {
      logger.error({ err: e }, 'WS error');
      const syncStatusEl = document.getElementById('syncStatus');
      if (syncStatusEl) { syncStatusEl.className = 'status-item disconnected'; syncStatusEl.textContent = T('ui.syncOffline'); }
    };
  } catch (e) {
    logger.error({ err: e }, 'WS connect failed');
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    logger.info('[WS] Reconnecting...');
    connectWS();
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }, reconnectDelay);
}

function updateWsStatus(connected) {
  const el = document.getElementById('wsStatus');
  if (connected) {
    el.className = 'status-item connected';
    el.textContent = T('device.wsConnected');
  } else {
    el.className = 'status-item disconnected';
    el.textContent = T('device.wsDisconnected');
  }
}

function handleWsMessage(msg) {
  const { type, payload } = msg;
  
  switch (type) {
    case 'registered': {
      currentFiles = payload.files || [];
      renderFiles();
      renderDevices(payload.devices || []);
      document.getElementById('syncStatus').textContent = T('device.syncOnline');
      updateTagFilterBar();
      // 加载标签颜色
      loadTagColors();
      // 保存增量同步时间戳
      if (payload.sync && payload.sync.serverTs) {
        lastSyncTs = payload.sync.serverTs;
        localStorage.setItem('sharetool_last_sync', lastSyncTs);
        logger.info('[Sync] Saved lastSyncTs:', lastSyncTs);
      }
      // 显示未同步状态
      if (payload.syncStatus) {
        const { unsynced, unsyncedSize } = payload.syncStatus;
        if (unsynced > 0) {
          const sizeStr = formatSize(unsyncedSize || 0);
          document.getElementById('syncStatus').textContent = T('device.online') + ' · ' + unsynced + ' ' + T('device.syncPending') + ' (' + sizeStr + ')';
        }
      }
      // 应用增量同步变更（差异更新，避免全量刷新）
      if (payload.sync && payload.sync.changes && payload.sync.changes.length > 0) {
        applyIncrementalChanges(payload.sync.changes);
      }
      break;
    }
    case 'change':
    case 'file_create':
    case 'file_update':
    case 'file_delete':
    case 'file_rename':
    case 'file_move': {
      if (type === 'change' && payload.type === 'bulk_update') {
        loadFiles();
      } else if (type === 'change' && payload.type === 'bulk_delete') {
        loadFiles();
      } else {
        loadFiles();
      }
      // Toast notification for remote changes
      if (type === 'file_create') {
        incrementBadge();
        showToast(T('sync.newFileReceived') + ' ' + (payload.filename || '').substring(0, 30));
      } else if (type === 'file_delete') {
        showToast(T('sync.remoteDeleted'));
      } else if (type === 'file_rename') {
        showToast(T('sync.remoteRenamed') + ' ' + (payload.oldFilename || '') + ' → ' + (payload.newFilename || ''));
      } else if (type === 'file_move') {
        showToast(T('sync.remoteMoved') + ' ' + (payload.oldFilename || '') + ' → ' + (payload.newFilename || ''));
      } else if (type === 'change' && payload.type === 'create') {
        showToast(T('sync.newFileReceived') + ' ' + (payload.filename || '').substring(0, 30));
      } else if (type === 'change' && payload.type === 'rename') {
        showToast(T('sync.remoteRenamed') + ' ' + (payload.oldFilename || '') + ' → ' + (payload.newFilename || ''));
      }
      break;
    }
    case 'sync_response': {
      // 处理定时增量同步响应
      if (payload.sync && payload.sync.serverTs) {
        lastSyncTs = payload.sync.serverTs;
        localStorage.setItem('sharetool_last_sync', lastSyncTs);
      }
      if (payload.changes && payload.changes.length > 0) {
        applyIncrementalChanges(payload.changes);
        showToast(T('sync.incSync', { n: payload.changes.length }));
      }
      logger.info('[Sync] sync_response:', payload.changes ? payload.changes.length : 0, 'changes');
      break;
    }
    case 'conflict': {
      // 显示冲突弹窗
      showConflictDialog(payload);
      break;
    }
    case 'sync_ack': {
      if (payload.status === 'duplicate' || payload.status === 'kept_local') {
        logger.info('[Sync] Ack:', payload.status, payload.filename);
      } else if (payload.status === 'ok' || payload.status === 'created') {
        showToast(T('sync.syncSuccess') + ' ' + (payload.filename || ''));
      } else if (payload.status === 'renamed') {
        showToast(T('sync.conflictResolved'));
      }
      break;
    }
    case 'sync_nudge': {
      // 服务器主动通知有未同步数据，立即拉取
      logger.info('[Sync] Nudge received: pending=' + payload.pending + ', size=' + formatSize(payload.size || 0));
      if (payload.pending > 0) {
        showToast(T('sync.discovered') + ' ' + payload.pending + T('sync.pendingChanges'));
        doIncrementalSync(lastSyncTs);
      }
      break;
    }
    case 'device_list': {
      renderDevices(payload.devices || []);
      break;
    }
    case 'pong': {
      break;
    }
  }
}

// 离线队列：操作符发送失败时缓存
function addToOfflineQueue(action, payload) {
  offlineQueue.push({ action, payload, ts: Math.floor(Date.now() / 1000) });
  localStorage.setItem('sharetool_offline_queue', JSON.stringify(offlineQueue));
  logger.info('[OfflineQueue] Added:', action, 'Queue size:', offlineQueue.length);
}

// 重连时批量发送离线操作
function flushOfflineQueue() {
  if (!isConnected || offlineQueue.length === 0) return;
  logger.info('[OfflineQueue] Flushing', offlineQueue.length, 'items');
  const queue = [...offlineQueue];
  offlineQueue = [];
  localStorage.setItem('sharetool_offline_queue', '[]');

  for (const item of queue) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: item.action, payload: item.payload }));
    } else {
      // 仍未连接，放回队列
      offlineQueue.push(item);
    }
  }
  if (offlineQueue.length > 0) {
    localStorage.setItem('sharetool_offline_queue', JSON.stringify(offlineQueue));
  }
  logger.info('[OfflineQueue] Flush complete, remaining:', offlineQueue.length);
}

// 增量同步：定期从服务器拉取变更
let syncIntervalId = null;

// 手动触发一次增量同步
function doIncrementalSync(sinceTs = 0) {
  if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) {
    logger.info('[Sync] Cannot sync: not connected');
    return;
  }
  ws.send(JSON.stringify({ type: 'sync_request', payload: { since: sinceTs || lastSyncTs, deviceId: DEVICE_ID } }));
  logger.info('[Sync] Manual sync_request sent, since:', sinceTs || lastSyncTs);
}

function startPeriodicSync(intervalMs = 30000) {
  if (syncIntervalId) clearInterval(syncIntervalId);
  syncIntervalId = setInterval(() => {
    if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'sync_request', payload: { since: lastSyncTs, deviceId: DEVICE_ID } }));
      logger.info('[Sync] Periodic sync_request sent, since:', lastSyncTs);
    }
  }, intervalMs);
  logger.info('[Sync] Periodic sync started, interval:', intervalMs, 'ms');
}

// 应用增量同步变更（差异更新）
function applyIncrementalChanges(changes) {
  if (!changes || !changes.length) return;
  logger.info('[Sync] Applying', changes.length, 'incremental changes');
  let updated = false;
  for (const change of changes) {
    const action = change.action;
    const filename = change.filename;
    if (action === 'create' || action === 'update') {
      // 文件创建或更新：检查是否存在
      const idx = currentFiles.findIndex(f => f.name === filename);
      const fileData = { name: filename, size: change.size, time: (change.timestamp || 0) * 1000, type: change.type, hash: change.current_hash || change.hash, tags: [] };
      if (idx >= 0) {
        currentFiles[idx] = { ...currentFiles[idx], ...fileData };
      } else {
        currentFiles.unshift(fileData);
      }
      updated = true;
    } else if (action === 'delete') {
      currentFiles = currentFiles.filter(f => f.name !== filename);
      updated = true;
    } else if (action === 'rename') {
      const idx = currentFiles.findIndex(f => f.name === change.oldFilename);
      if (idx >= 0) {
        currentFiles[idx].name = change.newFilename;
        updated = true;
      }
    }
  }
  if (updated) {
    renderFiles();
    updateTagFilterBar();
  }
}

// 发送 WS 消息（带离线队列）
function wsSend(type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  } else {
    addToOfflineQueue(type, payload);
  }
}

function renderDevices(devices) {
  const container = document.getElementById('deviceList');
  document.getElementById('deviceCount').textContent = T('device.device') + ': ' + devices.length;

  if (!devices.length) {
    container.innerHTML = '<div class="empty"><div class="empty-icon" style="font-size:32px;">📡</div><div class="empty-text">' + T('device.noOnlineDevices') + '</div></div>';
    return;
  }

  // Sort: online first, then by last_seen descending (most recent first)
  const sorted = [...devices].sort((a, b) => {
    if (a.isOnline !== b.isOnline) return b.isOnline - a.isOnline;
    return b.lastSeen - a.lastSeen;
  });

  container.innerHTML = sorted.map(d => {
    const lastSeenText = d.lastSeen
      ? new Date(d.lastSeen * 1000).toLocaleDateString() + ' ' +
        new Date(d.lastSeen * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    return '<div class="device-item">' +
      '<div class="indicator ' + (d.isOnline ? 'online' : '') + '"></div>' +
      '<div class="name">' + escapeHtml(d.deviceName || d.deviceId) + '</div>' +
      '<div class="ip" style="font-size:11px;">' + escapeHtml(d.ip) + (lastSeenText ? ' · ' + lastSeenText : '') + '</div>' +
    '</div>';
  }).join('');
}

async function loadTagColors() {
  try {
    const res = await fetch(API + '/api/tags/list', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success && data.tags) {
      tagColors = {};
      tagEmojis = {};
      data.tags.forEach(t => {
        if (t.color) tagColors[t.tag] = t.color;
        if (t.emoji) tagEmojis[t.tag] = t.emoji;
      });
      renderFiles();
    }
  } catch (e) {
    logger.error({ err: e }, 'TagColor load failed');
  }
}

function getTagStyle(tagName) {
  const color = tagColors[tagName];
  if (color) {
    const r = parseInt(color.slice(1,3), 16);
    const g = parseInt(color.slice(3,5), 16);
    const b = parseInt(color.slice(5,7), 16);
    // Use contrast-aware text color for both light and dark themes
    const textColor = getContrastColor(color);
    return 'background:rgba(' + r + ',' + g + ',' + b + ',0.2);color:' + textColor + ';';
  }
  return '';
}

function getTagEmoji(tagName) {
  return tagEmojis[tagName] || null;
}

function getContrastColor(hexColor) {
  if (!hexColor || !hexColor.startsWith('#') || hexColor.length !== 7) return '#000';
  const r = parseInt(hexColor.slice(1,3), 16);
  const g = parseInt(hexColor.slice(3,5), 16);
  const b = parseInt(hexColor.slice(5,7), 16);
  // Relative luminance formula
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000' : '#fff';
}

function navigateFolder(folder) {
  loadFiles(folder);
}

function renderBreadcrumb() {
  const bar = document.getElementById('breadcrumbBar');
  if (!bar) return;
  if (!currentFolder) {
    bar.innerHTML = '';
    bar.style.display = 'none';
    return;
  }
  const parts = currentFolder.split('/');
  let html = '<span class="breadcrumb-item" onclick="navigateFolder(null)" style="cursor:pointer;color:var(--accent-primary);">📁 T('ui.allFiles') + '</span>';
  let path = '';
  for (let i = 0; i < parts.length; i++) {
    path += (i > 0 ? '/' : '') + parts[i];
    html += ' <span style="color:var(--text-muted);">/</span> ';
    if (i === parts.length - 1) {
      html += '<span class="breadcrumb-item" style="color:var(--text-secondary);font-weight:500;">' + escapeHtml(parts[i]) + '</span>';
    } else {
      html += '<span class="breadcrumb-item" onclick="navigateFolder(\'' + escapeHtml(path) + '\')" style="cursor:pointer;color:var(--accent-primary);">' + escapeHtml(parts[i]) + '</span>';
    }
  }
  bar.innerHTML = html;
  bar.style.display = 'block';
}

async function loadFiles(folder = null, starred = false) {
  try {
    const sortRaw = localStorage.getItem('sharetool_sort') || 'created_at';
    const sortOrder = localStorage.getItem('sharetool_order') || 'desc';
    const folderParam = folder ? '&folder=' + encodeURIComponent(folder) : '';
    const starredParam = starred ? '&starred=1' : '';
    const res = await fetch(API + '/api/list?sort=' + sortRaw + '&order=' + sortOrder + folderParam + starredParam, { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    currentFiles = data.files || [];
    // Apply custom drag-order if set
    const customOrder = getCustomFileOrder();
    if (Object.keys(customOrder).length > 0) {
      currentFiles.sort((a, b) => {
        const ai = customOrder[a.name];
        const bi = customOrder[b.name];
        if (ai !== undefined && bi !== undefined) return ai - bi;
        if (ai !== undefined) return -1;
        if (bi !== undefined) return 1;
        return 0;
      });
    }
    currentFolder = folder;
    // Load folder sizes when at root
    if (!folder && !starred) {
      fetch(API + '/api/folder-sizes', { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
        .then(r => r.json())
        .then(d => { if (d.folders) window.folderSizes = Object.fromEntries(d.folders.map(f => [f.name, f.size])); })
        .catch(() => {});
    } else {
      window.folderSizes = {};
    }
    // Sync sort select UI
    initSortSelect(sortRaw, sortOrder);
    renderFiles();
    renderBreadcrumb();
    updateTagFilterBar();
  } catch (e) {
    logger.error({ err: e }, 'Load files failed');
  }
}

function initSortSelect(sort, order) {
  const sel = document.getElementById('sortSelect');
  if (!sel) return;
  const sortKey = sort === 'created_at' ? 'time' : sort;
  const target = sortKey === 'position' ? 'manual' : sortKey + '_' + order;
  for (const opt of sel.options) {
    opt.selected = opt.value === target;
  }
  currentSort = target;
}

function updateTagFilterBar() {
  const bar = document.getElementById('tagFilterBar');
  if (!bar) return;
  const tagCount = new Map();
  currentFiles.forEach(f => {
    if (f.tags) {
      f.tags.split(',').map(t => t.trim()).filter(t => t).forEach(t => {
        tagCount.set(t, (tagCount.get(t) || 0) + 1);
      });
    }
  });
  if (tagCount.size === 0) {
    bar.innerHTML = '';
    return;
  }
  const sorted = Array.from(tagCount.keys()).sort();
  const currentQ = window.currentSearchQ || '';
  const activeTag = sorted.find(t => currentQ.includes('tag:' + t));
  const clearBtn = activeTag
    ? '<span class="filter-tab" onclick="clearTagFilter()" style="font-size:11px;color:var(--text-muted);">✕' + T('msg.clear') + '</span>'
    : '';
  const manageBtn = '<span class="filter-tab" onclick="showTagManager()" style="font-size:11px;color:var(--text-muted);">⚙' + T('tag.manager') + '</span>';
  bar.innerHTML = sorted.map(t => {
    const active = currentQ.includes('tag:' + t) ? 'active' : '';
    const style = getTagStyle(t) || '';
    const count = tagCount.get(t);
    return '<span class="filter-tab ' + active + '" onclick="filterByTag(\'' + t.replace(/'/g, "\\'") + '\')" style="font-size:11px;' + style + '">🏷 ' + escapeHtml(t) + '<sup style="font-size:9px;opacity:0.7;margin-left:3px;">' + count + '</sup></span>';
  }).join('') + clearBtn + (sorted.length > 0 ? '<span class="filter-tab tag-match-toggle" id="tagMatchToggle" onclick="toggleTagMatch()" style="font-size:10px;opacity:0.7;cursor:pointer;" title="' + T('ui.tagMatchHint') + '">' + (window.currentTagMatch === 'any' ? 'OR' : 'AND') + '</span>' : '') + manageBtn;
}

function clearTagFilter() {
  window.currentTagMatch = 'all';
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    const val = searchInput.value || '';
    // Remove tag:xxx from search
    searchInput.value = val.replace(/tag:[^\s]*/g, '').trim();
    window.currentSearchQ = searchInput.value;
    doSearch();
  }
  updateTagFilterBar();
}

window.currentTagMatch = localStorage.getItem('sharetool_tag_match') || 'all'; // 'all' or 'any'

function toggleTagMatch() {
  window.currentTagMatch = window.currentTagMatch === 'all' ? 'any' : 'all';
  localStorage.setItem('sharetool_tag_match', window.currentTagMatch);
  // Update toggle button text
  const toggle = document.getElementById('tagMatchToggle');
  if (toggle) toggle.textContent = window.currentTagMatch === 'any' ? 'OR' : 'AND';
  // Re-run search if there's a tag filter
  if (window.currentSearchQ && window.currentSearchQ.includes('tag:')) {
    doSearch();
  }
}

function renderFiles() {
  const container = document.getElementById('filesContainer');
  const emptyState = document.getElementById('emptyState');
  
  let files = currentFiles;
  if (currentFilter !== 'all') {
    files = files.filter(f => f.type === currentFilter);
  }
  
  // Apply favorites filter
  files = applyFavoritesFilter(files);

  // Folder navigation: show subfolders and files directly in current folder
  if (currentFolder !== null) {
    const prefix = currentFolder + '/';
    const folderSet = new Set();
    const inFolderFiles = [];

    for (const f of files) {
      if (f.name.startsWith(prefix)) {
        const rest = f.name.slice(prefix.length);
        if (rest.includes('/')) {
          // Subfolder: extract first path component
          const subfolder = rest.split('/')[0];
          folderSet.add(subfolder);
        } else {
          // Direct file in this folder
          inFolderFiles.push({ ...f, displayName: rest });
        }
      }
    }

    // Build virtual folder items + direct files
    const folderItems = [...folderSet].map(name => ({
      name,
      displayName: name,
      type: 'folder',
      size: 0,
      time: 0,
      tags: '',
      isVirtualFolder: true
    }));
    files = [...folderItems, ...inFolderFiles];
    currentPage = 1; // reset to page 1 on folder change
  }

  // Apply sorting
  files = applySort(files);

  // Update count
  const countEl = document.getElementById('fileCount');
  if (countEl) countEl.textContent = files.length + ' ' + T('file.numFiles');
  
  // Pagination
  const totalPages = Math.ceil(files.length / PAGE_SIZE) || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pagedFiles = files.slice(start, start + PAGE_SIZE);
  
  if (pagedFiles.length === 0 && files.length > 0) {
    currentPage = 1;
    renderFiles();
    return;
  }
  
  if (files.length === 0) {
    const searchMode = !!window.currentSearchQ;
    container.innerHTML = '<div class="empty" id="emptyState">' +
      '<div class="empty-icon">' + (searchMode ? '🔍' : '📭') + '</div>' +
      '<div class="empty-text">' + (searchMode ? T('ui.noResults') : T('file.noContent')) + '</div>' +
      '<div class="empty-text" style="font-size:12px;margin-top:8px;">' + (searchMode ? T('ui.tryOtherKeywords') : T('file.uploadOrShare')) + '</div>' +
      '</div>';
    container.classList.remove('file-list', 'file-grid');
    container.classList.add(currentView === 'grid' ? 'file-grid' : 'file-list');
    renderPagination(0, 1);
    return;
  }

  container.innerHTML = '<div class="file-list">' + pagedFiles.map(f => {
    const isVirtualFolder = f.isVirtualFolder;
    const displayName = isVirtualFolder ? f.name : (f.displayName || f.name);
    const isText = !isVirtualFolder && f.type === 'text';
    const isImage = !isVirtualFolder && isImageFile(f.name);
    const isAudio = !isVirtualFolder && isAudioFile(f.name);
    const isVideo = !isVirtualFolder && isVideoFile(f.name);
    const isPdf = !isVirtualFolder && isPdfFile(f.name);
    const isMarkdown = !isVirtualFolder && /\.(md|markdown)$/i.test(f.name) && f.type === 'text';
    const isCode = !isVirtualFolder && !isMarkdown && isCodeFile(f.name);
    const previewId = 'preview-' + btoaSafe(f.name).substring(0, 20);
    const thumbId = 'thumb-' + btoaSafe(f.name).substring(0, 20);
    const tags = f.tags ? f.tags.split(',').filter(t => t.trim()) : [];
    const searchQ = (window.currentSearchQ || '').trim();
    const itemOnclick = isVirtualFolder
      ? 'handleFolderItemClick(\'' + encodeURIComponent(f.name) + '\')'
      : 'handleFileItemClick(event, \'' + encodeURIComponent(f.name) + '\', ' + isImage + ')';

    // Search highlight applied by applySearchHighlight() after render

    return '<div class="file-item" data-filename="' + escapeHtml(f.name) + '" draggable="true" ondragstart="handleDragStart(event, this)" ondragover="handleDragOver(event, this)" ondrop="handleDrop(event, this)" ondragend="handleDragEnd(event, this)" ontouchstart="handleSwipeStart(event, this)" ontouchmove="handleSwipeMove(event, this)" ontouchend="handleSwipeEnd(event, this)" onclick="' + itemOnclick + '" oncontextmenu="showFileContextMenu(event, \'' + encodeURIComponent(f.name) + '\')">' +
      '<div class="swipe-actions" id="swipe-' + btoaSafe(f.name).substring(0, 20) + '">' +
        (!isVirtualFolder ? '<button class="swipe-btn tag" onclick="event.preventDefault(); event.stopPropagation(); addTag(\'' + encodeURIComponent(f.name) + '\', \'' + (f.tags || '') + '\'); resetSwipe(this)"><span class="icon">🏷</span><span>' + T('file.addTag') + '</span></button>' : '') +
        '<button class="swipe-btn delete" onclick="event.preventDefault(); event.stopPropagation(); deleteFile(\'' + encodeURIComponent(f.name) + '\'); resetSwipe(this)"><span class="icon">🗑</span><span>' + T('tag.delete') + '</span></button>' +
      '</div>' +
      '<div style="margin-right: 12px; display:flex; align-items:center;">' +
        (!isVirtualFolder ? '<input type="checkbox" class="batch-checkbox" value="' + encodeURIComponent(f.name) + '" onchange="updateBatchBar()" style="width: 18px; height: 18px; cursor: pointer;">' : '<span style="font-size:20px;">📁</span>') +
      '</div>' +
      '<div class="file-content">' +
        (isVirtualFolder
          ? '<div class="file-name" style="cursor:pointer;"><span class="file-type-icon">📁</span><span class="search-target" style="color:var(--accent-primary);">' + escapeHtml(f.name) + '</span></div>'
          : (isImage
              ? '<div class="file-thumb-wrapper" style="margin-bottom:8px;"><img class="file-thumb-img" id="' + thumbId + '" data-src="" loading="lazy" style="border-radius:6px;max-width:100%;max-height:120px;object-fit:cover;display:block;cursor:pointer;" onclick="openImageModal(\'' + encodeURIComponent(f.name) + '\')" /></div>'
              : '<div class="file-name" ondblclick="startInlineRename(this, \'' + encodeURIComponent(f.name) + '\')" title="' + T('file.dblclickRename') + '"><span class="file-type-icon">' + getFileIcon(f.name) + '</span><span class="search-target">' + escapeHtml(displayName) + '</span></div>')) +
        (!isVirtualFolder && tags.length ? '<div class="file-tags">' + tags.map(t => {
          const tagEsc = t.trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const tagHtml = escapeHtml(t.trim());
          return '<span class="file-tag" style="' + getTagStyle(t.trim()) + '" onclick="filterByTag(\'' + tagEsc + '\')">' + tagHtml + '<span class="remove-tag" onclick="event.stopPropagation(); removeTag(\'' + encodeURIComponent(f.name) + '\', \'' + tagEsc + '\')">×</span></span>';
        }).join('') + '</div>' : '') +
        (!isVirtualFolder ? '<button class="btn btn-sm" style="margin-top:6px;font-size:11px;padding:4px 10px;" onclick="addTag(\'' + encodeURIComponent(f.name) + '\', \'' + ((f.tags || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")) + '\')">+' + T('file.addTag') + '</button>' : '') +
        (!isVirtualFolder ? '<div class="file-meta">' + formatSize(f.size) + ' | ' + formatTime(f.time) + '</div>' : '<div class="file-meta" style="color:var(--text-muted);">' + T('file.enterFolder') + (window.folderSizes && window.folderSizes[f.name] ? ' | ' + formatSize(window.folderSizes[f.name]) : '') + '</div>') +
        (!isVirtualFolder && isText ? '<div class="file-preview" id="' + previewId + '"></div>' : '') +
        // Audio/Video/PDF inline player
        (!isVirtualFolder && isAudio ? '<div class="file-audio-player" id="player-' + btoaSafe(f.name).substring(0, 20) + '" style="margin-top:8px;"></div>' : '') +
        (!isVirtualFolder && isVideo ? '<div class="file-video-wrapper" id="player-' + btoaSafe(f.name).substring(0, 20) + '" style="margin-top:8px;"></div>' : '') +
        (!isVirtualFolder && isPdf ? '<div class="file-thumb-wrapper" style="margin-bottom:8px;position:relative;"><img class="file-thumb-img" id="thumb-' + btoaSafe(f.name).substring(0, 20) + '" data-src="" loading="lazy" style="border-radius:6px;max-width:100%;max-height:120px;object-fit:cover;display:block;cursor:pointer;background:var(--bg-tertiary);" onclick="openPdfModal(\'' + encodeURIComponent(f.name) + '\')" /><div style="position:absolute;top:4px;left:6px;font-size:11px;background:rgba(0,0,0,0.5);color:white;padding:2px 6px;border-radius:4px;">📕 PDF</div></div>' : '') +
        (!isVirtualFolder && isOfficeFile(f.name) ? '<button class="btn btn-sm" style="margin-top:8px;font-size:11px;padding:4px 10px;" onclick="openOfficeModal(\'' + encodeURIComponent(f.name) + '\')">📊 ' + T('file.previewOffice') + '</button>' : '') +
        (!isVirtualFolder && isMarkdown ? '<button class="btn btn-sm" style="margin-top:8px;font-size:11px;padding:4px 10px;" onclick="openMarkdownModal(\'' + encodeURIComponent(f.name) + '\')">📝 ' + T('file.previewMd') + '</button>' : '') +
        (!isVirtualFolder && isCode ? '<button class="btn btn-sm" style="margin-top:8px;font-size:11px;padding:4px 10px;" onclick="openCodeModal(\'' + encodeURIComponent(f.name) + '\')">📄 ' + T('file.preview') + '</button>' : '') +
      '</div>' +
      '<div class="file-actions">' +
        (isVirtualFolder ? '<button class="btn btn-sm" onclick="downloadFolder(\'' + encodeURIComponent(f.name) + '\')">📦 ' + T('file.download') + '</button>' : '') +
        (!isVirtualFolder ? (isText || isCode ? '<button class="btn btn-sm" onclick="openFileModal(\'' + encodeURIComponent(f.name) + '\')">' + T('file.preview') + '</button>' : '') : '') +
        (!isVirtualFolder && (isAudio || isVideo) ? '<button class="btn btn-sm" onclick="openMediaModal(\'' + encodeURIComponent(f.name) + '\')">▶ ' + T('file.play') + '</button>' : '') +
        (!isVirtualFolder && isImage ? '<button class="btn btn-sm" onclick="openImageModal(\'' + encodeURIComponent(f.name) + '\')">🖼 ' + T('file.view') + '</button>' : '') +
        (!isVirtualFolder ? '<button class="btn btn-sm" onclick="copyContent(\'' + encodeURIComponent(f.name) + '\')">' + T('file.copy') + '</button>' : '') +
        '<button class="btn btn-sm" onclick="renameFile(\'' + encodeURIComponent(f.name) + '\')">' + T('file.rename') + '</button>' +
        (!isVirtualFolder ? '<button class="btn btn-sm" onclick="downloadFile(\'' + encodeURIComponent(f.name) + '\')">' + T('file.download') + '</button>' : '') +
        (!isVirtualFolder ? '<button class="btn btn-sm" onclick="shareFile(\'' + encodeURIComponent(f.name) + '\')">' + T('file.share') + '</button>' : '') +
        (!isVirtualFolder ? '<button class="btn btn-sm" onclick="showFileVersions(\'' + encodeURIComponent(f.name) + '\')">' + T('file.history') + '</button>' : '') +
        (!isVirtualFolder ? '<button class="btn btn-sm" onclick="openFileInfoPanel(\'' + encodeURIComponent(f.name) + '\')">ℹ️ ' + T('file.info') + '</button>' : '') +
        (!isVirtualFolder ? '<span class="file-star' + (f.starred ? ' starred' : '') + '" data-starfile="' + encodeURIComponent(f.name) + '" onclick="toggleFavorite(\'' + encodeURIComponent(f.name) + '\')">' + (f.starred ? '★' : '☆') + '</span>' : '') +
        '<button class="btn btn-sm btn-danger" onclick="deleteFile(\'' + encodeURIComponent(f.name) + '\')">' + T('tag.delete') + '</button>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';

  // 加载文本预览（跳过虚拟文件夹）
  for (const f of pagedFiles) {
    if (!f.isVirtualFolder && f.type === 'text' && f.size < 50000) {
      loadPreview(f.name, 'preview-' + btoaSafe(f.name).substring(0, 20));
    }
  }

  // 懒加载图片缩略图（仅 jpg/png/gif/webp，限制大小 2MB）
  for (const f of pagedFiles) {
    if (!f.isVirtualFolder && isImageFile(f.name) && f.size > 0 && f.size < 2 * 1024 * 1024) {
      loadImageThumb(f.name, 'thumb-' + btoaSafe(f.name).substring(0, 20));
    }
  }

  // 懒加载 PDF 缩略图（使用 PDF.js 渲染第一页）
  for (const f of pagedFiles) {
    if (!f.isVirtualFolder && isPdfFile(f.name) && f.size > 0 && f.size < 20 * 1024 * 1024) {
      loadPdfThumb(f.name, 'thumb-' + btoaSafe(f.name).substring(0, 20));
    }
  }

  // 懒加载音视频内联播放器
  for (const f of pagedFiles) {
    if (!f.isVirtualFolder && (isAudioFile(f.name) || isVideoFile(f.name))) {
      loadMediaPlayer(f.name, 'player-' + btoaSafe(f.name).substring(0, 20));
    }
  }

  // Render pagination
  const allFiles = applySort(currentFilter !== 'all' ? currentFiles.filter(f => f.type === currentFilter) : [...currentFiles]);
  const totalPages = Math.ceil(allFiles.length / PAGE_SIZE) || 1;
  renderPagination(currentPage, totalPages);
  updateFavoritesInView();
}

// Mobile swipe gesture handling
let swipeState = {};
const SWIPE_THRESHOLD = 80;
const LONG_PRESS_MS = 500;
let longPressTimer = null;
let longPressFired = false;
let longPressTarget = null; // filename for context menu
function handleSwipeStart(e, el) {
  swipeState.el = el;
  swipeState.startX = e.touches[0].clientX;
  swipeState.currentX = swipeState.startX;
  longPressFired = false;
  longPressTarget = el.dataset.filename ? decodeURIComponent(el.dataset.filename) : null;
  // Long-press detection: show context menu
  longPressTimer = setTimeout(() => {
    longPressFired = true;
    if (longPressTarget) showContextMenu(longPressTarget, el);
  }, LONG_PRESS_MS);
}

function handleSwipeMove(e, el) {
  if (!swipeState.el || swipeState.el !== el) return;
  const dx = e.touches[0].clientX - swipeState.startX;
  swipeState.currentX = e.touches[0].clientX;
  // Only cancel long-press if finger moved enough to be a deliberate swipe (not accidental micro-movement)
  const MOVE_CANCEL_THRESHOLD = 10;
  if (longPressTimer && Math.abs(dx) > MOVE_CANCEL_THRESHOLD) {
    clearTimeout(longPressTimer); longPressTimer = null; longPressTarget = null;
  }
  const actions = el.querySelector('.swipe-actions');
  if (!actions) return;
  if (dx < 0) {
    el.style.transform = 'translateX(' + Math.max(dx, -140) + 'px)';
    el.style.transition = 'none';
  }
}

function handleSwipeEnd(e, el) {
  if (!swipeState.el || swipeState.el !== el) return;
  // Cancel long-press timer
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  longPressTarget = null;
  const dx = swipeState.currentX - swipeState.startX;
  const actions = el.querySelector('.swipe-actions');
  if (!actions) return;
  el.style.transition = 'transform 0.2s ease';
  if (dx < -SWIPE_THRESHOLD) {
    el.style.transform = 'translateX(-140px)';
    actions.classList.add('show');
  } else {
    el.style.transform = 'translateX(0)';
    actions.classList.remove('show');
  }
  swipeState = {};
}

function resetSwipe(btn) {
  const item = btn.closest('.file-item');
  if (!item) return;
  item.style.transition = 'transform 0.2s ease';
  item.style.transform = 'translateX(0)';
  const actions = item.querySelector('.swipe-actions');
  if (actions) actions.classList.remove('show');
}

// File drag-and-drop reordering
let dragState = { sourceEl: null, sourceIndex: -1 };

function handleDragStart(e, el) {
  dragState.sourceEl = el;
  el.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Use filename as drag data
  e.dataTransfer.setData('text/plain', el.dataset.filename || el.getAttribute('data-filename'));
}

function handleDragOver(e, el) {
  // Don't allow reordering virtual folders or the source item
  if (el === dragState.sourceEl) return;
  if (el.classList.contains('drag-over')) return;
  // Remove drag-over from all items first
  document.querySelectorAll('.file-item.drag-over').forEach(item => item.classList.remove('drag-over'));
  el.classList.add('drag-over');
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function handleDrop(e, targetEl) {
  e.preventDefault();
  if (!dragState.sourceEl || targetEl === dragState.sourceEl) return;
  const sourceName = dragState.sourceEl.dataset.filename || dragState.sourceEl.getAttribute('data-filename');
  const targetName = targetEl.dataset.filename || targetEl.getAttribute('data-filename');
  // Save custom order to localStorage
  saveCustomFileOrder(sourceName, targetName);
  // Visual feedback: remove styles
  document.querySelectorAll('.file-item.drag-over').forEach(item => item.classList.remove('drag-over'));
  dragState = { sourceEl: null, sourceIndex: -1 };
}

function handleDragEnd(e, el) {
  el.classList.remove('dragging');
  document.querySelectorAll('.file-item.drag-over').forEach(item => item.classList.remove('drag-over'));
  dragState = { sourceEl: null, sourceIndex: -1 };
}

// Save and apply custom file order
const CUSTOM_ORDER_KEY = 'sharetool_custom_order_v1';
async function saveCustomFileOrder(movedName, targetName) {
  const container = document.getElementById('fileContainer') || document.querySelector('.file-list, .file-grid');
  if (!container) return;
  const items = Array.from(container.querySelectorAll('.file-item'));
  const names = items.map(el => el.dataset.filename || el.getAttribute('data-filename'));
  const order = getCustomFileOrder();
  // Find indices
  const movedIdx = names.indexOf(movedName);
  const targetIdx = names.indexOf(targetName);
  if (movedIdx < 0 || targetIdx < 0 || movedIdx === targetIdx) return;
  // Remove moved item
  names.splice(movedIdx, 1);
  // Insert at new position (insert before target)
  names.splice(targetIdx, 0, movedName);
  // Save
  const orderObj = {};
  names.forEach((name, i) => { orderObj[name] = i; });
  localStorage.setItem(CUSTOM_ORDER_KEY, JSON.stringify(orderObj));

  // Build positions array: use currentFiles (has id+name) to map filenames to ids
  const positions = names.map((name, i) => {
    const file = currentFiles.find(f => f.name === name);
    return file ? { id: file.id, position: i } : null;
  }).filter(Boolean);

  // Sync to server
  try {
    await fetch(API + '/api/file/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ positions })
    });
  } catch (_) {}

  // Reload the file list to reflect new order
  loadFiles();
}

  renderFiles();
  // Also persist to DB in background
  persistFileOrderToServer(names);
}

async function persistFileOrderToServer(names) {
  try {
    // Build positions array: name → position
    const positions = names.map((name, i) => {
      const file = currentFiles.find(f => f.name === name);
      return file ? { id: file.id, position: i } : null;
    }).filter(Boolean);
    if (positions.length === 0) return;
    await fetch(API + '/api/file/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ positions })
    });
  } catch (e) {
    logger.warn({ err: e }, 'Failed to persist file order');
  }
}

function getCustomFileOrder() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_ORDER_KEY) || '{}'); }
  catch { return {}; }
}

async function loadPreview(filename, previewId) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    const el = document.getElementById(previewId);
    if (el && data.content) {
      el.textContent = data.content.substring(0, 300) + (data.content.length > 300 ? '...' : '');
    }
  } catch (e) {}
}

// 懒加载 PDF 缩略图：使用 PDF.js 渲染第一页
async function loadPdfThumb(filename, thumbId) {
  const el = document.getElementById(thumbId);
  if (!el || el.dataset.src) return;
  try {
    // 确保 PDF.js 已加载
    if (!window.pdfjsLib) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      }).catch(() => {});
    }
    if (!window.pdfjsLib) return;

    // 获取 PDF 原始内容（base64）
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.content) return;

    // base64 → ArrayBuffer
    const binary = atob(data.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // 渲染 PDF 第一页
    const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 0.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    el.src = canvas.toDataURL('image/jpeg', 0.6);
    el.dataset.src = 'loaded';
  } catch (e) {
    // PDF 无法渲染，显示默认图标（el.src 保持空，CSS background 显示）
  }
}

// 懒加载图片缩略图：获取文件内容转为 data URL
async function loadImageThumb(filename, thumbId) {
  const el = document.getElementById(thumbId);
  if (!el || el.dataset.src) return;
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.content && data.type && data.type.startsWith('image/')) {
      const ext = filename.split('.').pop().toLowerCase();
      const mimeMap = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
        avif: 'image/avif', heic: 'image/heic', tiff: 'image/tiff',tif: 'image/tiff'
      };
      const mime = mimeMap[ext] || data.type; // fall back to server-reported type
      el.src = 'data:' + mime + ';base64,' + data.content;
      el.dataset.src = 'loaded';
    }
  } catch (e) {}
}

// 懒加载音视频内联播放器
async function loadMediaPlayer(filename, playerId) {
  const el = document.getElementById(playerId);
  if (!el || el.dataset.loaded) return;
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.content) return;
    const ext = filename.split('.').pop().toLowerCase();
    const isAudio = isAudioFile(filename);
    const mimeMap = {
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', m4a: 'audio/mp4',
      mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo', mov: 'video/quicktime', mkv: 'video/x-matroska', mov: 'video/quicktime'
    };
    const mime = mimeMap[ext] || (isAudio ? 'audio/mpeg' : 'video/mp4');
    const dataUrl = 'data:' + mime + ';base64,' + data.content;
    if (isAudio) {
      // Audio inline player style="width:100%;height:36px;"><source src="' + dataUrl + '" type="' + mime + '">' + T('err.browserNotSupport') + '音频</audio>';
    } else {
      el.innerHTML = '<video controls style="width:100%;max-height:200px;border-radius:8px;background:var(--bg-modal,#000);"><source src="' + dataUrl + '" type="' + mime + '">' + T('err.browserNotSupport') + '视频</video>';
    }
    el.dataset.loaded = '1';
  } catch (e) {}
}

// 点击图片缩略图打开全屏预览
async function openImageModal(filename) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.content) return;
    const ext = filename.split('.').pop().toLowerCase();
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };
    const mime = mimeMap[ext] || 'image/jpeg';
    const dataUrl = 'data:' + mime + ';base64,' + data.content;
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalMeta').textContent = 'Size: ' + formatSize(data.size || 0);
    document.getElementById('modalBody').innerHTML = '<div id="imageLightbox" style="position:relative;text-align:center;min-height:60px;"><button id="imgNavPrev" onclick="imageNav(-1)" style="position:absolute;left:8px;top:50%;transform:translateY(-50%);background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:50%;width:40px;height:40px;font-size:20px;cursor:pointer;z-index:2;display:none;">‹</button><img id="lightboxImg" src="' + dataUrl + '" style="max-width:100%;max-height:80vh;display:block;margin:0 auto;border-radius:8px;" /><button id="imgNavNext" onclick="imageNav(1)" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:50%;width:40px;height:40px;font-size:20px;cursor:pointer;z-index:2;display:none;">›</button><div id="imgCounter" style="position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.6);color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;display:none;"></div><button id="imgDownloadBtn" onclick="downloadCurrentImage()" style="position:absolute;top:8px;right:56px;background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:6px;width:36px;height:36px;font-size:16px;cursor:pointer;z-index:2;" title="Download">⬇</button></div>';
    // Collect image files for navigation
    window._imageFiles = currentFiles.filter(f => !f.isVirtualFolder && isImageFile(f.name));
    window._imageIndex = window._imageFiles.findIndex(f => f.name === filename);
    window._imageDataUrl = dataUrl;
    updateImageNavButtons();
    lockScroll();
    document.getElementById('fileModal').classList.add('show');
    // Arrow key navigation
    document.getElementById('fileModal').dataset.imageMode = '1';

    // Setup image zoom (pinch + double-tap)
    setupImageZoom();

  } catch (e) { showToast('Failed to open image'); }
}

let _imgZoomScale = 1;
let _imgZoomLast = 0;
let _imgPinchStart = 0;
let _imgPinchScale = 1;

function setupImageZoom() {
  _imgZoomScale = 1;
  _imgZoomLast = 0;
  _imgPinchStart = 0;
  _imgPinchScale = 1;

  const img = document.getElementById('lightboxImg');
  const container = document.getElementById('imageLightbox');
  if (!img || !container) return;

  // Reset transform
  img.style.transform = '';
  img.style.transformOrigin = 'center center';
  img.style.transition = 'transform 0.15s ease';
  container.style.overflow = 'hidden';

  // Remove old listeners by cloning
  img.removeEventListener('touchstart', handleImgTouchStart, { passive: false });
  img.removeEventListener('touchmove', handleImgTouchMove, { passive: false });
  img.removeEventListener('touchend', handleImgTouchEnd, { passive: false });
  img.removeEventListener('dblclick', handleImgDblClick);

  img.addEventListener('touchstart', handleImgTouchStart, { passive: false });
  img.addEventListener('touchmove', handleImgTouchMove, { passive: false });
  img.addEventListener('touchend', handleImgTouchEnd, { passive: false });
  img.addEventListener('dblclick', handleImgDblClick);
}

function handleImgTouchStart(e) {
  if (e.touches.length === 2) {
    _imgPinchStart = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    _imgPinchScale = _imgZoomScale;
    e.preventDefault();
  } else if (e.touches.length === 1) {
    _imgZoomLast = e.touches[0].clientX;
  }
}

function handleImgTouchMove(e) {
  const img = document.getElementById('lightboxImg');
  if (!img) return;

  if (e.touches.length === 2) {
    // Pinch to zoom
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const scale = (dist / _imgPinchStart) * _imgPinchScale;
    _imgZoomScale = Math.max(0.5, Math.min(5, scale));
    img.style.transform = 'scale(' + _imgZoomScale + ')';
    e.preventDefault();
  } else if (e.touches.length === 1 && _imgZoomScale > 1) {
    // Pan when zoomed
    const dx = e.touches[0].clientX - _imgZoomLast;
    img.style.transform = 'scale(' + _imgZoomScale + ') translate(' + (dx * 0.5) + 'px, 0)';
    _imgZoomLast = e.touches[0].clientX;
    e.preventDefault();
  }
}

function handleImgTouchEnd(e) {
  if (e.touches.length < 2) {
    _imgPinchStart = 0;
  }
}

function handleImgDblClick(e) {
  const img = document.getElementById('lightboxImg');
  if (!img) return;
  // Double-tap: toggle between 1x and 2.5x
  if (_imgZoomScale > 1.5) {
    _imgZoomScale = 1;
  } else {
    _imgZoomScale = 2.5;
  }
  img.style.transform = 'scale(' + _imgZoomScale + ')';
}

function resetImageZoom() {
  const img = document.getElementById('lightboxImg');
  if (!img) return;
  _imgZoomScale = 1;
  img.style.transform = '';
}

function downloadCurrentImage() {
  const a = document.createElement('a');
  a.href = window._imageDataUrl || '';
  a.download = document.getElementById('modalTitle').textContent || 'image';
  a.click();
}

// Long-press context menu
function showContextMenu(filename, el) {
  const menu = document.getElementById('contextMenu');
  const backdrop = document.getElementById('ctxBackdrop');
  const isImage = isImageFile(filename);
  const isText = /\.(txt|md|js|py|json|html|css|xml|yaml|yml|toml|sh|bash|c|cpp|h|java|go|rs|sql|ini|cfg|conf|log)$/i.test(filename);
  const isMarkdown = /\.(md|markdown)$/i.test(filename);
  const isPdf = /\.pdf$/i.test(filename);
  const isAudio = isAudioFile(filename);
  const isVideo = isVideoFile(filename);

  const items = [
    { label: '👁 ' + T('file.view'), action: "handleFileItemClick({stopPropagation:()=>{}}, '" + encodeURIComponent(filename) + "', " + isImage + ')' },
    { sep: true },
    { label: '🏷 ' + T('file.addTag'), action: "addTag('" + encodeURIComponent(filename) + "', ''); hideContextMenu()" },
    ...(isImage ? [{ label: '🖼 ' + T('media.viewImage'), action: "openImageModal('" + encodeURIComponent(filename) + "'); hideContextMenu()" }] : []),
    ...(isMarkdown ? [{ label: '📝 ' + T('media.viewMarkdown'), action: "openMarkdownModal('" + encodeURIComponent(filename) + "'); hideContextMenu()" }] : []),
    ...(isText ? [
      { label: '📄 ' + T('media.viewCode'), action: "openCodeModal('" + encodeURIComponent(filename) + "'); hideContextMenu()" },
      { label: '✏️ ' + T('ui.edit'), action: "openTextEditor('" + encodeURIComponent(filename) + "'); hideContextMenu()" }
    ] : []),
    ...(isAudio ? [{ label: '🎵 ' + T('media.playAudio'), action: "openMediaModal('" + encodeURIComponent(filename) + "'); hideContextMenu()" }] : []),
    ...(isVideo ? [{ label: '🎬 ' + T('media.playVideo'), action: "openMediaModal('" + encodeURIComponent(filename) + "'); hideContextMenu()" }] : []),
    ...(isPdf ? [{ label: '📕 ' + T('media.viewPdf'), action: "window.open(API + '/api/content/" + encodeURIComponent(filename) + "?auth=' + (AUTH_TOKEN || ''), '_blank'); hideContextMenu()" }] : []),
    { sep: true },
    { label: '📋 复制文件名', action: "copyText('" + filename.replace(/'/g, "\\'") + "'); hideContextMenu()" },
    { label: '↗️ 新标签页打开', action: "window.open(API + '/api/content/" + encodeURIComponent(filename) + "?auth=' + (AUTH_TOKEN || ''), '_blank'); hideContextMenu()" },
    { label: '⭐ 收藏', action: "toggleStar('" + encodeURIComponent(filename) + "'); hideContextMenu()" },
    { label: '✏️ 重命名', action: "startInlineRename(null, '" + encodeURIComponent(filename) + "'); hideContextMenu()" },
    { label: '📤 分享', action: "showShareModal('" + encodeURIComponent(filename) + "'); hideContextMenu()" },
    { sep: true },
    { label: '🗑 ' + T('tag.delete'), action: "deleteFile('" + encodeURIComponent(filename) + "'); hideContextMenu()", danger: true },
  ];

  menu.innerHTML = items.map(item =>
    item.sep ? '<div class="ctx-sep"></div>' :
    '<div class="ctx-item' + (item.danger ? ' danger' : '') + '" onclick="event.stopPropagation();' + item.action + '">' + item.label + '</div>'
  ).join('');

  // Position near element but keep on screen
  const rect = el.getBoundingClientRect();
  const menuW = 200, menuH = items.length * 42;
  let top = rect.bottom + 8;
  let left = Math.min(rect.left, window.innerWidth - menuW - 8);
  if (top + menuH > window.innerHeight - 8) top = rect.top - menuH - 8;
  if (top < 8) top = 8;

  menu.style.top = top + 'px';
  menu.style.left = Math.max(8, left) + 'px';
  menu.classList.add('show');
  backdrop.classList.add('show');
  hideContextMenu._active = true;
}

function hideContextMenu() {
  if (!hideContextMenu._active) return;
  document.getElementById('contextMenu').classList.remove('show');
  document.getElementById('ctxBackdrop').classList.remove('show');
  hideContextMenu._active = false;
}

function updateImageNavButtons() {
  const imgs = window._imageFiles || [];
  const idx = window._imageIndex;
  const prev = document.getElementById('imgNavPrev');
  const next = document.getElementById('imgNavNext');
  const counter = document.getElementById('imgCounter');
  if (!prev || !next) return;
  const show = imgs.length > 1;
  prev.style.display = show && idx > 0 ? 'block' : 'none';
  next.style.display = show && idx < imgs.length - 1 ? 'block' : 'none';
  if (counter) {
    counter.style.display = show ? 'block' : 'none';
    counter.textContent = (idx + 1) + ' / ' + imgs.length;
  }
}

async function imageNav(dir) {
  const imgs = window._imageFiles || [];
  const idx = window._imageIndex;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= imgs.length) return;
  window._imageIndex = newIdx;
  await openImageModal(imgs[newIdx].name);
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
let _currentSpeedIdx = 2; // default 1x

function cyclePlaybackSpeed() {
  _currentSpeedIdx = (_currentSpeedIdx + 1) % SPEEDS.length;
  const speed = SPEEDS[_currentSpeedIdx];
  const el = document.getElementById('mediaEl');
  const btn = document.getElementById('speedBtn');
  if (el) el.playbackRate = speed;
  if (btn) btn.textContent = '速度: ' + speed + 'x';
}

async function openMediaModal(filename) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.content) return;
    const ext = filename.split('.').pop().toLowerCase();
    const isAudio = isAudioFile(filename);
    const mimeMap = {
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', m4a: 'audio/mp4',
      mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo', mov: 'video/quicktime', mkv: 'video/x-matroska'
    };
    const mime = mimeMap[ext] || (isAudio ? 'audio/mpeg' : 'video/mp4');
    const dataUrl = 'data:' + mime + ';base64,' + data.content;
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalMeta').textContent = formatSize(data.size || 0);
    if (isAudio) {
      document.getElementById('modalBody').innerHTML =
        '<div style="text-align:center;padding:20px;background:var(--bg-tertiary);border-radius:8px;"><audio id="mediaEl" controls style="width:100%;max-width:500px;"><source src="' + dataUrl + '" type="' + mime + '">' + T('media.browserNotSupportAudio') + '</audio><div style="margin-top:8px;"><button onclick="cyclePlaybackSpeed()" id="speedBtn" style="background:var(--bg-secondary);border:1px solid var(--border-color);color:var(--text-secondary);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;">速度: 1x</button></div></div>';
    } else {
      document.getElementById('modalBody').innerHTML =
        '<div style="text-align:center;background:var(--bg-modal,#000);padding:10px;border-radius:8px;"><video id="mediaEl" controls style="max-width:100%;max-height:70vh;border-radius:8px;"><source src="' + dataUrl + '" type="' + mime + '">' + T('media.browserNotSupportVideo') + '</video><div style="margin-top:6px;"><button onclick="cyclePlaybackSpeed()" id="speedBtn" style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;">速度: 1x</button></div></div>';
    }
    lockScroll();
    document.getElementById('fileModal').classList.add('show');
  } catch (e) { showToast('Failed to open media: ' + e.message); }
}

async function openPdfModal(filename) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.content) return;
    const dataUrl = 'data:application/pdf;base64,' + data.content;
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalMeta').textContent = formatSize(data.size || 0);
    document.getElementById('modalBody').innerHTML =
      '<iframe title="' + T('file.preview') + '"  src="' + dataUrl + '" style="width:100%;height:70vh;border:none;border-radius:8px;background:var(--bg-tertiary);" title="PDF预览"></iframe>';
    lockScroll();
    document.getElementById('fileModal').classList.add('show');
  } catch (e) { showToast('Failed to open PDF: ' + e.message); }
}

async function openOfficeModal(filename) {
  try {
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalMeta').textContent = T('file.loading');
    document.getElementById('modalBody').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">' + T('file.loading') + '</div>';
    lockScroll();
    document.getElementById('fileModal').classList.add('show');

    const res = await fetch(API + '/api/office-preview?filename=' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.success) {
      document.getElementById('modalBody').innerHTML = '<div style="text-align:center;padding:40px;color:#dc2626;">' + escapeHtml(data.error || 'Failed to load preview') + '</div>';
      return;
    }
    const text = data.text || '';
    const slideCount = data.slides || 0;
    const sheetCount = data.sheets || 0;
    const info = slideCount > 0 ? slideCount + ' slides' : (sheetCount > 0 ? sheetCount + ' sheets' : '');
    document.getElementById('modalMeta').textContent = info;
    const safeText = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize('<pre style="white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.5;max-height:70vh;overflow-y:auto;background:var(--bg-tertiary);padding:16px;border-radius:8px;">' + escapeHtml(text.substring(0, 50000)) + '</pre>') : '<pre style="white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.5;max-height:70vh;overflow-y:auto;background:var(--bg-tertiary);padding:16px;border-radius:8px;">' + escapeHtml(text.substring(0, 50000)) + '</pre>';
    document.getElementById('modalBody').innerHTML = safeText;
  } catch (e) { showToast('Failed to open Office file: ' + e.message); }
}

async function openMarkdownModal(filename) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.content) return;
    // Decode base64 content
    const content = atob(data.content);
    // Render markdown using marked + DOMPurify sanitization
    const rawHtml = marked.parse(content);
    const safeHtml = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } }) : rawHtml;

    // Build table of contents from headings
    const tocEntries = [];
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = safeHtml;
    tempDiv.querySelectorAll('h1,h2,h3').forEach((h, i) => {
      const id = 'md-heading-' + i;
      h.id = id;
      const level = parseInt(h.tagName[1]);
      tocEntries.push({ id, text: h.textContent, level });
    });

    let tocHtml = '';
    if (tocEntries.length > 1) {
      tocHtml = '<div class="md-toc" style="background:var(--bg-tertiary);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:12px;">' +
        '<div style="color:var(--text-muted);margin-bottom:6px;font-weight:600;">' + T('media.tableOfContents') + '</div>' +
        tocEntries.map(e =>
          '<div class="toc-entry" data-id="' + e.id + '" style="padding-left:' + ((e.level - 1) * 12) + 'px;color:var(--accent-primary);cursor:pointer;margin:2px 0;transition:color 0.15s;" onclick="document.getElementById(\'' + e.id + '\').scrollIntoView({behavior:\'smooth\'})">' + escapeHtml(e.text) + '</div>'
        ).join('') + '</div>';
    }

    // Wrap safeHtml in container, add copy buttons to code blocks
    const bodyHtml = '<div class="markdown-body" style="padding:16px;font-size:14px;line-height:1.6;">' + tocHtml + safeHtml + '</div>';
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalMeta').textContent = formatSize(data.size || 0);
    document.getElementById('modalBody').innerHTML = bodyHtml;

    // TOC active tracking via IntersectionObserver
    if (tocEntries.length > 1) {
      const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          const el = document.querySelector('.toc-entry[data-id="' + entry.target.id + '"]');
          if (el) el.classList.toggle('toc-active', entry.isIntersecting);
        });
      }, { rootMargin: '-20% 0px -70% 0px' });
      tocEntries.forEach(e => {
        const h = document.getElementById(e.id);
        if (h) observer.observe(h);
      });
    }

    // Add copy buttons to code blocks
    document.querySelectorAll('#modalBody .markdown-body pre').forEach(pre => {
      const code = pre.querySelector('code');
      if (!code) return;
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = T('ui.copy');
      btn.onclick = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(code.textContent).then(() => {
          btn.textContent = T('file.copied') + '!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = T('ui.copy'); btn.classList.remove('copied'); }, 2000);
        });
      };
      pre.appendChild(btn);
    });

    // Apply syntax highlighting to code blocks
    if (typeof hljs !== 'undefined') hljs.highlightAll();

    // Add line numbers to code blocks after highlighting
    document.querySelectorAll('#modalBody .markdown-body pre').forEach(pre => {
      const code = pre.querySelector('code');
      if (!code) return;
      const lineCount = code.textContent.split('\n').length;
      if (lineCount <= 1) return;
      pre.style.counterSet = 'line ' + lineCount;
      pre.setAttribute('data-lines', lineCount);
      // Wrap code in a table for line numbers
      const lineNumWidth = String(lineCount).length + 1;
      const table = document.createElement('div');
      table.className = 'code-with-lines';
      table.style.cssText = 'display:table;width:100%;';
      const numCol = document.createElement('span');
      numCol.className = 'line-nums';
      numCol.style.cssText = 'display:table-cell;user-select:none;color:var(--text-muted);padding-right:10px;text-align:right;font-size:12px;line-height:1.6;white-space:pre;vertical-align:top;min-width:' + lineNumWidth + 'ch;';
      numCol.innerHTML = Array.from({length: lineCount}, (_, i) => '<span>' + (i+1) + '</span>').join('\n');
      const codeCol = document.createElement('span');
      codeCol.className = 'code-content';
      codeCol.style.cssText = 'display:table-cell;white-space:pre;word-break:break-all;line-height:1.6;width:100%;';
      codeCol.innerHTML = code.innerHTML;
      table.appendChild(numCol);
      table.appendChild(codeCol);
      code.replaceWith(table);
    });

    lockScroll();
    document.getElementById('fileModal').classList.add('show');
  } catch (e) { showToast('Failed to render Markdown: ' + e.message); }
}

async function openCodeModal(filename) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.content) return;
    const content = atob(data.content);
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const langMap = {
      js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
      c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', php: 'php',
      sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', xml: 'xml',
      yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
      json: 'json', html: 'html', css: 'css', scss: 'scss',
      md: 'markdown', markdown: 'markdown', txt: 'plaintext', log: 'plaintext',
      swift: 'swift', kt: 'kotlin', scala: 'scala', lua: 'lua', r: 'r', pl: 'perl', pm: 'perl'
    };
    const lang = langMap[ext] || 'plaintext';
    let highlighted;
    if (typeof hljs !== 'undefined') {
      try {
        const result = hljs.highlight(content, { language: lang, ignoreIllegals: true });
        highlighted = result.value;
      } catch (_) {
        highlighted = escapeHtml(content);
      }
    } else {
      highlighted = escapeHtml(content);
    }
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalMeta').textContent = formatSize(data.size || 0) + ' | ' + lang;
    document.getElementById('modalBody').innerHTML =
      '<div style="position:relative;">' +
        '<button onclick="navigator.clipboard.writeText(document.getElementById(\'codeContentClone\').textContent).then(()=>{this.textContent=\'' + T('file.copied') + '!\';this.classList.add(\'copied\');setTimeout(()=>{this.textContent=\'' + T('ui.copy') + '\';this.classList.remove(\'copied\')},2000)})" ' +
           'style="position:absolute;top:8px;right:8px;padding:4px 10px;font-size:12px;border-radius:6px;border:none;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;z-index:1;">' + T('ui.copy') + '</button>' +
        '<pre id="codeContentClone" style="margin:0;overflow:auto;max-height:70vh;background:var(--bg-tertiary);border-radius:8px;padding:16px;font-size:13px;line-height:1.5;display:none;">' + escapeHtml(content) + '</pre>' +
        '<pre style="margin:0;overflow:auto;max-height:70vh;background:var(--bg-tertiary);border-radius:8px;padding:16px;font-size:13px;line-height:1.5;"><code class="hljs language-' + lang + '">' + highlighted + '</code></pre>' +
      '</div>';
    lockScroll();
    document.getElementById('fileModal').classList.add('show');
  } catch (e) { showToast('Failed to open code file: ' + e.message); }
}

async function openTextEditor(filename) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.content && data.content !== '') { showToast('Failed to load file'); return; }
    const content = atob(data.content);

    document.getElementById('modalTitle').textContent = filename + ' (editing)';
    document.getElementById('modalMeta').textContent = formatSize(data.size || 0) + ' | ' + T('ui.save');
    document.getElementById('modalBody').innerHTML =
      '<div style="display:flex;flex-direction:column;height:70vh;">' +
        '<textarea id="textEditorContent" spellcheck="false" ' +
          'style="flex:1;width:100%;padding:16px;border:1px solid var(--border-color);border-radius:8px;' +
                 'background:var(--bg-tertiary);color:var(--text-primary);font-family:ui-monospace,Menlo,monospace;' +
                 'font-size:13px;line-height:1.5;resize:none;outline:none;box-sizing:border-box;">' +
          escapeHtml(content) +
        '</textarea>' +
        '<div id="editorStatus" style="padding:8px 0;font-size:12px;color:var(--text-muted);"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
          '<button class="btn" onclick="saveTextEditor(\'' + filename.replace(/'/g, "\\'") + '\')" id="saveEditorBtn">' + T('ui.save') + '</button>' +
          '<button class="btn btn-secondary" onclick="closeModal()">' + T('ui.cancel') + '</button>' +
        '</div>' +
      '</div>';
    document.getElementById('modalFooter').style.display = 'none';

    const originalContent = content;
    const textarea = document.getElementById('textEditorContent');
    textarea.addEventListener('input', () => {
      document.getElementById('editorStatus').textContent = textarea.value !== originalContent ? '● unsaved changes' : '';
    });
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveTextEditor(filename);
      }
    });

    lockScroll();
    document.getElementById('fileModal').classList.add('show');
  } catch (e) { showToast('Failed to open editor: ' + e.message); }
}

async function saveTextEditor(filename) {
  const content = document.getElementById('textEditorContent').value;
  const btn = document.getElementById('saveEditorBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ content })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Saved! hash: ' + (data.hash || '').slice(0, 8));
      closeModal();
      await refreshFileList();
    } else {
      showToast('Save failed: ' + (data.error || ''), 'error');
      btn.disabled = false;
      btn.textContent = T('ui.save');
    }
  } catch (e) {
    showToast('Save failed: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = T('ui.save');
  }
}

function togglePreview(filename, previewId) {
  const el = document.getElementById(previewId);
  if (el) {
    el.classList.toggle('show');
    if (!el.classList.contains('show') && !el.textContent) {
      loadPreview(filename, previewId);
    }
  }
}

async function openFileModal(filename) {
  try {
    const res = await fetch(API + '/api/content/' + encodeURIComponent(filename), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalMeta').textContent = 'Size: ' + formatSize(data.size || 0) + ' | Modified: ' + formatTime(data.time || 0);
    document.getElementById('modalBody').textContent = data.content || '';
    lockScroll();
    document.getElementById('fileModal').classList.add('show');
  } catch (e) { showToast('Failed to open file'); }
}

function handleFileItemClick(event, filename, isImage) {
  // Don't trigger if clicking interactive elements
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SPAN' || event.target.closest('input') || event.target.closest('button')) return;
  if (isImage) return; // images already have their own click handler (thumbnail)
  if (isCodeFile(filename)) { openCodeModal(filename); return; }
  if (isAudioFile(filename) || isVideoFile(filename)) { openMediaModal(filename); return; }
  if (isPdfFile(filename)) { openPdfModal(filename); return; }
  if (isOfficeFile(filename)) { openOfficeModal(filename); return; }
  openFileModal(filename);
}

function handleFolderItemClick(folderName) {
  const targetFolder = currentFolder ? currentFolder + '/' + folderName : folderName;
  navigateFolder(targetFolder);
}

// ============================================================
// File Info Side Panel
// ============================================================
let currentFileInfoPanel = null;

function openFileInfoPanel(filename) {
  currentFileInfoPanel = filename;
  const panel = document.getElementById('fileInfoPanel');
  const title = document.getElementById('fileInfoPanelTitle');
  const body = document.getElementById('fileInfoBody');
  if (!panel) return;

  title.textContent = filename;
  body.innerHTML = '<div class="file-info-loading">' + T('fileInfo.loading') + '</div>';
  panel.classList.add('open');
  lockScroll();

  // Fetch metadata
  fetch(API + '/api/file-meta/' + encodeURIComponent(filename), {
    headers: { 'x-auth-token': AUTH_TOKEN || '' }
  })
    .then(r => r.json())
    .then(data => {
      if (!data.success) {
        body.innerHTML = '<div style="color:var(--danger);padding:16px;">' + (data.error || 'Error') + '</div>';
        return;
      }
      renderFileInfoContent(data.meta);
    })
    .catch(() => {
      body.innerHTML = '<div style="color:var(--danger);padding:16px;">加载失败</div>';
    });
}

function closeFileInfoPanel() {
  const panel = document.getElementById('fileInfoPanel');
  if (panel) panel.classList.remove('open');
  unlockScroll();
  currentFileInfoPanel = null;
}

function renderFileInfoContent(meta) {
  const body = document.getElementById('fileInfoBody');
  if (!body) return;

  const tags = meta.tags ? meta.tags.split(',').filter(t => t.trim()) : [];
  const createdDate = meta.createdAt ? new Date(meta.createdAt).toLocaleString() : '--';
  const updatedDate = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : '--';

  let html = '';

  // Basic info section
  html += '<div class="file-info-section">';
  html += '<div class="file-info-section-title">' + T('fileInfo.basic') + '</div>';
  html += '<div class="file-info-row"><span class="file-info-label">' + T('fileInfo.size') + '</span><span class="file-info-value">' + formatSize(meta.size) + '</span></div>';
  html += '<div class="file-info-row"><span class="file-info-label">' + T('fileInfo.type') + '</span><span class="file-info-value">' + (meta.type || 'file') + '</span></div>';
  html += '<div class="file-info-row"><span class="file-info-label">' + T('fileInfo.encrypted') + '</span><span class="file-info-value">' + (meta.encrypted ? T('fileInfo.yes') : T('fileInfo.no')) + '</span></div>';
  html += '<div class="file-info-row" style="flex-direction:column;align-items:flex-start;gap:4px;">';
  html += '<span class="file-info-label" style="margin-bottom:2px;">' + T('fileInfo.hash') + '</span>';
  html += '<span class="file-info-value" style="max-width:100%;font-size:10px;word-break:break-all;">' + (meta.hash || '--') + '</span>';
  html += '</div>';
  html += '</div>';

  // Timestamps
  html += '<div class="file-info-section">';
  html += '<div class="file-info-section-title">' + T('fileInfo.versions') + '</div>';
  html += '<div class="file-info-row"><span class="file-info-label">' + T('fileInfo.created') + '</span><span class="file-info-value" style="font-size:10px;">' + createdDate + '</span></div>';
  html += '<div class="file-info-row"><span class="file-info-label">' + T('fileInfo.updated') + '</span><span class="file-info-value" style="font-size:10px;">' + updatedDate + '</span></div>';
  html += '<div class="file-info-row"><span class="file-info-label">' + T('fileInfo.versions') + '</span><span class="file-info-value">' + meta.versionCount + ' <button class="btn btn-sm" style="margin-left:8px;font-size:10px;padding:2px 8px;" onclick="closeFileInfoPanel();showFileVersions(\'' + encodeURIComponent(meta.filename) + '\')">' + T('fileInfo.openVersions') + '</button></span></div>';
  html += '</div>';

  // Tags
  if (tags.length > 0 || true) {
    html += '<div class="file-info-section">';
    html += '<div class="file-info-section-title">' + T('fileInfo.tags') + '</div>';
    if (tags.length > 0) {
      html += '<div class="file-info-tags">';
      for (const tag of tags) {
        const color = db.getTagColor(tag.trim());
        html += '<span class="file-tag" style="background:' + color + ';color:' + getContrastColor(color) + ';padding:2px 8px;border-radius:10px;font-size:11px;">' + escapeHtml(tag.trim()) + '</span>';
      }
      html += '</div>';
    } else {
      html += '<div style="color:var(--text-muted);font-size:12px;">--</div>';
    }
    html += '</div>';
  }

  // Share links
  html += '<div class="file-info-section">';
  html += '<div class="file-info-section-title">' + T('fileInfo.share') + ' (' + meta.shareCount + ')</div>';
  if (meta.shareLinks && meta.shareLinks.length > 0) {
    for (const link of meta.shareLinks) {
      const shareUrl = location.origin + '/s/' + link.code + '?utm_source=sharetool&utm_medium=file_info_copy&utm_campaign=sharetool';
      html += '<div class="file-info-share-item">';
      html += '<div style="font-size:12px;color:var(--text-primary);">' + escapeHtml(link.filename || meta.filename) + ' <button class="btn btn-sm" style="font-size:9px;padding:1px 4px;" onclick="copyText(\'' + escapeHtml(link.filename || meta.filename) + '\')">📋</button></div>';
      html += '<div class="file-info-share-url" title="' + escapeHtml(shareUrl) + '">' + escapeHtml(shareUrl) + '</div>';
      html += '<div style="display:flex;gap:4px;flex-shrink:0;">';
      if (link.hasPassword) html += '<span style="font-size:10px;color:var(--warning);">🔑</span>';
      html += '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px;" onclick="copyText(\'' + escapeHtml(shareUrl) + '\')">📋</button>';
      html += '</div></div>';
    }
  } else {
    html += '<div style="color:var(--text-muted);font-size:12px;">' + T('fileInfo.noShares') + '</div>';
  }
  html += '</div>';

  body.innerHTML = html;
}

// Click outside panel to close
document.addEventListener('click', function(e) {
  const panel = document.getElementById('fileInfoPanel');
  if (panel && panel.classList.contains('open') && !panel.contains(e.target)) {
    closeFileInfoPanel();
  }
});

// Keyboard: Escape closes file modal and context menu
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    hideContextMenu();
    const fileModal = document.getElementById('fileModal');
    if (fileModal && fileModal.classList.contains('show')) {
      closeModal();
    }
  }
});

function closeModal() {
  resetImageZoom();
  unlockScroll();
  document.getElementById('fileModal').classList.remove('show');
  const footer = document.getElementById('modalFooter');
  if (footer) footer.style.display = 'none';
}

function closeShortcutModal() {
  unlockScroll();
  document.getElementById('shortcutModal').classList.remove('show');
}

function closeAuditModal() {
  unlockScroll();
  document.getElementById('auditModal').classList.remove('show');
}

function closeTokenModal() {
  unlockScroll();
  document.getElementById('tokenModal').classList.remove('show');
}

function closeShareLinksModal() {
  unlockScroll();
  document.getElementById('shareLinksModal').classList.remove('show');
}

function showStorageModal() {
  const body = document.getElementById('storageModalBody');
  fetch(API + '/api/db/stats', { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      const used = (data.storageUsed || 0);
      const limit = (data.storageLimit || 0);
      const usedMB = (used / 1024 / 1024).toFixed(2);
      const limitMB = (limit / 1024 / 1024).toFixed(0);
      const pct = limit > 0 ? Math.min(100, (used / limit * 100)).toFixed(1) : 0;
      body.innerHTML = '<div style="padding:12px;">' +
        '<div style="font-size:24px;font-weight:600;">' + usedMB + ' <span style="font-size:14px;color:var(--text-muted);">/ ' + limitMB + ' MB</span></div>' +
        '<div style="height:12px;background:var(--bg-tertiary);border-radius:6px;margin:12px 0;overflow:hidden;"><div style="height:100%;width:' + pct + '%;background:var(--accent-primary);border-radius:6px;"></div></div>' +
        '<div style="font-size:12px;color:var(--text-muted);">' + pct + '% used · ' + (data.fileCount || 0) + ' files</div>' +
        '</div>';
    }).catch(() => { body.innerHTML = '<div style="padding:16px;color:var(--danger);">Failed to load storage info</div>'; });
  lockScroll();
  document.getElementById('storageModal').classList.add('show');
}
function closeStorageModal() { unlockScroll(); document.getElementById('storageModal').classList.remove('show'); }

function showDevicesModal() {
  const body = document.getElementById('devicesModalBody');
  fetch(API + '/api/devices', { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      const devs = data.devices || [];
      body.innerHTML = devs.length ? devs.map(d =>
        '<div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-tertiary);border-radius:8px;margin-bottom:6px;">' +
        '<span>' + (d.is_online ? '🟢' : '⚫') + '</span>' +
        '<span style="flex:1;font-size:13px;">' + escapeHtml(d.device_name || d.device_id) + '</span>' +
        '<span style="font-size:11px;color:var(--text-muted);">' + (d.last_seen ? new Date(d.last_seen * 1000).toLocaleString() : 'Never') + '</span>' +
        '</div>'
      ).join('') : '<div style="padding:16px;text-align:center;color:var(--text-muted);">No devices</div>';
    }).catch(() => { body.innerHTML = '<div style="padding:16px;color:var(--danger);">Failed</div>'; });
  lockScroll();
  document.getElementById('devicesModal').classList.add('show');
}
function closeDevicesModal() { unlockScroll(); document.getElementById('devicesModal').classList.remove('show'); }

function showTagsModal() {
  const body = document.getElementById('tagsModalBody');
  body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);">Loading...</div>';
  fetch(API + '/api/tags/list', { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      window._tagsModalData = data.tags || [];
      document.getElementById('tagsModalSearch').value = '';
      // Default to recent sort, then re-render with current sort selection
      document.getElementById('tagsModalSort').value = 'recent';
      const sorted = applyTagsModalSort(window._tagsModalData, 'recent');
      renderTagsModalBody(sorted);
    }).catch(() => { body.innerHTML = '<div style="padding:16px;color:var(--danger);">Failed</div>'; });
  lockScroll();
  document.getElementById('tagsModal').classList.add('show');
}

function renderTagsModalBody(tags) {
  const body = document.getElementById('tagsModalBody');
  if (!tags.length) {
    body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);">' + T('tags.empty') || 'No tags yet' + '</div>';
    return;
  }
  body.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:8px;">' + tags.map(t => {
    const color = t.color || '#667eea';
    const bg = color + '22';
    return '<div onclick="showFilesWithTag(\'' + escapeHtml(t.tag).replace(/'/g, "\\'") + '\')" ' +
      'style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:' + bg + ';border:1px solid ' + color + '44;border-radius:20px;font-size:13px;cursor:pointer;transition:transform 0.1s;" ' +
      'onmouseover="this.style.transform=\'scale(1.05)\'" onmouseout="this.style.transform=\'scale(1)\'">' +
      (t.emoji ? '<span>' + escapeHtml(t.emoji) + '</span>' : '') +
      '<span style="color:' + escapeHtml(color) + ';font-weight:500;">' + escapeHtml(t.tag) + '</span>' +
      '<span style="background:' + color + '33' + ';padding:1px 6px;border-radius:10px;font-size:11px;color:var(--text-muted);">' + t.count + '</span>' +
      '</div>';
  }).join('') + '</div>';
}

function filterTagsModal(query) {
  if (!window._tagsModalData) return;
  const q = query.toLowerCase();
  const sortBy = document.getElementById('tagsModalSort').value;
  let filtered = window._tagsModalData.filter(t => t.tag.toLowerCase().includes(q));
  filtered = applyTagsModalSort(filtered, sortBy);
  renderTagsModalBody(filtered);
}

function sortTagsModal(sortBy) {
  if (!window._tagsModalData) return;
  const query = document.getElementById('tagsModalSearch').value;
  const q = query.toLowerCase();
  let filtered = window._tagsModalData.filter(t => t.tag.toLowerCase().includes(q));
  filtered = applyTagsModalSort(filtered, sortBy);
  renderTagsModalBody(filtered);
}

function applyTagsModalSort(tags, sortBy) {
  const colorOrder = ['red','orange','yellow','green','teal','blue','purple','pink','gray'];
  if (sortBy === 'count') return [...tags].sort((a, b) => b.count - a.count);
  if (sortBy === 'alpha') return [...tags].sort((a, b) => a.tag.localeCompare(b.tag));
  if (sortBy === 'recent') return [...tags].sort((a, b) => (b.last_used || 0) - (a.last_used || 0));
  if (sortBy === 'color') {
    return [...tags].sort((a, b) => {
      const ca = colorOrder.indexOf(a.color) >= 0 ? colorOrder.indexOf(a.color) : 999;
      const cb = colorOrder.indexOf(b.color) >= 0 ? colorOrder.indexOf(b.color) : 999;
      return ca - cb;
    });
  }
  return tags;
}

function showFilesWithTag(tag) {
  closeTagsModal();
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.value = 'tag:' + tag;
    doSearch();
  }
}
function closeTagsModal() { unlockScroll(); document.getElementById('tagsModal').classList.remove('show'); }

function showBackupModal() {
  const body = document.getElementById('backupModalBody');
  body.innerHTML = '<div style="padding:16px;text-align:center;">' +
    '<p style="margin:0 0 16px;font-size:13px;color:var(--text-secondary);">' + T('admin.backupDesc') + '</p>' +
    '<button class="btn" style="margin:4px;" onclick="doBackup()">' + T('admin.backupNow') + '</button>' +
    '<button class="btn btn-secondary" style="margin:4px;" onclick="doRestore()">' + T('admin.restore') + '</button>' +
    '</div>';
  lockScroll();
  document.getElementById('backupModal').classList.add('show');
}
function closeBackupModal() { unlockScroll(); document.getElementById('backupModal').classList.remove('show'); }

function showAboutModal() {
  lockScroll();
  document.getElementById('aboutModal').classList.add('show');
  // Load system stats
  fetch(API + '/api/system/stats', { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      if (!data.success) return;
      const m = data.memory;
      const c = data.cpu;
      const p = data.process;
      const d = data.disk;
      const fmtMem = b => { if (b >= 1e9) return (b / 1024 / 1024 / 1024).toFixed(1) + ' GB'; return (b / 1024 / 1024).toFixed(0) + ' MB'; };
      const fmtDisk = b => (b / 1024 / 1024 / 1024).toFixed(1) + ' GB';
      const memPct = m ? Math.round((m.heapUsed / m.heapTotal) * 100) : 0;
      const sysMemPct = m ? Math.round((m.systemUsed / m.systemTotal) * 100) : 0;
      const sysMemFreePct = m ? 100 - sysMemPct : 0;
      const days = p ? Math.floor(p.uptime / 86400) : 0;
      const hours = p ? Math.floor((p.uptime % 86400) / 3600) : 0;
      const mins = p ? Math.floor((p.uptime % 3600) / 60) : 0;
      const secs = p ? Math.round(p.uptime % 60) : 0;
      const uptimeStr = p ? (days > 0 ? days + 'd ' : '') + hours + 'h ' + mins + 'm ' + secs + 's' : '—';
      // Load bar: normalize to cores (load < cores = green, < 2*cores = yellow, >= 2*cores = red)
      const loadPerCore = c ? c.loadavg1m / c.cores : 0;
      const loadColor = loadPerCore < 0.7 ? '#22c55e' : loadPerCore < 1.4 ? '#eab308' : '#ef4444';
      const loadBarWidth = Math.min(100, Math.round(loadPerCore * 100));
      const diskPct = d ? Math.round((d.used / d.total) * 100) : 0;
      let html = '<div style="border-top:1px solid var(--border-color);padding-top:12px;margin-top:4px;display:flex;flex-direction:column;gap:10px;">';
      // Memory section with pie chart
      if (m) {
        const heapPct = Math.round((m.heapUsed / m.heapTotal) * 100);
        html += '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">';
        // Heap pie (conic-gradient)
        html += '<div style="position:relative;width:48px;height:48px;flex-shrink:0;">';
        html += '<svg width="48" height="48" viewBox="0 0 48 48" style="transform:rotate(-90deg);">';
        html += '<circle cx="24" cy="24" r="20" fill="none" stroke="var(--border-color)" stroke-width="6"/>';
        html += '<circle cx="24" cy="24" r="20" fill="none" stroke="#60a5fa" stroke-width="6"';
        html += ' stroke-dasharray="' + (heapPct * 1.256) + ' 125.6" stroke-linecap="round"/>';
        html += '</svg>';
        html += '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:var(--text-primary);">' + heapPct + '%</div>';
        html += '</div>';
        // System memory bar (horizontal)
        html += '<div style="flex:1;min-width:120px;">';
        html += '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">🖥 ' + sysMemPct + '% ' + fmtMem(m.systemUsed) + ' / ' + fmtMem(m.systemTotal) + ' system</div>';
        html += '<div style="height:8px;background:var(--border-color);border-radius:4px;overflow:hidden;">';
        html += '<div style="height:100%;width:' + sysMemPct + '%;background:#60a5fa;border-radius:4px;"></div>';
        html += '</div>';
        html += '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">RSS ' + fmtMem(m.rss) + ' · heap ' + fmtMem(m.heapUsed) + '</div>';
        html += '</div>';
        html += '</div>';
      }
      // CPU load section
      if (c) {
        html += '<div>';
        html += '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px;">⚙️ Load avg: <span style="color:var(--text-primary);">' + c.loadavg1m.toFixed(2) + '</span> (1m) · <span style="opacity:0.7">' + c.loadavg5m.toFixed(2) + '</span> (5m) · <span style="opacity:0.6">' + c.loadavg15m.toFixed(2) + '</span> (15m) · ' + c.cores + ' cores</div>';
        html += '<div style="height:8px;background:var(--border-color);border-radius:4px;overflow:hidden;">';
        html += '<div style="height:100%;width:' + loadBarWidth + '%;background:' + loadColor + ';border-radius:4px;transition:width 0.3s;"></div>';
        html += '</div>';
        html += '</div>';
      }
      // Disk section
      if (d) {
        html += '<div>';
        html += '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">💾 ' + fmtDisk(d.used) + ' / ' + fmtDisk(d.total) + ' · ' + diskPct + '% used · ' + Math.round((d.free / d.total) * 100) + '% free</div>';
        html += '<div style="height:6px;background:var(--border-color);border-radius:3px;overflow:hidden;">';
        html += '<div style="height:100%;width:' + diskPct + '%;background:#a78bfa;border-radius:3px;"></div>';
        html += '</div>';
        html += '</div>';
      }
      // Uptime
      if (p) html += '<div style="font-size:11px;color:var(--text-muted);">⏱ ' + uptimeStr + ' · Node.js ' + p.nodeVersion + '</div>';
      html += '</div>';
      document.getElementById('aboutSystemStats').innerHTML = html;
    }).catch(() => {});
}
function closeAboutModal() { unlockScroll(); document.getElementById('aboutModal').classList.remove('show'); }

function showShareLinksModal() {
  fetch(API + '/api/share/list', { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      if (!data.success) { showToast(T('share.getLinkFailed')); return; }
      const links = data.links || [];
      const el = document.getElementById('shareLinksList');
      if (!el) return;
      if (!links.length) {
        el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">' + T('share.noLinks') + '</div>';
      } else {
        el.innerHTML = '<div style="display:flex;flex-direction:column;gap:8px;">' + links.map(l => {
          const url = location.origin + '/s/' + l.code + (l.password ? '?pwd=' : '');
          const isExpired = l.expiresAt && l.expiresAt !== MAX_TS && l.expiresAt < Date.now();
          const expires = (l.expiresAt === MAX_TS || !l.expiresAt) ? T('share.neverExpire') : (isExpired ? T('share.expired') : T('share.daysLeft') + ' ' + Math.ceil((l.expiresAt - Date.now()) / 86400000) + ' ' + T('share.day'));
          return '<div style="padding:12px;background:var(--bg-tertiary);border-radius:8px;display:flex;flex-direction:column;gap:6px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
              '<span style="font-weight:600;cursor:pointer;" onclick="copyText(\'' + l.filename.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\')" title="Click to copy filename">' + escapeHtml(l.filename) + (l.password ? ' 🔒' : '') + '</span>' +
              '<span style="font-size:11px;color:' + (isExpired ? 'var(--danger)' : 'var(--text-muted)') + ';">' + (isExpired ? T('share.expired') : expires) + '</span>' +
            '</div>' +
            '<div style="display:flex;gap:16px;font-size:11px;color:var(--text-muted);">' +
              '<span>📥 ' + (l.downloadCount || 0) + (l.maxDownloads ? ' / ' + l.maxDownloads : '') + ' ' + T('share.downloads') + '</span>' +
              '<span>🕐 ' + (l.createdAt ? new Date(l.createdAt * 1000).toLocaleDateString() : '—') + '</span>' +
            '</div>' +
            '<div style="font-size:11px;font-family:monospace;color:var(--text-muted);word-break:break-all;">' + escapeHtml(url) + '</div>' +
            (l.description ? '<div style="font-size:12px;color:var(--accent-secondary);margin-top:4px;">' + T('share.description') + ': ' + escapeHtml(l.description) + '</div>' : '') +
            '<div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">' +
              '<button class="btn btn-sm" onclick="copyShareLinkOf(\'' + l.code.replace(/'/g, "\\'") + '\', \'' + escapeHtml(url) + '\')">' + T('share.copyLink') + '</button>' +
              '<button class="btn btn-sm" onclick="emailShareLinkOf(\'' + l.code.replace(/'/g, "\\'") + '\')">✉️</button>' +
              '<button class="btn btn-sm" onclick="emailShareLink(\'' + l.code.replace(/'/g, "\\'") + '\', \'' + escapeHtml(l.filename).replace(/'/g, "\\'") + '\')">' + T('share.email') + '</button>' +
              '<button class="btn btn-sm" onclick="showShareLinkQR(\'' + l.code.replace(/'/g, "\\'") + '\')">' + T('share.qrCode') + '</button>' +
              '<button class="btn btn-sm" onclick="showEditShareLinkModal(\'' + l.code.replace(/'/g, "\\'") + '\')">' + T('ui.edit') + '</button>' +
              '<button class="btn btn-sm btn-danger" onclick="deleteShareLink(\'' + l.code.replace(/'/g, "\\'") + '\')">' + T('tag.delete') + '</button>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';
      }
      lockScroll();
      document.getElementById('shareLinksModal').classList.add('show');
    }).catch(() => showToast(T('share.getLinkFailed')));
}

function copyShareLinkOf(code, url) {
  navigator.clipboard.writeText(url).then(() => showToast(T('share.linkCopied'))).catch(() => showToast(T('share.linkCopyFailed')));
}

function emailShareLinkOf(code) {
  const shareUrl = location.origin + '/s/' + code + '?utm_source=sharetool&utm_medium=email_button&utm_campaign=sharetool';
  window.open('mailto:?subject=' + encodeURIComponent('与你分享文件') + '&body=' + encodeURIComponent('我通过 ShareTool 向你分享了文件。\n\n点击查看: ' + shareUrl + '\n\n—— via ShareTool'), '_blank');
}

function emailShareLink(code, filename) {
  // Build URL with UTM parameters for analytics
  const baseUrl = location.origin + '/s/' + code;
  const shareUrl = baseUrl + '?utm_source=sharetool&utm_medium=share_link&utm_campaign=email_share';
  const subject = encodeURIComponent('与你分享: ' + filename);
  const body = encodeURIComponent('我通过 ShareTool 向你分享了文件「' + filename + '」\n\n点击查看: ' + shareUrl + '\n\n—— via ShareTool');
  window.open('mailto:?subject=' + subject + '&body=' + body, '_blank');
}

function showShareLinkQR(code) {
  // Reuse the QR modal
  showShareQRModalForCode(code);
}

function showShareQRModalForCode(code) {
  const url = location.origin + '/s/' + code;
  const modal = document.getElementById('qrModal');
  const content = document.getElementById('qrModalContent');
  const urlEl = document.getElementById('qrModalUrl');
  if (modal && content && urlEl) {
    content.innerHTML = '<div style="font-size:40px;animation:spin 1s linear infinite;">⏳</div><div style="margin-top:8px;color:var(--text-muted);">' + T('msg.loading') + '</div>';
    urlEl.textContent = url;
    modal.classList.add('show');
    fetch(API + '/api/share/qr/' + code, { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
      .then(r => r.json())
      .then(qrData => {
        if (qrData.success && qrData.dataUrl) {
          content.innerHTML = '<img src="' + qrData.dataUrl + '" style="border-radius:8px;max-width:256px;width:100%;" />';
        } else {
          content.innerHTML = '<div style="color:var(--danger-fg);">' + T('err.genFailed') + '</div>';
        }
      })
      .catch(e => { content.innerHTML = '<div style="color:var(--danger-fg);">' + T('err.reqFailed') + '</div>'; });
  }
}

function deleteExpiredShares() {
  if (!confirm(T('share.confirmDeleteExpired') || 'Delete all expired share links?')) return;
  fetch(API + '/api/share/list', { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      if (!data.success || !data.links) return;
      const expired = (data.links || []).filter(l => l.expiresAt && l.expiresAt !== MAX_TS && l.expiresAt < Date.now());
      if (!expired.length) { showToast(T('share.noExpired')); return; }
      Promise.all(expired.map(l =>
        fetch(API + '/api/share/delete/' + l.code, { method: 'DELETE', headers: { 'x-auth-token': AUTH_TOKEN || '' } })
          .then(r => r.json())
      )).then(results => {
        const ok = results.filter(r => r.success).length;
        showToast('✓ ' + ok + ' ' + (T('share.deletedExpired') || 'expired links deleted'));
        showShareLinksModal();
      });
    });
}

function deleteShareLink(code) {
  if (!confirm(T('share.confirmDelete'))) return;
  fetch(API + '/api/share/delete/' + code, { method: 'DELETE', headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        showToast('✓ ' + T('file.deleted'));
        showShareLinksModal(); // Refresh
      } else {
        showToast(T('file.deleteFailed'));
      }
    }).catch(() => showToast(T('file.deleteFailed')));
}

function showEditShareLinkModal(code) {
  // Fetch current link data and populate edit form
  fetch(API + '/api/share/list', { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      if (!data.success) { showToast(T('err.reqFailed')); return; }
      const link = (data.links || []).find(l => l.code === code);
      if (!link) { showToast(T('err.notFound')); return; }
      document.getElementById('editShareCode').value = code;
      document.getElementById('editShareFilename').textContent = link.filename;
      // Compute current expiryHours from expiresAt
      const MAX_TS_MS = 32503680000000;
      const expiryEl = document.getElementById('editShareExpiryHours');
      if (link.expiresAt && link.expiresAt !== MAX_TS_MS) {
        const hoursLeft = Math.max(1, Math.ceil((link.expiresAt - Date.now()) / 3600000));
        if (hoursLeft <= 24) expiryEl.value = '24';
        else if (hoursLeft <= 72) expiryEl.value = '72';
        else if (hoursLeft <= 168) expiryEl.value = '168';
        else if (hoursLeft <= 720) expiryEl.value = '720';
        else expiryEl.value = '0';
      } else {
        expiryEl.value = '0';
      }
      document.getElementById('editShareMaxDownloads').value = link.maxDownloads || '';
      document.getElementById('editSharePassword').value = '';
      document.getElementById('editShareDescription').value = link.description || '';
      lockScroll();
      document.getElementById('editShareLinkModal').classList.add('show');
    }).catch(() => showToast(T('err.reqFailed')));
}

function doUpdateShareLink() {
  const code = document.getElementById('editShareCode').value;
  const expiryHours = parseInt(document.getElementById('editShareExpiryHours').value) || 0;
  const maxDownloads = parseInt(document.getElementById('editShareMaxDownloads').value) || null;
  const password = document.getElementById('editSharePassword').value || null;
  const description = document.getElementById('editShareDescription').value || '';
  closeEditShareLinkModal();
  fetch(API + '/api/share/update/' + code, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
    body: JSON.stringify({ expiryHours, maxDownloads, password, description })
  })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        showToast('✓ ' + T('ui.saved'));
        showShareLinksModal(); // Refresh
      } else {
        showToast(T('ui.saveFailed') + ': ' + data.error);
      }
    }).catch(e => showToast(T('ui.saveFailed') + ': ' + e.message));
}

function closeEditShareLinkModal() {
  unlockScroll();
  document.getElementById('editShareLinkModal').classList.remove('show');
}

let _auditAllLogs = [];

function showAuditModal() {
  const filterAction = document.getElementById('auditFilterAction')?.value || '';
  const filterDate = document.getElementById('auditFilterDate')?.value || '';
  let url = API + '/api/audit/logs?limit=500';
  if (filterAction) url += '&action=' + encodeURIComponent(filterAction);
  if (filterDate) url += '&date=' + filterDate;
  fetch(url, { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      if (!data.success) { showToast(T('admin.getFailed')); return; }
      const stats = data.stats || {};
      document.getElementById('auditStats').innerHTML =
        '<div style="background:var(--bg-tertiary);padding:8px 14px;border-radius:8px;font-size:12px;"><div style="color:var(--text-muted);">' + T('admin.todayOps') + '</div><div style="font-size:20px;font-weight:600;color:var(--accent-primary)">' + (stats.todayCount || 0) + '</div></div>' +
        '<div style="background:var(--bg-tertiary);padding:8px 14px;border-radius:8px;font-size:12px;"><div style="color:var(--text-muted);">' + T('admin.totalOps') + '</div><div style="font-size:20px;font-weight:600;color:var(--accent-primary)">' + (stats.totalCount || 0) + '</div></div>' +
        '<div style="background:var(--bg-tertiary);padding:8px 14px;border-radius:8px;font-size:12px;"><div style="color:var(--text-muted);">' + T('admin.lastOp') + '</div><div style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(stats.lastAction || '--') + '</div></div>';

      // Build action filter dropdown
      const allActions = [...new Set(data.logs.map(l => l.action).filter(Boolean))].sort();
      const filterSel = document.getElementById('auditFilterAction');
      if (filterSel) {
        const current = filterSel.value;
        filterSel.innerHTML = '<option value="">' + T('ui.all') + '</option>' +
          allActions.map(a => '<option value="' + escapeHtml(a) + '"' + (a === current ? ' selected' : '') + '>' + escapeHtml(a) + '</option>').join('');
      }

      // Action breakdown chart
      const chartDiv = document.getElementById('auditChart');
      const chartBars = document.getElementById('auditChartBars');
      if (allActions.length > 0) {
        const actionCounts = {};
        data.logs.forEach(l => { if (l.action) actionCounts[l.action] = (actionCounts[l.action] || 0) + 1; });
        const maxCount = Math.max(...Object.values(actionCounts));
        const colors = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#14b8a6'];
        let colorIdx = 0;
        chartBars.innerHTML = Object.entries(actionCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([action, count]) => {
            const pct = maxCount > 0 ? (count / maxCount * 100) : 0;
            const color = colors[colorIdx++ % colors.length];
            return '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">' +
              '<div style="width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);">' + escapeHtml(action) + '</div>' +
              '<div style="flex:1;background:var(--bg-tertiary);border-radius:4px;height:16px;overflow:hidden;">' +
                '<div style="width:' + pct + '%;background:' + color + ';height:100%;border-radius:4px;transition:width 0.3s;"></div>' +
              '</div>' +
              '<div style="width:28px;text-align:right;color:var(--text-muted);">' + count + '</div>' +
            '</div>';
          }).join('');
        chartDiv.style.display = 'block';
      } else {
        chartDiv.style.display = 'none';
      }

      const logs = data.logs || [];
      document.getElementById('auditLogList').innerHTML = logs.length ? logs.map(l =>
        '<div style="padding:8px 0;border-bottom:1px solid var(--border-color);display:flex;justify-content:space-between;gap:12px;">' +
          '<div><div style="color:var(--text-primary);">' + escapeHtml(l.action || '') + '</div><div style="color:var(--text-muted);font-size:11px;margin-top:2px;">' + escapeHtml(l.detail || '') + '</div></div>' +
          '<div style="text-align:right;flex-shrink:0;"><div style="color:var(--text-muted);font-size:11px;">' + formatTime((l.created_at || 0) * 1000) + '</div>' +
          (l.ip ? '<div style="color:var(--text-muted);font-size:10px;font-family:monospace;">' + escapeHtml(l.ip) + '</div>' : '') +
          '</div></div>'
      ).join('') : '<div style="padding:20px;text-align:center;color:var(--text-muted);">' + T('admin.noLogs') + '</div>';
      lockScroll();
      document.getElementById('auditModal').classList.add('show');
    }).catch(() => showToast(T('admin.getFailed')));
}

async function exportAudit(format) {
  try {
    const url = API + '/api/audit/export?format=' + format;
    const res = await fetch(url, { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const contentType = format === 'json' ? 'application/json' : 'text/csv';
    const blobUrl = URL.createObjectURL(new Blob([blob], { type: contentType }));
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = 'audit_log_' + new Date().toISOString().slice(0, 10) + '.' + format;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
    showToast(T('admin.exported') || (format.toUpperCase() + ' exported'));
  } catch (e) {
    showToast('Export failed: ' + e.message, 'error');
  }
}

function showTokenModal() {
  lockScroll();
  document.getElementById('tokenModal').classList.add('show');
  document.getElementById('newTokenInput').value = '';
  document.getElementById('newTokenInput').focus();
}

async function refreshToken() {
  try {
    const res = await fetch(API + '/api/token/refresh', { method: 'POST', headers: { 'x-refresh-token': REFRESH_TOKEN || '' } });
    const data = await res.json();
    if (data.success) {
      AUTH_TOKEN = data.token;
      REFRESH_TOKEN = data.refreshToken;
      localStorage.setItem('sharetool_token', AUTH_TOKEN);
      localStorage.setItem('sharetool_refresh_token', REFRESH_TOKEN);
      updateTokenDisplay(AUTH_TOKEN, data.expiresAt);
      showToast(T('admin.tokenRefreshed'));
    } else {
      showToast(T('admin.refreshFailed') + ': ' + (data.error || ''));
    }
  } catch (e) { showToast(T('admin.refreshFail')); }
}

async function manualRenewCert() {
  const btn = event.target;
  if (btn) { btn.disabled = true; btn.textContent = T('admin.renewing'); }
  try {
    const res = await fetch(API + '/api/admin/renew-cert', { method: 'POST', headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success) {
      showToast(T('admin.renewed'));
      loadSettings(); // Refresh status display
    } else {
      showToast(T('admin.renewFailed') + ' ' + (data.error || T('admin.unknown')), 'error');
    }
  } catch (e) { showToast(T('admin.renewReqFailed'), 'error'); }
  if (btn) { btn.disabled = false; btn.textContent = '🔄 ' + T('admin.renew'); }
}

function formatBytes(b) {
  if (b === 0) return '0 B';
  const k = 1024;
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function loadDashboard() {
  const el = document.getElementById('dashboardStats');
  const chartEl = document.getElementById('dashboardChart');
  if (!el) return;
  try {
    const res = await fetch(API + '/api/dashboard', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.success) return;

    const { files, storage, activity, shares, devices, tokens, sync } = data;
    const f = files || {};
    const s = storage || {};
    const d = devices || {};
    const sh = shares || {};
    const tk = tokens || {};

    const statCards = [
      { label: '📁 文件', value: f.total || 0 },
      { label: '💾 存储', value: formatBytes(s.total || 0) },
      { label: '⭐ 收藏', value: f.starred || 0 },
      { label: '🗑 回收站', value: f.trash || 0 },
      { label: '🔗 分享', value: sh.active || 0 },
      { label: '📡 设备', value: d.total || 0 },
      { label: '🔐 Token', value: tk.active || 0 },
      { label: '📊 同步', value: sync.unsynced || 0 },
    ];

    el.innerHTML = statCards.map(stat =>
      '<div style="background:var(--bg-tertiary);padding:8px 12px;border-radius:8px;text-align:center;">' +
      '<div style="font-size:16px;font-weight:600;">' + stat.value + '</div>' +
      '<div style="font-size:10px;color:var(--text-muted);white-space:nowrap;">' + stat.label + '</div>' +
      '</div>'
    ).join('');

    // 7-day bar chart
    const daily = activity?.dailyNew || [];
    const maxCount = Math.max(...daily.map(item => item.count), 1);
    const barMaxH = 36;
    chartEl.innerHTML = daily.map(item => {
      const barH = Math.max(3, Math.round((item.count / maxCount) * barMaxH));
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:2px;">' +
        '<div style="width:100%;max-width:28px;background:var(--accent-primary);border-radius:2px 2px 0 0;height:' + barH + 'px;" title="' + item.count + ' files"></div>' +
        '<div style="font-size:8px;color:var(--text-muted);">' + item.date + '</div>' +
        '</div>';
    }).join('');

    // Type distribution donut chart
    const typeEl = document.getElementById('dashboardTypeChart');
    const byType = data.byType || [];
    if (typeEl && byType.length > 0) {
      const totalFiles = (files?.total) || 1;
      const COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#667eea'];
      // Build conic-gradient segments
      let gradientStops = [];
      let accumulatedPercent = 0;
      byType.slice(0, 10).forEach((item, i) => {
        const percent = Math.round((item.count / totalFiles) * 100);
        if (percent > 0) {
          gradientStops.push(COLORS[i % COLORS.length] + ' ' + accumulatedPercent + '% ' + (accumulatedPercent + percent) + '%');
          accumulatedPercent += percent;
        }
      });
      const bg = gradientStops.length > 0 ? 'conic-gradient(' + gradientStops.join(', ') + ')' : 'none';

      typeEl.innerHTML =
        '<div style="width:52px;height:52px;border-radius:50%;background:' + bg + ';position:relative;flex-shrink:0;">' +
        '<div style="position:absolute;inset:8px;background:var(--bg-secondary);border-radius:50%;"></div>' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start;">' +
        byType.slice(0, 8).map((item, i) => {
          const pct = Math.round((item.count / totalFiles) * 100);
          return '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-secondary);">' +
            '<div style="width:8px;height:8px;border-radius:50%;background:' + (COLORS[i % COLORS.length]) + ';flex-shrink:0;"></div>' +
            '<span>' + escapeHtml(item.type || 'file') + ' ' + pct + '%</span>' +
            '</div>';
        }).join('') +
        '</div>';
    } else if (typeEl) {
      typeEl.innerHTML = '<div style="font-size:10px;color:var(--text-muted);">暂无数据</div>';
    }

    // Recent activity feed: fetch latest audit logs
    renderDashboardActivityFeed();

  } catch (e) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">加载失败</div>';
  }
}

async function renderDashboardActivityFeed() {
  const el = document.getElementById('dashboardActivityFeed');
  if (!el) return;
  try {
    const res = await fetch(API + '/api/audit/logs?limit=8', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.success || !data.logs || !data.logs.length) {
      el.innerHTML = '<div style="font-size:10px;color:var(--text-muted);">暂无活动记录</div>';
      return;
    }
    const ACTION_ICONS = {
      file_upload: '📤', file_delete: '🗑', file_rename: '✏️', share_create: '🔗',
      share_access: '👁', share_delete: '🗑', token_create: '🔑', token_revoke: '🔓',
      login: '🔐', logout: '🔒', audit_export: '📥', audit_query: '🔍',
      settings_change: '⚙️', device_register: '📱', device_remove: '📱',
    };
    const ACTION_LABELS = {
      file_upload: '上传', file_delete: '删除', file_rename: '重命名',
      share_create: '创建分享', share_access: '访问分享', share_delete: '删除分享',
      token_create: '创建 Token', token_revoke: '撤销 Token',
      login: '登录', logout: '登出', audit_export: '导出日志', audit_query: '查询日志',
      settings_change: '设置变更', device_register: '注册设备', device_remove: '移除设备',
    };
    el.innerHTML = data.logs.slice(0, 8).map(l => {
      const icon = ACTION_ICONS[l.action] || '📋';
      const label = ACTION_LABELS[l.action] || l.action;
      const detail = (l.details || '').length > 30 ? (l.details || '').substring(0, 30) + '…' : (l.details || '');
      const time = new Date(l.timestamp * 1000);
      const timeStr = time.toLocaleDateString() + ' ' + time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const shortDetail = detail ? '<span style="color:var(--text-muted);font-size:9px;">' + escapeHtml(detail) + '</span>' : '';
      return '<div style="display:flex;align-items:center;gap:6px;font-size:10px;padding:3px 0;border-bottom:1px solid var(--border-color);">' +
        '<span style="flex-shrink:0;">' + icon + '</span>' +
        '<span style="flex:1;color:var(--text-secondary);">' + escapeHtml(label) + '</span>' +
        shortDetail +
        '<span style="color:var(--text-muted);flex-shrink:0;font-size:9px;">' + timeStr + '</span>' +
        '</div>';
    }).join('');
  } catch (e) {
    el.innerHTML = '<div style="font-size:10px;color:var(--text-muted);">加载失败</div>';
  }
}

async function loadRateLimitStatus() {
  try {
    const res = await fetch(API + '/api/admin/rate-limit', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success) {
      const c = data.config;
      document.getElementById('rateLimitStatus').textContent = 'maxAttempts=' + c.maxAttempts + ', window=' + c.windowSeconds + 's, lockout=' + c.lockoutSeconds + 's';
    } else {
      document.getElementById('rateLimitStatus').innerHTML = T('admin.getFailed');
    }
  } catch (e) {
    document.getElementById('rateLimitStatus').innerHTML = T('admin.getFailed');
  }
}

async function showRateLimitModal() {
  try {
    const res = await fetch(API + '/api/admin/rate-limit', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (!data.success) { showToast('fetch config failed', 'error'); return; }
    const c = data.config;
    var html = '<div style="display:flex;flex-direction:column;gap:16px;">';
    html += '<div><div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Max attempts</div>';
    html += '<input type="number" id="rlMaxAttempts" value="' + c.maxAttempts + '" min="1" max="100" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;"></div>';
    html += '<div><div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Window (seconds)</div>';
    html += '<input type="number" id="rlWindow" value="' + c.windowSeconds + '" min="60" max="86400" step="60" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;"></div>';
    html += '<div><div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Lockout (seconds)</div>';
    html += '<input type="number" id="rlLockout" value="' + c.lockoutSeconds + '" min="30" max="86400" step="30" style="width:100%;padding:8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:16px;"></div>';
    html += '<div style="font-size:11px;color:var(--text-muted);">Changes take effect immediately</div>';
    html += '<button class="btn" onclick="saveRateLimitConfig()" style="width:100%;">Save</button></div>';
    openModal('Rate Limit Config', html, 'modal-small');
  } catch (e) { showToast('load failed', 'error'); }
}

async function saveRateLimitConfig() {
  const maxAttempts = parseInt(document.getElementById('rlMaxAttempts').value);
  const windowSeconds = parseInt(document.getElementById('rlWindow').value);
  const lockoutSeconds = parseInt(document.getElementById('rlLockout').value);
  try {
    const res = await fetch(API + '/api/admin/rate-limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ maxAttempts, windowSeconds, lockoutSeconds })
    });
    const data = await res.json();
    if (data.success) {
      showToast(T('admin.configSaved'));
      closeModal();
      loadRateLimitStatus();
    } else {
      showToast(T('admin.saveFailed') + ' ' + (data.error || T('admin.unknown')), 'error');
    }
  } catch (e) { showToast(T('admin.saveReqFailed'), 'error'); }
}

function updateTokenDisplay(token, expiresAt) {
  const el = document.getElementById('currentTokenDisplay');
  if (!el) return;
  if (!token) { el.textContent = '(' + T('admin.none').replace(/^\(|\)$/g, '') + ')'; el.style.color = 'var(--text-muted)'; return; }
  el.textContent = token;
  el.style.color = '';
  // 如果有过期时间，显示剩余天数
  const expEl = document.getElementById('tokenExpiresAt');
  if (expiresAt && expiresAt !== 32503680000) {
    const now = Date.now();
    if (expiresAt > now) {
      const daysLeft = Math.ceil((expiresAt - now) / 86400000);
      const expText = T('admin.daysLeft', {n: daysLeft});
      if (expEl) { expEl.textContent = expText; expEl.style.color = daysLeft <= 7 ? 'var(--warning)' : 'var(--text-muted)'; }
      else {
        const span = document.createElement('span');
        span.id = 'tokenExpiresAt';
        span.style.cssText = 'font-size:11px;margin-left:8px;color:var(--text-muted);';
        span.textContent = expText;
        el.parentNode.insertBefore(span, el.nextSibling);
      }
    } else {
      if (expEl) expEl.textContent = T('admin.expired');
      else {
        const span = document.createElement('span');
        span.id = 'tokenExpiresAt';
        span.style.cssText = 'font-size:11px;margin-left:8px;color:var(--danger);';
        span.textContent = T('admin.expired');
        el.parentNode.insertBefore(span, el.nextSibling);
      }
    }
  } else if (expEl) { expEl.remove(); }
}

async function doSetToken() {
  const newToken = document.getElementById('newTokenInput').value.trim();
  try {
    const res = await fetch(API + '/api/token/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ token: newToken })
    });
    const data = await res.json();
    if (data.success) {
      AUTH_TOKEN = data.token || AUTH_TOKEN || newToken || crypto.randomUUID();
      if (data.refreshToken) {
        REFRESH_TOKEN = data.refreshToken;
        localStorage.setItem('sharetool_refresh_token', REFRESH_TOKEN);
      }
      localStorage.setItem('sharetool_token', AUTH_TOKEN);
      updateTokenDisplay(AUTH_TOKEN, data.expiresAt || null);
      closeTokenModal();
      showToast(T('admin.tokenUpdated'));
    } else {
      showToast(T('admin.updateFailed') + ': ' + (data.error || ''));
    }
  } catch (e) { showToast(T('admin.updateFail')); }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeShortcutModal();
    closeAuditModal();
    closeTokenModal();
    focusedFileIndex = -1;
    refreshFileFocus();
  }
  // Don't interfere with typing in inputs (except / to override)
  const tag = e.target.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (e.key === '/') {
    e.preventDefault();
    const el = document.getElementById('searchInput');
    if (el) { el.focus(); el.select(); }
  } else if (isInput) {
    // Enter in search input triggers search (or apply selected suggestion)
    if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedSuggestionIndex >= 0 && currentSuggestions.length > 0) {
        const sel = currentSuggestions[selectedSuggestionIndex];
        applySuggestion(sel.text, sel.type);
      } else {
        doSearch();
      }
    }
    // Arrow keys for suggestion navigation
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (currentSuggestions.length > 0) {
        selectedSuggestionIndex = Math.min(selectedSuggestionIndex + 1, currentSuggestions.length - 1);
        updateSuggestionSelection();
      }
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentSuggestions.length > 0) {
        selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, -1);
        updateSuggestionSelection();
      }
    }
    // Escape in input: blur and hide suggestions
    if (e.key === 'Escape' && (tag === 'INPUT' || tag === 'TEXTAREA')) {
      hideSuggestions();
      e.target.blur();
    }
    return;
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    toggleFavFilter();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    loadFiles();
    showToast(T('admin.refreshed'));
  } else if (e.key === '?' && !isTouchDevice()) {
    // Hide ? shortcut hint on touch devices - they don't have keyboards
    e.preventDefault();
    lockScroll();
    document.getElementById('shortcutModal').classList.add('show');
  } else if (e.key === 'n' || e.key === 'N') {
    // n: new upload (trigger hidden file input)
    e.preventDefault();
    const inp = document.getElementById('fileInput');
    if (inp) inp.click();
  } else if (e.key === 'm' || e.key === 'M') {
    // m: quick text note
    e.preventDefault();
    const textarea = document.getElementById('textContent');
    const shareTextBtn = document.getElementById('shareTextBtn');
    if (textarea && shareTextBtn) {
      const shareModal = document.getElementById('shareTextModal');
      if (shareModal) shareModal.classList.add('show');
      textarea.focus();
    }
  } else if (e.key === 'ArrowLeft') {
    // Arrow keys for image lightbox navigation
    const modal = document.getElementById('fileModal');
    if (modal && modal.classList.contains('show') && modal.dataset.imageMode === '1') {
      e.preventDefault();
      imageNav(-1);
    }
  } else if (e.key === 'ArrowRight') {
    const modal = document.getElementById('fileModal');
    if (modal && modal.classList.contains('show') && modal.dataset.imageMode === '1') {
      e.preventDefault();
      imageNav(1);
    }
  } else if (e.key === 's' || e.key === 'S') {
    // s: star/favorite focused file
    e.preventDefault();
    const items = getVisibleFileItems();
    if (focusedFileIndex >= 0 && items[focusedFileIndex]) {
      const fn = items[focusedFileIndex].dataset.filename;
      if (fn) toggleFavorite(decodeURIComponent(fn));
    }
  } else if (e.key === 'a' || e.key === 'A') {
    // a: select all files
    e.preventDefault();
    const cbs = document.querySelectorAll('.batch-checkbox');
    const allChecked = Array.from(cbs).every(cb => cb.checked);
    cbs.forEach(cb => cb.checked = !allChecked);
    updateBatchBar();
  } else if (e.key === 'g' || e.key === 'G') {
    // g: go to root (when not in input)
    e.preventDefault();
    if (currentPath !== '/') { currentPath = '/'; loadFiles(); }
  } else if (e.key === 'j' || e.key === 'J') {
    // j: move focus down
    e.preventDefault();
    const items = getVisibleFileItems();
    if (items.length === 0) return;
    if (focusedFileIndex < 0) focusedFileIndex = 0;
    else focusedFileIndex = Math.min(focusedFileIndex + 1, items.length - 1);
    refreshFileFocus();
    items[focusedFileIndex].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'k' || e.key === 'K') {
    // k: move focus up
    e.preventDefault();
    const items = getVisibleFileItems();
    if (items.length === 0) return;
    if (focusedFileIndex < 0) focusedFileIndex = items.length - 1;
    else focusedFileIndex = Math.max(focusedFileIndex - 1, 0);
    refreshFileFocus();
    items[focusedFileIndex].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'x' || e.key === 'X') {
    // x: toggle select focused file
    e.preventDefault();
    const items = getVisibleFileItems();
    if (focusedFileIndex >= 0 && items[focusedFileIndex]) {
      const el = items[focusedFileIndex];
      const cb = el.querySelector('.batch-checkbox');
      if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
    }
  } else if (e.key === 'v' || e.key === 'V') {
    // v: toggle grid/list view
    e.preventDefault();
    const gridView = document.getElementById('gridView');
    const listView = document.getElementById('listView');
    if (gridView && listView) {
      const isGrid = gridView.style.display !== 'none';
      if (isGrid) {
        gridView.style.display = 'none';
        listView.style.display = 'block';
        localStorage.setItem('sharetool_view', 'list');
      } else {
        gridView.style.display = 'grid';
        listView.style.display = 'none';
        localStorage.setItem('sharetool_view', 'grid');
      }
    }
  } else if (e.key === 't' || e.key === 'T') {
    // t: batch tag selected files (or focused file if none selected)
    e.preventDefault();
    const checked = document.querySelectorAll('.batch-checkbox:checked');
    if (checked.length > 0) {
      const filenames = Array.from(checked).map(cb => decodeURIComponent(cb.value));
      openBatchTagModal(filenames);
    } else if (focusedFileIndex >= 0) {
      const items = getVisibleFileItems();
      const fn = items[focusedFileIndex]?.dataset.filename;
      if (fn) openBatchTagModal([decodeURIComponent(fn)]);
    }
  } else if (e.key === 'c' || e.key === 'C') {
    // c: copy share link of focused file
    e.preventDefault();
    const items = getVisibleFileItems();
    if (focusedFileIndex >= 0 && items[focusedFileIndex]) {
      const fn = items[focusedFileIndex].dataset.filename;
      if (fn) copyShareLinkByFilename(decodeURIComponent(fn));
    }
  } else if (e.key === 'Enter') {
    // Enter: open focused file
    e.preventDefault();
    const items = getVisibleFileItems();
    if (focusedFileIndex >= 0 && items[focusedFileIndex]) {
      const el = items[focusedFileIndex];
      const fn = el.dataset.filename;
      if (fn) {
        const decoded = decodeURIComponent(fn);
        const isImage = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(decoded);
        const isVirtualFolder = virtualFolders.some(vf => vf.name === decoded);
        if (!isVirtualFolder) {
          if (isImage) { openImageModal(decoded); return; }
          if (isCodeFile(decoded)) { openCodeModal(decoded); return; }
          if (isAudioFile(decoded) || isVideoFile(decoded)) { openMediaModal(decoded); return; }
          if (isPdfFile(decoded)) { openPdfModal(decoded); return; }
          if (isOfficeFile(decoded)) { openOfficeModal(decoded); return; }
          openFileModal(decoded);
        }
      }
    }
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && focusedFileIndex >= 0) {
    // Delete: delete focused file (with confirmation)
    e.preventDefault();
    const items = getVisibleFileItems();
    if (items[focusedFileIndex]) {
      const fn = items[focusedFileIndex].dataset.filename;
      if (fn && confirm(T('ui.confirmDelete') + ' ' + decodeURIComponent(fn) + '？')) {
        deleteFile(decodeURIComponent(fn));
      }
    }
  }
});

function getVisibleFileItems() {
  return Array.from(document.querySelectorAll('.file-item[data-filename]'));
}

function refreshFileFocus() {
  document.querySelectorAll('.file-item.focused').forEach(el => el.classList.remove('focused'));
  const items = getVisibleFileItems();
  if (focusedFileIndex >= 0 && items[focusedFileIndex]) {
    items[focusedFileIndex].classList.add('focused');
  }
}

function applySearchHighlight(q) {
  if (!q || !q.trim()) return;
  const targets = document.querySelectorAll('.search-target');
  // Escape regex special chars for safe text matching
  var s = q.trim().replace(/[\[\\\]\\*\.\+\?\^\$\{\}\(\)\|\-]/g, '\\\\$&');
  try {
    const regex = new RegExp('(' + s + ')', 'gi');
    targets.forEach(el => {
      const text = el.textContent || '';
      if (!regex.test(text)) return;
      regex.lastIndex = 0;
      const fragments = text.split(regex);
      regex.lastIndex = 0;
      el.innerHTML = '';
      fragments.forEach(frag => {
        if (!frag) return;
        if (regex.test(frag)) {
          regex.lastIndex = 0;
          const span = document.createElement('span');
          span.className = 'search-highlight';
          span.textContent = frag;
          el.appendChild(span);
        } else {
          el.appendChild(document.createTextNode(frag));
        }
      });
    });
  } catch (e) {}
}

async function removeTag(filename, tag) {
  const decodedTag = tag;
  try {
    const res = await fetch(API + '/api/file-tags/' + filename + '?action=remove', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ tags: decodedTag })
    });
    const data = await res.json();
    if (data.success) {
      showToast(T('tag.removed'));
      loadFiles();
    }
  } catch (e) {}
}

function filterByTag(tag) {
  const input = document.getElementById('searchInput');
  const existing = input.value.trim();
  const tagExpr = 'tag:' + tag;

  // Remove any existing instance of this tag using simple string replace
  let cleaned = existing.split(/\s+/).filter(t => t !== tagExpr && t !== 'tag:' + tag).join(' ');

  // Append new tag
  const newQ = cleaned ? cleaned + ' ' + tagExpr : tagExpr;
  input.value = newQ;
  window.currentSearchQ = newQ;
  doSearch();
  // Ensure toggle button text is current
  const toggle = document.getElementById('tagMatchToggle');
  if (toggle) toggle.textContent = window.currentTagMatch === 'any' ? 'OR' : 'AND';
}

function changeSort(value) { setSort(value); }

function applySort(files) {
  if (currentSort === 'manual') {
    // Manual sort: apply localStorage custom order
    const customOrder = getCustomFileOrder();
    const sorted = [...files];
    sorted.sort((a, b) => {
      const ai = customOrder[a.name];
      const bi = customOrder[b.name];
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return 0;
    });
    return sorted;
  }
  const [field, dir] = currentSort.split('_');
  const sorted = [...files];
  sorted.sort((a, b) => {
    let va, vb;
    if (field === 'time') {
      va = a.time || 0;
      vb = b.time || 0;
    } else if (field === 'name') {
      va = (a.name || '').toLowerCase();
      vb = (b.name || '').toLowerCase();
    } else if (field === 'size') {
      va = a.size || 0;
      vb = b.size || 0;
    } else if (field === 'type') {
      const extA = (a.name || '').includes('.') ? (a.name || '').split('.').pop().toLowerCase() : '';
      const extB = (b.name || '').includes('.') ? (b.name || '').split('.').pop().toLowerCase() : '';
      va = extA;
      vb = extB;
    } else if (field === 'tag') {
      va = a.tags || '';
      vb = b.tags || '';
    } else if (field === 'download') {
      va = a.dl_count || 0;
      vb = b.dl_count || 0;
    }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  return sorted;
}

function setSort(value) {
  if (value === 'manual') {
    // 手动排序：使用 localStorage 中的自定义顺序，不触发服务器重载
    localStorage.setItem('sharetool_sort', 'position');
    localStorage.setItem('sharetool_order', 'asc');
    currentSort = 'manual';
    currentPage = 1;
    // 直接应用自定义顺序并渲染（不走服务器）
    const customOrder = getCustomFileOrder();
    currentFiles.sort((a, b) => {
      const ai = customOrder[a.name];
      const bi = customOrder[b.name];
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return 0;
    });
    renderFiles();
    return;
  }
  const [sortKey, sortOrder] = value.split('_');
  localStorage.setItem('sharetool_sort', sortKey === 'time' ? 'created_at' : sortKey === 'tag' ? 'tags' : sortKey);
  localStorage.setItem('sharetool_order', sortOrder);
  currentSort = value;
  currentPage = 1;
  loadFiles();
  if (window.currentSearchQ) applySearchHighlight(window.currentSearchQ);
}

function setView(mode) {
  currentView = mode;
  localStorage.setItem('sharetool_view', mode);
  applyView(mode);
  renderFiles();
}

function applyView(mode) {
  const listBtn = document.getElementById('listViewBtn');
  const gridBtn = document.getElementById('gridViewBtn');
  if (listBtn) listBtn.classList.toggle('active', mode === 'list');
  if (gridBtn) gridBtn.classList.toggle('active', mode === 'grid');
  const container = document.getElementById('filesContainer');
  if (!container) return;
  // Remove both classes first
  container.classList.remove('file-list', 'file-grid');
  // Add the appropriate class
  container.classList.add(mode === 'grid' ? 'file-grid' : 'file-list');
}

function renderPagination(current, total) {
  const container = document.getElementById('pagination');
  if (!container) return;
  if (total <= 1) {
    container.innerHTML = '';
    return;
  }
  let html = '';
  html += '<button onclick="goPage(' + (current - 1) + ')" ' + (current === 1 ? 'disabled' : '') + '>‹</button>';
  const maxVisible = 5;
  let startPage = Math.max(1, current - Math.floor(maxVisible / 2));
  let endPage = Math.min(total, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);
  if (startPage > 1) {
    html += '<button onclick="goPage(1)">1</button>';
    if (startPage > 2) html += '<span style="color:var(--text-muted)">...</span>';
  }
  for (let i = startPage; i <= endPage; i++) {
    html += '<button class="' + (i === current ? 'active' : '') + '" onclick="goPage(' + i + ')">' + i + '</button>';
  }
  if (endPage < total) {
    if (endPage < total - 1) html += '<span style="color:var(--text-muted)">...</span>';
    html += '<button onclick="goPage(' + total + ')">' + total + '</button>';
  }
  html += '<button onclick="goPage(' + (current + 1) + ')" ' + (current === total ? 'disabled' : '') + '>›</button>';
  html += '<span class="page-info">' + current + '/' + total + '</span>';
  container.innerHTML = html;
}

function goPage(p) {
  const files = applySort(currentFilter !== 'all' ? currentFiles.filter(f => f.type === currentFilter) : [...currentFiles]);
  const total = Math.ceil(files.length / PAGE_SIZE) || 1;
  if (p < 1 || p > total) return;
  currentPage = p;
  renderFiles();
  if (window.currentSearchQ) applySearchHighlight(window.currentSearchQ);
}

function showSearchHint() {
  const el = document.getElementById('searchHint');
  if (el) el.style.display = 'block';
  // 空搜索时显示热门搜索
  const input = document.getElementById('searchInput');
  if (!input || !input.value.trim()) {
    fetchTrendingSearches();
  }
}
function hideSearchHint() {
  const el = document.getElementById('searchHint');
  if (el) el.style.display = 'none';
}
function insertSearchFilter(filter) {
  const input = document.getElementById('searchInput');
  if (!input) return;
  const val = input.value;
  // If cursor at end or no filter present, append filter
  input.value = val + (val && !val.endsWith(' ') ? ' ' : '') + filter;
  input.focus();
  hideSearchHint();
}

function doSearch() {
  const q = document.getElementById('searchInput').value.trim();
  window.currentSearchQ = q;
  document.getElementById('clearSearchBtn').style.display = q ? 'inline-block' : 'none';
  if (!q) {
    loadFiles();
    return;
  }

  // Extract inline search filters: tag:, content:, size:, date:, type:, ext:
  const tagMatches = q.match(/tag:\S+/g) || [];
  const tags = tagMatches.map(t => t.replace('tag:', '')).join(',');
  const contentMatch = q.match(/content:(\S+)/);
  const contentQuery = contentMatch ? contentMatch[1] : null;

  // size:>1m, size:<100k, size:>1g
  let size_min = null, size_max = null;
  const sizeMatch = q.match(/size:([<>])(\d+)([kmgt]?)/i);
  if (sizeMatch) {
    const unit = { k: 1024, m: 1024*1024, g: 1024*1024*1024, t: 1024*1024*1024*1024 };
    const val = parseInt(sizeMatch[2]) * (unit[sizeMatch[3].toLowerCase()] || 1);
    if (sizeMatch[1] === '>') size_min = val;
    else size_max = val;
  }

  // date:>2024-01-01, date:<today, date:>yesterday
  let date_from = null, date_to = null;
  const dateMatch = q.match(/date:([<>])(today|yesterday|\d{4}-\d{2}-\d{2})/i);
  if (dateMatch) {
    let d;
    if (dateMatch[2].toLowerCase() === 'today') d = new Date();
    else if (dateMatch[2].toLowerCase() === 'yesterday') d = new Date(Date.now() - 86400000);
    else d = new Date(dateMatch[2]);
    if (!isNaN(d)) {
      if (dateMatch[1] === '>') { date_from = Math.floor(d.getTime()/1000); date_to = null; }
      else { date_to = Math.floor(d.getTime()/1000) + 86399; date_from = null; }
    }
  }

  // type:pdf, ext:jpg
  const typeMatch = q.match(/(?:type|ext):(\w+)/i);
  const typeFilter = typeMatch ? typeMatch[1].toLowerCase() : null;

  const textQuery = q
    .replace(/tag:\S+/g, '')
    .replace(/content:\S+/g, '')
    .replace(/size:[<>]\d+[kmgt]*/gi, '')
    .replace(/date:[<>](?:today|yesterday|\d{4}-\d{2}-\d{2})/gi, '')
    .replace(/(?:type|ext):\w*/gi, '')
    .replace(/\s+/g, ' ').trim();

  const params = new URLSearchParams();
  if (textQuery) params.set('q', textQuery);
  if (contentQuery) params.set('content', contentQuery);
  if (tags) { params.set('tags', tags); params.set('tagMatch', window.currentTagMatch || 'all'); }
  if (size_min != null) params.set('size_min', size_min);
  if (size_max != null) params.set('size_max', size_max);
  if (date_from != null) params.set('date_from', date_from);
  if (date_to != null) params.set('date_to', date_to);
  if (typeFilter) params.set('type', typeFilter);
  const queryString = params.toString();

  fetch(API + '/api/search' + (queryString ? '?' + queryString : ''), { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
    .then(r => r.json())
    .then(data => {
      currentFiles = data.files || [];
      renderFiles();
      if (textQuery) applySearchHighlight(textQuery);
      if (data.files && data.files.length > 0) saveRecentSearch(q);
      // Show result count in sort-bar area
      const countEl = document.getElementById('searchResultCount');
      if (countEl) {
        countEl.textContent = currentFiles.length === 0 ? T('ui.noResults') : T('ui.resultsFound', {n: currentFiles.length});
        countEl.style.display = 'inline';
      }
      // Show export button when results exist
      const exportBtn = document.getElementById('exportSearchBtn');
      if (exportBtn) exportBtn.style.display = currentFiles.length > 0 ? 'inline-block' : 'none';
      updateTagFilterBar();
    })
    .catch(e => showAlert('listAlert', T('search.failed'), 'error'));
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  window.currentSearchQ = '';
  window.currentTagMatch = 'all';
  document.getElementById('clearSearchBtn').style.display = 'none';
  const countEl = document.getElementById('searchResultCount');
  if (countEl) countEl.style.display = 'none';
  const exportBtn = document.getElementById('exportSearchBtn');
  if (exportBtn) exportBtn.style.display = 'none';
  loadFiles();
}

function exportSearchResults() {
  if (!currentFiles || !currentFiles.length) return;
  const q = window.currentSearchQ || '';
  const headers = ['文件名', '类型', '大小', '修改时间', '标签'];
  const rows = currentFiles.map(f => {
    const size = f.size ? (f.size < 1024 ? f.size + ' B' : f.size < 1048576 ? (f.size/1024).toFixed(1)+' KB' : (f.size/1048576).toFixed(1)+' MB') : '';
    const date = f.updated_at ? new Date(f.updated_at * 1000).toLocaleString('zh-CN') : '';
    const tags = (f.tags || '').replace(/,/g, '; ');
    return [f.name, f.type || '', size, date, tags];
  });
  const csv = [headers, ...rows].map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sharetool-search-' + (q.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_') || 'results') + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('已导出 ' + currentFiles.length + ' 条结果');
}

// Filter tabs
document.querySelectorAll('.filter-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const filter = tab.dataset.filter;
    const prevFilter = currentFilter;
    currentFilter = filter;
    if (filter === 'starred') {
      loadFiles(null, true).then(() => { currentFilter = 'all'; });
    } else if (prevFilter === 'starred' || filter === 'all') {
      // Switching away from starred or to all: reload all files
      loadFiles(null, false);
    } else {
      renderFiles();
    }
  });
});

// 文字分享
document.getElementById('shareTextBtn').addEventListener('click', shareText);
document.getElementById('clearTextBtn').addEventListener('click', () => {
  document.getElementById('textContent').value = '';
});

async function shareText() {
  const content = document.getElementById('textContent').value;
  if (!content.trim()) {
    showToast(T('msg.inputRequired');
    return;
  }
  const filename = 'share_' + Date.now() + '.txt';
  try {
    const res = await fetch(API + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ filename, content, type: 'text' })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✓ ' + T('file.textShareSuccess'));
      document.getElementById('textContent').value = '';
      // Create share link for the file
      const shareRes = await fetch(API + '/api/share/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
        body: JSON.stringify({ filename })
      });
      const shareData = await shareRes.json();
      const linkBox = document.getElementById('shareLinkBox');
      const linkInput = document.getElementById('shareLinkInput');
      if (linkBox && linkInput) {
        linkInput.value = shareData.success ? shareData.url : (location.origin + '/api/files/' + encodeURIComponent(filename) + '?auth=' + (AUTH_TOKEN || ''));
        linkBox.style.display = 'flex';
      }
      loadFiles();
      broadcastWs({ type: 'file_create', payload: { filename, content, type: 'text' } });
    } else {
      showToast(T('msg.failed') + ': ' + data.error;
    }
  } catch (e) {
    showToast(T('msg.failed') + ': ' + e.message;
  }
}

function copyShareLink() {
  const input = document.getElementById('shareLinkInput');
  if (!input || !input.value) return;
  navigator.clipboard.writeText(input.value).then(() => {
    showToast('✓ ' + T('file.linkCopied'));
  }).catch(() => {
    input.select();
    document.execCommand('copy');
    showToast(T('msg.linkCopied'));
  });
}

async function copyShareLinkByFilename(filename) {
  // Create a temporary share link for the file and copy it
  try {
    const res = await fetch(API + '/api/share/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ filename, expiryHours: 168 })
    });
    const data = await res.json();
    if (data.success) {
      const url = window.location.origin + '/s/' + data.code + '?utm_source=sharetool&utm_medium=copy_link&utm_campaign=sharetool';
      navigator.clipboard.writeText(url).then(() => {
        showToast('✓ ' + T('file.linkCopied'));
      }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast(T('msg.copiedToClipboard'));
      });
    } else {
      showToast(T('share.createFailed'));
    }
  } catch {
    showToast(T('msg.createShareFailed'));
  }
}

function updatePasswordStrength(password) {
  const el = document.getElementById('sharePasswordStrength');
  if (!el) return;
  if (!password) { el.textContent = ''; el.style.color = 'var(--text-muted)'; return; }
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (score <= 1) {
    el.textContent = '⚠️ ' + T('share.passwordWeak');
    el.style.color = '#dc2626';
  } else if (score <= 3) {
    el.textContent = '✓ ' + T('share.passwordMedium');
    el.style.color = '#d97706';
  } else {
    el.textContent = '✓ ' + T('share.passwordStrong');
    el.style.color = '#16a34a';
  }
}

async function shareFile(filename) {
  // Open share options modal
  document.getElementById('shareOptionsFilename').value = filename;
  document.getElementById('shareOptionsFileName').textContent = filename;
  document.getElementById('shareExpiryHours').value = '168';
  document.getElementById('shareMaxDownloads').value = '';
  document.getElementById('sharePassword').value = '';
  const strengthEl = document.getElementById('sharePasswordStrength');
  if (strengthEl) { strengthEl.textContent = ''; }
  lockScroll();
  document.getElementById('shareOptionsModal').classList.add('show');
}

async function doCreateShareLink() {
  const filename = document.getElementById('shareOptionsFilename').value;
  if (!filename) { showToast(T('msg.invalidFilename')); return; }
  const expiryHours = parseInt(document.getElementById('shareExpiryHours').value) || 168;
  const maxDownloads = parseInt(document.getElementById('shareMaxDownloads').value) || null;
  const password = document.getElementById('sharePassword').value || null;
  const description = document.getElementById('shareDescription').value || '';
  closeShareOptionsModal();
  try {
    const res = await fetch(API + '/api/share/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ filename, expiryHours: expiryHours || null, maxDownloads, password, description })
    });
    const data = await res.json();
    if (data.success) {
      const shareUrl = data.url;
      const linkBox = document.getElementById('shareLinkBox');
      const linkInput = document.getElementById('shareLinkInput');
      if (linkBox && linkInput) {
        linkInput.value = shareUrl;
        linkBox.style.display = 'flex';
      }
      // 显示过期时间
      if (data.expiresAt) {
        const expiryDate = new Date(data.expiresAt);
        const expiryStr = expiryDate.toLocaleString();
        showToast('✓ ' + T('share.successCreated') + ' ' + expiryStr);
      } else {
        showToast('✓ ' + T('share.successCreated'));
      }
    } else {
      showToast(T('msg.shareFailed') + ': ' + data.error);
    }
  } catch (e) {
    showToast(T('msg.shareFailed') + ': ' + e.message);
  }
}

function closeShareOptionsModal() {
  unlockScroll();
  document.getElementById('shareOptionsModal').classList.remove('show');
}

function showShareQRModal() {
  const linkInput = document.getElementById('shareLinkInput');
  if (!linkInput || !linkInput.value) { showToast(T('share.generateFirst')); return; }
  const url = linkInput.value;
  const modal = document.getElementById('qrModal');
  const content = document.getElementById('qrModalContent');
  const urlEl = document.getElementById('qrModalUrl');
  if (modal && content && urlEl) {
    content.innerHTML = '<div style="font-size:40px;animation:spin 1s linear infinite;">⏳</div><div style="margin-top:8px;color:var(--text-muted);">' + T('msg.loading') + '</div>';
    urlEl.textContent = url;
    modal.classList.add('show');
    // Generate QR from URL (share code is embedded)
    // Extract code from URL like http://IP:PORT/s/XXXX
    const code = url.split('/s/')[1] || '';
    fetch(API + '/api/share/qr/' + code, { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
      .then(r => r.json())
      .then(qrData => {
        if (qrData.success && qrData.dataUrl) {
          content.innerHTML = '<img src="' + qrData.dataUrl + '" style="border-radius:8px;max-width:256px;width:100%;" />';
        } else {
          content.innerHTML = '<div style="color:var(--danger-fg);">' + T('err.genFailed') + ': ' + escapeHtml(qrData.error || T('err.unknown')) + '</div>';
        }
      })
      .catch(e => { content.innerHTML = '<div style="color:var(--danger-fg);">' + T('err.reqFailed') + ': ' + escapeHtml(e.message || T('err.unknown')) + '</div>'; });
  }
}

function closeShareQRModal() {
  unlockScroll();
  const modal = document.getElementById('qrModal');
  if (modal) modal.classList.remove('show');
}

// 文件上传
document.getElementById('fileInput').addEventListener('change', (e) => {
  uploadFiles(e.target.files);
});

// Paste from clipboard to upload
window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      // Prefix pasted files with timestamp to make names unique
      const timestamp = Date.now();
      files.forEach((f, i) => {
        const ext = f.name && f.name.includes('.') ? '.' + f.name.split('.').pop() : '';
        Object.defineProperty(f, 'name', { value: 'paste_' + timestamp + '_' + i + ext, writable: false });
      });
      uploadFiles(files);
      showToast('正在上传 ' + files.length + ' 个剪贴板文件…');
    }
  });
});

// Compress JPEG/PNG images > 100KB before upload (canvas-based, no server needed)
async function compressImage(file) {
  const isCompressable = file.type === 'image/jpeg' || file.type === 'image/png';
  if (!isCompressable || file.size <= 100 * 1024) {
    return { base64: await fileToBase64(file), compressed: false };
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const MAX_W = 1920, MAX_H = 1920;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > MAX_W || h > MAX_H) {
        const r = Math.min(MAX_W / w, MAX_H / h);
        w = Math.round(w * r); h = Math.round(h * r);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        if (!blob) { resolve({ base64: null, compressed: false }); return; }
        if (blob.size < file.size) {
          const saving = (((file.size - blob.size) / file.size) * 100).toFixed(0);
          setTimeout(() => showToast('🖼 ' + file.name + ' 压缩节省 ' + saving + '%'), 500);
        }
        fileToBase64(blob).then(base64 => resolve({ base64, compressed: true, origSize: file.size, newSize: blob.size }));
      }, 'image/jpeg', 0.8);
    };
    img.onerror = () => resolve({ base64: null, compressed: false });
    img.src = URL.createObjectURL(file);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function doRemoteUpload() {
  const urlInput = document.getElementById('remoteUrlInput');
  const nameInput = document.getElementById('remoteFilenameInput');
  const statusEl = document.getElementById('remoteUploadStatus');
  const url = (urlInput.value || '').trim();
  if (!url) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = T('msg.invalidUrl'); return; }
  let filename = (nameInput.value || '').trim();
  if (!filename) {
    try { filename = decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'download_' + Date.now(); }
    catch (_) { filename = 'download_' + Date.now(); }
  }
  statusEl.style.color = 'var(--text-muted)'; statusEl.textContent = T('msg.downloading');
  try {
    const res = await fetch(API + '/api/remote-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ url, filename })
    });
    const data = await res.json();
    if (data.success) {
      statusEl.style.color = 'var(--success-fg)'; statusEl.textContent = '✓ ' + filename + ' (' + formatSize(data.size) + ')';
      urlInput.value = ''; nameInput.value = '';
      loadFiles();
    } else {
      statusEl.style.color = 'var(--danger)'; statusEl.textContent = data.error || 'Download failed';
    }
  } catch (e) {
    statusEl.style.color = 'var(--danger)'; statusEl.textContent = e.message;
  }
}

async function uploadFiles(files) {
  let successCount = 0;
  let failCount = 0;
  const totalFiles = files.length;
  const progressBar = document.getElementById('uploadProgressBar');
  const progressFill = document.getElementById('uploadProgressFill');
  const uploadQueue = document.getElementById('uploadQueue');

  // Store failed file objects for retry
  window._failedUploads = [];

  if (progressBar) progressBar.style.display = 'block';
  if (uploadQueue) {
    uploadQueue.innerHTML = '';
    uploadQueue.classList.add('show');
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filename = file.webkitRelativePath || file.name;

    // Render queue item (spinner pending)
    if (uploadQueue) {
      const item = document.createElement('div');
      item.className = 'upload-queue-item';
      item.id = 'upload-item-' + i;
      item.innerHTML = '<span class="spinner"></span><span class="name">' + escapeHtml(filename) + '</span><span class="status">⏳</span>';
      uploadQueue.appendChild(item);
    }

    await new Promise(async (resolve) => {
      // Compress image client-side before upload (JPEG/PNG > 100KB)
      let base64;
      try {
        const result = await compressImage(file);
        if (!result.base64) throw new Error('compress failed');
        base64 = result.base64;
      } catch (e) {
        // Fallback to direct read
        try { base64 = await fileToBase64(file); } catch (_) { failCount++; resolve(); return; }
      }

      // Animate progress during upload
      let animFrame = 0;
      const animInterval = setInterval(() => {
        animFrame++;
        const basePct = Math.round((i / totalFiles) * 100);
        const animPct = Math.min(basePct + Math.round(animFrame / 10), basePct + 20);
        if (progressFill) progressFill.style.width = animPct + '%';
      }, 50);

      try {
        const res = await fetch(API + '/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
          body: JSON.stringify({ filename, content: base64, type: 'file' })
        });
        clearInterval(animInterval);
        const data = await res.json();
        if (progressFill) progressFill.style.width = Math.round(((i + 1) / totalFiles) * 100) + '%';
        const queueItem = document.getElementById('upload-item-' + i);
        if (queueItem) {
          queueItem.classList.add(data.success ? 'done' : 'fail');
          queueItem.querySelector('.status').textContent = data.success ? '✓' : '✗';
          if (!data.success) {
            window._failedUploads.push({ file, filename, index: i });
            // Add retry button
            const retryBtn = document.createElement('button');
            retryBtn.className = 'retry-btn';
            retryBtn.textContent = T('file.retry');
            retryBtn.style.cssText = 'margin-left:8px;padding:2px 8px;font-size:11px;background:var(--accent-primary);color:var(--text-inverse,#fff);border:none;border-radius:4px;cursor:pointer;';
            retryBtn.onclick = () => retryUploadItem(window._failedUploads.findIndex(f => f.filename === filename && f.index === i));
            queueItem.querySelector('.status').after(retryBtn);
          }
        }
        if (data.success) {
          successCount++;
          showToast('✓ ' + filename);
          loadFiles();
          broadcastWs({ type: 'file_create', payload: { filename, hash: data.hash } });
        } else {
          failCount++;
          showAlert('uploadAlert', T('msg.failed') + ': ' + data.error, 'error');
        }
      } catch (e) {
        clearInterval(animInterval);
        failCount++;
        const queueItem = document.getElementById('upload-item-' + i);
        if (queueItem) {
          queueItem.classList.add('fail');
          queueItem.querySelector('.status').textContent = '✗';
          window._failedUploads.push({ file, filename, index: i });
          const retryBtn = document.createElement('button');
          retryBtn.className = 'retry-btn';
          retryBtn.textContent = T('file.retry');
          retryBtn.style.cssText = 'margin-left:8px;padding:2px 8px;font-size:11px;background:var(--accent-primary);color:var(--text-inverse,#fff);border:none;border-radius:4px;cursor:pointer;';
          retryBtn.onclick = () => retryUploadItem(window._failedUploads.findIndex(f => f.filename === filename && f.index === i));
          queueItem.querySelector('.status').after(retryBtn);
        }
        showAlert('uploadAlert', T('msg.failed') + ': ' + e.message, 'error');
      }
      resolve();
    });
  }

  // Only auto-hide if all succeeded; otherwise keep queue visible with retry controls
  if (failCount === 0) {
    setTimeout(() => {
      if (progressBar) progressBar.style.display = 'none';
      if (progressFill) progressFill.style.width = '0%';
      if (uploadQueue) uploadQueue.classList.remove('show');
    }, 2000);
  } else {
    // Show retry bar at bottom
    if (uploadQueue) {
      const retryBar = document.createElement('div');
      retryBar.style.cssText = 'display:flex;gap:8px;align-items:center;padding-top:8px;border-top:1px solid var(--border-color);margin-top:4px;';
      retryBar.innerHTML = '<span style="color:var(--danger-fg,var(--danger));font-size:12px;">' + failCount + ' ' + T('file.numFiles') + ' ' + T('err.failed') + '</span><button id="retryAllBtn" style="padding:4px 12px;background:var(--accent-primary);color:var(--text-inverse,#fff);border:none;border-radius:4px;font-size:12px;cursor:pointer;">' + T('msg.retry.all') + '</button><button id="dismissQueueBtn" style="padding:4px 12px;background:var(--bg-tertiary);color:var(--text-secondary);border:1px solid var(--border-color);border-radius:4px;font-size:12px;cursor:pointer;">' + T('msg.close') + '</button>';
      uploadQueue.appendChild(retryBar);
      retryBar.querySelector('#retryAllBtn').onclick = () => retryAllFailed();
      retryBar.querySelector('#dismissQueueBtn').onclick = () => {
        if (uploadQueue) { uploadQueue.innerHTML = ''; uploadQueue.classList.remove('show'); }
        if (progressBar) progressBar.style.display = 'none';
        if (progressFill) progressFill.style.width = '0%';
        window._failedUploads = [];
      };
    }
  }

  if (successCount > 0) {
    showAlert('uploadAlert', '已上传 ' + successCount + ' 个文件' + (failCount > 0 ? '，失败 ' + failCount : ''), failCount > 0 ? 'error' : 'success');
  }
}

async function retryUploadItem(idx) {
  if (!window._failedUploads || !window._failedUploads[idx]) return;
  const { file, filename } = window._failedUploads[idx];
  // Remove from failed list
  window._failedUploads.splice(idx, 1);
  // Re-upload with compression
  let base64;
  try {
    const result = await compressImage(file);
    base64 = result.base64 || await fileToBase64(file);
  } catch (_) {
    base64 = await fileToBase64(file);
  }
  try {
    const res = await fetch(API + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ filename, content: base64, type: 'file' })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✓ ' + filename + ' ' + T('msg.uploadSuccess'));
      loadFiles();
      broadcastWs({ type: 'file_create', payload: { filename, hash: data.hash } });
    } else {
      showAlert('uploadAlert', T('msg.retryFailed') + ': ' + data.error, 'error');
      window._failedUploads.push({ file, filename });
    }
  } catch (e) {
    showAlert('uploadAlert', T('msg.retryFailed') + ': ' + e.message, 'error');
    window._failedUploads.push({ file, filename });
  }
}

async function retryAllFailed() {
  const failed = [...(window._failedUploads || [])];
  window._failedUploads = [];
  if (failed.length === 0) return;
  const uploadQueue = document.getElementById('uploadQueue');
  if (uploadQueue) { uploadQueue.innerHTML = ''; uploadQueue.classList.remove('show'); }
  // Re-use the file list to trigger new upload
  const fileInput = document.getElementById('fileInput');
  if (fileInput) {
    const dt = new DataTransfer();
    failed.forEach(({ file }) => dt.items.add(file));
    fileInput.files = dt.files;
    await uploadFiles(dt.files);
  }
}

async function copyContent(filename) {
  try {
    const res = await fetch(API + '/api/content/' + filename, { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.content) {
      const textarea = document.createElement('textarea');
      textarea.value = data.content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); showToast(T('msg.contentCopied')); }
      catch (e) { prompt(T('file.copyContent') + ':', data.content); }
      document.body.removeChild(textarea);
    }
  } catch (e) { showToast(T('msg.copy.failed'); }
}

function downloadFile(filename) {
  window.open(API + '/download/' + filename, '_blank');
}

async function downloadFolder(folderName) {
  // Stream ZIP download of entire virtual folder
  const a = document.createElement('a');
  a.href = API + '/api/batch-download';
  a.download = folderName.replace(/\/$/, '').replace(/\//g, '_') + '_folder.zip';
  a.method = 'POST';
  a.target = '_blank';
  const body = JSON.stringify({ folder: folderName });
  a.dataset.bearer = AUTH_TOKEN || '';
  try {
    const res = await fetch(API + '/api/batch-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body
    });
    if (!res.ok) {
      const data = await res.json();
      showToast(data.error || T('msg.downloadFailed') || 'Download failed');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast('Download failed: ' + e.message);
  }
}

async function addTag(filename, existingTags) {
  // Mobile-friendly tag input modal (replaces prompt())
  const existing = existingTags ? existingTags.split(',').filter(t => t.trim()) : [];
  _tagInputState = { filename, existingTags: [...existing] };

  // Show filename
  document.getElementById('tagInputFileName').textContent = decodeURIComponent(filename);

  // Render existing tags as removable chips
  const existingDiv = document.getElementById('tagInputExisting');
  existingDiv.innerHTML = existing.map(t =>
    '<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:rgba(102,126,234,0.2);color:var(--accent-primary);border-radius:12px;font-size:12px;">' +
    escapeHtml(t) +
    '<span onclick="removeTagFromInput(\'' + t.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\')" style="cursor:pointer;opacity:0.7;margin-left:2px;">×</span></span>'
  ).join('');

  // Color picker (6 preset colors)
  const colorPicker = document.getElementById('tagInputColorPicker');
  const presetColors = ['#667eea','#f59e0b','#10b981','#ef4444','#8b5cf6','#06b6d4'];
  colorPicker.innerHTML = presetColors.map(c =>
    '<div onclick="selectTagInputColor(this, \'' + c + '\')" style="width:28px;height:28px;border-radius:50%;background:' + c + ';cursor:pointer;border:2px solid transparent;transition:border-color 0.15s;"></div>'
  ).join('');

  // Reset input
  document.getElementById('tagInputField').value = '';

  // Setup tag autocomplete
  setupTagInputSuggestions();

  lockScroll();
  document.getElementById('tagInputModal').classList.add('show');
  document.getElementById('tagInputField').focus();
}

let _tagSuggestDebounce = null;
function setupTagInputSuggestions() {
  const input = document.getElementById('tagInputField');
  if (!input) return;
  const container = document.getElementById('tagInputSuggestions');
  if (!container) return;

  // Remove old listener by cloning
  input.removeEventListener('input', handleTagSuggestInput);
  input.addEventListener('input', handleTagSuggestInput);
}

function handleTagSuggestInput() {
  const input = document.getElementById('tagInputField');
  const container = document.getElementById('tagInputSuggestions');
  if (!input || !container) return;

  clearTimeout(_tagSuggestDebounce);
  const query = input.value.toLowerCase().trim();

  if (!query) {
    container.style.display = 'none';
    return;
  }

  _tagSuggestDebounce = setTimeout(() => {
    // Get existing tags in the modal
    const existingInModal = _tagInputState.existingTags || [];
    // Filter tagColors (all known tags) by query prefix
    const matches = Object.keys(tagColors).filter(t =>
      t.toLowerCase().includes(query) && !existingInModal.includes(t)
    ).slice(0, 6);

    if (matches.length === 0) {
      container.style.display = 'none';
      return;
    }

    container.innerHTML = matches.map(t => {
      const color = tagColors[t];
      const colorStyle = color ? 'background:rgba(' + hexToRgb(color) + ',0.2);color:' + color + ';' : '';
      return '<div class="tag-suggestion-item" style="padding:8px 12px;cursor:pointer;font-size:13px;' + colorStyle + '" onclick="applyTagSuggestion(\'' + t.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\')">' + escapeHtml(t) + '</div>';
    }).join('');
    container.style.display = 'block';
  }, 150);
}

function applyTagSuggestion(tag) {
  const input = document.getElementById('tagInputField');
  if (!input) return;
  // Append tag to existing input (comma-separated)
  const current = input.value.trim();
  const parts = current.split(',').map(p => p.trim()).filter(p => p);
  parts[parts.length - 1] = tag; // replace last partial match
  input.value = parts.join(', ') + (current.endsWith(',') ? ' ' : ', ');
  document.getElementById('tagInputSuggestions').style.display = 'none';
  input.focus();
}
}

function removeTagFromInput(tag) {
  _tagInputState.existingTags = _tagInputState.existingTags.filter(t => t !== tag);
  const existingDiv = document.getElementById('tagInputExisting');
  existingDiv.innerHTML = _tagInputState.existingTags.map(t =>
    '<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:rgba(102,126,234,0.2);color:var(--accent-primary);border-radius:12px;font-size:12px;">' +
    escapeHtml(t) +
    '<span onclick="removeTagFromInput(\'' + t.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\')" style="cursor:pointer;opacity:0.7;margin-left:2px;">×</span></span>'
  ).join('');
}

function selectTagInputColor(el, color) {
  el.parentElement.querySelectorAll('div').forEach(d => d.style.borderColor = 'transparent');
  el.style.borderColor = color;
  _tagInputState.selectedColor = color;
}

let _tagInputState = { filename: '', existingTags: [], selectedColor: '#667eea' };

// ============================================================
// Batch Tag Modal
// ============================================================
let _batchTagState = { filenames: [], tags: [] };

function openBatchTagModal(filenames) {
  _batchTagState = { filenames, tags: [] };
  document.getElementById('batchTagFileCount').textContent = filenames.length + ' 个文件';
  document.getElementById('batchTagInputField').value = '';
  renderBatchTagChips();
  lockScroll();
  document.getElementById('batchTagModal').classList.add('show');
  document.getElementById('batchTagInputField').focus();
  setupBatchTagSuggestions();
}

function closeBatchTagModal() {
  unlockScroll();
  document.getElementById('batchTagModal').classList.remove('show');
}

function renderBatchTagChips() {
  const container = document.getElementById('batchTagExisting');
  container.innerHTML = _batchTagState.tags.map(t =>
    '<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:rgba(102,126,234,0.2);color:var(--accent-primary);border-radius:12px;font-size:12px;cursor:pointer;" onclick="removeBatchTag(\'' + escapeHtml(t).replace(/'/g, "\\'") + '\')">' +
    escapeHtml(t) + '<span style="cursor:pointer;opacity:0.7;margin-left:2px;">×</span></span>'
  ).join('');
}

function removeBatchTag(tag) {
  _batchTagState.tags = _batchTagState.tags.filter(t => t !== tag);
  renderBatchTagChips();
}

function addBatchTag(tag) {
  const trimmed = tag.trim();
  if (trimmed && !_batchTagState.tags.includes(trimmed)) {
    _batchTagState.tags.push(trimmed);
    renderBatchTagChips();
  }
  document.getElementById('batchTagInputField').value = '';
  document.getElementById('batchTagSuggestions').style.display = 'none';
}

async function confirmBatchTagInput() {
  const { filenames, tags } = _batchTagState;
  if (!filenames.length) { closeBatchTagModal(); return; }
  closeBatchTagModal();
  let success = 0, failed = 0;
  for (const filename of filenames) {
    try {
      const res = await fetch(API + '/api/file-tags/' + encodeURIComponent(filename), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
        body: JSON.stringify({ action: 'replace', tags })
      });
      if (res.ok) success++; else failed++;
    } catch { failed++; }
  }
  if (success) {
    showToast(success + ' 个文件已更新标签');
    loadFiles();
  } else if (failed) {
    showToast('标签更新失败', true);
  }
}

function setupBatchTagSuggestions() {
  const input = document.getElementById('batchTagInputField');
  if (!input) return;
  input.removeEventListener('keydown', handleBatchTagKeydown);
  input.addEventListener('keydown', handleBatchTagKeydown);
}

function handleBatchTagKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = e.target.value.trim();
    if (val) addBatchTag(val);
  } else if (e.key === 'Backspace' && !e.target.value && _batchTagState.tags.length) {
    _batchTagState.tags.pop();
    renderBatchTagChips();
  }
}

function batchAddTagViaModal() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  if (checked.length === 0) return;
  const filenames = Array.from(checked).map(cb => decodeURIComponent(cb.value));
  openBatchTagModal(filenames);
}

function closeTagInputModal() {
  unlockScroll();
  document.getElementById('tagInputModal').classList.remove('show');
}

async function confirmTagInput() {
  const input = document.getElementById('tagInputField').value;
  const newTags = input.split(',').map(t => t.trim()).filter(t => t);
  const allTags = [..._tagInputState.existingTags, ...newTags].join(',');
  if (!allTags) {
    closeTagInputModal();
    return;
  }

  const filename = _tagInputState.filename;

  // 为新标签请求颜色
  for (const tag of newTags) {
    if (!tagColors[tag]) {
      try {
        const res = await fetch(API + '/api/tags/suggest-color?tag=' + encodeURIComponent(tag), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
        const data = await res.json();
        if (data.success) {
          tagColors[tag] = data.color;
          await fetch(API + '/api/tags/color', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
            body: JSON.stringify({ tag, color: data.color })
          });
        }
      } catch (e) {}
    }
  }

  closeTagInputModal();
  try {
    const res = await fetch(API + '/api/file-tags/' + filename, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ tags: allTags })
    });
    const data = await res.json();
    if (data.success) {
      showAlert('listAlert', T('tag.colorChanged'), 'success');
      loadFiles();
    } else {
      showAlert('listAlert', T('msg.update.failed') + ': ' + data.error, 'error');
    }
  } catch (e) { showAlert('listAlert', T('msg.update.failed') + ': ' + e.message, 'error'); }
}

async function toggleStar(filename) {
  try {
    const res = await fetch(API + '/api/star/' + encodeURIComponent(filename), {
      method: 'POST',
      headers: { 'x-auth-token': AUTH_TOKEN || '' }
    });
    const data = await res.json();
    if (data.success) {
      // Update UI: toggle star icon on the file item
      const decodedName = decodeURIComponent(filename);
      const el = document.querySelector('[data-filename="' + CSS.escape(decodedName) + '"]');
      if (el) {
        const starIcon = el.querySelector('.star-icon');
        if (starIcon) starIcon.textContent = data.starred ? '⭐' : '☆';
      }
    }
  } catch (e) { /* silent */ }
}

async function deleteFile(filename) {
  const isVirtual = filename.includes('/');
  var msg = isVirtual
    ? "Confirm delete folder [" + filename + "] and all contents?"
    : "Confirm delete?";
  if (!confirm(msg)) return;
  try {
    var res;
    if (isVirtual) {
      res = await fetch(API + "/api/folder/" + encodeURIComponent(filename) + "/delete", {
        method: "DELETE",
        headers: { "x-auth-token": AUTH_TOKEN || "" }
      });
    } else {
      res = await fetch(API + "/api/file/" + filename + "?filename=" + encodeURIComponent(filename), {
        method: "DELETE",
        headers: { "x-auth-token": AUTH_TOKEN || "" }
      });
    }
    var data = await res.json();
    if (data.success) {
      showAlert("listAlert", "Deleted", "success");
      loadFiles();
      broadcastWs({ type: "file_delete", payload: { filename: decodeURIComponent(filename) } });
    } else {
      showAlert("listAlert", "Delete failed", "error");
    }
  } catch (e) { showAlert("listAlert", "Delete failed: " + e.message, "error"); }
}

async function renameFile(oldFilename) {
  const isVirtual = oldFilename.includes('/');
  const promptMsg = isVirtual
    ? T('file.inputFolderName') : T('file.inputNewName');
  const newFilename = prompt(promptMsg, decodeURIComponent(oldFilename));
  if (!newFilename || newFilename === decodeURIComponent(oldFilename)) return;
  try {
    let res;
    if (isVirtual) {
      // Virtual folder rename: compute new path
      const parts = oldFilename.split('/');
      parts[parts.length - 1] = newFilename.trim();
      const newPath = parts.join('/');
      res = await fetch(API + '/api/folder/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
        body: JSON.stringify({ oldPath: oldFilename, newPath })
      });
    } else {
      res = await fetch(API + '/api/file-rename/' + oldFilename, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
        body: JSON.stringify({ newFilename: newFilename.trim() })
      });
    }
    const data = await res.json();
    if (data.success) {
      showToast(T('file.renamed'));
      loadFiles();
      broadcastWs({ type: 'file_rename', payload: { oldFilename: data.oldFilename || oldFilename, newFilename: data.newFilename || newFilename } });
    } else {
      showAlert('listAlert', T('file.renameFailed') + ': ' + (data.error || T('ui.unknownError')), 'error');
    }
  } catch (e) { showAlert('listAlert', T('file.renameFailed') + ': ' + e.message, 'error'); }
}

function startInlineRename(divEl, filename) {
  const span = divEl.querySelector('.search-target');
  if (!span) return;
  const currentName = decodeURIComponent(filename);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-rename';
  input.value = currentName;
  // Save original span content for restore on cancel
  input.dataset.original = currentName;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitInlineRename(divEl, filename, input); }
    else if (e.key === 'Escape') { cancelInlineRename(divEl, span); }
    else if (e.key === 'Tab') { e.preventDefault(); commitInlineRename(divEl, filename, input); }
  });
  input.addEventListener('blur', () => {
    // Small delay so that Enter key handler fires first
    setTimeout(() => commitInlineRename(divEl, filename, input), 50);
  });
  span.replaceWith(input);
  input.focus();
  input.select();
}

async function commitInlineRename(divEl, oldFilename, input) {
  const newFilename = input.value.trim();
  const original = input.dataset.original;
  if (!newFilename || newFilename === original) {
    cancelInlineRename(divEl, null, original);
    return;
  }
  try {
    const res = await fetch(API + '/api/file-rename/' + oldFilename, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ newFilename })
    });
    const data = await res.json();
    if (data.success) {
      showToast(T('file.renamed') + ': ' + data.newFilename);
      loadFiles();
      broadcastWs({ type: 'file_rename', payload: { oldFilename: data.oldFilename, newFilename: data.newFilename } });
    } else {
      showAlert('listAlert', T('file.renameFailed') + ': ' + (data.error || T('ui.unknownError')), 'error');
      cancelInlineRename(divEl, null, original);
    }
  } catch (e) {
    showAlert('listAlert', T('file.renameFailed') + ': ' + e.message, 'error');
    cancelInlineRename(divEl, null, original);
  }
}

function cancelInlineRename(divEl, span, originalName) {
  if (!divEl) return;
  const input = divEl.querySelector('.inline-rename');
  if (!input) return;
  const name = originalName || input.dataset.original || '';
  const icon = divEl.querySelector('.file-type-icon');
  const iconHtml = icon ? icon.outerHTML : '';
  const textNode = document.createTextNode(name);
  if (span) {
    input.replaceWith(span);
    span.textContent = name;
  } else {
    input.replaceWith(textNode);
  }
}

async function deleteOld(days) {
  if (!confirm(T('ui.confirmDeleteDays', {n: days}))) return;
  try {
    const res = await fetch(API + '/api/delete-old?days=' + days, { method: 'DELETE', headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success) {
      showAlert('listAlert', T('file.deleted') + ' ' + data.deleted + ' ' + T('file.numFiles'), 'success');
      loadFiles();
    } else {
      showAlert('listAlert', T('file.deleteFailed'), 'error');
    }
  } catch (e) { showAlert('listAlert', '删除失败: ' + e.message, 'error'); }
}

async function deleteAll() {
  if (!confirm(T('ui.confirmDeleteAll'))) return;
  try {
    const res = await fetch(API + '/api/delete-all', { method: 'DELETE', headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success) {
      showAlert('listAlert', T('file.deleted') + ' ' + data.deleted + ' ' + T('file.numFiles'), 'success');
      loadFiles();
    } else {
      showAlert('listAlert', T('file.deleteFailed'), 'error');
    }
  } catch (e) { showAlert('listAlert', '删除失败: ' + e.message, 'error'); }
}

function toggleSelectAll(checked) {
  document.querySelectorAll('.batch-checkbox').forEach(cb => cb.checked = checked);
  updateBatchBar();
}

function updateBatchBar() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  const bar = document.getElementById('batchBar');
  const count = document.getElementById('batchCount');
  if (bar) bar.classList.toggle('show', checked.length > 0);
  if (count) count.textContent = T('ui.selectedN').replace('{n}', checked.length);
  const selectAll = document.getElementById('selectAllBatch');
  if (selectAll) selectAll.checked = checked.length > 0 && checked.length === document.querySelectorAll('.batch-checkbox').length;
  // Sync count to standalone batch download button if visible
  const dlCount = document.getElementById('batchCountDL');
  if (dlCount) dlCount.textContent = checked.length;
}

function clearBatch() {
  document.querySelectorAll('.batch-checkbox').forEach(cb => cb.checked = false);
  updateBatchBar();
}

// File context menu
let _ctxFilename = null;

function showFileContextMenu(e, filename) {
  e.preventDefault();
  e.stopPropagation();
  _ctxFilename = filename;
  const menu = document.getElementById('fileContextMenu');
  if (!menu) return;

  const ext = filename.split('.').pop().toLowerCase();
  const isImage = isImageFile(filename);
  const isAudio = isAudioFile(filename);
  const isVideo = isVideoFile(filename);
  const isPdf = isPdfFile(filename);
  const isCode = isCodeFile(filename);
  const isMd = /\.(md|markdown)$/i.test(filename);
  const isText = /text/i.test(ext);

  const items = [];
  items.push({ icon: '📖', label: '打开 / Open', action: "openFileByName('" + encodeURIComponent(filename) + "')" });
  items.push({ icon: '🔗', label: '新标签页打开', action: "window.open(API + '/api/content/" + encodeURIComponent(filename) + "?auth=' + (AUTH_TOKEN || ''), '_blank')" });
  if (isImage) items.push({ icon: '🖼', label: '图片预览', action: "openImageModal('" + encodeURIComponent(filename) + "')" });
  if (isAudio || isVideo) items.push({ icon: isAudio ? '🎵' : '🎬', label: '媒体预览', action: "openMediaModal('" + encodeURIComponent(filename) + "')" });
  if (isPdf) items.push({ icon: '📕', label: 'PDF 预览', action: "openPdfModal('" + encodeURIComponent(filename) + "')" });
  if (isCode || isMd || isText) items.push({ icon: '📝', label: '代码/MD预览', action: "openCodeModal('" + encodeURIComponent(filename) + "')" });
  items.push({ divider: true });
  items.push({ icon: '🏷', label: '添加标签', action: "addTag('" + encodeURIComponent(filename) + "', '')" });
  items.push({ icon: '🔗', label: '创建分享链接', action: "shareFile('" + encodeURIComponent(filename) + "')" });
  items.push({ icon: '📋', label: '复制到...', action: "promptCopy('" + encodeURIComponent(filename) + "')" });
  items.push({ icon: '✏️', label: '重命名', action: "startInlineRenameFromCtx('" + encodeURIComponent(filename) + "')" });
  items.push({ divider: true });
  items.push({ icon: '⬇', label: '下载', action: "downloadFile('" + encodeURIComponent(filename) + "')" });
  items.push({ icon: '📄', label: '复制文件名', action: "navigator.clipboard.writeText('" + filename.replace(/'/g, "\\'") + "').then(()=>showToast('✓ 已复制文件名')).catch(()=>{})" });
  items.push({ icon: '🔗', label: '复制下载链接', action: "navigator.clipboard.writeText(window.location.origin + '/api/content/" + encodeURIComponent(filename) + "?auth=' + (AUTH_TOKEN || '')).then(()=>showToast('✓ 已复制链接')).catch(()=>{})" });
  items.push({ icon: '🗑', label: '删除', action: "deleteFile('" + encodeURIComponent(filename) + "')", danger: true });

  menu.innerHTML = items.map(item => {
    if (item.divider) return '<div class="ctx-divider"></div>';
    return '<div class="ctx-item' + (item.danger ? ' danger' : '') + '" onclick="closeContextMenu();' + item.action + '">' + item.icon + ' ' + item.label + '</div>';
  }).join('');

  // Position menu
  const menuW = 180, menuH = items.length * 36 + 8;
  let x = e.clientX, y = e.clientY;
  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.add('show');
}

function closeContextMenu() {
  const menu = document.getElementById('fileContextMenu');
  if (menu) menu.classList.remove('show');
  _ctxFilename = null;
}

function promptCopy(filename) {
  const dest = prompt('复制到目标文件夹前缀（如 backup/）：', '');
  if (!dest) return;
  fetch(API + '/api/file-copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
    body: JSON.stringify({ sourceFilename: filename, newFilename: dest + filename.split('/').pop() })
  }).then(r => r.json()).then(d => {
    showToast(d.success ? '已复制到 ' + dest : '复制失败: ' + d.error);
    if (d.success) loadFiles();
  }).catch(e => showToast('复制失败: ' + e.message));
}

function startInlineRenameFromCtx(filename) {
  closeContextMenu();
  setTimeout(() => startInlineRename(null, filename), 50);
}

function openFileByName(filename) {
  closeContextMenu();
  handleFileItemClick({ stopPropagation: () => {} }, filename, isImageFile(filename));
}

document.addEventListener('click', closeContextMenu);

function setBatchOperation(op) {
  const status = document.getElementById('batchStatus');
  const statusText = document.getElementById('batchStatusText');
  const progressBar = document.getElementById('batchProgressBar');
  const progressFill = document.getElementById('batchProgressFill');
  const buttons = document.querySelectorAll('.batch-bar button');
  if (status) {
    status.classList.toggle('active', !!op);
    if (statusText) statusText.textContent = op || '';
  }
  if (progressBar) progressBar.style.display = op ? 'flex' : 'none';
  if (progressFill) progressFill.style.width = '0%';
  buttons.forEach(btn => {
    if (btn) btn.disabled = !!op;
  });
}

function endBatchOperation(msg, fn) {
  setBatchOperation('');
  if (msg) showToast(msg);
  if (fn) fn();
}

async function batchDelete() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  if (checked.length === 0) return;
  if (!confirm(T('ui.confirmDeleteSelected', {n: checked.length}))) return;
  const filenames = Array.from(checked).map(cb => decodeURIComponent(cb.value));
  setBatchOperation('删除中...');
  let deleted = 0, failed = 0;
  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i];
    const statusText = document.getElementById('batchStatusText');
    const progressFill = document.getElementById('batchProgressFill');
    if (statusText) statusText.textContent = '删除中 ' + (i + 1) + '/' + filenames.length;
    if (progressFill) progressFill.style.width = Math.round(((i + 1) / filenames.length) * 100) + '%';
    try {
      await fetch(API + '/api/file/' + filename + '?filename=' + encodeURIComponent(filename), { method: 'DELETE', headers: { 'x-auth-token': AUTH_TOKEN || '' } });
      deleted++;
    } catch (e) { failed++; }
  }
  endBatchOperation(T('msg.deletedN', { n: deleted }) + (failed ? ' (' + failed + ' 失败)' : ''), () => { clearBatch(); loadFiles(); });
}

async function batchCopy() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  if (checked.length === 0) return;
  const destPrefix = prompt(T('file.inputFolderPrefix') + ' (work/backup/): ' + checked.length + ' files');
  if (destPrefix === null) return;
  const cleanPrefix = destPrefix.trim();
  if (!cleanPrefix) return;

  const filenames = Array.from(checked).map(cb => decodeURIComponent(cb.value));
  setBatchOperation('复制中...');
  try {
    const res = await fetch(API + '/api/file/batch-copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ filenames, destFolder: cleanPrefix })
    });
    const data = await res.json();
    if (data.success) {
      endBatchOperation(T('msg.copiedTo', { n: filenames.length, dest: cleanPrefix }), () => { clearBatch(); loadFiles(); });
    } else {
      endBatchOperation(T('msg.copyFailedN', { n: 0, m: filenames.length }) + ': ' + data.error, () => clearBatch());
    }
  } catch (e) {
    endBatchOperation('复制失败: ' + e.message, () => clearBatch());
  }
}

async function batchMove() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  if (checked.length === 0) return;
  const destPrefix = prompt(T('ui.confirmMoveSelected').replace('{n}', checked.length));
  if (destPrefix === null) return;
  const cleanPrefix = destPrefix.trim();
  if (!cleanPrefix) return;

  const filenames = Array.from(checked).map(cb => decodeURIComponent(cb.value));
  setBatchOperation('移动中...');
  try {
    const res = await fetch(API + '/api/file/batch-move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ filenames, destFolder: cleanPrefix })
    });
    const data = await res.json();
    if (data.success) {
      endBatchOperation(T('ui.confirmMoveSelected').replace('{n}', filenames.length), () => { clearBatch(); loadFiles(); });
    } else {
      endBatchOperation(T('ui.confirmMoveSelected').replace('{n}', filenames.length) + ': ' + data.error, () => clearBatch());
    }
  } catch (e) {
    endBatchOperation('移动失败: ' + e.message, () => clearBatch());
  }
}

async function batchCreateShare() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  if (checked.length === 0) return;
  const filenames = Array.from(checked).map(cb => decodeURIComponent(cb.value));

  // Reuse the share options modal: pre-fill filename with count
  const filenameEl = document.getElementById('shareOptionsFilename');
  const fileNameDisplayEl = document.getElementById('shareOptionsFileName');
  const titleEl = document.getElementById('shareOptionsTitle');

  if (filenameEl) filenameEl.value = filenames.join(',');
  if (titleEl) titleEl.textContent = '🔗 ' + T('share.batchCreate').replace('{n}', filenames.length);
  if (fileNameDisplayEl) {
    fileNameDisplayEl.textContent = filenames.length + ' ' + T('ui.files') + ':\n' + filenames.map(f => '  · ' + f).join('\n');
    fileNameDisplayEl.style.whiteSpace = 'pre-wrap';
    fileNameDisplayEl.style.maxHeight = '120px';
    fileNameDisplayEl.style.overflowY = 'auto';
  }

  // Override doCreateShareLink to handle batch
  window._batchCreateShareFilenames = filenames;
  window._batchCreateShareOriginal = window.doCreateShareLink;

  // Patch doCreateShareLink temporarily
  window.doCreateShareLink = async function() {
    const filenames = window._batchCreateShareFilenames || [];
    if (!filenames.length) return;
    const expiryHours = parseInt(document.getElementById('shareExpiryHours').value) || 168;
    const maxDownloads = parseInt(document.getElementById('shareMaxDownloads').value) || null;
    const password = document.getElementById('sharePassword').value || null;
    closeShareOptionsModal();

    let success = 0, failed = 0;
    for (const filename of filenames) {
      try {
        const res = await fetch(API + '/api/share/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
          body: JSON.stringify({ filename, expiryHours: expiryHours || null, maxDownloads, password })
        });
        const data = await res.json();
        if (data.success) success++;
        else failed++;
      } catch (_) { failed++; }
    }
    showToast(T('share.batchResult').replace('{n}', success).replace('{m}', failed));
    window.doCreateShareLink = window._batchCreateShareOriginal;
    clearBatch();
  };

  document.getElementById('shareOptionsModal').classList.add('show');
}

async function batchStar() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  if (checked.length === 0) return;
  const filenames = Array.from(checked).map(cb => decodeURIComponent(cb.value));
  setBatchOperation('收藏中...');
  let starred = 0, errors = 0;
  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i];
    const statusText = document.getElementById('batchStatusText');
    const progressFill = document.getElementById('batchProgressFill');
    if (statusText) statusText.textContent = '收藏中 ' + (i + 1) + '/' + filenames.length;
    if (progressFill) progressFill.style.width = Math.round(((i + 1) / filenames.length) * 100) + '%';
    try {
      const res = await fetch(API + '/api/star/' + encodeURIComponent(filename), {
        method: 'POST',
        headers: { 'x-auth-token': AUTH_TOKEN || '' }
      });
      const data = await res.json();
      if (data.success && data.starred) starred++;
      else if (data.success) starred++;
      else errors++;
    } catch (e) { errors++; }
  }
  endBatchOperation(T('msg.batchStarred').replace('{n}', starred), () => { clearBatch(); loadFiles(); });
}

async function showFileVersions(filename) {
  // Store current filename for reload after delete
  window._versionsFilename = filename;
  const res = await fetch(API + '/api/file-versions/' + encodeURIComponent(filename), {
    headers: { 'x-auth-token': AUTH_TOKEN || '' }
  });
  const data = await res.json();
  if (!data.success) {
    showToast(T('ver.loadFailed') + ': ' + (data.error || T('admin.unknown')), 'error');
    return;
  }
  const versions = data.versions || [];
  let html = '';
  if (versions.length === 0) {
    html = '<div style="color:var(--text-muted);padding:20px;text-align:center;">' + T('ver.noVersions') + '</div>';
  } else {
    html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border-color);">' +
      '<div style="font-size:12px;color:var(--text-muted);">选择两个版本进行对比</div>' +
      '<button class="btn btn-sm" id="compareVersionsBtn" onclick="compareSelectedVersions()" disabled>对比</button>' +
      '</div>';
    html += '<div style="display:flex;flex-direction:column;gap:8px;">';
    for (const v of versions) {
      const ts = new Date(v.created_at * 1000).toLocaleString('zh-CN');
      const size = (v.size / 1024).toFixed(1) + ' KB';
      html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px;background:var(--bg-secondary);border-radius:8px;">' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
        '<input type="checkbox" class="version-compare-check" value="' + v.id + '" onchange="onVersionCheckChange()" style="width:16px;height:16px;cursor:pointer;">' +
        '<div style="font-weight:500;">v' + v.id + ' <span style="font-weight:400;font-size:11px;color:var(--text-muted);">' + ts + ' · ' + size + '</span></div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;">' +
        '<button class="btn btn-sm" onclick="previewVersion(' + v.id + ')">' + T('file.view') + '</button>' +
        '<button class="btn btn-sm" onclick="restoreVersion(' + v.id + ')">' + T('ver.restore') + '</button>' +
        '<button class="btn btn-sm btn-danger" onclick="deleteVersion(' + v.id + ')">' + T('tag.delete') + '</button>' +
        '</div>' +
        '</div>';
    }
    html += '</div>';
  }
  document.getElementById('versionsContent').innerHTML = html;
  document.getElementById('versionsModal').classList.add('show');
}

function closeVersionsModal() {
  document.getElementById('versionsModal').classList.remove('show');
  window._versionsFilename = null;
}

function onVersionCheckChange() {
  const checked = document.querySelectorAll('.version-compare-check:checked');
  const btn = document.getElementById('compareVersionsBtn');
  if (btn) {
    btn.disabled = checked.length !== 2;
    btn.textContent = '对比' + (checked.length === 2 ? ' (2)' : '');
  }
}

async function compareSelectedVersions() {
  const checked = document.querySelectorAll('.version-compare-check:checked');
  if (checked.length !== 2) return;
  const [aId, bId] = Array.from(checked).map(c => c.value);
  const [resA, resB] = await Promise.all([
    fetch(API + '/api/file-version/' + aId, { headers: { 'x-auth-token': AUTH_TOKEN || '' } }),
    fetch(API + '/api/file-version/' + bId, { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
  ]);
  const [dataA, dataB] = await Promise.all([resA.json(), resB.json()]);
  if (!dataA.success || !dataB.success) { showToast('无法加载版本内容', 'error'); return; }
  const vA = dataA.version, vB = dataB.version;
  const textA = vA.content || '';
  const textB = vB.content || '';
  const linesA = textA.split('\n'), linesB = textB.split('\n');
  // LCS-based line diff
  const lcs = computeLCS(linesA, linesB);
  let html = '<div style="margin-bottom:12px;"><button class="btn btn-sm" onclick="showFileVersions(\'' + escapeHtml(window._versionsFilename || '').replace(/'/g, "\\'") + '\')">← 返回列表</button></div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:500px;overflow-y:auto;">';
  html += '<div style="padding:8px;font-size:12px;">';
  for (let i = 0; i < linesA.length; i++) {
    const inLCS = lcs.has(i);
    const cls = inLCS ? '' : ' style="background:rgba(239,68,68,0.15);color:#f87171;"';
    html += '<div' + cls + '>' + (inLCS ? '' : '-') + escapeHtml(linesA[i] || ' ') + '</div>';
  }
  html += '</div><div style="padding:8px;font-size:12px;">';
  for (let i = 0; i < linesB.length; i++) {
    const inLCS = lcs.has(i);
    const cls = inLCS ? '' : ' style="background:rgba(34,197,94,0.15);color:#4ade80;"';
    html += '<div' + cls + '>' + (inLCS ? '' : '+') + escapeHtml(linesB[i] || ' ') + '</div>';
  }
  html += '</div></div>';
  html += '<div style="margin-top:8px;font-size:11px;color:var(--text-muted);">' +
    '<span style="color:#f87171;">- 旧版本</span> · <span style="color:#4ade80;">+ 新版本</span>' +
    '</div>';
  document.getElementById('versionsContent').innerHTML = html;
}

function computeLCS(a, b) {
  const m = a.length, n = b.length;
  // Build LCS index mapping: for each position in a, does it appear in LCS?
  // Simplified: use greedy longest common subsequence approximation
  const dp = Array.from({length: m + 1}, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i-1] === b[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
      else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }
  // Backtrack to find which rows in 'a' are in LCS
  const lcsSet = new Set();
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i-1] === b[j-1]) { lcsSet.add(i-1); i--; j--; }
    else if (dp[i-1][j] > dp[i][j-1]) i--;
    else j--;
  }
  return lcsSet;
}

async function showTrashModal() {
  const res = await fetch(API + '/api/trash', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
  const data = await res.json();
  if (!data.success) {
    showToast(T('ui.trashRestoreFailed'), 'error');
    return;
  }
  const trash = data.trash || [];
  let html = '';
  if (trash.length === 0) {
    html = '<div style="color:var(--text-muted);text-align:center;padding:20px;">' + T('ui.trashNoItems') + '</div>';
  } else {
    html = '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">';
    for (const item of trash) {
      const ts = new Date(item.deleted_at * 1000).toLocaleString('zh-CN');
      const size = item.size > 0 ? (item.size / 1024).toFixed(1) + ' KB' : '';
      const expiresIn = Math.max(0, Math.ceil((item.expires_at - Math.floor(Date.now() / 1000)) / 86400));
      html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px;background:var(--bg-secondary);border-radius:8px;">' +
        '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(item.filename) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);">' + ts + (size ? ' · ' + size : '') + ' · ' + T('ui.trashExpiresIn').replace('{n}', expiresIn) + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-shrink:0;">' +
        '<button class="btn btn-sm" onclick="restoreTrashItem(' + item.id + ')">' + T('ui.trashRestore') + '</button>' +
        '<button class="btn btn-sm btn-danger" onclick="permanentDeleteTrashItem(' + item.id + ')">' + T('ui.trashPermanentDelete') + '</button>' +
        '</div>' +
        '</div>';
    }
    html += '</div>';
    html += '<div style="text-align:center;margin-top:12px;"><button class="btn btn-sm btn-danger" onclick="emptyTrash()">' + T('ui.trashEmpty') + '</button></div>';
  }
  document.getElementById('trashContent').innerHTML = html;
  document.getElementById('trashModal').classList.add('show');
}

function closeTrashModal() {
  document.getElementById('trashModal').classList.remove('show');
}

async function restoreTrashItem(id) {
  const res = await fetch(API + '/api/trash/' + id + '/restore', { method: 'POST', headers: { 'x-auth-token': AUTH_TOKEN || '' } });
  const data = await res.json();
  if (data.success) {
    showToast(T('ui.trashRestoreSuccess') + data.filename);
    showTrashModal();
    loadFiles();
  } else {
    showToast(T('ui.trashRestoreFailed') + ': ' + (data.error || ''), 'error');
  }
}

async function permanentDeleteTrashItem(id) {
  if (!confirm(T('ui.trashEmptyConfirm'))) return;
  const res = await fetch(API + '/api/trash/' + id, { method: 'DELETE', headers: { 'x-auth-token': AUTH_TOKEN || '' } });
  const data = await res.json();
  if (data.success) {
    showToast(T('ui.trashDeleteSuccess'));
    showTrashModal();
  } else {
    showToast(T('ui.trashRestoreFailed'), 'error');
  }
}

async function emptyTrash() {
  if (!confirm(T('ui.trashEmptyConfirm'))) return;
  const res = await fetch(API + '/api/trash', { method: 'DELETE', headers: { 'x-auth-token': AUTH_TOKEN || '' } });
  const data = await res.json();
  if (data.success) {
    showToast(T('ui.trashEmptySuccess'));
    closeTrashModal();
  } else {
    showToast(T('ui.trashRestoreFailed'), 'error');
  }
}

async function previewVersion(versionId) {
  const res = await fetch(API + '/api/file-version/' + versionId, {
    headers: { 'x-auth-token': AUTH_TOKEN || '' }
  });
  const data = await res.json();
  if (!data.success || !data.version) {
    showToast(T('ver.loadFailed'), 'error');
    return;
  }
  const v = data.version;
  const content = escapeHtml(v.content || T('ver.empty'));
  document.getElementById('versionsContent').innerHTML =
    '<div style="margin-bottom:12px;"><button class="btn btn-sm" onclick="showFileVersions(\'' + escapeHtml(v.filename).replace(/'/g, "\\'") + '\')">' + T('ver.backToList') + '</button></div>' +
    '<div style="background:var(--bg-secondary);padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:400px;overflow-y:auto;">' + content + '</div>';
}

async function restoreVersion(versionId) {
  if (!confirm(T('ver.confirmRestore'))) return;
  const res = await fetch(API + '/api/file-version/' + versionId + '/restore', {
    method: 'POST',
    headers: { 'x-auth-token': AUTH_TOKEN || '' }
  });
  const data = await res.json();
  if (data.success) {
    showToast(T('ver.restored') + ' v' + versionId);
    closeVersionsModal();
    loadFiles();
  } else {
    showToast(T('ver.restoreFailed') + ' ' + (data.error || T('admin.unknown')), 'error');
  }
}

let _tagMergeSelected = new Set();
function showTagMergeUI() {
  const ui = document.getElementById('tagMergeUI');
  ui.style.display = 'block';
  _tagMergeSelected = new Set();
  renderTagMergeList();
}

function hideTagMergeUI() {
  document.getElementById('tagMergeUI').style.display = 'none';
}

function renderTagMergeList() {
  const list = document.getElementById('tagMergeSourceList');
  const targetSelect = document.getElementById('tagMergeTarget');
  const tags = _tagManagerData;

  if (!tags.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px;">' + T('admin.noTags') + '</div>';
    return;
  }

  list.innerHTML = tags.map(t => {
    const checked = _tagMergeSelected.has(t.tag);
    const tagJs = t.tag.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return '<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-radius:6px;transition:background 0.15s;" onmouseover="this.style.background=\'var(--bg-secondary)\'" onmouseout="this.style.background=\'\'">' +
      '<input type="checkbox" id="merge_src_' + tagJs.replace(/[^a-zA-Z0-9]/g, '_') + '" ' + (checked ? 'checked' : '') + ' onchange="toggleMergeTag(\'' + tagJs + '\')" style="accent-color:var(--accent-primary);">' +
      '<span style="font-size:13px;color:var(--text-primary);">' + escapeHtml(t.tag) + '</span>' +
      '<span style="font-size:11px;color:var(--text-muted);margin-left:auto;">' + t.count + '</span></label>';
  }).join('');

  // Target select: all tags except selected ones
  const targetTags = tags.filter(t => !_tagMergeSelected.has(t.tag));
  targetSelect.innerHTML = targetTags.map(t =>
    '<option value="' + escapeHtml(t.tag).replace(/"/g, '&quot;') + '">' + escapeHtml(t.tag) + ' (' + t.count + ')</option>'
  ).join('');

  if (targetTags.length === 0) {
    targetSelect.innerHTML = '<option value="">' + T('tag.mergeNoTarget') + '</option>';
  }
}

function toggleMergeTag(tag) {
  if (_tagMergeSelected.has(tag)) {
    _tagMergeSelected.delete(tag);
  } else {
    _tagMergeSelected.add(tag);
  }
  renderTagMergeList();
}

async function executeTagMerge() {
  if (_tagMergeSelected.size === 0) {
    showToast(T('tag.mergeSelectFirst'));
    return;
  }
  const targetTag = document.getElementById('tagMergeTarget').value;
  if (!targetTag) {
    showToast(T('tag.mergeNoTarget'));
    return;
  }
  const sources = Array.from(_tagMergeSelected);
  const res = await fetch(API + '/api/tags/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
    body: JSON.stringify({ sources, target: targetTag })
  });
  const data = await res.json();
  if (data.success) {
    showToast(T('tag.mergeSuccess', null, { n: data.updated, target: targetTag }));
    hideTagMergeUI();
    showTagManager();
    loadFiles();
  } else {
    showToast(data.error || T('tag.mergeFailed'));
  }
}

async function deleteVersion(versionId) {
  if (!confirm(T('ver.confirmDelete'))) return;
  const res = await fetch(API + '/api/file-version/' + versionId, {
    method: 'DELETE',
    headers: { 'x-auth-token': AUTH_TOKEN || '' }
  });
  const data = await res.json();
  if (data.success) {
    showToast(T('file.deleted'));
    if (window._versionsFilename) {
      showFileVersions(window._versionsFilename);
    }
  } else {
    showToast(T('file.deleteFailed'), 'error');
  }
}

function toggleTagSelect(tag, checked) {
  if (!window._selectedTags) window._selectedTags = new Set();
  if (checked) {
    window._selectedTags.add(tag);
  } else {
    window._selectedTags.delete(tag);
  }
  updateBatchTagBar();
}

function updateBatchTagBar() {
  const bar = document.getElementById('tagBatchBar');
  if (!bar) return;
  const count = window._selectedTags ? window._selectedTags.size : 0;
  if (count === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  bar.querySelector('span').textContent = count + ' ' + T('tag.selected');
}

async function openBatchColorPicker() {
  const tags = Array.from(window._selectedTags || []);
  if (!tags.length) return;
  const colors = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899','#6b7280'];
  const selected = await new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay show';
    overlay.style.zIndex = '10000';
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } };
    overlay.innerHTML = '<div class="modal-content" style="max-width:320px;padding:20px;">' +
      '<div style="font-size:14px;font-weight:500;margin-bottom:16px;">' + T('tag.changeColor') + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-bottom:16px;">' +
      colors.map(c => '<div style="width:40px;height:40px;border-radius:50%;background:' + c + ';cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.2);" data-color="' + c + '"></div>').join('') +
      '</div>' +
      '<button class="btn btn-secondary" style="width:100%;" id="batchColorCancelBtn">' + T('ui.cancel') + '</button>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-color]').forEach(el => {
      el.addEventListener('click', () => { const color = el.dataset.color; overlay.remove(); resolve(color); });
    });
    document.getElementById('batchColorCancelBtn').addEventListener('click', () => { overlay.remove(); resolve(null); });
  });
  if (!selected) return;
  // Single batch request for all selected tags
  const res = await fetch(API + '/api/tags/colors', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
    body: JSON.stringify({ colors: tags.map(tag => ({ tag, color: selected })) })
  });
  const data = await res.json();
  if (data.success) {
    showToast(T('tag.batchColorChanged', null, { n: data.updated }));
    showTagManager();
    loadFiles();
  }
}

async function batchDeleteTags() {
  const tags = Array.from(window._selectedTags || []);
  if (!tags.length) return;
  if (!confirm(T('tag.confirmBatchDelete', null, { n: tags.length }))) return;
  let deleted = 0;
  for (const tag of tags) {
    const res = await fetch(API + '/api/tags/delete/' + encodeURIComponent(tag), {
      method: 'DELETE',
      headers: { 'x-auth-token': AUTH_TOKEN || '' }
    });
    if (res.ok) deleted++;
  }
  showToast(T('tag.batchDeleted', null, { n: deleted }));
  showTagManager();
  loadFiles();
}

async function showTagManager() {
  await loadTagColors();
  const res = await fetch(API + '/api/tags/list', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
  const data = await res.json();
  _tagManagerData = (data.success && data.tags) ? data.tags : [];
  window._selectedTags = new Set();
  // Reset search filter on open
  const searchInput = document.getElementById('tagManagerSearch');
  if (searchInput) searchInput.value = '';
  renderTagManagerItems(_tagManagerData);
  updateBatchTagBar();
  document.getElementById('tagManagerModal').classList.add('show');
  lockScroll();
}

function closeTagManager() {
  unlockScroll();
  document.getElementById('tagManagerModal').classList.remove('show');
}

let _tagManagerData = [];  // cache for filtering
function filterTagManagerList(q) {
  const list = document.getElementById('tagManagerList');
  if (!q.trim()) {
    renderTagManagerItems(_tagManagerData);
    return;
  }
  const lq = q.toLowerCase();
  renderTagManagerItems(_tagManagerData.filter(t => t.tag.toLowerCase().includes(lq)));
}
function renderTagManagerItems(tags) {
  const list = document.getElementById('tagManagerList');
  if (!tags.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">' + T('admin.noTags') + '</div>';
    return;
  }
  list.innerHTML = tags.map(t => {
    const color = t.color || '#667eea';
    const emoji = t.emoji || '🏷';
    const tagHtml = escapeHtml(t.tag);                              // HTML-safe for display
    const tagJs = t.tag.replace(/\\/g, '\\\\').replace(/'/g, "\\'");  // JS-string-safe for onclick
    const tagId = t.tag.replace(/[^a-zA-Z0-9]/g, '_');             // safe ID
    const checked = window._selectedTags && window._selectedTags.has(t.tag) ? 'checked' : '';
    return '<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-tertiary);border-radius:12px;border:1px solid var(--border-color);transition:border-color 0.15s;">' +
      '<input type="checkbox" id="tagchk_' + tagId + '" ' + checked + ' onchange="toggleTagSelect(\'' + tagJs + '\', this.checked)" style="width:18px;height:18px;cursor:pointer;accent-color:var(--accent-primary);flex-shrink:0;" title="批量选择">' +
      '<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0;">' +
        '<div style="width:36px;height:28px;border-radius:6px;background:' + color + ';display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.15);" title="' + T('tag.clickChangeColor') + '" onclick="document.getElementById(\'colorPicker_' + tagId + '\').click()">' +
          '<span style="font-size:14px;">' + escapeHtml(emoji) + '</span>' +
          '<input type="color" id="colorPicker_' + tagId + '" value="' + color + '" style="position:absolute;width:0;height:0;opacity:0;" onchange="updateTagColor(\'' + tagJs + '\', this.value);">' +
        '</div>' +
        // Emoji picker trigger
        '<span style="font-size:10px;color:var(--text-muted);cursor:pointer;" title="Change icon" onclick="changeTagEmoji(\'' + tagJs + '\')">✏️</span>' +
      '</div>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:14px;font-weight:500;color:var(--text-primary);cursor:pointer;" ondblclick="renameTag(\'' + tagJs + '\')" title="' + T('tag.doubleClickRename') + '">' + tagHtml + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;cursor:pointer;" onclick="filterByTag(\'' + tagJs + '\');closeTagManager()" title="' + T('tag.viewFiles') + '"><span style="color:var(--accent-primary);">' + t.count + '</span> ' + T('tag.count') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;align-items:center;">' +
        '<button class="btn btn-sm" style="font-size:11px;padding:8px 10px;min-height:44px;" onclick="renameTag(\'' + tagJs + '\')" title="' + T('tag.rename') + '">✏️</button>' +
        '<button class="btn btn-sm btn-danger" style="font-size:11px;padding:8px 10px;min-height:44px;" onclick="deleteTag(\'' + tagJs + '\')" title="' + T('tag.delete') + '">🗑</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function renameTag(oldTag) {
  const newTag = prompt(T('tag.renamePrompt', null, {old: oldTag}), oldTag);
  if (!newTag || newTag === oldTag) return;
  const res = await fetch(API + '/api/tags/rename/' + encodeURIComponent(oldTag), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
    body: JSON.stringify({ newTag })
  });
  const data = await res.json();
  if (data.success) {
    showToast(T('tag.renameSuccess', null, {n: data.updated}));
    showTagManager();
    loadFiles();
  } else {
    showToast(T('tag.renameFailed'));
  }
}

async function deleteTag(tag) {
  if (!confirm(T('tag.confirmDelete', null, {name: tag}))) return;
  const res = await fetch(API + '/api/tags/delete/' + encodeURIComponent(tag), {
    method: 'DELETE',
    headers: { 'x-auth-token': AUTH_TOKEN || '' }
  });
  const data = await res.json();
  if (data.success) {
    showToast(T('tag.removed', null, {n: data.updated}));
    showTagManager();
    loadFiles();
  } else {
    showToast(T('tag.renameFailed'));
  }
}

async function updateTagColor(tag, color) {
  const res = await fetch(API + '/api/tags/color', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
    body: JSON.stringify({ tag, color })
  });
  const data = await res.json();
  if (data.success) {
    tagColors[tag] = color;
    // 更新当前页面所有该标签的颜色
    document.querySelectorAll('.file-tag').forEach(el => {
      if (el.textContent.trim().replace('×', '') === tag) {
        el.style.background = color + '33';
        el.style.color = color;
        el.style.borderColor = color;
      }
    });
    showToast(T('tag.colorChanged'));
  }
}

let _emojiPickerTag = null;  // currently editing emoji for this tag
let _selectedEmoji = '🏷';

const TAG_EMOJI_PRESETS = ['🏷','📁','⭐','❤️','🔥','💡','📌','📝','🎯','🔑','🔐','🌟','📦','🎨','💻','🌐','🔔','📊','💾','🗂️'];

function openEmojiModal(tag) {
  _emojiPickerTag = tag;
  _selectedEmoji = tagEmojis[tag] || '🏷';
  document.getElementById('emojiPreview').textContent = _selectedEmoji;
  document.getElementById('emojiTagName').textContent = tag;
  document.getElementById('emojiCustomInput').value = '';
  lockScroll();
  // Build presets
  const presetsEl = document.getElementById('emojiPresets');
  presetsEl.innerHTML = TAG_EMOJI_PRESETS.map(e =>
    '<span onclick="selectEmojiPreset(\'' + e.replace(/'/g, "\\'") + '\')" style="font-size:24px;cursor:pointer;padding:4px;border-radius:8px;">' + e + '</span>'
  ).join('');
  document.getElementById('emojiModal').classList.add('show');
}

function closeEmojiModal() {
  document.getElementById('emojiModal').classList.remove('show');
  unlockScroll();
  _emojiPickerTag = null;
}

function selectEmojiPreset(emoji) {
  _selectedEmoji = emoji;
  document.getElementById('emojiPreview').textContent = emoji;
  document.getElementById('emojiCustomInput').value = emoji;
}

function updateEmojiPreview(text) {
  if (text.length > 0) {
    _selectedEmoji = text.slice(-2);  // take last grapheme
    document.getElementById('emojiPreview').textContent = _selectedEmoji;
  }
}

async function confirmEmojiChange() {
  if (!_emojiPickerTag) return;
  const emoji = _selectedEmoji;
  const tag = _emojiPickerTag;
  closeEmojiModal();
  const res = await fetch(API + '/api/tags/emoji', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
    body: JSON.stringify({ tag, emoji })
  });
  const data = await res.json();
  if (data.success) {
    tagEmojis[tag] = emoji;
    showToast(T('tag.iconChanged'));
    showTagManager();
  } else {
    showToast(T('tag.iconChangeFailed'));
  }
}

// expose changeTagEmoji for inline onclick
window.changeTagEmoji = openEmojiModal;

async function batchAddTag() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  if (checked.length === 0) return;
  const tag = prompt(T('tag.inputName'));
  if (!tag || !tag.trim()) return;
  const newTags = tag.split(',').map(t => t.trim()).filter(t => t);
  if (newTags.length === 0) return;

  setBatchOperation('标签中...');
  const files = Array.from(checked).map(cb => cb.value);

  // Auto-assign colors for new tags
  for (let i = 0; i < newTags.length; i++) {
    const t = newTags[i];
    if (!tagColors[t]) {
      try {
        const res = await fetch(API + '/api/tags/suggest-color?tag=' + encodeURIComponent(t), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
        const data = await res.json();
        if (data.success) {
          tagColors[t] = data.color;
          await fetch(API + '/api/tags/color', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
            body: JSON.stringify({ tag: t, color: data.color })
          });
        }
      } catch (e) {}
    }
    const statusText = document.getElementById('batchStatusText');
    if (statusText) statusText.textContent = '标签 ' + (i + 1) + '/' + newTags.length;
  }

  // Use batch API - single call for all files
  try {
    const res = await fetch(API + '/api/file-tags/batch', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ files, action: 'add', tags: newTags })
    });
    const data = await res.json();
    if (data.success) {
      endBatchOperation(T('tag.added', null, {n: data.updated}), () => { clearBatch(); loadFiles(); });
    } else {
      showToast(T('tag.addFailed') + ' ' + (data.error || T('admin.unknown')), 'error');
      clearBatch();
    }
  } catch (e) {
    showToast(T('tag.addFailed') + ' ' + e.message, 'error');
    clearBatch();
  }
}

async function batchRemoveTag() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  if (checked.length === 0) return;

  // Collect all tags from selected files
  const tagSet = new Map();
  Array.from(checked).forEach(cb => {
    const fn = cb.value;
    const file = currentFiles.find(f => encodeURIComponent(f.name) === fn);
    if (file && file.tags) {
      file.tags.split(',').map(t => t.trim()).filter(t => t).forEach(t => {
        tagSet.set(t, (tagSet.get(t) || 0) + 1);
      });
    }
  });

  if (tagSet.size === 0) {
    showToast(T('tag.noneToRemove') || 'No tags to remove', 'error');
    return;
  }

  // Build modal content with existing tags as clickable chips
  const tagChips = Array.from(tagSet.entries()).map(([tag, count]) => {
    const style = getTagStyle(tag) || 'background:rgba(102,126,234,0.2);color:var(--accent-primary);';
    return '<span class="batch-tag-chip" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:16px;font-size:13px;cursor:pointer;' + style + '" data-tag="' + escapeHtml(tag) + '" onclick="batchRemoveTagSelect(this)">' +
      escapeHtml(tag) + ' <sup style="font-size:10px;opacity:0.7;">' + count + '</sup></span>';
  }).join('');

  const content = '<div style="padding:8px 0;text-align:center;color:var(--text-muted);font-size:12px;margin-bottom:12px;">' + T('tag.removePrompt') + '</div>' +
    '<div id="batchRemoveTagList" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;">' + tagChips + '</div>' +
    '<div id="batchRemoveTagSelected" style="font-size:12px;color:var(--accent-primary);margin-bottom:12px;min-height:20px;"></div>' +
    '<div style="display:flex;gap:8px;"><button class="btn" id="batchRemoveTagConfirm" style="flex:1;opacity:0.5;pointer-events:none;" disabled onclick="confirmBatchRemoveTag()">' + T('ui.remove') + '</button>' +
    '<button class="btn btn-secondary" style="flex:1;" onclick="closeBatchRemoveTagModal()">' + T('ui.cancel') + '</button></div>';

  _batchRemoveSelectedTags = [];
  // Reuse tagInputModal structure
  document.getElementById('tagInputModalTitle').textContent = '\u0001\u000f ' + T('ui.batchRemoveTag');
  document.getElementById('tagInputFileName').textContent = T('ui.selectedN').replace('{n}', files.length) + ' ' + T('ui.files');
  document.getElementById('tagInputExisting').innerHTML = content;
  document.getElementById('tagInputField').style.display = 'none';
  document.getElementById('tagInputColorPicker').style.display = 'none';
  document.querySelector('#tagInputModal .modal-content').querySelector('div[style*="font-size:11px"]').style.display = 'none';
  lockScroll();
  document.getElementById('tagInputModal').classList.add('show');
}

let _batchRemoveSelectedTags = [];

function batchRemoveTagSelect(el) {
  const tag = el.dataset.tag;
  el.classList.toggle('selected');
  if (_batchRemoveSelectedTags.includes(tag)) {
    _batchRemoveSelectedTags = _batchRemoveSelectedTags.filter(t => t !== tag);
  } else {
    _batchRemoveSelectedTags.push(tag);
  }
  const confirmBtn = document.getElementById('batchRemoveTagConfirm');
  const selectedDiv = document.getElementById('batchRemoveTagSelected');
  if (_batchRemoveSelectedTags.length > 0) {
    confirmBtn.style.opacity = '1';
    confirmBtn.style.pointerEvents = 'auto';
    selectedDiv.textContent = T('ui.selectedN').replace('{n}', _batchRemoveSelectedTags.length) + ': ' + _batchRemoveSelectedTags.join(', ');
  } else {
    confirmBtn.style.opacity = '0.5';
    confirmBtn.style.pointerEvents = 'none';
    selectedDiv.textContent = '';
  }
}

function closeBatchRemoveTagModal() {
  document.getElementById('tagInputModal').classList.remove('show');
  // Restore tagInputModal state for normal tag input usage
  document.getElementById('tagInputField').style.display = '';
  document.getElementById('tagInputColorPicker').style.display = '';
  const hint = document.querySelector('#tagInputModal .modal-content [style*="font-size:11px"]');
  if (hint) hint.style.display = '';
  unlockScroll();
}

async function confirmBatchRemoveTag() {
  if (_batchRemoveSelectedTags.length === 0) return;
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  const files = Array.from(checked).map(cb => cb.value);

  try {
    const res = await fetch(API + '/api/file-tags/batch', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ files, action: 'remove', tags: _batchRemoveSelectedTags })
    });
    const data = await res.json();
    if (data.success) {
      showToast(T('tag.removedN', null, {n: data.updated}));
    } else {
      showToast(T('tag.removeFailed') + ' ' + (data.error || ''), 'error');
    }
  } catch (e) {
    showToast(T('tag.removeFailed') + ' ' + e.message, 'error');
  }
  closeBatchRemoveTagModal();
  clearBatch();
  loadFiles();
}

function showBatchRenameModal() {
  const checked = document.querySelectorAll('.batch-checkbox:checked');
  if (checked.length === 0) return;
  const filenames = Array.from(checked).map(cb => cb.value);
  const body = document.getElementById('modalBody');
  const previewList = filenames.slice(0, 5).map(f => '<div style="font-size:12px;color:var(--text-muted);word-break:break-all;">' + escapeHtml(decodeURIComponent(f)) + '</div>').join('');
  const more = filenames.length > 5 ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">以及其他 ' + (filenames.length - 5) + ' 个文件</div>' : '';
  body.innerHTML =
    '<div style="display:flex;flex-direction:column;gap:12px;">' +
      '<div>' +
        '<label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:4px;">操作类型</label>' +
        '<select id="brOpType" onchange="onBrOpTypeChange(); updateBatchRenamePreview()" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);font-size:13px;">' +
          '<option value="replace">查找替换</option>' +
          '<option value="prefix">添加前缀</option>' +
          '<option value="suffix">添加后缀</option>' +
          '<option value="case">切换大小写</option>' +
          '<option value="seq">顺序编号</option>' +
        '</select>' +
      '</div>' +
      '<div id="brReplaceFields">' +
        '<label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:4px;">查找</label>' +
        '<input id="brFind" type="text" placeholder="要替换的文本" oninput="updateBatchRenamePreview()" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">' +
        '<label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:4px;margin-top:8px;">替换为</label>' +
        '<input id="brReplace" type="text" placeholder="替换为（留空则删除）" oninput="updateBatchRenamePreview()" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">' +
      '</div>' +
      '<div id="brPrefixSuffixField" style="display:none;">' +
        '<label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:4px;">文本</label>' +
        '<input id="brText" type="text" placeholder="输入前缀或后缀" oninput="updateBatchRenamePreview()" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">' +
      '</div>' +
      '<div id="brSeqField" style="display:none;">' +
        '<div style="display:flex;gap:8px;margin-bottom:4px;">' +
          '<div style="flex:1;">' +
            '<label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:4px;">前缀</label>' +
            '<input id="brSeqPrefix" type="text" placeholder="文件名前缀" oninput="updateBatchRenamePreview()" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">' +
          '</div>' +
          '<div style="width:100px;">' +
            '<label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:4px;">起始号</label>' +
            '<input id="brSeqStart" type="number" value="1" min="0" oninput="updateBatchRenamePreview()" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">' +
          '</div>' +
          '<div style="width:80px;">' +
            '<label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:4px;">位数</label>' +
            '<input id="brSeqPad" type="number" value="3" min="1" max="6" oninput="updateBatchRenamePreview()" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">' +
          '</div>' +
        '</div>' +
        '<label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:4px;margin-top:4px;">后缀（留空保留原扩展名）</label>' +
        '<input id="brSeqSuffix" type="text" placeholder="如 .txt 或 _备注" oninput="updateBatchRenamePreview()" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);font-size:13px;box-sizing:border-box;">' +
      '</div>' +
      '<div id="brPreviewArea" style="background:var(--bg-tertiary);border-radius:8px;padding:12px;max-height:200px;overflow:auto;">' +
        '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">预览（前5个）</div>' +
        '<div id="brPreviewList">' + previewList + more + '</div>' +
      '</div>' +
    '</div>';
  document.getElementById('modalTitle').textContent = '✏️ 批量重命名 (' + filenames.length + ' 个文件)';
  document.getElementById('modalMeta').textContent = '';
  const footer = document.getElementById('modalFooter');
  footer.style.display = 'flex';
  footer.style.gap = '8px';
  footer.style.justifyContent = 'flex-end';
  footer.innerHTML = '<button class="btn btn-sm" onclick="batchRename()">确认重命名</button><button class="btn btn-sm btn-secondary" onclick="closeModal()">取消</button>';
  lockScroll();
  document.getElementById('fileModal').classList.add('show');
  window._batchRenameFiles = filenames;
}

function onBrOpTypeChange() {
  const op = document.getElementById('brOpType').value;
  const replaceFields = document.getElementById('brReplaceFields');
  const prefixSuffixField = document.getElementById('brPrefixSuffixField');
  const seqField = document.getElementById('brSeqField');
  if (replaceFields) replaceFields.style.display = op === 'replace' ? 'block' : 'none';
  if (prefixSuffixField) prefixSuffixField.style.display = (op === 'prefix' || op === 'suffix' || op === 'seq') ? 'block' : 'none';
  if (seqField) seqField.style.display = op === 'seq' ? 'block' : 'none';
}

function updateBatchRenamePreview() {
  const op = document.getElementById('brOpType').value;
  const find = (document.getElementById('brFind') || {}).value || '';
  const repl = (document.getElementById('brReplace') || {}).value || '';
  const text = (document.getElementById('brText') || {}).value || '';
  const files = window._batchRenameFiles || [];
  const preview = files.slice(0, 5).map((f, idx) => {
    const fn = decodeURIComponent(f);
    const ext = fn.includes('.') ? fn.split('.').pop() : '';
    const base = ext ? fn.slice(0, -(ext.length + 1)) : fn;
    let newBase = base;
    if (op === 'replace') newBase = find ? base.split(find).join(repl) : base;
    else if (op === 'prefix') newBase = text + base;
    else if (op === 'suffix') newBase = base + text;
    else if (op === 'case') newBase = base === base.toLowerCase() ? base.toUpperCase() : base.toLowerCase();
    else if (op === 'seq') {
      const start = parseInt((document.getElementById('brSeqStart') || {}).value) || 1;
      const pad = parseInt((document.getElementById('brSeqPad') || {}).value) || 3;
      const prefix = (document.getElementById('brSeqPrefix') || {}).value || '';
      const suffix = (document.getElementById('brSeqSuffix') || {}).value || ('.' + ext);
      const num = String(start + idx).padStart(pad, '0');
      newBase = prefix + num;
      const newFn = suffix ? newBase + suffix : newBase;
      const changed = newFn !== fn;
      return '<div style="font-size:12px;word-break:break-all;margin:3px 0;">' +
        (changed ? '<span style="color:var(--text-muted);text-decoration:line-through;">' + escapeHtml(fn) + '</span> → <span style="color:var(--success-fg);">' + escapeHtml(newFn) + '</span>' :
         '<span>' + escapeHtml(fn) + '</span>') + '</div>';
    }
    const newFn = ext ? newBase + '.' + ext : newBase;
    const changed = newFn !== fn;
    return '<div style="font-size:12px;word-break:break-all;margin:3px 0;">' +
      (changed ? '<span style="color:var(--text-muted);text-decoration:line-through;">' + escapeHtml(fn) + '</span> → <span style="color:var(--success-fg);">' + escapeHtml(newFn) + '</span>' :
       '<span>' + escapeHtml(fn) + '</span>') + '</div>';
  }).join('');
  const more = files.length > 5 ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">以及其他 ' + (files.length - 5) + ' 个文件</div>' : '';
  const el = document.getElementById('brPreviewList');
  if (el) el.innerHTML = preview + more;
}

async function batchRename() {
  const op = document.getElementById('brOpType').value;
  const find = (document.getElementById('brFind') || {}).value || '';
  const repl = (document.getElementById('brReplace') || {}).value || '';
  const text = (document.getElementById('brText') || {}).value || '';
  const files = window._batchRenameFiles || [];
  setBatchOperation('重命名中...');
  let renamed = 0, failed = 0;
  for (let i = 0; i < files.length; i++) {
    const oldEnc = files[i];
    const oldFn = decodeURIComponent(oldEnc);
    const ext = oldFn.includes('.') ? oldFn.split('.').pop() : '';
    const base = ext ? oldFn.slice(0, -(ext.length + 1)) : oldFn;
    let newBase = base, newFn;
    if (op === 'replace') { newBase = find ? base.split(find).join(repl) : base; newFn = ext ? newBase + '.' + ext : newBase; }
    else if (op === 'prefix') { newBase = text + base; newFn = ext ? newBase + '.' + ext : newBase; }
    else if (op === 'suffix') { newBase = base + text; newFn = ext ? newBase + '.' + ext : newFn; }
    else if (op === 'case') { newBase = base === base.toLowerCase() ? base.toUpperCase() : base.toLowerCase(); newFn = ext ? newBase + '.' + ext : newBase; }
    else if (op === 'seq') {
      const start = parseInt((document.getElementById('brSeqStart') || {}).value) || 1;
      const pad = parseInt((document.getElementById('brSeqPad') || {}).value) || 3;
      const prefix = (document.getElementById('brSeqPrefix') || {}).value || '';
      const suffix = (document.getElementById('brSeqSuffix') || {}).value || ('.' + ext);
      newFn = prefix + String(start + i).padStart(pad, '0') + suffix;
    }
    if (!newFn || newFn === oldFn) continue;
    const statusText = document.getElementById('batchStatusText');
    const progressFill = document.getElementById('batchProgressFill');
    if (statusText) statusText.textContent = '重命名中 ' + (i + 1) + '/' + files.length;
    if (progressFill) progressFill.style.width = Math.round(((i + 1) / files.length) * 100) + '%';
    try {
      const res = await fetch(API + '/api/file-rename/' + oldEnc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
        body: JSON.stringify({ newFilename: newFn.trim() })
      });
      const data = await res.json();
      if (data.success) renamed++;
      else failed++;
    } catch (e) { failed++; }
  }
  closeModal();
  endBatchOperation('已重命名 ' + renamed + ' 个文件' + (failed > 0 ? '，' + failed + ' 个失败' : ''), () => { clearBatch(); loadFiles(); });
}

// Favorites (localStorage)
function getFavorites() {
  try { return JSON.parse(localStorage.getItem('sharetool_favorites') || '[]'); }
  catch (e) { return []; }
}

function toggleFavorite(filename) {
  const decoded = decodeURIComponent(filename);
  fetch(API + '/api/star/' + encodeURIComponent(decoded), { method: 'POST', headers: { 'x-auth-token': getToken() } })
    .then(r => r.json())
    .then(data => {
      if (!data.success) { showToast('Star failed'); return; }
      // Update localStorage favorites
      let favs = getFavorites();
      if (data.starred) {
        if (!favs.includes(decoded)) { favs.unshift(decoded); favs = favs.slice(0, 20); }
      } else {
        favs = favs.filter(f => f !== decoded);
      }
      try { localStorage.setItem('sharetool_favorites', JSON.stringify(favs)); } catch (e) {}
      // Update star UI
      const isFav = data.starred;
      const starEl = document.querySelector('[data-starfile="' + filename + '"]');
      if (starEl) {
        starEl.classList.toggle('starred', isFav);
        starEl.textContent = isFav ? '★' : '☆';
      }
    })
    .catch(() => {});
}

function updateFavoritesInView() {
  const favs = getFavorites();
  document.querySelectorAll('[data-starfile]').forEach(el => {
    const filename = decodeURIComponent(el.getAttribute('data-starfile'));
    const isFav = favs.includes(filename);
    el.classList.toggle('starred', isFav);
    el.textContent = isFav ? '★' : '☆';
  });
}

function showFavoritesManager() {
  const favs = getFavorites();
  const list = document.getElementById('favoritesManagerList');
  if (!favs.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">' + T('fav.noFavorites') + '</div>';
  } else {
    list.innerHTML = favs.map(f => {
      const enc = encodeURIComponent(f);
      return '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-tertiary);border-radius:8px;">' +
        '<span style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(f) + '</span>' +
        '<button class="btn btn-sm" style="font-size:11px;padding:4px 8px;" onclick="navigateToFav(\'' + enc + '\')">' + T('fav.goTo') + '</button>' +
        '<button class="btn btn-sm btn-danger" style="font-size:11px;padding:4px 8px;" onclick="removeFav(\'' + enc + '\')">' + T('tag.delete') + '</button>' +
      '</div>';
    }).join('');
  }
  lockScroll();
  document.getElementById('favoritesModal').classList.add('show');
}

function closeFavoritesManager() {
  unlockScroll();
  document.getElementById('favoritesModal').classList.remove('show');
}

function navigateToFav(encodedFilename) {
  const filename = decodeURIComponent(encodedFilename);
  closeFavoritesManager();
  // Clear any tag/search filter
  clearTagFilter();
  // Navigate to the file's folder if in a virtual folder
  const lastSlash = filename.lastIndexOf('/');
  if (lastSlash > 0) {
    const folder = filename.substring(0, lastSlash);
    window.currentFolder = folder;
    window.currentSearchQ = '';
    document.getElementById('searchInput').value = '';
    loadFiles();
  }
  // Highlight and scroll to the file
  setTimeout(() => {
    const el = document.querySelector('[data-starfile="' + encodeURIComponent(filename) + '"]');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('focused');
      setTimeout(() => el.classList.remove('focused'), 2000);
    }
  }, 100);
}

function removeFav(encodedFilename) {
  const filename = decodeURIComponent(encodedFilename);
  let favs = getFavorites().filter(f => f !== filename);
  try { localStorage.setItem('sharetool_favorites', JSON.stringify(favs)); } catch (e) {}
  updateFavoritesInView();
  // Re-render list
  showFavoritesManager();
  showToast(T('fav.removed'));
}

// Notification badge for WS changes
let notifCount = 0;
function incrementBadge() {
  notifCount++;
  const badge = document.getElementById('notifBadge');
  if (badge) {
    badge.textContent = notifCount > 9 ? '9+' : notifCount;
    badge.classList.add('show');
  }
}

function clearBadge() {
  notifCount = 0;
  const badge = document.getElementById('notifBadge');
  if (badge) badge.classList.remove('show');
}

document.addEventListener('click', () => clearBadge());

// Paste from clipboard (for images)
document.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const textArea = document.getElementById('textContent');
  if (!textArea || document.activeElement !== textArea) return;
  
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          const filename = 'paste_' + Date.now() + '.' + (file.type.split('/')[1] || 'png');
          fetch(API + '/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
            body: JSON.stringify({ filename, content: base64, type: 'file' })
          }).then(r => r.json()).then(data => {
            if (data.success) {
              showToast(T('msg.pasted') + filename);
              loadFiles();
            }
          });
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  }
});

// 批量选择处理
document.addEventListener('change', (e) => {
  if (e.target.classList.contains('batch-checkbox')) {
    updateBatchBar();
  }
});

async function batchDownload() {
  const checkboxes = document.querySelectorAll('.batch-checkbox:checked');
  if (checkboxes.length === 0) {
    showAlert('listAlert', T('file.noFileSelected'), 'error');
    return;
  }
  
  const filenames = Array.from(checkboxes).map(cb => decodeURIComponent(cb.value));
  
  try {
    const res = await fetch(API + '/api/batch-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
      body: JSON.stringify({ filenames })
    });
    
    const contentType = res.headers.get('Content-Type');
    
    if (contentType && contentType.includes('application/json')) {
      const data = await res.json();
      if (data.mode === 'multiple') {
        showAlert('listAlert', T('msg.batchPackUnavailable'), 'info');
        for (const f of data.files) {
          window.open(API + '/download/' + encodeURIComponent(f.name), '_blank');
        }
      } else {
        showAlert('listAlert', T('msg.downloadFailed') + ': ' + data.error, 'error');
      }
    } else if (contentType && contentType.includes('zip')) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sharetool_batch.zip';
      a.click();
      URL.revokeObjectURL(url);
      showAlert('listAlert', T('msg.batchDownloadSuccess'), 'success');
    }
  } catch (e) {
    showAlert('listAlert', T('msg.batchDownloadFailed') + ': ' + e.message, 'error');
  }
}

function saveDownloadDir() {
  const dir = document.getElementById('downloadDir').value.trim();
  const resolved = path.isAbsolute(dir) ? dir : path.resolve(dir);
  localStorage.setItem('shareTool_downloadDir', resolved);
  config.downloadDir = resolved;
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  showAlert('listAlert', T('msg.downloadDirSaved'), 'success');
}

// 搜索回车/实时搜索
let selectedSuggestionIndex = -1;
let currentSuggestions = [];

document.getElementById('searchInput').addEventListener('keydown', (e) => {
  const container = document.getElementById('searchSuggestions');
  const isVisible = container && container.style.display !== 'none';

  if (isVisible && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape')) {
    if (e.key === 'Escape') {
      hideSuggestions();
      selectedSuggestionIndex = -1;
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedSuggestionIndex = Math.min(selectedSuggestionIndex + 1, currentSuggestions.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, 0);
    } else if (e.key === 'Enter') {
      if (selectedSuggestionIndex >= 0 && currentSuggestions[selectedSuggestionIndex]) {
        e.preventDefault();
        const s = currentSuggestions[selectedSuggestionIndex];
        applySuggestion(s.text, s.type);
        return;
      }
      doSearch();
      return;
    }
    updateSuggestionSelection();
    return;
  }
  // Enter without selection → normal search
  if (e.key === 'Enter') {
    doSearch();
  }
});

// 实时搜索（输入时自动搜索）
let searchDebounce = null;
let suggestDebounce = null;
document.getElementById('searchInput').addEventListener('input', () => {
  selectedSuggestionIndex = -1;
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(doSearch, 400);
  // 搜索自动补全
  const q = document.getElementById('searchInput').value.trim();
  if (suggestDebounce) clearTimeout(suggestDebounce);
  if (q.length < 1) {
    hideSuggestions();
    // 空搜索时显示最近搜索
    const recent = getRecentSearches();
    if (recent.length > 0) {
      document.getElementById('recentSearches').style.display = 'flex';
    }
    return;
  }
  document.getElementById('recentSearches').style.display = 'none';
  suggestDebounce = setTimeout(() => fetchSuggestions(q), 200);
});

// Cmd/Ctrl+K 全局搜索快捷键
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    const input = document.getElementById('searchInput');
    if (input) { input.focus(); input.select(); }
  }
});

async function fetchSuggestions(q) {
  try {
    const res = await fetch(API + '/api/search/suggest?q=' + encodeURIComponent(q), { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success && data.suggestions.length > 0) {
      renderSuggestions(data.suggestions);
    } else {
      hideSuggestions();
    }
  } catch (e) { hideSuggestions(); }
}

async function fetchTrendingSearches() {
  try {
    const res = await fetch(API + '/api/search/popular?limit=5', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    if (data.success && data.popular && data.popular.length > 0) {
      const trending = data.popular.map(item => ({
        text: item.query,
        type: 'trending',
        icon: '🔥',
        count: item.count,
        color: null
      }));
      renderSuggestions(trending);
    }
  } catch (e) { /* silent fail */ }
}

function renderSuggestions(suggestions) {
  const container = document.getElementById('searchSuggestions');
  currentSuggestions = suggestions;
  selectedSuggestionIndex = -1;
  container.innerHTML = suggestions.map((s, i) => {
    const tagStyle = s.color ? 'background:rgba(' + hexToRgb(s.color) + ',0.2);color:' + s.color + ';' : 'background:rgba(102,126,234,0.2);color:var(--accent-primary);';
    const tagLabel = s.type === 'tag' ? '<span class="suggestion-tag" style="' + tagStyle + '">tag</span>' : s.type === 'syntax' ? '<span class="suggestion-tag" style="background:rgba(102,126,234,0.2);color:var(--accent-primary);">content</span>' : s.type === 'trending' ? '<span class="suggestion-tag" style="background:rgba(255,100,50,0.15);color:#ff6432;">' + (s.count || '') + '</span>' : '';
    return '<div class="search-suggestion' + (i === 0 ? ' selected' : '') + '" data-idx="' + i + '" onclick="applySuggestion(\'' + escapeHtml(s.text).replace(/'/g, "\\'") + '\', \'' + s.type + '\')">' +
      '<span class="suggestion-icon">' + escapeHtml(s.icon || '') + '</span>' +
      '<span>' + escapeHtml(s.text) + '</span>' +
      tagLabel +
      '</div>';
  }).join('');
  container.style.display = 'block';
  // Auto-select first item
  if (suggestions.length > 0) selectedSuggestionIndex = 0;
}

function updateSuggestionSelection() {
  const container = document.getElementById('searchSuggestions');
  container.querySelectorAll('.search-suggestion').forEach((el, i) => {
    el.classList.toggle('selected', i === selectedSuggestionIndex);
  });
  // Scroll selected into view
  const selected = container.querySelector('.search-suggestion.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function hideSuggestions() {
  document.getElementById('searchSuggestions').style.display = 'none';
}

function applySuggestion(text, type) {
  document.getElementById('searchInput').value = type === 'tag' ? 'tag:' + text : text;
  hideSuggestions();
  doSearch();
}

function hexToRgb(hex) {
  if (!hex || !hex.startsWith('#')) return '102,126,234'; // fallback accent
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return r + ',' + g + ',' + b;
}

// 点击其他区域关闭建议
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrapper')) hideSuggestions();
  // Close swipe actions when tapping outside a file-item
  if (!e.target.closest('.file-item')) {
    document.querySelectorAll('.swipe-actions.show').forEach(el => {
      el.classList.remove('show');
      el.closest('.file-item').style.transform = 'translateX(0)';
      el.closest('.file-item').style.transition = 'transform 0.2s ease';
    });
  }
});

function broadcastWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// 主题切换
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', next);
  localStorage.setItem('shareTool_theme', next);
  document.getElementById('themeToggle').textContent = next === 'light' ? '☀️' : '🌙';
  updateThemeColor(next);
  // 取消系统跟随监听（用户已手动选择）
  detachSystemThemeWatcher();
  updateThemeDropdownActive(next);
}

const ACCENT_PRESETS = [
  { color: '#667eea', name: '紫' },
  { color: '#3b82f6', name: '蓝' },
  { color: '#10b981', name: '绿' },
  { color: '#f59e0b', name: '橙' },
  { color: '#ef4444', name: '红' },
  { color: '#ec4899', name: '粉' },
  { color: '#8b5cf6', name: '靛' },
  { color: '#14b8a6', name: '青' },
];

function renderAccentColorPicker() {
  const container = document.getElementById('accentColorPicker');
  if (!container) return;
  const saved = localStorage.getItem('sharetool_accent') || '#667eea';
  container.innerHTML = ACCENT_PRESETS.map(p => {
    const active = p.color === saved ? '2px solid var(--text-primary)' : '1px solid var(--border-color)';
    return '<button onclick="applyAccentColor(\'' + p.color + '\');closeThemeDropdown();" ' +
      'style="width:28px;height:28px;border-radius:50%;border:' + active + ';background:' + p.color + ';cursor:pointer;" ' +
      'title="' + p.name + '"></button>';
  }).join('');
  const custom = document.getElementById('customAccentColor');
  if (custom) custom.value = saved;
}

function toggleThemeDropdown() {
  const dd = document.getElementById('themeDropdown');
  const isOpen = dd.style.display !== 'none';
  if (isOpen) { dd.style.display = 'none'; return; }
  dd.style.display = 'block';
  updateThemeDropdownActive();
  renderAccentColorPicker();
  // Close on outside click
  const close = (e) => { if (!dd.contains(e.target) && e.target.id !== 'themeToggle') { dd.style.display = 'none'; document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function closeThemeDropdown() {
  const dd = document.getElementById('themeDropdown');
  if (dd) dd.style.display = 'none';
}

function applyAccentColor(color) {
  document.documentElement.style.setProperty('--accent-primary', color);
  localStorage.setItem('sharetool_accent', color);
  // Derive secondary from primary (lighter shade)
  const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
  const secondary = '#' + [Math.min(r+30,255), Math.min(g+20,255), Math.min(b+40,255)].map(v => v.toString(16).padStart(2,'0')).join('');
  document.documentElement.style.setProperty('--accent-secondary', secondary);
  renderAccentColorPicker();
}

function setTheme(theme) {
  // 'system' = follow system; 'light'/'dark' = manual
  if (theme === 'system') {
    localStorage.removeItem('shareTool_theme');
    applySystemTheme();
    attachSystemThemeWatcher();
  } else {
    localStorage.setItem('shareTool_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('themeToggle').textContent = theme === 'light' ? '☀️' : '🌙';
    updateThemeColor(theme);
    detachSystemThemeWatcher();
  }
  // 更新下拉菜单激活状态
  updateThemeDropdownActive(theme);
}

function updateThemeDropdownActive(theme) {
  const current = theme || (localStorage.getItem('shareTool_theme') || 'system');
  ['light', 'dark', 'system'].forEach(t => {
    const btn = document.getElementById('themeBtn_' + t);
    if (btn) {
      btn.style.fontWeight = t === current ? '700' : '400';
      btn.style.background = t === current ? 'var(--accent-primary)' : 'var(--bg-tertiary)';
      btn.style.color = t === current ? '#fff' : 'var(--text-primary)';
    }
  });
}

function updateThemeColor(theme) {
  const themeColor = theme === 'light' ? '#667eea' : '#0f172a';
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => { m.content = themeColor; });
}

function applySystemTheme() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = prefersDark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeToggle').textContent = theme === 'light' ? '☀️' : '🌙';
  updateThemeColor(theme);
}

let _systemWatcher = null;
let _systemThemeHandler = null;
function attachSystemThemeWatcher() {
  if (_systemWatcher) return;
  _systemWatcher = window.matchMedia('(prefers-color-scheme: dark)');
  _systemThemeHandler = () => {
    if (!localStorage.getItem('shareTool_theme')) applySystemTheme();
  };
  _systemWatcher.addEventListener('change', _systemThemeHandler);
}
function detachSystemThemeWatcher() {
  if (_systemWatcher && _systemThemeHandler) {
    _systemWatcher.removeEventListener('change', _systemThemeHandler);
    _systemWatcher = null;
    _systemThemeHandler = null;
  }
}
}

function initTheme() {
  const saved = localStorage.getItem('shareTool_theme');
  if (saved) {
    // 手动设置
    document.documentElement.setAttribute('data-theme', saved);
    document.getElementById('themeToggle').textContent = saved === 'light' ? '☀️' : '🌙';
    updateThemeColor(saved);
  } else {
    // 跟随系统
    attachSystemThemeWatcher();
    applySystemTheme();
  }
}

// 初始化
async function init() {
  // 加载 Token 和 Refresh Token
  try {
    // 优先从 localStorage 恢复（包含 refresh token）
    const savedToken = localStorage.getItem('sharetool_token');
    const savedRefresh = localStorage.getItem('sharetool_refresh_token');
    if (savedRefresh) REFRESH_TOKEN = savedRefresh;
    if (savedToken) AUTH_TOKEN=***

    // 从服务端验证 token 是否有效，获取过期时间
    const res = await fetch(API + '/api/token/current', {
      headers: { 'x-auth-token': AUTH_TOKEN || '' }
    });
    const data = await res.json();
    if (data.token) AUTH_TOKEN=***

    // 检查是否即将过期（7天内），是则自动刷新
    if (data.expiresAt && REFRESH_TOKEN) {
      const now = Math.floor(Date.now() / 1000);
      const sevenDays = 7 * 24 * 3600;
      if (data.expiresAt - now < sevenDays) {
        await refreshToken();
      }
    }

    updateTokenDisplay(AUTH_TOKEN, data.expiresAt || null);
  } catch (e) {}

  initTheme();
  loadRateLimitStatus();
  loadDashboard();

  const localDownloadDir = localStorage.getItem('shareTool_downloadDir') || '';
  document.getElementById('downloadDir').value = localDownloadDir;

  // 恢复视图模式
  applyView(currentView);
  
  // 加载文件列表
  await loadFiles();
  
  // 连接 WebSocket
  connectWS();
  
  // Drag and drop
  const dropZone = document.getElementById('dropZone');
  const fileUploadArea = document.querySelector('.file-upload-area');
  const dragTargets = [dropZone, fileUploadArea].filter(Boolean);

  dragTargets.forEach(el => {
    ['dragenter','dragover'].forEach(evt => {
      el.addEventListener(evt, (e) => { e.preventDefault(); el.classList.add('drag-over'); });
    });
    ['dragleave','drop'].forEach(evt => {
      el.addEventListener(evt, (e) => { e.preventDefault(); el.classList.remove('drag-over'); });
    });
    el.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length > 0) { uploadFiles(files); }
    });
  });

  if (dropZone) {
    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        uploadFiles(files);
      }
    });
  }
  
  // Load storage info
  fetchStorageInfo();

  // Load recent searches (localStorage + server merge)
  await renderRecentSearches();
  loadSearchHistoryFromServer();

  // Load HTTPS status + token display
  if (document.getElementById('currentTokenDisplay')) {
    document.getElementById('currentTokenDisplay').textContent = AUTH_TOKEN || T('admin.none');
  }
  if (document.getElementById('httpsStatus')) {
    fetch(API + '/api/https/cert', { headers: { 'x-auth-token': AUTH_TOKEN || '' } })
      .then(r => r.json())
      .then(data => {
        const el = document.getElementById('httpsStatus');
        const btnEl = document.getElementById('httpsRenewBtn');
        if (el) {
          if (data.https) {
            const warnStyle = data.daysRemaining !== null && data.daysRemaining <= 30
              ? 'color:var(--warning)' : 'color:var(--text-muted)';
            el.innerHTML = '<span style="color:var(--success-fg)">✅ HTTPS 已启用</span> <span style="' + warnStyle + '">到期: ' + (data.expires || '未知') + (data.daysRemaining !== null ? ' (' + data.daysRemaining + '天)' : '') + '</span>';
            if (btnEl) btnEl.style.display = 'inline-block';
          } else {
            el.innerHTML = '<span style="color:var(--warning)">⚠️ ' + T('file.httpsDisabled') + '</span> <span style="color:var(--text-muted)">' + T('file.httpsLanSkip') + '</span>';
            if (btnEl) btnEl.style.display = 'none';
          }
        }
      }).catch(() => {
        const el = document.getElementById('httpsStatus');
        if (el) el.textContent = T('file.checkFailed');
      });
  }
}

async function fetchStorageInfo() {
  try {
    const res = await fetch(API + '/api/storage', { headers: { 'x-auth-token': AUTH_TOKEN || '' } });
    const data = await res.json();
    const used = data.totalSize || 0;
    const max = data.maxSize || 10 * 1024 * 1024 * 1024;
    const pct = Math.round(used / max * 100);
    const el = document.getElementById('storageText');
    if (el) el.textContent = T('file.storage') + ': ' + formatSize(used) + ' / 10GB (' + pct + '%)';
  } catch (e) {
    const el = document.getElementById('storageText');
    if (el) el.textContent = T('file.storage') + ': --';
  }
}

function getRecentSearches() {
  try {
    return JSON.parse(localStorage.getItem('sharetool_recent_searches') || '[]');
  } catch (e) { return []; }
}

function saveRecentSearch(q) {
  if (!q || q.trim().length < 2) return;
  let searches = getRecentSearches().filter(s => s !== q);
  searches.unshift(q);
  searches = searches.slice(0, 5);
  try { localStorage.setItem('sharetool_recent_searches', JSON.stringify(searches)); } catch (e) {}
  renderRecentSearches();
  // Sync to server API (fire-and-forget)
  fetch(API + '/api/search/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': AUTH_TOKEN || '' },
    body: JSON.stringify({ query: q })
  }).catch(() => {});
}

async function renderRecentSearches() {
  const container = document.getElementById('recentSearches');
  if (!container) return;
  const searches = getRecentSearches();
  const popular = await loadPopularSearches();
  const hasRecent = searches.length > 0;
  const hasPopular = popular.length > 0;

  if (!hasRecent && !hasPopular) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';
  let html = '';
  if (hasRecent) {
    html += searches.map(s =>
      '<span class="recent-search-tag" onclick="document.getElementById(\'searchInput\').value=\'' + escapeHtml(s).replace(/'/g, "\\'") + '\';doSearch()">' + escapeHtml(s) + '</span>'
    ).join('');
  }
  if (hasPopular) {
    html += '<span style="font-size:11px;color:var(--text-muted);padding:0 4px;align-self:center;">|</span>';
    html += '<span style="font-size:11px;color:var(--text-muted);padding:0 2px;align-self:center;">🔥 热门</span>';
    html += popular.map(s =>
      '<span class="recent-search-tag" style="background:rgba(255,100,0,0.1);border-color:rgba(255,100,0,0.3);" onclick="document.getElementById(\'searchInput\').value=\'' + escapeHtml(s).replace(/'/g, "\\'") + '\';doSearch()">' + escapeHtml(s) + '</span>'
    ).join('');
  }
  html += '<span class="recent-search-tag" style="color:var(--danger);margin-left:auto;" onclick="clearRecentSearches()">' + T('ui.clearFilter') + '</span>';
  container.innerHTML = html;
}

function clearRecentSearches() {
  try { localStorage.setItem('sharetool_recent_searches', '[]'); } catch (e) {}
  renderRecentSearches();
  // Sync clear to server API (fire-and-forget)
  fetch(API + '/api/search/history', {
    method: 'DELETE',
    headers: { 'x-auth-token': AUTH_TOKEN || '' }
  }).catch(() => {});
}

async function loadPopularSearches() {
  try {
    const res = await fetch(API + '/api/search/popular?limit=5', {
      headers: { 'x-auth-token': AUTH_TOKEN || '' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.popular || []).map(p => p.query);
  } catch (e) {
    return [];
  }
}

// Load search history from server and merge with localStorage
async function loadSearchHistoryFromServer() {
  try {
    const res = await fetch(API + '/api/search/history?limit=20', {
      headers: { 'x-auth-token': AUTH_TOKEN || '' }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.history && data.history.length > 0) {
      // Merge: server history takes priority, cap at 5
      const serverSearches = data.history.slice(0, 5);
      const local = getRecentSearches();
      // Merge, dedupe, keep server order
      const merged = [...serverSearches];
      local.forEach(s => { if (!merged.includes(s)) merged.push(s); });
      merged.splice(5);
      try { localStorage.setItem('sharetool_recent_searches', JSON.stringify(merged)); } catch (e) {}
      renderRecentSearches();
    }
  } catch (e) {}
}

function getFileIcon(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const icons = {
    // Documents
    pdf: '📕', doc: '📘', docx: '📘', rtf: '📘', odt: '📘',
    xls: '📗', xlsx: '📗', csv: '📊', ods: '📗',
    ppt: '📙', pptx: '📙', odp: '📙',
    txt: '📄', log: '📄', ini: '📄', cfg: '📄', conf: '📄',
    md: '📝', markdown: '📝', rst: '📝',
    // Config & Data
    json: '📋', jsonc: '📋', toml: '⚙️', yaml: '⚙️', yml: '⚙️',
    xml: '🌐', html: '🌐', htm: '🌐', xhtml: '🌐',
    css: '🎨', scss: '🎨', sass: '🎨', less: '🎨',
    // Code - Web & Script
    js: '💻', mjs: '💻', cjs: '💻', ts: '💻',
    jsx: '⚛️', tsx: '⚛️',
    vue: '💚', svelte: '🧡',
    py: '🐍', pyw: '🐍',
    rb: '💎', erb: '💎',
    php: '🐘',
    pl: '🐪', pm: '🐪',
    lua: '🌙',
    go: '🔵', rs: '🦀', zig: '⚡',
    java: '☕', class: '☕', jar: '☕', kotlin: '🟣',
    swift: '🍎', objectivec: 'Ⓜ️',
    cs: '🔷', fs: '🔷',
    c: '🔧', cpp: '🔧', cc: '🔧', cxx: '🔧', h: '🔧', hpp: '🔧',
    scala: '🔴', clj: '🍃', hs: '🟣', elm: '🟢', elixir: '💜', ex: '💜', exs: '💜',
    erl: '🔵', hrl: '🔵', lfe: '🔵',
    r: '📊', R: '📊',
    dart: '🎯', julia: '🔴', jl: '🔴',
    stata: '📊', sas: '📊',
    // Shell & DevOps
    sh: '🖥️', bash: '🖥️', zsh: '🖥️', fish: '🐟',
    ps1: '🟦', psm1: '🟦',
    bat: '🟩', cmd: '🟩',
    dockerfile: '🐳', dockerignore: '🐳',
    makefile: '🔨', mk: '🔨',
    terraform: '🏗️', tf: '🏗️', tfvars: '🏗️',
    // Images
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    bmp: '🖼️', tiff: '🖼️', tif: '🖼️', ico: '🖼️', heic: '🖼️', avif: '🖼️',
    // Audio
    mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵',
    m4a: '🎵', opus: '🎵', wma: '🎵', alac: '🎵',
    // Video
    mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', webm: '🎬',
    flv: '🎬', wmv: '🎬', m4v: '🎬', mpg: '🎬', mpeg: '🎬',
    // Archives
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    bz2: '📦', xz: '📦', zst: '📦', lz4: '📦',
    tgz: '📦', tbz2: '📦', txz: '📦',
    dmg: '📦', pkg: '📦', deb: '📦', rpm: '📦', apk: '📦',
    // Executables & System
    exe: '⚙️', msi: '⚙️', msc: '⚙️',
    dll: '⚙️', so: '⚙️', dylib: '⚙️', a: '⚙️', o: '⚙️',
    // Fonts
    ttf: '🔤', otf: '🔤', woff: '🔤', woff2: '🔤', eot: '🔤',
    // Database
    sql: '🗃️', db: '🗃️', sqlite: '🗃️', mdb: '🗃️', accdb: '🗃️',
    // Certificate & Key
    pem: '🔐', crt: '🔐', cer: '🔐', der: '🔐', p12: '🔐', pfx: '🔐', key: '🔐',
    env: '🔑', gitignore: '🔑', gitattributes: '🔑',
    // Book & Notes
    epub: '📚', mobi: '📚', azw: '📚', azw3: '📚',
    fb2: '📚', djvu: '📚', oxps: '📚', xps: '📚',
    // Design
    psd: '🎨', ai: '🎨', sketch: '🎨', fig: '🎨',
    xd: '🎨', indd: '🎨',
    // 3D
    obj: '📐', fbx: '📐', stl: '📐', gltf: '📐', glb: '📐', blend: '📐',
    // Binary & Disk
    bin: '💾', img: '💾', iso: '💾', vdi: '💾', vmdk: '💾',
    // Torrent
    torrent: '📡',
    // Shortcut
    lnk: '🔗', url: '🔗',
  };
  return icons[ext] || '📄';
}

init();
</script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@9/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>

<!-- PWA Install Prompt -->
<div id="pwaInstallPrompt" style="display:none;position:fixed;bottom:max(90px,calc(90px + env(safe-area-inset-bottom)));right:24px;left:24px;background:var(--bg-secondary,#1e293b);border:1px solid var(--border,#334155);border-radius:12px;padding:12px 16px;z-index:99;box-shadow:0 4px 12px rgba(0,0,0,0.3);">
  <div style="display:flex;align-items:center;gap:12px;">
    <span style="font-size:24px;">📲</span>
    <div style="flex:1;">
      <div style="font-size:14px;font-weight:600;color:var(--text-primary);">' + T('pwa.installTitle') + '</div>
      <div style="font-size:12px;color:var(--text-muted);">' + T('pwa.installDesc') + '</div>
    </div>
    <button onclick="installPWA()" style="background:var(--accent-primary);color:var(--text-inverse,#fff);border:none;border-radius:8px;padding:6px 16px;font-size:13px;cursor:pointer;white-space:nowrap;">' + T('pwa.install') + '</button>
    <button onclick="dismissPWAInstall()" style="background:transparent;color:var(--text-muted);border:none;font-size:18px;cursor:pointer;padding:4px;line-height:1;">✕</button>
  </div>
</div>

<!-- FAB: Mobile-friendly upload button -->
<div class="fab" id="fabMain" style="position:fixed;bottom:max(24px,env(safe-area-inset-bottom));right:24px;width:56px;height:56px;background:linear-gradient(135deg,var(--accent-primary),var(--accent-secondary));border-radius:50%;box-shadow:0 4px 16px rgba(102,126,234,0.4);cursor:pointer;z-index:100;display:none;" onclick="fabClicked()">
  <span style="font-size:24px;color:var(--text-inverse,#fff);">+</span>
</div>
<div class="fab-menu" id="fabMenu">
  <button class="btn" onclick="fabUpload()" title="上传文件">' + T('file.upload') + '</button>
  <button class="btn" onclick="fabText()" title="分享文字">' + T('file.textShare') + '</button>
</div>

<script>
// FAB for mobile - triggers file input on click
function fabClicked() {
  const menu = document.getElementById('fabMenu');
  const isHidden = menu.style.display === 'none' || !menu.classList.contains('show');
  if (isHidden) {
    menu.classList.add('show');
    document.getElementById('fabMain').style.transform = 'rotate(45deg)';
  } else {
    menu.classList.remove('show');
    document.getElementById('fabMain').style.transform = '';
  }
}
// Close FAB menu when tapping outside
document.addEventListener('click', (e) => {
  const menu = document.getElementById('fabMenu');
  const fab = document.getElementById('fabMain');
  if (menu && menu.classList.contains('show') && !menu.contains(e.target) && !fab.contains(e.target)) {
    menu.classList.remove('show');
    fab.style.transform = '';
  }
});
function fabUpload() {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (isMobile) {
    // iOS Safari doesn't support webkitdirectory well — use plain file input instead
    const fileInput = document.getElementById('fileInput');
    fileInput.removeAttribute('webkitdirectory');
    fileInput.removeAttribute('multiple');
    const handler = () => {
      fileInput.removeEventListener('change', handler);
      fileInput.setAttribute('webkitdirectory', '');
      fileInput.setAttribute('multiple', '');
    };
    fileInput.addEventListener('change', handler);
    fileInput.click();
  } else {
    document.getElementById('fileInput').click();
  }
  fabClicked(); // close menu
}
function fabText() {
  document.getElementById('textContent').focus();
  fabClicked(); // close menu
}
// Show FAB on mobile, hide on desktop
function updateFabVisibility() {
  const fab = document.getElementById('fabMain');
  if (window.innerWidth <= 500) {
    fab.style.display = 'flex';
  } else {
    fab.style.display = 'none';
  }
}
window.addEventListener('resize', updateFabVisibility);
window.addEventListener('DOMContentLoaded', updateFabVisibility);
</script>

<!-- File Info Side Panel -->
<div id="fileInfoPanel">
  <div class="file-info-header">
    <h3 id="fileInfoPanelTitle"></h3>
    <button class="file-info-close" onclick="closeFileInfoPanel()">×</button>
  </div>
  <div class="file-info-body" id="fileInfoBody">
    <div class="file-info-loading">加载中...</div>
  </div>
</div>

<!-- Mobile menu drawer -->
<div id="mobileMenuOverlay" class="modal-overlay" style="display:none;z-index:500;" onclick="if(event.target===this)toggleMobileMenu()">
  <div id="mobileMenuDrawer" style="position:fixed;bottom:0;left:0;right:0;background:var(--bg-secondary);border-radius:16px 16px 0 0;padding:24px 20px;padding-bottom:max(24px,env(safe-area-inset-bottom));max-height:70vh;overflow-y:auto;transform:translateY(100%);transition:transform 0.3s ease;z-index:501;" onclick="event.stopPropagation()">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <span style="font-size:16px;font-weight:600;">Menu</span>
      <button onclick="toggleMobileMenu()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-muted);padding:4px;">✕</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;">
      <button class="menu-item" onclick="showStorageInfo();toggleMobileMenu()">📊 ' + T('admin.storage') + '</button>
      <button class="menu-item" onclick="showAuditModal();toggleMobileMenu()">📋 ' + T('admin.auditLog') + '</button>
      <button class="menu-item" onclick="showTokenModal();toggleMobileMenu()">🔑 ' + T('admin.changeToken') + '</button>
      <button class="menu-item" onclick="showShareLinksModal();toggleMobileMenu()">🔗 ' + T('share.title') + '</button>
      <button class="menu-item" onclick="showDevicesModal();toggleMobileMenu()">📱 ' + T('ui.devices') + '</button>
      <button class="menu-item" onclick="showTagsModal();toggleMobileMenu()">🏷️ ' + T('file.tags') + '</button>
      <button class="menu-item" onclick="showBackupModal();toggleMobileMenu()">💾 ' + T('admin.backup') + '</button>
      <button class="menu-item" onclick="showAboutModal();toggleMobileMenu()">ℹ️ ' + T('about.about') + '</button>
    </div>
  </div>
</div>

  </body>
  <div class="file-context-menu" id="fileContextMenu"></div>
</html>`;


// ============================================================
// HTML Page Handler
// ============================================================
function sendHtml(res, html = HTML_PAGE, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ============================================================
// Server-side utilities (shared with route modules)
// ============================================================
const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','svg','bmp','ico']);
const AUDIO_EXTS = new Set(['mp3','wav','ogg','aac','flac','m4a','wma','opus']);
const VIDEO_EXTS = new Set(['mp4','webm','avi','mov','mkv','flv','wmv','m4v','mpeg','mpg']);
const PDF_EXTS = new Set(['pdf']);
const OFFICE_EXTS = new Set(['docx','xlsx','pptx','doc','xls','ppt']);
const CODE_EXTS = new Set(['js','jsx','ts','tsx','json','html','css','scss','py','rb','go','rs','java','c','cpp','h','hpp','cs','php','sh','bash','zsh','sql','xml','yaml','yml','toml','ini','cfg','conf','md','markdown','txt','log','swift','kt','scala','lua','r','pl','pm','lua']);

function isImageFile(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return IMAGE_EXTS.has(ext);
}
function isAudioFile(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return AUDIO_EXTS.has(ext);
}
function isVideoFile(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return VIDEO_EXTS.has(ext);
}
function isPdfFile(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return PDF_EXTS.has(ext);
}
function isOfficeFile(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return OFFICE_EXTS.has(ext);
}
function isCodeFile(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return CODE_EXTS.has(ext);
}


// ============================================================
// 启动
// ============================================================
// Graceful shutdown helper
function gracefulShutdown(code = 0) {
  logger.info('[ShareTool] Shutting down gracefully...');
  if (broadcastTimer) clearInterval(broadcastTimer);
  if (wsServer) wsServer.close();
  if (udpServer) udpServer.close();
  if (httpServer) httpServer.close();
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => gracefulShutdown(0));
process.on('SIGTERM', () => gracefulShutdown(0));

process.on('uncaughtException', (e) => {
  logger.fatal({ err: e }, 'Uncaught exception - shutting down');
  gracefulShutdown(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason: String(reason) }, 'Unhandled Promise rejection');
});

init();
