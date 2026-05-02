package server

import (
	"archive/zip"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ChunkSize is 2MB per chunk for uploads
const ChunkSize = 2 * 1024 * 1024

// UploadSession tracks an in-progress upload with chunk bitmap
type UploadSession struct {
	ID         string         `json:"id"`          // UUID
	Filename   string         `json:"filename"`    // original filename
	TotalSize  int64          `json:"total_size"`   // total file size
	ChunkSize  int64         `json:"chunk_size"`   // chunk size
	ChunkCount int           `json:"chunk_count"`  // total chunks
	Received   int64          `json:"received"`     // bytes received
	ChunkMap   map[int]bool  `json:"chunk_map"`   // bitmap of received chunks
	ChunkHashes map[int]string `json:"chunk_hashes"` // SHA256 per chunk
	TempPath   string         `json:"temp_path"`   // temp file path
	FinalPath  string         `json:"final_path"`  // final path after completion
	CreatedAt  int64          `json:"created_at"`
	UpdatedAt  int64          `json:"updated_at"`
	Status     string         `json:"status"`      // active / completed / failed
	SHA256     string         `json:"sha256"`      // final file SHA256
}

// uploadSessions stores active upload sessions
var uploadSessions = sync.Map{} // sessionID -> *UploadSession

// InitUploadStore initializes the upload session store with a directory
var uploadStoreDir = ""

// SetUploadStoreDir sets the directory for upload temp files
func SetUploadStoreDir(dir string) {
	uploadStoreDir = dir
	os.MkdirAll(dir, 0755)
}

// handleUploadCreate creates a new upload session
// POST /api/uploads
func handleUploadCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	var req struct {
		Filename  string `json:"filename"`
		Size      int64  `json:"size"`
		SHA256    string `json:"sha256,omitempty"`
		ChunkSize int64 `json:"chunk_size,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	if req.Filename == "" || req.Size <= 0 {
		http.Error(w, `{"error":"filename and size required"}`, 400)
		return
	}

	// Sanitize filename
	safeName := filepath.Base(req.Filename)
	if safeName == "" || strings.HasPrefix(safeName, ".") {
		http.Error(w, `{"error":"invalid filename"}`, 400)
		return
	}

	chunkSize := req.ChunkSize
	if chunkSize <= 0 {
		chunkSize = ChunkSize
	}
	chunkCount := int((req.Size + chunkSize - 1) / chunkSize)

	// Create temp file
	sessionID := newUUID()
	tempPath := filepath.Join(uploadStoreDir, "uploads", sessionID+"_"+safeName)
	os.MkdirAll(filepath.Dir(tempPath), 0755)
	f, err := os.Create(tempPath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%v"}`, err), 500)
		return
	}
	f.Close()
	os.Remove(tempPath) // remove, recreate on first chunk

	session := &UploadSession{
		ID:          sessionID,
		Filename:    safeName,
		TotalSize:   req.Size,
		ChunkSize:   chunkSize,
		ChunkCount:  chunkCount,
		Received:    0,
		ChunkMap:    make(map[int]bool, chunkCount),
		ChunkHashes: make(map[int]string, chunkCount),
		TempPath:    tempPath,
		FinalPath:   filepath.Join(uploadStoreDir, "uploads", safeName),
		CreatedAt:   time.Now().UnixMilli(),
		UpdatedAt:   time.Now().UnixMilli(),
		Status:      "active",
	}

	uploadSessions.Store(sessionID, session)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{
		"session_id":   sessionID,
		"chunk_count":   chunkCount,
		"chunk_size":    chunkSize,
		"filename":      safeName,
		"total_size":    req.Size,
	})
}

