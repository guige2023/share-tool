package server

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// handleFileList returns all files, preferring database metadata when available.
func handleFileList(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		if q != "" && db != nil {
			files, err := searchDBFiles(q)
			if err == nil {
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]any{"files": files})
				return
			}
		}
		// Fallback to filesystem listing
		files, err := listFiles(sharedDir)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"files": files})
	}
}

func searchDBFiles(q string) ([]FileInfo, error) {
	rows, err := db.Query(`
		SELECT id, filename, type, size, tags, starred, updated_at
		FROM files
		WHERE filename LIKE ? OR tags LIKE ?
		ORDER BY updated_at DESC LIMIT 200`,
		"%"+q+"%", "%"+q+"%",
	)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	if err == sql.ErrNoRows || rows == nil {
		return []FileInfo{}, nil
	}
	defer rows.Close()

	var files []FileInfo
	for rows.Next() {
		var id int64
		var filename, typ, tags string
		var size int64
		var starred int
		var updatedAt int64
		if err := rows.Scan(&id, &filename, &typ, &size, &tags, &starred, &updatedAt); err != nil {
			continue
		}
		files = append(files, FileInfo{
			Name:      filename,
			Size:      size,
			CreatedAt: updatedAt,
			UpdatedAt: updatedAt,
			IsDir:     typ == "folder",
			Starred:   starred == 1,
			Tags:      tags,
		})
	}
	return files, rows.Err()
}

// safeRelPath extracts and validates a safe relative path from the URL path.
// It strips the /api/files/ prefix and returns the rest, ensuring:
//   - No path traversal (no ".." components)
//   - No absolute paths
//   - No files outside sharedDir
//   - No filenames starting with "-" (would create hidden files)
//   - No reserved route names as the final component
//
// Returns "" if the path is unsafe.
func safeRelPath(urlPath string) string {
	// Strip /api/files/ prefix (API route: /api/files/...)
	const prefix = "/api/files/"
	if !strings.HasPrefix(urlPath, prefix) {
		return ""
	}
	rel := strings.TrimPrefix(urlPath, prefix)
	// Must not be empty
	if rel == "" {
		return ""
	}
	// Must not contain path traversal
	if strings.Contains(rel, "..") {
		return ""
	}
	// Must not be an absolute path
	if strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, ".") {
		return ""
	}
	// Each component must not start with "-"
	parts := strings.Split(rel, "/")
	for _, part := range parts {
		if strings.HasPrefix(part, "-") {
			return ""
		}
	}
	// Final component must not be a reserved route name
	last := parts[len(parts)-1]
	if last == "files" || last == "text" || last == "api" {
		return ""
	}
	return rel
}

