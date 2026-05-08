package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"time"
)

// TrashEntry represents a file in the trash.
type TrashEntry struct {
	ID        int64  `json:"id"`
	FileID    int64  `json:"fileId"`
	Filename  string `json:"filename"`
	Content   string `json:"content,omitempty"`
	Size      int64  `json:"size"`
	Type      string `json:"type"`
	Hash      string `json:"hash"`
	DeletedAt int64  `json:"deletedAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

// ListTrash returns all items in trash.
func ListTrash() ([]TrashEntry, error) {
	rows, err := DB.Query(`
		SELECT id, file_id, filename, content, size, type, hash, deleted_at, expires_at
		FROM trash
		ORDER BY deleted_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []TrashEntry
	for rows.Next() {
		var e TrashEntry
		var content, hash, typ sql.NullString
		if err := rows.Scan(&e.ID, &e.FileID, &e.Filename, &content, &e.Size, &typ, &hash, &e.DeletedAt, &e.ExpiresAt); err != nil {
			continue
		}
		e.Content = content.String
		e.Hash = hash.String
		e.Type = typ.String
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// MoveToTrash moves a file to trash. Returns the trash ID.
func MoveToTrash(filename string, storageDir string) (int64, error) {
	// Get file info first
	file, err := GetFileByName(filename)
	if err != nil || file == nil {
		return 0, err
	}

	// Read file content
	fpath := filepath.Join(storageDir, filename)
	data, err := os.ReadFile(fpath)
	if err != nil {
		// File might not exist on disk (only DB record)
		data = []byte{}
	}

	// Insert into trash
	now := time.Now().Unix()
	expiresAt := now + 30*24*60*60 // 30 days
	result, err := DB.Exec(`
		INSERT INTO trash (file_id, filename, content, size, type, hash, deleted_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		file.ID, filename, string(data), file.Size, file.Type, file.Hash, now, expiresAt,
	)
	if err != nil {
		return 0, err
	}

	trashID, _ := result.LastInsertId()

	// Delete from files table
	_, err = DB.Exec("DELETE FROM files WHERE filename = ?", filename)
	if err != nil {
		return trashID, err
	}

	// Also delete from disk
	os.Remove(fpath)

	return trashID, nil
}

// RestoreFromTrash restores a file from trash.
func RestoreFromTrash(trashID int64, storageDir string) error {
	var e TrashEntry
	var content, hash, typ sql.NullString
	err := DB.QueryRow(`
		SELECT id, file_id, filename, content, size, type, hash, deleted_at, expires_at
		FROM trash WHERE id = ?`, trashID,
	).Scan(&e.ID, &e.FileID, &e.Filename, &content, &e.Size, &typ, &hash, &e.DeletedAt, &e.ExpiresAt)
	if err != nil {
		return err
	}

	// Write content back to disk
	if content.String != "" {
		fpath := filepath.Join(storageDir, e.Filename)
		os.MkdirAll(filepath.Dir(fpath), 0755)
		os.WriteFile(fpath, []byte(content.String), 0644)
	}

	// Insert back into files table
	_, err = DB.Exec(`
		INSERT INTO files (filename, content, type, size, hash, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		e.Filename, content.String, typ.String, e.Size, hash.String, e.DeletedAt, time.Now().Unix(),
	)
	if err != nil {
		return err
	}

	// Delete from trash
	_, err = DB.Exec("DELETE FROM trash WHERE id = ?", trashID)
	return err
}

// PermanentlyDeleteTrash permanently deletes a trash item.
func PermanentlyDeleteTrash(trashID int64) error {
	_, err := DB.Exec("DELETE FROM trash WHERE id = ?", trashID)
	return err
}

// EmptyTrash permanently deletes all expired trash items.
func EmptyTrash() (int, error) {
	result, err := DB.Exec("DELETE FROM trash WHERE expires_at < ?", time.Now().Unix())
	if err != nil {
		return 0, err
	}
	n, _ := result.RowsAffected()
	return int(n), nil
}

// CleanupExpiredTrash removes expired trash items.
func CleanupExpiredTrash() (int, error) {
	now := time.Now().Unix()
	rows, err := DB.Query("SELECT id, filename, content FROM trash WHERE expires_at < ?", now)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var id int64
		var filename string
		rows.Scan(&id, &filename)
		DB.Exec("DELETE FROM trash WHERE id = ?", id)
		count++
	}
	return count, nil
}