// handleUploadChunk receives a single chunk
// PUT /api/uploads/:id/chunks/:index
func handleUploadChunk(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	// Parse session ID and chunk index from path
	path := r.URL.Path
	// /api/uploads/{id}/chunks/{index}
	parts := strings.Split(strings.TrimPrefix(path, "/api/uploads/"), "/chunks/")
	if len(parts) != 2 {
		http.Error(w, `{"error":"invalid path"}`, 400)
		return
	}
	sessionID := parts[0]
	chunkIdxStr := parts[1]

	var chunkIdx int
	if _, err := fmt.Sscanf(chunkIdxStr, "%d", &chunkIdx); err != nil {
		http.Error(w, `{"error":"invalid chunk index"}`, 400)
		return
	}

	sessionInt, ok := uploadSessions.Load(sessionID)
	if !ok {
		http.Error(w, `{"error":"session not found"}`, 404)
		return
	}
	session := sessionInt.(*UploadSession)
	if session.Status != "active" {
		http.Error(w, `{"error":"session not active"}`, 400)
		return
	}

	if chunkIdx < 0 || chunkIdx >= session.ChunkCount {
		http.Error(w, `{"error":"chunk index out of range"}`, 400)
		return
	}

	// Read chunk data
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"failed to read chunk"}`, 400)
		return
	}

	if int64(len(data)) > session.ChunkSize {
		http.Error(w, `{"error":"chunk too large"}`, 400)
		return
	}

	// Compute chunk SHA256
	hash := sha256.Sum256(data)
	hashHex := hex.EncodeToString(hash[:])
	chunkHashHeader := r.Header.Get("X-Chunk-SHA256")
	if chunkHashHeader != "" && chunkHashHeader != hashHex {
		http.Error(w, `{"error":"chunk SHA256 mismatch"}`, 400)
		return
	}

	// Verify expected size
	expectedStart := int64(chunkIdx) * session.ChunkSize
	expectedEnd := expectedStart + int64(len(data))
	if expectedEnd > session.TotalSize {
		http.Error(w, `{"error":"chunk exceeds file size"}`, 400)
		return
	}

	// Open temp file for writing at offset
	f, err := os.OpenFile(session.TempPath, os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		// Create the file if it doesn't exist
		f, err = os.Create(session.TempPath)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"%v"}`, err), 500)
			return
		}
	}
	defer f.Close()

	if _, err := f.Seek(expectedStart, io.SeekStart); err != nil {
		http.Error(w, `{"error":"seek failed"}`, 500)
		return
	}
	if _, err := f.Write(data); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%v"}`, err), 500)
		return
	}
	f.Close()

	// Update session
	session.ChunkMap[chunkIdx] = true
	session.ChunkHashes[chunkIdx] = hashHex
	session.Received += int64(len(data))
	session.UpdatedAt = time.Now().UnixMilli()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]any{
		"session_id":  sessionID,
		"chunk_index": chunkIdx,
		"received":    session.Received,
		"chunks_done": len(session.ChunkMap),
		"total_chunks": session.ChunkCount,
	})
}

// handleUploadStatus returns session status for resumption
// GET /api/uploads/:id/status
func handleUploadStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	sessionID := filepath.Base(r.URL.Path)

	sessionInt, ok := uploadSessions.Load(sessionID)
	if !ok {
		http.Error(w, `{"error":"session not found"}`, 404)
		return
	}
	session := sessionInt.(*UploadSession)

	// Build bitmap (sorted indices)
	var doneChunks []int
	for idx := range session.ChunkMap {
		doneChunks = append(doneChunks, idx)
	}
	sort.Ints(doneChunks)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"session_id":   session.ID,
		"filename":     session.Filename,
		"total_size":   session.TotalSize,
		"received":     session.Received,
		"status":       session.Status,
		"chunks_done":  doneChunks,
		"total_chunks": session.ChunkCount,
	})
}

