import AppKit

class StatusBarController: NSObject {

    private var statusItem: NSStatusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var menu: NSMenu = NSMenu()
    private var statusMenuItem: NSMenuItem!
    private var ipMenuItem: NSMenuItem!
    private var openWebMenuItem: NSMenuItem!
    private var openFolderMenuItem: NSMenuItem!
    private var startStopMenuItem: NSMenuItem!
    private var autoStartMenuItem: NSMenuItem!
    private var quitMenuItem: NSMenuItem!

    // Settings submenu
    private var settingsMenuItem: NSMenuItem!
    private var autoSendMenuItem: NSMenuItem!
    private var autoSyncTextMenuItem: NSMenuItem!
    private var autoSyncImageMenuItem: NSMenuItem!
    private var autoSyncFilesMenuItem: NSMenuItem!

    // Clipboard
    private var clipboardManager: ClipboardManager!
    private var clipboardHistoryMenuItem: NSMenuItem!
    private var clipboardHistory: [ClipboardEntry] = []
    private var lastSentID: String = ""

    private let onStart: () -> Void
    private let onStop: () -> Void
    private let onOpenWebUI: () -> Void
    private let onOpenFolder: () -> Void
    private let onQuit: () -> Void
    private let getStatus: () -> Bool
    private let getIP: () -> String
    private let baseURL: String
    private let instanceName: String

