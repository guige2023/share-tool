import AppKit

class StatusBarController {

    private var statusItem: NSStatusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var menu: NSMenu = NSMenu()
    private var statusMenuItem: NSMenuItem
    private var ipMenuItem: NSMenuItem
    private var openWebMenuItem: NSMenuItem
    private var openFolderMenuItem: NSMenuItem
    private var startStopMenuItem: NSMenuItem
    private var autoStartMenuItem: NSMenuItem
    private var quitMenuItem: NSMenuItem

    private let onStart: () -> Void
    private let onStop: () -> Void
    private let onOpenWebUI: () -> Void
    private let onOpenFolder: () -> Void
    private let onQuit: () -> Void
    private let getStatus: () -> Bool
    private let getIP: () -> String

    init(
        onStart: @escaping () -> Void,
        onStop: @escaping () -> Void,
        onOpenWebUI: @escaping () -> Void,
        onOpenFolder: @escaping () -> Void,
        onQuit: @escaping () -> Void,
        getStatus: @escaping () -> Bool,
        getIP: @escaping () -> String
    ) {
        self.onStart = onStart
        self.onStop = onStop
        self.onOpenWebUI = onOpenWebUI
        self.onOpenFolder = onOpenFolder
        self.onQuit = onQuit
        self.getStatus = getStatus
        self.getIP = getIP

        // Menu items - initialized before using self
        let sMI = NSMenuItem(title: "状态: 启动中...", action: nil, keyEquivalent: "")
        sMI.isEnabled = false
        self.statusMenuItem = sMI

        let ipMI = NSMenuItem(title: "IP: 获取中...", action: nil, keyEquivalent: "")
        ipMI.isEnabled = false
        self.ipMenuItem = ipMI

        let owmMI = NSMenuItem(title: "打开 Web UI", action: nil, keyEquivalent: "o")
        self.openWebMenuItem = owmMI

        let ofmMI = NSMenuItem(title: "打开共享文件夹", action: nil, keyEquivalent: "f")
        self.openFolderMenuItem = ofmMI

        let ssmMI = NSMenuItem(title: "停止服务", action: nil, keyEquivalent: "s")
        self.startStopMenuItem = ssmMI

        let asmMI = NSMenuItem(title: "开机自动启动", action: nil, keyEquivalent: "")
        asmMI.state = UserDefaults.standard.bool(forKey: "autoStart") ? .on : .off
        self.autoStartMenuItem = asmMI

        let qMI = NSMenuItem(title: "退出", action: nil, keyEquivalent: "q")
        self.quitMenuItem = qMI

        let cIPMI = NSMenuItem(title: "复制 IP", action: nil, keyEquivalent: "c")

        // Now self is available - build menu and assign targets
        self.menu.addItem(self.statusMenuItem)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(self.ipMenuItem)
        self.menu.addItem(cIPMI)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(self.openWebMenuItem)
        self.menu.addItem(self.openFolderMenuItem)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(self.startStopMenuItem)
        self.menu.addItem(self.autoStartMenuItem)
        self.menu.addItem(NSMenuItem.separator())
        self.menu.addItem(self.quitMenuItem)

        // Set targets
        self.openWebMenuItem.target = self
        self.openFolderMenuItem.target = self
        self.startStopMenuItem.target = self
        self.autoStartMenuItem.target = self
        self.quitMenuItem.target = self
        cIPMI.target = self

        // Assign menu to status item
        self.statusItem.menu = self.menu

        if let button = self.statusItem.button {
            if #available(macOS 11.0, *) {
                button.image = NSImage(systemSymbolName: "shared.with.you", accessibilityDescription: "ShareTool")
            } else {
                button.title = "ST"
            }
            button.imagePosition = .imageLeft
        }

        updateStatus()

        Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.updateStatus()
        }
    }

    func updateStatus() {
        let running = getStatus()
        let ip = getIP()

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if running {
                self.statusMenuItem.title = "状态: 运行中"
                self.startStopMenuItem.title = "停止服务"
                self.openWebMenuItem.isEnabled = true
                self.ipMenuItem.title = "IP: \(ip)"
                if let button = self.statusItem.button, #available(macOS 11.0, *) {
                    button.contentTintColor = NSColor.systemGreen
                }
            } else {
                self.statusMenuItem.title = "状态: 已停止"
                self.startStopMenuItem.title = "启动服务"
                self.openWebMenuItem.isEnabled = false
                self.ipMenuItem.title = "IP: ---"
                if let button = self.statusItem.button, #available(macOS 11.0, *) {
                    button.contentTintColor = NSColor.systemRed
                }
            }
        }
    }

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
}
