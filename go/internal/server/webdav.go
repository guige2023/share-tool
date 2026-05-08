package server

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// WebDAVHandler handles WebDAV requests at /dav/*
func WebDAVHandler(sharedDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if !strings.HasPrefix(path, "/dav") {
			http.NotFound(w, r)
			return
		}

		// Strip /dav prefix
		relPath := strings.TrimPrefix(path, "/dav")
		if relPath == "" {
			relPath = "/"
		}

		// Normalize path
		relPath = filepath.Clean(relPath)
		if relPath == "." {
			relPath = "/"
		}

		// CORS headers for WebDAV
		w.Header().Set("DAV", "1")
		w.Header().Set("MS-Author-Via", "DAV")

		switch r.Method {
		case "OPTIONS":
			handleDavOptions(w, r)
		case "PROPFIND":
			handlePropFind(w, r, relPath, sharedDir)
		case "GET":
			handleDavGet(w, r, relPath, sharedDir)
		case "PUT":
			handleDavPut(w, r, relPath, sharedDir)
		case "DELETE":
			handleDavDelete(w, r, relPath, sharedDir)
		case "MKCOL":
			handleDavMkcol(w, r, relPath, sharedDir)
		case "PROPPATCH":
			handleDavPropPatch(w, r, relPath)
		case "MOVE":
			handleDavMove(w, r, relPath, sharedDir)
		case "COPY":
			handleDavCopy(w, r, relPath, sharedDir)
		default:
			w.Header().Set("Allow", "OPTIONS, PROPFIND, GET, PUT, DELETE, MKCOL, PROPPATCH, MOVE, COPY")
			http.Error(w, "Method Not Allowed", 405)
		}
	}
}

func handleDavOptions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Allow", "OPTIONS, PROPFIND, GET, PUT, DELETE, MKCOL, PROPPATCH, MOVE, COPY")
	w.Header().Set("DAV", "1")
	w.WriteHeader(200)
}

func handlePropFind(w http.ResponseWriter, r *http.Request, relPath, sharedDir string) {
	depth := r.Header.Get("Depth")
	if depth == "" {
		depth = "1"
	}

	var reqBody string
	if r.Body != nil {
		body, _ := io.ReadAll(r.Body)
		reqBody = string(body)
	}

	// Get files
	items := []davItem{}

	if relPath == "/" {
		// Root: list all top-level files and folders
		entries, err := os.ReadDir(sharedDir)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		for _, e := range entries {
			fi, err := e.Info()
			if err != nil {
				continue
			}
			items = append(items, davItem{
				Filename:  e.Name(),
				Size:     fi.Size(),
				IsDir:    e.IsDir(),
				Created:  fi.ModTime().Unix(),
				Modified: fi.ModTime().Unix(),
			})
		}
	} else {
		fullPath := filepath.Join(sharedDir, relPath)
		fi, err := os.Stat(fullPath)
		if err != nil {
			if os.IsNotExist(err) {
				http.Error(w, "Not Found", 404)
				return
			}
			http.Error(w, err.Error(), 500)
			return
		}
		if fi.IsDir() {
			entries, err := os.ReadDir(fullPath)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			for _, e := range entries {
				info, err := e.Info()
				if err != nil {
					continue
				}
				items = append(items, davItem{
					Filename:  e.Name(),
					Size:     info.Size(),
					IsDir:    e.IsDir(),
					Created:  info.ModTime().Unix(),
					Modified: info.ModTime().Unix(),
				})
			}
		} else {
			items = append(items, davItem{
				Filename:  filepath.Base(relPath),
				Size:     fi.Size(),
				IsDir:    false,
				Created:  fi.ModTime().Unix(),
				Modified: fi.ModTime().Unix(),
			})
		}
	}

	// Check if property names were requested
	propNamesOnly := false
	if strings.Contains(reqBody, "propname") {
		propNamesOnly = true
	}

	xml := buildPropFindResponse(items, relPath, propNamesOnly)
	sendDavXML(w, 207, xml)
}

