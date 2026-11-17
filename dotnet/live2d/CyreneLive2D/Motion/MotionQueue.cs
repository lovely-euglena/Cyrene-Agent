// 动作队列基础设施（T3）——逐式移植 CubismWebFramework：
//   acubismmotion.ts / cubismmotionqueueentry.ts / cubismmotionqueuemanager.ts。
// 时间单位一律「秒」（pld Cubism4InternalModel.update 已把 ms/1000）。
// 注意：TS startMotion 的第三参 userTimeSeconds 被忽略——startTime 在首次
// DoUpdateMotion 的 SetupMotionQueueEntry 里才设定。本移植保持一致。

using CyreneLive2D.Model;

namespace CyreneLive2D.Motion;

/// <summary>动作基类（淡入淡出/权重/循环 + 队列条目生命周期）。Motion3/Expression3 继承。</summary>
public abstract class ACubismMotion
{
    public float FadeInSeconds { get; protected set; } = -1.0f;
    public float FadeOutSeconds { get; protected set; } = -1.0f;
    public float Weight { get; set; } = 1.0f;
    public float OffsetSeconds { get; set; } = 0.0f;
    public bool IsLoop { get; set; } = false;
    public bool IsLoopFadeIn { get; set; } = true;
    internal bool PreviousLoopState { get; set; }

    public Action<ACubismMotion>? OnBeganMotion { get; set; }
    public Action<ACubismMotion>? OnFinishedMotion { get; set; }

    protected ACubismMotion() { PreviousLoopState = IsLoop; }

    public void SetFadeInTime(float seconds) => FadeInSeconds = seconds;
    public void SetFadeOutTime(float seconds) => FadeOutSeconds = seconds;

    /// <summary>时长（秒）；循环动作返回 -1。子类覆写。</summary>
    public virtual float GetDuration() => -1.0f;
    public virtual float GetLoopDuration() => -1.0f;

    /// <summary>用户事件（UserData）；基类无事件。Motion3 覆写。</summary>
    public virtual IReadOnlyList<string> GetFiredEvent(float beforeCheckTimeSeconds, float motionTimeSeconds)
        => Array.Empty<string>();

    public void UpdateParameters(CubismModel model, MotionQueueEntry entry, float userTimeSeconds)
    {
        if (!entry.IsAvailable || entry.IsFinished) return;

        SetupMotionQueueEntry(entry, userTimeSeconds);
        float fadeWeight = UpdateFadeWeight(entry, userTimeSeconds);
        DoUpdateParameters(model, userTimeSeconds, fadeWeight, entry);

        // 结束时刻已过 → 置结束标志（队列管理器随后移除）
        if (entry.EndTimeSeconds > 0.0f && entry.EndTimeSeconds < userTimeSeconds)
        {
            entry.IsFinished = true;
        }
    }

    private void SetupMotionQueueEntry(MotionQueueEntry entry, float userTimeSeconds)
    {
        if (entry.IsStarted) return;
        if (!entry.IsAvailable) return;

        entry.IsStarted = true;
        entry.StartTimeSeconds = userTimeSeconds - OffsetSeconds;
        entry.FadeInStartTimeSeconds = userTimeSeconds;

        if (entry.EndTimeSeconds < 0.0f)
        {
            AdjustEndTime(entry);
        }
        OnBeganMotion?.Invoke(this);
    }

    public float UpdateFadeWeight(MotionQueueEntry entry, float userTimeSeconds)
    {
        float fadeWeight = Weight;

        float fadeIn = FadeInSeconds == 0.0f
            ? 1.0f
            : CubismMath.GetEasingSine((userTimeSeconds - entry.FadeInStartTimeSeconds) / FadeInSeconds);

        float fadeOut = (FadeOutSeconds == 0.0f || entry.EndTimeSeconds < 0.0f)
            ? 1.0f
            : CubismMath.GetEasingSine((entry.EndTimeSeconds - userTimeSeconds) / FadeOutSeconds);

        fadeWeight = fadeWeight * fadeIn * fadeOut;
        entry.SetState(userTimeSeconds, fadeWeight);
        return fadeWeight;
    }

    protected void AdjustEndTime(MotionQueueEntry entry)
    {
        float duration = GetDuration();
        float endTime = duration <= 0.0f ? -1.0f : entry.StartTimeSeconds + duration;
        entry.EndTimeSeconds = endTime;
    }

