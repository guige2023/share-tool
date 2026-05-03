namespace ShareToolClipboardSync;

/// <summary>
/// Clipboard entry matching the Go server's JSON schema.
/// </summary>
public class ClipboardEntry
{
    public string? Id { get; set; }
    public string? Type { get; set; }  // "text" | "image" | "file"
    public string? Content { get; set; }
    public string? FileName { get; set; }
    public long FileSize { get; set; }
    public string? FilePath { get; set; }
    public string? From { get; set; }
    public long Timestamp { get; set; }
}

public class ClipboardRequest
{
    public string Type { get; set; } = "text";
    public string Content { get; set; } = "";
    public string? FileName { get; set; }
    public long FileSize { get; set; }
    public string From { get; set; } = "";
    public long Timestamp { get; set; }
}

public class ClipboardResponse
{
    public bool Success { get; set; }
    public string? Id { get; set; }
    public int Forwarded { get; set; }
    public string? Error { get; set; }
}

public class ClipboardHistoryResponse
{
    public List<ClipboardEntry>? Entries { get; set; }
}

public class ClipboardLatestResponse
{
    public ClipboardEntry? Entry { get; set; }
}
