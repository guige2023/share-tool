using System.Drawing;
using System.Net.Http;
using System.Net.Http.Json;
using System.Windows.Forms;

namespace ShareToolClipboardSync;

public class TrayIconManager : IDisposable
{
    private NotifyIcon? _notifyIcon;
    private ContextMenuStrip? _menu;
    private readonly ClipboardService _clipboardService;
    private readonly string _instanceName;
    private readonly string _sharedDir;
    private readonly ServerDiscovery _discovery;

    public event EventHandler? OnQuit;
    public event EventHandler? OnOpenWebUI;
    public event EventHandler? OnStartService;
    public event EventHandler? OnStopService;
    public event EventHandler? OnOpenFolder;
    public Func<bool>? GetServiceStatus { get; set; }
    public Func<string>? GetLocalIP { get; set; }
    private string _baseUrl = "";
    private string _connectedServer = "";

    public string BaseUrl
    {
        get => _baseUrl;
        set
        {
            _baseUrl = value;
            _connectedServer = value;
            // Also update ClipboardService so it polls the correct server
            _clipboardService.SetBaseUrl(value);
            // Only refresh if menu is already set up
            if (_menu != null)
            {
                RefreshMenu();
                _menu.Refresh();
            }
        }
    }

    public TrayIconManager(ClipboardService clipboardService, string instanceName, string sharedDir, ServerDiscovery discovery)
    {
        _clipboardService = clipboardService;
        _instanceName = instanceName;
        _sharedDir = sharedDir;
        _discovery = discovery;

        _discovery.ServerFound += (s, server) =>
        {
            Logger.Info($"[TrayIcon] Server discovered: {server.Name} at {server.URL}");
            RefreshServersMenu();
        };

        _discovery.ScanProgress += (s, progress) =>
        {
            UpdateStatus($"扫描中... {progress}%");
        };

        _clipboardService.OnReceived += (_, entry) =>
        {
            ShowNotification("收到剪贴板", $"来自 {entry?.From}: {(entry?.Type == "text" ? Truncate(entry?.Content ?? "", 40) : $"[{entry?.Type}]")}");
            RefreshHistoryMenu();
        };

        _clipboardService.OnSent += (_, result) =>
        {
            if (result.Error != null)
                ShowNotification("发送失败", result.Error);
            else
                ShowNotification("剪贴板已发送", $"已发送到 {result.Count} 个设备");
        };
    }

    public void Setup(ContextMenuStrip menu)
    {
        _menu = menu;
        BuildMenu();
    }

    public void SetNotifyIcon(NotifyIcon ni)
    {
        _notifyIcon = ni;
        RefreshMenu();
    }

    private void UpdateStatus(string status)
    {
        if (_menu == null) return;
        var statusItem = _menu.Items[0] as ToolStripMenuItem;
        if (statusItem != null)
            statusItem.Text = status;
    }

