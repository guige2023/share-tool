package server

import (
	"encoding/json"
	"net/http"
)

// ToolSchemas returns ShareTool's tool/function schemas for AI agent registration
// This is consumed by AI agents like Hermes/OpenClaw to understand available actions
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
				"description": "将文本内容分享到局域网，所有连接的设备都能看到",
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
				"name":        "get_latest_text",
				"description": "获取局域网内其他设备分享的最新文本",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{},
				},
				"example": map[string]any{},
			},
			{
				"name":        "list_files",
				"description": "列出当前共享目录中的所有文件",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{},
				},
				"example": map[string]any{},
			},
			{
				"name":        "upload_file",
				"description": "上传文件到共享目录，支持大文件断点续传",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"filename": map[string]string{"type": "string", "description": "文件名"},
						"content":  map[string]string{"type": "string", "description": "文件内容（base64 或原始）"},
					},
					"required": []string{"filename", "content"},
				},
				"example": map[string]string{"filename": "report.pdf", "content": "(binary)"},
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
				"name":        "delete_file",
				"description": "从共享目录删除文件",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"filename": map[string]string{"type": "string", "description": "要删除的文件名"},
					},
					"required": []string{"filename"},
				},
				"example": map[string]string{"filename": "old_report.pdf"},
			},
			{
				"name":        "list_devices",
				"description": "列出局域网内发现的其他 ShareTool 设备",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{},
				},
				"example": map[string]any{},
			},
		},
		"endpoints": map[string]string{
			"text_share":  "POST /api/text",
			"text_latest": "GET /api/text/latest",
			"files_list":  "GET /api/files",
			"file_upload": "PUT /api/files/:name",
			"file_get":    "GET /api/files/:name",
			"file_delete": "DELETE /api/files/:name",
			"peers_list":  "GET /api/peers",
			"peers_reg":   "POST /api/peers",
			"openapi":     "GET /openapi.json",
			"tools":       "GET /tools.json",
		},
		"cli_examples": map[string]string{
			"upload":    "curl -T file.zip http://localhost:18790/api/files/file.zip",
			"download": "curl -O http://localhost:18790/api/files/file.zip",
			"text":     "curl -X POST http://localhost:18790/api/text -d '{\"content\":\"hello\"}'",
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
				"description": "将文本内容分享到局域网，所有连接的设备都能看到",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"content": map[string]string{"type": "string"},
					},
					"required": []string{"content"},
				},
			},
			{
				"name":        "get_latest_text",
				"description": "获取最新分享的文本",
				"input_schema": map[string]any{"type": "object", "properties": map[string]any{}},
			},
			{
				"name":        "list_files",
				"description": "列出共享目录中的文件",
				"input_schema": map[string]any{"type": "object", "properties": map[string]any{}},
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
				"name":        "delete_file",
				"description": "删除共享文件",
				"input_schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"filename": map[string]string{"type": "string"},
					},
					"required": []string{"filename"},
				},
			},
			{
				"name":        "list_devices",
				"description": "列出局域网设备",
				"input_schema": map[string]any{"type": "object", "properties": map[string]any{}},
			},
		},
		"endpoints": map[string]string{
			"text_share":  "POST http://IP:18790/api/text",
			"text_latest": "GET http://IP:18790/api/text/latest",
			"files_list":  "GET http://IP:18790/api/files",
			"file_upload": "PUT http://IP:18790/api/files/:name",
			"file_get":    "GET http://IP:18790/api/files/:name",
			"file_delete": "DELETE http://IP:18790/api/files/:name",
			"peers_list":  "GET http://IP:18790/api/peers",
			"openapi":     "GET http://IP:18790/openapi.json",
			"tools":       "GET http://IP:18790/tools.json",
		},
	})
}
