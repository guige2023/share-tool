using System.Runtime.InteropServices;

namespace ShareToolClipboardSync;

public class HotkeyManager : IDisposable
{
    // Win32 API
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const int HOTKEY_ID = 9000;

    // Modifiers
    private const uint MOD_ALT = 0x0001;
    private const uint MOD_CTRL = 0x0002;
    private const uint MOD_SHIFT = 0x0004;
    private const uint MOD_WIN = 0x0008;
    private const uint MOD_NOREPEAT = 0x4000;

    // Virtual key codes
    private const uint VK_V = 0x56;  // V key (for Ctrl+Shift+V)
    private const uint VK_S = 0x53;  // S key (for Win+Shift+S alternative)

    // Hotkey message
    private const int WM_HOTKEY = 0x0312;

    private IntPtr _hwnd;
    private bool _registered = false;

    public event EventHandler? OnHotkeyTriggered;

    // Register Win+Shift+V as the global hotkey
    public bool Register(IntPtr hwnd)
    {
        _hwnd = hwnd;

        // Win+Shift+V
        // Using MOD_WIN | MOD_SHIFT | MOD_NOREPEAT, VK_V
        _registered = RegisterHotKey(_hwnd, HOTKEY_ID, MOD_WIN | MOD_SHIFT | MOD_NOREPEAT, VK_V);

        if (!_registered)
        {
            Console.WriteLine("[HotkeyManager] Failed to register Win+Shift+V. Trying Ctrl+Shift+V...");

            // Fallback: Ctrl+Shift+V
            _registered = RegisterHotKey(_hwnd, HOTKEY_ID, MOD_CTRL | MOD_SHIFT | MOD_NOREPEAT, VK_V);
        }

        if (_registered)
        {
            Console.WriteLine("[HotkeyManager] Registered global hotkey (Win/Ctrl+Shift+V)");
        }
        else
        {
            var err = Marshal.GetLastWin32Error();
            Console.WriteLine($"[HotkeyManager] Failed to register hotkey. Error: {err}");
        }

        return _registered;
    }

    public void Unregister()
    {
        if (_registered && _hwnd != IntPtr.Zero)
        {
            UnregisterHotKey(_hwnd, HOTKEY_ID);
            _registered = false;
            Console.WriteLine("[HotkeyManager] Unregistered hotkey");
        }
    }

    // Call this from your WndProc override
    public void ProcessMessage(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && (int)m.WParam == HOTKEY_ID)
        {
            OnHotkeyTriggered?.Invoke(this, EventArgs.Empty);
        }
    }

    public void Dispose()
    {
        Unregister();
    }
}
