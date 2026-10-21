import AppKit
import ApplicationServices

let owner = pid_t(CommandLine.arguments.dropFirst().first.flatMap(Int32.init) ?? 0)
var target: NSRunningApplication?
struct Snapshot {
    let app: NSRunningApplication
    let element: AXUIElement
    let range: CFRange
    let value: String?
    let point: CGPoint
}
struct CapturedTarget {
    let app: NSRunningApplication
    let window: AXUIElement?
    let snapshot: Snapshot?
}
var captured: (String, CapturedTarget)?
var accessibilityRequests: [pid_t: (app: NSRunningApplication, time: TimeInterval, supported: Bool)] = [:]

// Bound every remote AX message, as well as the entire snapshot. A stalled
// application must not block hotkey presentation or leave commands queued.
final class AXReader {
    let deadline: TimeInterval
    var timedOut = false
    init(budget: TimeInterval) { deadline = ProcessInfo.processInfo.systemUptime + budget }
    func prepare(_ element: AXUIElement) -> Bool {
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard !timedOut, remaining > 0.001 else { timedOut = true; return false }
        return AXUIElementSetMessagingTimeout(element, Float(min(remaining, 0.1))) == .success
    }
    func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        guard prepare(element) else { return nil }
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        if result == .cannotComplete { timedOut = true }
        return result == .success ? value : nil
    }
    func editable(_ element: AXUIElement) -> Bool {
        guard prepare(element) else { return false }
        var value = DarwinBoolean(false)
        let result = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &value)
        if result == .cannotComplete { timedOut = true }
        return result == .success && value.boolValue
    }
    func reason(_ fallback: String) -> String {
        return timedOut || ProcessInfo.processInfo.systemUptime >= deadline ? "timeout" : fallback
    }
}
func focused(_ app: NSRunningApplication, _ reader: AXReader) -> AXUIElement? {
    guard let value = reader.attribute(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedUIElementAttribute),
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func focusedWindow(_ app: NSRunningApplication, budget: TimeInterval = 0.04) -> AXUIElement? {
    let reader = AXReader(budget: budget)
    guard let value = reader.attribute(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute),
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func prepareAccessibility(_ app: NSRunningApplication) {
    guard AXIsProcessTrusted() else { return }
    let pid = app.processIdentifier
    if let previous = accessibilityRequests[pid], !previous.app.isTerminated { return }
    // Electron documents AXManualAccessibility; Chrome uses AXEnhancedUserInterface.
    // Chromium debounces this request for two seconds. Reissuing it on every
    // activation restarts that delay, so request once per running application.
    // https://www.electronjs.org/docs/latest/tutorial/accessibility
    let reader = AXReader(budget: 0.04)
    let application = AXUIElementCreateApplication(pid)
    // Reading the application role also activates Chromium's native AX APIs.
    _ = reader.attribute(application, kAXRoleAttribute)
    guard reader.prepare(application) else { return }
    let manual = AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, true as CFTypeRef)
    var enhanced = AXError.attributeUnsupported
    if manual != .success && reader.prepare(application) {
        enhanced = AXUIElementSetAttributeValue(application, "AXEnhancedUserInterface" as CFString, true as CFTypeRef)
    }
    // A busy launch is transient; do not cache it as unsupported for the whole
    // app lifetime. Capture/paste can retry once the app is responsive.
    if manual == .cannotComplete || enhanced == .cannotComplete { return }
    // Chromium may process EnhancedUserInterface before its superclass returns
    // notImplemented. Other apps simply reject these optional attributes.
    accessibilityRequests[pid] = (app, ProcessInfo.processInfo.systemUptime,
        manual == .success || enhanced == .success || enhanced == .notImplemented)
    if ProcessInfo.processInfo.environment["PROMPT_DOCK_NATIVE_TEST"] != nil {
        reply(0, ["type": "diagnostic", "app": app.bundleIdentifier ?? "", "pid": pid, "manual": manual.rawValue, "enhanced": enhanced.rawValue])
    }
}
func accessibilityStarting(_ app: NSRunningApplication) -> Bool {
    guard let request = accessibilityRequests[app.processIdentifier] else { return false }
    return request.supported && ProcessInfo.processInfo.systemUptime - request.time < 3
}
func snapshot(_ app: NSRunningApplication?, budget: TimeInterval = 0.5) -> (Snapshot?, String) {
    guard AXIsProcessTrusted() else { return (nil, "permission") }
    let reader = AXReader(budget: budget)
    guard let app = app, !app.isTerminated, let element = focused(app, reader) else { return (nil, reader.reason("caret-unavailable")) }
    // Check the focused element and ancestors; never inject into a secure field.
    var ancestor: AXUIElement? = element
    for _ in 0..<8 {
        guard let current = ancestor else { break }
        let role = reader.attribute(current, kAXRoleAttribute) as? String ?? ""
        let subrole = reader.attribute(current, kAXSubroleAttribute) as? String ?? ""
        if role.localizedCaseInsensitiveContains("secure") || subrole.localizedCaseInsensitiveContains("secure") {
            return (nil, "password")
        }
        if let parent = reader.attribute(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() {
            ancestor = (parent as! AXUIElement)
        } else { ancestor = nil }
    }
    guard !reader.timedOut else { return (nil, "timeout") }
    let role = reader.attribute(element, kAXRoleAttribute) as? String ?? ""
    guard [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role) else { return (nil, reader.reason("caret-unavailable")) }
    guard reader.editable(element), (reader.attribute(element, kAXEnabledAttribute) as? Bool) != false else { return (nil, reader.reason("read-only")) }
    guard let rawRange = reader.attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(rawRange) == AXValueGetTypeID() else { return (nil, reader.reason("caret-unavailable")) }
    var range = CFRange()
    guard AXValueGetValue(rawRange as! AXValue, .cfRange, &range), range.location >= 0 else { return (nil, "caret-unavailable") }
    var point = CGPoint(x: 120, y: 120)
    var size = CGSize.zero
    if let raw = reader.attribute(element, kAXPositionAttribute), CFGetTypeID(raw) == AXValueGetTypeID() { _ = AXValueGetValue(raw as! AXValue, .cgPoint, &point) }
    if let raw = reader.attribute(element, kAXSizeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() { _ = AXValueGetValue(raw as! AXValue, .cgSize, &size) }
    point.y += min(size.height, 60)
    let value = reader.attribute(element, kAXValueAttribute) as? String
    guard reader.reason("").isEmpty else { return (nil, "timeout") }
    return (Snapshot(app: app, element: element, range: range, value: value, point: point), "")
}
func remember(_ app: NSRunningApplication?) {
    guard let app = app, app.processIdentifier != owner,
          app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
          app.activationPolicy == .regular else { return }
    target = app
    prepareAccessibility(app)
}
remember(NSWorkspace.shared.frontmostApplication)
let activated = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
    remember(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}
func reply(_ request: Any, _ data: [String: Any]) {
    var result = data; result["request"] = request
    if ProcessInfo.processInfo.environment["PROMPT_DOCK_NATIVE_TEST"] != nil && data["ok"] as? Bool == false {
        result["targetApp"] = target?.bundleIdentifier ?? "none"
        result["targetExists"] = target != nil
        result["frontApp"] = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "none"
        result["frontPid"] = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        result["targetPid"] = target?.processIdentifier ?? 0
        let reader = AXReader(budget: 0.02)
        if let app = target, let field = focused(app, reader) { result["role"] = reader.attribute(field, kAXRoleAttribute) as? String ?? "none" }
    }
    if let bytes = try? JSONSerialization.data(withJSONObject: result), let string = String(data: bytes, encoding: .utf8) { print(string); fflush(stdout) }
}
DispatchQueue.global().async {
    while let line = readLine() {
        guard let bytes = line.data(using: .utf8), let command = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any], let request = command["request"] else { continue }
        DispatchQueue.main.async {
            let type = command["type"] as? String ?? ""
            if type == "permission" {
                reply(request, ["ok": true, "trusted": AXIsProcessTrusted()]); return
            }
            if type == "restore" {
                let saved = captured
                captured = nil
                if let token = command["token"] as? String, token == saved?.0,
                   NSWorkspace.shared.frontmostApplication?.processIdentifier == owner {
                    _ = saved?.1.app.activate(options: [.activateIgnoringOtherApps])
                }
                reply(request, ["ok": true]); return
            }
            if type == "capture" {
                // An app may have been busy during its activation notification.
                // Retry that short initialization before the first hotkey capture.
                if let app = target { prepareAccessibility(app) }
                let (fresh, reason) = snapshot(target, budget: 0.1)
                let item: CapturedTarget
                if let fresh = fresh {
                    item = CapturedTarget(app: fresh.app, window: nil, snapshot: fresh)
                } else if reason == "caret-unavailable", let app = target,
                          NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
                          accessibilityStarting(app), let window = focusedWindow(app) {
                    // The first Chromium tree may still be starting. Bind this
                    // session to its app/window now and verify the editable field
                    // after returning there. Never hold up popup presentation.
                    item = CapturedTarget(app: app, window: window, snapshot: nil)
                } else { captured = nil; reply(request, ["ok": false, "reason": reason]); return }
                let token = UUID().uuidString
                captured = (token, item)
                var result: [String: Any] = ["ok": true, "token": token, "deferred": item.snapshot == nil]
                if let point = fresh?.point { result["x"] = point.x; result["y"] = point.y }
                reply(request, result)
                return
            }
            guard type == "paste" else { reply(request, ["ok": false, "reason": "invalid-command"]); return }
            guard AXIsProcessTrusted() else { reply(request, ["ok": false, "reason": "permission"]); return }
            let item: CapturedTarget?
            let explicitTarget = command["token"] as? String
            if let token = command["token"] as? String {
                item = captured?.0 == token ? captured?.1 : nil
                captured = nil
            } else { item = nil }
            guard explicitTarget == nil || item != nil else { reply(request, ["ok": false, "reason": "target-changed"]); return }
            guard let destination = item?.app ?? target, !destination.isTerminated else { reply(request, ["ok": false, "reason": "caret-unavailable"]); return }
            if item != nil, let front = NSWorkspace.shared.frontmostApplication,
               front.processIdentifier != owner && front.processIdentifier != destination.processIdentifier {
                reply(request, ["ok": false, "reason": "target-changed"]); return
            }
            prepareAccessibility(destination)
            guard destination.activate(options: [.activateIgnoringOtherApps]) else { reply(request, ["ok": false, "reason": "target-changed"]); return }
            let deadline = ProcessInfo.processInfo.systemUptime + 3
            let clipboardChange = NSPasteboard.general.changeCount
            func attemptPaste() {
                guard !destination.isTerminated,
                      NSWorkspace.shared.frontmostApplication?.processIdentifier == destination.processIdentifier else {
                    reply(request, ["ok": false, "reason": "target-changed"]); return
                }
                if let expectedWindow = item?.window {
                    guard let window = focusedWindow(destination), CFEqual(window, expectedWindow) else {
                        reply(request, ["ok": false, "reason": "target-changed"]); return
                    }
                }
                let (current, failure) = snapshot(destination, budget: 0.15)
                guard let current = current else {
                    if ["caret-unavailable", "timeout"].contains(failure), ProcessInfo.processInfo.systemUptime < deadline {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: attemptPaste)
                    } else { reply(request, ["ok": false, "reason": failure]) }
                    return
                }
                let expected = item?.snapshot ?? current
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    let (verified, failure) = snapshot(destination)
                    guard let verified = verified else { reply(request, ["ok": false, "reason": failure]); return }
                    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == destination.processIdentifier,
                          NSPasteboard.general.changeCount == clipboardChange,
                          CFEqual(verified.element, expected.element), verified.range.location == expected.range.location,
                          verified.range.length == expected.range.length, verified.value == expected.value else {
                        reply(request, ["ok": false, "reason": "target-changed"]); return
                    }
                    guard let source = CGEventSource(stateID: .hidSystemState),
                        let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
                        let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else { reply(request, ["ok": false, "reason": "event-unavailable"]); return }
                    down.flags = .maskCommand; up.flags = .maskCommand
                    down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
                    reply(request, ["ok": true])
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: attemptPaste)
        }
    }
    exit(0)
}
print("{\"type\":\"ready\"}")
fflush(stdout)
RunLoop.main.run()
