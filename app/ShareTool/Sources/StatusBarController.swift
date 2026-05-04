import AppKit
import UserNotifications

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

    // Clipboard
    private var clipboardManager: ClipboardManager!
    // private var hotkeyManager: HotkeyManager! // DISABLED - Python helper handles hotkey
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
        clipboardManager.startPolling(interval: 2.0)

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

        // Separator
        let sep0 = NSMenuItem.separator()

        // Open Web UI
        let owmMI = NSMenuItem(title: "打开 Web UI", action: #selector(openWeb), keyEquivalent: "o")
        owmMI.target = self
        self.openWebMenuItem = owmMI

        // Open shared folder
        let ofmMI = NSMenuItem(title: "打开共享文件夹", action: #selector(openFolder), keyEquivalent: "f")
        ofmMI.target = self
        self.openFolderMenuItem = ofmMI

        // Clipboard History submenu
        let historyMI = NSMenuItem(title: "剪贴板历史", action: nil, keyEquivalent: "")
        let historySubmenu = NSMenu()
        historyMI.submenu = historySubmenu
        self.clipboardHistoryMenuItem = historyMI

        // Send Clipboard
        let sendClipMI = NSMenuItem(title: "发送剪贴板  ⌘⇧V", action: #selector(sendClipboard), keyEquivalent: "")
        sendClipMI.target = self
        sendClipMI.tag = 100

        // Send Files
        let sendFilesMI = NSMenuItem(title: "发送文件...", action: #selector(sendFiles), keyEquivalent: "")
        sendFilesMI.target = self

        let sep2 = NSMenuItem.separator()

        // Start/Stop
        let ssmMI = NSMenuItem(title: "停止服务", action: #selector(toggleService), keyEquivalent: "s")
        ssmMI.target = self
        self.startStopMenuItem = ssmMI

        // Auto start
        let asmMI = NSMenuItem(title: "开机自动启动", action: #selector(toggleAutoStart), keyEquivalent: "")
        asmMI.state = UserDefaults.standard.bool(forKey: "autoStart") ? .on : .off
        asmMI.target = self
        self.autoStartMenuItem = asmMI

        let sep3 = NSMenuItem.separator()

        // Quit
        let qMI = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")
        qMI.target = self
        self.quitMenuItem = qMI

        // Assemble
        self.menu.addItem(self.statusMenuItem)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(self.ipMenuItem)
        self.menu.addItem(cIPMI)
        self.menu.addItem(sep0)
        self.menu.addItem(self.openWebMenuItem)
        self.menu.addItem(self.openFolderMenuItem)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(sendClipMI)
        self.menu.addItem(sendFilesMI)
        self.menu.addItem(self.clipboardHistoryMenuItem)
        self.menu.addItem(sep2)
        self.menu.addItem(self.startStopMenuItem)
        self.menu.addItem(self.autoStartMenuItem)
        self.menu.addItem(sep3)
        self.menu.addItem(self.quitMenuItem)
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
        pb.setString("https://\(ip):18793", forType: .string)
        let alert = NSAlert()
        alert.messageText = "已复制访问地址"
        alert.informativeText = "https://\(ip):18793"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "好的")
        alert.runModal()
    }

    @objc private func sendClipboard() {
        print("DEBUG: sendClipboard called")
        clipboardManager.sendClipboard()
    }

    @objc private func sendFiles() {
        // Dismiss menu tracking first
        NSApp.mainMenu?.cancelTracking()

        // Use a timer to delay - this helps with menu bar apps
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in
            self?.showOpenPanelViaShell()
        }
    }

    private func showOpenPanelViaShell() {
        // Use osascript via shell to show file picker
        let script = """
        set chosenFiles to (choose file with multiple selections allowed)
        set filePaths to {}
        repeat with f in chosenFiles
            set end of filePaths to POSIX path of f
        end repeat
        set astid to AppleScript's text item delimiters
        set AppleScript's text item delimiters to linefeed
        set filePaths to filePaths as string
        set AppleScript's text item delimiters to astid
        return filePaths
        """

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            process.waitUntilExit()

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let output = String(data: data, encoding: .utf8), !output.isEmpty {
                let paths = output.components(separatedBy: "\n").filter { !$0.isEmpty }
                let urls = paths.map { URL(fileURLWithPath: $0) }
                if !urls.isEmpty {
                    DispatchQueue.main.async {
                        self.sendSelectedFiles(urls)
                    }
                }
            }
        } catch {
            debugLog("Failed to run osascript: \(error.localizedDescription)")
        }
    }

    private func sendSelectedFiles(_ urls: [URL]) {
        for url in urls {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else { continue }

            if isDirectory.boolValue {
                // Zip directory first
                let zipName = url.lastPathComponent + ".zip"
                let tempURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("ShareTool").appendingPathComponent(zipName)
                try? FileManager.default.createDirectory(at: tempURL.deletingLastPathComponent() as URL, withIntermediateDirectories: true)

                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
                process.arguments = ["-c", "-k", "--sequesterRsrc", url.path, tempURL.path]
                try? process.run()
                process.waitUntilExit()

                if let zipData = try? Data(contentsOf: tempURL) {
                    let base64 = zipData.base64EncodedString()
                    try? FileManager.default.removeItem(at: tempURL)
                    sendFileAsPayload(base64: base64, fileName: zipName, fileSize: Int64(zipData.count))
                }
            } else {
                // Single file
                debugLog("Sending file: \(url.path), size: \(try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64 ?? 0)")
                do {
                    let fileData = try Data(contentsOf: url)
                    let base64 = fileData.base64EncodedString()
                    sendFileAsPayload(base64: base64, fileName: url.lastPathComponent, fileSize: Int64(fileData.count))
                } catch {
                    debugLog("Failed to read file: \(error.localizedDescription)")
                    DispatchQueue.main.async {
                        self.showNotification(title: "发送失败", body: "无法读取文件: \(url.lastPathComponent)")
                    }
                }
            }
        }
    }

    private func sendFileAsPayload(base64: String, fileName: String, fileSize: Int64) {
        let payload: [String: Any] = [
            "type": "file",
            "content": base64,
            "fileName": fileName,
            "fileSize": fileSize,
            "from": instanceName,
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000)
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload) else { return }

        let url = URL(string: "\(baseURL)/api/clipboard")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = jsonData
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        clipboardManager.session.dataTask(with: req) { [weak self] data, resp, err in
            guard let self = self else { return }
            if let err = err {
                debugLog("SendFile FAILED: \(err)")
                DispatchQueue.main.async {
                    self.showNotification(title: "发送失败", body: err.localizedDescription)
                }
                return
            }
            if let data = data, let response = try? JSONDecoder().decode(ClipboardSendResponse.self, from: data) {
                debugLog("SendFile SUCCESS: \(fileName) id=\(response.id ?? "nil")")
                DispatchQueue.main.async {
                    self.showNotification(title: "已发送文件", body: "\(fileName) (\(self.formatBytes(Int(fileSize))))")
                }
            }
        }.resume()
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
            // Fetch from server when empty
            fetchClipboardHistory()
            return
        }

        for (i, entry) in clipboardHistory.prefix(10).enumerated() {
            let preview: String
            switch entry.type {
            case "text":
                preview = truncate(entry.content, 40)
            case "image":
                preview = "📷 图片 (\(formatBytes(Int(entry.fileSize ?? 0)))"
            case "file":
                if let fn = entry.fileName, !fn.isEmpty {
                    preview = "📄 \(fn) (\(formatBytes(Int(entry.fileSize ?? 0))))"
                } else {
                    preview = "📄 文件 (\(formatBytes(Int(entry.fileSize ?? 0))))"
                }
            default:
                preview = truncate(entry.content, 40)
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

    private func fetchClipboardHistory() {
        let url = URL(string: "\(baseURL)/api/clipboard/history")!
        clipboardManager.session.dataTask(with: url) { [weak self] data, _, _ in
            guard let self = self, let data = data,
                  let response = try? JSONDecoder().decode(ClipboardHistoryResponse.self, from: data) else { return }
            DispatchQueue.main.async {
                // Merge server history with local, avoiding duplicates
                for entry in response.entries {
                    if !self.clipboardHistory.contains(where: { $0.id == entry.id }) {
                        self.clipboardHistory.append(entry)
                    }
                }
                // Sort by timestamp descending
                self.clipboardHistory.sort { $0.timestamp > $1.timestamp }
                if self.clipboardHistory.count > 50 {
                    self.clipboardHistory = Array(self.clipboardHistory.prefix(50))
                }
                self.refreshHistoryMenu()
            }
        }.resume()
    }

    @objc private func clearClipboardHistory() {
        clipboardHistory.removeAll()
        refreshHistoryMenu()
        // Also clear server-side
        let url = URL(string: "\(baseURL)/api/clipboard")!
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        clipboardManager.session.dataTask(with: req) { _, _, _ in }.resume()
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

    private func showNotification(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            let req = UNNotificationRequest(
                identifier: UUID().uuidString,
                content: content,
                trigger: nil
            )
            center.add(req)
        }
    }
}

// MARK: - ClipboardManagerDelegate

extension StatusBarController: ClipboardManagerDelegate {
    func clipboardManager(_ manager: ClipboardManager, didReceiveClipboard entry: ClipboardEntry) {
        // Add to local history (don't duplicate server's own history)
        clipboardHistory.insert(entry, at: 0)
        if clipboardHistory.count > 50 {
            clipboardHistory = Array(clipboardHistory.prefix(50))
        }
        refreshHistoryMenu()
    }

    func clipboardManager(_ manager: ClipboardManager, didSendClipboard count: Int) {
        // Use system notification instead of modal dialog
        if count > 0 {
            showNotification(title: "剪贴板已发送", body: "已发送到 \(count) 个设备")
        } else {
            showNotification(title: "剪贴板已发送", body: "当前无其他在线设备")
        }
    }

    func clipboardManager(_ manager: ClipboardManager, didFailWithError error: Error) {
        if (error as? ClipboardManager.ClipboardError) == .empty {
            showNotification(title: "剪贴板为空", body: "没有可发送的内容")
        }
    }
}

// MARK: - HotkeyManagerDelegate

extension StatusBarController: HotkeyManagerDelegate {
    func hotkeyTriggered() {
        sendClipboard()
    }
}
// Force recompile 2026年 5月 4日 星期一 14时26分46秒 CST
