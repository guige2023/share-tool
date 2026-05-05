import Foundation
import Network

struct DiscoveredServer: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let ip: String
    let port: Int
    var url: String { "https://\(ip):\(port)" }

    static func == (lhs: DiscoveredServer, rhs: DiscoveredServer) -> Bool {
        lhs.ip == rhs.ip && lhs.port == rhs.port
    }
}

protocol ServerDiscoveryDelegate: AnyObject {
    func serverDiscovery(_ discovery: ServerDiscovery, didFind server: DiscoveredServer)
    func serverDiscovery(_ discovery: ServerDiscovery, didLose server: DiscoveredServer)
    func serverDiscovery(_ discovery: ServerDiscovery, didUpdateProgress progress: Int)
}

class ServerDiscovery: NSObject {

    weak var delegate: ServerDiscoveryDelegate?

    private(set) var servers: [DiscoveredServer] = []
    private let lock = NSLock()

    private var browser: NWBrowser?
    private var pendingProbes: [String: DispatchWorkItem] = [:]
    private let probeQueue = DispatchQueue(label: "ShareTool.ServerDiscovery.probe", attributes: .concurrent)
    private let serverQueue = DispatchQueue(label: "ShareTool.ServerDiscovery.server", attributes: .concurrent)
    private var cts: CancellationSource?

    private let port: UInt16 = 18793
    private let scanTimeout: TimeInterval = 1.5

    typealias CancellationSource = DispatchWorkItem

    // MARK: - Public API

    func start() {
        stop()

        cts = DispatchWorkItem { [weak self] in self?.scanSubnet() }
        if let cts = cts {
            DispatchQueue.global().async(execute: cts)
        }

        // Also try mDNS/Bonjour discovery
        startBonjourDiscovery()
    }

    func stop() {
        cts?.cancel()
        cts = nil

        browser?.cancel()
        browser = nil

        pendingProbes.values.forEach { $0.cancel() }
        pendingProbes.removeAll()

        lock.lock()
        servers.removeAll()
        lock.unlock()
    }

    func rescan() {
        stop()
        servers.removeAll()
        start()
    }

    // MARK: - Subnet Scanning

