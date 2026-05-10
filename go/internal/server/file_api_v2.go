package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// ── Tags API ─────────────────────────────────────────────────────────

func handleTagsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	tags, err := listTagsAPI()
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	colors, _ := getTagColorsAPI()
	// Merge tags with colors
	for i := range tags {
		for _, c := range colors {
			if tags[i].Tag == c.Tag {
				tags[i].Color = c.Color
				tags[i].Emoji = c.Emoji
				break
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "tags": tags})
}

func handleTagsCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		Tag   string `json:"tag"`
		Color string `json:"color"`
		Emoji string `json:"emoji"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	if req.Tag == "" {
		http.Error(w, `{"error":"tag required"}`, 400)
		return
	}
	if req.Color == "" {
		req.Color = "#667eea"
	}
	err := setTagColorAPI(req.Tag, req.Color, req.Emoji)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func handleTagsUpdateColor(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		Tag   string `json:"tag"`
		Color string `json:"color"`
		Emoji string `json:"emoji"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	err := setTagColorAPI(req.Tag, req.Color, req.Emoji)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func handleTagsDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	tag := strings.TrimPrefix(r.URL.Path, "/api/tags/")
	tag = strings.TrimSuffix(tag, "/delete")
	if tag == "" {
		http.Error(w, `{"error":"tag required"}`, 400)
		return
	}
	// Remove tag from all files
	err := removeTagFromAllFiles(tag)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func handleTagsRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		OldTag string `json:"oldTag"`
		NewTag string `json:"newTag"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	err := renameTagInAllFiles(req.OldTag, req.NewTag)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func handleTagsMerge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		SourceTags []string `json:"sourceTags"`
		TargetTag string    `json:"targetTag"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	err := mergeTagsInAllFiles(req.SourceTags, req.TargetTag)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

// ── Starred Files ───────────────────────────────────────────────────

func handleStarredList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	files, err := listStarredFiles()
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "files": files})
}

func handleFileStar(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		Filename string `json:"filename"`
		Starred  bool  `json:"starred"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	err := setFileStarred(req.Filename, req.Starred)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

// ── Virtual Folders API ─────────────────────────────────────────────

func handleVirtualFoldersList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	folders, err := listVirtualFoldersAPI()
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "folders": folders})
}

func handleVirtualFolderCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Color      string `json:"color"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	id, err := createVirtualFolderAPI(req.Name, req.Description, req.Color)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "id": id})
}

func handleVirtualFolderUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	idStr := strings.TrimPrefix(r.URL.Path, "/api/folders/")
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Color      string `json:"color"`
		Position   int    `json:"position"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, `{"error":"invalid id"}`, 400)
		return
	}
	err = updateVirtualFolderAPI(id, req.Name, req.Description, req.Color, req.Position)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func handleVirtualFolderDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	idStr := strings.TrimPrefix(r.URL.Path, "/api/folders/")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, `{"error":"invalid id"}`, 400)
		return
	}
	err = deleteVirtualFolderAPI(id)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func handleVirtualFolderFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	idStr := strings.TrimPrefix(r.URL.Path, "/api/folders/")
	idStr = strings.TrimSuffix(idStr, "/files")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, `{"error":"invalid id"}`, 400)
		return
	}
	files, err := getVirtualFolderFilesAPI(id)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "files": files})
}

func handleVirtualFolderAddFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	path := r.URL.Path
	// /api/folders/:id/files
	idStr := strings.TrimPrefix(path, "/api/folders/")
	idStr = strings.TrimSuffix(idStr, "/files")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, `{"error":"invalid folder id"}`, 400)
		return
	}
	var req struct {
		Filename string `json:"filename"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	file, err := getFileByNameAPI(req.Filename)
	if err != nil || file == nil {
		http.Error(w, `{"error":"file not found"}`, 404)
		return
	}
	err = addFileToVirtualFolderAPI(id, file.ID)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func handleVirtualFolderRemoveFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	// /api/folders/:id/files/:filename
	path := r.URL.Path
	parts := strings.Split(path, "/")
	if len(parts) < 6 {
		http.Error(w, `{"error":"invalid path"}`, 400)
		return
	}
	folderID, err := strconv.ParseInt(parts[3], 10, 64)
	if err != nil {
		http.Error(w, `{"error":"invalid folder id"}`, 400)
		return
	}
	filename := parts[5]
	file, err := getFileByNameAPI(filename)
	if err != nil || file == nil {
		http.Error(w, `{"error":"file not found"}`, 404)
		return
	}
	err = removeFileFromVirtualFolderAPI(folderID, file.ID)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

// ── Trash API ──────────────────────────────────────────────────────

func handleTrashList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	entries, err := listTrashAPI()
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "trash": entries})
}

func handleTrashRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		TrashID int64 `json:"trashId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	err := restoreFromTrashAPI(req.TrashID)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func handleTrashDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var req struct {
		TrashID int64 `json:"trashId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, 400)
		return
	}
	err := permanentlyDeleteTrashAPI(req.TrashID)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func handleTrashEmpty(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	n, err := emptyTrashAPI()
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"success": true, "deleted": n})
}

