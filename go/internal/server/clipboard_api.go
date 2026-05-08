package server

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	MaxClipboardTextSize   = 1 * 1024 * 1024  // 1MB
	MaxClipboardImageSize  = 10 * 1024 * 1024 // 10MB
	MaxClipboardFilesSize  = 100 * 1024 * 1024 // 100MB
	MaxClipboardHistory    = 50
	HistoryFileName        = "history.json"
	ImagesDirName          = "images"
	FilesDirName           = "files"
)

// ServerMode: "hub" = this instance is the central relay, "client" = sends to hub
var ServerMode = "hub"

type ClipboardEntry struct {
	ID        string `json:"id"`
	Type      string `json:"type"` // "text" | "image" | "file"
	Content   string `json:"content"` // text content, or base64 for images/files
	FileName  string `json:"fileName,omitempty"` // original filename for files
	FileSize  int64  `json:"fileSize,omitempty"` // file size for files
	FilePath  string `json:"filePath,omitempty"` // local disk path for images/files
	From      string `json:"from"`
	Timestamp int64  `json:"timestamp"`
}

type ClipboardRequest struct {
	Type      string `json:"type"`
	Content   string `json:"content"`
	FileName  string `json:"fileName,omitempty"`
	FileSize  int64  `json:"fileSize,omitempty"`
	From      string `json:"from"`
	Timestamp int64  `json:"timestamp"`
}

type ClipboardResponse struct {
	Success   bool   `json:"success"`
	ID        string `json:"id,omitempty"`
	Forwarded int    `json:"forwarded,omitempty"`
	Error     string `json:"error,omitempty"`
}

var (
	clipboardHistory  []ClipboardEntry
	clipboardMu       sync.RWMutex
	instanceName      = "unknown"
	instanceIP        = "127.0.0.1"
	instancePort     = 18793
	forwardClient     *http.Client
	dataDir           = "" // e.g. ~/.sharetool/clipboard
	sharedDir        = "" // e.g. ~/ShareToolShared
	db               *sql.DB
	shareToken       = ""
)

func SetInstanceInfo(name, ip string, port int) {
	instanceName = name
	instanceIP = ip
	instancePort = port
	forwardClient = &http.Client{Timeout: 10 * time.Second}
}

// SetDB sets the database connection for server-side storage
func SetDB(database *sql.DB) {
	db = database
}

// SetShareToken sets the share token for authentication
func SetShareToken(token string) {
	shareToken = token
}

// SetDataDir sets the persistent storage directory
func SetDataDir(dir string) {
	dataDir = dir
	ensureDataDirs()
	loadHistory()
}

// SetSharedDir sets the shared directory for file sync
func SetSharedDir(dir string) {
	sharedDir = dir
	log.Printf("[Clipboard] Shared dir set to: %s", dir)
}

// Ensure image/ and files/ subdirs exist
func ensureDataDirs() {
	if dataDir == "" {
		return
	}
	os.MkdirAll(filepath.Join(dataDir, ImagesDirName), 0755)
	os.MkdirAll(filepath.Join(dataDir, FilesDirName), 0755)
}

// copyFileToShared copies a file from clipboard storage to shared directory for WebUI
func copyFileToShared(srcPath, fileName string) {
	if sharedDir == "" || srcPath == "" {
		return
	}
	src, err := os.Open(srcPath)
	if err != nil {
		log.Printf("[Clipboard] Warning: failed to open source file for shared dir: %v", err)
		return
	}
	defer src.Close()

	// Use timestamp prefix to avoid name conflicts
	dstName := fmt.Sprintf("%d_%s", time.Now().UnixMilli(), fileName)
	dstPath := filepath.Join(sharedDir, dstName)
	dst, err := os.Create(dstPath)
	if err != nil {
		log.Printf("[Clipboard] Warning: failed to create shared file: %v", err)
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		log.Printf("[Clipboard] Warning: failed to copy file to shared dir: %v", err)
		return
	}
	log.Printf("[Clipboard] Copied file to shared dir: %s", dstName)
}

