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
DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
    let status: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier,
        "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
        "keyWindow": window.isKeyWindow, "firstResponder": String(describing: type(of: window.firstResponder!))]
    if let bytes = try? JSONSerialization.data(withJSONObject: status) { try? bytes.write(to: URL(fileURLWithPath: output + ".ready")) }
}
app.run()