    private void BuildMenu()
    {
        if (_menu == null) return;

        _menu.Items.Clear();

        // Status
        var statusRunning = GetServiceStatus?.Invoke() ?? false;
        var connStatus = string.IsNullOrEmpty(_connectedServer) ? "未连接" : $"已连接:{ExtractIP(_connectedServer)}";
        var statusItem = new ToolStripMenuItem($"状态: {connStatus}") { Enabled = false };
        _menu.Items.Add(statusItem);

        // Local server status
        var serverStatus = statusRunning ? "本地服务: 运行中" : "本地服务: 已停止";
        var serverItem = new ToolStripMenuItem(serverStatus) { Enabled = false };
        _menu.Items.Add(serverItem);

        _menu.Items.Add(new ToolStripSeparator());

        // Servers submenu
        var serversItem = new ToolStripMenuItem("发现的服务器");
        var serversSubmenu = new ContextMenuStrip();
        RefreshServersSubmenu(serversSubmenu);
        serversItem.DropDown = serversSubmenu;
        _menu.Items.Add(serversItem);

        // Manual connect
        var manualItem = new ToolStripMenuItem("手动输入IP连接...");
        manualItem.Click += (_, _) => ShowManualConnectDialog();
        _menu.Items.Add(manualItem);

        // Rescan
        var rescanItem = new ToolStripMenuItem("重新扫描局域网");
        rescanItem.Click += (_, _) =>
        {
            _discovery.Rescan();
            UpdateStatus("状态: 扫描中...");
        };
        _menu.Items.Add(rescanItem);

        _menu.Items.Add(new ToolStripSeparator());

        // Open Web UI
        var webItem = new ToolStripMenuItem("打开 Web UI");
        webItem.Click += (_, _) => OnOpenWebUI?.Invoke(this, EventArgs.Empty);
        webItem.Enabled = statusRunning;
        _menu.Items.Add(webItem);

        // Open Shared Folder
        var folderItem = new ToolStripMenuItem("打开共享文件夹");
        folderItem.Click += (_, _) => OnOpenFolder?.Invoke(this, EventArgs.Empty);
        _menu.Items.Add(folderItem);

        // Send clipboard
        var sendItem = new ToolStripMenuItem("发送剪贴板  Win+⇧+V");
        sendItem.Click += async (_, _) => await _clipboardService.SendSystemClipboard();
        _menu.Items.Add(sendItem);

        // Clipboard History
        var historyItem = new ToolStripMenuItem("剪贴板历史");
        historyItem.Name = "history";
        var historySubmenu = new ContextMenuStrip();
        RefreshHistorySubmenu(historySubmenu);
        historyItem.DropDown = historySubmenu;
        _menu.Items.Add(historyItem);

        _menu.Items.Add(new ToolStripSeparator());

        // Start/Stop
        var toggleItem = new ToolStripMenuItem(statusRunning ? "停止本地服务" : "启动本地服务") { Name = "toggle" };
        toggleItem.Click += (_, _) =>
        {
            if (GetServiceStatus?.Invoke() == true)
                OnStopService?.Invoke(this, EventArgs.Empty);
            else
                OnStartService?.Invoke(this, EventArgs.Empty);
            BuildMenu();
        };
        _menu.Items.Add(toggleItem);

        _menu.Items.Add(new ToolStripSeparator());

        // Quit
        var quitItem = new ToolStripMenuItem("退出");
        quitItem.Click += (_, _) => OnQuit?.Invoke(this, EventArgs.Empty);
        _menu.Items.Add(quitItem);
    }

    private void RefreshServersSubmenu(ToolStripDropDown menu)
    {
        menu.Items.Clear();
        var servers = _discovery.Servers;

        if (servers.Count == 0)
        {
            var noServer = new ToolStripMenuItem("（未发现服务器）") { Enabled = false };
            menu.Items.Add(noServer);
        }
        else
        {
            foreach (var server in servers)
            {
                var item = new ToolStripMenuItem($"{server.Name} ({server.IP})");
                item.Click += (_, _) =>
                {
                    _clipboardService.SetBaseURL(server.URL);
                    BaseUrl = server.URL;
                    Logger.Info($"[TrayIcon] Connected to: {server.URL}");
                    ShowNotification("已连接", $"连接到 {server.Name}");
                };
                menu.Items.Add(item);
            }
        }
    }

    private void RefreshServersMenu()
    {
        if (_menu == null) return;
        var serversItem = _menu.Items.Cast<ToolStripItem>().FirstOrDefault(i => i.Text == "发现的服务器") as ToolStripMenuItem;
        if (serversItem?.DropDown is ContextMenuStrip submenu)
        {
            RefreshServersSubmenu(submenu);
        }
    }

