// WinExe（GUI 子系统）自测模式附着父控制台，保证 exit code 之外的输出可见。
// 与 CyreneNative 自测同策；宿主模式（stdio 管道）不需要控制台。

using System.Runtime.InteropServices;

namespace CyreneLive2D;

internal static partial class ConsoleAttach
{
    private const int ATTACH_PARENT_PROCESS = -1;

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AttachConsole(int dwProcessId);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial IntPtr GetStdHandle(int nStdHandle);

    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    public static void Ensure()
    {
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            if (!AttachConsole(ATTACH_PARENT_PROCESS)) return;
            // 附着后重建 stdout/stderr 流（原流指向 NUL）
            var outStream = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(GetStdHandle(STD_OUTPUT_HANDLE), false), FileAccess.Write);
            var errStream = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(GetStdHandle(STD_ERROR_HANDLE), false), FileAccess.Write);
            Console.SetOut(new StreamWriter(outStream) { AutoFlush = true });
            Console.SetError(new StreamWriter(errStream) { AutoFlush = true });
        }
        catch
        {
            // 无父控制台（双击运行）时静默——输出不可见但退出码仍有效
        }
    }
}
