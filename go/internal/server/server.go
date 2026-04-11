package server

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
)

//go:embed web
var webAssets embed.FS

func SetupRouter(sharedDir string, readonly bool) *http.ServeMux {
	mux := http.NewServeMux()

	// Text API
	mux.HandleFunc("/api/text", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			handleTextPost(w, r)
		} else {
			http.Error(w, "Method Not Allowed", 405)
		}
	})
	mux.HandleFunc("/api/text/latest", handleTextLatest)

	// File API
	mux.HandleFunc("/api/files", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			handleFileList(sharedDir)(w, r)
		} else {
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

	// Serve embedded web UI
	webRoot, _ := fs.Sub(webAssets, "web")
	mux.Handle("/", http.FileServer(http.FS(webRoot)))

	log.Printf("[Server] Router initialized, shared dir: %s, readonly: %v", sharedDir, readonly)
	return mux
}
