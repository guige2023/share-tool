import AppKit
import ServiceManagement

class AppDelegate: NSObject, NSApplicationDelegate {

    private var statusBarController: StatusBarController?
    private var shareToolPID: Int32 = -1
    private var sharedDir: String = ""
    private var instanceName: String = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
        sharedDir = (homeDir as NSString).appendingPathComponent("ShareToolShared")
        instanceName = Host.current().localizedName ?? "my-mac"

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
        let baseURL = "http://\(localIP):18793"

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

        let fileMgr = FileManager.default
        let logDir2 = (fileMgr.homeDirectoryForCurrentUser.path as NSString).appendingPathComponent("Library/Logs/ShareTool")
        try? fileMgr.createDirectory(atPath: logDir2, withIntermediateDirectories: true, attributes: nil)
        let diagPath = (logDir2 as NSString).appendingPathComponent("server_diagnose.log")

        guard let bundlePath = Bundle.main.path(forResource: "sharetool", ofType: nil, inDirectory: "ShareTool-bin") else {
            let msg = "[ShareTool] ERROR: Cannot find sharetool binary in app bundle\nBundle.main.bundlePath=\(Bundle.main.bundlePath)\n"
            try? msg.write(toFile: diagPath, atomically: true, encoding: String.Encoding.utf8)
            return
        }

        let appSupportDir = (fileMgr.homeDirectoryForCurrentUser.path as NSString).appendingPathComponent("Library/Application Support/ShareTool")
        try? fileMgr.createDirectory(atPath: appSupportDir, withIntermediateDirectories: true, attributes: nil)

        let destPath = (appSupportDir as NSString).appendingPathComponent("sharetool")
        try? fileMgr.removeItem(atPath: destPath)
        do {
            try fileMgr.copyItem(atPath: bundlePath, toPath: destPath)
        } catch {
            let msg = "[ShareTool] ERROR: copy failed: \(error)\n"
            try? msg.write(toFile: diagPath, atomically: true, encoding: String.Encoding.utf8)
            return
        }
        try? fileMgr.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destPath)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: destPath)
        process.arguments = ["-name", instanceName, "-dir", sharedDir]
        process.currentDirectoryURL = URL(fileURLWithPath: sharedDir)
        let logPath = (logDir2 as NSString).appendingPathComponent("server_startup.log")
        let logFile = FileHandle(forWritingAtPath: logPath) ?? FileHandle.nullDevice
        process.standardOutput = logFile
        process.standardError = logFile

        do {
            try process.run()
            shareToolPID = process.processIdentifier
            let msg = "[ShareTool] Started PID: \(shareToolPID)\ndestPath: \(destPath)\n"
            try? msg.write(toFile: diagPath, atomically: true, encoding: String.Encoding.utf8)
        } catch {
            let msg = "[ShareTool] Failed to start: \(error)\ndestPath: \(destPath)\n"
            try? msg.write(toFile: diagPath, atomically: true, encoding: String.Encoding.utf8)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.statusBarController?.updateStatus()
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
        NSWorkspace.shared.open(URL(string: "http://localhost:18793")!)
    }

    func openSharedFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: sharedDir))
    }
}
