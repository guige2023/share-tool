import AppKit
import ServiceManagement
import UserNotifications

class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, StatusBarControllerDelegate {

    private var statusBarController: StatusBarController?
    private var shareToolPID: Int32 = -1
    private var sharedDir: String = ""
    private var instanceName: String = ""
    private var localBaseURL: String = ""
    private var serverDiscovery: ServerDiscovery?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
        sharedDir = (homeDir as NSString).appendingPathComponent("ShareToolShared")
        instanceName = Host.current().localizedName ?? "my-mac"

        // Request notification permissions
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if granted {
                print("[ShareTool] Notification permission granted")
            } else if let error = error {
                print("[ShareTool] Notification permission error: \(error)")
            }
        }

        let fileMgr = FileManager.default
        try? fileMgr.createDirectory(atPath: sharedDir, withIntermediateDirectories: true, attributes: nil)

        // Log startup
        let logDir = fileMgr.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/ShareTool")
        try? fileMgr.createDirectory(at: logDir, withIntermediateDirectories: true)
        let startupLog = logDir.appendingPathComponent("clipboard.log")
        let startupMsg = "\(Date()) AppDelegate startup: instanceName=\(instanceName) sharedDir=\(sharedDir)\n"
        if fileMgr.fileExists(atPath: startupLog.path) {
            let handle = try? FileHandle(forWritingTo: startupLog)
            handle?.seekToEndOfFile()
            handle?.write(startupMsg.data(using: .utf8)!)
            handle?.closeFile()
        } else {
            try? startupMsg.data(using: .utf8)?.write(to: startupLog)
        }

        startShareToolService()

        // Determine local IP for clipboard manager base URL
        let localIP = getLocalIP() ?? "127.0.0.1"
        localBaseURL = "https://\(localIP):18793"

        statusBarController = StatusBarController(
            baseURL: localBaseURL,
            instanceName: instanceName,
            onStart: { [weak self] in self?.startShareToolService() },
            onStop: { [weak self] in self?.stopShareToolService() },
            onOpenFolder: { [weak self] in self?.openSharedFolder() },
            onQuit: {
                // Stop the sharetool Go server first
                self.stopShareToolService()
                // Menu bar app (LSUIElement) cannot use NSApp.terminate —
                // it returns without exiting. Use exit(0) directly.
                exit(0)
            },
            getStatus: { [weak self] in self?.isServiceRunning() ?? false },
            getIP: { [weak self] in self?.getLocalIP() ?? "127.0.0.1" }
        )
        statusBarController?.delegate = self

        // Start server discovery
        let discovery = ServerDiscovery()
        statusBarController?.setServerDiscovery(discovery)
        self.serverDiscovery = discovery

        // Update status after a delay to allow discovery to start
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.statusBarController?.updateStatus()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopShareToolService()
    }

    // MARK: - Service Management

    private func log(_ msg: String) {
        NSLog("[ShareTool] %@", msg)
        if let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("ShareTool") {
            let logFile = dir.appendingPathComponent("debug.log")
            let line = "[\(Date())] \(msg)\n"
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            if let handle = try? FileHandle(forWritingTo: logFile) {
                handle.seekToEndOfFile()
                if let data = line.data(using: .utf8) {
                    handle.write(data)
                }
                handle.closeFile()
            } else {
                try? line.data(using: .utf8)?.write(to: logFile)
            }
        }
    }

    func startShareToolService() {
        stopShareToolService()

        let bundlePath = Bundle.main.bundlePath
        let contentsPath = (bundlePath as NSString).appendingPathComponent("Contents")
        let resourcesPath = (contentsPath as NSString).appendingPathComponent("Resources")
        let binPath = (resourcesPath as NSString).appendingPathComponent("ShareTool-bin")
        let bundleBinPath = (binPath as NSString).appendingPathComponent("sharetool")
        let fileMgr = FileManager.default

        log("[ShareTool] startShareToolService called")
        log("[ShareTool] Bundle: \(bundlePath)")
        log("[ShareTool] Contents: \(contentsPath)")
        log("[ShareTool] Bin: \(binPath)")
        log("[ShareTool] Target: \(bundleBinPath)")
        log("[ShareTool] Exists: \(fileMgr.fileExists(atPath: bundleBinPath))")

        if fileMgr.fileExists(atPath: bundleBinPath) {
            log("[ShareTool] Found sharetool at: \(bundleBinPath)")
            startShareToolProcess(binaryPath: bundleBinPath)
            return
        }

        // Fallback: try legacy path (if bundled directly in Resources)
        if let legacyPath = Bundle.main.path(forResource: "sharetool", ofType: nil) {
            log("[ShareTool] Found sharetool at (legacy): \(legacyPath)")
            startShareToolProcess(binaryPath: legacyPath)
            return
        }

        // Fallback: check Application Support
        let appSupportPath = (fileMgr.homeDirectoryForCurrentUser.path as NSString).appendingPathComponent("Library/Application Support/ShareTool/sharetool")
        if fileMgr.fileExists(atPath: appSupportPath) {
            log("[ShareTool] Found sharetool at (app support): \(appSupportPath)")
            startShareToolProcess(binaryPath: appSupportPath)
            return
        }

        log("[ShareTool] ERROR: Cannot find sharetool binary")
        log("[ShareTool] Contents of Contents dir:")
        if let contents = try? fileMgr.contentsOfDirectory(atPath: contentsPath) {
            for item in contents {
                log("  \(item)")
            }
        }
        log("[ShareTool] Contents of ShareTool-bin dir:")
        if let binContents = try? fileMgr.contentsOfDirectory(atPath: binPath) {
            for item in binContents {
                log("  \(item)")
            }
        }
        showAlert(title: "启动失败", message: "无法在应用包中找到 sharetool 二进制文件")
    }

    private func startShareToolProcess(binaryPath: String) {
        let fileMgr = FileManager.default
        let appSupportDir = (fileMgr.homeDirectoryForCurrentUser.path as NSString).appendingPathComponent("Library/Application Support/ShareTool")

        do {
            try fileMgr.createDirectory(atPath: appSupportDir, withIntermediateDirectories: true, attributes: nil)
        } catch {
            print("[ShareTool] Failed to create app support dir: \(error)")
        }

        let destPath = (appSupportDir as NSString).appendingPathComponent("sharetool")
        print("[ShareTool] Copying to: \(destPath)")

        // Remove existing
        try? fileMgr.removeItem(atPath: destPath)

        // Copy
        do {
            try fileMgr.copyItem(atPath: binaryPath, toPath: destPath)
            print("[ShareTool] Copied successfully")
        } catch {
            print("[ShareTool] Copy failed: \(error)")
            showAlert(title: "启动失败", message: "复制 sharetool 失败: \(error.localizedDescription)")
            return
        }

        // Set permissions
        do {
            try fileMgr.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destPath)
            print("[ShareTool] Permissions set")
        } catch {
            print("[ShareTool] Failed to set permissions: \(error)")
        }

        // Verify file exists
        guard fileMgr.fileExists(atPath: destPath) else {
            print("[ShareTool] ERROR: File does not exist after copy!")
            showAlert(title: "启动失败", message: "sharetool 文件复制后不存在")
            return
        }

        // Verify it's executable
        guard fileMgr.isExecutableFile(atPath: destPath) else {
            print("[ShareTool] ERROR: File is not executable!")
            showAlert(title: "启动失败", message: "sharetool 文件没有执行权限")
            return
        }

        // Start process
        let process = Process()
        process.executableURL = URL(fileURLWithPath: destPath)
        process.arguments = ["-name", instanceName, "-dir", sharedDir]
        process.currentDirectoryURL = URL(fileURLWithPath: sharedDir)
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            shareToolPID = process.processIdentifier
            print("[ShareTool] Started PID: \(shareToolPID)")

            // Verify it's actually running
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                if self?.shareToolPID ?? 0 > 0 {
                    let running = kill(self!.shareToolPID, 0) == 0
                    print("[ShareTool] Process running verification: \(running)")
                    if !running {
                        self?.showAlert(title: "启动失败", message: "sharetool 进程启动后立即退出")
                    }
                }
            }
        } catch {
            print("[ShareTool] Failed to start: \(error)")
            showAlert(title: "启动失败", message: "无法启动 sharetool: \(error.localizedDescription)")
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.statusBarController?.updateStatus()
        }
    }

    private func showAlert(title: String, message: String) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = message
            alert.alertStyle = .warning
            alert.addButton(withTitle: "确定")
            alert.runModal()
        }
    }

    func stopShareToolService() {
        // First try SIGTERM (graceful)
        if shareToolPID > 0 {
            let killed = kill(shareToolPID, SIGTERM)
            print("[ShareTool] Sent SIGTERM to PID \(shareToolPID), result: \(killed)")
            // Give it 0.5s to exit gracefully
            Thread.sleep(forTimeInterval: 0.5)
            if kill(shareToolPID, 0) == 0 {
                // Still running — use SIGKILL (force kill)
                print("[ShareTool] Process still running, sending SIGKILL")
                kill(shareToolPID, SIGKILL)
            }
            shareToolPID = -1
        }

        // Also use pkill as a safety net (kills any sharetool process)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        task.arguments = ["-9", "-f", "sharetool.*-name"]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()
        print("[ShareTool] Service stopped")
    }

    func isServiceRunning() -> Bool {
        if shareToolPID > 0 {
            return kill(shareToolPID, 0) == 0
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        task.arguments = ["-i", ":18793", "-sTCP:LISTEN", "-t"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()
        return pipe.fileHandleForReading.readDataToEndOfFile().count > 0
    }

    func getLocalIP() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else {
            return "127.0.0.1"
        }
        defer { freeifaddrs(ifaddr) }

        var ptr: UnsafeMutablePointer<ifaddrs>? = firstAddr
        while let interface = ptr {
            let addrFamily = interface.pointee.ifa_addr.pointee.sa_family
            if addrFamily == UInt8(AF_INET) {
                let name = String(cString: interface.pointee.ifa_name)
                if name == "en0" || name == "en1" {
                    var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    getnameinfo(interface.pointee.ifa_addr, socklen_t(interface.pointee.ifa_addr.pointee.sa_len),
                                &hostname, socklen_t(hostname.count),
                                nil, socklen_t(0), NI_NUMERICHOST)
                    return String(cString: hostname)
                }
            }
            ptr = interface.pointee.ifa_next
        }
        return "127.0.0.1"
    }

    func openSharedFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: sharedDir))
    }

    // MARK: - StatusBarControllerDelegate

    func statusBarController(_ controller: StatusBarController, didBindToServer url: String, name: String) {
        // When user binds to a server (remote or local), ensure the clipboard manager polls that URL
        // The StatusBarController already calls clipboardManager.setBaseURL(), so we just update localBaseURL if it's the local server
        if name == "本地服务" {
            localBaseURL = url
        }
        print("[ShareTool] Bound to server: \(name) at \(url)")
    }

    func statusBarControllerDidDisconnect(_ controller: StatusBarController) {
        // Revert to local server URL
        print("[ShareTool] Disconnected from remote, using local server")
    }

    func statusBarController(_ controller: StatusBarController, didRequestOpenWebUI url: String) {
        NSWorkspace.shared.open(URL(string: url)!)
    }

    func statusBarControllerDidRequestRescan(_ controller: StatusBarController) {
        print("[ShareTool] LAN rescan requested")
    }

    func statusBarControllerDidRequestSendClipboard(_ controller: StatusBarController) {
        // Handled by StatusBarController directly
    }
}
