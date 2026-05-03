using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
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
    private readonly ContextMenuStrip _contextMenu;
    private readonly ToolStripMenuItem[] _deviceMenuItems;
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

    // Path to extracted Go server binary (single-exe bundling)
    private static string? _extractedServerPath;

    // Extract the bundled Go server binary from resources to a temp file.
    // Returns the path to the extracted exe, or null if extraction fails.
    private static string? ExtractServerBinary()
    {
        try
        {
            var asm = typeof(Program).Assembly;
            var resourceName = "ShareToolClipboardSync.Resources.ShareToolEmbedded.exe";
            var resStream = asm.GetManifestResourceStream(resourceName);
            if (resStream == null)
            {
                Console.WriteLine("[Extract] Resource not found: " + resourceName);
                return null;
            }

            var tempDir = Path.Combine(Path.GetTempPath(), "ShareTool");
            Directory.CreateDirectory(tempDir);
            var destPath = Path.Combine(tempDir, "ShareTool.exe");

            // Always overwrite to get latest version
            using (var fileStream = File.Create(destPath))
                resStream.CopyTo(fileStream);

            File.SetAttributes(destPath, FileAttributes.Normal);
            Console.WriteLine("[Extract] Go server extracted to: " + destPath);
            return destPath;
        }
        catch (Exception ex)
        {
            Console.WriteLine("[Extract] Failed: " + ex.Message);
            return null;
        }
    }

    public TrayAppContext()
    {
        var logPath = Path.Combine(AppContext.BaseDirectory, "logs", "sharetool.log");
        try { Directory.CreateDirectory(Path.GetDirectoryName(logPath)!); } catch { }
        try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] === ShareTool starting ===\n"); } catch { }

        _instanceName = $"{Environment.MachineName}-Win";
        _localIP = GetLocalIP();
        try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] LocalIP={_localIP} InstanceName={_instanceName}\n"); } catch { }
        _deviceMenuItems = new ToolStripMenuItem[10];

        _contextMenu = BuildMenu();

        _notifyIcon = new NotifyIcon
        {
            Text = "ShareTool (未启动)",
            Visible = true,
            ContextMenuStrip = _contextMenu
        };

        // Load icon from embedded resource (works in single-file mode too)
        try
        {
            var asm = typeof(Program).Assembly;
            var icoStream = asm.GetManifestResourceStream("ShareToolClipboardSync.Resources.ShareTool.ico");
            if (icoStream != null)
                _notifyIcon.Icon = new Icon(icoStream);
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

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();

        var statusItem = new ToolStripMenuItem("状态: 扫描中...") { Enabled = false };
        statusItem.Name = "status";
        menu.Items.Add(statusItem);

        var ipItem = new ToolStripMenuItem($"本机 IP: {_localIP}") { Enabled = false };
        menu.Items.Add(ipItem);

        // Devices header
        var devicesHeader = new ToolStripMenuItem("发现的服务:") { Enabled = false };
        devicesHeader.Name = "devicesHeader";
        menu.Items.Add(devicesHeader);

        // Device list (max 10)
        for (int i = 0; i < 10; i++)
        {
            _deviceMenuItems[i] = new ToolStripMenuItem("(空)") { Enabled = false, Available = false };
            _deviceMenuItems[i].Name = $"device{i}";
            _deviceMenuItems[i].Click += DeviceItem_Click;
            menu.Items.Add(_deviceMenuItems[i]);
        }

        // Rescan
        var rescanItem = new ToolStripMenuItem("重新扫描  🔍");
        rescanItem.Click += (_, _) => StartLanScan();
        menu.Items.Add(rescanItem);

        menu.Items.Add(new ToolStripSeparator());

        // Sync settings submenu
        var settingsMenu = new ToolStripMenuItem("同步设置 ▼");
        _autoSendItem = new ToolStripMenuItem("自动发送剪贴板") { Checked = _autoSend };
        _autoSendItem.Click += (_, _) =>
        {
            _autoSend = !_autoSend;
            _autoSendItem!.Checked = _autoSend;
            SaveSyncSettings();
        };
        _syncTextItem = new ToolStripMenuItem("自动接收文本") { Checked = _autoSyncText };
        _syncTextItem.Click += (_, _) =>
        {
            _autoSyncText = !_autoSyncText;
            _syncTextItem!.Checked = _autoSyncText;
            SaveSyncSettings();
        };
        _syncImgItem = new ToolStripMenuItem("自动接收图片") { Checked = _autoSyncImage };
        _syncImgItem.Click += (_, _) =>
        {
            _autoSyncImage = !_autoSyncImage;
            _syncImgItem!.Checked = _autoSyncImage;
            SaveSyncSettings();
        };
        _syncFilesItem = new ToolStripMenuItem("自动接收文件") { Checked = _autoSyncFiles };
        _syncFilesItem.Click += (_, _) =>
        {
            _autoSyncFiles = !_autoSyncFiles;
            _syncFilesItem!.Checked = _autoSyncFiles;
            SaveSyncSettings();
        };
        settingsMenu.DropDownItems.Add(_autoSendItem);
        settingsMenu.DropDownItems.Add(new ToolStripSeparator());
        settingsMenu.DropDownItems.Add(_syncTextItem);
        settingsMenu.DropDownItems.Add(_syncImgItem);
        settingsMenu.DropDownItems.Add(_syncFilesItem);
        menu.Items.Add(settingsMenu);

        // Send clipboard
        _sendItem = new ToolStripMenuItem("发送剪贴板  📋") { Enabled = false };
        _sendItem.Click += async (_, _) => await SendClipboardNow();
        menu.Items.Add(_sendItem);

        // History submenu
        _historyItem = new ToolStripMenuItem("剪贴板历史  📜") { Enabled = false };
        RebuildHistoryMenu();
        menu.Items.Add(_historyItem);

        menu.Items.Add(new ToolStripSeparator());

        // Start/Stop service
        _startStopItem = new ToolStripMenuItem("启动本地服务  ▶");
        _startStopItem.Click += (_, _) =>
        {
            if (_serviceRunning) StopService();
            else StartService();
        };
        menu.Items.Add(_startStopItem);

        // Web UI
        _webItem = new ToolStripMenuItem("打开 Web UI  🌐") { Enabled = false };
        _webItem.Click += (_, _) => OpenWebUI();
        menu.Items.Add(_webItem);

        menu.Items.Add(new ToolStripSeparator());

        // Quit
        var quitItem = new ToolStripMenuItem("退出  ✕");
        quitItem.Click += (_, _) =>
        {
            StopService();
            _scanTimer?.Dispose();
            _healthTimer?.Dispose();
            _clipboardService?.Dispose();
            _notifyIcon.Visible = false;
            Application.Exit();
        };
        menu.Items.Add(quitItem);

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

    private ToolStripMenuItem GetItem(string name) =>
        _contextMenu.Items.Cast<ToolStripMenuItem>().FirstOrDefault(m => m.Name == name)
        ?? new ToolStripMenuItem();

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
        _historyItem!.DropDownItems.Clear();

        if (_historyEntries.Count == 0)
        {
            _historyItem!.DropDownItems.Add(new ToolStripMenuItem("(无历史)") { Enabled = false });
            return;
        }

        foreach (var entry in _historyEntries)
        {
            var preview = entry.@type == "text"
                ? Truncate(entry.text ?? "", 35)
                : entry.@type == "image" ? "[图片]" : $"[{entry.@type}]";
            var label = $"{preview}  ← {entry.from}";
            var item = new ToolStripMenuItem(label);
            var entryCopy = entry;
            item.Click += (_, _) => CopyHistoryEntry(entryCopy);
            _historyItem!.DropDownItems.Add(item);
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
            // Marshal to UI thread to avoid cross-thread UI issues
            _contextMenu.BeginInvoke(new Action(() =>
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
            }));
        };

        _clipboardService.OnSent += (_, result) =>
        {
            _contextMenu.BeginInvoke(new Action(() =>
            {
                try
                {
                    if (result.Error != null)
                        ShowNotification("发送失败", result.Error);
                    else if (result.Count == 0)
                        ShowNotification("剪贴板已发送", "已发送至服务器");
                    else
                        ShowNotification("剪贴板已发送", $"已发送至 {result.Count} 台设备");
                }
                catch { }
            }));
        };

        _clipboardService.OnError += (_, errMsg) =>
        {
            if (string.IsNullOrEmpty(errMsg)) return;
            _contextMenu.BeginInvoke(new Action(() =>
            {
                try { ShowNotification("连接异常", errMsg); }
                catch { }
            }));
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
        // Try to extract bundled Go server binary first (single-exe mode)
        _extractedServerPath ??= ExtractServerBinary();

        var exeDir = Path.GetDirectoryName(Environment.ProcessPath ?? AppContext.BaseDirectory) ?? ".";
        var bundledPath = Path.Combine(exeDir, "ShareTool.exe");
        var exePath = _extractedServerPath ?? (File.Exists(bundledPath) ? bundledPath : null);

        if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath))
        {
            MessageBox.Show($"找不到 ShareTool.exe 服务器程序。\n\n请确保 ShareTool.exe 在同一目录下：\n{exeDir}",
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
            // 延迟 3 秒后加载历史（等待 Go 服务器完全启动）
            _ = Task.Delay(3000).ContinueWith(_ => RefreshHistoryAsync());
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

            // Hide all device items immediately
            for (int i = 0; i < 10; i++)
                _deviceMenuItems[i].Available = false;

            // Kick off first scan immediately (no periodic timer, just reschedule)
            _scanTimer = new System.Threading.Timer(_ => LanScanOnTimer(), null, 0, Timeout.Infinite);
        }
        catch
        {
            GetItem("devicesHeader").Text = "发现的服务: (扫描失败)";
            UpdateStatus(false, "扫描失败");
        }
    }

    private void LanScanOnTimer()
    {
        try
        {
            var subnet = GetSubnet().ToList();
            var found = new List<Device>();
            var tasks = new List<Task<Device?>>();

            foreach (var ip in subnet)
                tasks.Add(ScanHostAsync(ip));

            Task.WhenAll(tasks).ContinueWith(_ =>
            {
                foreach (var t in tasks)
                {
                    if (t.Result != null) found.Add(t.Result);
                }

                // Marshal back to UI thread before updating menu
                _contextMenu.BeginInvoke(new Action(() =>
                {
                    _discoveredDevices.Clear();
                    _discoveredDevices.AddRange(found);
                    UpdateDeviceMenu(found);

                    // Reschedule next scan (one-shot, reschedule after each completes)
                    _scanTimer?.Dispose();
                    _scanTimer = new System.Threading.Timer(__ => LanScanOnTimer(), null, 15000, Timeout.Infinite);
                }));
            });
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
        var logPath = Path.Combine(AppContext.BaseDirectory, "logs", "sharetool.log");
        try
        {
            File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] UpdateDeviceMenu: {devices.Count} devices\n");
        }
        catch { }

        // Hide all device items
        for (int i = 0; i < 10; i++)
        {
            _deviceMenuItems[i].Enabled = false;
            _deviceMenuItems[i].Available = false;
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
            _deviceMenuItems[i].Enabled = true;  // ← 关键！灰色=Enabled=false
            _deviceMenuItems[i].Available = true;
            _deviceMenuItems[i].Tag = d;
            try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}]   device[{i}]={d.IP} enabled=true\n"); } catch { }
        }

        try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] UpdateDeviceMenu done\n"); } catch { }
    }

    private void DeviceItem_Click(object? sender, EventArgs e)
    {
        // ULTRA-VERIFIED: This MessageBox confirms if the click event fires at all
        System.Windows.Forms.MessageBox.Show(
            "DeviceItem_Click fired!\nSender=" + (sender?.GetType().Name ?? "null"),
            "DEBUG: Click Received",
            System.Windows.Forms.MessageBoxButtons.OK,
            System.Windows.Forms.MessageBoxIcon.Information);

        var logPath = Path.Combine(AppContext.BaseDirectory, "logs", "sharetool.log");
        try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] DeviceItem_Click fired\n"); } catch { }

        if (sender is not ToolStripMenuItem item)
        {
            try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] NOT a ToolStripMenuItem\n"); } catch { }
            MessageBox.Show("点击了未知菜单项", "调试");
            return;
        }

        if (item.Tag == null)
        {
            try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] Tag is NULL\n"); } catch { }
            MessageBox.Show($"Tag is null, Text={item.Text}, Available={item.Available}", "调试");
            return;
        }

        if (item.Tag is not Device d)
        {
            try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] Tag type={item.Tag.GetType()}\n"); } catch { }
            MessageBox.Show($"Tag不是Device: {item.Tag.GetType()}", "调试");
            return;
        }

        if (_isConnecting)
        {
            try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] _isConnecting=true, returning\n"); } catch { }
            ShowNotification("请等待", "正在连接上一次设备...");
            return;
        }

        try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] Connecting to {d.IP}\n"); } catch { }
        _isConnecting = true;
        try
        {
            ConnectTo(d);
            try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] ConnectTo OK\n"); } catch { }
        }
        catch
        {
            try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] ConnectTo threw, clearing state\n"); } catch { }
            _isConnecting = false;
            throw;
        }
        finally
        {
            if (_isConnecting) _isConnecting = false;
            try { File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] Done, _isConnecting={_isConnecting}\n"); } catch { }
        }
    }

    private async Task ConnectToAsync(Device d)
    {
        await Task.Run(() => ConnectTo(d));
    }

    private void ConnectTo(Device d)
    {
        try
        {
            _connectedServer = d.Url;
            GetItem("devicesHeader").Text = $"已绑定: {d.IP} ✓";
            _webItem!.Enabled = true;
            _sendItem!.Enabled = true;
            _historyItem!.Enabled = true;
            UpdateStatus(false, $"已连接至 {d.IP}");
            _notifyIcon.Text = $"ShareTool (已连接: {d.IP})";

            _scanTimer?.Dispose();
            _scanTimer = null;

            InitClipboardService(d.Url);
            _ = RefreshHistoryAsync();  // 立即加载历史记录
            ShowNotification("已绑定设备", $"正在同步 {d.IP} 的剪贴板...");
        }
        catch
        {
            // Don't re-throw — let DeviceItem_Click handle it
            throw;
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
            _deviceMenuItems[i].Available = false;
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
            _deviceMenuItems[i].Available = false;
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

    private static readonly object _logLock = new();
    private void Log(string msg)
    {
        try
        {
            var logDir = Path.Combine(AppContext.BaseDirectory, "logs");
            Directory.CreateDirectory(logDir);
            var logFile = Path.Combine(logDir, "sharetool.log");
            var entry = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {msg}{Environment.NewLine}";
            lock (_logLock)
            {
                File.AppendAllText(logFile, entry);
            }
            Console.WriteLine(entry);
        }
        catch { }
    }

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
