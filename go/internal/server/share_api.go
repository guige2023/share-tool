package server

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/skip2/go-qrcode"
)

// ── Share Link API ─────────────────────────────────────────────────────

func handleShareCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		Filename     string `json:"filename"`
		ExpiryHours  int    `json:"expiryHours"`
		CustomExpiry int64  `json:"customExpiry"`
		MaxDownloads int    `json:"maxDownloads"`
		Password     string `json:"password"`
		IsText       bool   `json:"isText"`
		Description  string `json:"description"`
		ThemeBg      string `json:"themeBg"`
		ThemeColor   string `json:"themeColor"`
		BrandText    string `json:"brandText"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	if req.Filename == "" {
		http.Error(w, `{"error":"filename required"}`, 400)
		return
	}

	expiresAt := int64(0)
	if req.ExpiryHours > 0 {
		expiresAt = time.Now().Add(time.Duration(req.ExpiryHours) * time.Hour).Unix()
	} else if req.CustomExpiry > 0 {
		expiresAt = req.CustomExpiry / 1000
	}

	passwordHash := ""
	if req.Password != "" {
		h := sha256.Sum256([]byte(req.Password))
		passwordHash = hex.EncodeToString(h[:])
	}

	code := generateCode(8)
		_, err := db.Exec(`
		INSERT INTO share_links (code, filename, is_text, password, expires_at, max_downloads, description, theme_color, created_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		code, req.Filename, boolToInt(req.IsText), passwordHash, expiresAt, req.MaxDownloads, req.Description, req.ThemeColor, "",
	)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}

	scheme := "https"
	if r.TLS == nil {
		scheme = "http"
	}
	shareURL := fmt.Sprintf("%s://%s/s/%s", scheme, r.Host, code)

	LogAudit(db, "share_create", req.Filename, clientIP(r), "")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"share": map[string]any{
			"code":       code,
			"url":        shareURL,
			"filename":   req.Filename,
			"expiresAt":  expiresAt * 1000,
			"createdAt":  time.Now().Unix() * 1000,
			"themeColor": req.ThemeColor,
			"description": req.Description,
		},
	})
}

func handleShareList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	rows, err := db.Query(`
		SELECT code, filename, is_text, password, expires_at, max_downloads, download_count, description, label, view_count, theme_color, created_at
		FROM share_links ORDER BY created_at DESC`)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	defer rows.Close()

	shares := []map[string]any{}
	for rows.Next() {
		var code, filename, password, description, label, themeColor sql.NullString
		var expiresAt, maxDownloads, downloadCount, viewCount, createdAt sql.NullInt64
		var isText int
		rows.Scan(&code, &filename, &isText, &password, &expiresAt, &maxDownloads, &downloadCount, &description, &label, &viewCount, &themeColor, &createdAt)

		scheme := "https"
		if r.TLS == nil {
			scheme = "http"
		}
		shareURL := fmt.Sprintf("%s://%s/s/%s", scheme, r.Host, code.String)

		shares = append(shares, map[string]any{
			"code":           code.String,
			"filename":       filename.String,
			"hasPassword":    password.String != "",
			"expiresAt":      expiresAt.Int64 * 1000,
			"createdAt":      createdAt.Int64 * 1000,
			"maxDownloads":   maxDownloads.Int64,
			"downloadCount":  downloadCount.Int64,
			"viewCount":      viewCount.Int64,
			"description":    description.String,
			"themeColor":     themeColor.String,
			"url":            shareURL,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "shares": shares})
}

func handleShareDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	code := strings.TrimPrefix(r.URL.Path, "/api/share/delete/")
	if code == "" {
		http.Error(w, `{"error":"code required"}`, 400)
		return
	}
	_, err := db.Exec("DELETE FROM share_links WHERE code = ?", code)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	LogAudit(db, "share_delete", code, clientIP(r), "")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func handleShareUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	code := strings.TrimPrefix(r.URL.Path, "/api/share/update/")
	if code == "" {
		http.Error(w, `{"error":"code required"}`, 400)
		return
	}
	var req map[string]any
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}

	// Build update query
	updates := []string{}
	args := []any{}
	if v, ok := req["expiresAt"]; ok {
		if v == nil || v.(float64) == 0 {
			updates = append(updates, "expires_at = 0")
		} else {
			updates = append(updates, "expires_at = ?")
			args = append(args, int64(v.(float64))/1000)
		}
	}
	if v, ok := req["maxDownloads"]; ok {
		if v == nil || v.(float64) == 0 {
			updates = append(updates, "max_downloads = NULL")
		} else {
			updates = append(updates, "max_downloads = ?")
			args = append(args, int64(v.(float64)))
		}
	}
	if v, ok := req["password"]; ok {
		if v == nil || v.(string) == "" {
			updates = append(updates, "password = ''")
		} else {
			h := sha256.Sum256([]byte(v.(string)))
			updates = append(updates, "password = ?")
			args = append(args, hex.EncodeToString(h[:]))
		}
	}
	if v, ok := req["description"]; ok {
		updates = append(updates, "description = ?")
		args = append(args, v.(string))
	}

	if len(updates) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"success": true})
		return
	}

	args = append(args, code)
	query := fmt.Sprintf("UPDATE share_links SET %s WHERE code = ?", strings.Join(updates, ", "))
	_, err := db.Exec(query, args...)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	LogAudit(db, "share_update", code, clientIP(r), "")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func handleShareRenew(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	code := strings.TrimPrefix(r.URL.Path, "/api/share/renew/")
	if code == "" {
		http.Error(w, `{"error":"code required"}`, 400)
		return
	}
	var req struct {
		Days int `json:"days"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.Days <= 0 {
		req.Days = 7
	}
	newExpires := time.Now().Add(time.Duration(req.Days) * 24 * time.Hour).Unix()
	_, err := db.Exec("UPDATE share_links SET expires_at = ? WHERE code = ?", newExpires, code)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	LogAudit(db, "share_renew", code, clientIP(r), "")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "expiresAt": newExpires * 1000, "days": req.Days})
}

func handleShareQR(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimPrefix(r.URL.Path, "/api/share/qr/")
	if code == "" {
		http.Error(w, `{"error":"code required"}`, 400)
		return
	}
	scheme := "https"
	if r.TLS == nil {
		scheme = "http"
	}
	urlStr := fmt.Sprintf("%s://%s/s/%s", scheme, r.Host, code)
	png, err := qrcode.Encode(urlStr, qrcode.Medium, 256)
	if err != nil {
		http.Error(w, `{"error":"failed to generate QR"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Write(png)
}

func handleShareStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var total, active, expiring int
	var totalDownloads int64
	db.QueryRow("SELECT COUNT(*) FROM share_links").Scan(&total)
	db.QueryRow("SELECT COUNT(*) FROM share_links WHERE expires_at = 0 OR expires_at > ?", time.Now().Unix()).Scan(&active)
	db.QueryRow("SELECT COUNT(*) FROM share_links WHERE expires_at > 0 AND expires_at < ?", time.Now().Add(7*24*time.Hour).Unix()).Scan(&expiring)
	db.QueryRow("SELECT COALESCE(SUM(download_count), 0) FROM share_links").Scan(&totalDownloads)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"stats": map[string]any{
			"total":          total,
			"active":         active,
			"expiringSoon":   expiring,
			"totalDownloads": totalDownloads,
		},
	})
}

func handleShareExpiring(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	days := 7
	if d := r.URL.Query().Get("days"); d != "" {
		if parsed, err := strconv.Atoi(d); err == nil {
			days = parsed
		}
	}
	cutoff := time.Now().Add(time.Duration(days) * 24 * time.Hour).Unix()
	rows, err := db.Query("SELECT code, filename, expires_at FROM share_links WHERE expires_at > 0 AND expires_at < ? ORDER BY expires_at ASC", cutoff)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	defer rows.Close()

	shares := []map[string]any{}
	for rows.Next() {
		var code, filename string
		var expiresAt int64
		rows.Scan(&code, &filename, &expiresAt)
		shares = append(shares, map[string]any{"code": code, "filename": filename, "expiresAt": expiresAt * 1000})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "shares": shares})
}

// ── Public Share Page (/s/:code) ──────────────────────────────────────

