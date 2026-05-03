import AppKit
import ServiceManagement
import UserNotifications

class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {

    private var statusBarController: StatusBarController?
    private var shareToolPID: Int32 = -1
    private var sharedDir: String = ""
    private var instanceName: String = ""

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
        let baseURL = "https://\(localIP):18793"

        statusBarController = StatusBarController(
            baseURL: baseURL,
            instanceName: instanceName,
            onStart: { [weak self] in self?.startShareToolService() },
            onStop: { [weak self] in self?.stopShareToolService() },
            onOpenWebUI: { [weak self] in self?.openWebUI() },
            onOpenFolder: { [weak self] in self?.openSharedFolder() },
            onQuit: { NSApp.terminate(nil) },
            getStatus: { [weak self] in self?.isServiceRunning() ?? false },
            getIP: { [weak self] in self?.getLocalIP() ?? "127.0.0.1" }
        )
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopShareToolService()
    }

    // MARK: - Service Management

    func startShareToolService() {
        stopShareToolService()

        // Debug: print bundle info
        print("[ShareTool] Bundle: \(Bundle.main.bundlePath)")
        print("[ShareTool] Shared directory: \(sharedDir)")

        // Build sharetool path directly from bundle path
        let bundleBinPath = (Bundle.main.bundlePath as NSString).appendingPathComponent("Contents/ShareTool-bin/sharetool")
        let fileMgr = FileManager.default

        if fileMgr.fileExists(atPath: bundleBinPath) {
            print("[ShareTool] Found sharetool at: \(bundleBinPath)")
            startShareToolProcess(binaryPath: bundleBinPath)
            return
        }

        // Fallback: try legacy path (if bundled directly in Resources)
        if let legacyPath = Bundle.main.path(forResource: "sharetool", ofType: nil) {
            print("[ShareTool] Found sharetool at (legacy): \(legacyPath)")
            startShareToolProcess(binaryPath: legacyPath)
            return
        }

        // Fallback: check Application Support
        let appSupportPath = (fileMgr.homeDirectoryForCurrentUser.path as NSString).appendingPathComponent("Library/Application Support/ShareTool/sharetool")
        if fileMgr.fileExists(atPath: appSupportPath) {
            print("[ShareTool] Found sharetool at (app support): \(appSupportPath)")
            startShareToolProcess(binaryPath: appSupportPath)
            return
        }

        print("[ShareTool] ERROR: Cannot find sharetool binary")
        print("[ShareTool] Contents of Contents dir:")
        let contentsPath = (Bundle.main.bundlePath as NSString).appendingPathComponent("Contents")
        if let contents = try? fileMgr.contentsOfDirectory(atPath: contentsPath) {
            for item in contents {
                print("  \(item)")
            }
        }
        print("[ShareTool] Contents of ShareTool-bin dir:")
        let binPath = (Bundle.main.bundlePath as NSString).appendingPathComponent("Contents/ShareTool-bin")
        if let binContents = try? fileMgr.contentsOfDirectory(atPath: binPath) {
            for item in binContents {
                print("  \(item)")
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
        if shareToolPID > 0 {
            kill(shareToolPID, SIGTERM)
            print("[ShareTool] Sent SIGTERM to PID \(shareToolPID)")
            shareToolPID = -1
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        task.arguments = ["-f", "sharetool.*-name"]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()
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

    func openWebUI() {
        guard let ip = getLocalIP() else { return }
        NSWorkspace.shared.open(URL(string: "https://\(ip):18793")!)
    }

    func openSharedFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: sharedDir))
    }
}
