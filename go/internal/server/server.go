package server

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"strings"

	"github.com/skip2/go-qrcode"
)

//go:embed all:web
var webAssets embed.FS

// rawMux is a custom HTTP router that checks the raw request URI for path
// traversal BEFORE Go's default mux cleans the path. This prevents the 301
// redirect noise that would otherwise leak file system information.
type rawMux struct {
	patterns []struct {
		prefix string
		handler http.HandlerFunc
	}
	defaultHandler http.Handler
}

func newRawMux() *rawMux { return &rawMux{} }

func (m *rawMux) HandleFunc(pattern string, handler http.HandlerFunc) {
	m.patterns = append(m.patterns, struct {
		prefix   string
		handler  http.HandlerFunc
	}{pattern, handler})
}

func (m *rawMux) SetDefault(handler http.Handler) {
	m.defaultHandler = handler
}

func (m *rawMux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	uri := r.RequestURI

	// CRITICAL: reject path traversal BEFORE any routing or redirect.
	// Go's HTTP server cleans the URL.Path during parsing, but the original
	// request line may contain raw ".." that we can catch via RequestURI.
	if strings.Contains(uri, "..") || strings.Contains(uri, "%2e%2e") || strings.Contains(uri, "%2E%2E") {
		http.Error(w, `{"error":"path traversal not allowed"}`, 400)
		return
	}

	// Manual prefix-based routing.
	// Patterns are checked in order; longer/more specific prefixes first.
	path := r.URL.Path
	for _, p := range m.patterns {
		if hasPrefix(path, p.prefix) {
			p.handler(w, r)
			return
		}
	}
	if m.defaultHandler != nil {
		m.defaultHandler.ServeHTTP(w, r)
	} else {
		http.NotFound(w, r)
	}
}

// hasPrefix returns true if path starts with prefix.
// For prefixes ending in "/" (e.g., "/api/files/"), also matches sub-paths
// like "/api/files/foo" but NOT the exact "/api/files" alone.
// For prefixes NOT ending in "/" (e.g., "/api/files"), requires exact match.
func hasPrefix(path, prefix string) bool {
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	if strings.HasSuffix(prefix, "/") {
		// "/api/files/" matches "/api/files/foo", not "/api/files" alone
		return len(path) > len(prefix)
	}
	// "/api/files" matches only exact "/api/files"
	if len(path) == len(prefix) {
		return true // exact match
	}
	return false // prefix without trailing slash does NOT match sub-paths
}