// copyImageToShared copies an image from clipboard storage to shared directory for WebUI
func copyImageToShared(srcPath, fileName string) {
	if sharedDir == "" || srcPath == "" {
		return
	}
	src, err := os.Open(srcPath)
	if err != nil {
		log.Printf("[Clipboard] Warning: failed to open source image for shared dir: %v", err)
		return
	}
	defer src.Close()

	// Use timestamp prefix to avoid name conflicts
	dstName := fmt.Sprintf("%d_%s", time.Now().UnixMilli(), fileName)
	dstPath := filepath.Join(sharedDir, dstName)
	dst, err := os.Create(dstPath)
	if err != nil {
		log.Printf("[Clipboard] Warning: failed to create shared image: %v", err)
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		log.Printf("[Clipboard] Warning: failed to copy image to shared dir: %v", err)
		return
	}
	log.Printf("[Clipboard] Copied image to shared dir: %s", dstName)
}

// Load history from disk
func loadHistory() {
	if dataDir == "" {
		return
	}
	path := filepath.Join(dataDir, HistoryFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		// No history file yet, start fresh
		return
	}
	var entries []ClipboardEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return
	}
	clipboardMu.Lock()
	clipboardHistory = entries
	clipboardMu.Unlock()
}

// Save history to disk (called after every write)
func saveHistory() {
	if dataDir == "" {
		return
	}
	path := filepath.Join(dataDir, HistoryFileName)
	clipboardMu.RLock()
	data, err := json.MarshalIndent(clipboardHistory, "", "  ")
	clipboardMu.RUnlock()
	if err != nil {
		return
	}
	os.WriteFile(path, data, 0644)
}

// Save image to disk, return relative path
func saveImageFile(entryID string, base64Data string) (string, error) {
	if dataDir == "" {
		return "", fmt.Errorf("no data dir")
	}
	decoded, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return "", err
	}
	filename := fmt.Sprintf("%s.png", entryID)
	filepath := filepath.Join(dataDir, ImagesDirName, filename)
	if err := os.WriteFile(filepath, decoded, 0644); err != nil {
		return "", err
	}
	return filepath, nil
}

// Save file content to disk, return relative path
func saveFileContent(entryID string, fileName string, base64Content string) (string, error) {
	if dataDir == "" {
		return "", fmt.Errorf("no data dir")
	}

	// Create files subdirectory
	filesDir := filepath.Join(dataDir, FilesDirName)
	if err := os.MkdirAll(filesDir, 0755); err != nil {
		return "", err
	}

	// Decode base64 content
	decoded, err := base64.StdEncoding.DecodeString(base64Content)
	if err != nil {
		return "", fmt.Errorf("failed to decode base64: %v", err)
	}

	// Use sanitized filename
	safeName := filepath.Base(fileName)
	filename := fmt.Sprintf("%s_%s", entryID, safeName)
	filepath := filepath.Join(filesDir, filename)

	if err := os.WriteFile(filepath, decoded, 0644); err != nil {
		return "", err
	}
	return filepath, nil
}

