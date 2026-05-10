package server

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Device represents a discovered or manually added ShareTool device
type Device struct {
	IP       string `json:"ip"`
	Port     int    `json:"port"`
	Name     string `json:"name"`
	Online   bool   `json:"online"`
	LastSeen int64  `json:"lastSeen"` // Unix ms
	Manual   bool   `json:"manual"`   // true if manually added
}

// handleDevicesList returns all discovered and manually added devices
func handleDevicesList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	var devices []Device
	now := time.Now()

	// Collect discovered peers (from TCP scan + mDNS)
	peersMu.RLock()
	for _, p := range peers {
		online := now.Sub(time.UnixMilli(p.UpdatedAt)) < 5*time.Minute
		devices = append(devices, Device{
			IP:       p.IP,
			Port:     p.Port,
			Name:     p.Name,
			Online:   online,
			LastSeen: p.UpdatedAt,
			Manual:   false,
		})
	}
	peersMu.RUnlock()

	// Collect manual peers
	manualPeers.mu.RLock()
	for _, p := range manualPeers.peers {
		online := now.Sub(time.UnixMilli(p.UpdatedAt)) < 5*time.Minute
		devices = append(devices, Device{
			IP:       p.IP,
			Port:     p.Port,
			Name:     p.Name,
			Online:   online,
			LastSeen: p.UpdatedAt,
			Manual:   true,
		})
	}
	manualPeers.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"devices": devices,
		"success": true,
	})
}

// handleDevicesCheck probes a device to check if it's online and returns its info
func handleDevicesCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	ip := r.URL.Query().Get("ip")
	portStr := r.URL.Query().Get("port")
	if ip == "" || portStr == "" {
		http.Error(w, `{"error":"ip and port required"}`, 400)
		return
	}

	var port int
	if _, err := fmt.Sscanf(portStr, "%d", &port); err != nil {
		http.Error(w, `{"error":"invalid port"}`, 400)
		return
	}

	// Probe the device
	online, name := probeDeviceOnline(ip, port)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ip":     ip,
		"port":   port,
		"name":   name,
		"online": online,
	})
}

// probeDeviceOnline checks if a device is reachable and returns its display name
func probeDeviceOnline(ip string, port int) (bool, string) {
	tr := &tls.Config{InsecureSkipVerify: true}
	client := &http.Client{
		Transport: &http.Transport{TLSClientConfig: tr},
		Timeout:   1200 * time.Millisecond,
	}

	type infoResp struct {
		Name string `json:"name"`
	}

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
			var info infoResp
			if err := json.NewDecoder(resp.Body).Decode(&info); err == nil {
				if info.Name != "" {
					return true, info.Name
				}
			}
		}
	}
	return false, ip
}

// devicesOnlineCheck checks multiple devices concurrently and returns online status
func devicesOnlineCheck(devices []Device) []Device {
	type result struct {
		ip     string
		port   int
		online bool
		name   string
	}

	in := make(chan Device, len(devices))
	out := make(chan result, len(devices))

	// Fan out
	for _, d := range devices {
		in <- d
	}
	close(in)

	var wg sync.WaitGroup
	for range devices {
		wg.Add(1)
		go func(d Device) {
			defer wg.Done()
			online, name := probeDeviceOnline(d.IP, d.Port)
			out <- result{ip: d.IP, port: d.Port, online: online, name: name}
		}(<-in)
	}

	// Close out when all done
	go func() {
		wg.Wait()
		close(out)
	}()

	// Build result map
	results := make(map[string]result)
	for r := range out {
		results[fmt.Sprintf("%s:%d", r.ip, r.port)] = r
	}

	// Merge back into devices
	for i := range devices {
		key := fmt.Sprintf("%s:%d", devices[i].IP, devices[i].Port)
		if res, ok := results[key]; ok {
			devices[i].Online = res.online
			if res.name != "" {
				devices[i].Name = res.name
			}
		}
	}

	return devices
}