    init(
        baseURL: String,
        instanceName: String,
        onStart: @escaping () -> Void,
        onStop: @escaping () -> Void,
        onOpenWebUI: @escaping () -> Void,
        onOpenFolder: @escaping () -> Void,
        onQuit: @escaping () -> Void,
        getStatus: @escaping () -> Bool,
        getIP: @escaping () -> String
    ) {
        self.baseURL = baseURL
        self.instanceName = instanceName
        self.onStart = onStart
        self.onStop = onStop
        self.onOpenWebUI = onOpenWebUI
        self.onOpenFolder = onOpenFolder
        self.onQuit = onQuit
        self.getStatus = getStatus
        self.getIP = getIP

        super.init()

        setupClipboard()
        setupMenu()
        setupStatusItem()
        updateStatus()

        Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.updateStatus()
        }
    }

    // MARK: - Clipboard Setup

    private func setupClipboard() {
        clipboardManager = ClipboardManager(baseURL: baseURL, instanceName: instanceName)
        clipboardManager.delegate = self
        clipboardManager.startMonitoring()
        clipboardManager.loadHistory()

        // NOTE: Carbon RegisterEventHotKey is DISABLED to prevent race condition
        // with the Python helper's CGEvent tap. The helper handles Cmd+Shift+V exclusively.
        // hotkeyManager = HotkeyManager()
        // hotkeyManager.delegate = self
        // if !hotkeyManager.registerHotkey() { ... }
    }

    // MARK: - Menu Setup

    private func setupMenu() {
        // Status
        let sMI = NSMenuItem(title: "状态: 启动中...", action: nil, keyEquivalent: "")
        sMI.isEnabled = false
        self.statusMenuItem = sMI

        // IP
        let ipMI = NSMenuItem(title: "IP: 获取中...", action: nil, keyEquivalent: "")
        ipMI.isEnabled = false
        self.ipMenuItem = ipMI

        // Copy IP
        let cIPMI = NSMenuItem(title: "复制 IP", action: #selector(copyIP), keyEquivalent: "c")
        cIPMI.target = self

        // --- Settings submenu ---
        let settingsSubmenu = NSMenu()
        let smi = NSMenuItem(title: "同步设置", action: nil, keyEquivalent: "")
        smi.submenu = settingsSubmenu
        self.settingsMenuItem = smi

        // Auto-send toggle
        let asMI = NSMenuItem(title: "自动发送剪贴板", action: #selector(toggleAutoSend), keyEquivalent: "")
        asMI.state = .on
        asMI.target = self
        self.autoSendMenuItem = asMI

        let sepSettings0 = NSMenuItem.separator()

        // Auto-sync text toggle
        let astMI = NSMenuItem(title: "自动接收文本", action: #selector(toggleAutoSyncText), keyEquivalent: "")
        astMI.state = .on
        astMI.target = self
        self.autoSyncTextMenuItem = astMI

        // Auto-sync image toggle
        let asiMI = NSMenuItem(title: "自动接收图片", action: #selector(toggleAutoSyncImage), keyEquivalent: "")
        asiMI.state = .on
        asiMI.target = self
        self.autoSyncImageMenuItem = asiMI

        // Auto-sync files toggle
        let asfiMI = NSMenuItem(title: "自动接收文件", action: #selector(toggleAutoSyncFiles), keyEquivalent: "")
        asfiMI.state = .off
        asfiMI.target = self
        self.autoSyncFilesMenuItem = asfiMI

        settingsSubmenu.addItem(self.autoSendMenuItem)
        settingsSubmenu.addItem(sepSettings0)
        settingsSubmenu.addItem(self.autoSyncTextMenuItem)
        settingsSubmenu.addItem(self.autoSyncImageMenuItem)
        settingsSubmenu.addItem(self.autoSyncFilesMenuItem)

        // --- Clipboard History submenu ---
        let historySubmenu = NSMenu()
        let historyMI = NSMenuItem(title: "剪贴板历史", action: nil, keyEquivalent: "")
        historyMI.submenu = historySubmenu
        self.clipboardHistoryMenuItem = historyMI

        // --- Send Clipboard ---
        let sendClipMI = NSMenuItem(title: "发送剪贴板  ⌘⇧V", action: #selector(sendClipboard), keyEquivalent: "")
        sendClipMI.target = self

        // --- Open Web UI ---
        let owmMI = NSMenuItem(title: "打开 Web UI", action: #selector(openWeb), keyEquivalent: "o")
        owmMI.target = self
        self.openWebMenuItem = owmMI

        // --- Open shared folder ---
        let ofmMI = NSMenuItem(title: "打开共享文件夹", action: #selector(openFolder), keyEquivalent: "f")
        ofmMI.target = self
        self.openFolderMenuItem = ofmMI

        // --- Start/Stop ---
        let ssmMI = NSMenuItem(title: "停止服务", action: #selector(toggleService), keyEquivalent: "s")
        ssmMI.target = self
        self.startStopMenuItem = ssmMI

        // --- Auto start ---
        let asmMI = NSMenuItem(title: "开机自动启动", action: #selector(toggleAutoStart), keyEquivalent: "")
        asmMI.state = UserDefaults.standard.bool(forKey: "autoStart") ? .on : .off
        asmMI.target = self
        self.autoStartMenuItem = asmMI

        // --- Quit ---
        let qMI = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")
        qMI.target = self
        self.quitMenuItem = qMI

        // Assemble
        self.menu.addItem(self.statusMenuItem)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(self.ipMenuItem)
        self.menu.addItem(cIPMI)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(sendClipMI)
        self.menu.addItem(self.clipboardHistoryMenuItem)
        self.menu.addItem(self.settingsMenuItem)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(self.openWebMenuItem)
        self.menu.addItem(self.openFolderMenuItem)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(self.startStopMenuItem)
        self.menu.addItem(self.autoStartMenuItem)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(self.quitMenuItem)

        // Refresh history menu with empty state
        refreshHistoryMenu()
    }

    private func setupStatusItem() {
        self.statusItem.menu = self.menu

        if let button = self.statusItem.button {
            let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
                let bgPath = NSBezierPath(roundedRect: rect.insetBy(dx: 1, dy: 1), xRadius: 3, yRadius: 3)
                NSColor(red: 0.95, green: 0.45, blue: 0.0, alpha: 1.0).setFill()
                bgPath.fill()
                let para = NSMutableParagraphStyle()
                para.alignment = .center
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: NSFont.boldSystemFont(ofSize: 12),
                    .foregroundColor: NSColor.white,
                    .paragraphStyle: para
                ]
                let sRect = rect.offsetBy(dx: 0, dy: 1)
                "S".draw(in: sRect, withAttributes: attrs)
                return true
            }
            img.isTemplate = false
            button.image = img
            button.imagePosition = .imageLeft
        }
    }

    func updateStatus() {
        let running = getStatus()
        let ip = getIP()

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.statusMenuItem.title = running ? "状态: 运行中" : "状态: 已停止"
            self.startStopMenuItem.title = running ? "停止服务" : "启动服务"
            self.openWebMenuItem.isEnabled = running
            self.ipMenuItem.title = running ? "IP: \(ip)" : "IP: ---"
        }
    }

    // MARK: - Actions

    @objc private func toggleService() {
        if getStatus() { onStop() } else { onStart() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.updateStatus()
        }
    }

    @objc private func openWeb() { onOpenWebUI() }

    @objc private func openFolder() { onOpenFolder() }

    @objc private func copyIP() {
        let ip = getIP()
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString("http://\(ip):18793", forType: .string)
        let alert = NSAlert()
        alert.messageText = "已复制访问地址"
        alert.informativeText = "http://\(ip):18793"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "好的")
        alert.runModal()
    }

    @objc private func sendClipboard() {
        clipboardManager.sendClipboard()
    }

    @objc private func toggleAutoStart() {
        let newVal = !UserDefaults.standard.bool(forKey: "autoStart")
        UserDefaults.standard.set(newVal, forKey: "autoStart")
        autoStartMenuItem.state = newVal ? .on : .off
        let plistPath = (FileManager.default.homeDirectoryForCurrentUser.path as NSString).appendingPathComponent("Library/LaunchAgents/com.sharetool.app.plist")
        if newVal {
            let xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
                <key>Label</key><string>com.sharetool.app</string>
                <key>ProgramArguments</key>
                <array>
                    <string>/usr/bin/open</string>
                    <string>-a</string>
                    <string>ShareTool</string>
                </array>
                <key>RunAtLoad</key><true/>
            </dict>
            </plist>
            """
            try? xml.write(toFile: plistPath, atomically: true, encoding: .utf8)
        } else {
            try? FileManager.default.removeItem(atPath: plistPath)
        }
    }

    @objc private func toggleAutoSend() {
        let newVal = !clipboardManager.syncSettings.autoSend
        clipboardManager.syncSettings.autoSend = newVal
        autoSendMenuItem.state = newVal ? .on : .off
    }

    @objc private func toggleAutoSyncText() {
        let newVal = !clipboardManager.syncSettings.autoSyncText
        clipboardManager.syncSettings.autoSyncText = newVal
        autoSyncTextMenuItem.state = newVal ? .on : .off
    }

    @objc private func toggleAutoSyncImage() {
        let newVal = !clipboardManager.syncSettings.autoSyncImage
        clipboardManager.syncSettings.autoSyncImage = newVal
        autoSyncImageMenuItem.state = newVal ? .on : .off
    }

    @objc private func toggleAutoSyncFiles() {
        let newVal = !clipboardManager.syncSettings.autoSyncFiles
        clipboardManager.syncSettings.autoSyncFiles = newVal
        autoSyncFilesMenuItem.state = newVal ? .on : .off
    }

    @objc private func quit() { onQuit() }

    @objc private func useHistoryItem(_ sender: NSMenuItem) {
        let index = sender.tag
        guard index >= 0 && index < clipboardHistory.count else { return }
        let entry = clipboardHistory[index]
        clipboardManager.writeClipboard(entry: entry)
    }

    private func refreshHistoryMenu() {
        guard let submenu = clipboardHistoryMenuItem.submenu else { return }
        submenu.removeAllItems()

        if clipboardHistory.isEmpty {
            let empty = NSMenuItem(title: "（无历史）", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            submenu.addItem(empty)
            return
        }

        for (i, entry) in clipboardHistory.prefix(15).enumerated() {
            let preview: String
            switch entry.type {
            case "text":
                preview = truncate(entry.text ?? "", 40)
            case "image":
                let size = (entry.text ?? "").utf8.count
                preview = "📷 图片 (\(formatBytes(size)))"
            case "files":
                preview = "📁 文件"
            default:
                preview = truncate(entry.text ?? "", 40)
            }
            let title = "来自 \(entry.from): \(preview)"
            let item = NSMenuItem(title: title, action: #selector(useHistoryItem(_:)), keyEquivalent: "")
            item.target = self
            item.tag = i
            submenu.addItem(item)
        }

        submenu.addItem(NSMenuItem.separator())
        let clearItem = NSMenuItem(title: "清空历史", action: #selector(clearClipboardHistory), keyEquivalent: "")
        clearItem.target = self
        submenu.addItem(clearItem)
    }

    @objc private func clearClipboardHistory() {
        clipboardHistory.removeAll()
        refreshHistoryMenu()
        // Also clear server-side
        let url = URL(string: "\(baseURL)/api/clipboard")!
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        URLSession.shared.dataTask(with: req) { _, _, _ in }.resume()
    }

    private func truncate(_ s: String, _ max: Int) -> String {
        let clean = s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        if clean.count <= max { return clean }
        return String(clean.prefix(max)) + "…"
    }

    private func formatBytes(_ n: Int) -> String {
        if n < 1024 { return "\(n)B" }
        if n < 1024 * 1024 { return "\(n/1024)KB" }
        return "\(n/1024/1024)MB"
    }
}

// MARK: - ClipboardManagerDelegate

extension StatusBarController: ClipboardManagerDelegate {
    func clipboardManager(_ manager: ClipboardManager, didReceiveClipboard entry: ClipboardEntry) {
        // Add to local history (don't duplicate server's own history)
        clipboardHistory.insert(entry, at: 0)
        if clipboardHistory.count > 15 {
            clipboardHistory = Array(clipboardHistory.prefix(15))
        }
        refreshHistoryMenu()
    }

    func clipboardManager(_ manager: ClipboardManager, didSendClipboard count: Int) {
        // Note: count reflects peer-forwarding only (HTTP /api/clipboard/receive).
        // SSE push delivers to all connected clients even when count=0.
        let alert = NSAlert()
        alert.messageText = "剪贴板已发送"
        alert.informativeText = "服务器已接收"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "好的")
        alert.runModal()
    }

    func clipboardManager(_ manager: ClipboardManager, didFailWithError error: Error) {
        if (error as? ClipboardManager.ClipboardError) == .empty {
            let alert = NSAlert()
            alert.messageText = "剪贴板为空"
            alert.informativeText = "没有可发送的内容"
            alert.alertStyle = .warning
            alert.addButton(withTitle: "好的")
            alert.runModal()
        }
    }
}

// MARK: - HotkeyManagerDelegate

// extension StatusBarController: HotkeyManagerDelegate {
//     func hotkeyTriggered() {
//         sendClipboard()
//     }
// }
