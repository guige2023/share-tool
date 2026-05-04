package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type Peer struct {
	Name      string `json:"name"`
	IP        string `json:"ip"`
	Port      int    `json:"port"`
	UpdatedAt int64  `json:"updatedAt"`
}

var (
	peers   = make(map[string]Peer)
	peersMu sync.RWMutex
)

// handlePeersList returns all registered peers (both discovered and manually added)
func handlePeersList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var list []Peer
	peersMu.RLock()
	now := time.Now().UnixMilli()
	for _, p := range peers {
		// Only include peers seen in last 5 minutes
		if now-p.UpdatedAt < 5*60*1000 {
			list = append(list, p)
		}
	}
	peersMu.RUnlock()

	// Include manual peers
	manualPeers.mu.RLock()
	for _, p := range manualPeers.peers {
		list = append(list, p)
	}
	manualPeers.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"peers": list})
}

// handlePeersRegister registers or updates a peer entry
func handlePeersRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		Name string `json:"name"`
		IP   string `json:"ip"`
		Port int    `json:"port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	if req.Name == "" || req.IP == "" || req.Port <= 0 {
		http.Error(w, `{"error":"missing required fields"}`, 400)
		return
	}
	key := fmt.Sprintf("%s:%d", req.IP, req.Port)
	peersMu.Lock()
	peers[key] = Peer{
		Name:      req.Name,
		IP:        req.IP,
		Port:      req.Port,
		UpdatedAt: time.Now().UnixMilli(),
	}
	peersMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// handlePeersRemove removes a peer
func handlePeersRemove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		IP   string `json:"ip"`
		Port int    `json:"port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	key := fmt.Sprintf("%s:%d", req.IP, req.Port)
	peersMu.Lock()
	delete(peers, key)
	peersMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// ManualPeerManager manages manually added peers
type ManualPeerManager struct {
	peers map[string]Peer
	mu    sync.RWMutex
}

var manualPeers = &ManualPeerManager{
	peers: make(map[string]Peer),
}

// SetManualPeer adds or updates a manually configured peer
func SetManualPeer(ip string, port int, name string) {
	manualPeers.mu.Lock()
	defer manualPeers.mu.Unlock()
	if name == "" {
		name = ip
	}
	key := fmt.Sprintf("%s:%d", ip, port)
	manualPeers.peers[key] = Peer{
		Name:      name,
		IP:        ip,
		Port:      port,
		UpdatedAt: time.Now().UnixMilli(),
	}
}

// RemoveManualPeer removes a manually configured peer
func RemoveManualPeer(ip string, port int) {
	manualPeers.mu.Lock()
	defer manualPeers.mu.Unlock()
	key := fmt.Sprintf("%s:%d", ip, port)
	delete(manualPeers.peers, key)
}

// handlePeersManualAdd adds a peer manually
func handlePeersManualAdd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		IP   string `json:"ip"`
		Port int    `json:"port"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	if req.IP == "" || req.Port <= 0 {
		http.Error(w, `{"error":"ip and port are required"}`, 400)
		return
	}
	SetManualPeer(req.IP, req.Port, req.Name)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// handlePeersManualRemove removes a manually added peer
func handlePeersManualRemove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		IP   string `json:"ip"`
		Port int    `json:"port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	RemoveManualPeer(req.IP, req.Port)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// SetPeer adds or updates a discovered peer
func SetPeer(ip string, port int, name string) {
	key := fmt.Sprintf("%s:%d", ip, port)
	peersMu.Lock()
	peers[key] = Peer{
		Name:      name,
		IP:        ip,
		Port:      port,
		UpdatedAt: time.Now().UnixMilli(),
	}
	peersMu.Unlock()
}

// GetAllPeers returns all discovered peers
func GetAllPeers() []Peer {
	peersMu.RLock()
	defer peersMu.RUnlock()
	var list []Peer
	for _, p := range peers {
		list = append(list, p)
	}
	return list
}
