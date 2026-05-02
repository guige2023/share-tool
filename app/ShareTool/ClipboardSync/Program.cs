using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ShareToolClipboardSync;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        var logPath = Path.Combine(AppContext.BaseDirectory, "sharetool_crash.log");

        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        AppDomain.CurrentDomain.UnhandledException += (s, e) =>
        {
            try { File.AppendAllText(logPath, $"[{DateTime.Now}] FATAL: {e.ExceptionObject}\n"); } catch { }
            Environment.Exit(1);
        };
        Application.ThreadException += (s, e) =>
        {
            try { File.AppendAllText(logPath, $"[{DateTime.Now}] THREAD: {e.Exception}\n"); } catch { }
        };

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayAppContext());
    }
}

record Device(string IP, string Name, string Url);

class TrayAppContext : ApplicationContext
{
    private readonly NotifyIcon _notifyIcon;
    private readonly ContextMenu _contextMenu;
    private readonly MenuItem[] _deviceMenuItems;
    private ToolStripMenuItem? _autoSendItem;
    private ToolStripMenuItem? _syncTextItem;
    private ToolStripMenuItem? _syncImgItem;
    private ToolStripMenuItem? _syncFilesItem;
    private ToolStripMenuItem? _historyItem;
    private ToolStripMenuItem? _sendItem;
    private ToolStripMenuItem? _webItem;
    private ToolStripMenuItem? _startStopItem;

    private Process? _serverProcess;
    private readonly string _instanceName;
    private readonly string _localIP;
    private bool _serviceRunning;

    private string? _connectedServer;
    private readonly List<Device> _discoveredDevices = new();
    private System.Threading.Timer? _scanTimer;
    private System.Threading.Timer? _healthTimer;
    private ClipboardService? _clipboardService;

    private bool _autoSend = true;
    private bool _autoSyncText = true;
    private bool _autoSyncImage = true;
    private bool _autoSyncFiles = false;
    private readonly List<ClipboardEntry> _historyEntries = new();
    private bool _isConnecting;

    public TrayAppContext()
    {
        _instanceName = $"{Environment.MachineName}-Win";
        _localIP = GetLocalIP();
        _deviceMenuItems = new MenuItem[10];

        _contextMenu = BuildMenu();

        _notifyIcon = new NotifyIcon
        {
            Text = "ShareTool (未启动)",
            Visible = true,
            ContextMenu = _contextMenu
        };

        // Load icon
        try
        {
            var exeDir = Path.GetDirectoryName(Environment.ProcessPath ?? AppContext.BaseDirectory) ?? ".";
            var icoPath = Path.Combine(exeDir, "ShareTool.ico");
            if (File.Exists(icoPath))
                _notifyIcon.Icon = new Icon(icoPath);
            else
                _notifyIcon.Icon = SystemIcons.Application;
        }
        catch
        {
            _notifyIcon.Icon = SystemIcons.Application;
        }

        UpdateStatus(false, "正在扫描局域网...");
        StartLanScan();
    }

