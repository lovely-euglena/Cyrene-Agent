using System.Text.Json;
using QuestPDF.Drawing;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;

namespace CyreneNative.Tools;

/// <summary>
/// write_pdf：PDF 生成（与 document-tools.ts write_pdf 同语义，IKJK3V T2 库替代批）。
///
/// 库替代：pdfkit → QuestPDF（Community 许可，开源项目适用）。
///   - 标题居中 22 号 + 段落 12 号，段间留白；
///   - 中文字体：注册系统 CJK 字体（msyh.ttc → simhei.ttf → simsun.ttc），
///     均不可用时回落 QuestPDF 默认字体（中文可能缺字形，与 TS"找不到则用默认"同口径）；
///   - 文件字节与 pdfkit 不逐字节一致（库不同），双轨按结果文案 + 文件签名比对，
///     文本内容由矩阵侧 PdfPig 提取断言。
/// </summary>
internal static class PdfTool
{
    private static readonly object FontLock = new();
    private static string? resolvedFont;
    private const string CjkFamily = "CyreneCJK";

    public static string Execute(JsonElement args)
    {
        var path = Str(args, "path").Trim();
        if (path.Length == 0) throw new ToolHostException("E_PDF_PATH", "path 不能为空（TS 预检注入绝对路径）");
        var title = Str(args, "title");
        var paragraphs = ReadStrings(args, "paragraphs");

        QuestPDF.Settings.License = LicenseType.Community; // 开源项目：QuestPDF 社区许可
        var font = EnsureFont();

        try
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            Document.Create(container =>
            {
                container.Page(page =>
                {
                    page.Size(PageSizes.A4);
                    page.Margin(50);
                    page.DefaultTextStyle(x => x.FontSize(12).FontFamily(font));
                    page.Content().Column(col =>
                    {
                        col.Item().AlignCenter().Text(title).FontSize(22);
                        col.Item().PaddingTop(12);
                        foreach (var p in paragraphs)
                        {
                            col.Item().Text(p).FontSize(12);
                            col.Item().PaddingTop(6);
                        }
                    });
                });
            }).GeneratePdf(path);
        }
        catch (Exception ex) when (ex is not ToolHostException)
        {
            throw new ToolHostException("E_PDF_IO", "PDF 生成失败: " + ex.Message);
        }
        return "[write_pdf] 已生成：" + path;
    }

    /// <summary>注册系统 CJK 字体（进程内一次）；返回可用字体族名。</summary>
    private static string EnsureFont()
    {
        lock (FontLock)
        {
            if (resolvedFont is not null) return resolvedFont;
            // 候选字体与预期族名（QuestPDF 2026.9 起按字体文件内的族名索引）
            var candidates = new (string File, string[] Families)[]
            {
                (@"C:\Windows\Fonts\msyh.ttc", new[] { "Microsoft YaHei", "Microsoft YaHei UI" }),
                (@"C:\Windows\Fonts\simhei.ttf", new[] { "SimHei" }),
                (@"C:\Windows\Fonts\simsun.ttc", new[] { "SimSun", "NSimSun" }),
            };
            foreach (var (file, families) in candidates)
            {
                if (!File.Exists(file)) continue;
                try
                {
                    FontManager.RegisterFontFromFile(file);
                    var registered = FontManager.GetRegisteredFonts()
                        .Select(f => f.FamilyName)
                        .ToHashSet(StringComparer.OrdinalIgnoreCase);
                    foreach (var name in families)
                    {
                        if (registered.Contains(name))
                        {
                            resolvedFont = name;
                            return resolvedFont;
                        }
                    }
                }
                catch
                {
                    // TTC/损坏文件注册失败：继续尝试下一个候选
                }
            }
            resolvedFont = "Lato"; // QuestPDF 内置默认（无 CJK 字形，与 TS 回退口径一致）
            return resolvedFont;
        }
    }

    private static List<string> ReadStrings(JsonElement obj, string key)
    {
        var list = new List<string>();
        if (!obj.TryGetProperty(key, out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
        foreach (var item in arr.EnumerateArray())
            list.Add(item.ValueKind == JsonValueKind.String ? item.GetString()! : "");
        return list;
    }

    private static string Str(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()!
            : "";
}
