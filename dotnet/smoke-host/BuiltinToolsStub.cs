// Linux 冒烟替代：NowTool/SysInfo 原实现（BuiltinTools.cs 带 WinForms 引用，
// 排除后此处重实现同名类）；ClipboardTool 返回不可用（Linux 无剪贴板属正常）。
using System.Text.Json;

namespace CyreneNative.Tools;

internal static class NowTool
{
    public static string Execute(JsonElement? args) => $$"""{"now":"{{DateTimeOffset.Now:O}}","tz":"smoke"}""";
}

internal static class SysInfo
{
    public static string Execute() => $$"""{"os":"linux-smoke","memory":"n/a"}""";
}

internal static class ClipboardTool
{
    public static string Execute(JsonElement? args) => """{"success":false,"errorCode":"E_CLIPBOARD","error":"Linux 冒烟无剪贴板"}""";
}
