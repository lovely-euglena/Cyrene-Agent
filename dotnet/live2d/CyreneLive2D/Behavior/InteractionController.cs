// 点击交互（T4）——逐式移植 src/renderer/live2d/interaction.ts + manager.ts buildHitAreaDefs。
// HitAreas 触发串 "group:motionName"：先按动作索引播放（NORMAL 优先级），
// 未注册则回退表情（Expression ?? motionName）。首个成功 → Trigger；首个失败 → Miss。
// 点击判定：down/up 位移 ≤ 5px（触屏 ×4）。命中名单由渲染层 hitTest 提供。

using CyreneLive2D.Model;
using CyreneLive2D.Motion;

namespace CyreneLive2D.Behavior;

/// <summary>解析后的命中区定义（manager.ts buildHitAreaDefs 同构）。</summary>
public sealed class ResolvedHitArea
{
    public string Name { get; init; } = "";
    public string Id { get; init; } = "";
    public string Group { get; init; } = "";
    public string MotionName { get; init; } = "";
    public int MotionIndex { get; init; } = -1;
    public string? ExpressionName { get; init; }
}

public sealed class InteractionController
{
    private readonly MotionManager _motions;
    private readonly ExpressionManager _expressions;
    private readonly Dictionary<string, ResolvedHitArea> _byName;
    private readonly float _clickThreshold;

    private float _downX, _downY;
    private ResolvedHitArea[] _downHits = Array.Empty<ResolvedHitArea>();

    public event Action<ResolvedHitArea>? Trigger;
    public event Action<ResolvedHitArea>? Miss;

    public InteractionController(
        MotionManager motions, ExpressionManager expressions,
        ResolvedHitArea[] hitAreaDefs, float clickThreshold = 5f)
    {
        _motions = motions;
        _expressions = expressions;
        _clickThreshold = clickThreshold;
        // 重名容错（首个生效）：web 轨 defs 为数组不按名建索引，
        // 第三方模型重名不应在加载期抛异常
        _byName = new Dictionary<string, ResolvedHitArea>(StringComparer.Ordinal);
        foreach (var a in hitAreaDefs) _byName.TryAdd(a.Name, a);
    }

    /// <summary>model3.json HitAreas → 解析定义（trigger "group:motionName"）。</summary>
    public static ResolvedHitArea[] BuildHitAreaDefs(Model3Json manifest)
    {
        var defs = new List<ResolvedHitArea>();
        foreach (var area in manifest.HitAreas)
        {
            // 对齐 web buildHitAreaDefs：Name/Id/Motion 任一缺失即跳过
            //（第三方/自定义模型条目可能不全，不能加载期抛异常）
            if (string.IsNullOrEmpty(area.Name) || string.IsNullOrEmpty(area.Id) || area.Motion == null) continue;
            int sep = area.Motion.IndexOf(':');
            if (sep <= 0) continue;
            string group = area.Motion[..sep];
            string motionName = area.Motion[(sep + 1)..];

            int motionIndex = -1;
            string? expressionName = null;
            if (manifest.Motions.TryGetValue(group, out var list))
            {
                for (int i = 0; i < list.Length; i++)
                {
                    if (list[i].Name == motionName) { motionIndex = i; break; }
                }
                if (motionIndex >= 0) expressionName = list[motionIndex].Expression;
            }

            defs.Add(new ResolvedHitArea
            {
                Name = area.Name,
                Id = area.Id,
                Group = group,
                MotionName = motionName,
                MotionIndex = motionIndex,
                ExpressionName = expressionName,
            });
        }
        return defs.ToArray();
    }

    public void RegisterDown(float x, float y, IReadOnlyList<string> hitNames)
    {
        _downX = x;
        _downY = y;
        var hits = new List<ResolvedHitArea>();
        foreach (var name in hitNames)
        {
            if (_byName.TryGetValue(name, out var def)) hits.Add(def);
        }
        _downHits = hits.ToArray();
    }

    public void RegisterUp(float x, float y, bool isTouch = false)
    {
        float dx = x - _downX;
        float dy = y - _downY;
        float dist = MathF.Sqrt(dx * dx + dy * dy);
        var hits = _downHits;
        _downHits = Array.Empty<ResolvedHitArea>();
        float threshold = isTouch ? _clickThreshold * 4 : _clickThreshold;
        if (dist > threshold) return;
        Fire(hits);
    }

    public void Cancel() => _downHits = Array.Empty<ResolvedHitArea>();

    private void Fire(ResolvedHitArea[] hits)
    {
        for (int i = 0; i < hits.Length; i++)
        {
            if (TryPlay(hits[i]))
            {
                Trigger?.Invoke(hits[i]);
                return;
            }
            if (i == 0) Miss?.Invoke(hits[i]);
        }
    }

    private bool TryPlay(ResolvedHitArea def)
    {
        if (def.MotionIndex >= 0
            && _motions.Definitions.TryGetValue(def.Group, out var defs)
            && def.MotionIndex < defs.Length)
        {
            if (_motions.StartMotion(def.Group, def.MotionIndex)) return true;
        }
        return _expressions.SetExpression(def.ExpressionName ?? def.MotionName);
    }
}