package server

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	MaxClipboardTextSize   = 1 * 1024 * 1024  // 1MB
	MaxClipboardImageSize  = 10 * 1024 * 1024 // 10MB
	MaxClipboardFilesSize = 100 * 1024 * 1024 // 100MB
	MaxClipboardHistory   = 50
	HistoryFileName      = "history.json"
	ImagesDirName        = "images"
	FilesDirName         = "files"
	SmallImageMaxBytes   = 512 * 1024       // 512KB: embed directly, above -> blob URL
)

// ClipboardEntry v2 — unified protocol structure
type ClipboardEntry struct {
	ID        string     `json:"entry_id"` // global unique ID for loop prevention
	DeviceID  string     `json:"device_id"` // sender device identifier
	Type      string     `json:"type"`      // "text" | "image" | "files"
	Mime      string     `json:"mime"`      // MIME type
	Text      string     `json:"text,omitempty"` // text content (type=text)
	Files     []FileMeta `json:"files,omitempty"` // file array (type=image/files)
	BlobURL   string     `json:"blob_url,omitempty"` // blob download URL
	SHA256    string     `json:"sha256,omitempty"` // overall checksum
	From      string     `json:"from"`       // display name
	Timestamp int64      `json:"timestamp"`  // unix ms
}

// FileMeta describes a file in a clipboard entry
type FileMeta struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
	BlobURL string `json:"blob_url"`
	Mime    string `json:"mime,omitempty"`
}

// ClipboardRequest v2 — incoming request from clients
type ClipboardRequest struct {
	Type      string     `json:"type"`
	Content   string     `json:"content"`               // text content (type=text)
	From      string     `json:"from"`
	Timestamp int64      `json:"timestamp"`
	EntryID   string     `json:"entry_id,omitempty"`   // for dedup
	BlobURL   string     `json:"blob_url,omitempty"`  // image/file download URL (type=image/files)
	Files     []FileMeta `json:"files,omitempty"`      // file metadata array (type=files)
}

// ClipboardResponse v2
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
	lastWrittenEntry  = "" // for loop prevention
	lastWrittenAt     int64
	lastWrittenMu     sync.Mutex
)

func SetInstanceInfo(name, ip string, port int) {
	instanceName = name
	instanceIP = ip
	instancePort = port
	forwardClient = &http.Client{Timeout: 10 * time.Second}
}

// SetDataDir sets the persistent storage directory
func SetDataDir(dir string) {
	dataDir = dir
	ensureDataDirs()
	loadHistory()
	if blobStore == nil {
		if err := InitBlobStore(dir); err != nil {
			fmt.Printf("[BlobStore] init failed: %v\n", err)
		}
	}
}

// Ensure image/ and files/ subdirs exist
func ensureDataDirs() {
	if dataDir == "" {
		return
	}
	os.MkdirAll(filepath.Join(dataDir, ImagesDirName), 0755)
	os.MkdirAll(filepath.Join(dataDir, FilesDirName), 0755)
}