func handleSharePage(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if !strings.HasPrefix(path, "/s/") {
		return
	}
	code := strings.TrimPrefix(path, "/s/")
	if code == "" {
		http.Error(w, "Not Found", 404)
		return
	}

	share, err := getShareLink(code)
	if err != nil || share == nil {
		http.Error(w, "分享链接无效或已过期", 404)
		return
	}

	// Increment view count
	db.Exec("UPDATE share_links SET view_count = view_count + 1 WHERE code = ?", code)

	file, err := getFileByName(share.Filename)
	if err != nil || file == nil {
		http.Error(w, "文件不存在", 404)
		return
	}

	isTextFile := share.IsText || file.Type == "text"
	ext := extOf(file.Filename)
	isImage := isImageExt(ext)
	isVideo := isVideoExt(ext)
	isAudio := isAudioExt(ext)
	fileSize := formatFileSize(file.Size)
	createdAt := time.Unix(file.CreatedAt, 0).Format("2006-01-02")

	bgColor := ""
	textColor := "#111827"
	if share.ThemeColor != "" {
		textColor = share.ThemeColor
	}

	if share.Password != "" {
		if r.Method == http.MethodGet {
			servePasswordPage(w, r, code, file.Filename, textColor, bgColor)
			return
		}
		if r.Method == http.MethodPost {
			err := r.ParseForm()
			if err != nil {
				http.Error(w, "Bad Request", 400)
				return
			}
			pwd := r.FormValue("password")
			if !verifyPassword(pwd, share.Password) {
				servePasswordError(w, r, code, file.Filename, textColor, bgColor)
				return
			}
			// Password correct — fall through to serve the page
		}
	}

	// Serve content or download based on action
	if r.Method == http.MethodPost {
		action := r.FormValue("action")
		if action == "download" {
			serveShareDownload(w, r, code, file, share)
			return
		}
	}

	// Show the share page
	if isTextFile {
		serveTextSharePage(w, r, code, file, share, fileSize, createdAt)
	} else if isImage {
		serveImageSharePage(w, r, code, file, share, fileSize, createdAt)
	} else if isVideo || isAudio {
		serveMediaSharePage(w, r, code, file, share, fileSize, createdAt, isVideo)
	} else {
		serveGenericSharePage(w, r, code, file, share, fileSize, createdAt, ext)
	}
}

func serveShareDownload(w http.ResponseWriter, r *http.Request, code string, file *ShareFile, share *ShareLinkRow) {
	if share.MaxDownloads > 0 && share.DownloadCount >= share.MaxDownloads {
		http.Error(w, "分享次数已用尽", 410)
		return
	}

	fpath := filepath.Join(sharedDir, file.Filename)
	data, err := os.ReadFile(fpath)
	if err != nil {
		http.Error(w, "文件不存在", 404)
		return
	}

	db.Exec("UPDATE share_links SET download_count = download_count + 1 WHERE code = ?", code)
	LogAudit(db, "share_access", code+":"+file.Filename, clientIP(r), "")

	contentType := mime.TypeByExtension(extOf(file.Filename))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename*=UTF-8''%s", url.PathEscape(file.Filename)))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(data)))
	w.Write(data)
}

// ── Share File Content ────────────────────────────────────────────────

func handleShareContent(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimPrefix(r.URL.Path, "/api/share/content/")
	share, err := getShareLink(code)
	if err != nil || share == nil {
		http.Error(w, "Share not found", 404)
		return
	}
	file, err := getFileByName(share.Filename)
	if err != nil || file == nil {
		http.Error(w, "File not found", 404)
		return
	}

	fpath := filepath.Join(sharedDir, file.Filename)
	data, err := os.ReadFile(fpath)
	if err != nil {
		http.Error(w, "File not found", 404)
		return
	}

	contentType := mime.TypeByExtension(extOf(file.Filename))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(data)))
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Write(data)
}

// ── Request Link (Public Upload) ─────────────────────────────────────

func handleRequestLinkPage(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimPrefix(r.URL.Path, "/r/")
	if code == "" {
		return
	}
	link, err := getRequestLink(code)
	if err != nil || link == nil || !link.Active {
		http.Error(w, "链接不存在或已失效", 404)
		return
	}
	if link.ExpiresAt > 0 && link.ExpiresAt < time.Now().Unix() {
		http.Error(w, "链接已过期", 410)
		return
	}
	serveRequestUploadPage(w, r, code, link)
}