func genClipboardID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// handleClipboardPost receives clipboard content and stores + forwards to all peers
func handleClipboardPost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	contentLength := r.ContentLength
	if contentLength > MaxClipboardFilesSize {
		http.Error(w, `{"error":"content too large"}`, 413)
		return
	}

	var req ClipboardRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}

	// Validate type
	if req.Type != "text" && req.Type != "image" && req.Type != "file" {
		http.Error(w, `{"error":"type must be text, image, or file"}`, 400)
		return
	}

	// Validate size
	size := int64(len(req.Content))
	switch req.Type {
	case "text":
		if size > MaxClipboardTextSize {
			http.Error(w, `{"error":"text content exceeds 1MB limit"}`, 413)
			return
		}
	case "image":
		if size > MaxClipboardImageSize {
			http.Error(w, `{"error":"image content exceeds 10MB limit"}`, 413)
			return
		}
	case "file":
		if size > MaxClipboardFilesSize {
			http.Error(w, `{"error":"file content exceeds 100MB limit"}`, 413)
			return
		}
	}

	if req.From == "" {
		req.From = instanceName
	}
	if req.Timestamp == 0 {
		req.Timestamp = time.Now().UnixMilli()
	}

	entry := ClipboardEntry{
		ID:        genClipboardID(),
		Type:      req.Type,
		Content:   req.Content,
		From:      req.From,
		Timestamp: req.Timestamp,
	}

	// Persist to disk: images/files -> save to disk, text -> keep in JSON
	// Use default filename if not provided
	log.Printf("[Clipboard] handleClipboardPost: type=%s, dataDir=%s, sharedDir=%s", req.Type, dataDir, sharedDir)
	if req.FileName == "" {
		req.FileName = "unnamed"
	}
	if req.Type == "image" && dataDir != "" {
		imageName := req.FileName
		if imageName == "" || imageName == "." {
			imageName = "image.png"
		}
		log.Printf("[Clipboard] Saving image: %s", imageName)
		if fp, err := saveImageFile(entry.ID, imageName); err == nil {
			entry.FilePath = fp
			// Clear base64 from memory after saving to disk
			entry.Content = ""
			// Also copy to shared dir for WebUI
			if sharedDir != "" {
				log.Printf("[Clipboard] Starting async copy to shared dir for image")
				go copyImageToShared(fp, imageName)
			}
		}
	} else if req.Type == "file" && dataDir != "" {
		// Save file content to disk
		log.Printf("[Clipboard] Saving file: %s, size=%d", req.FileName, req.FileSize)
		if fp, err := saveFileContent(entry.ID, req.FileName, req.Content); err == nil {
			entry.FilePath = fp
			entry.FileName = req.FileName
			entry.FileSize = req.FileSize
			entry.Content = ""
			// Also copy to shared dir for WebUI
			if sharedDir != "" {
				log.Printf("[Clipboard] Starting async copy to shared dir for file")
				go copyFileToShared(fp, req.FileName)
			}
		}
	}

	// Store locally
	clipboardMu.Lock()
	clipboardHistory = append([]ClipboardEntry{entry}, clipboardHistory...)
	if len(clipboardHistory) > MaxClipboardHistory {
		clipboardHistory = clipboardHistory[:MaxClipboardHistory]
	}
	clipboardMu.Unlock()

	// Persist history to disk
	saveHistory()

	// Forward to all registered peers (async, non-blocking)
	forwarded := 0
	var mu sync.Mutex
	var wg sync.WaitGroup
	peersMu.RLock()
	for key, peer := range peers {
		// Don't send to self
		if peer.IP == instanceIP && peer.Port == instancePort {
			continue
		}
		wg.Add(1)
		go func(k string, p Peer) {
			defer wg.Done()
			if err := forwardClipboardToPeer(p, entry); err != nil {
				// Remove unreachable peer
				peersMu.Lock()
				delete(peers, k)
				peersMu.Unlock()
			} else {
				mu.Lock()
				forwarded++
				mu.Unlock()
				// Update peer's timestamp
				peersMu.Lock()
				if existing, ok := peers[k]; ok {
					existing.UpdatedAt = time.Now().UnixMilli()
					peers[k] = existing
				}
				peersMu.Unlock()
			}
		}(key, peer)
	}
	peersMu.RUnlock()
	go wg.Wait()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ClipboardResponse{
		Success:   true,
		ID:        entry.ID,
		Forwarded: forwarded,
	})
}

func forwardClipboardToPeer(peer Peer, entry ClipboardEntry) error {
	url := fmt.Sprintf("https://%s:%d/api/clipboard/receive", peer.IP, peer.Port)

	payload := map[string]any{
		"type":      entry.Type,
		"content":   entry.Content,
		"file_name": entry.FileName,
		"file_size": entry.FileSize,
		"file_path": entry.FilePath,
		"from":      entry.From,
		"timestamp": entry.Timestamp,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	// Skip TLS verification for self-signed certs
	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	client := &http.Client{Transport: tr, Timeout: 10 * time.Second}

	resp, err := client.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("peer returned status %d", resp.StatusCode)
	}
	return nil
}

// handleClipboardReceive receives clipboard from a peer and stores it locally
func handleClipboardReceive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	if r.ContentLength > MaxClipboardFilesSize {
		http.Error(w, `{"error":"content too large"}`, 413)
		return
	}

	var req ClipboardRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}

	// Also accept file_path in the request (for receiving path-based entries from peers)
	filePath := req.Content // reuse Content field for file path in receive context

	if req.Type != "text" && req.Type != "image" && req.Type != "file" {
		http.Error(w, `{"error":"invalid type"}`, 400)
		return
	}

	if req.From == "" || req.From == instanceName {
		// Don't store own messages that bounced back
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ClipboardResponse{Success: true})
		return
	}

	entry := ClipboardEntry{
		ID:        genClipboardID(),
		Type:      req.Type,
		Content:   req.Content,
		From:      req.From,
		Timestamp: req.Timestamp,
	}

	// Persist received image/files to disk if they came with base64 content
	if req.Type == "image" && req.Content != "" && dataDir != "" {
		if fp, err := saveImageFile(entry.ID, req.Content); err == nil {
			entry.FilePath = fp
			entry.Content = ""
		}
	} else if req.Type == "file" && req.Content != "" && dataDir != "" {
		if fp, err := saveFileContent(entry.ID, req.FileName, req.Content); err == nil {
			entry.FilePath = fp
			entry.FileName = req.FileName
			entry.FileSize = req.FileSize
			entry.Content = ""
		}
	} else if filePath != "" {
		// Content was already a path reference
		entry.FilePath = filePath
		entry.Content = ""
	}

	clipboardMu.Lock()
	// Deduplicate: don't store if same content from same sender within 2 seconds
	isDup := false
	if len(clipboardHistory) > 0 && clipboardHistory[0].From == entry.From {
		if abs(entry.Timestamp-clipboardHistory[0].Timestamp) < 2000 &&
			clipboardHistory[0].Content == entry.Content {
			isDup = true
		}
	}
	if !isDup {
		clipboardHistory = append([]ClipboardEntry{entry}, clipboardHistory...)
		if len(clipboardHistory) > MaxClipboardHistory {
			clipboardHistory = clipboardHistory[:MaxClipboardHistory]
		}
	}
	clipboardMu.Unlock()

	// Persist to disk
	saveHistory()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ClipboardResponse{Success: true})
}

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