// ── DB Helpers for API ─────────────────────────────────────────────

type tagItem struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
	Color string `json:"color,omitempty"`
	Emoji string `json:"emoji,omitempty"`
}

func listTagsAPI() ([]tagItem, error) {
	rows, err := db.Query(`
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
		return listTagsLikeFallback()
	}
	defer rows.Close()

	var tags = []tagItem{}
	for rows.Next() {
		var t tagItem
		if err := rows.Scan(&t.Tag, &t.Count); err != nil {
			continue
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

func listTagsLikeFallback() ([]tagItem, error) {
	rows, err := db.Query("SELECT id, tags FROM files WHERE tags != '' AND tags IS NOT NULL")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := make(map[string]int)
	for rows.Next() {
		var id int
		var tags string
		if err := rows.Scan(&id, &tags); err != nil {
			continue
		}
		for _, t := range strings.Split(tags, ",") {
			t = strings.TrimSpace(t)
			if t != "" {
				counts[t]++
			}
		}
	}
	var result []tagItem
	for tag, count := range counts {
		result = append(result, tagItem{Tag: tag, Count: count})
	}
	return result, nil
}

type tagColorItem struct {
	Tag   string `json:"tag"`
	Color string `json:"color"`
	Emoji string `json:"emoji"`
}

func getTagColorsAPI() ([]tagColorItem, error) {
	rows, err := db.Query("SELECT tag, color, emoji FROM tag_colors")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var colors []tagColorItem
	for rows.Next() {
		var c tagColorItem
		var emoji sql.NullString
		if err := rows.Scan(&c.Tag, &c.Color, &emoji); err != nil {
			continue
		}
		c.Emoji = emoji.String
		colors = append(colors, c)
	}
	return colors, rows.Err()
}

func setTagColorAPI(tag, color, emoji string) error {
	_, err := db.Exec(`
		INSERT INTO tag_colors (tag, color, emoji, updated_at, last_used)
		VALUES (?, ?, ?, unixepoch(), unixepoch())
		ON CONFLICT(tag) DO UPDATE SET color=excluded.color, emoji=excluded.emoji, updated_at=excluded.updated_at`,
		tag, color, emoji,
	)
	return err
}

func removeTagFromAllFiles(tag string) error {
	rows, err := db.Query("SELECT id, tags FROM files WHERE tags LIKE ?", "%"+tag+"%")
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
		newTags := strings.TrimSuffix(strings.TrimPrefix(strings.ReplaceAll(","+tags+",", ","+tag+",", ","), ","), ",")
		newTags = strings.ReplaceAll(newTags, ",,", ",")
		db.Exec("UPDATE files SET tags = ? WHERE id = ?", newTags, id)
	}
	return nil
}

func renameTagInAllFiles(oldTag, newTag string) error {
	rows, err := db.Query("SELECT id, tags FROM files WHERE tags LIKE ?", "%"+oldTag+"%")
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
		newTags := strings.ReplaceAll(","+tags+",", ","+oldTag+",", ","+newTag+",")
		newTags = strings.Trim(newTags, ",")
		newTags = strings.ReplaceAll(newTags, ",,", ",")
		db.Exec("UPDATE files SET tags = ? WHERE id = ?", newTags, id)
	}
	return nil
}

func mergeTagsInAllFiles(sourceTags []string, targetTag string) error {
	for _, st := range sourceTags {
		if st == targetTag {
			continue
		}
		rows, err := db.Query("SELECT id, tags FROM files WHERE tags LIKE ?", "%"+st+"%")
		if err != nil {
			continue
		}
		for rows.Next() {
			var id int
			var tags string
			if err := rows.Scan(&id, &tags); err != nil {
				continue
			}
			// Remove source tag, ensure target tag exists
			newTags := strings.ReplaceAll(","+tags+",", ","+st+",", ",")
			if !strings.Contains(newTags, targetTag) {
				newTags = newTags + "," + targetTag
			}
			newTags = strings.Trim(newTags, ",")
			newTags = strings.ReplaceAll(newTags, ",,", ",")
			db.Exec("UPDATE files SET tags = ? WHERE id = ?", newTags, id)
		}
		rows.Close()
	}
	return nil
}

type starredFileInfo struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	UpdatedAt int64  `json:"updatedAt"`
}

func listStarredFiles() ([]starredFileInfo, error) {
	rows, err := db.Query(`
		SELECT filename, size, updated_at FROM files
		WHERE starred = 1
		ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var files = []starredFileInfo{}
	for rows.Next() {
		var f starredFileInfo
		if err := rows.Scan(&f.Name, &f.Size, &f.UpdatedAt); err != nil {
			continue
		}
		files = append(files, f)
	}
	return files, rows.Err()
}

func setFileStarred(filename string, starred bool) error {
	v := 0
	if starred {
		v = 1
	}
	_, err := db.Exec("UPDATE files SET starred = ?, updated_at = unixepoch() WHERE filename = ?", v, filename)
	return err
}

type virtualFolderInfo struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Color       string `json:"color"`
	Position    int    `json:"position"`
}