func handleRequestLinkUpload(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimPrefix(r.URL.Path, "/r/")
	if code == "" {
		return
	}
	link, err := getRequestLink(code)
	if err != nil || link == nil || !link.Active {
		http.Error(w, `{"error":"Link not available"}`, 410)
		return
	}
	if link.ExpiresAt > 0 && link.ExpiresAt < time.Now().Unix() {
		http.Error(w, `{"error":"Link expired"}`, 410)
		return
	}
	if link.MaxUploads > 0 && link.UploadCount >= link.MaxUploads {
		http.Error(w, `{"error":"Upload limit reached"}`, 410)
		return
	}

	var req struct {
		Filename string `json:"filename"`
		Content  string `json:"content"`
		Type     string `json:"type"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"Invalid request"}`, 400)
		return
	}
	if req.Filename == "" || req.Content == "" {
		http.Error(w, `{"error":"filename and content required"}`, 400)
		return
	}

	targetName := req.Filename
	if link.TargetFolder != "" {
		targetName = link.TargetFolder + "/" + req.Filename
	}

	data, err := base64.StdEncoding.DecodeString(req.Content)
	if err != nil {
		data = []byte(req.Content)
	}

	fpath := filepath.Join(sharedDir, targetName)
	if err := os.MkdirAll(filepath.Dir(fpath), 0755); err != nil {
		http.Error(w, `{"error":"storage error"}`, 500)
		return
	}
	if err := os.WriteFile(fpath, data, 0644); err != nil {
		http.Error(w, `{"error":"write error"}`, 500)
		return
	}

	db.Exec("UPDATE request_links SET upload_count = upload_count + 1 WHERE code = ?", code)
	LogAudit(db, "request_link_upload", targetName, clientIP(r), "")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "filename": targetName})
}

// ── Helpers ───────────────────────────────────────────────────────────

type ShareLinkRow struct {
	Code          string
	Filename      string
	IsText        bool
	Password      string
	ExpiresAt     int64
	MaxDownloads  int
	DownloadCount int
	Description   string
	ThemeColor    string
}

type ShareFile struct {
	Filename string
	Type    string
	Size    int64
	CreatedAt int64
}

type RequestLinkRow struct {
	Name         string
	TargetFolder string
	MaxUploads   int
	UploadCount  int
	ExpiresAt    int64
	Active       bool
}

func getShareLink(code string) (*ShareLinkRow, error) {
	var s ShareLinkRow
	var password, description, themeColor sql.NullString
	var maxDownloads sql.NullInt64
	err := db.QueryRow(`
		SELECT code, filename, is_text, password, expires_at, max_downloads, download_count, description, theme_color
		FROM share_links WHERE code = ?`, code,
	).Scan(&s.Code, &s.Filename, &s.IsText, &password, &s.ExpiresAt, &maxDownloads, &s.DownloadCount, &description, &themeColor)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.Password = password.String
	s.Description = description.String
	s.ThemeColor = themeColor.String
	if maxDownloads.Valid {
		s.MaxDownloads = int(maxDownloads.Int64)
	}
	return &s, nil
}

