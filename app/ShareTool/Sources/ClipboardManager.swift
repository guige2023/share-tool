import AppKit
import Foundation
import UserNotifications

func debugLog(_ msg: String) {
    let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/ShareTool")
    try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
    let logFile = logDir.appendingPathComponent("clipboard.log")
    let line = "\(Date()) \(msg)\n"
    try? line.appendToFile(at: logFile)
}

extension String {
    func appendToFile(at url: URL) throws {
        if FileManager.default.fileExists(atPath: url.path) {
            let handle = try FileHandle(forWritingTo: url)
            handle.seekToEndOfFile()
            handle.write(self.data(using: .utf8)!)
            handle.closeFile()
        } else {
            try self.data(using: .utf8)!.write(to: url)
        }
    }
}

// MARK: - V2 Protocol

struct ClipboardEntry: Codable {
    let entry_id: String?
    let device_id: String?
    let type: String // "text" | "image" | "files"
    let mime: String?
    let text: String?
    let files: [FileMeta]?
    let blob_url: String?
    let sha256: String?
    let from: String
    let timestamp: Int64
}

struct FileMeta: Codable {
    let name: String
    let size: Int64
    let sha256: String?
    let blob_url: String?
    let mime: String?
}

struct ClipboardHistoryResponse: Codable {
    let entries: [ClipboardEntry]?
    let entry: ClipboardEntry?
}

struct ClipboardSendResponse: Codable {
    let success: Bool
    let id: String?
    let forwarded: Int?
    let error: String?
}

struct PeersResponse: Codable {
    let peers: [Peer]
}

struct Peer: Codable {
    let name: String
    let ip: String
    let port: Int
    let updatedAt: Int64
}

// MARK: - Sync Settings

struct SyncSettings: Codable {
    var autoSend: Bool = true       // 自动发送剪贴板变化
    var autoSyncText: Bool = true   // 自动接收文本
    var autoSyncImage: Bool = true  // 自动接收图片
    var autoSyncFiles: Bool = false // 自动接收文件
}

// MARK: - Clipboard Manager Delegate

protocol ClipboardManagerDelegate: AnyObject {
    func clipboardManager(_ manager: ClipboardManager, didReceiveClipboard entry: ClipboardEntry)
    func clipboardManager(_ manager: ClipboardManager, didSendClipboard count: Int)
    func clipboardManager(_ manager: ClipboardManager, didFailWithError error: Error)
}

// MARK: - Clipboard Manager

class ClipboardManager: NSObject, URLSessionDelegate {

    weak var delegate: ClipboardManagerDelegate?

    private var baseURL: String = ""
    private var instanceName: String = ""
    private var isPolling = false

    // changeCount monitoring
    private var lastChangeCount: Int = 0
    private var monitorTimer: Timer?
    private var sseTask: URLSessionDataTask?

    // Loop prevention
    private var lastWrittenEntryID: String = ""
    private var lastWrittenAt: Date = .distantPast
    private let writeWindowSeconds: TimeInterval = 2.0

    // Sync settings
    var syncSettings = SyncSettings()

    // Local SSE event source
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 0
        config.timeoutIntervalForResource = 0
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    init(baseURL: String, instanceName: String) {
        self.baseURL = baseURL
        self.instanceName = instanceName
        super.init()
        self.lastChangeCount = NSPasteboard.general.changeCount
    }

    // MARK: - TLS: skip verification for self-signed certs

    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let serverTrust = challenge.protectionSpace.serverTrust {
            let credential = URLCredential(trust: serverTrust)
            completionHandler(.useCredential, credential)
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    // MARK: - Clipboard Change Monitoring (NSPasteboard.changeCount)

    /// Start monitoring clipboard via NSPasteboard.changeCount (efficient, event-driven)
    func startMonitoring() {
        guard !isPolling else { return }
        isPolling = true
        lastChangeCount = NSPasteboard.general.changeCount

        // Poll changeCount every 0.3s — much lighter than polling content
        monitorTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            self?.checkClipboardChange()
        }

        // Also connect SSE push for receiving from other devices
        connectSSEPush()
    }

    func stopMonitoring() {
        monitorTimer?.invalidate()
        monitorTimer = nil
        isPolling = false
        sseTask?.cancel()
        sseTask = nil
    }

    private func checkClipboardChange() {
        guard syncSettings.autoSend else { return }
        let current = NSPasteboard.general.changeCount
        if current != lastChangeCount {
            lastChangeCount = current
            // Clipboard changed — send it to server
            sendClipboard()
        }
    }

    // MARK: - SSE Push (receive from peers)

