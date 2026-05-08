package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"time"
)

// ShareLink represents a share link record.
type ShareLink struct {
	ID            int64
	Code          string
	Filename      string
	IsText        bool
	Password      string
	ExpiresAt     int64
	MaxDownloads  int
	DownloadCount int
	Description   string
	Label         string
	ViewCount     int
	ThemeColor    string
	CreatedAt     int64
	CreatedBy     string
}

// CreateShareLink creates a new share link with a random code.
func CreateShareLink(filename string, isText bool, password string, expiresAt int64, maxDownloads int, description, label, themeColor, createdBy string) (string, error) {
	code := generateCode(8)
	_, err := DB.Exec(`
		INSERT INTO share_links (code, filename, is_text, password, expires_at, max_downloads, description, label, theme_color, created_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		code, filename, boolToInt(isText), password, expiresAt, maxDownloads, description, label, themeColor, createdBy,
	)
	return code, err
}

// GetShareLink returns a share link by code.
func GetShareLink(code string) (*ShareLink, error) {
	var s ShareLink
	var password, description, label, themeColor, createdBy sql.NullString
	var maxDownloads sql.NullInt64
	err := DB.QueryRow(`
		SELECT id, code, filename, is_text, password, expires_at, max_downloads, download_count, description, label, view_count, theme_color, created_at, created_by
		FROM share_links WHERE code = ?`, code,
	).Scan(&s.ID, &s.Code, &s.Filename, &s.IsText, &password, &s.ExpiresAt, &maxDownloads, &s.DownloadCount, &description, &label, &s.ViewCount, &themeColor, &s.CreatedAt, &createdBy)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.Password = password.String
	s.Description = description.String
	s.Label = label.String
	s.ThemeColor = themeColor.String
	s.CreatedBy = createdBy.String
	if maxDownloads.Valid {
		s.MaxDownloads = int(maxDownloads.Int64)
	}
	return &s, nil
}

// ListShareLinks returns all share links.
func ListShareLinks() ([]ShareLink, error) {
	rows, err := DB.Query(`
		SELECT id, code, filename, is_text, password, expires_at, max_downloads, download_count, description, label, view_count, theme_color, created_at, created_by
		FROM share_links ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var links []ShareLink
	for rows.Next() {
		var s ShareLink
		var password, description, label, themeColor, createdBy sql.NullString
		var maxDownloads sql.NullInt64
		if err := rows.Scan(&s.ID, &s.Code, &s.Filename, &s.IsText, &password, &s.ExpiresAt, &maxDownloads, &s.DownloadCount, &description, &label, &s.ViewCount, &themeColor, &s.CreatedAt, &createdBy); err != nil {
			return nil, err
		}
		s.Password = password.String
		s.Description = description.String
		s.Label = label.String
		s.ThemeColor = themeColor.String
		s.CreatedBy = createdBy.String
		if maxDownloads.Valid {
			s.MaxDownloads = int(maxDownloads.Int64)
		}
		links = append(links, s)
	}
	return links, rows.Err()
}

// DeleteShareLink removes a share link by code.
func DeleteShareLink(code string) error {
	_, err := DB.Exec("DELETE FROM share_links WHERE code = ?", code)
	return err
}

// IncrementShareLinkDownload increments the download count.
func IncrementShareLinkDownload(code string) error {
	_, err := DB.Exec("UPDATE share_links SET download_count = download_count + 1 WHERE code = ?", code)
	return err
}

// IncrementShareLinkView increments the view count.
func IncrementShareLinkView(code string) error {
	_, err := DB.Exec("UPDATE share_links SET view_count = view_count + 1 WHERE code = ?", code)
	return err
}

// generateCode generates a random URL-safe code.
func generateCode(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)[:n]
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// RequestLink represents a request/upload link.
type RequestLink struct {
	ID          int64
	Code        string
	Name        string
	TargetFolder string
	Password    string
	MaxUploads  int
	UploadCount int
	ExpiresAt   int64
	Active      bool
	CreatedAt   int64
	CreatedBy   string
}

// CreateRequestLink creates a new request link.
func CreateRequestLink(name, targetFolder, password string, maxUploads int, expiresAt int64, createdBy string) (string, error) {
	code := generateCode(8)
	_, err := DB.Exec(`
		INSERT INTO request_links (code, name, target_folder, password, max_uploads, expires_at, created_by)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		code, name, targetFolder, password, maxUploads, expiresAt, createdBy,
	)
	return code, err
}

// GetRequestLink returns a request link by code.
func GetRequestLink(code string) (*RequestLink, error) {
	var r RequestLink
	var password, targetFolder, createdBy sql.NullString
	var maxUploads sql.NullInt64
	err := DB.QueryRow(`
		SELECT id, code, name, target_folder, password, max_uploads, upload_count, expires_at, active, created_at, created_by
		FROM request_links WHERE code = ?`, code,
	).Scan(&r.ID, &r.Code, &r.Name, &targetFolder, &password, &maxUploads, &r.UploadCount, &r.ExpiresAt, &r.Active, &r.CreatedAt, &createdBy)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.Password = password.String
	r.TargetFolder = targetFolder.String
	r.CreatedBy = createdBy.String
	if maxUploads.Valid {
		r.MaxUploads = int(maxUploads.Int64)
	}
	return &r, nil
}

// ListRequestLinks returns all request links.
func ListRequestLinks() ([]RequestLink, error) {
	rows, err := DB.Query(`
		SELECT id, code, name, target_folder, password, max_uploads, upload_count, expires_at, active, created_at, created_by
		FROM request_links ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var links []RequestLink
	for rows.Next() {
		var r RequestLink
		var password, targetFolder, createdBy sql.NullString
		var maxUploads sql.NullInt64
		if err := rows.Scan(&r.ID, &r.Code, &r.Name, &targetFolder, &password, &maxUploads, &r.UploadCount, &r.ExpiresAt, &r.Active, &r.CreatedAt, &createdBy); err != nil {
			return nil, err
		}
		r.Password = password.String
		r.TargetFolder = targetFolder.String
		r.CreatedBy = createdBy.String
		if maxUploads.Valid {
			r.MaxUploads = int(maxUploads.Int64)
		}
		links = append(links, r)
	}
	return links, rows.Err()
}

// DeleteRequestLink removes a request link.
func DeleteRequestLink(code string) error {
	_, err := DB.Exec("DELETE FROM request_links WHERE code = ?", code)
	return err
}

// IncrementRequestLinkUpload increments the upload count.
func IncrementRequestLinkUpload(code string) error {
	_, err := DB.Exec("UPDATE request_links SET upload_count = upload_count + 1 WHERE code = ?", code)
	return err
}

// CleanupExpiredShareLinks removes expired share links.
func CleanupExpiredShareLinks() error {
	_, err := DB.Exec("DELETE FROM share_links WHERE expires_at > 0 AND expires_at < ?", time.Now().Unix())
	return err
}

// CleanupExpiredRequestLinks removes expired request links.
func CleanupExpiredRequestLinks() error {
	_, err := DB.Exec("DELETE FROM request_links WHERE expires_at > 0 AND expires_at < ?", time.Now().Unix())
	return err
}
