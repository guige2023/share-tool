import AppKit
import UserNotifications

// MARK: - Delegate Protocol

protocol StatusBarControllerDelegate: AnyObject {
    /// Called when user wants to bind to a server (local or remote)
    func statusBarController(_ controller: StatusBarController, didBindToServer url: String, name: String)
    /// Called when user wants to disconnect from remote and use local server
    func statusBarControllerDidDisconnect(_ controller: StatusBarController)
    /// Called when user wants to open Web UI for a specific URL
    func statusBarController(_ controller: StatusBarController, didRequestOpenWebUI url: String)
    /// Called when user wants to rescan LAN
    func statusBarControllerDidRequestRescan(_ controller: StatusBarController)
    /// Called when user wants to send clipboard
    func statusBarControllerDidRequestSendClipboard(_ controller: StatusBarController)
}

// MARK: - StatusBarController

class StatusBarController: NSObject {

    private var statusItem: NSStatusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var menu: NSMenu = NSMenu()
    private var statusMenuItem: NSMenuItem!
    private var ipMenuItem: NSMenuItem!
    private var connectionMenuItem: NSMenuItem!
    private var openWebMenuItem: NSMenuItem!
    private var openFolderMenuItem: NSMenuItem!
    private var serversMenuItem: NSMenuItem!
    private var startStopMenuItem: NSMenuItem!
    private var autoStartMenuItem: NSMenuItem!
    private var disconnectMenuItem: NSMenuItem!
    private var quitMenuItem: NSMenuItem!

    // Clipboard
    private var clipboardManager: ClipboardManager!
    private var clipboardHistoryMenuItem: NSMenuItem!
    private var clipboardHistory: [ClipboardEntry] = []
    private var lastSentID: String = ""

    private let onStart: () -> Void
    private let onStop: () -> Void
    private let onOpenFolder: () -> Void
    private let onQuit: () -> Void
    private let getStatus: () -> Bool
    private let getIP: () -> String
    private let baseURL: String
    private let instanceName: String

    weak var delegate: StatusBarControllerDelegate?

    // Server discovery
    private var serverDiscovery: ServerDiscovery?
    private var discoveredServers: [DiscoveredServer] = []
    private var connectedURL: String = ""
    private var connectedName: String = ""

