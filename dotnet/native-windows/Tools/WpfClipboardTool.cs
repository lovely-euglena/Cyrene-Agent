using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>
/// clipboard：WPF 剪贴板实现，STA 线程 marshal（后台线程调用安全）。
/// 经 <see cref="ClipboardTool.PlatformImpl"/> 注入 cyrene-core 的工具分发
/// （Windows-only 边界留在本工程，核心库保持 net10.0 跨平台）。
/// </summary>
internal static class WpfClipboardTool
{
    private const int ReadLimit = 200_000;

    public static object Execute(JsonElement? args)
    {
        var action = args?.TryGetProperty("action", out var a) == true ? a.GetString() : "read";
        if (action == "write")
        {
            var text = args?.TryGetProperty("text", out var t) == true ? t.GetString() : "";
            RunSta<bool>(() => { System.Windows.Clipboard.SetText(text ?? ""); return true; });
            return new { written = (text ?? "").Length };
        }
        // read
        var got = RunSta<string?>(() => System.Windows.Clipboard.ContainsText() ? System.Windows.Clipboard.GetText() : null);
        if (string.IsNullOrEmpty(got)) return new { text = "", empty = true };
        return new { text = got.Length > ReadLimit ? got[..ReadLimit] + $"\n…（已截断，共 {got.Length} 字符）" : got };
    }

    private static T RunSta<T>(Func<T> func)
    {
        if (Thread.CurrentThread.GetApartmentState() == ApartmentState.STA) return func();
        T result = default!;
        var t = new Thread(() => result = func());
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join(TimeSpan.FromSeconds(3));
        return result;
    }
}
