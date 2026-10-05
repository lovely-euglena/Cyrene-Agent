using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using ClosedXML.Excel;

namespace CyreneNative.Tools;

/// <summary>
/// write_excel：美观 Excel 生成（与 document-tools.ts write_excel 同语义，IKJK3V T2 库替代批）。
///
/// 库替代：exceljs → ClosedXML。样式语义逐项对齐：
///   - 表头：白粗体 11 号 Calibri + 主题底色 + 居中 + 细边框（底部 medium 主题线）+ 行高 24；
///   - 数据行：全表细边框 + 隔行斑马纹（第 3/5/7… 数据行）+ 按表头推断数字格式 + 对齐；
///   - 列宽自适应（CJK 按 2 宽估算，钳制 10–45）+ 冻结首行 + 自动筛选。
///   - 主题（5 个 ARGB 色）由 TS 侧解析 skills 样式 + 自定义颜色后经内部参数注入；
///     缺省值与 TS DEFAULT_THEME 一致（默认深蓝）。
/// 文件字节与 exceljs 不逐字节一致（库不同），双轨按"单元格值 / 数字格式 / 列宽"投影比对。
/// </summary>
internal static class ExcelTool
{
    private static readonly JsonSerializerOptions Json = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal sealed record Theme(
        string HeaderFill, string HeaderFont, string HeaderBorder, string ZebraFill, string BorderColor);

    private static readonly Theme DefaultTheme = new("FF1F4E79", "FFFFFFFF", "FF1F4E79", "FFF2F2F2", "FFBFBFBF");