type davItem struct {
	Filename  string
	Size     int64
	IsDir    bool
	Created  int64
	Modified int64
}

func buildPropFindResponse(items []davItem, basePath string, propNamesOnly bool) string {
	var responses []string
	for _, item := range items {
		href := "/dav" + basePath
		if !strings.HasSuffix(href, "/") && href != "/dav" {
			href = href + "/"
		}
		if item.Filename != "" {
			href = href + xmlEscape(item.Filename)
		}

		var props string
		if propNamesOnly {
			props = `<d:prop><d:displayname/><d:getcontentlength/><d:getcontenttype/><d:resourcetype/><d:creationdate/><d:getlastmodified/></d:prop>`
		} else {
			ct := "application/octet-stream"
			if item.IsDir {
				ct = "httpd/unix-directory"
			} else {
				ct = mimeType(item.Filename)
			}
			created := time.Unix(item.Created, 0).Format(time.RFC3339)
			modified := time.Unix(item.Modified, 0).Format(http.TimeFormat)
			resourcetype := ""
			if item.IsDir {
				resourcetype = "<d:collection/>"
			}
			props = fmt.Sprintf(`<d:prop>
<d:displayname>%s</d:displayname>
<d:getcontentlength>%d</d:getcontentlength>
<d:getcontenttype>%s</d:getcontenttype>
<d:resourcetype>%s</d:resourcetype>
<d:creationdate>%s</d:creationdate>
<d:getlastmodified>%s</d:getlastmodified>
</d:prop>`, xmlEscape(item.Filename), item.Size, xmlEscape(ct), resourcetype, created, modified)
		}

		responses = append(responses, fmt.Sprintf(`<d:response>
<d:href>%s</d:href>
<d:propstat>
<d:prop>%s</d:prop>
<d:status>HTTP/1.1 200 OK</d:status>
</d:propstat>
</d:response>`, href, props))
	}

	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
%s
</d:multistatus>`, strings.Join(responses, "\n"))
}

func handleDavGet(w http.ResponseWriter, r *http.Request, relPath, sharedDir string) {
	if relPath == "/" {
		// Return root collection
		handlePropFind(w, r, "/", sharedDir)
		return
	}
	fullPath := filepath.Join(sharedDir, relPath)
	fi, err := os.Stat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Not Found", 404)
			return
		}
		http.Error(w, err.Error(), 500)
		return
	}
	if fi.IsDir() {
		handlePropFind(w, r, relPath, sharedDir)
		return
	}
	http.ServeFile(w, r, fullPath)
}

func handleDavPut(w http.ResponseWriter, r *http.Request, relPath, sharedDir string) {
	if relPath == "/" {
		http.Error(w, "Cannot PUT to root", 403)
		return
	}
	fullPath := filepath.Join(sharedDir, relPath)

	// Create parent directories
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	// Read body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	// Write file
	if err := os.WriteFile(fullPath, body, 0644); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	w.WriteHeader(201)
}

func handleDavDelete(w http.ResponseWriter, r *http.Request, relPath, sharedDir string) {
	if relPath == "/" {
		http.Error(w, "Cannot DELETE root", 403)
		return
	}
	fullPath := filepath.Join(sharedDir, relPath)

	fi, err := os.Stat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Not Found", 404)
			return
		}
		http.Error(w, err.Error(), 500)
		return
	}

	if fi.IsDir() {
		os.RemoveAll(fullPath)
	} else {
		os.Remove(fullPath)
	}

	w.WriteHeader(204)
}

func handleDavMkcol(w http.ResponseWriter, r *http.Request, relPath, sharedDir string) {
	if relPath == "/" {
		http.Error(w, "Cannot MKCOL root", 403)
		return
	}
	fullPath := filepath.Join(sharedDir, relPath)

	// Check if already exists
	if _, err := os.Stat(fullPath); err == nil {
		http.Error(w, "Already Exists", 405)
		return
	}

	if err := os.MkdirAll(fullPath, 0755); err != nil {
		http.Error(w, err.Error(), 405)
		return
	}

	w.WriteHeader(201)
}

func handleDavPropPatch(w http.ResponseWriter, r *http.Request, relPath string) {
	// We don't support property modifications
	w.WriteHeader(200)
}

func handleDavMove(w http.ResponseWriter, r *http.Request, relPath, sharedDir string) {
	if relPath == "/" {
		http.Error(w, "Cannot MOVE root", 403)
		return
	}

	dest := r.Header.Get("Destination")
	if dest == "" {
		http.Error(w, "Destination required", 400)
		return
	}

	// Parse destination (strip /dav prefix)
	destPath := strings.TrimPrefix(dest, "/dav")
	if destPath == "" {
		destPath = "/"
	}
	destPath = filepath.Clean(destPath)

	srcPath := filepath.Join(sharedDir, relPath)
	dstPath := filepath.Join(sharedDir, destPath)

	// Check source exists
	if _, err := os.Stat(srcPath); err != nil {
		http.Error(w, "Not Found", 404)
		return
	}

	// Copy then delete (simple move)
	if err := copyPath(srcPath, dstPath); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	// Delete source
	si, _ := os.Stat(srcPath)
	if si.IsDir() {
		os.RemoveAll(srcPath)
	} else {
		os.Remove(srcPath)
	}

	w.WriteHeader(201)
}

func handleDavCopy(w http.ResponseWriter, r *http.Request, relPath, sharedDir string) {
	if relPath == "/" {
		http.Error(w, "Cannot COPY root", 403)
		return
	}

	dest := r.Header.Get("Destination")
	if dest == "" {
		http.Error(w, "Destination required", 400)
		return
	}

	overwrite := r.Header.Get("Overwrite")
	if overwrite == "F" {
		// Check if destination exists
		destPath := filepath.Join(sharedDir, strings.TrimPrefix(strings.TrimPrefix(dest, "/dav"), "/"))
		if _, err := os.Stat(destPath); err == nil {
			http.Error(w, "Precondition Failed", 412)
			return
		}
	}

	destPath := filepath.Join(sharedDir, strings.TrimPrefix(dest, "/dav"))
	srcPath := filepath.Join(sharedDir, relPath)

	if err := copyPath(srcPath, destPath); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	w.WriteHeader(201)
}

func copyPath(src, dst string) error {
	srcFi, err := os.Stat(src)
	if err != nil {
		return err
	}

	if srcFi.IsDir() {
		if err := os.MkdirAll(dst, 0755); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := copyPath(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
				return err
			}
		}
		return nil
	}

	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0644)
}

func sendDavXML(w http.ResponseWriter, status int, xml string) {
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("DAV", "1")
	w.WriteHeader(status)
	w.Write([]byte(xml))
}

func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	return s
}

func mimeType(filename string) string {
	ext := ""
	if i := strings.LastIndex(filename, "."); i >= 0 {
		ext = strings.ToLower(filename[i+1:])
	}
	switch ext {
	case "txt", "text": return "text/plain"
	case "html", "htm": return "text/html"
	case "css": return "text/css"
	case "js": return "application/javascript"
	case "json": return "application/json"
	case "xml": return "application/xml"
	case "pdf": return "application/pdf"
	case "zip": return "application/zip"
	case "gz", "gzip": return "application/gzip"
	case "tar": return "application/x-tar"
	case "png": return "image/png"
	case "jpg", "jpeg": return "image/jpeg"
	case "gif": return "image/gif"
	case "svg": return "image/svg+xml"
	case "webp": return "image/webp"
	case "mp4": return "video/mp4"
	case "mp3": return "audio/mpeg"
	case "wav": return "audio/wav"
	case "doc": return "application/msword"
	case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case "xls": return "application/vnd.ms-excel"
	case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	default: return "application/octet-stream"
	}
}

// DAVContext holds WebDAV request context for parsing XML bodies
type DavPropFind struct {
	XMLName xml.Name `xml:"propfind"`
	Prop    string  `xml:"prop>propname"`
}
