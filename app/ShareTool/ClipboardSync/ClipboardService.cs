using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace ShareToolClipboardSync;

public class ClipboardService : IDisposable
{
    private string _baseUrl;
    private readonly string _instanceName;
    private HttpClient _http;
    private System.Threading.Timer? _pollTimer;
    private string _lastEntryHash = "";
    private bool _isWritingClipboard = false; // Prevent feedback loop

    public event EventHandler<ClipboardEntry>? OnReceived;
    public event EventHandler<(int Count, string? Error)>? OnSent;

    public string BaseURL => _baseUrl;

    public ClipboardService(string baseUrl, string instanceName)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        _instanceName = instanceName;
        _http = CreateHttpClient();
    }

    public void SetBaseUrl(string baseUrl)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        Logger.Info($"[ClipboardService] BaseUrl updated to: {_baseUrl}");
    }

    private static HttpClient CreateHttpClient()
    {
        var handler = new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = (_, _, _, _) => true
        };
        var client = new HttpClient(handler);
        client.Timeout = TimeSpan.FromSeconds(15);
        return client;
    }

    public void SetBaseURL(string url)
    {
        _baseUrl = url.TrimEnd('/');
        Logger.Info($"[ClipboardService] BaseURL changed to: {_baseUrl}");
    }

    // Start polling for received clipboard entries
    public void StartPolling(int intervalSeconds = 2)
    {
        _pollTimer?.Dispose();
        _pollTimer = new System.Threading.Timer(
            _ => PollReceived(),
            null,
            TimeSpan.Zero,
            TimeSpan.FromSeconds(intervalSeconds)
        );
    }

    public void StopPolling()
    {
        _pollTimer?.Dispose();
        _pollTimer = null;
    }

    private async void PollReceived()
    {
        try
        {
            var resp = await _http.GetAsync($"{_baseUrl}/api/clipboard/latest");
            if (!resp.IsSuccessStatusCode) return;

            var data = await resp.Content.ReadFromJsonAsync<ClipboardLatestResponse>();
            if (data?.Entry == null) return;

            var entry = data.Entry;

            // Skip if from self
            if (entry.From == _instanceName) return;

            // Deduplicate
            if (!ShouldProcess(entry)) return;

            UpdateDeduplicationState(entry);

            // Write to local clipboard
            WriteClipboardToSystem(entry);

            // Notify
            OnReceived?.Invoke(this, entry);
        }
        catch
        {
            // Silently ignore polling errors
        }
    }

    private bool ShouldProcess(ClipboardEntry entry)
    {
        var hash = ComputeEntryHash(entry);
        if (hash == _lastEntryHash) return false;
        return true;
    }

    private void UpdateDeduplicationState(ClipboardEntry entry)
    {
        _lastEntryHash = ComputeEntryHash(entry);
    }

    private static string ComputeEntryHash(ClipboardEntry entry)
    {
        var key = $"{entry.Type}:{entry.Content ?? ""}:{entry.From}";
        return ComputeHash(key);
    }

    private static string ComputeHash(string content)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(content));
        return Convert.ToHexString(bytes);
    }

    // Send current system clipboard to server (which forwards to peers)
    public async Task SendSystemClipboard()
    {
        if (_isWritingClipboard) return; // Skip if we're writing clipboard (prevent feedback)

        try
        {
            var (clipType, content, fileName, fileSize) = DetectClipboardType();
            if (content == null || content.Length == 0)
            {
                OnSent?.Invoke(this, (0, "Clipboard is empty"));
                return;
            }

            var req = new ClipboardRequest
            {
                Type = clipType,
                Content = content,
                FileName = fileName,
                FileSize = fileSize,
                From = _instanceName,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };

            var resp = await _http.PostAsJsonAsync($"{_baseUrl}/api/clipboard", req);
            if (!resp.IsSuccessStatusCode)
            {
                var err = await resp.Content.ReadAsStringAsync();
                OnSent?.Invoke(this, (0, $"Server error: {(int)resp.StatusCode}"));
                return;
            }

            var result = await resp.Content.ReadFromJsonAsync<ClipboardResponse>();
            OnSent?.Invoke(this, (result?.Forwarded ?? 0, null));
        }
        catch (Exception ex)
        {
            OnSent?.Invoke(this, (0, ex.Message));
        }
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
            _isWritingClipboard = true;
            try
            {
                if (entry.Type == "text" && !string.IsNullOrEmpty(entry.Content))
                {
                    Clipboard.SetText(entry.Content);
                }
                else if (entry.Type == "image" && !string.IsNullOrEmpty(entry.Content))
                {
                    var bytes = Convert.FromBase64String(entry.Content);
                    using var ms = new MemoryStream(bytes);
                    using var bmp = new System.Drawing.Bitmap(ms);
                    Clipboard.SetImage(bmp);
                }
                else if (entry.Type == "file" && !string.IsNullOrEmpty(entry.Content))
                {
                    // File: save to temp folder and set file drop list
                    var fileName = entry.FileName ?? "file";
                    var tempDir = Path.Combine(Path.GetTempPath(), "ShareTool");
                    Directory.CreateDirectory(tempDir);
                    var filePath = Path.Combine(tempDir, fileName);

                    var bytes = Convert.FromBase64String(entry.Content);
                    File.WriteAllBytes(filePath, bytes);

                    var col = new System.Collections.Specialized.StringCollection();
                    col.Add(filePath);
                    Clipboard.SetFileDropList(col);
                }
            }
            finally
            {
                _isWritingClipboard = false;
            }
        }
        catch (Exception ex)
        {
            _isWritingClipboard = false;
            Logger.Error($"[ClipboardService] Failed to write clipboard: {ex.Message}");
        }
    }

    // Detect what's currently in the system clipboard
    private (string type, string? content, string? fileName, long fileSize) DetectClipboardType()
    {
        try
        {
            if (Clipboard.ContainsImage())
            {
                var (data, content) = TryReadImage();
                if (content != null) return ("image", content, null, data?.Length ?? 0);
            }
            if (Clipboard.ContainsFileDropList())
            {
                var files = Clipboard.GetFileDropList();
                if (files.Count > 0)
                {
                    var filePath = files[0];
                    var fileName = Path.GetFileName(filePath);
                    if (File.Exists(filePath))
                    {
                        var fileData = File.ReadAllBytes(filePath);
                        return ("file", Convert.ToBase64String(fileData), fileName, fileData.Length);
                    }
                    return ("file", Convert.ToBase64String(Encoding.UTF8.GetBytes(filePath)), fileName, filePath.Length);
                }
            }
            if (Clipboard.ContainsText())
            {
                var text = Clipboard.GetText();
                if (!string.IsNullOrEmpty(text)) return ("text", text, null, 0);
            }
        }
        catch { }

        return ("text", null, null, 0);
    }

    public void Dispose()
    {
        StopPolling();
        _http.Dispose();
    }
}
