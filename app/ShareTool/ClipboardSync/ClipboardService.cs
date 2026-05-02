using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Forms;
using System.IO;
using System.Runtime.InteropServices;

namespace ShareToolClipboardSync;

public class ClipboardService : IDisposable
{
    private readonly string _baseUrl;
    private readonly string _instanceName;
    private readonly HttpClient _http;
    private System.Threading.CancellationTokenSource? _sseCts;

    public event EventHandler<ClipboardEntry>? OnReceived;
    public event EventHandler<(int Count, string? Error)>? OnSent;

    public SyncSettings SyncSettings { get; set; } = new SyncSettings();

    // Loop prevention
    private string _lastWrittenEntryID = "";
    private DateTime _lastWrittenAt = DateTime.MinValue;
    private readonly TimeSpan _writeWindow = TimeSpan.FromSeconds(2);

    // Clipboard change count (Win32)
    private IntPtr _hwnd;
    private uint _lastClipboardSequenceNumber = 0;
    private bool _clipboardListenerActive = false;

    public ClipboardService(string baseUrl, string instanceName)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        _instanceName = instanceName;
        _http = new HttpClient();
        _http.Timeout = TimeSpan.FromSeconds(15);
    }

    // Win32 API for clipboard sequence number
    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    // Win32 API for clipboard format listener
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool AddClipboardFormatListener(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RemoveClipboardFormatListener(IntPtr hwnd);

    private const int WM_CLIPBOARDUPDATE = 0x031D;

    // Start listening to clipboard changes via AddClipboardFormatListener
    public void StartClipboardListener(IntPtr hwnd)
    {
        _hwnd = hwnd;
        _lastClipboardSequenceNumber = GetClipboardSequenceNumber();

        if (AddClipboardFormatListener(hwnd))
        {
            _clipboardListenerActive = true;
            Console.WriteLine("[ClipboardService] Clipboard listener started");
        }
        else
        {
            Console.WriteLine("[ClipboardService] Failed to start clipboard listener, falling back to polling");
            StartPolling(2);
        }

        // Connect SSE push for receiving from peers
        _ = ConnectSSEPush();
    }

    public void StopClipboardListener()
    {
        _sseCts?.Cancel();
        if (_clipboardListenerActive && _hwnd != IntPtr.Zero)
        {
            RemoveClipboardFormatListener(_hwnd);
            _clipboardListenerActive = false;
        }
    }

    // Called from WndProc when WM_CLIPBOARDUPDATE is received
    public void OnClipboardUpdate()
    {
        if (!SyncSettings.autoSend) return; // auto-send disabled

        var seq = GetClipboardSequenceNumber();
        if (seq != _lastClipboardSequenceNumber)
        {
            _lastClipboardSequenceNumber = seq;
            SendSystemClipboard();
        }
    }

    // Fallback polling
    public void StartPolling(int intervalSeconds = 2)
    {
        var timer = new System.Threading.Timer(
            _ => PollReceived(),
            null,
            TimeSpan.Zero,
            TimeSpan.FromSeconds(intervalSeconds)
        );
    }

    public void StopPolling() { }

    private async void PollReceived()
    {
        try
        {
            var resp = await _http.GetAsync($"{_baseUrl}/api/clipboard/latest");
            if (!resp.IsSuccessStatusCode) return;

            var data = await resp.Content.ReadFromJsonAsync<ClipboardLatestResponse>();
            if (data?.entry == null) return;

            var entry = data.entry;

            // Skip self
            if (entry.from == _instanceName) return;

            // Loop prevention
            if (!string.IsNullOrEmpty(entry.entry_id) && entry.entry_id == _lastWrittenEntryID)
                return;

            // Type filter
            if (entry.@type == "text" && !SyncSettings.autoSyncText) return;
            if (entry.@type == "image" && !SyncSettings.autoSyncImage) return;
            if (entry.@type == "files" && !SyncSettings.autoSyncFiles) return;

            WriteClipboardToSystem(entry);

            if (!string.IsNullOrEmpty(entry.entry_id))
                _lastWrittenEntryID = entry.entry_id;
            _lastWrittenAt = DateTime.Now;

            OnReceived?.Invoke(this, entry);
        }
        catch
        {
            // Silently ignore polling errors
        }
    }

    // SSE push connection for receiving clipboard from peers
    private async Task ConnectSSEPush()
    {
        _sseCts = new System.Threading.CancellationTokenSource();
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{_baseUrl}/api/push?device_id={_instanceName}");
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, _sseCts.Token);
            if (!response.IsSuccessStatusCode) return;

            var stream = await response.Content.ReadAsStreamAsync(_sseCts.Token);
            var reader = new StreamReader(stream);

            while (!reader.EndOfStream && !_sseCts.Token.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(_sseCts.Token);
                if (line == null) break;
                if (!line.StartsWith("event: clipboard")) continue;

                var dataLine = await reader.ReadLineAsync(_sseCts.Token);
                if (dataLine == null || !dataLine.StartsWith("data: ")) continue;

                var json = dataLine.Substring(6);
                var entry = JsonSerializer.Deserialize<ClipboardEntry>(json);
                if (entry == null) continue;

                // Loop prevention
                if (!string.IsNullOrEmpty(entry.entry_id) && entry.entry_id == _lastWrittenEntryID)
                    continue;
                if (entry.from == _instanceName) continue;

                // Type filter
                if (entry.@type == "text" && !SyncSettings.autoSyncText) continue;
                if (entry.@type == "image" && !SyncSettings.autoSyncImage) continue;
                if (entry.@type == "files" && !SyncSettings.autoSyncFiles) continue;

                WriteClipboardToSystem(entry);

                if (!string.IsNullOrEmpty(entry.entry_id))
                    _lastWrittenEntryID = entry.entry_id;
                _lastWrittenAt = DateTime.Now;

                OnReceived?.Invoke(this, entry);
            }
        }
        catch (OperationCanceledException)
        {
            // Normal cancellation
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SSE] Disconnected: {ex.Message}");
            // Reconnect after delay
            await Task.Delay(3000);
            if (!_sseCts.Token.IsCancellationRequested)
                _ = ConnectSSEPush();
        }
    }

    // Send current system clipboard to server
    public async Task SendSystemClipboard()
    {
        try
        {
            var (clipType, content, files) = await DetectClipboardTypeAsync();
            if (string.IsNullOrEmpty(content) && (files == null || files.Count == 0))
            {
                OnSent?.Invoke(this, (0, "Clipboard is empty"));
                return;
            }

            // Type filter
            if (clipType == "text" && !SyncSettings.autoSyncText) return;
            if (clipType == "image" && !SyncSettings.autoSyncImage) return;
            if (clipType == "files" && !SyncSettings.autoSyncFiles) return;

            var req = new ClipboardRequest
            {
                type = clipType,
                content = content ?? "",
                from = _instanceName,
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                files = files
            };

            var resp = await _http.PostAsJsonAsync($"{_baseUrl}/api/clipboard", req);
            if (!resp.IsSuccessStatusCode)
            {
                var err = await resp.Content.ReadAsStringAsync();
                OnSent?.Invoke(this, (0, $"Server error: {(int)resp.StatusCode}"));
                return;
            }

            var result = await resp.Content.ReadFromJsonAsync<ClipboardResponse>();
            OnSent?.Invoke(this, (result?.forwarded ?? 0, null));
        }
        catch (Exception ex)
        {
            OnSent?.Invoke(this, (0, ex.Message));
        }
    }

    // Detect what's currently in the system clipboard
    // Returns: (type, content/base64, files)
    private async Task<(string type, string? content, List<FileMeta>? files)> DetectClipboardTypeAsync()
    {
        try
        {
            if (Clipboard.ContainsImage())
            {
                var (_, content) = TryReadImage();
                if (content != null) return ("image", content, null);
            }
            if (Clipboard.ContainsFileDropList())
            {
                var files = Clipboard.GetFileDropList();
                if (files.Count > 0)
                {
                    // Upload each file to blob and collect FileMeta
                    var fileMetas = new List<FileMeta>();
                    foreach (var filePath in files.Cast<string>())
                    {
                        if (!File.Exists(filePath)) continue;
                        var fileInfo = new FileInfo(filePath);
                        var data = await File.ReadAllBytesAsync(filePath);
                        var sha256 = ComputeSHA256(data);
                        // Upload to blob store
                        var blobUrl = $"{_baseUrl}/api/blobs?id={Uri.EscapeDataString(fileInfo.Name)}";
                        using var blobReq = new HttpRequestMessage(HttpMethod.Post, blobUrl);
                        blobReq.Content = new ByteArrayContent(data);
                        blobReq.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream");
                        using var blobResp = await _http.SendAsync(blobReq);
                        if (blobResp.IsSuccessStatusCode)
                        {
                            var blobResult = await blobResp.Content.ReadFromJsonAsync<BlobUploadResult>();
                            if (blobResult != null)
                            {
                                fileMetas.Add(new FileMeta
                                {
                                    name = fileInfo.Name,
                                    size = fileInfo.Length,
                                    sha256 = blobResult.sha256,
                                    blob_url = $"/api/blobs?id={blobResult.id}",
                                    mime = GetMimeType(fileInfo.Extension)
                                });
                            }
                        }
                    }
                    if (fileMetas.Count > 0)
                        return ("files", null, fileMetas);
                }
            }
            if (Clipboard.ContainsText())
            {
                var text = Clipboard.GetText();
                if (!string.IsNullOrEmpty(text)) return ("text", text, null);
            }
        }
        catch { }

        return ("text", null, null);
    }

    private static string ComputeSHA256(byte[] data)
    {
        using var sha = SHA256.Create();
        var hash = sha.ComputeHash(data);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static string GetMimeType(string extension)
    {
        return extension.ToLowerInvariant() switch
        {
            ".pdf" => "application/pdf",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".zip" => "application/zip",
            ".txt" => "text/plain",
            ".json" => "application/json",
            ".html" or ".htm" => "text/html",
            ".css" => "text/css",
            ".js" => "application/javascript",
            _ => "application/octet-stream"
        };
    }

    private class BlobUploadResult
    {
        public string? id { get; set; }
        public string? sha256 { get; set; }
    }

    // Read text from system clipboard
    public static string? TryReadText()
    {
        try
        {
            if (Clipboard.ContainsText())
                return Clipboard.GetText();
        }
        catch { }
        return null;
    }

    // Read image from system clipboard as Base64 PNG
    public static (string type, string? content) TryReadImage()
    {
        try
        {
            if (Clipboard.ContainsImage())
            {
                using var bmp = Clipboard.GetImage();
                if (bmp != null)
                {
                    using var ms = new MemoryStream();
                    bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                    return ("image", Convert.ToBase64String(ms.ToArray()));
                }
            }
        }
        catch { }
        return ("image", null);
    }

    // Write clipboard entry to system clipboard
    public void WriteClipboardToSystem(ClipboardEntry entry)
    {
        try
        {
            if (entry.@type == "text" && !string.IsNullOrEmpty(entry.text))
            {
                Clipboard.SetText(entry.text);
            }
            else if (entry.@type == "image")
            {
                // Try embedded base64 first
                if (!string.IsNullOrEmpty(entry.text))
                {
                    try
                    {
                        var bytes = Convert.FromBase64String(entry.text);
                        using var ms = new MemoryStream(bytes);
                        using var bmp = new System.Drawing.Bitmap(ms);
                        Clipboard.SetImage(bmp);
                        return;
                    }
                    catch { }
                }

                // Try blob URL
                if (!string.IsNullOrEmpty(entry.blob_url))
                {
                    _ = FetchBlobAndWrite(entry.blob_url);
                }
            }
            else if (entry.@type == "files" && entry.files != null && entry.files.Count > 0)
            {
                // Download files from blob URLs and write to temp, then set file drop list
                _ = DownloadFilesAndSetClipboard(entry.files);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[ClipboardService] Failed to write clipboard: {ex.Message}");
        }
    }

    private async Task DownloadFilesAndSetClipboard(List<FileMeta> files)
    {
        try
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "ShareTool");
            Directory.CreateDirectory(tempDir);
            var localPaths = new List<string>();

            foreach (var file in files)
            {
                if (string.IsNullOrEmpty(file.blob_url)) continue;
                var localPath = Path.Combine(tempDir, file.name);
                var blobUrl = file.blob_url.StartsWith("http")
                    ? file.blob_url
                    : $"{_baseUrl}{file.blob_url}";
                var resp = await _http.GetAsync(blobUrl);
                if (!resp.IsSuccessStatusCode) continue;
                var data = await resp.Content.ReadAsByteArrayAsync();
                await File.WriteAllBytesAsync(localPath, data);
                localPaths.Add(localPath);
            }

            if (localPaths.Count > 0)
            {
                var dropList = new System.Collections.Specialized.StringCollection();
                foreach (var path in localPaths)
                    dropList.Add(path);
                Clipboard.SetFileDropList(dropList);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[ClipboardService] Failed to download files: {ex.Message}");
        }
    }

    private async Task FetchBlobAndWrite(string blobUrl)
    {
        try
        {
            var resp = await _http.GetAsync($"{_baseUrl}{blobUrl}");
            if (!resp.IsSuccessStatusCode) return;
            var bytes = await resp.Content.ReadAsByteArrayAsync();
            using var ms = new MemoryStream(bytes);
            using var bmp = new System.Drawing.Bitmap(ms);
            Clipboard.SetImage(bmp);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[ClipboardService] Failed to fetch blob: {ex.Message}");
        }
    }

    public void Dispose()
    {
        StopClipboardListener();
        _sseCts?.Dispose();
        _http.Dispose();
    }
}
