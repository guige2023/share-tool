package server

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	BlobsDirName     = "blobs"
	SmallImageMaxLen = 512 * 1024 // 512KB: below this, embed base64 directly
)

// BlobInfo describes a stored blob
type BlobInfo struct {
	ID      string `json:"id"`      // SHA256 hex prefix (8 chars)
	SHA256  string `json:"sha256"` // full SHA256
	Size    int64  `json:"size"`
	Mime    string `json:"mime"`
	Path    string `json:"path"`    // relative path within blobs dir
	Created int64  `json:"created"` // unix timestamp
}

var (
	blobStore *BlobStore
)

// BlobStore manages blob storage
type BlobStore struct {
	dir   string
	index map[string]*BlobInfo // id -> info (id is first 8 of sha256)
	mu    sync.RWMutex
}

// InitBlobStore creates/fetches the blob store singleton
func InitBlobStore(dataDir string) error {
	if dataDir == "" {
		return fmt.Errorf("no data dir")
	}
	blobDir := filepath.Join(dataDir, BlobsDirName)
	if err := os.MkdirAll(blobDir, 0755); err != nil {
		return err
	}
	blobStore = &BlobStore{
		dir:   blobDir,
		index: make(map[string]*BlobInfo),
	}
	blobStore.rebuildIndex()
	return nil
}

// rebuildIndex scans the blobs directory and rebuilds the in-memory index
func (bs *BlobStore) rebuildIndex() {
	bs.mu.Lock()
	defer bs.mu.Unlock()
	bs.index = make(map[string]*BlobInfo)
	entries, err := os.ReadDir(bs.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			sub, _ := os.ReadDir(filepath.Join(bs.dir, e.Name()))
			for _, se := range sub {
				if !se.IsDir() {
					bs.loadBlobInfo(filepath.Join(bs.dir, e.Name(), se.Name()))
				}
			}
		} else {
			bs.loadBlobInfo(filepath.Join(bs.dir, e.Name()))
		}
	}
}

func (bs *BlobStore) loadBlobInfo(path string) {
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	if info.IsDir() {
		return
	}
	name := filepath.Base(path)
	// blobs are stored as: <first8>/<sha256_full> where name IS the full SHA256 (64 hex chars)
	sha256hex := name
	if len(sha256hex) < 64 {
		// Old format: skip it
		return
	}
	id := sha256hex[:8]
	relPath, _ := filepath.Rel(bs.dir, path)
	bs.index[id] = &BlobInfo{
		ID:     id,
		SHA256: sha256hex,
		Size:   info.Size(),
		Path:   relPath,
	}
}

// Save stores data as a blob and returns id, sha256, and error
func (bs *BlobStore) Save(id string, data []byte, mime string) (string, string, error) {
	hash := sha256.Sum256(data)
	hashHex := hex.EncodeToString(hash[:])
	idPrefix := hashHex[:8]

	// Check if already exists
	bs.mu.RLock()
	if existing, ok := bs.index[idPrefix]; ok && existing.SHA256 == hashHex {
		bs.mu.RUnlock()
		return existing.ID, existing.SHA256, nil // already exists
	}
	bs.mu.RUnlock()

	// Store: <first8>/<sha256_full>
	subDir := filepath.Join(bs.dir, idPrefix)
	if err := os.MkdirAll(subDir, 0755); err != nil {
		return "", "", err
	}
	filename := hashHex // Use full SHA256 as filename
	fpath := filepath.Join(subDir, filename)
	if err := os.WriteFile(fpath, data, 0644); err != nil {
		return "", "", err
	}

	info := &BlobInfo{
		ID:      idPrefix,
		SHA256:  hashHex,
		Size:    int64(len(data)),
		Mime:    mime,
		Path:    filepath.Join(BlobsDirName, idPrefix, filename),
		Created: nowUnix(),
	}

	bs.mu.Lock()
	bs.index[idPrefix] = info
	bs.mu.Unlock()

	return idPrefix, hashHex, nil
}

// Get returns blob data by id prefix
func (bs *BlobStore) Get(id string) ([]byte, *BlobInfo, error) {
	bs.mu.RLock()
	info, ok := bs.index[id]
	bs.mu.RUnlock()
	if !ok {
		return nil, nil, fmt.Errorf("blob not found")
	}
	fpath := filepath.Join(bs.dir, info.Path)
	data, err := os.ReadFile(fpath)
	if err != nil {
		return nil, nil, err
	}
	return data, info, nil
}

// HandleBlobUpload handles POST /api/blobs — upload a blob
func handleBlobUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	if r.ContentLength > MaxClipboardFilesSize {
		http.Error(w, `{"error":"blob too large"}`, 413)
		return
	}

	blobID := r.URL.Query().Get("id")
	if blobID == "" {
		http.Error(w, `{"error":"missing id"}`, 400)
		return
	}
	mime := r.Header.Get("Content-Type")
	if mime == "" {
		mime = "application/octet-stream"
	}

	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"failed to read body"}`, 400)
		return
	}

	id, sha256, err := blobStore.Save(blobID, data, mime)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%v"}`, err), 500)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"id":"%s","sha256":"%s","size":%d}`, id, sha256, len(data))
}

// HandleBlobGet serves blob data by id
func handleBlobGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	id := r.URL.Query().Get("id")
	if id == "" {
		// Try to get from path
		id = filepath.Base(r.URL.Path)
	}

	data, info, err := blobStore.Get(id)
	if err != nil {
		http.Error(w, `{"error":"blob not found"}`, 404)
		return
	}

	if info.Mime != "" {
		w.Header().Set("Content-Type", info.Mime)
	}
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(data)))
	w.Header().Set("X-SHA256", info.SHA256)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write(data)
}

func nowUnix() int64 {
	return int64(time.Now().Unix())
}
