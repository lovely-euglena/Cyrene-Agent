using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>
/// clipboard：平台桥。Windows 实现在 cyrene-native（WPF 剪贴板，STA marshal），
/// 启动时经 <see cref="PlatformImpl"/> 注入；未注入（Linux / 冒烟壳 / 服务端）
/// = 不可用。协议形状与旧冒烟 stub 一致（ok 帧 + E_CLIPBOARD 数据）。
/// </summary>
internal static class ClipboardTool
{
    /// <summary>平台实现注入点（cyrene-native 设 WpfClipboardTool.Execute）。</summary>
    internal static Func<JsonElement?, object>? PlatformImpl { get; set; }

    private static bool _unavailableLogged;

    public static object Execute(JsonElement? args)
    {
        if (PlatformImpl is { } impl) return impl(args);
        if (!_unavailableLogged)
        {
            _unavailableLogged = true;
            Console.Error.WriteLine("[ClipboardTool] 当前平台无剪贴板实现（未注入；Linux/冒烟壳属正常）");
        }
        return """{"success":false,"errorCode":"E_CLIPBOARD","error":"当前平台无剪贴板实现"}""";
    }
}