    /// <summary>把动作值写入模型（子类实现）。fadeWeight 已含淡入淡出。</summary>
    protected abstract void DoUpdateParameters(CubismModel model, float userTimeSeconds, float fadeWeight, MotionQueueEntry entry);
}

/// <summary>队列条目：记录单个动作实例的播放/淡入淡出时间轴。</summary>
public sealed class MotionQueueEntry
{
    public ACubismMotion? Motion { get; internal set; }
    public bool IsAvailable { get; set; } = true;
    public bool IsFinished { get; set; } = false;
    public bool IsStarted { get; set; } = false;
    public float StartTimeSeconds { get; set; } = -1.0f;
    public float FadeInStartTimeSeconds { get; set; } = 0.0f;
    public float EndTimeSeconds { get; set; } = -1.0f;
    public float StateTimeSeconds { get; private set; } = 0.0f;
    public float StateWeight { get; private set; } = 0.0f;
    public float LastCheckEventSeconds { get; set; } = 0.0f;
    public float FadeOutSeconds { get; private set; } = 0.0f;
    public bool IsTriggeredFadeOut { get; private set; } = false;

    public void SetState(float timeSeconds, float weight)
    {
        StateTimeSeconds = timeSeconds;
        StateWeight = weight;
    }

    /// <summary>标记淡出（新动作入场时触发）；实际结束时刻在 StartFadeout 设定。</summary>
    public void SetFadeout(float fadeOutSeconds)
    {
        FadeOutSeconds = fadeOutSeconds;
        IsTriggeredFadeOut = true;
    }

    public void StartFadeout(float fadeOutSeconds, float userTimeSeconds)
    {
        float newEndTimeSeconds = userTimeSeconds + fadeOutSeconds;
        IsTriggeredFadeOut = true;
        if (EndTimeSeconds < 0.0f || newEndTimeSeconds < EndTimeSeconds)
        {
            EndTimeSeconds = newEndTimeSeconds;
        }
    }
}

/// <summary>动作队列管理器：入场淡出旧动作、逐帧更新、移除已结束动作、发事件。</summary>
public sealed class MotionQueueManager
{
    private readonly List<MotionQueueEntry> _motions = new();

    /// <summary>用户事件回调（motion3.json UserData）；pld 发 "motion:"+value。</summary>
    public event Action<string>? MotionEvent;

    public IReadOnlyList<MotionQueueEntry> Entries => _motions;

    /// <summary>入场：先给既有动作打淡出标记，再追加新条目。返回新条目。</summary>
    public MotionQueueEntry StartMotion(ACubismMotion motion)
    {
        foreach (var entry in _motions)
        {
            if (entry.Motion != null)
            {
                entry.SetFadeout(entry.Motion.FadeOutSeconds);
            }
        }
        var newEntry = new MotionQueueEntry { Motion = motion };
        _motions.Add(newEntry);
        return newEntry;
    }

    public bool IsFinished()
    {
        for (int i = 0; i < _motions.Count;)
        {
            var entry = _motions[i];
            if (entry.Motion == null) { _motions.RemoveAt(i); continue; }
            if (!entry.IsFinished) return false;
            i++;
        }
        return true;
    }

    public void StopAllMotions() => _motions.Clear();

    /// <summary>逐帧更新所有动作；返回是否有动作实际更新。时间单位秒。</summary>
    public bool DoUpdateMotion(CubismModel model, float userTimeSeconds)
    {
        bool updated = false;
        for (int i = 0; i < _motions.Count;)
        {
            var entry = _motions[i];
            var motion = entry.Motion;
            if (motion == null) { _motions.RemoveAt(i); continue; }

            motion.UpdateParameters(model, entry, userTimeSeconds);
            updated = true;

            var firedList = motion.GetFiredEvent(
                entry.LastCheckEventSeconds - entry.StartTimeSeconds,
                userTimeSeconds - entry.StartTimeSeconds);
            foreach (var value in firedList) MotionEvent?.Invoke(value);
            entry.LastCheckEventSeconds = userTimeSeconds;

            if (entry.IsFinished)
            {
                _motions.RemoveAt(i);
            }
            else
            {
                if (entry.IsTriggeredFadeOut)
                {
                    entry.StartFadeout(entry.FadeOutSeconds, userTimeSeconds);
                }
                i++;
            }
        }
        return updated;
    }
}