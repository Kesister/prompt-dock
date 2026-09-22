import AppKit
let output = CommandLine.arguments[1]
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
window.contentView = textView
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(textView)
app.activate(ignoringOtherApps: true)
app.run()