    private ContextMenu BuildMenu()
    {
        var menu = new ContextMenu();

        var statusItem = new MenuItem("状态: 扫描中...") { Enabled = false };
        statusItem.Name = "status";
        menu.MenuItems.Add(statusItem);

        var ipItem = new MenuItem($"本机 IP: {_localIP}") { Enabled = false };
        menu.MenuItems.Add(ipItem);

        // Devices header
        var devicesHeader = new MenuItem("发现的服务:") { Enabled = false };
        devicesHeader.Name = "devicesHeader";
        menu.MenuItems.Add(devicesHeader);

        // Device list (max 10)
        for (int i = 0; i < 10; i++)
        {
            _deviceMenuItems[i] = new MenuItem("(空)") { Enabled = false, Visible = false };
            _deviceMenuItems[i].Name = $"device{i}";
            _deviceMenuItems[i].Click += DeviceItem_Click;
            menu.MenuItems.Add(_deviceMenuItems[i]);
        }

        // Rescan
        var rescanItem = new MenuItem("重新扫描  🔍");
        rescanItem.Click += (_, _) => StartLanScan();
        menu.MenuItems.Add(rescanItem);

        menu.MenuItems.Add(new MenuItem("-")); // separator

        // Sync settings submenu
        var settingsMenu = new MenuItem("同步设置 ▼");
        _autoSendItem = new MenuItem("自动发送剪贴板") { Checked = _autoSend };
        _autoSendItem.Click += (_, _) =>
        {
            _autoSend = !_autoSend;
            _autoSendItem!.Checked = _autoSend;
            SaveSyncSettings();
        };
        _syncTextItem = new MenuItem("自动接收文本") { Checked = _autoSyncText };
        _syncTextItem.Click += (_, _) =>
        {
            _autoSyncText = !_autoSyncText;
            _syncTextItem!.Checked = _autoSyncText;
            SaveSyncSettings();
        };
        _syncImgItem = new MenuItem("自动接收图片") { Checked = _autoSyncImage };
        _syncImgItem.Click += (_, _) =>
        {
            _autoSyncImage = !_autoSyncImage;
            _syncImgItem!.Checked = _autoSyncImage;
            SaveSyncSettings();
        };
        _syncFilesItem = new MenuItem("自动接收文件") { Checked = _autoSyncFiles };
        _syncFilesItem.Click += (_, _) =>
        {
            _autoSyncFiles = !_autoSyncFiles;
            _syncFilesItem!.Checked = _autoSyncFiles;
            SaveSyncSettings();
        };
        settingsMenu.MenuItems.Add(_autoSendItem);
        settingsMenu.MenuItems.Add(new MenuItem("-"));
        settingsMenu.MenuItems.Add(_syncTextItem);
        settingsMenu.MenuItems.Add(_syncImgItem);
        settingsMenu.MenuItems.Add(_syncFilesItem);
        menu.MenuItems.Add(settingsMenu);

        // Send clipboard
        _sendItem = new MenuItem("发送剪贴板  📋") { Enabled = false };
        _sendItem.Click += async (_, _) => await SendClipboardNow();
        menu.MenuItems.Add(_sendItem);

        // History submenu
        _historyItem = new MenuItem("剪贴板历史  📜") { Enabled = false };
        RebuildHistoryMenu();
        menu.MenuItems.Add(_historyItem);

        menu.MenuItems.Add(new MenuItem("-"));

        // Start/Stop service
        _startStopItem = new MenuItem("启动本地服务  ▶");
        _startStopItem.Click += (_, _) =>
        {
            if (_serviceRunning) StopService();
            else StartService();
        };
        menu.MenuItems.Add(_startStopItem);

        // Web UI
        _webItem = new MenuItem("打开 Web UI  🌐") { Enabled = false };
        _webItem.Click += (_, _) => OpenWebUI();
        menu.MenuItems.Add(_webItem);

        menu.MenuItems.Add(new MenuItem("-"));

        // Quit
        var quitItem = new MenuItem("退出  ✕");
        quitItem.Click += (_, _) =>
        {
            StopService();
            _scanTimer?.Dispose();
            _healthTimer?.Dispose();
            _clipboardService?.Dispose();
            _notifyIcon.Visible = false;
            Application.Exit();
        };
        menu.MenuItems.Add(quitItem);

        return menu;
    }

    private void SaveSyncSettings()
    {
        if (_clipboardService != null)
        {
            _clipboardService.SyncSettings.autoSend = _autoSend;
            _clipboardService.SyncSettings.autoSyncText = _autoSyncText;
            _clipboardService.SyncSettings.autoSyncImage = _autoSyncImage;
            _clipboardService.SyncSettings.autoSyncFiles = _autoSyncFiles;
        }
    }

    private MenuItem GetItem(string name) =>
        _contextMenu.MenuItems.Cast<MenuItem>().FirstOrDefault(m => m.Name == name)
        ?? new MenuItem();

    private void UpdateStatus(bool running, string status)
    {
        GetItem("status").Text = $"状态: {status}";
    }

    #region Clipboard Sync