// Load history from disk
func loadHistory() {
	if dataDir == "" {
		return
	}
	path := filepath.Join(dataDir, HistoryFileName)
	data, err := os.ReadFile(path)
	if err != nil {
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

func genClipboardID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func mimeForType(t string) string {
	switch t {
	case "text":
		return "text/plain"
	case "image":
		return "image/png"
	case "files":
		return "application/octet-stream"
	default:
		return "application/octet-stream"
	}
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

	if req.Type != "text" && req.Type != "image" && req.Type != "files" {
		http.Error(w, `{"error":"type must be text, image, or files"}`, 400)
		return
	}

	if req.From == "" {
		req.From = instanceName
	}
	if req.Timestamp == 0 {
		req.Timestamp = time.Now().UnixMilli()
	}

	entryID := genClipboardID()
	entry := ClipboardEntry{
		ID:        entryID,
		DeviceID:  instanceName,
		Type:      req.Type,
		Mime:      mimeForType(req.Type),
		From:      req.From,
		Timestamp: req.Timestamp,
	}

	switch req.Type {
	case "text":
		size := int64(len(req.Content))
		if size > MaxClipboardTextSize {
			http.Error(w, `{"error":"text content exceeds 1MB limit"}`, 413)
			return
		}
		entry.Text = req.Content

	case "image":
		size := int64(len(req.Content))
		if size > MaxClipboardImageSize {
			http.Error(w, `{"error":"image content exceeds 10MB limit"}`, 413)
			return
		}
		// Strategy: < 512KB embed directly; >= 512KB store as blob
		if len(req.Content) > 0 {
			if len(req.Content) < SmallImageMaxBytes {
				// Small image: embed base64 in Text field, save locally
				entry.Text = req.Content
				if dataDir != "" {
					fp, err := saveImageFile(entryID, req.Content)
					if err == nil {
						entry.BlobURL = "/api/clipboard/file?path=" + filepath.Base(fp)
					}
				}
			} else {
				// Large image: store as blob
				data, _ := hex.DecodeString(req.Content)
				// If not valid hex, use content directly (should already be base64)
				if len(data) == 0 {
					data = []byte(req.Content)
				}
				blobID, sha, err := blobStore.Save(entryID, data, "image/png")
				if err == nil {
					entry.SHA256 = sha
					entry.BlobURL = fmt.Sprintf("/api/blobs?id=%s", blobID)
				}
			}
		}

	case "files":
		size := int64(len(req.Content))
		if size > MaxClipboardFilesSize {
			http.Error(w, `{"error":"files content exceeds 100MB limit"}`, 413)
			return
		}
		// req.Files contains FileMeta array from client
		if len(req.Files) > 0 {
			entry.Files = req.Files
		}
	}

	// Store locally
	clipboardMu.Lock()
	clipboardHistory = append([]ClipboardEntry{entry}, clipboardHistory...)
	if len(clipboardHistory) > MaxClipboardHistory {
		clipboardHistory = clipboardHistory[:MaxClipboardHistory]
	}
	clipboardMu.Unlock()
	saveHistory()

	// Push to SSE clients (non-blocking)
	go BroadcastClipboard(entry)

	// Forward to all registered peers (sync, wait for results)
	// Snapshot peers to avoid modifying map during iteration
	peersMu.RLock()
	peerList := make([]Peer, 0, len(peers))
	for _, p := range peers {
		if p.IP == instanceIP && p.Port == instancePort {
			continue
		}
		peerList = append(peerList, p)
	}
	peersMu.RUnlock()

	forwarded := 0
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, peer := range peerList {
		wg.Add(1)
		go func(p Peer) {
			defer wg.Done()
			if err := forwardClipboardToPeer(p, entry); err != nil {
				// Remove failed peer (separate lock, outside map iteration)
				peersMu.Lock()
				key := fmt.Sprintf("%s:%d", p.IP, p.Port)
				delete(peers, key)
				peersMu.Unlock()
			} else {
				mu.Lock()
				forwarded++
				mu.Unlock()
				peersMu.Lock()
				key := fmt.Sprintf("%s:%d", p.IP, p.Port)
				if existing, ok := peers[key]; ok {
					existing.UpdatedAt = time.Now().UnixMilli()
					peers[key] = existing
				}
				peersMu.Unlock()
			}
		}(peer)
	}
	wg.Wait()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ClipboardResponse{
		Success:   true,
		ID:        entry.ID,
		Forwarded: forwarded,
	})
}

func forwardClipboardToPeer(peer Peer, entry ClipboardEntry) error {
	url := fmt.Sprintf("http://%s:%d/api/clipboard/receive", peer.IP, peer.Port)

	payload := map[string]any{
		"entry_id":  entry.ID,
		"device_id": entry.DeviceID,
		"type":      entry.Type,
		"mime":      entry.Mime,
		"from":      entry.From,
		"timestamp": entry.Timestamp,
	}
	if entry.Text != "" {
		payload["text"] = entry.Text
	}
	if entry.BlobURL != "" {
		payload["blob_url"] = entry.BlobURL
	}
	if len(entry.Files) > 0 {
		payload["files"] = entry.Files
	}
	if entry.SHA256 != "" {
		payload["sha256"] = entry.SHA256
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}

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

	if req.Type != "text" && req.Type != "image" && req.Type != "files" {
		http.Error(w, `{"error":"invalid type"}`, 400)
		return
	}

	// Loop prevention: skip if entry_id matches last written (our own echo)
	if req.EntryID != "" {
		lastWrittenMu.Lock()
		skip := req.EntryID == lastWrittenEntry && time.Now().UnixMilli()-lastWrittenAt < 2000
		lastWrittenMu.Unlock()
		if skip {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(ClipboardResponse{Success: true})
			return
		}
	}

	if req.From == "" || req.From == instanceName {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ClipboardResponse{Success: true})
		return
	}

	entryID := genClipboardID()
	if req.EntryID != "" {
		entryID = req.EntryID
	}

	entry := ClipboardEntry{
		ID:        entryID,
		DeviceID:  req.From,
		Type:      req.Type,
		Mime:      mimeForType(req.Type),
		Text:      req.Content, // text content (type=text) or base64 image (type=image)
		From:      req.From,
		Timestamp: req.Timestamp,
	}

	// Handle BlobURL: fetch blob content and convert to base64 for local storage
	targetContent := req.Content
	if req.BlobURL != "" {
		// Fetch blob from the provided URL
		blobResp, err := forwardClient.Get(req.BlobURL)
		if err == nil && blobResp.StatusCode == http.StatusOK {
			data, err := io.ReadAll(blobResp.Body)
			blobResp.Body.Close()
			if err == nil {
				targetContent = base64.StdEncoding.EncodeToString(data)
			}
		}
	}

	// Persist received image to disk if we have content (either direct or fetched from blob)
	if req.Type == "image" && targetContent != "" && dataDir != "" {
		entry.Text = targetContent
		if fp, err := saveImageFile(entry.ID, targetContent); err == nil {
			entry.BlobURL = "/api/clipboard/file?path=" + filepath.Base(fp)
		}
	}

	clipboardMu.Lock()
	// Deduplicate: don't store if same entry_id from same sender within 2 seconds
	isDup := false
	if len(clipboardHistory) > 0 && clipboardHistory[0].From == entry.From {
		if abs(entry.Timestamp-clipboardHistory[0].Timestamp) < 2000 &&
			clipboardHistory[0].Text == entry.Text {
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

	// Update loop prevention
	lastWrittenMu.Lock()
	lastWrittenEntry = entry.ID
	lastWrittenAt = time.Now().UnixMilli()
	lastWrittenMu.Unlock()

	// Push to SSE clients
	go BroadcastClipboard(entry)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ClipboardResponse{Success: true})
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"entries": list})
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

	// Snapshot peers to avoid modifying map during iteration
	peersMu.RLock()
	peerList := make([]Peer, 0, len(peers))
	for _, p := range peers {
		if p.IP == instanceIP && p.Port == instancePort {
			continue
		}
		peerList = append(peerList, p)
	}
	peersMu.RUnlock()

	forwarded := 0
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, peer := range peerList {
		wg.Add(1)
		go func(p Peer) {
			defer wg.Done()
			if err := forwardClipboardToPeer(p, *entry); err != nil {
				peersMu.Lock()
				key := fmt.Sprintf("%s:%d", p.IP, p.Port)
				delete(peers, key)
				peersMu.Unlock()
			} else {
				mu.Lock()
				forwarded++
				mu.Unlock()
			}
		}(peer)
	}
	wg.Wait()

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