// handleFileUpload handles multipart file upload (HTML form submission).
// The file is saved to the shared directory. Subdirectories are supported
// via the "path" form field: <input type="hidden" name="path" value="subdir/">
// If path is omitted, file goes to the root of sharedDir.
func handleFileUpload(sharedDir string, maxSize int64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", 405)
			return
		}
		if err := r.ParseMultipartForm(maxSize); err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"upload too large or parse error: %v"}`, err), 400)
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			http.Error(w, `{"error":"no file in form (need <input name=\"file\" type=\"file\">)"}`, 400)
			return
		}
		defer file.Close()

		// Determine target subdirectory from form field "path"
		subDir := strings.TrimSpace(r.FormValue("path"))
		relPath := subDir

		// Sanitize: reject path traversal, absolute paths, hidden files
		if strings.Contains(relPath, "..") || strings.HasPrefix(relPath, "/") ||
			strings.HasPrefix(relPath, ".") || strings.HasPrefix(relPath, "-") {
			http.Error(w, `{"error":"invalid path"}`, 400)
			return
		}

		filename := header.Filename
		// Final filename safety check
		if strings.HasPrefix(filename, "-") || filename == "files" ||
			filename == "text" || filename == "api" || filename == "" {
			http.Error(w, `{"error":"invalid filename"}`, 400)
			return
		}

		if relPath != "" {
			relPath = relPath + "/" + filename
		} else {
			relPath = filename
		}

		fpath := filepath.Join(sharedDir, relPath)
		if err := os.MkdirAll(filepath.Dir(fpath), 0755); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}

		dst, err := os.Create(fpath)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer dst.Close()

		written, err := io.Copy(dst, file)
		if err != nil {
			os.Remove(fpath)
			http.Error(w, err.Error(), 500)
			return
		}

		fi, _ := os.Stat(fpath)
		// Write to database if available
		if db != nil {
			db.Exec(`INSERT OR REPLACE INTO files (filename, type, size, created_at, updated_at) VALUES (?, ?, ?, unixepoch(), unixepoch())`,
				relPath, "file", fi.Size())
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"success":  true,
			"name":     filename,
			"size":     fi.Size(),
			"written":  written,
			"path":     relPath,
			"message":  fmt.Sprintf("saved to %s", relPath),
		})
	}
}

// handleFilePut handles file upload with Content-Range for resume support.
// Supports subdirectories: PUT /files/subdir/document.pdf creates subdir if needed.
func handleFilePut(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.Error(w, "Method Not Allowed", 405)
			return
		}

		rel := safeRelPath(r.URL.Path)
		if rel == "" {
			http.Error(w, `{"error":"invalid filename"}`, 400)
			return
		}
		fpath := filepath.Join(sharedDir, rel)

		// Create parent directories if they don't exist
		if err := os.MkdirAll(filepath.Dir(fpath), 0755); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}

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
		if db != nil {
			db.Exec(`INSERT OR REPLACE INTO files (filename, type, size, created_at, updated_at) VALUES (?, ?, ?, unixepoch(), unixepoch())`,
				rel, "file", fi.Size())
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"size":    fi.Size(),
			"written": written,
			"path":    rel,
		})
	}
}

// handleFileGet serves a file with Range support via http.ServeContent.
// Supports subdirectories: GET /files/subdir/document.pdf serves the correct file.
func handleFileGet(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Method Not Allowed", 405)
			return
		}

		rel := safeRelPath(r.URL.Path)
		if rel == "" {
			http.Error(w, `{"error":"invalid filename"}`, 400)
			return
		}
		fpath := filepath.Join(sharedDir, rel)

		http.ServeFile(w, r, fpath)
	}
}

// handleFileDelete removes a file (optionally in a subdirectory)
func handleFileDelete(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			http.Error(w, "Method Not Allowed", 405)
			return
		}

		rel := safeRelPath(r.URL.Path)
		if rel == "" {
			http.Error(w, `{"error":"invalid filename"}`, 400)
			return
		}
		fpath := filepath.Join(sharedDir, rel)
		if err := os.Remove(fpath); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if db != nil {
			db.Exec("DELETE FROM files WHERE filename = ?", rel)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"success": true})
	}
}

// handleFileBatchDelete removes multiple files at once
func handleFileBatchDelete(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			http.Error(w, "Method Not Allowed", 405)
			return
		}
		var req struct {
			Names []string `json:"names"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid JSON"}`, 400)
			return
		}
		if len(req.Names) == 0 {
			http.Error(w, `{"error":"names array is empty"}`, 400)
			return
		}

		var deleted, failed int
		var errs []string
		for _, name := range req.Names {
			rel := safeRelPath("/api/files/" + name)
			if rel == "" {
				failed++
				errs = append(errs, "unsafe name: "+name)
				continue
			}
			fpath := filepath.Join(sharedDir, rel)
			if err := os.Remove(fpath); err != nil {
				failed++
				errs = append(errs, name+": "+err.Error())
			} else {
				deleted++
				if db != nil {
					db.Exec("DELETE FROM files WHERE filename = ?", rel)
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"success": failed == 0,
			"deleted": deleted,
			"failed":  failed,
			"errors":  errs,
		})
	}
}

// listFiles returns top-level files in dir (non-recursive).
// Returns subdirectories as entries with IsDir=true so the frontend can navigate.
func listFiles(dir string) ([]FileInfo, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	files := make([]FileInfo, 0)
	for _, e := range entries {
		fi, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, FileInfo{
			Name:      e.Name(),
			Size:      fi.Size(),
			CreatedAt: fi.ModTime().UnixMilli(),
			UpdatedAt: fi.ModTime().UnixMilli(),
			IsDir:     e.IsDir(),
		})
	}
	// sort: dirs first, then by UpdatedAt descending
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
	IsDir     bool   `json:"isDir,omitempty"`
	Starred   bool   `json:"starred,omitempty"`
	Tags      string `json:"tags,omitempty"`
}
