package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

type TextEntry struct {
	ID        string `json:"id"`
	Content   string `json:"content"`
	Timestamp int64  `json:"timestamp"`
}

var (
	textHistory   []TextEntry
	textMu        sync.RWMutex
	maxTextHistory = 100
)

func genID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// handleTextPost adds a new entry to the history
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
	if req.Content == "" {
		http.Error(w, `{"error":"content cannot be empty"}`, 400)
		return
	}

	entry := TextEntry{
		ID:        genID(),
		Content:   req.Content,
		Timestamp: time.Now().UnixMilli(),
	}

	textMu.Lock()
	textHistory = append([]TextEntry{entry}, textHistory...)
	if len(textHistory) > maxTextHistory {
		textHistory = textHistory[:maxTextHistory]
	}
	textMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(entry)
}

// handleTextList returns the full text history
func handleTextList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	textMu.RLock()
	list := make([]TextEntry, len(textHistory))
	copy(list, textHistory)
	textMu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"entries": list})
}

// handleTextDelete removes one entry or clears all
func handleTextDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	id := r.URL.Query().Get("id")
	all := r.URL.Query().Get("all")

	if all == "true" {
		// Clear all
		textMu.Lock()
		textHistory = nil
		textMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"success": true, "cleared": true})
		return
	}

	if id == "" {
		http.Error(w, `{"error":"missing id parameter"}`, 400)
		return
	}

	textMu.Lock()
	found := false
	for i, e := range textHistory {
		if e.ID == id {
			textHistory = append(textHistory[:i], textHistory[i+1:]...)
			found = true
			break
		}
	}
	textMu.Unlock()

	if !found {
		http.Error(w, `{"error":"entry not found"}`, 404)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}
