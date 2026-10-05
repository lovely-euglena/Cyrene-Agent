using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

namespace CyreneNative.Tools;

/// <summary>
/// write_word：美观 Word 文档生成（与 document-tools.ts write_word 同语义，IKJK3V T2 库替代批）。
///
/// 库替代：docx（JS）→ Open XML SDK。样式语义对齐：
///   - 默认样式（docDefaults）：正文 run 字体/字号/颜色 + 段落行距；
///   - 标题段：Heading1 样式 + 加粗/标题色/标题字号/标题字体 + after=200/行距；
///   - 正文段：每段 run 字体/字号/颜色 + after=120/行距。
/// 主题（字号为半磅、行距为 240 分之一行、颜色 RRGGBB）由 TS 侧解析 skills 样式后经内部参数注入；
/// 缺省值与 TS 默认商务主题一致。文件字节与 docx 库不逐字节一致（库不同），双轨按段落文本 + run 属性比对。
/// </summary>
internal static class WordTool
{
    internal sealed record WordTheme(
        string TitleColor, int TitleSize, string TitleFont,
        string BodyFont, int BodySize, string BodyColor,
        int LineSpacing, string HeadingColor);

    private static readonly WordTheme DefaultTheme = new(
        "1F4E79", 28, "微软雅黑", "微软雅黑", 24, "333333", 360, "1F4E79");

    public static string Execute(JsonElement args)
    {
        var path = Str(args, "path").Trim();
        if (path.Length == 0) throw new ToolHostException("E_WORD_PATH", "path 不能为空（TS 预检注入绝对路径）");
        var title = Str(args, "title");
        var paragraphs = ReadStrings(args, "paragraphs");
        var theme = ReadTheme(args);

        try
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            using var doc = WordprocessingDocument.Create(path, WordprocessingDocumentType.Document);
            var main = doc.AddMainDocumentPart();
            var body = new Body();
            body.Append(BuildParagraph(title, theme.TitleFont, theme.TitleSize, theme.TitleColor, bold: true, after: 200, line: theme.LineSpacing, heading: true));
            foreach (var p in paragraphs)
                body.Append(BuildParagraph(p, theme.BodyFont, theme.BodySize, theme.BodyColor, bold: false, after: 120, line: theme.LineSpacing, heading: false));
            body.Append(new SectionProperties(
                new PageSize { Width = 11906, Height = 16838 }, // A4（twips）
                new PageMargin { Top = 1440, Bottom = 1440, Left = 1440, Right = 1440 }));
            main.Document = new Document(body);

            var stylesPart = main.AddNewPart<StyleDefinitionsPart>();
            stylesPart.Styles = BuildStyles(theme);
            main.Document.Save();
        }
        catch (Exception ex) when (ex is not ToolHostException)
        {
            throw new ToolHostException("E_WORD_IO", "Word 生成失败: " + ex.Message);
        }
        return "[write_word] 已生成：" + path;
    }

    private static Paragraph BuildParagraph(
        string text, string font, int sizeHalfPoints, string colorHex, bool bold, int after, int line, bool heading)
    {
        var pPr = new ParagraphProperties();
        if (heading) pPr.Append(new ParagraphStyleId { Val = "Heading1" });
        pPr.Append(new SpacingBetweenLines { After = after.ToString(), Line = line.ToString(), LineRule = LineSpacingRuleValues.Auto });

        // CT_RPr 子元素顺序：rFonts → b/bCs → color → sz/szCs（schema 顺序，乱序 Word 可能判损坏）
        var rPr = new RunProperties(new RunFonts { Ascii = font, HighAnsi = font, EastAsia = font });
        if (bold)
        {
            rPr.Append(new Bold());
            rPr.Append(new BoldComplexScript());
        }
        rPr.Append(new Color { Val = colorHex });
        rPr.Append(new FontSize { Val = sizeHalfPoints.ToString() });
        rPr.Append(new FontSizeComplexScript { Val = sizeHalfPoints.ToString() });

        var run = new Run(rPr, new Text(text) { Space = SpaceProcessingModeValues.Preserve });
        return new Paragraph(pPr, run);
    }

    private static Styles BuildStyles(WordTheme theme)
    {
        var docDefaults = new DocDefaults(
            new RunPropertiesDefault(new RunPropertiesBaseStyle(
                new RunFonts { Ascii = theme.BodyFont, HighAnsi = theme.BodyFont, EastAsia = theme.BodyFont },
                new Color { Val = theme.BodyColor },
                new FontSize { Val = theme.BodySize.ToString() },
                new FontSizeComplexScript { Val = theme.BodySize.ToString() })),
            new ParagraphPropertiesDefault(new ParagraphPropertiesBaseStyle(
                new SpacingBetweenLines { Line = theme.LineSpacing.ToString(), LineRule = LineSpacingRuleValues.Auto })));

        var normal = new Style(new StyleName { Val = "Normal" })
        {
            Type = StyleValues.Paragraph,
            StyleId = "Normal",
            Default = true,
        };
        var heading1 = new Style(
            new StyleName { Val = "heading 1" },
            new BasedOn { Val = "Normal" },
            new NextParagraphStyle { Val = "Normal" },
            new StyleParagraphProperties(new OutlineLevel { Val = 0 }))
        {
            Type = StyleValues.Paragraph,
            StyleId = "Heading1",
        };
        return new Styles(docDefaults, normal, heading1);
    }

    private static WordTheme ReadTheme(JsonElement args)
    {
        if (!args.TryGetProperty("theme", out var t) || t.ValueKind != JsonValueKind.Object) return DefaultTheme;
        return new WordTheme(
            Hex6Or(t, "titleColor", DefaultTheme.TitleColor),
            IntOr(t, "titleSize", DefaultTheme.TitleSize),
            FontOr(t, "titleFont", DefaultTheme.TitleFont),
            FontOr(t, "bodyFont", DefaultTheme.BodyFont),
            IntOr(t, "bodySize", DefaultTheme.BodySize),
            Hex6Or(t, "bodyColor", DefaultTheme.BodyColor),
            IntOr(t, "lineSpacing", DefaultTheme.LineSpacing),
            Hex6Or(t, "headingColor", DefaultTheme.HeadingColor));
    }

    private static string Hex6Or(JsonElement obj, string key, string fallback)
    {
        var v = Str(obj, key).Trim().TrimStart('#').ToUpperInvariant();
        return v.Length == 6 ? v : fallback;
    }

    private static int IntOr(JsonElement obj, string key, int fallback)
        => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number
            ? (int)Math.Round(v.GetDouble())
            : fallback;

    private static string FontOr(JsonElement obj, string key, string fallback)
    {
        var v = Str(obj, key).Trim();
        return v.Length > 0 ? v : fallback;
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
