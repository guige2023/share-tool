namespace ShareToolClipboardSync;

using System.Text.Json.Serialization;

/// <summary>
/// ClipboardEntry v2 — matches Go server's unified protocol
/// </summary>
public class ClipboardEntry
{
    [JsonPropertyName("entry_id")]
    public string? entry_id { get; set; }

    [JsonPropertyName("device_id")]
    public string? device_id { get; set; }

    [JsonPropertyName("type")]
    public string? @type { get; set; }

    [JsonPropertyName("mime")]
    public string? mime { get; set; }

    [JsonPropertyName("text")]
    public string? text { get; set; }

    [JsonPropertyName("files")]
    public List<FileMeta>? files { get; set; }

    [JsonPropertyName("blob_url")]
    public string? blob_url { get; set; }

    [JsonPropertyName("sha256")]
    public string? sha256 { get; set; }

    [JsonPropertyName("from")]
    public string? from { get; set; }

    [JsonPropertyName("timestamp")]
    public long timestamp { get; set; }
}

public class FileMeta
{
    [JsonPropertyName("name")]
    public string name { get; set; } = "";

    [JsonPropertyName("size")]
    public long size { get; set; }

    [JsonPropertyName("sha256")]
    public string? sha256 { get; set; }

    [JsonPropertyName("blob_url")]
    public string? blob_url { get; set; }

    [JsonPropertyName("mime")]
    public string? mime { get; set; }
}

public class ClipboardRequest
{
    [JsonPropertyName("type")]
    public string type { get; set; } = "text";

    [JsonPropertyName("content")]
    public string content { get; set; } = "";

    [JsonPropertyName("from")]
    public string from { get; set; } = "";

    [JsonPropertyName("timestamp")]
    public long timestamp { get; set; }

    [JsonPropertyName("entry_id")]
    public string? entry_id { get; set; }

    [JsonPropertyName("blob_url")]
    public string? blob_url { get; set; }

    [JsonPropertyName("files")]
    public List<FileMeta>? files { get; set; }
}

public class ClipboardResponse
{
    [JsonPropertyName("success")]
    public bool success { get; set; }

    [JsonPropertyName("id")]
    public string? id { get; set; }

    [JsonPropertyName("forwarded")]
    public int forwarded { get; set; }

    [JsonPropertyName("error")]
    public string? error { get; set; }
}

public class ClipboardHistoryResponse
{
    [JsonPropertyName("entries")]
    public List<ClipboardEntry>? entries { get; set; }
}

public class ClipboardLatestResponse
{
    [JsonPropertyName("entry")]
    public ClipboardEntry? entry { get; set; }
}

// Sync settings
public class SyncSettings
{
    public bool autoSend = true;       // 自动发送剪贴板变化
    public bool autoSyncText = true;   // 自动接收文本
    public bool autoSyncImage = true;  // 自动接收图片
    public bool autoSyncFiles = false; // 自动接收文件
}