// handleUploadComplete finalizes the upload, verifies SHA256, renames atomically
// POST /api/uploads/:id/complete
func handleUploadComplete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	sessionID := filepath.Base(r.URL.Path)

	sessionInt, ok := uploadSessions.Load(sessionID)
	if !ok {
		http.Error(w, `{"error":"session not found"}`, 404)
		return
	}
	session := sessionInt.(*UploadSession)
	if session.Status != "active" {
		http.Error(w, `{"error":"session not active"}`, 400)
		return
	}

	// Check all chunks received
	if int64(len(session.ChunkMap)) != int64(session.ChunkCount) {
		missing := session.ChunkCount - len(session.ChunkMap)
		http.Error(w, fmt.Sprintf(`{"error":"%d chunks missing"}`, missing), 400)
		return
	}

	// Verify final SHA256
	f, err := os.Open(session.TempPath)
	if err != nil {
		http.Error(w, `{"error":"temp file not found"}`, 500)
		return
	}
	defer f.Close()

	hashWriter := sha256.New()
	if _, err := io.Copy(hashWriter, f); err != nil {
		http.Error(w, `{"error":"SHA256 computation failed"}`, 500)
		return
	}
	finalHash := hex.EncodeToString(hashWriter.Sum(nil))
	session.SHA256 = finalHash

	// Check against expected SHA256 (if provided)
	clientSHA256 := r.Header.Get("X-Final-SHA256")
	if clientSHA256 != "" && clientSHA256 != finalHash {
		session.Status = "failed"
		http.Error(w, `{"error":"SHA256 mismatch"}`, 400)
		return
	}

	// Atomic rename to final path
	// If final path exists, remove it first
	if _, err := os.Stat(session.FinalPath); err == nil {
		os.Remove(session.FinalPath)
	}
	if err := os.Rename(session.TempPath, session.FinalPath); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"atomic rename failed: %v"}`, err), 500)
		return
	}

	session.Status = "completed"
	session.UpdatedAt = time.Now().UnixMilli()

	// Clean up session after a delay
	go func() {
		time.Sleep(5 * time.Minute)
		uploadSessions.Delete(sessionID)
	}()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]any{
		"success":    true,
		"filename":   session.Filename,
		"size":       session.TotalSize,
		"sha256":      finalHash,
		"file_url":    "/api/files/" + session.Filename,
	})
}

// handleUploadCancel cancels and cleans up an upload
// DELETE /api/uploads/:id
func handleUploadCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	sessionID := filepath.Base(r.URL.Path)

	sessionInt, ok := uploadSessions.Load(sessionID)
	if !ok {
		http.Error(w, `{"error":"session not found"}`, 404)
		return
	}
	session := sessionInt.(*UploadSession)

	// Remove temp file
	if session.TempPath != "" {
		os.Remove(session.TempPath)
	}
	uploadSessions.Delete(sessionID)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// handleBlobsDownload downloads multiple blobs as a zip
// GET /api/blobs/download?ids=id1,id2,id3
func handleBlobsDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	idsParam := r.URL.Query().Get("ids")
	if idsParam == "" {
		http.Error(w, `{"error":"ids required"}`, 400)
		return
	}
	ids := strings.Split(idsParam, ",")

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=files.zip")
	w.Header().Set("Transfer-Encoding", "chunked")

	zw := zip.NewWriter(w)
	defer zw.Close()

	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		data, info, err := blobStore.Get(id)
		if err != nil {
			continue
		}

		filename := info.ID
		if info.Mime != "" {
			ext := mimeToExt(info.Mime)
			filename += ext
		}

		header := &zip.FileHeader{
			Name:     filename,
			Method:   zip.Deflate,
			Modified: time.Unix(info.Created/1000, 0),
		}
		writer, err := zw.CreateHeader(header)
		if err != nil {
			continue
		}
		writer.Write(data)
	}
}

func mimeToExt(mime string) string {
	switch mime {
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "application/pdf":
		return ".pdf"
	case "text/plain":
		return ".txt"
	case "application/json":
		return ".json"
	case "application/zip":
		return ".zip"
	default:
		return ""
	}
}

// newUUID generates a random UUID string using crypto/rand
func newUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
