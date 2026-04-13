using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace ShareToolClipboardSync;

public class ClipboardService : IDisposable
{
    private readonly string _baseUrl;
    private readonly string _instanceName;
    private readonly HttpClient _http;
    private System.Threading.Timer? _pollTimer;
    private string _lastTextHash = "";
    private bool _lastWasImage = false;

    public event EventHandler<ClipboardEntry>? OnReceived;
    public event EventHandler<(int Count, string? Error)>? OnSent;

    public ClipboardService(string baseUrl, string instanceName)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        _instanceName = instanceName;
        _http = new HttpClient();
        _http.Timeout = TimeSpan.FromSeconds(15);
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
        if (entry.Type == "text")
        {
            var hash = ComputeHash(entry.Content ?? "");
            if (hash == _lastTextHash) return false;
        }
        else if (entry.Type == "image")
        {
            if (_lastWasImage && entry.Content == "") return false;
        }
        return true;
    }

    private void UpdateDeduplicationState(ClipboardEntry entry)
    {
        if (entry.Type == "text")
        {
            _lastTextHash = ComputeHash(entry.Content ?? "");
            _lastWasImage = false;
        }
        else if (entry.Type == "image")
        {
            _lastWasImage = true;
            _lastTextHash = "";
        }
    }

    private static string ComputeHash(string content)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(content));
        return Convert.ToHexString(bytes);
    }

    // Send current system clipboard to server (which forwards to peers)
    public async Task SendSystemClipboard()
    {
        try
        {
            var (clipType, content) = DetectClipboardType();
            if (content == null || content.Length == 0)
            {
                OnSent?.Invoke(this, (0, "Clipboard is empty"));
                return;
            }

            var req = new ClipboardRequest
            {
                Type = clipType,
                Content = content,
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
            // files type: not supported on Windows clipboard directly
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[ClipboardService] Failed to write clipboard: {ex.Message}");
        }
    }

    // Detect what's currently in the system clipboard
    private (string type, string? content) DetectClipboardType()
    {
        try
        {
            if (Clipboard.ContainsImage())
            {
                var (_, content) = TryReadImage();
                if (content != null) return ("image", content);
            }
            if (Clipboard.ContainsFileDropList())
            {
                var files = Clipboard.GetFileDropList();
                if (files.Count > 0)
                    return ("files", string.Join("\n", files.Cast<string>()));
            }
            if (Clipboard.ContainsText())
            {
                var text = Clipboard.GetText();
                if (!string.IsNullOrEmpty(text)) return ("text", text);
            }
        }
        catch { }

        return ("text", null);
    }

    public void Dispose()
    {
        StopPolling();
        _http.Dispose();
    }
}
