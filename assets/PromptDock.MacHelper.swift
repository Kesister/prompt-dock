import AppKit
import ApplicationServices

// Keep the last external application without polling or reactivating Prompt Dock.
let owner = pid_t(CommandLine.arguments.dropFirst().first.flatMap(Int32.init) ?? 0)
var target: NSRunningApplication?
func remember(_ app: NSRunningApplication?) {
    guard let app = app, app.processIdentifier != owner,
          app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
          app.activationPolicy == .regular else { return }
    target = app
}
remember(NSWorkspace.shared.frontmostApplication)
let observer = NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { notification in
    remember(notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}
func reply(_ value: String) {
    print(value)
    fflush(stdout)
}
DispatchQueue.global().async {
    while let command = readLine() {
        DispatchQueue.main.async {
            if command == "status" {
                reply("STATUS:\(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "none"):\(AXIsProcessTrusted()):\(CGPreflightPostEventAccess())")
                return
            }
            guard command == "paste" else { return }
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            guard AXIsProcessTrustedWithOptions(options) else { reply("PERMISSION"); return }
            guard let app = target, !app.isTerminated else { reply("NO_TARGET"); return }
            if ProcessInfo.processInfo.environment["PROMPT_DOCK_USER_DATA"] != nil { reply("TARGET:\(app.bundleIdentifier ?? "unknown")") }
            guard app.activate(options: [.activateIgnoringOtherApps]) else { reply("NO_TARGET"); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
                    reply("NO_TARGET"); return
                }
                guard let source = CGEventSource(stateID: .hidSystemState),
                      let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else {
                    reply("FAILED"); return
                }
                down.flags = .maskCommand
                up.flags = .maskCommand
                down.post(tap: .cghidEventTap)
                up.post(tap: .cghidEventTap)
                reply("OK")
            }
        }
    }
    exit(0)
}
RunLoop.main.run()
