package server

import (
	"encoding/json"
	"net/http"
)

// ToolSchemas returns ShareTool's tool/function schemas for AI agent registration
// Consumed by AI agents like Hermes/OpenClaw to understand available actions
func HandleToolSchemas(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"tools": []map[string]any{
			{
				"name":        "share_text",
				"description": "将文本内容分享到局域网，所有连接的设备都能看到，并在本地保存历史记录",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"content": map[string]string{"type": "string", "description": "要分享的文本内容"},
					},
					"required": []string{"content"},
				},
				"example": map[string]string{"content": "Hello from ShareTool!"},
			},
			{
				"name":        "get_text_history",
				"description": "获取文本分享历史记录（按时间倒序，最多200条）",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"page":  map[string]any{"type": "integer", "description": "页码（从1开始，默认1）"},
						"size":  map[string]any{"type": "integer", "description": "每页条数（默认50，最大100）"},
					},
				},
				"example": map[string]any{"page": 1, "size": 50},
			},
			{
				"name":        "delete_text_entry",
				"description": "删除单条文本历史记录",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id": map[string]string{"type": "string", "description": "要删除的记录ID"},
					},
					"required": []string{"id"},
				},
				"example": map[string]string{"id": "a1b2c3d4e5f6"},
			},
			{
				"name":        "clear_text_history",
				"description": "清空全部文本历史记录",
				"input_schema": map[string]any{
					"type": "object",
					"properties":  map[string]any{},
				},
				"example": map[string]any{},
			},
			{
				"name":        "list_files",
				"description": "列出当前共享目录中的所有文件（按修改时间倒序）",
				"input_schema": map[string]any{
					"type": "object",
					"properties":  map[string]any{},
				},
				"example": map[string]any{},
			},
			{
				"name":        "upload_file",
				"description": "上传文件到共享目录，支持大文件分片断点续传",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"filename": map[string]string{"type": "string", "description": "文件名"},
						"content":  map[string]string{"type": "string", "description": "文件内容（base64编码）"},
					},
					"required": []string{"filename", "content"},
				},
				"example": map[string]string{"filename": "report.pdf", "content": "(base64)"},
			},
			{
				"name":        "download_file",
				"description": "从共享目录下载文件",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"filename": map[string]string{"type": "string", "description": "要下载的文件名"},
					},
					"required": []string{"filename"},
				},
				"example": map[string]string{"filename": "report.pdf"},
			},
			{
				"name":        "batch_delete_files",
				"description": "批量删除共享目录中的文件",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"names": map[string]any{"type": "array", "items": map[string]string{"type": "string"}, "description": "要删除的文件名数组"},
					},
					"required": []string{"names"},
				},
				"example": map[string]any{"names": []string{"old.pdf", "temp.txt"}},
			},
		},
		"endpoints": map[string]string{
			"text_share":         "POST /api/text",
			"text_history":       "GET  /api/text",
			"text_delete":        "DELETE /api/text?id=... 或 DELETE /api/text?all=true",
			"files_list":         "GET  /api/files",
			"file_upload":        "PUT  /api/files/:name",
			"file_get":           "GET  /api/files/:name",
			"file_delete_single": "DELETE /api/files/:name",
			"file_batch_delete":  "DELETE /api/files",
			"qr_code":            "GET  /api/qr?url=...",
			"openapi":            "GET  /openapi.json",
			"tools":              "GET  /tools.json",
		},
		"cli_examples": map[string]string{
			"upload":        "curl -T file.zip http://localhost:18790/api/files/file.zip",
			"download":     "curl -O http://localhost:18790/api/files/file.zip",
			"list_files":   "curl http://localhost:18790/api/files",
			"text_share":   "curl -X POST http://localhost:18790/api/text -H 'Content-Type: application/json' -d '{\"content\":\"hello\"}'",
			"text_history": "curl http://localhost:18790/api/text",
			"batch_delete": "curl -X DELETE http://localhost:18790/api/files -H 'Content-Type: application/json' -d '{\"names\":[\"a.txt\",\"b.txt\"]}'",
		},
	})
}

// HandleTools is the HTTP handler for /tools.json
func HandleTools(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"tools": []map[string]any{
			{
				"name":        "share_text",
				"description": "将文本内容分享到局域网，所有连接的设备都能看到，并在本地保存历史记录",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"content": map[string]string{"type": "string"},
					},
					"required": []string{"content"},
				},
			},
			{
				"name":        "get_text_history",
				"description": "获取文本分享历史记录",
				"input_schema": map[string]any{
					"type":       "object",
					"properties": map[string]any{},
				},
			},
			{
				"name":        "delete_text_entry",
				"description": "删除单条文本历史记录",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id": map[string]string{"type": "string"},
					},
					"required": []string{"id"},
				},
			},
			{
				"name":        "clear_text_history",
				"description": "清空全部文本历史记录",
				"input_schema": map[string]any{
					"type":       "object",
					"properties": map[string]any{},
				},
			},
			{
				"name":        "list_files",
				"description": "列出共享目录中的文件",
				"input_schema": map[string]any{
					"type":       "object",
					"properties": map[string]any{},
				},
			},
			{
				"name":        "upload_file",
				"description": "上传文件到共享目录",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"filename": map[string]string{"type": "string"},
						"content":  map[string]string{"type": "string"},
					},
					"required": []string{"filename", "content"},
				},
			},
			{
				"name":        "download_file",
				"description": "下载共享文件",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"filename": map[string]string{"type": "string"},
					},
					"required": []string{"filename"},
				},
			},
			{
				"name":        "batch_delete_files",
				"description": "批量删除文件",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"names": map[string]any{"type": "array", "items": map[string]string{"type": "string"}},
					},
					"required": []string{"names"},
				},
			},
		},
		"endpoints": map[string]string{
			"text_share":         "POST http://IP:18790/api/text",
			"text_history":       "GET  http://IP:18790/api/text",
			"text_delete":        "DELETE http://IP:18790/api/text?id=...",
			"text_clear":         "DELETE http://IP:18790/api/text?all=true",
			"files_list":         "GET  http://IP:18790/api/files",
			"file_upload":        "PUT  http://IP:18790/api/files/:name",
			"file_get":           "GET  http://IP:18790/api/files/:name",
			"file_delete_single": "DELETE http://IP:18790/api/files/:name",
			"file_batch_delete":  "DELETE http://IP:18790/api/files",
			"qr_code":            "GET  http://IP:18790/api/qr?url=...",
			"openapi":            "GET  http://IP:18790/openapi.json",
			"tools":              "GET  http://IP:18790/tools.json",
		},
	})
}
