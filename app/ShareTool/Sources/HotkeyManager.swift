import AppKit
import Carbon.HIToolbox

protocol HotkeyManagerDelegate: AnyObject {
    func hotkeyTriggered()
}

class HotkeyManager: NSObject {

    weak var delegate: HotkeyManagerDelegate?

    private var hotkeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private static var sharedInstance: HotkeyManager?

    override init() {
        super.init()
        HotkeyManager.sharedInstance = self
    }

    deinit {
        unregisterHotkey()
    }

    // Register Cmd+Shift+V as the global hotkey
    func registerHotkey() -> Bool {
        // Cmd + Shift + V
        // V = 0x09, Cmd = cmdKey, Shift = shiftKey
        let keyCode: UInt32 = UInt32(kVK_ANSI_V) // V key
        let modifiers: UInt32 = UInt32(cmdKey | shiftKey)

        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        // Install event handler
        let handler: EventHandlerUPP = { _, event, _ -> OSStatus in
            var hotkeyID = EventHotKeyID()
            GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &hotkeyID
            )

            if hotkeyID.id == 1 {
                DispatchQueue.main.async {
                    HotkeyManager.sharedInstance?.delegate?.hotkeyTriggered()
                }
            }
            return noErr
        }

        let status = InstallEventHandler(
            GetApplicationEventTarget(),
            handler,
            1,
            &eventType,
            nil,
            &eventHandler
        )

        guard status == noErr else {
            print("[HotkeyManager] Failed to install event handler: \(status)")
            return false
        }

        // Register the hotkey
        let hotKeyID = EventHotKeyID(signature: OSType(0x5348_4B50), id: 1) // "SHKP"
        let registerStatus = RegisterEventHotKey(
            keyCode,
            modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotkeyRef
        )

        if registerStatus != noErr {
            print("[HotkeyManager] Failed to register hotkey: \(registerStatus)")
            return false
        }

        print("[HotkeyManager] Registered Cmd+Shift+V")
        return true
    }

    func unregisterHotkey() {
        if let ref = hotkeyRef {
            UnregisterEventHotKey(ref)
            hotkeyRef = nil
        }
        if let handler = eventHandler {
            RemoveEventHandler(handler)
            eventHandler = nil
        }
    }

    // Register the app as accessory to receive events even when not focused
    // Note: For Cmd+Shift+V to work globally, the app needs Accessibility permissions
    // or use of a helper tool. On first run, the system will prompt the user.
}
