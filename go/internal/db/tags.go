package db

import (
	"database/sql"
	"strings"
	"time"
)

// TagStats represents a tag with its file count.
type TagStats struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

// ListTags returns all tags with their file counts.
func ListTags() ([]TagStats, error) {
	rows, err := DB.Query(`
		SELECT tag, COUNT(*) as count
		FROM (
			SELECT TRIM(value) as tag
			FROM files, json_each(files.tags)
			WHERE files.tags != ''
		)
		GROUP BY tag
		ORDER BY count DESC
	`)
	if err != nil {
		// Fallback to LIKE-based parsing if JSON1 not available
		return listTagsLike()
	}
	defer rows.Close()

	var tags []TagStats
	for rows.Next() {
		var t TagStats
		if err := rows.Scan(&t.Tag, &t.Count); err != nil {
			continue
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

func listTagsLike() ([]TagStats, error) {
	rows, err := DB.Query("SELECT id, tags FROM files WHERE tags != '' AND tags IS NOT NULL")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tagCounts := make(map[string]int)
	for rows.Next() {
		var id int
		var tags string
		if err := rows.Scan(&id, &tags); err != nil {
			continue
		}
		for _, t := range strings.Split(tags, ",") {
			t = strings.TrimSpace(t)
			if t != "" {
				tagCounts[t]++
			}
		}
	}

	var result []TagStats
	for tag, count := range tagCounts {
		result = append(result, TagStats{Tag: tag, Count: count})
	}
	return result, nil
}

// AddTagToFile adds a tag to a file's tags list.
func AddTagToFile(filename, tag string) error {
	file, err := GetFileByName(filename)
	if err != nil || file == nil {
		return err
	}
	currentTags := file.Tags
	if currentTags == "" {
		currentTags = tag
	} else {
		// Check if tag already exists
		for _, t := range strings.Split(currentTags, ",") {
			if strings.TrimSpace(t) == tag {
				return nil // tag already exists
			}
		}
		currentTags = currentTags + "," + tag
	}
	_, err = DB.Exec("UPDATE files SET tags = ?, updated_at = ? WHERE filename = ?",
		currentTags, time.Now().Unix(), filename)
	return err
}

// RemoveTagFromFile removes a tag from a file's tags list.
func RemoveTagFromFile(filename, tag string) error {
	file, err := GetFileByName(filename)
	if err != nil || file == nil {
		return err
	}
	currentTags := file.Tags
	var newTags []string
	for _, t := range strings.Split(currentTags, ",") {
		if strings.TrimSpace(t) != tag {
			newTags = append(newTags, t)
		}
	}
	newTagsStr := strings.Join(newTags, ",")
	_, err = DB.Exec("UPDATE files SET tags = ?, updated_at = ? WHERE filename = ?",
		newTagsStr, time.Now().Unix(), filename)
	return err
}

// RenameTag renames a tag across all files.
func RenameTag(oldTag, newTag string) error {
	rows, err := DB.Query("SELECT id, tags FROM files WHERE tags LIKE ?", "%"+oldTag+"%")
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var id int
		var tags string
		if err := rows.Scan(&id, &tags); err != nil {
			continue
		}
		newTags := strings.ReplaceAll(tags, oldTag, newTag)
		newTags = strings.ReplaceAll(newTags, ",,", ",")
		DB.Exec("UPDATE files SET tags = ? WHERE id = ?", newTags, id)
	}
	return nil
}

// MergeTags merges multiple tags into a single tag.
func MergeTags(sourceTags []string, targetTag string) error {
	for _, tag := range sourceTags {
		if tag == targetTag {
			continue
		}
		// Replace occurrences of source tag with target tag
		rows, err := DB.Query("SELECT id, tags FROM files WHERE tags LIKE ?", "%"+tag+"%")
		if err != nil {
			continue
		}
		for rows.Next() {
			var id int
			var tags string
			if err := rows.Scan(&id, &tags); err != nil {
				continue
			}
			// Replace tag (handle comma-separated)
			newTags := strings.ReplaceAll(","+tags+",", ","+tag+",", ","+targetTag+",")
			newTags = strings.Trim(newTags, ",")
			newTags = strings.ReplaceAll(newTags, ",,", ",")
			DB.Exec("UPDATE files SET tags = ? WHERE id = ?", newTags, id)
		}
		rows.Close()
	}
	return nil
}

// TagColor represents a tag's display color.
type TagColor struct {
	Tag      string `json:"tag"`
	Color    string `json:"color"`
	Emoji    string `json:"emoji"`
	LastUsed int64  `json:"lastUsed"`
}

// SetTagColor sets the color for a tag.
func SetTagColor(tag, color, emoji string) error {
	_, err := DB.Exec(`
		INSERT INTO tag_colors (tag, color, emoji, updated_at, last_used)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(tag) DO UPDATE SET color=excluded.color, emoji=excluded.emoji, updated_at=excluded.updated_at`,
		tag, color, emoji, time.Now().Unix(), time.Now().Unix(),
	)
	return err
}

// GetTagColors returns colors for all tags.
func GetTagColors() ([]TagColor, error) {
	rows, err := DB.Query("SELECT tag, color, emoji, last_used FROM tag_colors")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var colors []TagColor
	for rows.Next() {
		var c TagColor
		var emoji sql.NullString
		var lastUsed sql.NullInt64
		if err := rows.Scan(&c.Tag, &c.Color, &emoji, &lastUsed); err != nil {
			continue
		}
		c.Emoji = emoji.String
		if lastUsed.Valid {
			c.LastUsed = lastUsed.Int64
		}
		colors = append(colors, c)
	}
	return colors, rows.Err()
}

// ── Virtual Folders ──────────────────────────────────────────────────

// VirtualFolder represents a virtual folder.
type VirtualFolder struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Color       string `json:"color"`
	Position    int    `json:"position"`
	CreatedAt   int64  `json:"createdAt"`
}

// CreateVirtualFolder creates a new virtual folder.
func CreateVirtualFolder(name, description, color string, position int) (int64, error) {
	if color == "" {
		color = "#667eea"
	}
	result, err := DB.Exec(`
		INSERT INTO virtual_folders (name, description, color, position, created_at)
		VALUES (?, ?, ?, ?, ?)`,
		name, description, color, position, time.Now().Unix(),
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// ListVirtualFolders returns all virtual folders.
func ListVirtualFolders() ([]VirtualFolder, error) {
	rows, err := DB.Query("SELECT id, name, description, color, position, created_at FROM virtual_folders ORDER BY position ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var folders []VirtualFolder
	for rows.Next() {
		var f VirtualFolder
		var description, color sql.NullString
		if err := rows.Scan(&f.ID, &f.Name, &description, &color, &f.Position, &f.CreatedAt); err != nil {
			continue
		}
		f.Description = description.String
		f.Color = color.String
		folders = append(folders, f)
	}
	return folders, rows.Err()
}

// UpdateVirtualFolder updates a virtual folder.
func UpdateVirtualFolder(id int64, name, description, color string, position int) error {
	_, err := DB.Exec(`
		UPDATE virtual_folders SET name=?, description=?, color=?, position=? WHERE id=?`,
		name, description, color, position, id,
	)
	return err
}

// DeleteVirtualFolder deletes a virtual folder.
func DeleteVirtualFolder(id int64) error {
	_, err := DB.Exec("DELETE FROM virtual_folders WHERE id = ?", id)
	return err
}

// AddFileToVirtualFolder adds a file to a virtual folder.
func AddFileToVirtualFolder(folderID, fileID int64) error {
	_, err := DB.Exec(`
		INSERT OR IGNORE INTO virtual_folder_files (folder_id, file_id) VALUES (?, ?)`,
		folderID, fileID,
	)
	return err
}

// RemoveFileFromVirtualFolder removes a file from a virtual folder.
func RemoveFileFromVirtualFolder(folderID, fileID int64) error {
	_, err := DB.Exec("DELETE FROM virtual_folder_files WHERE folder_id = ? AND file_id = ?", folderID, fileID)
	return err
}

// GetVirtualFolderFiles returns all files in a virtual folder.
func GetVirtualFolderFiles(folderID int64) ([]File, error) {
	rows, err := DB.Query(`
		SELECT f.id, f.filename, f.content, f.type, f.size, f.hash, f.tags, f.encrypted, f.starred, f.position, f.created_at, f.updated_at
		FROM files f
		JOIN virtual_folder_files vff ON f.id = vff.file_id
		WHERE vff.folder_id = ?
		ORDER BY vff.added_at DESC`,
		folderID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []File
	for rows.Next() {
		var f File
		var content, hash, tags, typ sql.NullString
		var size, pos, id int64
		var createdAt, updatedAt int64
		if err := rows.Scan(&id, &content, &typ, &size, &hash, &tags, &f.Encrypted, &f.Starred, &pos, &createdAt, &updatedAt); err != nil {
			continue
		}
		f.ID = id
		f.Filename = content.String
		f.Type = typ.String
		f.Size = size
		f.Hash = hash.String
		f.Tags = tags.String
		f.Position = int(pos)
		f.CreatedAt = createdAt
		f.UpdatedAt = updatedAt
		files = append(files, f)
	}
	return files, rows.Err()
}
