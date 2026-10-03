using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CyreneNative.Tools;

/// <summary>
/// 记账工具（record_expense / query_expense）——与 life-tools.ts 同语义：
///   - 本地 JSON 存储：{ToolHostConfig.DataDir}/expenses.json（config 帧注入 dataDir）
///   - record：正数校验；追加一条 {ts, amount, category, note}
///   - query：最近 N 天 / 分类过滤 / 汇总 or 明细（日期走 config 时区+locale）
///   - dataDir 未注入 / IO 异常 → ToolHostException 错误帧 → TS 包装层回退原实现
/// </summary>
internal static class ExpenseTools
{
    private sealed class ExpenseRecord
    {
        // 属性名与 TS 存储结构一致（跨轨互读）；声明顺序 = JSON 字段顺序
        public long ts { get; set; }
        public double amount { get; set; }
        public string category { get; set; } = "";
        public string note { get; set; } = "";
    }

    private static readonly JsonSerializerOptions StoreJson = new()
    {
        WriteIndented = true, // TS JSON.stringify(records, null, 2) 对齐
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, // 中文分类不转 \uXXXX
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    private static string StorePath()
    {
        var dir = ToolHostConfig.DataDir;
        if (string.IsNullOrEmpty(dir)) throw new ToolHostException("E_HOST_NO_DATA_DIR", "宿主未注入数据目录（config.dataDir）");
        return Path.Combine(dir, "expenses.json");
    }

    private static List<ExpenseRecord> Load()
    {
        try
        {
            var path = StorePath();
            if (!File.Exists(path)) return new List<ExpenseRecord>();
            return JsonSerializer.Deserialize<List<ExpenseRecord>>(File.ReadAllText(path), StoreJson) ?? new List<ExpenseRecord>();
        }
        catch (ToolHostException) { throw; }
        catch
        {
            return new List<ExpenseRecord>(); // TS loadExpenses：解析失败按空账本
        }
    }

    private static void Save(List<ExpenseRecord> records)
    {
        try
        {
            var path = StorePath();
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir); // dataDir 可能刚初始化
            File.WriteAllText(path, JsonSerializer.Serialize(records, StoreJson));
        }
        catch (ToolHostException) { throw; }
        catch (Exception ex)
        {
            throw new ToolHostException("E_EXPENSE_IO", "记账保存失败: " + ex.Message);
        }
    }

    public static string Record(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object)
            return "[错误] amount 必须是正数";
        var amount = args.TryGetProperty("amount", out var a) && a.ValueKind == JsonValueKind.Number ? a.GetDouble() : double.NaN;
        if (double.IsNaN(amount) || amount <= 0) return "[错误] amount 必须是正数";

        var rec = new ExpenseRecord
        {
            ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            amount = amount,
            category = StrOr(args, "category", "其他"),
            note = StrOr(args, "note", ""),
        };
        var records = Load();
        records.Add(rec);
        Save(records);
        return $"[record_expense] 已记录：{HostLocale.Fmt(amount)} 元 / {rec.category} / {rec.note}";
    }

    public static string Query(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object) args = EmptyObject();
        var days = args.TryGetProperty("days", out var d) && d.ValueKind == JsonValueKind.Number ? d.GetDouble() : 30;
        if (days == 0) days = 30; // TS: Number(args.days) || 30
        var cutoff = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - (long)(days * 86_400_000);

        var records = Load().Where(r => r.ts >= cutoff).ToList();
        if (args.TryGetProperty("category", out var catEl) && HostLocale.Truthy(catEl))
        {
            var cat = catEl.ValueKind == JsonValueKind.String ? catEl.GetString() : catEl.ToString();
            records = records.Where(r => r.category == cat).ToList();
        }
        if (records.Count == 0) return $"[query_expense] 最近 {HostLocale.Fmt(days)} 天没有记账记录";

        var summary = args.TryGetProperty("summary", out var s) && HostLocale.Truthy(s);
        if (summary)
        {
            var total = records.Sum(r => r.amount);
            // 分类汇总：按首次出现顺序输出，与 JS 对象键序一致
            var byCat = new List<KeyValuePair<string, double>>();
            foreach (var r in records)
            {
                var idx = byCat.FindIndex(kv => kv.Key == r.category);
                if (idx >= 0) byCat[idx] = new KeyValuePair<string, double>(r.category, byCat[idx].Value + r.amount);
                else byCat.Add(new KeyValuePair<string, double>(r.category, r.amount));
            }
            var json = "{" + string.Join(",", byCat.Select(kv => Quote(kv.Key) + ":" + HostLocale.Fmt(kv.Value))) + "}";
            return $"[query_expense] 最近 {HostLocale.Fmt(days)} 天共 {records.Count} 笔，合计 {total.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture)} 元\n分类：{json}";
        }

        var lines = records.Select(r =>
            $"{HostLocale.FormatDate(DateTimeOffset.FromUnixTimeMilliseconds(r.ts))} {HostLocale.Fmt(r.amount)}元 {r.category} {r.note}");
        return $"[query_expense] 最近 {HostLocale.Fmt(days)} 天 {records.Count} 笔：\n{string.Join("\n", lines)}";
    }

    private static JsonElement EmptyObject()
        => JsonDocument.Parse("{}").RootElement;

    private static string StrOr(JsonElement args, string key, string fallback)
        => args.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(el.GetString())
            ? el.GetString()!
            : fallback;

    /// <summary>JS JSON.stringify 字符串引号近似（转义 \\ 与 "，不转义非 ASCII）。</summary>
    private static string Quote(string value)
        => "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
}
