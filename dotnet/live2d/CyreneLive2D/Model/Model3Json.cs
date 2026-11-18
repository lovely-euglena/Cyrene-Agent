// model3.json 清单解析（T1）。格式为公开 JSON schema（Cubism 3/4/5 通用）。
// 兼容两种布局：FileReferences.Motions（现行）与顶层 Motions（旧导出，
// origin 上游分支曾直读顶层——双读兜底）。

using System.Text.Json;
using System.Text.Json.Serialization;
using CyreneLive2D.Host;

namespace CyreneLive2D.Model;

public sealed class Model3Json
{
    public string Moc { get; private set; } = "model.moc3";
    public string[] Textures { get; private set; } = Array.Empty<string>();
    public string? Physics { get; private set; }
    public string? Pose { get; private set; }
    public Dictionary<string, MotionDef[]> Motions { get; private set; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> Expressions { get; private set; } = new(StringComparer.Ordinal);
    public HitAreaDef[] HitAreas { get; private set; } = Array.Empty<HitAreaDef>();
    public string[] EyeBlinkIds { get; private set; } = Array.Empty<string>();
    public string[] LipSyncIds { get; private set; } = Array.Empty<string>();
    public float MouseTrackingSmoothTime { get; private set; } = 0.15f;
    public LayoutDef? Layout { get; private set; }

    public static Model3Json Load(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var root = doc.RootElement;
        var m = new Model3Json();

        var fileRefs = root.TryGetProperty("FileReferences", out var fr) ? fr : default;

        m.Moc = GetString(fileRefs, "Moc") ?? GetString(root, "Moc") ?? "model.moc3";
        m.Physics = GetString(fileRefs, "Physics") ?? GetString(root, "Physics");
        m.Pose = GetString(fileRefs, "Pose") ?? GetString(root, "Pose");

        if (fileRefs.ValueKind == JsonValueKind.Object && fileRefs.TryGetProperty("Textures", out var tex) && tex.ValueKind == JsonValueKind.Array)
        {
            m.Textures = tex.EnumerateArray().Select(t => t.GetString() ?? "").Where(t => t.Length > 0).ToArray();
        }

        // Motions：FileReferences 优先，顶层兜底
        var motionsEl = default(JsonElement);
        var hasMotions = (fileRefs.ValueKind == JsonValueKind.Object && fileRefs.TryGetProperty("Motions", out motionsEl))
            || root.TryGetProperty("Motions", out motionsEl);
        if (hasMotions && motionsEl.ValueKind == JsonValueKind.Object)
        {
            foreach (var group in motionsEl.EnumerateObject())
            {
                if (group.Value.ValueKind != JsonValueKind.Array) continue;
                var defs = new List<MotionDef>();
                foreach (var entry in group.Value.EnumerateArray())
                {
                    defs.Add(new MotionDef
                    {
                        Name = GetString(entry, "Name") ?? "",
                        File = GetString(entry, "File"),
                        Expression = GetString(entry, "Expression"),
                        NextMtn = GetString(entry, "NextMtn"),
                        Sound = GetString(entry, "Sound"),
                        FadeInTime = GetFloat(entry, "FadeInTime"),
                        FadeOutTime = GetFloat(entry, "FadeOutTime"),
                        WrapMode = GetInt(entry, "WrapMode") ?? 0,
                    });
                }
                m.Motions[group.Name] = defs.ToArray();
            }
        }

        // Expressions
        var exprEl = default(JsonElement);
        var hasExpr = (fileRefs.ValueKind == JsonValueKind.Object && fileRefs.TryGetProperty("Expressions", out exprEl))
            || root.TryGetProperty("Expressions", out exprEl);
        if (hasExpr && exprEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in exprEl.EnumerateArray())
            {
                var name = GetString(entry, "Name");
                var file = GetString(entry, "File");
                if (name != null && file != null) m.Expressions[name] = file;
            }
        }

        // Groups（EyeBlink / LipSync 参数白名单）
        if (root.TryGetProperty("Groups", out var groups) && groups.ValueKind == JsonValueKind.Array)
        {
            foreach (var g in groups.EnumerateArray())
            {
                var name = GetString(g, "Name");
                if (!g.TryGetProperty("Ids", out var ids) || ids.ValueKind != JsonValueKind.Array) continue;
                var idList = ids.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToArray();
                if (name == "EyeBlink") m.EyeBlinkIds = idList;
                else if (name == "LipSync") m.LipSyncIds = idList;
            }
        }

        // HitAreas（Name / Id=ArtMesh / Motion="group:motionName"）
        var hitEl = default(JsonElement);
        var hasHit = root.TryGetProperty("HitAreas", out hitEl)
            || (fileRefs.ValueKind == JsonValueKind.Object && fileRefs.TryGetProperty("HitAreas", out hitEl));
        if (hasHit && hitEl.ValueKind == JsonValueKind.Array)
        {
            var areas = new List<HitAreaDef>();
            foreach (var h in hitEl.EnumerateArray())
            {
                var name = GetString(h, "Name");
                var id = GetString(h, "Id");
                if (name == null || id == null) continue;
                areas.Add(new HitAreaDef { Name = name, Id = id, Motion = GetString(h, "Motion") });
            }
            m.HitAreas = areas.ToArray();
        }

        // Controllers（MouseTracking.SmoothTime 供 focus 参考；其余由行为层接管）
        if (root.TryGetProperty("Controllers", out var controllers) && controllers.ValueKind == JsonValueKind.Object)
        {
            if (controllers.TryGetProperty("MouseTracking", out var mt) && mt.ValueKind == JsonValueKind.Object)
            {
                m.MouseTrackingSmoothTime = GetFloat(mt, "SmoothTime") ?? 0.15f;
            }
        }

        // Layout（可选；Cyrene 模型未使用）
        if (root.TryGetProperty("Layout", out var layout) && layout.ValueKind == JsonValueKind.Object)
        {
            m.Layout = new LayoutDef
            {
                CenterX = GetFloat(layout, "CenterX") ?? 0,
                CenterY = GetFloat(layout, "CenterY") ?? 0,
                X = GetFloat(layout, "X") ?? 0,
                Y = GetFloat(layout, "Y") ?? 0,
                Width = GetFloat(layout, "Width") ?? 0,
                Height = GetFloat(layout, "Height") ?? 0,
                Scale = GetFloat(layout, "Scale") ?? 1,
            };
        }

        return m;
    }