func getFileByName(filename string) (*ShareFile, error) {
	var f ShareFile
	err := db.QueryRow(`
		SELECT filename, type, size, created_at FROM files WHERE filename = ?`, filename,
	).Scan(&f.Filename, &f.Type, &f.Size, &f.CreatedAt)
	if err == sql.ErrNoRows {
		// Fallback: check filesystem
		fpath := filepath.Join(sharedDir, filename)
		fi, err := os.Stat(fpath)
		if err != nil {
			return nil, err
		}
		f.Filename = filename
		f.Type = "file"
		f.Size = fi.Size()
		f.CreatedAt = fi.ModTime().Unix()
		return &f, nil
	}
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func getRequestLink(code string) (*RequestLinkRow, error) {
	var r RequestLinkRow
	var targetFolder sql.NullString
	var maxUploads sql.NullInt64
	err := db.QueryRow(`
		SELECT name, target_folder, max_uploads, upload_count, expires_at, active
		FROM request_links WHERE code = ?`, code,
	).Scan(&r.Name, &targetFolder, &maxUploads, &r.UploadCount, &r.ExpiresAt, &r.Active)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.TargetFolder = targetFolder.String
	if maxUploads.Valid {
		r.MaxUploads = int(maxUploads.Int64)
	}
	return &r, nil
}

func verifyPassword(input, hash string) bool {
	h := sha256.Sum256([]byte(input))
	return hex.EncodeToString(h[:]) == hash
}

func clientIP(r *http.Request) string {
	ip := r.Header.Get("X-Forwarded-For")
	if ip == "" {
		ip = r.Header.Get("X-Real-IP")
	}
	if ip == "" {
		ip = r.RemoteAddr
	}
	return ip
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func generateCode(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	for i := range b {
		b[i] = chars[int(b[i])%len(chars)]
	}
	return string(b)
}

func extOf(name string) string {
	if i := strings.LastIndex(name, "."); i >= 0 {
		return strings.ToLower(name[i+1:])
	}
	return ""
}

func isImageExt(ext string) bool {
	m := map[string]bool{"jpg": true, "jpeg": true, "png": true, "gif": true, "webp": true, "svg": true, "bmp": true, "ico": true}
	return m[ext]
}

func isVideoExt(ext string) bool {
	m := map[string]bool{"mp4": true, "webm": true, "mov": true, "avi": true, "mkv": true, "wmv": true}
	return m[ext]
}

func isAudioExt(ext string) bool {
	m := map[string]bool{"mp3": true, "wav": true, "ogg": true, "aac": true, "flac": true, "m4a": true}
	return m[ext]
}

func formatFileSize(size int64) string {
	if size > 1024*1024 {
		return fmt.Sprintf("%.1f MB", float64(size)/1024/1024)
	}
	if size > 1024 {
		return fmt.Sprintf("%.1f KB", float64(size)/1024)
	}
	return fmt.Sprintf("%d B", size)
}

func LogAudit(db *sql.DB, action, details, ip, token string) {
	if db == nil {
		return
	}
	db.Exec("INSERT INTO audit_log (action, details, ip, token) VALUES (?, ?, ?, ?)",
		action, details, ip, token)
}

// HTML page templates (inline for simplicity)

func escapeHtml(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	return s
}

func servePasswordPage(w http.ResponseWriter, r *http.Request, code, filename, color, bg string) {
	if color == "" {
		color = "#111827"
	}
	w.WriteHeader(200)
	w.Write([]byte(fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>访问分享</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:%s;color:%s;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{width:min(420px,92vw);background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:28px;box-shadow:0 20px 50px rgba(0,0,0,.08)}
h1{margin:0 0 10px;font-size:24px}
p{color:#6b7280;line-height:1.5}
input,button{width:100%;box-sizing:border-box;border-radius:12px;padding:14px 16px;font-size:16px}
input{border:1px solid #d1d5db;margin:18px 0 12px}
button{border:none;background:%s;color:#fff;cursor:pointer}
</style>
</head>
<body>
<form class="card" method="post" action="/s/%s">
<h1>输入访问密码</h1>
<p>%s</p>
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">打开分享</button>
</form>
</body></html>`, bg, color, color, code, escapeHtml(filename))))
}

func servePasswordError(w http.ResponseWriter, r *http.Request, code, filename, color, bg string) {
	if color == "" {
		color = "#111827"
	}
	w.WriteHeader(403)
	w.Write([]byte(fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>访问分享</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:%s;color:%s;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{width:min(420px,92vw);background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:28px;box-shadow:0 20px 50px rgba(0,0,0,.08)}
h1{margin:0 0 10px;font-size:24px;color:#dc2626}
p{color:#6b7280;line-height:1.5}
input,button{width:100%;box-sizing:border-box;border-radius:12px;padding:14px 16px;font-size:16px}
input{border:1px solid #d1d5db;margin:18px 0 12px}
button{border:none;background:%s;color:#fff;cursor:pointer}
</style>
</head>
<body>
<form class="card" method="post" action="/s/%s">
<h1>密码错误</h1>
<p>%s</p>
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">重试</button>
</form>
</body></html>`, bg, color, color, code, escapeHtml(filename))))
}

func serveTextSharePage(w http.ResponseWriter, r *http.Request, code string, file *ShareFile, share *ShareLinkRow, fileSize, createdAt string) {
	color := share.ThemeColor
	if color == "" {
		color = "#111827"
	}
	fpath := filepath.Join(sharedDir, file.Filename)
	content, _ := os.ReadFile(fpath)
	preview := string(content)
	if len(preview) > 2000 {
		preview = preview[:2000] + "\n\n... (内容已截断)"
	}
	w.WriteHeader(200)
	w.Write([]byte(fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s - ShareTool</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;margin:0;padding:0}
.wrap{max-width:860px;margin:0 auto;padding:32px 16px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.06);margin-bottom:16px}
h1{font-size:20px;margin:0 0 8px;font-weight:600}
.meta{color:#6b7280;font-size:13px;margin-bottom:20px}
.meta span{margin-right:16px}
pre{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#f8f9fa;border:1px solid #e5e7eb;border-radius:12px;padding:20px;white-space:pre-wrap;word-break:break-word;max-height:60vh;overflow-y:auto}
.dl-btn{display:inline-block;width:100%;box-sizing:border-box;background:%s;color:#fff;border:none;border-radius:14px;padding:16px;font-size:16px;cursor:pointer;text-align:center;text-decoration:none;font-weight:500}
</style>
</head>
<body><div class="wrap"><div class="card">
<h1>📄 %s</h1>
<div class="meta"><span>📝 文本</span><span>%s</span><span>🗓 %s</span></div>
<pre>%s</pre>
</div>
<form method="post" action="/s/%s">
<input type="hidden" name="action" value="download">
<button type="submit" class="dl-btn">⬇ 下载文件</button>
</form></div></body></html>`,
		escapeHtml(file.Filename), color,
		escapeHtml(file.Filename), fileSize, createdAt,
		escapeHtml(preview), code,
	)))
}

func serveImageSharePage(w http.ResponseWriter, r *http.Request, code string, file *ShareFile, share *ShareLinkRow, fileSize, createdAt string) {
	color := share.ThemeColor
	if color == "" {
		color = "#111827"
	}
	w.WriteHeader(200)
	w.Write([]byte(fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s - ShareTool</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;margin:0;padding:0}
.wrap{max-width:900px;margin:0 auto;padding:32px 16px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.06);margin-bottom:16px;text-align:center}
h1{font-size:20px;margin:0 0 8px;font-weight:600;text-align:left}
.meta{color:#6b7280;font-size:13px;margin-bottom:20px;text-align:left}
.meta span{margin-right:16px}
img{max-width:100%;max-height:70vh;border-radius:12px;border:1px solid #e5e7eb}
.dl-btn{display:inline-block;width:100%;box-sizing:border-box;background:%s;color:#fff;border:none;border-radius:14px;padding:16px;font-size:16px;cursor:pointer;text-decoration:none;text-align:center;font-weight:500}
</style>
</head>
<body><div class="wrap"><div class="card">
<h1>🖼 %s</h1>
<div class="meta"><span>图片</span><span>%s</span><span>🗓 %s</span></div>
<img src="/api/share/content/%s" alt="%s" loading="lazy">
</div>
<form method="post" action="/s/%s">
<input type="hidden" name="action" value="download">
<button type="submit" class="dl-btn">⬇ 下载文件</button>
</form></div></body></html>`,
		escapeHtml(file.Filename), color,
		escapeHtml(file.Filename), fileSize, createdAt,
		code, escapeHtml(file.Filename), code,
	)))
}

func serveMediaSharePage(w http.ResponseWriter, r *http.Request, code string, file *ShareFile, share *ShareLinkRow, fileSize, createdAt string, isVideo bool) {
	color := share.ThemeColor
	if color == "" {
		color = "#111827"
	}
	tag := "audio"
	if isVideo {
		tag = "video"
	}
	attrs := "controls style=\"width:100%;border-radius:12px\""
	if isVideo {
		attrs = "controls playsinline style=\"max-width:100%;border-radius:12px\""
	}
	w.WriteHeader(200)
	w.Write([]byte(fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s - ShareTool</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;margin:0;padding:0}
.wrap{max-width:860px;margin:0 auto;padding:32px 16px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.06);margin-bottom:16px}
h1{font-size:20px;margin:0 0 8px;font-weight:600}
.meta{color:#6b7280;font-size:13px;margin-bottom:20px}
.meta span{margin-right:16px}
.%s{display:block;width:100%%;margin:0 auto 20px;background:#000;border-radius:12px}
.dl-btn{display:inline-block;width:100%%;box-sizing:border-box;background:%s;color:#fff;border:none;border-radius:14px;padding:16px;font-size:16px;cursor:pointer;text-decoration:none;text-align:center;font-weight:500}
</style>
</head>
<body><div class="wrap"><div class="card">
<h1>%s %s</h1>
<div class="meta"><span>%s</span><span>%s</span><span>🗓 %s</span></div>
<%s %s><source src="/api/share/content/%s"></%s>
</div>
<form method="post" action="/s/%s">
<input type="hidden" name="action" value="download">
<button type="submit" class="dl-btn">⬇ 下载文件</button>
</form></div></body></html>`,
		escapeHtml(file.Filename), color,
		escapeHtml(file.Filename), fileSize, createdAt,
		tag, attrs, code, tag, code,
	)))
}

func serveGenericSharePage(w http.ResponseWriter, r *http.Request, code string, file *ShareFile, share *ShareLinkRow, fileSize, createdAt, ext string) {
	color := share.ThemeColor
	if color == "" {
		color = "#111827"
	}
	iconMap := map[string]string{
		"pdf": "📕", "doc": "📘", "docx": "📘", "xls": "📗", "xlsx": "📗",
		"ppt": "📙", "pptx": "📙", "zip": "🗜", "rar": "🗜", "7z": "🗜",
		"txt": "📄", "md": "📝", "json": "📋", "xml": "📋", "csv": "📊",
		"html": "🌐", "css": "🎨", "js": "⚡", "py": "🐍", "go": "🐹",
		"rs": "🦀", "java": "☕", "exe": "⚙", "apk": "📱",
	}
	icon := iconMap[ext]
	if icon == "" {
		icon = "📎"
	}
	w.WriteHeader(200)
	w.Write([]byte(fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s - ShareTool</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;margin:0;padding:0}
.wrap{max-width:520px;margin:0 auto;padding:48px 16px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:36px;box-shadow:0 4px 24px rgba(0,0,0,.06);text-align:center;margin-bottom:16px}
.icon{font-size:56px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 8px;font-weight:600;word-break:break-all}
.meta{color:#6b7280;font-size:13px;margin-bottom:20px}
.ext-tag{display:inline-block;background:#f3f4f6;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:500;text-transform:uppercase;margin-bottom:16px}
.dl-btn{display:inline-block;width:100%%;box-sizing:border-box;background:%s;color:#fff;border:none;border-radius:14px;padding:16px;font-size:16px;cursor:pointer;text-decoration:none;text-align:center;font-weight:500}
</style>
</head>
<body><div class="wrap"><div class="card">
<div class="icon">%s</div>
<div class="ext-tag">%s</div>
<h1>%s</h1>
<div class="meta"><span>%s</span><span>🗓 %s</span></div>
</div>
<form method="post" action="/s/%s">
<input type="hidden" name="action" value="download">
<button type="submit" class="dl-btn">⬇ 下载文件</button>
</form></div></body></html>`,
		escapeHtml(file.Filename), color,
		icon, strings.ToUpper(ext), escapeHtml(file.Filename),
		fileSize, createdAt, code,
	)))
}

func serveRequestUploadPage(w http.ResponseWriter, r *http.Request, code string, link *RequestLinkRow) {
	w.WriteHeader(200)
	uploadCountInfo := ""
	if link.MaxUploads > 0 {
		uploadCountInfo = fmt.Sprintf("已收集 %d/%d 个文件", link.UploadCount, link.MaxUploads)
	} else {
		uploadCountInfo = fmt.Sprintf("已收集 %d 个文件", link.UploadCount)
	}
	targetInfo := ""
	if link.TargetFolder != "" {
		targetInfo = fmt.Sprintf("收集到文件夹: %s", escapeHtml(link.TargetFolder))
	}
	w.Write([]byte(fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>文件收集 - %s</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7fb;color:#111827;margin:0;min-height:100vh}
.wrap{max-width:560px;margin:0 auto;padding:32px 16px}
.header{text-align:center;margin-bottom:28px}
.header h1{font-size:22px;margin:0 0 6px}
.header p{color:#6b7280;font-size:14px;margin:0}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:24px;box-shadow:0 4px 16px rgba(0,0,0,.05);margin-bottom:16px}
.drop-zone{border:2px dashed #d1d5db;border-radius:16px;padding:40px 20px;text-align:center;cursor:pointer;transition:border-color .2s,background .2s}
.drop-zone.dragover{border-color:#667eea;background:#f5f3ff}
.drop-zone:hover{border-color:#667eea}
.drop-icon{font-size:48px;margin-bottom:12px}
.drop-text{font-size:15px;color:#374151;margin-bottom:4px}
.drop-hint{font-size:12px;color:#9ca3af}
#fileInput{display:none}
.file-list{margin-top:16px}
.file-item{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#f9fafb;border-radius:10px;margin-bottom:8px;font-size:14px}
.file-item .name{flex:1;word-break:break-all;color:#111827}
.file-item .size{color:#9ca3af;font-size:12px;white-space:nowrap}
.file-item .remove{color:#9ca3af;cursor:pointer;font-size:16px;line-height:1;padding:2px}
.file-item .remove:hover{color:#dc2626}
.file-item.success{background:#f0fdf4;border:1px solid #bbf7d0}
.file-item.error{background:#fef2f2;border:1px solid #fecaca}
.file-item .status{font-size:12px;white-space:nowrap}
.file-item .status.ok{color:#16a34a}
.file-item .status.err{color:#dc2626}
.submit-btn{width:100%%;padding:15px;border:none;border-radius:14px;background:#111827;color:#fff;font-size:16px;cursor:pointer;margin-top:8px}
.submit-btn:hover{background:#1f2937}
.submit-btn:disabled{background:#9ca3af;cursor:not-allowed}
.msg{padding:12px 16px;border-radius:10px;font-size:14px;margin-bottom:12px;display:none}
.msg.error{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
.msg.success{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0}
</style>
</head>
<body>
<div class="wrap">
<div class="header">
<h1>📁 %s</h1>
%s
<p style="color:#6b7280;font-size:14px;margin-top:4px">%s</p>
</div>
<div class="card">
<div id="msg" class="msg"></div>
<div class="drop-zone" id="dropZone">
<div class="drop-icon">📤</div>
<div class="drop-text">拖拽文件到这里，或点击选择</div>
<div class="drop-hint">支持任意文件类型，单个文件不超过 5MB</div>
</div>
<input type="file" id="fileInput" multiple>
<div class="file-list" id="fileList"></div>
<button class="submit-btn" id="submitBtn" disabled onclick="uploadAll()">上传文件</button>
</div>
</div>
<script>
const dropZone=document.getElementById('dropZone'),fileInput=document.getElementById('fileInput'),fileList=document.getElementById('fileList'),submitBtn=document.getElementById('submitBtn'),msg=document.getElementById('msg');
let files=[];
function showMsg(text,type){msg.textContent=text;msg.className='msg '+type;msg.style.display='block'}
function formatSize(b){if(b>1024*1024)return(b/1024/1024).toFixed(1)+' MB';if(b>1024)return(b/1024).toFixed(1)+' KB';return b+' B'}
function addFiles(newFiles){for(const f of newFiles){if(f.size>5*1024*1024){showMsg('文件太大: '+f.name,maxSizeLabel,'error');continue}const idx=files.length;files.push(f);const el=document.createElement('div');el.className='file-item';el.innerHTML='<span class="name">'+f.name.replace(/</g,'&lt;')+'</span><span class="size">'+formatSize(f.size)+'</span><span class="remove" onclick="removeFile('+idx+')">✕</span><span class="status" id="status_'+idx+'"></span>';fileList.appendChild(el)}submitBtn.disabled=files.length===0}
function removeFile(idx){files.splice(idx,1);fileList.innerHTML='';files.forEach((f,i)=>{const el=document.createElement('div');el.className='file-item';el.innerHTML='<span class="name">'+f.name.replace(/</g,'&lt;')+'</span><span class="size">'+formatSize(f.size)+'</span><span class="remove" onclick="removeFile('+i+')">✕</span><span class="status" id="status_'+i+'"></span>';fileList.appendChild(el)});submitBtn.disabled=files.length===0}
dropZone.addEventListener('click',()=>fileInput.click());
dropZone.addEventListener('dragover',e=>{e.preventDefault();dropZone.classList.add('dragover')});
dropZone.addEventListener('dragleave',()=>dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop',e=>{e.preventDefault();dropZone.classList.remove('dragover');addFiles(e.dataTransfer.files)});
fileInput.addEventListener('change',()=>addFiles(fileInput.files));
async function uploadFile(f,index){const statusEl=document.getElementById('status_'+index);const itemEl=statusEl?statusEl.closest('.file-item'):null;try{const buf=await f.arrayBuffer();const b64=btoa(String.fromCharCode(...new Uint8Array(buf)));const res=await fetch('/r/%s',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:f.name,content:b64,type:'base64'})});const data=await res.json();if(data.success){if(statusEl){statusEl.textContent='✓';statusEl.className='status ok'}if(itemEl)itemEl.classList.add('success')}else{if(statusEl){statusEl.textContent='✕ '+(data.error||'');statusEl.className='status err'}if(itemEl)itemEl.classList.add('error')}}catch(e){if(statusEl){statusEl.textContent='✕ '+e.message;statusEl.className='status err'}if(itemEl)itemEl.classList.add('error')}}
async function uploadAll(){if(files.length===0)return;submitBtn.disabled=true;for(let i=0;i<files.length;i++){await uploadFile(files[i],i)}submitBtn.disabled=false}
</script>
</body></html>`, escapeHtml(link.Name), targetInfo, uploadCountInfo, code)))
}
