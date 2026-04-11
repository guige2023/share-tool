package server

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

var (
	latestText   = ""
	latestTime   int64 = 0
	textMu       sync.RWMutex
)

func handleTextPost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct{ Content string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	textMu.Lock()
	latestText = req.Content
	latestTime = time.Now().UnixMilli()
	textMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func handleTextLatest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	textMu.RLock()
	c, t := latestText, latestTime
	textMu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"content": c, "timestamp": t})
}
