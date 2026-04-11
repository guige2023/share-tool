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
