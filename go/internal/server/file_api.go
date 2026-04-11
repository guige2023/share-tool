package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// handleFileList returns all files in the shared directory
func handleFileList(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		files, err := listFiles(sharedDir)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"files": files})
	}
}

// safeName extracts a safe filename from the URL path.
// Returns empty string if the name is unsafe (empty, contains path separators,
// path traversal, or collides with reserved API route names).
func safeName(path string) string {
	// CRITICAL: check raw path for path traversal BEFORE filepath.Base cleans it
	if strings.Contains(path, "..") {
		return ""
	}
	name := filepath.Base(path)
	if name == "" || name == "." || name == "/" {
		return ""
	}
	// Reject names that would create files outside sharedDir
	if name[0] == '-' {
		return ""
	}
	// Reject reserved API route names to prevent path collision
	if name == "files" || name == "text" || name == "api" {
		return ""
	}
	return name
}

// handleFilePut handles file upload with Content-Range for resume support
func handleFilePut(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.Error(w, "Method Not Allowed", 405)
			return
		}

		name := safeName(r.URL.Path)
		if name == "" {
			http.Error(w, `{"error":"invalid filename"}`, 400)
			return
		}
		fpath := filepath.Join(sharedDir, name)

		offset := int64(0)
		cr := r.Header.Get("Content-Range")
		if cr != "" {
			// Format: "bytes START-END/TOTAL"
			if strings.HasPrefix(cr, "bytes ") {
				parts := strings.Split(strings.TrimPrefix(cr, "bytes "), "-")
				if len(parts) == 2 {
					fmt.Sscanf(parts[0], "%d", &offset)
				}
			}
		}

		var f *os.File
		var err error
		if offset > 0 {
			f, err = os.OpenFile(fpath, os.O_CREATE|os.O_WRONLY, 0644)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			if _, err := f.Seek(offset, io.SeekStart); err != nil {
				f.Close()
				http.Error(w, err.Error(), 500)
				return
			}
		} else {
			f, err = os.Create(fpath)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
		}

		written, err := io.Copy(f, r.Body)
		f.Close()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}

		fi, _ := os.Stat(fpath)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"size":    fi.Size(),
			"written": written,
		})
	}
}

// handleFileGet serves a file with Range support via http.ServeContent
func handleFileGet(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Method Not Allowed", 405)
			return
		}

		name := safeName(r.URL.Path)
		if name == "" {
			http.Error(w, `{"error":"invalid filename"}`, 400)
			return
		}
		fpath := filepath.Join(sharedDir, name)

		// http.ServeFile handles HEAD method correctly and adds Content-Type
		http.ServeFile(w, r, fpath)
	}
}

// handleFileDelete removes a file
func handleFileDelete(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			http.Error(w, "Method Not Allowed", 405)
			return
		}

		name := safeName(r.URL.Path)
		if name == "" {
			http.Error(w, `{"error":"invalid filename"}`, 400)
			return
		}
		fpath := filepath.Join(sharedDir, name)
		if err := os.Remove(fpath); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"success": true})
	}
}

func listFiles(dir string) ([]FileInfo, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	files := make([]FileInfo, 0)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, FileInfo{
			Name:      e.Name(),
			Size:      fi.Size(),
			CreatedAt: fi.ModTime().UnixMilli(),
			UpdatedAt: fi.ModTime().UnixMilli(),
		})
	}
	// sort by UpdatedAt descending
	for i := 0; i < len(files)-1; i++ {
		for j := i + 1; j < len(files); j++ {
			if files[j].UpdatedAt > files[i].UpdatedAt {
				files[i], files[j] = files[j], files[i]
			}
		}
	}
	return files, nil
}

type FileInfo struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}
