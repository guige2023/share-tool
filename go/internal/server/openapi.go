package server

import (
	"encoding/json"
	"net/http"
)

// OpenAPI 3.0 schema for ShareTool API
func HandleOpenAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(openAPISchema())
}

func openAPISchema() map[string]any {
	return map[string]any{
		"openapi": "3.0.0",
		"info": map[string]string{
			"title":       "ShareTool API",
			"description": "极简局域网分享工具 REST API",
			"version":     "1.0.0",
		},
		"servers": []map[string]string{
			{"url": "http://localhost:18790", "description": "本地服务"},
		},
		"paths": map[string]map[string]any{
			"/api/text": map[string]any{
				"post": map[string]any{
					"summary": "分享文本",
					"requestBody": map[string]any{
						"required": true,
						"content": map[string]any{
							"application/json": map[string]any{
								"schema": map[string]any{
									"type": "object",
									"properties": map[string]any{
										"content": map[string]any{"type": "string"},
									},
								},
							},
						},
					},
					"responses": map[string]any{
						"200": map[string]string{"description": "成功"},
					},
				},
			},
			"/api/text/latest": map[string]any{
				"get": map[string]any{
					"summary": "获取最新文本",
					"responses": map[string]any{
						"200": map[string]any{
							"description": "最新文本",
							"content": map[string]any{
								"application/json": map[string]any{
									"schema": map[string]any{
										"type": "object",
										"properties": map[string]any{
											"content":   map[string]any{"type": "string"},
											"timestamp": map[string]any{"type": "integer"},
										},
									},
								},
							},
						},
					},
				},
			},
			"/api/files": map[string]any{
				"get": map[string]any{
					"summary": "获取文件列表",
					"responses": map[string]any{
						"200": map[string]any{
							"description": "文件列表",
							"content": map[string]any{
								"application/json": map[string]any{
									"schema": map[string]any{
										"type": "object",
										"properties": map[string]any{
											"files": map[string]any{
												"type": "array",
												"items": map[string]any{
													"type": "object",
													"properties": map[string]any{
														"name":      map[string]any{"type": "string"},
														"size":      map[string]any{"type": "integer"},
														"updatedAt": map[string]any{"type": "integer"},
													},
												},
											},
										},
									},
								},
							},
						},
					},
				},
			},
			"/api/files/{name}": map[string]any{
				"get": map[string]any{
					"summary": "下载文件",
					"parameters": []map[string]any{
						{"name": "name", "in": "path", "required": true, "schema": map[string]any{"type": "string"}},
					},
					"responses": map[string]any{
						"200": map[string]string{"description": "文件内容"},
					},
				},
				"put": map[string]any{
					"summary": "上传文件（支持断点续传）",
					"parameters": []map[string]any{
						{"name": "name", "in": "path", "required": true, "schema": map[string]any{"type": "string"}},
					},
					"requestBody": map[string]any{
						"required": true,
						"content": map[string]any{
							"application/octet-stream": map[string]any{
								"schema": map[string]any{"type": "string", "format": "binary"},
							},
						},
					},
					"responses": map[string]any{
						"200": map[string]any{
							"description": "上传成功",
							"content": map[string]any{
								"application/json": map[string]any{
									"schema": map[string]any{
										"type": "object",
										"properties": map[string]any{
											"success": map[string]any{"type": "boolean"},
											"size":    map[string]any{"type": "integer"},
										},
									},
								},
							},
						},
					},
				},
				"delete": map[string]any{
					"summary": "删除文件",
					"parameters": []map[string]any{
						{"name": "name", "in": "path", "required": true, "schema": map[string]any{"type": "string"}},
					},
					"responses": map[string]any{
						"200": map[string]string{"description": "删除成功"},
					},
				},
			},
			"/api/clipboard": map[string]any{
				"get": map[string]any{
					"summary": "获取剪贴板历史",
					"responses": map[string]any{
						"200": map[string]string{"description": "剪贴板历史列表"},
					},
				},
				"post": map[string]any{
					"summary": "发送剪贴板（自动转发给所有在线设备）",
					"requestBody": map[string]any{
						"required": true,
						"content": map[string]any{
							"application/json": map[string]any{
								"schema": map[string]any{
									"type": "object",
									"properties": map[string]any{
										"type":      map[string]any{"type": "string", "enum": []any{"text", "image", "files"}},
										"content":   map[string]any{"type": "string"},
										"from":      map[string]any{"type": "string"},
										"timestamp": map[string]any{"type": "integer"},
									},
								},
							},
						},
					},
					"responses": map[string]any{
						"200": map[string]string{"description": "成功"},
					},
				},
				"delete": map[string]any{
					"summary": "清空剪贴板历史",
					"responses": map[string]any{
						"200": map[string]string{"description": "成功"},
					},
				},
			},
			"/api/clipboard/latest": map[string]any{
				"get": map[string]any{
					"summary": "获取最新剪贴板条目",
					"responses": map[string]any{
						"200": map[string]string{"description": "最新剪贴板条目"},
					},
				},
			},
			"/api/clipboard/receive": map[string]any{
				"post": map[string]any{
					"summary": "接收来自其他设备的剪贴板",
					"responses": map[string]any{
						"200": map[string]string{"description": "成功"},
					},
				},
			},
			"/api/peers": map[string]any{
				"get": map[string]any{
					"summary": "获取设备列表",
					"responses": map[string]any{
						"200": map[string]string{"description": "设备列表"},
					},
				},
				"post": map[string]any{
					"summary": "注册设备",
					"responses": map[string]any{
						"200": map[string]string{"description": "注册成功"},
					},
				},
			},
			"/openapi.json": map[string]any{
				"get": map[string]any{
					"summary": "OpenAPI 3.0 Schema",
					"responses": map[string]any{
						"200": map[string]string{"description": "OpenAPI JSON schema"},
					},
				},
			},
		},
	}
}
