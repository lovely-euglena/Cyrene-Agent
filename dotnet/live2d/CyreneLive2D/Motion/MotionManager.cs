// 动作播放编排（T3）——逐式移植 pld MotionManager.ts + Cubism4MotionManager.ts。
// reserve→load→start 状态机 + 淡入淡出默认值（model.json > motion.json > config）。
// 同步磁盘加载（sidecar 无网络异步）；reserve/start 间无并发抢占，但状态校验保持一致。
// 帧更新：IsFinished → motionFinish → restoreExpression → complete → 请求 idle。
//
// ⚠️ pld 从不 setLoop：Meta.Loop 被忽略，动作播一次即止（秋千 60.333s 后结束）。
//    idle 组默认 "Idle"；Cyrene 无此组 → 不自动播放 idle（与 web 轨一致）。

using System.Text.Json;
using CyreneLive2D.Model;

namespace CyreneLive2D.Motion;

public sealed class MotionManager
{
    private readonly Model3Json _manifest;
    private readonly string _modelDir;
    private readonly Dictionary<string, Motion3?[]> _motionGroups = new(StringComparer.Ordinal);
    private readonly HashSet<(string Group, int Index)> _failed = new();
    private readonly MotionQueueManager _queue = new();

    public IReadOnlyDictionary<string, MotionDef[]> Definitions { get; }
    public string IdleGroup { get; set; } = "Idle";
    public MotionState State { get; } = new();
    public ExpressionManager? ExpressionManager { get; set; }
    public bool Playing { get; private set; }

    public event Action<string, int>? MotionStart;
    public event Action? MotionFinish;
    public event Action<string>? MotionEvent;

    public MotionManager(Model3Json manifest, string modelDir)
    {
        _manifest = manifest;
        _modelDir = modelDir;
        Definitions = manifest.Motions;
        foreach (var (group, defs) in manifest.Motions)
        {
            _motionGroups[group] = new Motion3?[defs.Length];
        }
        _queue.MotionEvent += v => MotionEvent?.Invoke(v);
    }

    public bool IsFinished() => _queue.IsFinished();

    private MotionDef? GetDefinition(string group, int index)
        => Definitions.TryGetValue(group, out var defs) && index >= 0 && index < defs.Length ? defs[index] : null;

    private Motion3? LoadMotion(string group, int index)
    {
        var def = GetDefinition(group, index);
        if (def?.File == null) return null; // 表达式伪动作无 motion 文件
        if (_failed.Contains((group, index))) return null;
        if (_motionGroups[group][index] != null) return _motionGroups[group][index];
        try
        {
            var path = Path.Combine(_modelDir, def.File);
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var motion = CreateMotion(doc.RootElement, group, def);
            _motionGroups[group][index] = motion;
            return motion;
        }
        catch
        {
            _failed.Add((group, index));
            return null;
        }
    }

    /// <summary>淡入淡出优先级：model.json > motion.json > config（仅 motion.json 未定义时覆盖）。</summary>
    private Motion3 CreateMotion(JsonElement data, string group, MotionDef def)
    {
        var motion = Motion3.Create(data);
        float defaultFading = (group == IdleGroup
            ? Live2DConfig.IdleMotionFadingDurationMs
            : Live2DConfig.MotionFadingDurationMs) / 1000.0f;

        if (!motion.HasJsonFadeIn)
        {
            motion.SetFadeInTime(def.FadeInTime is > 0 ? def.FadeInTime.Value : defaultFading);
        }
        if (!motion.HasJsonFadeOut)
        {
            motion.SetFadeOutTime(def.FadeOutTime is > 0 ? def.FadeOutTime.Value : defaultFading);
        }
        motion.SetEffectIds(_manifest.EyeBlinkIds, _manifest.LipSyncIds);
        return motion;
    }

    public bool StartMotion(string group, int index, MotionPriority priority = MotionPriority.Normal)
    {
        if (!State.Reserve(group, index, priority)) return false;
        if (GetDefinition(group, index) == null) return false;

        var motion = LoadMotion(group, index);
        if (!State.Start(motion, group, index, priority)) return false;

        MotionStart?.Invoke(group, index);
        if (State.ShouldOverrideExpression()) ExpressionManager?.ResetExpression();

        Playing = true;
        StartMotionInternal(motion!);
        return true;
    }

    public bool StartRandomMotion(string group, MotionPriority priority = MotionPriority.Normal)
    {
        if (!Definitions.TryGetValue(group, out var defs) || defs.Length == 0) return false;
        var available = new List<int>();
        for (int i = 0; i < defs.Length; i++)
        {
            if (!_failed.Contains((group, i)) && !State.IsActive(group, i)) available.Add(i);
        }
        if (available.Count == 0) return false;
        return StartMotion(group, available[Random.Shared.Next(available.Count)], priority);
    }

    public void StopAllMotions()
    {
        _queue.StopAllMotions();
        State.Reset();
    }

    /// <summary>逐帧更新（时间单位秒）。返回是否有动作实际更新参数。</summary>
    public bool Update(CubismModel model, float nowSeconds)
    {
        if (IsFinished())
        {
            if (Playing)
            {
                Playing = false;
                MotionFinish?.Invoke();
            }
            if (State.ShouldOverrideExpression()) ExpressionManager?.RestoreExpression();
            State.Complete();
            if (State.ShouldRequestIdleMotion()) StartRandomMotion(IdleGroup, MotionPriority.Idle);
        }
        return _queue.DoUpdateMotion(model, nowSeconds);
    }

    private void StartMotionInternal(Motion3 motion)
    {
        _queue.StopAllMotions();
        _queue.StartMotion(motion);
    }
}