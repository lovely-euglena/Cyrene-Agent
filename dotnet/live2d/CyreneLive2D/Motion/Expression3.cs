// exp3.json 表情（T3）——逐式移植 Framework CubismExpressionMotion.cpp / TS cubismexpressionmotion.ts。
// 表情是「特殊动作」：复用 ACubismMotion 的淡入淡出与队列机制。
// Blend：Add（current+value*w）/ Multiply（current*(1+(value-1)*w)）/ Overwrite（blend(current,value,w)）。
// 淡入淡出默认 1.0s（exp3.json 未给 FadeInTime/FadeOutTime 时）——注意不是 config 的 500ms（那是 Cubism2）。

using System.Text.Json;
using CyreneLive2D.Model;

namespace CyreneLive2D.Motion;

public enum ExpressionBlendType { Additive = 0, Multiply = 1, Overwrite = 2 }

public sealed class ExpressionParameter
{
    public string Id = "";
    public ExpressionBlendType Blend;
    public float Value;
}

public sealed class Expression3 : ACubismMotion
{
    private const float DefaultFadeTime = 1.0f;

    public List<ExpressionParameter> Parameters { get; } = new();

    public static Expression3 Load(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return Create(doc.RootElement);
    }

    public static Expression3 Create(JsonElement root)
    {
        var expression = new Expression3();
        expression.Parse(root);
        return expression;
    }

    /// <summary>空表情（defaultExpression）：无参数，用于 reset。</summary>
    public static Expression3 CreateEmpty() => new();

    private void Parse(JsonElement root)
    {
        FadeInSeconds = root.TryGetProperty("FadeInTime", out var fi) ? (float)fi.GetDouble() : DefaultFadeTime;
        FadeOutSeconds = root.TryGetProperty("FadeOutTime", out var fo) ? (float)fo.GetDouble() : DefaultFadeTime;

        if (!root.TryGetProperty("Parameters", out var paramsEl) || paramsEl.ValueKind != JsonValueKind.Array) return;
        foreach (var p in paramsEl.EnumerateArray())
        {
            var id = p.GetProperty("Id").GetString() ?? "";
            float value = p.TryGetProperty("Value", out var v) ? (float)v.GetDouble() : 0f;
            string? blend = p.TryGetProperty("Blend", out var b) ? b.GetString() : null;
            var blendType = blend switch
            {
                "Multiply" => ExpressionBlendType.Multiply,
                "Overwrite" => ExpressionBlendType.Overwrite,
                _ => ExpressionBlendType.Additive, // null / "Add" / 其它 → Additive
            };
            Parameters.Add(new ExpressionParameter { Id = id, Blend = blendType, Value = value });
        }
    }

    protected override void DoUpdateParameters(CubismModel model, float userTimeSeconds, float fadeWeight, MotionQueueEntry entry)
    {
        foreach (var p in Parameters)
        {
            switch (p.Blend)
            {
                case ExpressionBlendType.Additive:
                    model.AddParameterValueById(p.Id, p.Value, fadeWeight);
                    break;
                case ExpressionBlendType.Multiply:
                    model.MultiplyParameterValueById(p.Id, p.Value, fadeWeight);
                    break;
                case ExpressionBlendType.Overwrite:
                    model.SetParameterValueById(p.Id, p.Value, fadeWeight);
                    break;
            }
        }
    }
}