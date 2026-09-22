using System;
using System.Runtime.InteropServices;

internal static class PromptDockWinHelper
{
    private const byte VK_CONTROL = 0x11;
    private const byte VK_V = 0x56;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, Input[] inputs, int inputSize);

    [StructLayout(LayoutKind.Explicit)]
    private struct Input
    {
        [FieldOffset(0)]
        public uint type;

        [FieldOffset(8)]
        public InputUnion data;
    }

    [StructLayout(LayoutKind.Explicit, Size = 32)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        public KeyboardInput keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort virtualKey;
        public ushort scanCode;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    private static Input KeyboardEvent(byte virtualKey, uint flags)
    {
        return new Input
        {
            type = 1,
            data = new InputUnion
            {
                keyboard = new KeyboardInput
                {
                    virtualKey = virtualKey,
                    scanCode = 0,
                    flags = flags,
                    time = 0,
                    extraInfo = UIntPtr.Zero
                }
            }
        };
    }

    private static bool SendPaste()
    {
        var inputs = new[]
        {
            KeyboardEvent(VK_CONTROL, 0),
            KeyboardEvent(VK_V, 0),
            KeyboardEvent(VK_V, KEYEVENTF_KEYUP),
            KeyboardEvent(VK_CONTROL, KEYEVENTF_KEYUP)
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) == inputs.Length;
    }

    public static int Main(string[] args)
    {
        if (args.Length != 1 || args[0] != "paste")
        {
            Console.WriteLine("USAGE");
            return 2;
        }

        if (!SendPaste())
        {
            Console.WriteLine("INPUT_FAILED:" + Marshal.GetLastWin32Error());
            return 1;
        }

        Console.WriteLine("OK");
        return 0;
    }
}
