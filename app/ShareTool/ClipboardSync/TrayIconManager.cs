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

    public event EventHandler? OnQuit;
    public event EventHandler? OnOpenWebUI;
    public event EventHandler? OnStartService;
    public event EventHandler? OnStopService;
    public Func<bool>? GetServiceStatus { get; set; }
    public Func<string>? GetLocalIP { get; set; }
    public string BaseUrl { get; set; } = "";

    public TrayIconManager(ClipboardService clipboardService, string instanceName)
    {
        _clipboardService = clipboardService;
        _instanceName = instanceName;

        _clipboardService.OnReceived += (_, entry) =>
        {
            ShowNotification(
                "收到剪贴板",
                $"来自 {entry?.from}: {(entry?.@type == "text" ? Truncate(entry?.text ?? "", 40) : $"[{entry?.@type}]")}"
            );
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

    private void BuildMenu()
    {
        if (_menu == null) return;

        _menu.Items.Clear();

        // Status
        var statusRunning = GetServiceStatus?.Invoke() ?? false;
        var statusItem = new ToolStripMenuItem($"状态: {(statusRunning ? "运行中" : "已停止")}") { Enabled = false };
        _menu.Items.Add(statusItem);

        // IP
        var ip = GetLocalIP?.Invoke() ?? "---";
        var ipItem = new ToolStripMenuItem($"IP: {ip}") { Enabled = false };
        _menu.Items.Add(ipItem);

        _menu.Items.Add(new ToolStripSeparator());

        // Open Web UI
        var webItem = new ToolStripMenuItem("打开 Web UI") { Name = "web" };
        webItem.Click += (_, _) => OnOpenWebUI?.Invoke(this, EventArgs.Empty);
        webItem.Enabled = statusRunning;
        _menu.Items.Add(webItem);

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
        var toggleItem = new ToolStripMenuItem(statusRunning ? "停止服务" : "启动服务") { Name = "toggle" };
        toggleItem.Click += (_, _) =>
        {
            if (GetServiceStatus?.Invoke() == true)
                OnStopService?.Invoke(this, EventArgs.Empty);
            else
                OnStartService?.Invoke(this, EventArgs.Empty);

            // Refresh menu after short delay
            Application.CurrentInputLanguage = InputLanguage.CurrentInputLanguage;
            BuildMenu();
        };
        _menu.Items.Add(toggleItem);

        _menu.Items.Add(new ToolStripSeparator());

        // Quit
        var quitItem = new ToolStripMenuItem("退出") { Name = "quit" };
        quitItem.Click += (_, _) => OnQuit?.Invoke(this, EventArgs.Empty);
        _menu.Items.Add(quitItem);
    }

    private async void RefreshHistorySubmenu(ToolStripDropDown menu)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            var resp = await client.GetAsync($"{BaseUrl}/api/clipboard");
            if (resp.IsSuccessStatusCode)
            {
                var data = await resp.Content.ReadFromJsonAsync<ClipboardHistoryResponse>();
                if (data?.entries != null && data.entries.Count > 0)
                {
                    foreach (var entry in data.entries.Take(10))
                    {
                        var preview = entry.@type == "text"
                            ? Truncate(entry.text ?? "", 40)
                            : $"[{entry.@type}]";
                        var item = new ToolStripMenuItem($"{entry.from}: {preview}");
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
        }
        catch
        {
            menu.Items.Add(new ToolStripMenuItem("（无法加载）") { Enabled = false });
        }
    }

    private void RefreshMenu()
    {
        BuildMenu();
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

    public void RefreshStatus()
    {
        RefreshMenu();
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
