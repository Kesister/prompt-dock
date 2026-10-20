using System;
using System.Runtime.InteropServices;

// Short-lived foreground permission handoff only. No input, clipboard or UIA access.
internal static class FocusGrant {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint process);
  public static int Main(string[] args) {
    uint owner,recipient,foreground;
    if(args.Length!=2||!UInt32.TryParse(args[0],out owner)||!UInt32.TryParse(args[1],out recipient)||recipient==0||recipient==UInt32.MaxValue)return 2;
    GetWindowThreadProcessId(GetForegroundWindow(),out foreground);
    if(foreground!=owner)return 3;
    bool allowed=AllowSetForegroundWindow(recipient);
    Console.WriteLine(allowed?"OK":"DENIED");return allowed?0:3;
  }
}
