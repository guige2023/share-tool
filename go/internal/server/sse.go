package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// SSEClient represents a client subscribed to server-sent events.
type SSEClient struct {
	ch  chan []byte
	id  int
}

var (
	sseClients   = make(map[*SSEClient]bool)
	sseClientsMu sync.RWMutex
	sseNextID    int
	sseNextIDMu  sync.Mutex
)

// Broadcast sends an event to all connected SSE clients.
func Broadcast(event string, data interface{}) {
	payload, err := json.Marshal(map[string]any{"event": event, "data": data, "time": time.Now().Unix()})
	if err != nil {
		return
	}
	sseClientsMu.RLock()
	defer sseClientsMu.RUnlock()
	for client := range sseClients {
		select {
		case client.ch <- payload:
		default:
			// drop if client buffer full
		}
	}
}

// BroadcastFileChanged notifies all clients that the file list has changed.
func BroadcastFileChanged() {
	Broadcast("files_changed", nil)
}

// BroadcastClipboardReceived notifies all clients of a new clipboard entry.
func BroadcastClipboardReceived(entry map[string]any) {
	Broadcast("clipboard_received", entry)
}

// BroadcastDeviceOnline notifies of a device coming online.
func BroadcastDeviceOnline(device map[string]any) {
	Broadcast("device_online", device)
}

// BroadcastDeviceOffline notifies of a device going offline.
func BroadcastDeviceOffline(deviceID string) {
	Broadcast("device_offline", map[string]string{"device_id": deviceID})
}

// handleSSE serves Server-Sent Events for real-time updates.
func handleSSE(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	// Get client ID
	sseNextIDMu.Lock()
	id := sseNextID
	sseNextID++
	sseNextIDMu.Unlock()

	client := &SSEClient{
		ch: make(chan []byte, 50),
		id: id,
	}

	// Register client
	sseClientsMu.Lock()
	sseClients[client] = true
	sseClientsMu.Unlock()

	// Cleanup on disconnect
	defer func() {
		sseClientsMu.Lock()
		delete(sseClients, client)
		sseClientsMu.Unlock()
		close(client.ch)
	}()

	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE not supported", 500)
		return
	}

	// Send initial connection event
	fmt.Fprintf(w, "event: connected\ndata: {\"client_id\":%d}\n\n", id)
	flusher.Flush()

	// Keep-alive ticker
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case payload, ok := <-client.ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", payload)
			flusher.Flush()
		case <-ticker.C:
			// Keep-alive comment
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}
