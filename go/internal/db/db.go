package db

import (
	"database/sql"
	"log/slog"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

var (
	DB   *sql.DB
	log  = slog.Default()
	path string
)

// Init opens or creates the SQLite database at the given path.
// Schema is initialized automatically.
func Init(dbPath string) error {
	path = dbPath

	// Ensure directory exists
	if err := os.MkdirAll(filepath.Dir(dbPath), 0755); err != nil {
		return err
	}

	var err error
	DB, err = sql.Open("sqlite", dbPath+"?_journal=WAL&_busy_timeout=5000&_synchronous=NORMAL")
	if err != nil {
		return err
	}

	// Enable foreign keys
	if _, err := DB.Exec("PRAGMA foreign_keys = ON"); err != nil {
		return err
	}

	if err := initSchema(); err != nil {
		return err
	}

	log.Info("database initialized", "path", dbPath)
	return nil
}

func GetDB() *sql.DB { return DB }

func Close() error {
	if DB != nil {
		return DB.Close()
	}
	return nil
}

func initSchema() error {
	schema := []string{
		// Meta table (key-value store)
		`CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT
		)`,

		// Files table
		`CREATE TABLE IF NOT EXISTS files (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			filename TEXT NOT NULL UNIQUE,
			content TEXT,
			type TEXT NOT NULL DEFAULT 'file',
			size INTEGER NOT NULL DEFAULT 0,
			hash TEXT,
			tags TEXT DEFAULT '',
			encrypted INTEGER NOT NULL DEFAULT 0,
			starred INTEGER NOT NULL DEFAULT 0,
			position INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		)`,

		// FTS5 virtual table for full-text search
		`CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
			filename, tags, content='files', content_rowid='id'
		)`,

		// Triggers to keep FTS in sync
		`CREATE TRIGGER IF NOT EXISTS files_fts_insert AFTER INSERT ON files BEGIN
			INSERT INTO files_fts(rowid, filename, tags) VALUES (new.id, new.filename, new.tags);
		END`,
		`CREATE TRIGGER IF NOT EXISTS files_fts_delete AFTER DELETE ON files BEGIN
			INSERT INTO files_fts(files_fts, rowid, filename, tags) VALUES('delete', old.id, old.filename, old.tags);
		END`,
		`CREATE TRIGGER IF NOT EXISTS files_fts_update AFTER UPDATE ON files BEGIN
			INSERT INTO files_fts(files_fts, rowid, filename, tags) VALUES('delete', old.id, old.filename, old.tags);
			INSERT INTO files_fts(rowid, filename, tags) VALUES (new.id, new.filename, new.tags);
		END`,

		// File versions
		`CREATE TABLE IF NOT EXISTS file_versions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			file_id INTEGER NOT NULL,
			filename TEXT NOT NULL,
			content TEXT,
			size INTEGER NOT NULL DEFAULT 0,
			hash TEXT,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_file_versions_file_id ON file_versions(file_id)`,

		// Virtual folders
		`CREATE TABLE IF NOT EXISTS virtual_folders (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			color TEXT DEFAULT '',
			position INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		)`,

		// Virtual folder files (many-to-many)
		`CREATE TABLE IF NOT EXISTS virtual_folder_files (
			folder_id INTEGER NOT NULL,
			file_id INTEGER NOT NULL,
			position INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (folder_id, file_id),
			FOREIGN KEY (folder_id) REFERENCES virtual_folders(id) ON DELETE CASCADE,
			FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
		)`,

		// Devices
		`CREATE TABLE IF NOT EXISTS devices (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			device_id TEXT NOT NULL UNIQUE,
			device_name TEXT,
			ip TEXT,
			port INTEGER DEFAULT 18792,
			last_seen INTEGER NOT NULL DEFAULT (unixepoch()),
			is_online INTEGER NOT NULL DEFAULT 1,
			last_sync_at INTEGER,
			synced_files INTEGER DEFAULT 0
		)`,

		// Tokens
		`CREATE TABLE IF NOT EXISTS tokens (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			token TEXT NOT NULL UNIQUE,
			refresh_token TEXT,
			refresh_token_expires_at INTEGER,
			device_id TEXT,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		)`,

		// Share links
		`CREATE TABLE IF NOT EXISTS share_links (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			code TEXT NOT NULL UNIQUE,
			filename TEXT NOT NULL,
			is_text INTEGER NOT NULL DEFAULT 0,
			password TEXT,
			expires_at INTEGER NOT NULL,
			max_downloads INTEGER,
			download_count INTEGER NOT NULL DEFAULT 0,
			description TEXT DEFAULT '',
			label TEXT,
			view_count INTEGER NOT NULL DEFAULT 0,
			theme_color TEXT,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			created_by TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_share_links_code ON share_links(code)`,

		// Request links (public upload)
		`CREATE TABLE IF NOT EXISTS request_links (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			code TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			target_folder TEXT NOT NULL DEFAULT '',
			password TEXT,
			max_uploads INTEGER,
			upload_count INTEGER NOT NULL DEFAULT 0,
			expires_at INTEGER,
			active INTEGER NOT NULL DEFAULT 1,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			created_by TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_request_links_code ON request_links(code)`,
		`CREATE INDEX IF NOT EXISTS idx_request_links_active ON request_links(active)`,

		// Audit log
		`CREATE TABLE IF NOT EXISTS audit_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			action TEXT NOT NULL,
			details TEXT,
			ip TEXT,
			token TEXT,
			timestamp INTEGER NOT NULL DEFAULT (unixepoch())
		)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)`,

		// File access log
		`CREATE TABLE IF NOT EXISTS file_access_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			file_id INTEGER NOT NULL,
			action TEXT NOT NULL,
			ip TEXT,
			timestamp INTEGER NOT NULL DEFAULT (unixepoch())
		)`,
		`CREATE INDEX IF NOT EXISTS idx_file_access_log_file_id ON file_access_log(file_id)`,

		// Rate limiting
		`CREATE TABLE IF NOT EXISTS rate_limit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			key TEXT NOT NULL UNIQUE,
			attempts INTEGER NOT NULL DEFAULT 0,
			locked_until INTEGER,
			last_attempt INTEGER NOT NULL DEFAULT (unixepoch())
		)`,

		// Notifications
		`CREATE TABLE IF NOT EXISTS notifications (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL,
			title TEXT NOT NULL,
			body TEXT,
			read INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL DEFAULT (unixepoch())
		)`,

		// Tag colors
		`CREATE TABLE IF NOT EXISTS tag_colors (
			tag TEXT PRIMARY KEY,
			color TEXT NOT NULL,
			emoji TEXT,
			updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
			last_used INTEGER
		)`,

		// Search history
		`CREATE TABLE IF NOT EXISTS search_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			query TEXT NOT NULL,
			timestamp INTEGER NOT NULL DEFAULT (unixepoch())
		)`,
	}

	for _, s := range schema {
		if _, err := DB.Exec(s); err != nil {
			return err
		}
	}

	return nil
}

// LogAudit records an audit log entry.
func LogAudit(action, details, ip, token string) error {
	_, err := DB.Exec(
		"INSERT INTO audit_log (action, details, ip, token) VALUES (?, ?, ?, ?)",
		action, details, ip, token,
	)
	return err
}