    private func connectSSEPush() {
        guard let url = URL(string: "\(baseURL)/api/push?device_id=\(instanceName)") else { return }

        var req = URLRequest(url: url)
        req.timeoutInterval = 0

        sseTask = session.dataTask(with: req) { [weak self] data, response, error in
            guard let self = self else { return }
            if let error = error {
                debugLog("SSE error: \(error)")
                // Retry connection after delay
                DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
                    self.connectSSEPush()
                }
                return
            }
            guard let data = data else { return }
            self.handleSSEData(data)
        }
        sseTask?.resume()
    }

    private func handleSSEData(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        let lines = text.components(separatedBy: "\n")
        for line in lines {
            guard line.hasPrefix("event: clipboard") else { continue }
            let dataLine = lines.first { $0.hasPrefix("data: ") }
            guard let jsonStr = dataLine else { continue }
            let json = String(jsonStr.dropFirst(6))
            guard let jsonData = json.data(using: .utf8),
                  let entry = try? JSONDecoder().decode(ClipboardEntry.self, from: jsonData) else {
                continue
            }
            DispatchQueue.main.async {
                self.handleIncomingEntry(entry)
            }
        }
    }

    private func handleIncomingEntry(_ entry: ClipboardEntry) {
        // Loop prevention
        if let entryID = entry.entry_id, entryID == lastWrittenEntryID {
            return
        }
        if entry.from == instanceName {
            return
        }
        // Type filter
        if entry.type == "text" && !syncSettings.autoSyncText { return }
        if entry.type == "image" && !syncSettings.autoSyncImage { return }
        if entry.type == "files" && !syncSettings.autoSyncFiles { return }

        writeClipboard(entry: entry)
        if let eid = entry.entry_id {
            lastWrittenEntryID = eid
        }
        lastWrittenAt = Date()
        delegate?.clipboardManager(self, didReceiveClipboard: entry)
    }

    // MARK: - Read Clipboard

    func readClipboard() -> (type: String, content: String)? {
        let pb = NSPasteboard.general

        // 1. Check for file URLs first
        if let fileURLs = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           !fileURLs.isEmpty {
            let filenames = fileURLs.map { $0.lastPathComponent }
            if let jsonData = try? JSONSerialization.data(withJSONObject: filenames),
               let jsonStr = String(data: jsonData, encoding: .utf8) {
                return ("files", jsonStr)
            }
        }

        // 2. Check for image
        if let imageData = pb.data(forType: .png) ?? pb.data(forType: .tiff) {
            let size = imageData.count
            if size > 10 * 1024 * 1024 {
                print("[ClipboardManager] Image too large: \(size) bytes, skipping")
                return nil
            }
            let base64 = imageData.base64EncodedString()
            return ("image", base64)
        }

        // 3. Check for text
        if let text = pb.string(forType: .string), !text.isEmpty {
            if text.utf8.count > 1 * 1024 * 1024 {
                print("[ClipboardManager] Text too large: \(text.utf8.count) bytes, skipping")
                return nil
            }
            return ("text", text)
        }

        return nil
    }

    // MARK: - Write to Clipboard

    func writeClipboard(entry: ClipboardEntry) {
        let pb = NSPasteboard.general
        pb.clearContents()

        switch entry.type {
        case "text":
            if let text = entry.text, !text.isEmpty {
                pb.setString(text, forType: .string)
                showNotification(title: "剪贴板已更新", body: "来自: \(entry.from)\n\(truncate(text, 50))")
            }

        case "image":
            // Try text (base64 embedded) first
            if let text = entry.text, !text.isEmpty,
               let imageData = Data(base64Encoded: text) {
                pb.setData(imageData, forType: .png)
                showNotification(title: "图片已更新", body: "来自: \(entry.from)")
            } else if let blobURL = entry.blob_url {
                // Fetch blob URL
                fetchBlob(from: blobURL) { [weak self] data in
                    guard let self = self, let data = data else { return }
                    DispatchQueue.main.async {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setData(data, forType: .png)
                        self.showNotification(title: "图片已更新", body: "来自: \(entry.from)")
                    }
                }
            }

        case "files":
            if let files = entry.files, !files.isEmpty {
                var urls: [URL] = []
                for file in files {
                    if let blobURL = file.blob_url {
                        // Download file
                        if let url = URL(string: "\(baseURL)\(blobURL)") {
                            urls.append(url)
                        }
                    }
                }
                if !urls.isEmpty {
                    pb.writeObjects(urls as [NSURL])
                }
                showNotification(title: "文件已更新", body: "来自: \(entry.from)\n\(files.map { $0.name }.joined(separator: ", "))")
            }

        default:
            break
        }
    }

    private func fetchBlob(from path: String, completion: @escaping (Data?) -> Void) {
        guard let url = URL(string: "\(baseURL)\(path)") else {
            completion(nil)
            return
        }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            completion(data)
        }.resume()
    }

    // MARK: - Send Clipboard to All Peers

    func sendClipboard() {
        guard let (clipType, content) = readClipboard() else {
            delegate?.clipboardManager(self, didFailWithError: ClipboardError.empty)
            return
        }

        debugLog("Sending type=\(clipType) contentLen=\(content.count) from=\(instanceName)")

        // For files, we need to upload each file to blob first
        if clipType == "files" {
            sendFilesClipboard(content: content)
            return
        }

        var payload: [String: Any] = [
            "type": clipType,
            "content": content,
            "from": instanceName,
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000)
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload) else { return }
        postClipboardPayload(jsonData)
    }

    private func sendFilesClipboard(content: String) {
        // Parse filenames from JSON array
        guard let data = content.data(using: .utf8),
              let filenames = try? JSONSerialization.jsonObject(with: data) as? [String] else {
            delegate?.clipboardManager(self, didFailWithError: ClipboardError.empty)
            return
        }

        let pb = NSPasteboard.general
        guard let fileURLs = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
              !fileURLs.isEmpty else {
            delegate?.clipboardManager(self, didFailWithError: ClipboardError.empty)
            return
        }

        var fileMetas: [[String: Any]] = []
        let group = DispatchGroup()
        var uploadError: Error?

        for (i, url) in fileURLs.enumerated() {
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            guard let fileData = try? Data(contentsOf: url) else { continue }

            group.enter()
            uploadBlob(data: fileData, filename: url.lastPathComponent, mime: mimeType(for: url.pathExtension)) { [weak self] result in
                defer { group.leave() }
                guard let self = self else { return }
                switch result {
                case .success(let meta):
                    var m = meta
                    m["name"] = url.lastPathComponent
                    fileMetas.append(m)
                case .failure(let err):
                    debugLog("Blob upload failed for \(url.lastPathComponent): \(err)")
                    uploadError = err
                }
            }
        }

        group.notify(queue: .main) { [weak self] in
            guard let self = self else { return }
            guard !fileMetas.isEmpty else {
                if let err = uploadError {
                    self.delegate?.clipboardManager(self, didFailWithError: err)
                }
                return
            }

            let payload: [String: Any] = [
                "type": "files",
                "content": "",
                "from": self.instanceName,
                "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
                "files": fileMetas
            ]

            guard let jsonData = try? JSONSerialization.data(withJSONObject: payload) else { return }
            self.postClipboardPayload(jsonData)
        }
    }

    private func uploadBlob(data: Data, filename: String, mime: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard let url = URL(string: "\(baseURL)/api/blobs?id=\(filename.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? filename)") else {
            completion(.failure(ClipboardError.invalidURL))
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = data
        req.setValue(mime, forHTTPHeaderField: "Content-Type")

        URLSession.shared.dataTask(with: req) { data, resp, err in
            if let err = err {
                completion(.failure(err))
                return
            }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = json["id"] as? String,
                  let sha256 = json["sha256"] as? String else {
                completion(.failure(ClipboardError.invalidResponse))
                return
            }
            completion(.success([
                "name": filename,
                "size": data.count,
                "sha256": sha256,
                "blob_url": "/api/blobs?id=\(id)",
                "mime": mime
            ]))
        }.resume()
    }

    private func postClipboardPayload(_ jsonData: Data) {
        let url = URL(string: "\(baseURL)/api/clipboard")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = jsonData
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        session.dataTask(with: req) { [weak self] data, resp, err in
            guard let self = self else { return }
            if let err = err {
                debugLog("Send FAILED: \(err)")
                DispatchQueue.main.async {
                    self.delegate?.clipboardManager(self, didFailWithError: err)
                }
                return
            }
            guard let data = data,
                  let response = try? JSONDecoder().decode(ClipboardSendResponse.self, from: data) else {
                return
            }
            debugLog("Send SUCCESS: id=\(response.id ?? "nil") forwarded=\(response.forwarded ?? -1)")
            DispatchQueue.main.async {
                self.delegate?.clipboardManager(self, didSendClipboard: response.forwarded ?? 0)
            }
        }.resume()
    }

    private func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "pdf": return "application/pdf"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "zip": return "application/zip"
        case "txt": return "text/plain"
        case "json": return "application/json"
        case "html", "htm": return "text/html"
        case "css": return "text/css"
        case "js": return "application/javascript"
        default: return "application/octet-stream"
        }
    }

    // MARK: - Helpers

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

    private func truncate(_ s: String, _ max: Int) -> String {
        if s.count <= max { return s }
        return String(s.prefix(max)) + "..."
    }

    enum ClipboardError: Error {
        case empty
        case invalidURL
        case invalidResponse
    }
}
