package server

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ScanState tracks the current scan status
type ScanState struct {
	Scanning   bool      `json:"scanning"`
	Progress   int       `json:"progress"` // 0-100
	Found      int       `json:"found"`
	StartTime  time.Time `json:"startTime,omitempty"`
	Subnet     string    `json:"subnet,omitempty"`
}

var (
	scanState    = ScanState{}
	scanStateMu  sync.RWMutex
)

var tlsConfigInsecure = &tls.Config{InsecureSkipVerify: true}

var scanPort = 18793 // default ShareTool port (can be updated via SetScanPort)

// SetScanPort updates the port used for LAN scanning
func SetScanPort(port int) {
	scanPort = port
}

// handleScanTrigger starts a LAN scan and returns immediately
func handleScanTrigger(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	scanStateMu.Lock()
	if scanState.Scanning {
		scanStateMu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"scanning": true, "message": "扫描进行中"})
		return
	}
	scanState.Scanning = true
	scanState.Progress = 0
	scanState.Found = 0
	scanState.StartTime = time.Now()
	subnet, _ := getLocalSubnet()
	scanState.Subnet = subnet
	scanStateMu.Unlock()

	// Trigger scan in background
		go func() {
		runLANScan(subnet, func(found int) {
			scanStateMu.Lock()
			scanState.Found = found
			if time.Since(scanState.StartTime) > 4*time.Second {
				scanState.Progress = 100
			} else {
				scanState.Progress = 80
			}
			scanStateMu.Unlock()
		})
		// Mark scan complete
		scanStateMu.Lock()
		scanState.Scanning = false
		scanState.Progress = 100
		scanStateMu.Unlock()
	}()

	json.NewEncoder(w).Encode(map[string]any{"scanning": true, "message": "扫描已启动"})
}

// handleScanStatus returns the current scan status
func handleScanStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	scanStateMu.RLock()
	state := scanState
	scanStateMu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"scanning": state.Scanning,
		"progress": state.Progress,
		"found":    state.Found,
		"subnet":   state.Subnet,
	})
}

// getLocalSubnet returns the local subnet (e.g. "192.168.1.0/24")
func getLocalSubnet() (string, error) {
	iface, err := defaultInterface()
	if err != nil {
		return "", err
	}
	addrs, _ := iface.Addrs()
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok {
			if ip4 := ipnet.IP.To4(); ip4 != nil && !ip4.IsLoopback() {
				baseIP := net.IP{ip4[0], ip4[1], ip4[2], 0}.String()
				return baseIP + "/24", nil
			}
		}
	}
	return "", fmt.Errorf("no suitable interface")
}

// defaultInterface returns the default network interface
func defaultInterface() (*net.Interface, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok {
				if ip4 := ipnet.IP.To4(); ip4 != nil {
					return &iface, nil
				}
			}
		}
	}
	return nil, fmt.Errorf("no suitable interface")
}

// runLANScan performs a TCP scan of the given subnet
func runLANScan(subnet string, onFound func(int)) {
	_, ipnet, err := net.ParseCIDR(subnet)
	if err != nil {
		log.Printf("[Scan] Invalid subnet: %v", err)
		scanStateMu.Lock()
		scanState.Scanning = false
		scanState.Progress = 100
		scanStateMu.Unlock()
		return
	}

	ip := ipnet.IP.To4()
	if ip == nil {
		log.Printf("[Scan] Only IPv4 subnets supported")
		scanStateMu.Lock()
		scanState.Scanning = false
		scanState.Progress = 100
		scanStateMu.Unlock()
		return
	}

	baseIP := [4]byte{ip[0], ip[1], ip[2], 0}
	localIP := getLocalIP()

	type scanResult struct {
		ip   string
		port int
	}
	resultCh := make(chan scanResult, 254)

	sem := make(chan struct{}, 50)
	var wg sync.WaitGroup
	foundCount := 0
	var foundMu sync.Mutex

	for i := 1; i < 255; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			targetIP := fmt.Sprintf("%d.%d.%d.%d", baseIP[0], baseIP[1], baseIP[2], n)
			if targetIP == localIP {
				return
			}

			if ok := probeHost(targetIP, scanPort); ok {
				resultCh <- scanResult{ip: targetIP, port: scanPort}
				foundMu.Lock()
				foundCount++
				f := foundCount
				foundMu.Unlock()
				onFound(f)
			}
		}(i)
	}

	go func() {
		wg.Wait()
		close(resultCh)
	}()

	for result := range resultCh {
		// Probe for device info (name, port, protocol)
		name, port, _ := probeHostInfo(result.ip, result.port)
		log.Printf("[Scan] Found ShareTool at %s:%d -> name=%s", result.ip, result.port, name)
		SetPeer(result.ip, port, name)
	}

	scanStateMu.Lock()
	scanState.Scanning = false
	scanState.Progress = 100
	scanStateMu.Unlock()
}

// getLocalIP returns the local IP address
func getLocalIP() string {
	iface, err := defaultInterface()
	if err != nil {
		return "unknown"
	}
	addrs, _ := iface.Addrs()
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok {
			if ip4 := ipnet.IP.To4(); ip4 != nil && !ip4.IsLoopback() {
				return ip4.String()
			}
		}
	}
	return "unknown"
}

// probeHost checks if a ShareTool instance is running at the given IP:port
func probeHost(ip string, port int) bool {
	// Try HTTPS first (most common), then HTTP
	// Use InsecureSkipVerify since we only care about existence, not cert validity
	tr := &http.Transport{TLSClientConfig: tlsConfigInsecure}
	client := &http.Client{Transport: tr, Timeout: 800 * time.Millisecond}
	urls := []string{
		fmt.Sprintf("https://%s:%d/api/health", ip, port),
		fmt.Sprintf("http://%s:%d/api/health", ip, port),
	}

	for _, url := range urls {
		resp, err := client.Get(url)
		if err != nil {
			continue
		}
		resp.Body.Close()
		if resp.StatusCode == 200 {
			return true
		}
	}
	return false
}

// DeviceInfo holds the info retrieved from a ShareTool /api/info endpoint
type DeviceInfo struct {
	Name     string `json:"name"`
	IP       string `json:"ip"`
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
}

// probeHostInfo queries the /api/info endpoint to get device name and details
func probeHostInfo(ip string, port int) (string, int, string) {
	tr := &http.Transport{TLSClientConfig: tlsConfigInsecure}
	client := &http.Client{Transport: tr, Timeout: 1200 * time.Millisecond}
	urls := []string{
		fmt.Sprintf("https://%s:%d/api/info", ip, port),
		fmt.Sprintf("http://%s:%d/api/info", ip, port),
	}

	for _, url := range urls {
		resp, err := client.Get(url)
		if err != nil {
			continue
		}
		defer resp.Body.Close()
		if resp.StatusCode == 200 {
			var info DeviceInfo
			if err := json.NewDecoder(resp.Body).Decode(&info); err == nil && info.Name != "" {
				proto := "https"
				if !strings.HasPrefix(url, "https") {
					proto = "http"
				}
				return info.Name, info.Port, proto
			}
		}
	}
	// Fallback: return IP as name with default port
	return ip, port, "http"
}
