package server

import (
	"encoding/json"
	"fmt"
	"log"
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

// RegisterPeer registers or updates a peer (exported for use by mDNS discovery)
func RegisterPeer(ip string, port int, name string) {
	if ip == "" || port <= 0 {
		return
	}
	key := fmt.Sprintf("%s:%d", ip, port)
	peersMu.Lock()
	existing, exists := peers[key]
	peers[key] = Peer{
		Name:      name,
		IP:        ip,
		Port:      port,
		UpdatedAt: time.Now().UnixMilli(),
	}
	peersMu.Unlock()
	if !exists || existing.Name != name {
		log.Printf("[Peers] Registered peer: %s (%s:%d)", name, ip, port)
	}
}

// handlePeersList returns all registered peers
func handlePeersList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	peersMu.RLock()
	list := make([]Peer, 0, len(peers))
	now := time.Now().UnixMilli()
	for _, p := range peers {
		// Only include peers seen in last 5 minutes
		if now-p.UpdatedAt < 5*60*1000 {
			list = append(list, p)
		}
	}
	peersMu.RUnlock()
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
	RegisterPeer(req.IP, req.Port, req.Name)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// StartPeerCleanup starts a background goroutine that removes stale peers
// (not updated within the given maxAge). Call once at startup.
func StartPeerCleanup(maxAge time.Duration) {
	go func() {
		ticker := time.NewTicker(maxAge)
		defer ticker.Stop()
		for range ticker.C {
			now := time.Now().UnixMilli()
			peersMu.Lock()
			for key, p := range peers {
				if now-p.UpdatedAt > int64(maxAge/time.Millisecond) {
					delete(peers, key)
					log.Printf("[Peers] Removed stale peer: %s (%s:%d)", p.Name, p.IP, p.Port)
				}
			}
			peersMu.Unlock()
		}
	}()
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