func listVirtualFoldersAPI() ([]virtualFolderInfo, error) {
	rows, err := db.Query("SELECT id, name, description, color, position FROM virtual_folders ORDER BY position ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var folders = []virtualFolderInfo{}
	for rows.Next() {
		var f virtualFolderInfo
		var desc, color sql.NullString
		if err := rows.Scan(&f.ID, &f.Name, &desc, &color, &f.Position); err != nil {
			continue
		}
		f.Description = desc.String
		f.Color = color.String
		folders = append(folders, f)
	}
	return folders, rows.Err()
}

func createVirtualFolderAPI(name, desc, color string) (int64, error) {
	if color == "" {
		color = "#667eea"
	}
	var maxPos int
	db.QueryRow("SELECT COALESCE(MAX(position), 0) FROM virtual_folders").Scan(&maxPos)
	result, err := db.Exec(`
		INSERT INTO virtual_folders (name, description, color, position, created_at)
		VALUES (?, ?, ?, ?, unixepoch())`,
		name, desc, color, maxPos+1,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func updateVirtualFolderAPI(id int64, name, desc, color string, pos int) error {
	_, err := db.Exec(`
		UPDATE virtual_folders SET name=?, description=?, color=?, position=? WHERE id=?`,
		name, desc, color, pos, id,
	)
	return err
}

func deleteVirtualFolderAPI(id int64) error {
	_, err := db.Exec("DELETE FROM virtual_folders WHERE id = ?", id)
	return err
}

func getVirtualFolderFilesAPI(folderID int64) ([]FileInfo, error) {
	rows, err := db.Query(`
		SELECT f.filename, f.size, f.updated_at, f.type, f.tags, f.starred
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
	var files []FileInfo
	for rows.Next() {
		var f FileInfo
		var tags sql.NullString
		var starred int
		if err := rows.Scan(&f.Name, &f.Size, &f.UpdatedAt, &f.IsDir, &tags, &starred); err != nil {
			continue
		}
		f.Starred = starred == 1
		f.Tags = tags.String
		files = append(files, f)
	}
	return files, rows.Err()
}

func addFileToVirtualFolderAPI(folderID, fileID int64) error {
	_, err := db.Exec(`
		INSERT OR IGNORE INTO virtual_folder_files (folder_id, file_id) VALUES (?, ?)`,
		folderID, fileID,
	)
	return err
}

func removeFileFromVirtualFolderAPI(folderID, fileID int64) error {
	_, err := db.Exec("DELETE FROM virtual_folder_files WHERE folder_id = ? AND file_id = ?", folderID, fileID)
	return err
}

type trashInfo struct {
	ID        int64  `json:"id"`
	Filename  string `json:"filename"`
	Size      int64  `json:"size"`
	DeletedAt int64  `json:"deletedAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

func listTrashAPI() ([]trashInfo, error) {
	rows, err := db.Query("SELECT id, filename, size, deleted_at, expires_at FROM trash ORDER BY deleted_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var entries = []trashInfo{}
	for rows.Next() {
		var e trashInfo
		if err := rows.Scan(&e.ID, &e.Filename, &e.Size, &e.DeletedAt, &e.ExpiresAt); err != nil {
			continue
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

func restoreFromTrashAPI(trashID int64) error {
	var filename string
	var content sql.NullString
	var size int64
	var typ, hash sql.NullString
	err := db.QueryRow("SELECT filename, content, size, type, hash FROM trash WHERE id = ?", trashID).Scan(&filename, &content, &size, &typ, &hash)
	if err != nil {
		return err
	}

	// Write back to disk
	if content.Valid && content.String != "" {
		fpath := filepath.Join(sharedDir, filename)
		os.MkdirAll(filepath.Dir(fpath), 0755)
		os.WriteFile(fpath, []byte(content.String), 0644)
	}

	// Restore to files table
	_, err = db.Exec(`
		INSERT INTO files (filename, content, type, size, hash, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
		ON CONFLICT(filename) DO UPDATE SET content=excluded.content, size=excluded.size, updated_at=unixepoch()`,
		filename, content.String, typ.String, size, hash.String,
	)
	if err != nil {
		return err
	}

	_, err = db.Exec("DELETE FROM trash WHERE id = ?", trashID)
	return err
}

func permanentlyDeleteTrashAPI(trashID int64) error {
	_, err := db.Exec("DELETE FROM trash WHERE id = ?", trashID)
	return err
}

func emptyTrashAPI() (int, error) {
	result, err := db.Exec("DELETE FROM trash")
	if err != nil {
		return 0, err
	}
	n, _ := result.RowsAffected()
	return int(n), nil
}

func getFileByNameAPI(filename string) (*struct{ ID int64 }, error) {
	var id int64
	err := db.QueryRow("SELECT id FROM files WHERE filename = ?", filename).Scan(&id)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &struct{ ID int64 }{ID: id}, nil
}
