using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Windows.Forms;

namespace ShareToolClipboardSync;

static class Program
{
    private static Process? _serverProcess;
    private static string _sharedDir = "";
    private static ServerDiscovery? _discovery;
    private static string _selectedServerUrl = "";

    [STAThread]
    static void Main()
    {
        // Determine shared directory
        _sharedDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "ShareToolShared");
        if (!Directory.Exists(_sharedDir))
            Directory.CreateDirectory(_sharedDir);

        ApplicationConfiguration.Initialize();

        var localIP = GetLocalIP();
        var instanceName = $"{Environment.MachineName}-Win";

        Console.WriteLine($"[ShareTool] Instance: {instanceName}");
        Console.WriteLine($"[ShareTool] Shared dir: {_sharedDir}");

        // Start UDP discovery to find existing servers
        _discovery = new ServerDiscovery();
        _discovery.ServerFound += (s, server) =>
        {
            Logger.Info($"[ShareTool] Discovered server: {server.Name} at {server.URL}");
        };

        Application.Run(new AppContext($"https://{localIP}:18793", instanceName, _sharedDir, _discovery));
    }

    public static void StartLocalServer()
    {
        var exeDir = AppDomain.CurrentDomain.BaseDirectory;
        var serverPath = Path.Combine(exeDir, "server.exe");

        if (!File.Exists(serverPath))
        {
            MessageBox.Show("server.exe not found.", "ShareTool Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = serverPath,
                Arguments = $"-name {Environment.MachineName}-Win -dir \"{_sharedDir}\"",
                WorkingDirectory = _sharedDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };

            _serverProcess = Process.Start(startInfo);
            Console.WriteLine("[ShareTool] Local server started with PID: " + (_serverProcess?.Id ?? -1));
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[ShareTool] Failed to start server: {ex.Message}");
        }
    }

    public static void StopLocalServer()
    {
        if (_serverProcess != null && !_serverProcess.HasExited)
        {
            try
            {
                _serverProcess.Kill();
                _serverProcess.WaitForExit(5000);
            }
            catch { }
        }
    }

    public static bool IsServerRunning()
    {
        try
        {
            using var client = new HttpClient();
            client.Timeout = TimeSpan.FromSeconds(2);
            var resp = client.GetAsync("https://127.0.0.1:18793/api/health").Result;
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public static string GetLocalIP()
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
    private readonly string _sharedDir;
    private ServerDiscovery _discovery;

    public AppContext(string baseUrl, string instanceName, string sharedDir, ServerDiscovery discovery)
    {
        _baseUrl = baseUrl;
        _instanceName = instanceName;
        _sharedDir = sharedDir;
        _discovery = discovery;

        // Use local server as default, will switch when server is discovered
        _clipboardService = new ClipboardService(baseUrl, instanceName);
        _hotkeyManager = new HotkeyManager();
        _trayManager = new TrayIconManager(_clipboardService, instanceName, sharedDir, _discovery)
        {
            BaseUrl = baseUrl,
            GetServiceStatus = () => Program.IsServerRunning(),
            GetLocalIP = () => Program.GetLocalIP()
        };

        // When a server is discovered, auto-connect to it
        _discovery.ServerFound += (s, server) =>
        {
            _clipboardService.SetBaseURL(server.URL);
            _trayManager.BaseUrl = server.URL;
        };

        // Hidden main form
        _mainForm = new HiddenMainForm();
        _mainForm.SetHotkeyManager(_hotkeyManager);
        _mainForm.Show();
        _mainForm.Hide();

        // Wire up hotkey
        _hotkeyManager.Register(_mainForm.Handle);
        _hotkeyManager.OnHotkeyTriggered += async (_, _) =>
        {
            Logger.Info("[Hotkey] Triggered - sending clipboard");
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
            var exePath = AppDomain.CurrentDomain.BaseDirectory;
            var iconPath = Path.Combine(exePath, "icon.ico");
            if (File.Exists(iconPath))
                notifyIcon.Icon = new Icon(iconPath);
            else
                notifyIcon.Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        }
        catch
        {
            notifyIcon.Icon = SystemIcons.Application;
        }

        _trayManager.SetNotifyIcon(notifyIcon);

        // Start discovery after UI is ready
        _discovery.Start();

        // Check for already discovered servers
        System.Threading.Tasks.Task.Run(async () =>
        {
            await System.Threading.Tasks.Task.Delay(2000);
            var servers = _discovery.Servers;
            if (servers.Count > 0)
            {
                Logger.Info($"[ShareTool] Auto-connecting to: {servers[0].URL}");
                _clipboardService.SetBaseURL(servers[0].URL);
                _trayManager.BaseUrl = servers[0].URL;
            }
        });

        _trayManager.OnQuit += (_, _) =>
        {
            notifyIcon.Visible = false;
            Program.StopLocalServer();
            _discovery.Stop();
            Application.Exit();
        };

        _trayManager.OnOpenWebUI += (_, _) =>
        {
            try
            {
                var url = _clipboardService.BaseURL;
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

        _trayManager.OnOpenFolder += (_, _) =>
        {
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = _sharedDir,
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[ShareTool] Failed to open folder: {ex.Message}");
            }
        };

        _trayManager.OnStartService += (_, _) =>
        {
            Program.StartLocalServer();
            _trayManager.RefreshMenu();
        };

        _trayManager.OnStopService += (_, _) =>
        {
            Program.StopLocalServer();
            _trayManager.RefreshMenu();
        };

        // Start clipboard polling
        _clipboardService.StartPolling(2);

        Console.WriteLine("[ShareTool] Started - clipboard polling active");
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
}

// Hidden main form for message loop and hotkey
class HiddenMainForm : Form
{
    private HotkeyManager? _hotkeyManager;

    protected override void SetVisibleCore(bool value)
    {
        base.SetVisibleCore(false);
    }

    protected override void WndProc(ref Message m)
    {
        _hotkeyManager?.ProcessMessage(ref m);
        base.WndProc(ref m);
    }

    public void SetHotkeyManager(HotkeyManager hm)
    {
        _hotkeyManager = hm;
    }
}