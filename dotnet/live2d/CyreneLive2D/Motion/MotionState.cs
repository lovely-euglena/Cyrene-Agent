// 动作优先级状态机（T3）——逐式移植 pld src/cubism-common/MotionState.ts。
// reserve（加载前占位）→ start（加载完成放行）→ complete（播放结束）。
// IDLE 仅在无动作时入场；非 FORCE 须高于当前与已占位优先级；FORCE 无条件。
// undefined 语义用 null（string?/int?）表达。

namespace CyreneLive2D.Motion;

public enum MotionPriority
{
    None = 0,
    Idle = 1,
    Normal = 2,
    Force = 3,
}

public sealed class MotionState
{
    public MotionPriority CurrentPriority { get; private set; } = MotionPriority.None;
    public MotionPriority ReservePriority { get; private set; } = MotionPriority.None;
    public string? CurrentGroup { get; private set; }
    public int? CurrentIndex { get; private set; }
    public string? ReservedGroup { get; private set; }
    public int? ReservedIndex { get; private set; }
    public string? ReservedIdleGroup { get; private set; }
    public int? ReservedIdleIndex { get; private set; }

    /// <summary>占位一个待播放动作。成功返回 true。</summary>
    public bool Reserve(string group, int index, MotionPriority priority)
    {
        if (priority <= MotionPriority.None) return false;

        if (group == CurrentGroup && index == CurrentIndex) return false;

        if ((group == ReservedGroup && index == ReservedIndex) ||
            (group == ReservedIdleGroup && index == ReservedIdleIndex)) return false;

        if (priority == MotionPriority.Idle)
        {
            if (CurrentPriority != MotionPriority.None) return false;
            if (ReservedIdleGroup != null) return false;
            SetReservedIdle(group, index);
        }
        else
        {
            if (priority < MotionPriority.Force)
            {
                if (priority <= CurrentPriority) return false;
                if (priority <= ReservePriority) return false;
            }
            SetReserved(group, index, priority);
        }
        return true;
    }

    /// <summary>请求放行（加载完成后）。motion 为 null 或占位被抢走则拒绝。</summary>
    public bool Start(ACubismMotion? motion, string group, int index, MotionPriority priority)
    {
        if (priority == MotionPriority.Idle)
        {
            SetReservedIdle(null, null);
            if (CurrentPriority != MotionPriority.None) return false;
        }
        else
        {
            if (group != ReservedGroup || index != ReservedIndex) return false;
            SetReserved(null, null, MotionPriority.None);
        }

        if (motion == null) return false;

        SetCurrent(group, index, priority);
        return true;
    }

    public void Complete() => SetCurrent(null, null, MotionPriority.None);

    public void SetCurrent(string? group, int? index, MotionPriority priority)
    {
        CurrentPriority = priority;
        CurrentGroup = group;
        CurrentIndex = index;
    }

    public void SetReserved(string? group, int? index, MotionPriority priority)
    {
        ReservePriority = priority;
        ReservedGroup = group;
        ReservedIndex = index;
    }

    public void SetReservedIdle(string? group, int? index)
    {
        ReservedIdleGroup = group;
        ReservedIdleIndex = index;
    }

    public bool IsActive(string group, int index)
        => (group == CurrentGroup && index == CurrentIndex) ||
           (group == ReservedGroup && index == ReservedIndex) ||
           (group == ReservedIdleGroup && index == ReservedIdleIndex);

    public void Reset()
    {
        SetCurrent(null, null, MotionPriority.None);
        SetReserved(null, null, MotionPriority.None);
        SetReservedIdle(null, null);
    }

    public bool ShouldRequestIdleMotion() => CurrentGroup == null && ReservedIdleGroup == null;

    public bool ShouldOverrideExpression()
        => !Live2DConfig.PreserveExpressionOnMotion && CurrentPriority > MotionPriority.Idle;
}