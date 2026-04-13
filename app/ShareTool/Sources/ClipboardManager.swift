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

struct ClipboardEntry: Codable {
    let id: String
    let type: String // "text" | "image" | "files"
    let content: String
    let from: String
    let timestamp: Int64
}

struct ClipboardHistoryResponse: Codable {
    let entries: [ClipboardEntry]
}

struct ClipboardLatestResponse: Codable {
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

protocol ClipboardManagerDelegate: AnyObject {
    func clipboardManager(_ manager: ClipboardManager, didReceiveClipboard entry: ClipboardEntry)
    func clipboardManager(_ manager: ClipboardManager, didSendClipboard count: Int)
    func clipboardManager(_ manager: ClipboardManager, didFailWithError error: Error)
}

class ClipboardManager: NSObject, URLSessionDelegate {

    weak var delegate: ClipboardManagerDelegate?

    private var baseURL: String = ""
    private var instanceName: String = ""
    private var pollTimer: Timer?
    private var lastSeenID: String = ""
    private var isPolling = false

    // URLSession that skips TLS verification for self-signed certs
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    init(baseURL: String, instanceName: String) {
        self.baseURL = baseURL
        self.instanceName = instanceName
        super.init()
    }

    // Skip TLS verification for self-signed certs
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

    // MARK: - Read Clipboard

    /// Returns the type and content of the current clipboard
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
            pb.setString(entry.content, forType: .string)
            showNotification(title: "剪贴板已更新", body: "来自: \(entry.from)\n\(truncate(entry.content, 50))")

        case "image":
            if let imageData = Data(base64Encoded: entry.content) {
                pb.setData(imageData, forType: .png)
                showNotification(title: "图片已更新", body: "来自: \(entry.from)")
            }

        case "files":
            if let data = entry.content.data(using: .utf8),
               let filenames = try? JSONSerialization.jsonObject(with: data) as? [String] {
                let urls = filenames.compactMap { URL(fileURLWithPath: $0) as NSURL? }
                pb.writeObjects(urls)
                showNotification(title: "文件已更新", body: "来自: \(entry.from)\n\(filenames.joined(separator: ", "))")
            }

        default:
            break
        }
    }

    // MARK: - Send Clipboard to All Peers

    func sendClipboard() {
        debugLog("sendClipboard CALLED baseURL=\(baseURL) instanceName=\(instanceName)")
        guard let (type, content) = readClipboard() else {
            debugLog("Nothing to send - clipboard empty")
            print("[ClipboardManager] Nothing to send")
            delegate?.clipboardManager(self, didFailWithError: ClipboardError.empty)
            return
        }
        debugLog("Sending type=\(type) contentLen=\(content.count) from=\(instanceName)")

        let payload: [String: Any] = [
            "type": type,
            "content": content,
            "from": instanceName,
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000)
        ]

        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload) else { return }

        // Send to local server (which forwards to all peers)
        let url = URL(string: "\(baseURL)/api/clipboard")!
        debugLog("URL: \(url.absoluteString)")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = jsonData
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        session.dataTask(with: req) { [weak self] data, resp, err in
            guard let self = self else { return }
            if let err = err {
                debugLog("Send FAILED: \(err)")
                print("[ClipboardManager] Send failed: \(err)")
                DispatchQueue.main.async {
                    self.delegate?.clipboardManager(self, didFailWithError: err)
                }
                return
            }
            guard let data = data,
                  let response = try? JSONDecoder().decode(ClipboardSendResponse.self, from: data) else {
                debugLog("Send: could not decode response")
                return
            }
            debugLog("Send SUCCESS: id=\(response.id ?? "nil") forwarded=\(response.forwarded ?? -1)")
            DispatchQueue.main.async {
                self.delegate?.clipboardManager(self, didSendClipboard: response.forwarded ?? 0)
            }
        }.resume()
    }

    // MARK: - Polling (receive from peers)

    func startPolling(interval: TimeInterval = 3.0) {
        guard !isPolling else { return }
        isPolling = true

        pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.checkForUpdates()
        }
        // Immediate first check
        checkForUpdates()
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
        isPolling = false
    }

    private func checkForUpdates() {
        let url = URL(string: "\(baseURL)/api/clipboard/latest")!

        session.dataTask(with: url) { [weak self] data, _, err in
            guard let self = self, let data = data,
                  let response = try? JSONDecoder().decode(ClipboardLatestResponse.self, from: data),
                  let entry = response.entry else { return }

            // Skip if it's from ourselves or if we already have it
            if entry.from == self.instanceName { return }
            if entry.id == self.lastSeenID { return }

            self.lastSeenID = entry.id

            DispatchQueue.main.async {
                self.writeClipboard(entry: entry)
                self.delegate?.clipboardManager(self, didReceiveClipboard: entry)
            }
        }.resume()
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
    }
}
