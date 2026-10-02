using System.Text.Json;

namespace CyreneEmbedSidecar;

/// <summary>
/// `cyrene-embed pandoc-probe [pandocPath]`：设置页「文档转换」检测命令。
/// stdout 输出单行 JSON（ok/exe/version/formats 或 ok=false/error），退出码恒 0，
/// 由宿主解析 JSON 决定展示文案。
/// </summary>
public static class PandocProbeCommand
{
    public static int Run(string? pandocPath)
    {
        var exe = PandocConverter.ResolveExecutable(pandocPath);
        if (exe is null)
        {
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                ok = false,
                error = string.IsNullOrWhiteSpace(pandocPath)
                    ? "未检测到 Pandoc（PATH 中没有 pandoc.exe）"
                    : $"自定义路径无效：{pandocPath}",
            }));
            return 0;
        }

        var probe = PandocConverter.Probe(exe);
        if (probe is null)
        {
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                ok = false,
                exe,
                error = $"无法运行 Pandoc（{exe}）",
            }));
            return 0;
        }

        Console.WriteLine(JsonSerializer.Serialize(new
        {
            ok = true,
            exe,
            version = probe.Version,
            formats = probe.InputFormats.Count,
        }));
        return 0;
    }
}
