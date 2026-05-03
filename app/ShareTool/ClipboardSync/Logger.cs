using System;
using System.IO;

namespace ShareToolClipboardSync;

public static class Logger
{
    private static readonly string LogFile;
    private static readonly object LockObj = new();

    static Logger()
    {
        var logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ShareTool", "Logs");
        Directory.CreateDirectory(logDir);
        LogFile = Path.Combine(logDir, $"ShareTool_{DateTime.Now:yyyyMMdd_HHmmss}.log");
    }

    public static void Info(string msg) => Log("INFO", msg);
    public static void Error(string msg) => Log("ERROR", msg);
    public static void Debug(string msg) => Log("DEBUG", msg);

    private static void Log(string level, string msg)
    {
        var entry = $"[{DateTime.Now:HH:mm:ss.fff}] [{level}] {msg}";
        lock (LockObj)
        {
            try { File.AppendAllText(LogFile, entry + Environment.NewLine); } catch { }
        }
        System.Diagnostics.Debug.WriteLine(entry);
    }
}