    private static string? GetString(JsonElement el, string name)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    private static float? GetFloat(JsonElement el, string name)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
            ? (float)v.GetDouble()
            : null;

    private static int? GetInt(JsonElement el, string name)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
            ? v.GetInt32()
            : null;
}

public sealed class MotionDef
{
    public string Name { get; set; } = "";
    /// <summary>motion3.json 相对路径；表达式伪动作时为 null。</summary>
    public string? File { get; set; }
    /// <summary>表达式伪动作：触发的 exp3 名称。</summary>
    public string? Expression { get; set; }
    /// <summary>表达式伪动作链：下一动作 "group:name"。</summary>
    public string? NextMtn { get; set; }
    public string? Sound { get; set; }
    public float? FadeInTime { get; set; }
    public float? FadeOutTime { get; set; }
    /// <summary>0=未知 1=单次 2=循环（model3.json 语义）。</summary>
    public int WrapMode { get; set; }
}

public sealed class HitAreaDef
{
    public string Name { get; set; } = "";
    /// <summary>ArtMesh drawable Id。</summary>
    public string Id { get; set; } = "";
    /// <summary>"group:motionName" 触发器。</summary>
    public string? Motion { get; set; }
}

public sealed class LayoutDef
{
    public float CenterX { get; set; }
    public float CenterY { get; set; }
    public float X { get; set; }
    public float Y { get; set; }
    public float Width { get; set; }
    public float Height { get; set; }
    public float Scale { get; set; }
}
