package db

import (
	"database/sql"
	"time"
)

// File represents a file record in the database.
type File struct {
	ID        int64
	Filename  string
	Content   string
	Type      string
	Size      int64
	Hash      string
	Tags      string
	Encrypted bool
	Starred   bool
	Position  int
	CreatedAt int64
	UpdatedAt int64
}

// ListFiles returns all files ordered by updated_at desc.
func ListFiles() ([]File, error) {
	rows, err := DB.Query(`
		SELECT id, filename, content, type, size, hash, tags, encrypted, starred, position, created_at, updated_at
		FROM files
		ORDER BY updated_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []File
	for rows.Next() {
		var f File
		var content, hash, tags, typ, enc, star sql.NullString
		var size, pos, id int64
		var createdAt, updatedAt int64
		if err := rows.Scan(&id, &content, &typ, &size, &hash, &tags, &enc, &star, &pos, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		f.ID = id
		f.Filename = content.String
		f.Type = typ.String
		f.Size = size
		f.Hash = hash.String
		f.Tags = tags.String
		f.Encrypted = enc.String == "1"
		f.Starred = star.String == "1"
		f.Position = int(pos)
		f.CreatedAt = createdAt
		f.UpdatedAt = updatedAt
		files = append(files, f)
	}
	return files, rows.Err()
}

// GetFileByName returns a file by its filename.
func GetFileByName(filename string) (*File, error) {
	var f File
	var content, hash, tags, typ, enc, star sql.NullString
	var size, pos, id int64
	var createdAt, updatedAt int64
	err := DB.QueryRow(`
		SELECT id, filename, content, type, size, hash, tags, encrypted, starred, position, created_at, updated_at
		FROM files WHERE filename = ?`, filename,
	).Scan(&id, &content, &typ, &size, &hash, &tags, &enc, &star, &pos, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	f.ID = id
	f.Filename = content.String
	f.Type = typ.String
	f.Size = size
	f.Hash = hash.String
	f.Tags = tags.String
	f.Encrypted = enc.String == "1"
	f.Starred = star.String == "1"
	f.Position = int(pos)
	f.CreatedAt = createdAt
	f.UpdatedAt = updatedAt
	return &f, nil
}

// CreateFile inserts a new file record.
func CreateFile(filename, content, typ string, size int64) (int64, error) {
	now := time.Now().Unix()
	result, err := DB.Exec(`
		INSERT INTO files (filename, content, type, size, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		filename, content, typ, size, now, now,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// UpdateFile updates file content and size.
func UpdateFile(filename, content string, size int64) error {
	_, err := DB.Exec(`
		UPDATE files SET content=?, size=?, updated_at=? WHERE filename=?`,
		content, size, time.Now().Unix(), filename,
	)
	return err
}

// DeleteFile removes a file by filename.
func DeleteFile(filename string) error {
	_, err := DB.Exec("DELETE FROM files WHERE filename = ?", filename)
	return err
}

// SearchFiles performs full-text search on filenames and tags.
func SearchFiles(query string) ([]File, error) {
	rows, err := DB.Query(`
		SELECT f.id, f.filename, f.content, f.type, f.size, f.hash, f.tags, f.encrypted, f.starred, f.position, f.created_at, f.updated_at
		FROM files f
		JOIN files_fts fts ON f.id = fts.rowid
		WHERE files_fts MATCH ?
		ORDER BY f.updated_at DESC`,
		query,
	)
	if err != nil {
		// Fallback to LIKE if FTS fails
		return searchFilesLike(query)
	}
	defer rows.Close()

	var files []File
	for rows.Next() {
		var f File
		var content, hash, tags, typ, enc, star sql.NullString
		var size, pos, id int64
		var createdAt, updatedAt int64
		if err := rows.Scan(&id, &content, &typ, &size, &hash, &tags, &enc, &star, &pos, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		f.ID = id
		f.Filename = content.String
		f.Type = typ.String
		f.Size = size
		f.Hash = hash.String
		f.Tags = tags.String
		f.Encrypted = enc.String == "1"
		f.Starred = star.String == "1"
		f.Position = int(pos)
		f.CreatedAt = createdAt
		f.UpdatedAt = updatedAt
		files = append(files, f)
	}
	return files, rows.Err()
}

func searchFilesLike(query string) ([]File, error) {
	like := "%" + query + "%"
	rows, err := DB.Query(`
		SELECT id, filename, content, type, size, hash, tags, encrypted, starred, position, created_at, updated_at
		FROM files
		WHERE filename LIKE ? OR tags LIKE ?
		ORDER BY updated_at DESC`,
		like, like,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []File
	for rows.Next() {
		var f File
		var content, hash, tags, typ, enc, star sql.NullString
		var size, pos, id int64
		var createdAt, updatedAt int64
		if err := rows.Scan(&id, &content, &typ, &size, &hash, &tags, &enc, &star, &pos, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		f.ID = id
		f.Filename = content.String
		f.Type = typ.String
		f.Size = size
		f.Hash = hash.String
		f.Tags = tags.String
		f.Encrypted = enc.String == "1"
		f.Starred = star.String == "1"
		f.Position = int(pos)
		f.CreatedAt = createdAt
		f.UpdatedAt = updatedAt
		files = append(files, f)
	}
	return files, rows.Err()
}

// GetFileCount returns the total number of files.
func GetFileCount() (int, error) {
	var count int
	err := DB.QueryRow("SELECT COUNT(*) FROM files").Scan(&count)
	return count, err
}