// SecurityMiddleware is kept for defense-in-depth but is no longer
// the primary path traversal defense (rawMux handles it).
func SecurityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uri := r.RequestURI
		if strings.Contains(uri, "..") || strings.Contains(uri, "%2e%2e") || strings.Contains(uri, "%2E%2E") {
			http.Error(w, `{"error":"path traversal not allowed"}`, 400)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func SetupRouter(sharedDir string, readonly bool) http.Handler {
	mux := newRawMux()

	// Health check
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok","version":"1.0.0"}`))
	})

	// Text API — history
	mux.HandleFunc("/api/text", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleTextList(w, r)
		case http.MethodPost:
			handleTextPost(w, r)
		case http.MethodDelete:
			handleTextDelete(w, r)
		default:
			http.Error(w, "Method Not Allowed", 405)
		}
	})

	// Upload endpoint (multipart form, used by the web UI)
	mux.HandleFunc("/api/upload", func(w http.ResponseWriter, r *http.Request) {
		handleFileUpload(sharedDir, 100*1024*1024)(w, r)
	})

	// File API
	mux.HandleFunc("/api/files", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleFileList(sharedDir)(w, r)
		case http.MethodDelete:
			handleFileBatchDelete(sharedDir)(w, r)
		default:
			http.Error(w, "Method Not Allowed", 405)
		}
	})

	// Dynamic file routes using pattern matching
	mux.HandleFunc("/api/files/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch r.Method {
		case http.MethodPut:
			if readonly {
				http.Error(w, `{"error":"server is in readonly mode"}`, 403)
				return
			}
			handleFilePut(sharedDir)(w, r)
		case http.MethodGet:
			handleFileGet(sharedDir)(w, r)
		case http.MethodDelete:
			if readonly {
				http.Error(w, `{"error":"server is in readonly mode"}`, 403)
				return
			}
			handleFileDelete(sharedDir)(w, r)
		case http.MethodHead:
			handleFileGet(sharedDir)(w, r)
		default:
			http.Error(w, "Method Not Allowed", 405)
		}
		_ = path // unused, kept for clarity
	})

	// Peers API
	mux.HandleFunc("/api/peers", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handlePeersList(w, r)
		case http.MethodPost:
			handlePeersRegister(w, r)
		case http.MethodDelete:
			handlePeersRemove(w, r)
		default:
			http.Error(w, "Method Not Allowed", 405)
		}
	})

	// QR Code endpoint - generates PNG QR code for the given URL
	mux.HandleFunc("/api/qr", func(w http.ResponseWriter, r *http.Request) {
		urlStr := r.URL.Query().Get("url")
		if urlStr == "" {
			http.Error(w, `{"error":"missing url parameter"}`, 400)
			return
		}
		png, err := qrcode.Encode(urlStr, qrcode.Medium, 256)
		if err != nil {
			http.Error(w, `{"error":"failed to generate QR code"}`, 500)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=300")
		w.Write(png)
	})

	// Clipboard API
	mux.HandleFunc("/api/clipboard", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleClipboardHistory(w, r)
		case http.MethodPost:
			handleClipboardPost(w, r)
		case http.MethodDelete:
			handleClipboardDelete(w, r)
		default:
			http.Error(w, "Method Not Allowed", 405)
		}
	})

	// Clipboard receive (from peers - no forwarding)
	mux.HandleFunc("/api/clipboard/receive", func(w http.ResponseWriter, r *http.Request) {
		handleClipboardReceive(w, r)
	})

	// Clipboard latest
	mux.HandleFunc("/api/clipboard/latest", func(w http.ResponseWriter, r *http.Request) {
		handleClipboardLatest(w, r)
	})

	// Clipboard file (serve stored images/files)
	mux.HandleFunc("/api/clipboard/file", func(w http.ResponseWriter, r *http.Request) {
		handleClipboardFile(w, r)
	})

	// Clipboard push via SSE
	mux.HandleFunc("/api/push", handlePush)

	// Blob upload/download
	mux.HandleFunc("/api/blobs", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			handleBlobUpload(w, r)
		case http.MethodGet:
			handleBlobGet(w, r)
		default:
			http.Error(w, "Method Not Allowed", 405)
		}
	})

	// Blob download (zip multi-blob)
	mux.HandleFunc("/api/blobs/download", handleBlobsDownload)

	// Upload session API
	mux.HandleFunc("/api/uploads", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			handleUploadCreate(w, r)
		default:
			http.Error(w, "Method Not Allowed", 405)
		}
	})

	// Upload session status / cancel
	mux.HandleFunc("/api/uploads/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if strings.HasSuffix(path, "/status") {
			if r.Method == http.MethodGet {
				handleUploadStatus(w, r)
			} else {
				http.Error(w, "Method Not Allowed", 405)
			}
			return
		}
		if strings.HasSuffix(path, "/complete") {
			if r.Method == http.MethodPost {
				handleUploadComplete(w, r)
			} else {
				http.Error(w, "Method Not Allowed", 405)
			}
			return
		}
		if strings.HasPrefix(path, "/api/uploads/") && r.Method == http.MethodDelete {
			handleUploadCancel(w, r)
			return
		}
		// Chunk upload: /api/uploads/{id}/chunks/{index}
		if strings.Contains(path, "/chunks/") && r.Method == http.MethodPut {
			handleUploadChunk(w, r)
			return
		}
		http.Error(w, "Not Found", 404)
	})

	// AI Integration endpoints
	mux.HandleFunc("/openapi.json", HandleOpenAPI)
	mux.HandleFunc("/tools.json", HandleTools)

	// Serve embedded web UI with SPA fallback
	webRoot, _ := fs.Sub(webAssets, "web")
	httpFS := http.FS(webRoot)
	fallback := serveIndexFallback(httpFS)

	// Custom handler: serve static files if they exist, otherwise fallback to index.html (SPA)
	webHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		// Try to open the file
		f, err := httpFS.Open(path)
		if err == nil {
			fi, err := f.Stat()
			f.Close()
			if err == nil && !fi.IsDir() {
				// File exists and is not a directory — serve it
				http.FileServer(httpFS).ServeHTTP(w, r)
				return
			}
		}
		// Fallback: serve index.html for SPA routing
		fallback.ServeHTTP(w, r)
	})

	// Default handler serves web UI with SPA fallback
	mux.SetDefault(rejectPathTraversal(webHandler, fallback))

	log.Printf("[Server] Router initialized, shared dir: %s, readonly: %v", sharedDir, readonly)
	return mux
}

// WrapWithCORS returns the given handler with CORS middleware applied.
func WrapWithCORS(h http.Handler) http.Handler {
	return corsMiddleware(h)
}

// corsMiddleware wraps a handler and adds CORS headers for API routes
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Range, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// rejectPathTraversal rejects any request with path traversal attempts.
// Go's mux cleans paths before routing (path.Clean), so the resolved URL.Path
// is always clean. However, the original URI may contain encoded or unencoded
// ".." that was cleaned away. We check RequestURI to catch these before
// Go's mux redirect (301) exposes file system access to the browser.
func rejectPathTraversal(handler, on404 http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uri := r.RequestURI
		// Check for ".." in any form: raw, URL-encoded (lowercase and uppercase)
		if strings.Contains(uri, "..") || strings.Contains(uri, "%2e%2e") || strings.Contains(uri, "%2E%2E") {
			http.Error(w, `{"error":"path traversal not allowed"}`, 400)
			return
		}
		handler.ServeHTTP(w, r)
	})
}

func serveIndexFallback(files http.FileSystem) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Only fallback for browser navigation (HTML requests)
		if !strings.Contains(r.Header.Get("Accept"), "text/html") {
			http.NotFound(w, r)
			return
		}

		index, err := files.Open("index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer index.Close()

		stat, err := index.Stat()
		if err != nil {
			http.NotFound(w, r)
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		http.ServeContent(w, r, stat.Name(), stat.ModTime(), index)
	}
}
