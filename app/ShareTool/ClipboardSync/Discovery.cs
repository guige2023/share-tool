using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace ShareToolClipboardSync;

public class DiscoveredServer
{
    public string IP { get; set; } = "";
    public int Port { get; set; }
    public string Name { get; set; } = "";
    public string URL => $"https://{IP}:{Port}";
}

public class ServerDiscovery
{
    private const int ScanPort = 18793;

    public event EventHandler<DiscoveredServer>? ServerFound;
    public event EventHandler<string>? ServerLost;
    public event EventHandler<int>? ScanProgress;

    private CancellationTokenSource? _cts;
    private readonly List<DiscoveredServer> _servers = new List<DiscoveredServer>();
    private readonly object _lock = new();

    public List<DiscoveredServer> Servers
    {
        get
        {
            lock (_lock) { return new List<DiscoveredServer>(_servers); }
        }
    }

    public void Start()
    {
        _cts = new CancellationTokenSource();
        _ = ScanLANAsync(_cts.Token);
    }

    public void Stop()
    {
        _cts?.Cancel();
    }

    private async Task ScanLANAsync(CancellationToken ct)
    {
        var localIP = GetLocalIP();
        if (string.IsNullOrEmpty(localIP))
        {
            Logger.Error("[Discovery] Cannot determine local IP");
            return;
        }

        var baseIP = GetBaseIP(localIP);
        if (string.IsNullOrEmpty(baseIP))
        {
            Logger.Error("[Discovery] Cannot determine network base IP");
            return;
        }

        Logger.Info($"[Discovery] Scanning {baseIP}.0/24 for ShareTool servers...");

        var tasks = new List<Task>();
        var scanned = 0;
        var total = 254;

        // Scan all IPs in the subnet concurrently
        for (int i = 1; i <= 254; i++)
        {
            if (ct.IsCancellationRequested) break;

            var ip = $"{baseIP}.{i}";
            tasks.Add(Task.Run(async () =>
            {
                if (await CheckServerAsync(ip))
                {
                    lock (_lock)
                    {
                        if (!_servers.Any(s => s.IP == ip))
                        {
                            var server = new DiscoveredServer
                            {
                                IP = ip,
                                Port = ScanPort,
                                Name = $"ShareTool-{ip}"
                            };
                            _servers.Add(server);
                            Logger.Info($"[Discovery] Found server at {ip}");
                            ServerFound?.Invoke(this, server);
                        }
                    }
                }

                var progress = Interlocked.Increment(ref scanned);
                ScanProgress?.Invoke(this, (progress * 100) / total);
            }));

            // Limit concurrent connections
            if (tasks.Count >= 50)
            {
                await Task.WhenAny(tasks);
                tasks.RemoveAll(t => t.IsCompleted);
            }
        }

        await Task.WhenAll(tasks);
        Logger.Info($"[Discovery] Scan complete. Found {_servers.Count} server(s)");
    }

    private async Task<bool> CheckServerAsync(string ip)
    {
        try
        {
            using var client = new TcpClient();
            var connectTask = client.ConnectAsync(ip, ScanPort);
            if (await Task.WhenAny(connectTask, Task.Delay(500, CancellationToken.None)) == connectTask)
            {
                return client.Connected;
            }
            return false;
        }
        catch
        {
            return false;
        }
    }

    private string? GetLocalIP()
    {
        try
        {
            using var sock = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, 0);
            sock.Connect("8.8.8.8", 65530);
            if (sock.LocalEndPoint is IPEndPoint ep)
                return ep.Address.ToString();
        }
        catch { }

        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;

                foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                {
                    if (ua.Address.AddressFamily == AddressFamily.InterNetwork)
                        return ua.Address.ToString();
                }
            }
        }
        catch { }

        return null;
    }

    private string? GetBaseIP(string localIP)
    {
        var parts = localIP.Split('.');
        if (parts.Length == 4)
            return $"{parts[0]}.{parts[1]}.{parts[2]}";
        return null;
    }

    public void Rescan()
    {
        lock (_lock) { _servers.Clear(); }
        Stop();
        _cts = new CancellationTokenSource();
        _ = ScanLANAsync(_cts.Token);
    }
}