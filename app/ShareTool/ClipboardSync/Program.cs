using System.Net.Http;
using System.Text.Json;
using System.Windows.Forms;

namespace ShareToolClipboardSync;

static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();

        // Determine local IP for base URL
        var localIP = GetLocalIP();
        var baseUrl = $"https://{localIP}:18793";
        var instanceName = $"{Environment.MachineName}-Win";

        Console.WriteLine($"[ShareTool] Base URL: {baseUrl}");
        Console.WriteLine($"[ShareTool] Instance: {instanceName}");

        // Start the app
        Application.Run(new AppContext(baseUrl, instanceName));
    }

    static string GetLocalIP()
    {
        try
        {
            using var sock = new System.Net.Sockets.Socket(
                System.Net.Sockets.AddressFamily.InterNetwork,
                System.Net.Sockets.SocketType.Dgram,
                0);
            sock.Connect("8.8.8.8", 65530);
            if (sock.LocalEndPoint is System.Net.IPEndPoint ep)
                return ep.Address.ToString();
        }
        catch { }

        try
        {
            var host = System.Net.Dns.GetHostEntry(System.Net.Dns.GetHostName());
            foreach (var addr in host.AddressList)
                if (addr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                    return addr.ToString();
        }
        catch { }

        return "127.0.0.1";
    }
}

class AppContext : ApplicationContext
{
    private readonly ClipboardService _clipboardService;
    private readonly TrayIconManager _trayManager;
    private readonly HotkeyManager _hotkeyManager;
    private HiddenMainForm _mainForm;
    private readonly string _baseUrl;
    private readonly string _instanceName;

    public AppContext(string baseUrl, string instanceName)
    {
        _baseUrl = baseUrl;
        _instanceName = instanceName;

        _clipboardService = new ClipboardService(baseUrl, instanceName);
        _hotkeyManager = new HotkeyManager();
        _trayManager = new TrayIconManager(_clipboardService, instanceName)
        {
            BaseUrl = baseUrl,
            GetServiceStatus = () => true, // Assume running if app is running
            GetLocalIP = () => GetLocalIPAddress()
        };

        // Hidden main form (for message loop and hotkey)
        _mainForm = new HiddenMainForm();
        _mainForm.Show();
        _mainForm.Hide();

        // Wire up hotkey
        _hotkeyManager.Register(_mainForm.Handle);
        _hotkeyManager.OnHotkeyTriggered += async (_, _) =>
        {
            Console.WriteLine("[Hotkey] Triggered - sending clipboard");
            await _clipboardService.SendSystemClipboard();
        };

        // Setup tray icon
        var contextMenu = new ContextMenuStrip();
        _trayManager.Setup(contextMenu);

        var notifyIcon = new NotifyIcon
        {
            Text = "ShareTool",
            Visible = true,
            ContextMenuStrip = contextMenu
        };

        // Try to load icon
        try
        {
            var exePath = Environment.ProcessPath ?? System.AppContext.BaseDirectory;
            notifyIcon.Icon = System.Drawing.Icon.ExtractAssociatedIcon(exePath)
                ?? System.Drawing.SystemIcons.Application;
        }
        catch
        {
            notifyIcon.Icon = System.Drawing.SystemIcons.Application;
        }

        _trayManager.SetNotifyIcon(notifyIcon);

        _trayManager.OnQuit += (_, _) =>
        {
            notifyIcon.Visible = false;
            Application.Exit();
        };

        _trayManager.OnOpenWebUI += (_, _) =>
        {
            try
            {
                var url = $"https://{GetLocalIPAddress()}:18793";
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[ShareTool] Failed to open browser: {ex.Message}");
            }
        };

        // Start clipboard polling
        _clipboardService.StartPolling(2);

        Console.WriteLine($"[ShareTool] Started - clipboard polling active");
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _clipboardService.Dispose();
            _hotkeyManager.Dispose();
            _trayManager.Dispose();
            _mainForm.Dispose();
        }
        base.Dispose(disposing);
    }

    private string GetLocalIPAddress()
    {
        try
        {
            using var sock = new System.Net.Sockets.Socket(
                System.Net.Sockets.AddressFamily.InterNetwork,
                System.Net.Sockets.SocketType.Dgram, 0);
            sock.Connect("8.8.8.8", 65530);
            if (sock.LocalEndPoint is System.Net.IPEndPoint ep)
                return ep.Address.ToString();
        }
        catch { }
        return "127.0.0.1";
    }
}

// Hidden main form that processes Windows messages (for hotkey)
class HiddenMainForm : Form
{
    private HotkeyManager? _hotkeyManager;

    protected override void SetVisibleCore(bool value)
    {
        base.SetVisibleCore(false); // Always hidden
    }

    protected override void WndProc(ref Message m)
    {
        // Forward to hotkey manager if set
        _hotkeyManager?.ProcessMessage(ref m);
        base.WndProc(ref m);
    }

    public void SetHotkeyManager(HotkeyManager hm)
    {
        _hotkeyManager = hm;
    }
}
