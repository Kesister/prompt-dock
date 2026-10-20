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
var captured: (String, Snapshot)?

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func focused(_ app: NSRunningApplication) -> AXUIElement? {
    guard let value = attribute(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedUIElementAttribute),
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func snapshot(_ app: NSRunningApplication?) -> (Snapshot?, String) {
    guard AXIsProcessTrusted() else { return (nil, "permission") }
    guard let app = app, !app.isTerminated, let element = focused(app) else { return (nil, "caret-unavailable") }
    // Check the focused element and ancestors; never inject into a secure field.
    var ancestor: AXUIElement? = element
    for _ in 0..<8 {
        guard let current = ancestor else { break }
        let role = attribute(current, kAXRoleAttribute) as? String ?? ""
        let subrole = attribute(current, kAXSubroleAttribute) as? String ?? ""
        if role.localizedCaseInsensitiveContains("secure") || subrole.localizedCaseInsensitiveContains("secure") {
            return (nil, "password")
        }
        if let parent = attribute(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() {
            ancestor = (parent as! AXUIElement)
        } else { ancestor = nil }
    }
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    guard [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role) else { return (nil, "caret-unavailable") }
    var editable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &editable) == .success,
          editable.boolValue, (attribute(element, kAXEnabledAttribute) as? Bool) != false else { return (nil, "read-only") }
    guard let rawRange = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(rawRange) == AXValueGetTypeID() else { return (nil, "caret-unavailable") }
    var range = CFRange()
    guard AXValueGetValue(rawRange as! AXValue, .cfRange, &range), range.location >= 0 else { return (nil, "caret-unavailable") }
    var point = CGPoint(x: 120, y: 120)
    var size = CGSize.zero
    if let raw = attribute(element, kAXPositionAttribute), CFGetTypeID(raw) == AXValueGetTypeID() { _ = AXValueGetValue(raw as! AXValue, .cgPoint, &point) }
    if let raw = attribute(element, kAXSizeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() { _ = AXValueGetValue(raw as! AXValue, .cgSize, &size) }
    point.y += min(size.height, 60)
    return (Snapshot(app: app, element: element, range: range, value: attribute(element, kAXValueAttribute) as? String, point: point), "")
}
func remember(_ app: NSRunningApplication?) {
    guard let app = app, app.processIdentifier != owner,
          app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
          app.activationPolicy == .regular else { return }
    target = app
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
        if let app = target, let field = focused(app) { result["role"] = attribute(field, kAXRoleAttribute) as? String ?? "none" }
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
                let (fresh, reason) = snapshot(target)
                guard let item = fresh else { captured = nil; reply(request, ["ok": false, "reason": reason]); return }
                let token = UUID().uuidString
                captured = (token, item)
                reply(request, ["ok": true, "token": token, "x": item.point.x, "y": item.point.y])
                return
            }
            guard type == "paste" else { reply(request, ["ok": false, "reason": "invalid-command"]); return }
            guard AXIsProcessTrusted() else { reply(request, ["ok": false, "reason": "permission"]); return }
            let item: Snapshot?
            let explicitTarget = command["token"] as? String
            if let token = command["token"] as? String {
                item = captured?.0 == token ? captured?.1 : nil
                captured = nil
            } else { item = nil }
            guard explicitTarget == nil || item != nil else { reply(request, ["ok": false, "reason": "target-changed"]); return }
            guard let destination = item?.app ?? target, !destination.isTerminated else { reply(request, ["ok": false, "reason": "caret-unavailable"]); return }
            // Browsers may stop exposing their focused field/selection while inactive.
            // Main-window clicks resolve the live field after activation. Palette tokens
            // still require the exact pre-popup field, selection and content.
            guard destination.activate(options: [.activateIgnoringOtherApps]) else { reply(request, ["ok": false, "reason": "target-changed"]); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                let (current, failure) = snapshot(destination)
                guard let current = current else { reply(request, ["ok": false, "reason": failure]); return }
                let expected = item ?? current
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                  let (verified, failure) = snapshot(destination)
                  guard let verified = verified else { reply(request, ["ok": false, "reason": failure]); return }
                  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == destination.processIdentifier,
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
        }
    }
    exit(0)
}
print("{\"type\":\"ready\"}")
fflush(stdout)
RunLoop.main.run()