// handleClipboardLatest returns the most recent clipboard entry
func handleClipboardLatest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	clipboardMu.RLock()
	var entry *ClipboardEntry
	if len(clipboardHistory) > 0 {
		e := clipboardHistory[0]
		entry = &e
	}
	clipboardMu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	if entry == nil {
		json.NewEncoder(w).Encode(map[string]any{"entry": nil})
		return
	}

	// Re-read file content for file/image types
	enrichEntry(entry)
	json.NewEncoder(w).Encode(map[string]any{"entry": entry})
}

// handleClipboardHistory returns clipboard history
func handleClipboardHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	clipboardMu.RLock()
	list := make([]ClipboardEntry, len(clipboardHistory))
	copy(list, clipboardHistory)
	clipboardMu.RUnlock()

	// Re-read file content for file/image types
	for i := range list {
		enrichEntry(&list[i])
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"entries": list})
}

// enrichEntry re-reads file content from disk and populates Content field
func enrichEntry(entry *ClipboardEntry) {
	if entry == nil || entry.FilePath == "" {
		return
	}
	if entry.Type != "file" && entry.Type != "image" {
		return
	}
	// Read file content and encode as base64
	data, err := os.ReadFile(entry.FilePath)
	if err != nil {
		return
	}
	entry.Content = base64.StdEncoding.EncodeToString(data)
}

// handleClipboardDelete clears clipboard history
func handleClipboardDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	clipboardMu.Lock()
	clipboardHistory = nil
	clipboardMu.Unlock()

	// Also clear history file
	if dataDir != "" {
		os.Remove(filepath.Join(dataDir, HistoryFileName))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// handleClipboardPeersSend sends the latest clipboard entry to all peers manually
func handleClipboardPeersSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	clipboardMu.RLock()
	var entry *ClipboardEntry
	if len(clipboardHistory) > 0 {
		e := clipboardHistory[0]
		entry = &e
	}
	clipboardMu.RUnlock()

	if entry == nil {
		http.Error(w, `{"error":"no clipboard content to send"}`, 404)
		return
	}

	forwarded := 0
	var mu sync.Mutex
	var wg sync.WaitGroup

	peersMu.RLock()
	for key, peer := range peers {
		if peer.IP == instanceIP && peer.Port == instancePort {
			continue
		}
		wg.Add(1)
		go func(k string, p Peer) {
			defer wg.Done()
			if err := forwardClipboardToPeer(p, *entry); err != nil {
				peersMu.Lock()
				delete(peers, k)
				peersMu.Unlock()
			} else {
				mu.Lock()
				forwarded++
				mu.Unlock()
			}
		}(key, peer)
	}
	peersMu.RUnlock()
	go wg.Wait()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"success":   true,
		"forwarded": forwarded,
		"entry":     entry,
	})
}

// handleClipboardFile serves a stored image/file by path
func handleClipboardFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		http.Error(w, `{"error":"path required"}`, 400)
		return
	}

	// Security: only serve files within dataDir
	absPath, err := filepath.Abs(filepath.Join(dataDir, filePath))
	if err != nil || absPath[:len(dataDir)] != dataDir {
		http.Error(w, `{"error":"invalid path"}`, 400)
		return
	}

	data, err := os.ReadFile(absPath)
	if err != nil {
		http.Error(w, `{"error":"file not found"}`, 404)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(data)
}