    private async Task RefreshHistoryAsync()
    {
        var url = _serviceRunning ? "http://localhost:18793" : _connectedServer;
        if (string.IsNullOrEmpty(url)) return;

        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            var resp = await client.GetAsync($"{url}/api/clipboard");
            if (!resp.IsSuccessStatusCode) return;

            var data = await resp.Content.ReadFromJsonAsync<ClipboardHistoryResponse>();
            if (data?.entries == null) return;

            var entries = data.entries.Take(15).ToList();
            _historyEntries.Clear();
            _historyEntries.AddRange(entries);
            RebuildHistoryMenu();
        }
        catch { }
    }

    private void RebuildHistoryMenu()
    {
        _historyItem!.MenuItems.Clear();

        if (_historyEntries.Count == 0)
        {
            _historyItem!.MenuItems.Add(new MenuItem("(无历史)") { Enabled = false });
            return;
        }

        foreach (var entry in _historyEntries)
        {
            var preview = entry.@type == "text"
                ? Truncate(entry.text ?? "", 35)
                : entry.@type == "image" ? "[图片]" : $"[{entry.@type}]";
            var label = $"{preview}  ← {entry.from}";
            var item = new MenuItem(label);
            var entryCopy = entry;
            item.Click += (_, _) => CopyHistoryEntry(entryCopy);
            _historyItem!.MenuItems.Add(item);
        }
    }

    private void CopyHistoryEntry(ClipboardEntry entry)
    {
        try
        {
            if (entry.@type == "text" && !string.IsNullOrEmpty(entry.text))
            {
                Clipboard.SetText(entry.text);
                ShowNotification("已复制", Truncate(entry.text ?? "", 30));
            }
            else if (entry.@type == "image" && !string.IsNullOrEmpty(entry.text))
            {
                try
                {
                    var bytes = Convert.FromBase64String(entry.text);
                    using var ms = new MemoryStream(bytes);
                    using var bmp = new System.Drawing.Bitmap(ms);
                    Clipboard.SetImage(bmp);
                    ShowNotification("已复制", "[图片]");
                }
                catch { ShowNotification("复制失败", "[图片]解码失败"); }
            }
            else
            {
                ShowNotification("已复制", $"[{entry.@type}] 类型不支持直接复制");
            }
        }
        catch (Exception ex) { ShowNotification("复制失败", ex.Message); }
    }

    private void InitClipboardService(string baseUrl)
    {
        _clipboardService?.Dispose();

        _clipboardService = new ClipboardService(baseUrl, _instanceName);
        _clipboardService.SyncSettings.autoSend = _autoSend;
        _clipboardService.SyncSettings.autoSyncText = _autoSyncText;
        _clipboardService.SyncSettings.autoSyncImage = _autoSyncImage;
        _clipboardService.SyncSettings.autoSyncFiles = _autoSyncFiles;

        _clipboardService.OnReceived += (_, entry) =>
        {
            try
            {
                var preview = entry.@type == "text"
                    ? Truncate(entry.text ?? "", 40)
                    : $"[{entry.@type}]";
                ShowNotification("收到剪贴板", $"来自 {entry.from}: {preview}");
                _ = RefreshHistoryAsync();
            }
            catch { }
        };

        _clipboardService.OnSent += (_, result) =>
        {
            try
            {
                if (result.Error != null)
                    ShowNotification("发送失败", result.Error);
                else
                    ShowNotification("剪贴板已发送", $"已发送到 {result.Count} 个设备");
            }
            catch { }
        };

        // Start clipboard listener WITHOUT creating any hidden window
        _clipboardService.StartClipboardListener(IntPtr.Zero);
    }

    private async Task SendClipboardNow()
    {
        if (_clipboardService == null) return;
        await _clipboardService.SendSystemClipboard();
    }

    #endregion

    #region Service (Server Mode)

    private void StartService()
    {
        var exeDir = Path.GetDirectoryName(Environment.ProcessPath ?? AppContext.BaseDirectory) ?? ".";
        var exePath = Path.Combine(exeDir, "ShareTool.exe");

        if (!File.Exists(exePath))
        {
            MessageBox.Show($"找不到 ShareTool.exe\n\n请把 ShareTool.exe 放在同一目录下：\n{exeDir}",
                "ShareTool", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        try
        {
            _scanTimer?.Dispose();
            _scanTimer = null;
            _discoveredDevices.Clear();

            _serverProcess = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = exePath,
                    Arguments = $"-port 18793 -name \"{_instanceName}\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                },
                EnableRaisingEvents = true
            };
            _serverProcess.OutputDataReceived += (_, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data))
                    Console.WriteLine($"[ShareTool] {e.Data}");
            };
            _serverProcess.ErrorDataReceived += (_, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data))
                    Console.WriteLine($"[ShareTool ERR] {e.Data}");
            };

            _serverProcess.Start();
            _serverProcess.BeginOutputReadLine();
            _serverProcess.BeginErrorReadLine();

            _serviceRunning = true;
            _connectedServer = null;
            UpdateServerModeUI();
            InitClipboardService("http://localhost:18793");
            _healthTimer = new System.Threading.Timer(_ => CheckLocalHealth(), null, 5000, 10000);
            ShowNotification("ShareTool 已启动", "本机服务: http://localhost:18793");
        }
        catch (Exception ex)
        {
            MessageBox.Show($"启动服务失败: {ex.Message}", "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            _serviceRunning = false;
            UpdateClientModeUI(null);
        }
    }

    private void StopService()
    {
        _healthTimer?.Dispose();
        _healthTimer = null;

        if (_serverProcess != null && !_serverProcess.HasExited)
        {
            try { _serverProcess.Kill(); _serverProcess.Dispose(); } catch { }
            _serverProcess = null;
        }

        _clipboardService?.Dispose();
        _clipboardService = null;

        _serviceRunning = false;
        _connectedServer = null;
        ShowNotification("ShareTool 已停止", "服务已关闭");
        UpdateClientModeUI(null);
        StartLanScan();
    }

    private void CheckLocalHealth()
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            var resp = client.GetAsync("http://localhost:18793/api/health").Result;
            if (!resp.IsSuccessStatusCode) throw new Exception();
        }
        catch
        {
            try
            {
                _healthTimer?.Dispose();
                _healthTimer = null;
                if (_serverProcess != null && _serverProcess.HasExited)
                {
                    _serverProcess = null;
                    _serviceRunning = false;
                    ShowNotification("ShareTool 已崩溃", "已切换到客户端模式");
                    UpdateClientModeUI(null);
                    StartLanScan();
                }
            }
            catch { }
        }
    }

    #endregion

    #region Client Mode (Auto-Discovery)

    private void StartLanScan()
    {
        if (_serviceRunning) return;

        try
        {
            _scanTimer?.Dispose();
            _discoveredDevices.Clear();
            GetItem("devicesHeader").Text = "发现的服务: (扫描中...)";
            UpdateStatus(false, "扫描局域网...");

            // Hide all device items
            for (int i = 0; i < 10; i++)
                _deviceMenuItems[i].Visible = false;

            _scanTimer = new System.Threading.Timer(_ => LanScanOnce(), null, 0, 15000);
        }
        catch
        {
            GetItem("devicesHeader").Text = "发现的服务: (扫描失败)";
            UpdateStatus(false, "扫描失败");
        }
    }

    private async void LanScanOnce()
    {
        try
        {
            var subnet = GetSubnet().ToList();
            var found = new List<Device>();
            var tasks = new List<Task<Device?>>();

            foreach (var ip in subnet)
                tasks.Add(ScanHostAsync(ip));

            var results = await Task.WhenAll(tasks);
            foreach (var d in results.Where(d => d != null))
                found.Add(d!);

            _discoveredDevices.Clear();
            _discoveredDevices.AddRange(found);

            UpdateDeviceMenu(found);
        }
        catch { }
    }

    private async Task<Device?> ScanHostAsync(string ip)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
            var resp = await client.GetAsync($"http://{ip}:18793/api/health");
            if (resp.IsSuccessStatusCode)
                return new Device(ip, ip, $"http://{ip}:18793");
        }
        catch { }
        return null;
    }

    private IEnumerable<string> GetSubnet()
    {
        var parts = _localIP.Split('.');
        if (parts.Length != 4) return [];
        var baseIp = $"{parts[0]}.{parts[1]}.{parts[2]}";
        return Enumerable.Range(1, 254).Select(i => $"{baseIp}.{i}");
    }

    private void UpdateDeviceMenu(List<Device> devices)
    {
        // Hide all device items
        for (int i = 0; i < 10; i++)
        {
            _deviceMenuItems[i].Visible = false;
            _deviceMenuItems[i].Tag = null;
        }

        if (devices.Count == 0)
        {
            GetItem("devicesHeader").Text = "发现的服务: (未找到)";
            return;
        }

        GetItem("devicesHeader").Text = $"发现的服务: ({devices.Count})";

        for (int i = 0; i < Math.Min(devices.Count, 10); i++)
        {
            var d = devices[i];
            _deviceMenuItems[i].Text = $"  {d.IP}";
            _deviceMenuItems[i].Visible = true;
            _deviceMenuItems[i].Tag = d;
        }
    }

    private void DeviceItem_Click(object? sender, EventArgs e)
    {
        if (sender is not MenuItem item || item.Tag is not Device d) return;
        if (_isConnecting) return;
        _isConnecting = true;
        ConnectTo(d);
        _isConnecting = false;
    }

    private void ConnectTo(Device d)
    {
        try
        {
            _connectedServer = d.Url;
            GetItem("devicesHeader").Text = $"已连接: {d.IP}";
            _webItem!.Enabled = true;
            _sendItem!.Enabled = true;
            _historyItem!.Enabled = true;
            UpdateStatus(false, $"已连接至 {d.IP}");
            _notifyIcon.Text = $"ShareTool (已连接: {d.IP})";

            _scanTimer?.Dispose();
            _scanTimer = null;

            InitClipboardService(d.Url);
            ShowNotification("已连接到 ShareTool", $"{d.IP} 的分享服务");
        }
        catch (Exception ex)
        {
            ShowNotification("连接失败", ex.Message);
            UpdateClientModeUI(null);
            StartLanScan();
        }
    }

    private void UpdateClientModeUI(string? connectedIP)
    {
        _startStopItem!.Text = "启动本地服务  ▶";
        UpdateStatus(false, string.IsNullOrEmpty(connectedIP) ? "未连接" : $"已连接至 {connectedIP}");
        _notifyIcon.Text = string.IsNullOrEmpty(connectedIP) ? "ShareTool (未连接)" : $"ShareTool (已连接: {connectedIP})";
        _webItem!.Enabled = !string.IsNullOrEmpty(connectedIP);
        _sendItem!.Enabled = !string.IsNullOrEmpty(connectedIP);
        _historyItem!.Enabled = !string.IsNullOrEmpty(connectedIP);
        GetItem("devicesHeader").Text = "发现的服务:";
        for (int i = 0; i < 10; i++)
            _deviceMenuItems[i].Visible = false;
    }

    private void UpdateServerModeUI()
    {
        _startStopItem!.Text = "停止本地服务  ⏹";
        UpdateStatus(true, "本机服务运行中");
        _notifyIcon.Text = "ShareTool (本机服务运行中)";
        _webItem!.Enabled = true;
        _sendItem!.Enabled = true;
        _historyItem!.Enabled = true;
        GetItem("devicesHeader").Text = "发现的服务: (服务端模式)";
        for (int i = 0; i < 10; i++)
            _deviceMenuItems[i].Visible = false;
    }

    #endregion

    #region WebUI

    private void OpenWebUI()
    {
        var url = _serviceRunning ? "http://localhost:18793" : _connectedServer;
        if (string.IsNullOrEmpty(url))
        {
            MessageBox.Show("未连接到任何 ShareTool 服务。", "提示");
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }
        catch (Exception ex) { MessageBox.Show($"打开浏览器失败: {ex.Message}"); }
    }

    #endregion

    #region Utilities

    private void ShowNotification(string title, string text)
    {
        if (string.IsNullOrEmpty(text)) text = " ";
        try { _notifyIcon.ShowBalloonTip(3000, title, text, ToolTipIcon.Info); } catch { }
    }

    private string GetLocalIP()
    {
        try
        {
            using var sock = new System.Net.Sockets.Socket(
                System.Net.Sockets.AddressFamily.InterNetwork,
                System.Net.Sockets.SocketType.Dgram, 0);
            sock.Connect("8.8.8.8", 65530);
            if (sock.LocalEndPoint is IPEndPoint ep)
                return ep.Address.ToString();
        }
        catch { }
        try
        {
            var host = Dns.GetHostEntry(Dns.GetHostName());
            foreach (var addr in host.AddressList)
                if (addr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                    return addr.ToString();
        }
        catch { }
        return "127.0.0.1";
    }

    private string Truncate(string s, int max) =>
        s.Length <= max ? s : s[..(max - 3)] + "...";

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _scanTimer?.Dispose();
            _healthTimer?.Dispose();
            _clipboardService?.Dispose();
            StopService();
            _notifyIcon?.Dispose();
            _contextMenu?.Dispose();
        }
        base.Dispose(disposing);
    }

    #endregion
}