    private void ShowManualConnectDialog()
    {
        var form = new Form
        {
            Text = "手动连接服务器",
            Width = 300,
            Height = 120,
            StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false
        };

        var label = new Label { Text = "输入服务器IP:", Left = 10, Top = 15, Width = 80 };
        var textBox = new TextBox { Left = 95, Top = 12, Width = 180, PlaceholderText = "192.168.1.100" };
        var okButton = new Button { Text = "连接", Left = 100, Top = 50, Width = 80, DialogResult = DialogResult.OK };
        var cancelButton = new Button { Text = "取消", Left = 190, Top = 50, Width = 80, DialogResult = DialogResult.Cancel };

        okButton.Click += (_, _) => form.Close();
        cancelButton.Click += (_, _) => form.Close();

        form.Controls.AddRange(new Control[] { label, textBox, okButton, cancelButton });
        form.AcceptButton = okButton;
        form.CancelButton = cancelButton;

        if (form.ShowDialog() == DialogResult.OK)
        {
            var ip = textBox.Text.Trim();
            if (!string.IsNullOrEmpty(ip))
            {
                var url = $"https://{ip}:18793";
                _clipboardService.SetBaseURL(url);
                BaseUrl = url;
                Logger.Info($"[TrayIcon] Manually connected to: {url}");
                ShowNotification("已连接", $"连接到 {ip}");
            }
        }
    }

    private async void RefreshHistorySubmenu(ToolStripDropDown menu)
    {
        // First, show loading indicator
        menu.Items.Clear();
        var loadingItem = new ToolStripMenuItem("（加载中...）") { Enabled = false };
        menu.Items.Add(loadingItem);

        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            var resp = await client.GetAsync($"{BaseUrl}/api/clipboard/history");
            if (resp.IsSuccessStatusCode)
            {
                var data = await resp.Content.ReadFromJsonAsync<ClipboardHistoryResponse>();
                menu.Items.Clear();

                if (data?.Entries != null && data.Entries.Count > 0)
                {
                    foreach (var entry in data.Entries.Take(10))
                    {
                        var preview = entry.Type == "text"
                            ? Truncate(entry.Content ?? "", 40)
                            : $"[{entry.Type}] {entry.FileName ?? entry.Type}";
                        var item = new ToolStripMenuItem($"{entry.From}: {preview}");
                        item.Click += (_, _) => _clipboardService.WriteClipboardToSystem(entry);
                        menu.Items.Add(item);
                    }
                    menu.Items.Add(new ToolStripSeparator());
                    var clearItem = new ToolStripMenuItem("清空历史");
                    clearItem.Click += async (_, _) =>
                    {
                        await client.DeleteAsync($"{BaseUrl}/api/clipboard");
                        RefreshHistorySubmenu(menu);
                    };
                    menu.Items.Add(clearItem);
                }
                else
                {
                    menu.Items.Add(new ToolStripMenuItem("（无历史）") { Enabled = false });
                }
            }
            else
            {
                menu.Items.Clear();
                menu.Items.Add(new ToolStripMenuItem($"（加载失败:{resp.StatusCode}）") { Enabled = false });
            }
        }
        catch (Exception ex)
        {
            menu.Items.Clear();
            menu.Items.Add(new ToolStripMenuItem($"（无法加载）") { Enabled = false });
            Logger.Error($"[History] Load failed: {ex.Message}");
        }
    }

    private void RefreshHistoryMenu()
    {
        if (_menu == null) return;
        var historyItem = _menu.Items["history"] as ToolStripMenuItem;
        if (historyItem?.DropDown is ContextMenuStrip submenu)
        {
            RefreshHistorySubmenu(submenu);
        }
    }

    public void RefreshMenu()
    {
        BuildMenu();
    }

    private static string ExtractIP(string url)
    {
        // Extract IP from URL like "https://192.168.1.100:18793"
        try
        {
            var uri = new Uri(url);
            return uri.Host;
        }
        catch
        {
            return url.Replace("https://", "").Split(':')[0];
        }
    }

    private static string Truncate(string s, int max)
    {
        var clean = s.Replace("\r", "").Replace("\n", " ").Trim();
        if (clean.Length <= max) return clean;
        return clean[..max] + "…";
    }

    public void ShowNotification(string title, string text)
    {
        _notifyIcon?.ShowBalloonTip(3000, title, text, ToolTipIcon.Info);
    }

    public void Dispose()
    {
        _notifyIcon?.Dispose();
        _menu?.Dispose();
    }
}