    private func scanSubnet() {
        guard let localIP = getLocalIP() else { return }

        // Parse subnet from local IP (e.g., "192.168.1.100" -> "192.168.1.")
        let components = localIP.split(separator: ".")
        guard components.count == 4 else { return }
        let subnetPrefix = "\(components[0]).\(components[1]).\(components[2])."

        let group = DispatchGroup()
        let semaphore = DispatchSemaphore(value: 50) // max 50 concurrent probes

        for i in 1...254 {
            guard cts?.isCancelled == false else { break }

            let ip = "\(subnetPrefix)\(i)"
            if ip == localIP { continue } // skip self

            group.enter()
            semaphore.wait()

            probeQueue.async { [weak self] in
                defer {
                    group.leave()
                    semaphore.signal()
                }
                guard let self = self, self.cts?.isCancelled == false else { return }

                self.probeHost(ip: ip, port: self.port) { found in
                    if found {
                        // Server name will be set when we get the /api/info response
                    }
                }

                // Update progress
                let progress = Int(Double(i) / 254.0 * 100)
                DispatchQueue.main.async { [weak self] in
                    guard let self = self else { return }
                    self.delegate?.serverDiscovery(self, didUpdateProgress: progress)
                }
            }
        }

        group.wait()
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.delegate?.serverDiscovery(self, didUpdateProgress: 100)
        }
    }

    private func probeHost(ip: String, port: UInt16, completion: @escaping (Bool) -> Void) {
        let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(ip), port: NWEndpoint.Port(rawValue: port)!)

        let parameters = NWParameters.tcp
        parameters.prohibitExpensivePaths = false
        parameters.prohibitedInterfaceTypes = [.loopback]

        let connection = NWConnection(to: endpoint, using: parameters)

        var completed = false
        let completionLock = NSLock()

        let timer = DispatchSource.makeTimerSource(queue: probeQueue)
        timer.schedule(deadline: .now() + scanTimeout)
        timer.setEventHandler { [weak self] in
            self?.cancelConnection(connection, completed: &completed, lock: completionLock, completion: completion)
        }
        timer.resume()

        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                completionLock.lock()
                if !completed {
                    completed = true
                    completionLock.unlock()
                    timer.cancel()
                    // Send HTTP probe to /api/info to get server metadata
                    let request = "GET /api/info HTTP/1.1\r\nHost: \(ip):\(port)\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
                    connection.send(content: request.data(using: .utf8), completion: .contentProcessed { _ in
                        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, _, _ in
                            if let data = data, let response = String(data: data, encoding: .utf8) {
                                // Skip HTTP headers, find JSON body
                                if let jsonStart = response.firstIndex(of: "{"),
                                   let jsonData = String(response[jsonStart...]).data(using: .utf8),
                                   let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                                   let name = json["name"] as? String {
                                    DispatchQueue.main.async {
                                        self?.addServer(ip: ip, name: name)
                                        completion(true)
                                    }
                                } else {
                                    // Valid HTTP response but no /api/info — use IP as name
                                    DispatchQueue.main.async {
                                        self?.addServer(ip: ip, name: "ShareTool (\(ip))")
                                        completion(true)
                                    }
                                }
                            } else {
                                DispatchQueue.main.async {
                                    completion(false)
                                }
                            }
                            self?.cancelConnection(connection, completed: &completed, lock: completionLock, completion: completion)
                        }
                    })
                } else {
                    completionLock.unlock()
                }
            case .failed, .cancelled:
                self?.cancelConnection(connection, completed: &completed, lock: completionLock, completion: completion)
            default:
                break
            }
        }

        connection.start(queue: probeQueue)
    }

    private func cancelConnection(_ connection: NWConnection, completed: inout Bool, lock: NSLock, completion: @escaping (Bool) -> Void) {
        lock.lock()
        if !completed {
            completed = true
            lock.unlock()
            connection.cancel()
            DispatchQueue.main.async {
                completion(false)
            }
        } else {
            lock.unlock()
        }
    }

    // MARK: - Bonjour/mDNS Discovery

    private func startBonjourDiscovery() {
        // Look for _sharetool._tcp Bonjour service
        let browser = NWBrowser(for: .bonjour(type: "_sharetool._tcp", domain: nil), using: .tcp)
        self.browser = browser

        browser.stateUpdateHandler = { state in
            if case .failed(let err) = state {
                print("[ServerDiscovery] Bonjour browser failed: \(err)")
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, changes in
            guard let self = self else { return }
            for result in results {
                if case let .service(name, _, _, _) = result.endpoint {
                    self.resolveService(name: name, endpoint: result.endpoint)
                }
            }
        }

        browser.start(queue: serverQueue)
    }

    private func resolveService(name: String, endpoint: NWEndpoint) {
        let params = NWParameters.tcp
        let connection = NWConnection(to: endpoint, using: params)

        connection.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                if let path = connection.currentPath,
                   let localEndpoint = path.localEndpoint,
                   case let .hostPort(host, port) = localEndpoint {
                    let ip: String
                    switch host {
                    case .ipv4(let addr):
                        ip = "\(addr)"
                    case .ipv6(let addr):
                        ip = "\(addr)"
                    case .name(let hostname, _):
                        ip = hostname
                    @unknown default:
                        ip = "unknown"
                    }

                    // Try to get server info via HTTP to get the real instance name
                    self?.fetchServerInfo(ip: ip, port: Int(port.rawValue), fallbackName: name)
                }
                connection.cancel()
            }
        }

        connection.start(queue: serverQueue)

        // Timeout after 5 seconds
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
            connection.cancel()
        }
    }

    /// Fetch server info via HTTP /api/info to get the real instance name
    private func fetchServerInfo(ip: String, port: Int, fallbackName: String) {
        guard let url = URL(string: "https://\(ip):\(port)/api/info") else { return }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 2.0
        let session = URLSession(configuration: config, delegate: IgnoreCertDelegate(), delegateQueue: nil)

        let task = session.dataTask(with: url) { [weak self] data, response, error in
            if let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let serverName = json["name"] as? String {
                DispatchQueue.main.async {
                    self?.addServer(ip: ip, name: serverName)
                }
            } else {
                // Fall back to Bonjour service name
                DispatchQueue.main.async {
                    self?.addServer(ip: ip, name: fallbackName)
                }
            }
        }
        task.resume()
    }

    // MARK: - Server Management

    private func addServer(ip: String, name: String) {
        lock.lock()
        defer { lock.unlock() }

        let server = DiscoveredServer(name: name, ip: ip, port: Int(port))
        if !servers.contains(where: { $0.ip == ip }) {
            servers.append(server)
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.delegate?.serverDiscovery(self, didFind: server)
            }
        }
    }

    // MARK: - Helpers

    private func getLocalIP() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else {
            return nil
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
        return nil
    }
}

// MARK: - IgnoreCertDelegate (nested inside ServerDiscovery for TLS self-signed certs)

/// Helper class that ignores TLS certificate errors for self-signed certs
private class IgnoreCertDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let serverTrust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}