    init(
        baseURL: String,
        instanceName: String,
        onStart: @escaping () -> Void,
        onStop: @escaping () -> Void,
        onOpenFolder: @escaping () -> Void,
        onQuit: @escaping () -> Void,
        getStatus: @escaping () -> Bool,
        getIP: @escaping () -> String
    ) {
        self.baseURL = baseURL
        self.instanceName = instanceName
        self.onStart = onStart
        self.onStop = onStop
        self.onOpenFolder = onOpenFolder
        self.onQuit = onQuit
        self.getStatus = getStatus
        self.getIP = getIP
        self.connectedURL = baseURL
        self.connectedName = "本地服务"

        super.init()

        setupClipboard()
        setupMenu()
        setupStatusItem()
        updateStatus()

        Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.updateStatus()
        }
    }

    // MARK: - Server Discovery

    func setServerDiscovery(_ discovery: ServerDiscovery) {
        self.serverDiscovery = discovery
        discovery.delegate = self
        discovery.start()
    }

    // MARK: - Clipboard Setup

    private func setupClipboard() {
        clipboardManager = ClipboardManager(baseURL: connectedURL.isEmpty ? baseURL : connectedURL, instanceName: instanceName)
        clipboardManager.delegate = self
        clipboardManager.startPolling(interval: 2.0)
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

        // Connection status (local or remote)
        let connMI = NSMenuItem(title: "连接: 本地服务", action: nil, keyEquivalent: "")
        connMI.isEnabled = false
        self.connectionMenuItem = connMI

        // Separator 0
        let sep0 = NSMenuItem.separator()

        // Discovered Servers submenu
        let serversMI = NSMenuItem(title: "发现的服务器", action: nil, keyEquivalent: "")
        let serversSubmenu = NSMenu()
        serversMI.submenu = serversSubmenu
        self.serversMenuItem = serversMI
        refreshServersSubmenu()

        // Disconnect (shown when connected to remote)
        let disMI = NSMenuItem(title: "断开远程连接", action: #selector(disconnectFromRemoteServer), keyEquivalent: "")
        disMI.target = self
        self.disconnectMenuItem = disMI

        // Rescan LAN
        let rescanMI = NSMenuItem(title: "重新扫描局域网", action: #selector(rescanLAN), keyEquivalent: "")
        rescanMI.target = self

        // Manual connect
        let manualMI = NSMenuItem(title: "手动输入IP连接...", action: #selector(manualConnect), keyEquivalent: "")
        manualMI.target = self

        // Separator 1
        let sep1 = NSMenuItem.separator()

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
        let sendClipMI = NSMenuItem(title: " 发送剪贴板  ⌘⇧V", action: #selector(sendClipboard), keyEquivalent: "")
        sendClipMI.target = self
        sendClipMI.tag = 100

        // Send Files
        let sendFilesMI = NSMenuItem(title: " 发送文件...", action: #selector(sendFiles), keyEquivalent: "")
        sendFilesMI.target = self

        let sep3 = NSMenuItem.separator()

        // Start/Stop
        let ssmMI = NSMenuItem(title: "停止服务", action: #selector(toggleService), keyEquivalent: "s")
        ssmMI.target = self
        self.startStopMenuItem = ssmMI

        // Auto start
        let asmMI = NSMenuItem(title: "开机自动启动", action: #selector(toggleAutoStart), keyEquivalent: "")
        asmMI.state = UserDefaults.standard.bool(forKey: "autoStart") ? .on : .off
        asmMI.target = self
        self.autoStartMenuItem = asmMI

        let sep4 = NSMenuItem.separator()

        // Quit
        let qMI = NSMenuItem(title: " 退出", action: #selector(quit), keyEquivalent: "q")
        qMI.target = self
        self.quitMenuItem = qMI

        // Assemble
        self.menu.addItem(self.statusMenuItem)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(self.ipMenuItem)
        self.menu.addItem(cIPMI)
        self.menu.addItem(self.connectionMenuItem)
        self.menu.addItem(sep0)
        self.menu.addItem(self.serversMenuItem)
        self.menu.addItem(self.disconnectMenuItem)
        self.menu.addItem(rescanMI)
        self.menu.addItem(manualMI)
        self.menu.addItem(sep1)
        self.menu.addItem(self.openWebMenuItem)
        self.menu.addItem(self.openFolderMenuItem)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(sendClipMI)
        self.menu.addItem(sendFilesMI)
        self.menu.addItem(self.clipboardHistoryMenuItem)
        self.menu.addItem(sep3)
        self.menu.addItem(self.startStopMenuItem)
        self.menu.addItem(self.autoStartMenuItem)
        self.menu.addItem(sep4)
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
            // WebUI enabled if local server running OR connected to remote
            self.openWebMenuItem.isEnabled = running || !self.connectedURL.isEmpty
            self.ipMenuItem.title = running ? "IP: \(ip)" : "IP: ---"

            // Update connection status
            let isLocalServer = self.connectedURL == self.baseURL || self.connectedURL.isEmpty
            if isLocalServer {
                self.connectionMenuItem.title = "连接: 本地服务"
                self.disconnectMenuItem.isHidden = true
            } else {
                self.connectionMenuItem.title = "连接: 远程 「\(self.connectedName)」"
                self.disconnectMenuItem.isHidden = false
            }
        }
    }

    // MARK: - Actions

    @objc private func toggleService() {
        if getStatus() { onStop() } else { onStart() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.updateStatus()
        }
    }

    @objc private func openWeb() {
        let urlToOpen = (connectedURL == baseURL || connectedURL.isEmpty) ? baseURL : connectedURL
        delegate?.statusBarController(self, didRequestOpenWebUI: urlToOpen)
    }

    @objc private func rescanLAN() {
        serverDiscovery?.rescan()
        delegate?.statusBarControllerDidRequestRescan(self)
    }

    @objc private func manualConnect() {
        NSApp.mainMenu?.cancelTracking()

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.showManualConnectDialog()
        }
    }

    private func showManualConnectDialog() {
        let alert = NSAlert()
        alert.messageText = "手动连接服务器"
        alert.informativeText = "请输入服务器的 IP 地址："
        alert.alertStyle = .informational
        alert.addButton(withTitle: "连接")
        alert.addButton(withTitle: "取消")

        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 250, height: 24))
        input.placeholderString = "例如: 192.168.1.100"
        alert.accessoryView = input

        if alert.runModal() == .alertFirstButtonReturn {
            let ip = input.stringValue.trimmingCharacters(in: .whitespaces)
            if !ip.isEmpty {
                let url = "https://\(ip):18793"
                let name = "手动: \(ip)"
                bindToServer(url: url, name: name)
            }
        }
    }

    private func bindToServer(url: String, name: String) {
        connectedURL = url
        connectedName = name
        clipboardManager.setBaseURL(url)
        delegate?.statusBarController(self, didBindToServer: url, name: name)
        updateStatus()

        // Show TLS warning since we're using self-signed certificates
        let isLocal = url == baseURL || url.isEmpty
        if !isLocal {
            showNotification(
                title: "已连接（TLS 警告）",
                body: "已连接到 \(name)。注意：使用自签名证书，TLS 证书未经过验证。"
            )
        } else {
            showNotification(title: "已连接", body: "已连接到 \(name)")
        }
    }

    private func disconnectFromRemote() {
        connectedURL = baseURL
        connectedName = "本地服务"
        clipboardManager.setBaseURL(baseURL)
        delegate?.statusBarControllerDidDisconnect(self)
        updateStatus()
        showNotification(title: "已断开", body: "已切换到本地服务")
    }

    private func refreshServersSubmenu() {
        guard let submenu = serversMenuItem.submenu else { return }
        submenu.removeAllItems()

        // Add "切换到本地服务" at the top if connected to remote
        let isConnectedToRemote = connectedURL != baseURL && !connectedURL.isEmpty
        if isConnectedToRemote {
            let localItem = NSMenuItem(
                title: "切换到「本地服务」",
                action: #selector(disconnectFromRemoteServer),
                keyEquivalent: ""
            )
            localItem.target = self
            localItem.state = .off
            submenu.addItem(localItem)
            submenu.addItem(NSMenuItem.separator())
        }

        if discoveredServers.isEmpty {
            let empty = NSMenuItem(title: "（未发现服务器）", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            submenu.addItem(empty)
        } else {
            for server in discoveredServers {
                // If name already ends with (IP), don't duplicate — server.name may already contain IP
                // from Bonjour resolution where the service name includes the IP.
                let displayName: String
                if server.name.hasSuffix("(\(server.ip))") {
                    displayName = server.name
                } else {
                    displayName = "\(server.name) (\(server.ip))"
                }
                let item = NSMenuItem(
                    title: displayName,
                    action: #selector(selectServer(_:)),
                    keyEquivalent: ""
                )
                item.target = self
                item.representedObject = server
                // Mark currently connected server
                if server.url == connectedURL {
                    item.state = .on
                }
                submenu.addItem(item)
            }
        }
    }

    @objc private func selectServer(_ sender: NSMenuItem) {
        guard let server = sender.representedObject as? DiscoveredServer else { return }
        bindToServer(url: server.url, name: server.name)
        refreshServersSubmenu()
    }

    @objc private func disconnectFromRemoteServer() {
        disconnectFromRemote()
        refreshServersSubmenu()
    }

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
        NSApp.mainMenu?.cancelTracking()

        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in
            self?.showOpenPanelViaShell()
        }
    }

    private func showOpenPanelViaShell() {
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
                debugLog("Sending file: \(url.path), size: \(String(describing: (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? Int64 ?? 0))")
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
        let entry = ClipboardEntry(
            id: UUID().uuidString,
            type: "file",
            content: base64,
            fileName: fileName,
            fileSize: fileSize,
            from: instanceName,
            timestamp: Int64(Date().timeIntervalSince1970 * 1000)
        )
        clipboardManager.send(entry: entry) { [weak self] count in
            DispatchQueue.main.async {
                if count > 0 {
                    self?.showNotification(title: "文件已发送", body: "\(fileName) 已发送到 \(count) 个设备")
                } else {
                    self?.showNotification(title: "发送失败", body: "当前无其他在线设备")
                }
            }
        }
    }

    @objc private func toggleAutoStart() {
        let currentlyEnabled = isAutoStartEnabled()
        let newVal = !currentlyEnabled
        UserDefaults.standard.set(newVal, forKey: "autoStart")

        if newVal {
            enableAutoStart()
        } else {
            disableAutoStart()
        }

        autoStartMenuItem.state = newVal ? .on : .off
        showNotification(
            title: newVal ? "已开启" : "已关闭",
            body: newVal ? "ShareTool 将在开机时自动启动" : "已取消开机自动启动"
        )
    }

    private func isAutoStartEnabled() -> Bool {
        let plistPath = (FileManager.default.homeDirectoryForCurrentUser.path as NSString)
            .appendingPathComponent("Library/LaunchAgents/com.sharetool.app.plist")
        return FileManager.default.fileExists(atPath: plistPath)
    }

    private func enableAutoStart() {
        let launchAgentsDir = (FileManager.default.homeDirectoryForCurrentUser.path as NSString)
            .appendingPathComponent("Library/LaunchAgents")
        try? FileManager.default.createDirectory(atPath: launchAgentsDir, withIntermediateDirectories: true)

        let bundlePath = Bundle.main.bundlePath

        let plistPath = (launchAgentsDir as NSString).appendingPathComponent("com.sharetool.app.plist")
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key><string>com.sharetool.app</string>
            <key>ProgramArguments</key>
            <array>
                <string>/usr/bin/open</string>
                <string>-n</string>
                <string>-a</string>
                <string>\(bundlePath)</string>
            </array>
            <key>RunAtLoad</key><true/>
            <key>KeepAlive</key><false/>
        </dict>
        </plist>
        """
        try? xml.write(toFile: plistPath, atomically: true, encoding: .utf8)

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["bootstrap", "gui/\(currentUID())", plistPath]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
    }

    private func disableAutoStart() {
        let plistPath = (FileManager.default.homeDirectoryForCurrentUser.path as NSString)
            .appendingPathComponent("Library/LaunchAgents/com.sharetool.app.plist")

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["bootout", "gui/\(currentUID())/com.sharetool.app"]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()

        try? FileManager.default.removeItem(atPath: plistPath)
    }

    private func currentUID() -> uid_t {
        return getuid()
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
        } else {
            for (index, entry) in clipboardHistory.prefix(10).enumerated() {
                let preview = entry.type == "text"
                    ? String(entry.content.prefix(40)).replacingOccurrences(of: "\n", with: " ")
                    : "[\(entry.type)] \(entry.fileName ?? entry.type)"
                let item = NSMenuItem(title: "\(entry.from): \(preview)", action: #selector(useHistoryItem(_:)), keyEquivalent: "")
                item.target = self
                item.tag = index
                submenu.addItem(item)
            }
            submenu.addItem(NSMenuItem.separator())
            let clearItem = NSMenuItem(title: "清空历史", action: #selector(clearHistory), keyEquivalent: "")
            clearItem.target = self
            submenu.addItem(clearItem)
        }
    }

    @objc private func clearHistory() {
        clipboardHistory.removeAll()
        clipboardManager.clearHistory()
        refreshHistoryMenu()
        showNotification(title: "已清空", body: "剪贴板历史已清空")
    }

    private func showNotification(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            if granted {
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                content.sound = .default
                let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
                center.add(req)
            }
        }
    }
}

// MARK: - ServerDiscoveryDelegate

extension StatusBarController: ServerDiscoveryDelegate {
    func serverDiscovery(_ discovery: ServerDiscovery, didFind server: DiscoveredServer) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if !self.discoveredServers.contains(where: { $0.ip == server.ip }) {
                self.discoveredServers.append(server)
            }
            self.refreshServersSubmenu()
            // Avoid duplicate IP in notification if name already contains it
            let notificationBody: String
            if server.name.hasSuffix("(\(server.ip))") {
                notificationBody = server.name
            } else {
                notificationBody = "\(server.name) (\(server.ip))"
            }
            self.showNotification(title: "发现服务器", body: notificationBody)
        }
    }

    func serverDiscovery(_ discovery: ServerDiscovery, didLose server: DiscoveredServer) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.discoveredServers.removeAll { $0.ip == server.ip }
            self.refreshServersSubmenu()
        }
    }

    func serverDiscovery(_ discovery: ServerDiscovery, didUpdateProgress progress: Int) {
        // Progress updates can be shown in UI if needed
    }
}

// MARK: - ClipboardManagerDelegate

extension StatusBarController: ClipboardManagerDelegate {
    func clipboardManager(_ manager: ClipboardManager, didReceiveClipboard entry: ClipboardEntry) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if !self.clipboardHistory.contains(where: { $0.id == entry.id }) {
                self.clipboardHistory.insert(entry, at: 0)
                if self.clipboardHistory.count > 20 {
                    self.clipboardHistory = Array(self.clipboardHistory.prefix(20))
                }
            }
            self.refreshHistoryMenu()
        }
    }

    func clipboardManager(_ manager: ClipboardManager, didSendClipboard count: Int) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if count > 0 {
                self.showNotification(title: "剪贴板已发送", body: "已发送到 \(count) 个设备")
            } else {
                self.showNotification(title: "剪贴板已发送", body: "当前无其他在线设备")
            }
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
