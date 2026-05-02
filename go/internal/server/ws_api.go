package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// handlePush serves clipboard updates via SSE (Server-Sent Events)
func handlePush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	deviceID := r.URL.Query().Get("device_id")
	if deviceID == "" {
		deviceID = instanceName
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE not supported", 500)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("X-Accel-Buffering", "no")

	ch := AddPushClient(deviceID)
	defer RemovePushClient(deviceID)

	log.Printf("[SSE] Client connected: %s", deviceID)

	// Send initial ping
	fmt.Fprintf(w, "event: ping\ndata: {\"device_id\":\"%s\"}\n\n", deviceID)
	flusher.Flush()

	// Keep-alive ticker
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	clientGone := r.Context().Done()

	for {
		select {
		case entry, ok := <-ch:
			if !ok {
				// Channel closed
				return
			}
			data, err := json.Marshal(entry)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: clipboard\ndata: %s\n\n", data)
			flusher.Flush()
		case <-ticker.C:
			// Keep-alive ping
			fmt.Fprintf(w, ": ping\n\n")
			flusher.Flush()
		case <-clientGone:
			log.Printf("[SSE] Client disconnected: %s", deviceID)
			return
		}
	}
}
