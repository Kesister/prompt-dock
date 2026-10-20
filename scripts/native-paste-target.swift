import AppKit
let output = CommandLine.arguments[1]
let mode = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "normal"
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let menu = NSMenu()
let editItem = NSMenuItem()
menu.addItem(editItem)
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editItem.submenu = editMenu
app.mainMenu = menu
let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 500, height: 250), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Prompt Dock — isolated paste test"
class TestTextView: NSTextView {
    override func didChangeText() {
        super.didChangeText()
        try? string.write(toFile: output, atomically: true, encoding: .utf8)
    }
}
let textView = TestTextView(frame: window.contentView!.bounds)
textView.isEditable = mode != "read-only"
let secure = NSSecureTextField(frame: NSRect(x: 20, y: 100, width: 420, height: 40))
if mode == "password" {
    window.contentView!.addSubview(secure)
} else { window.contentView = textView }
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(mode == "password" ? secure : textView)
app.activate(ignoringOtherApps: true)
// Test-only heartbeat: the next hotkey starts after the receiver actually
// regains foreground focus, rather than racing an unfinished app switch.
func writeFocusStatus() {
    let status: [String: Any] = ["active": NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier && window.isKeyWindow,
        "updatedAt": Date().timeIntervalSince1970 * 1000]
    if let bytes = try? JSONSerialization.data(withJSONObject: status) { try? bytes.write(to: URL(fileURLWithPath: output + ".status"), options: .atomic) }
}
let focusTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in writeFocusStatus() }
DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
    writeFocusStatus()
    let status: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier,
        "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
        "keyWindow": window.isKeyWindow, "firstResponder": String(describing: type(of: window.firstResponder!))]
    if let bytes = try? JSONSerialization.data(withJSONObject: status) { try? bytes.write(to: URL(fileURLWithPath: output + ".ready")) }
    // Reproduce a target application that stops answering Accessibility messages.
    if mode == "slow-capture" { Thread.sleep(forTimeInterval: 3.0) }
}
app.run()