    public static string Execute(JsonElement args)
    {
        var path = Str(args, "path").Trim();
        if (path.Length == 0) throw new ToolHostException("E_EXCEL_PATH", "path 不能为空（TS 预检注入绝对路径）");
        if (!args.TryGetProperty("sheets", out var sheets) || sheets.ValueKind != JsonValueKind.Array || sheets.GetArrayLength() == 0)
            throw new ToolHostException("E_EXCEL_SHEETS", "sheets 不能为空");

        var theme = ReadTheme(args);
        var wb = new XLWorkbook();
        foreach (var sheet in sheets.EnumerateArray())
        {
            var name = Str(sheet, "name").Trim();
            if (name.Length == 0) name = "Sheet1";
            var ws = wb.AddWorksheet(name);
            var headers = ReadStrings(sheet, "headers");
            var rows = ReadRows(sheet, "rows");
            FillSheet(ws, headers, rows, theme);
        }

        try
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            wb.SaveAs(path);
        }
        catch (Exception ex)
        {
            throw new ToolHostException("E_EXCEL_IO", "Excel 生成失败: " + ex.Message);
        }
        return "[write_excel] 已生成：" + path;
    }

    private static void FillSheet(IXLWorksheet ws, List<string> headers, List<object?[]> rows, Theme theme)
    {
        // 写入数据（表头行 + 数据行；与 exceljs addRow 同：值按列序落位，空位留空）
        if (headers.Count > 0)
        {
            for (var i = 0; i < headers.Count; i++) SetCellValue(ws.Cell(1, i + 1), headers[i]);
        }
        for (var r = 0; r < rows.Count; r++)
        {
            var row = rows[r];
            for (var c = 0; c < row.Length; c++)
            {
                if (row[c] is not null) SetCellValue(ws.Cell(r + 2, c + 1), row[c]);
            }
        }

        var maxCols = headers.Count;
        foreach (var row in rows) maxCols = Math.Max(maxCols, row.Length);
        var totalRows = rows.Count + 1; // +1 表头（TS 同口径）

        var headerFill = XlColor(theme.HeaderFill);
        var headerFont = XlColor(theme.HeaderFont);
        var headerBorder = XlColor(theme.HeaderBorder);
        var zebraFill = XlColor(theme.ZebraFill);
        var borderColor = XlColor(theme.BorderColor);

        // 1. 表头样式（逐 cell；行级样式会铺到空列，TS 同）
        ws.Row(1).Height = 24;
        for (var c = 1; c <= maxCols; c++)
        {
            var cell = ws.Cell(1, c);
            if (cell.IsEmpty()) continue;
            cell.Style.Font.Bold = true;
            cell.Style.Font.FontColor = headerFont;
            cell.Style.Font.FontSize = 11;
            cell.Style.Font.FontName = "Calibri";
            cell.Style.Fill.BackgroundColor = headerFill;
            cell.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
            cell.Style.Alignment.Vertical = XLAlignmentVerticalValues.Center;
            SetThinBorder(cell, borderColor);
            cell.Style.Border.BottomBorder = XLBorderStyleValues.Medium;
            cell.Style.Border.BottomBorderColor = headerBorder;
        }

        // 2. 数据行：细边框 + 斑马纹 + 智能数字格式（TS：isZebra = (r-1)%2===0，r 为 Excel 行号）
        for (var r = 2; r <= totalRows; r++)
        {
            var isZebra = (r - 1) % 2 == 0;
            for (var c = 1; c <= maxCols; c++)
            {
                var cell = ws.Cell(r, c);
                if (cell.IsEmpty()) continue;
                SetThinBorder(cell, borderColor);
                if (isZebra) cell.Style.Fill.BackgroundColor = zebraFill;
                if (cell.Value.IsNumber)
                {
                    var num = cell.Value.GetNumber();
                    cell.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Right;
                    cell.Style.Alignment.Vertical = XLAlignmentVerticalValues.Center;
                    cell.Style.NumberFormat.Format = InferNumberFormat(headers, c, num);
                }
                else
                {
                    cell.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Left;
                    cell.Style.Alignment.Vertical = XLAlignmentVerticalValues.Center;
                }
            }
        }

        // 3. 列宽自适应（CJK 按 2 宽估算；表头 +4、数据 +2；钳制 10–45）
        for (var c = 1; c <= maxCols; c++)
        {
            double maxLen = c <= headers.Count ? JsWidth(headers[c - 1]) + 4 : 8;
            foreach (var row in rows)
            {
                if (c - 1 >= row.Length || row[c - 1] is null) continue;
                var len = JsWidth(JsString(row[c - 1]!));
                if (len + 2 > maxLen) maxLen = len + 2;
            }
            ws.Column(c).Width = Math.Min(Math.Max(maxLen, 10), 45);
        }

        // 4. 冻结首行
        ws.SheetView.FreezeRows(1);

        // 5. 自动筛选（有表头且有数据行时）
        if (headers.Count > 0 && rows.Count > 0)
            ws.Range(1, 1, totalRows, headers.Count).SetAutoFilter();
    }

    private static string InferNumberFormat(List<string> headers, int col, double value)
    {
        var headerText = col - 1 < headers.Count ? headers[col - 1].ToLowerInvariant() : "";
        if (headerText.Contains('年') || headerText.Contains("year")) return "0";
        if (Regex.IsMatch(headerText, "%|率|比|ratio|rate|涨|跌|幅")) return "0.0%";
        if (Regex.IsMatch(headerText, "\\$|元|价|额|金|amount|price|cost|revenue")) return "#,##0.00";
        if (value == Math.Floor(value) && Math.Abs(value) >= 1000) return "#,##0";
        return "#,##0.00";
    }

    private static void SetThinBorder(IXLCell cell, XLColor color)
    {
        cell.Style.Border.TopBorder = XLBorderStyleValues.Thin;
        cell.Style.Border.LeftBorder = XLBorderStyleValues.Thin;
        cell.Style.Border.BottomBorder = XLBorderStyleValues.Thin;
        cell.Style.Border.RightBorder = XLBorderStyleValues.Thin;
        cell.Style.Border.TopBorderColor = color;
        cell.Style.Border.LeftBorderColor = color;
        cell.Style.Border.BottomBorderColor = color;
        cell.Style.Border.RightBorderColor = color;
    }

    private static void SetCellValue(IXLCell cell, object? value)
    {
        switch (value)
        {
            case string s: cell.Value = s; break;
            case double d: cell.Value = d; break;
            case bool b: cell.Value = b; break;
        }
    }

    // ── 参数读取 ─────────────────────────────────────────────

    private static Theme ReadTheme(JsonElement args)
    {
        if (!args.TryGetProperty("theme", out var t) || t.ValueKind != JsonValueKind.Object) return DefaultTheme;
        return new Theme(
            ColorOr(t, "headerFill", DefaultTheme.HeaderFill),
            ColorOr(t, "headerFont", DefaultTheme.HeaderFont),
            ColorOr(t, "headerBorder", DefaultTheme.HeaderBorder),
            ColorOr(t, "zebraFill", DefaultTheme.ZebraFill),
            ColorOr(t, "borderColor", DefaultTheme.BorderColor));
    }

    private static string ColorOr(JsonElement obj, string key, string fallback)
    {
        var v = Str(obj, key).Trim();
        return v.Length == 8 ? v.ToUpperInvariant() : fallback;
    }

    private static XLColor XlColor(string argb)
        => XLColor.FromHtml("#" + argb[2..]); // ARGB 前两位 alpha（工具侧恒为 FF，见 TS toArgb）

    private static List<string> ReadStrings(JsonElement obj, string key)
    {
        var list = new List<string>();
        if (!obj.TryGetProperty(key, out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
        foreach (var item in arr.EnumerateArray()) list.Add(JsStringElement(item));
        return list;
    }

    private static List<object?[]> ReadRows(JsonElement obj, string key)
    {
        var rows = new List<object?[]>();
        if (!obj.TryGetProperty(key, out var arr) || arr.ValueKind != JsonValueKind.Array) return rows;
        foreach (var row in arr.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Array) continue;
            var cells = new List<object?>();
            foreach (var cell in row.EnumerateArray())
            {
                cells.Add(cell.ValueKind switch
                {
                    JsonValueKind.String => cell.GetString(),
                    JsonValueKind.Number => cell.GetDouble(),
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    _ => null,
                });
            }
            rows.Add(cells.ToArray());
        }
        return rows;
    }

    private static string JsStringElement(JsonElement el)
        => el.ValueKind switch
        {
            JsonValueKind.String => el.GetString()!,
            JsonValueKind.Number => JsNumber(el.GetDouble()),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => "",
        };

    /// <summary>JS String(value) 近似（列宽估算用；整数无小数位）。</summary>
    private static string JsString(object value)
        => value switch
        {
            string s => s,
            double d => JsNumber(d),
            bool b => b ? "true" : "false",
            _ => "",
        };

    private static string JsNumber(double d)
    {
        if (d == Math.Floor(d) && Math.Abs(d) < 1e15) return ((long)d).ToString(CultureInfo.InvariantCulture);
        return d.ToString("R", CultureInfo.InvariantCulture).Replace("E+", "e+").Replace("E-", "e-");
    }

    /// <summary>TS 宽度估算：UTF-16 码元 &gt;127 记 2，其余记 1。</summary>
    private static int JsWidth(string text)
    {
        var width = 0;
        foreach (var ch in text) width += ch > 127 ? 2 : 1;
        return width;
    }

    private static string Str(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()!
            : "";
}