// Save image to disk, return relative path
func saveImageFile(entryID string, base64Data string) (string, error) {
	if dataDir == "" {
		return "", fmt.Errorf("no data dir")
	}
	decoded, err := decodeBase64(base64Data)
	if err != nil {
		return "", err
	}
	filename := fmt.Sprintf("%s.png", entryID)
	fpath := filepath.Join(dataDir, ImagesDirName, filename)
	if err := os.WriteFile(fpath, decoded, 0644); err != nil {
		return "", err
	}
	return fpath, nil
}

// Save file list to disk, return relative path
func saveFilesList(entryID string, filesJSON string) (string, error) {
	if dataDir == "" {
		return "", fmt.Errorf("no data dir")
	}
	filename := fmt.Sprintf("%s.files.json", entryID)
	fpath := filepath.Join(dataDir, FilesDirName, filename)
	if err := os.WriteFile(fpath, []byte(filesJSON), 0644); err != nil {
		return "", err
	}
	return fpath, nil
}

// decodeBase64 attempts to decode base64 string, returns raw bytes
func decodeBase64(s string) ([]byte, error) {
	// Try standard base64
	data, err := base64.StdEncoding.DecodeString(s)
	if err == nil {
		return data, nil
	}
	// Try raw base64
	data, err = base64.RawStdEncoding.DecodeString(s)
	if err == nil {
		return data, nil
	}
	return nil, err
}

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

// BroadcastClipboard sends entry to all connected SSE clients
func BroadcastClipboard(entry ClipboardEntry) {
	pushServer.mu.RLock()
	defer pushServer.mu.RUnlock()
	for deviceID, ch := range pushServer.clients {
		// Don't send to self
		if deviceID == instanceName {
			continue
		}
		select {
		case ch <- entry:
		default:
		}
	}
}

// SSEClient holds a client connection for clipboard push
type SSEClient struct {
	DeviceID string
	Ch       chan ClipboardEntry
}

// PushServer manages SSE client connections
type PushServer struct {
	clients map[string]chan ClipboardEntry
	mu     sync.RWMutex
}

var pushServer *PushServer

func init() {
	pushServer = &PushServer{
		clients: make(map[string]chan ClipboardEntry),
	}
}

// AddPushClient registers a client for clipboard push
func AddPushClient(deviceID string) chan ClipboardEntry {
	ch := make(chan ClipboardEntry, 20)
	pushServer.mu.Lock()
	pushServer.clients[deviceID] = ch
	pushServer.mu.Unlock()
	return ch
}

// RemovePushClient unregisters a client
func RemovePushClient(deviceID string) {
	pushServer.mu.Lock()
	if ch, ok := pushServer.clients[deviceID]; ok {
		close(ch)
		delete(pushServer.clients, deviceID)
	}
	pushServer.mu.Unlock()
}
