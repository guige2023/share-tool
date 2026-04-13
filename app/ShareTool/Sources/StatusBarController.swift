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

        super.init()

        setupMenu()
        setupStatusItem()
        updateStatus()

        Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.updateStatus()
        }
    }

    private func setupMenu() {
        // Status (informational only)
        let sMI = NSMenuItem(title: "状态: 启动中...", action: nil, keyEquivalent: "")
        sMI.isEnabled = false
        self.statusMenuItem = sMI

        // IP (informational only)
        let ipMI = NSMenuItem(title: "IP: 获取中...", action: nil, keyEquivalent: "")
        ipMI.isEnabled = false
        self.ipMenuItem = ipMI

        // Copy IP - action set
        let cIPMI = NSMenuItem(title: "复制 IP", action: #selector(copyIP), keyEquivalent: "c")
        cIPMI.target = self

        // Open Web UI - action set
        let owmMI = NSMenuItem(title: "打开 Web UI", action: #selector(openWeb), keyEquivalent: "o")
        owmMI.target = self
        self.openWebMenuItem = owmMI

        // Open shared folder - action set
        let ofmMI = NSMenuItem(title: "打开共享文件夹", action: #selector(openFolder), keyEquivalent: "f")
        ofmMI.target = self
        self.openFolderMenuItem = ofmMI

        // Start/Stop service - action set
        let ssmMI = NSMenuItem(title: "停止服务", action: #selector(toggleService), keyEquivalent: "s")
        ssmMI.target = self
        self.startStopMenuItem = ssmMI

        // Auto start - action set
        let asmMI = NSMenuItem(title: "开机自动启动", action: #selector(toggleAutoStart), keyEquivalent: "")
        asmMI.state = UserDefaults.standard.bool(forKey: "autoStart") ? .on : .off
        asmMI.target = self
        self.autoStartMenuItem = asmMI

        // Quit - action set
        let qMI = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")
        qMI.target = self
        self.quitMenuItem = qMI

        // Assemble menu
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
