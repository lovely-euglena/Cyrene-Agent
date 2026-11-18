// 空闲帧率分档（T4）——逐式移植 src/renderer/live2d/manager.ts 的 idle FPS 策略。
// 满帧 60 → 空闲 60s 后 24 → 300s 后 12；看门狗 5s 评估一次；
// 互动信号（鼠标扫过/hit-test/交互）markActivity 立即回满帧。
// 时间基 = 宿主真实时间（PetEngine.RealNowMs）：web 走 performance.now()，
// 暂停期空闲计时不冻结（隐藏超 5min 恢复后起始档位与 web 一致）。

namespace CyreneLive2D.Behavior;

public sealed class IdleFpsGovernor
{
    private static readonly (double AfterMs, int Fps)[] Tiers =
    {
        (0, 60),
        (60_000, 24),
        (300_000, 12),
    };
    private const double WatchIntervalMs = 5_000;

    private double _lastActivityAt;
    private double _lastWatchAt;

    public int CurrentFps { get; private set; } = 60;

    public IdleFpsGovernor(double nowMs)
    {
        _lastActivityAt = nowMs;
        _lastWatchAt = nowMs;
    }

    /// <summary>互动信号：回满帧并重置空闲计时。</summary>
    public void MarkActivity(double nowMs)
    {
        _lastActivityAt = nowMs;
        CurrentFps = 60;
    }

    /// <summary>看门狗：每 5s 从最深档往回找第一个已达到的档位。</summary>
    public void Update(double nowMs)
    {
        if (nowMs - _lastWatchAt < WatchIntervalMs) return;
        _lastWatchAt = nowMs;

        double idleFor = nowMs - _lastActivityAt;
        for (int i = Tiers.Length - 1; i >= 0; i--)
        {
            if (idleFor >= Tiers[i].AfterMs)
            {
                CurrentFps = Tiers[i].Fps;
                break;
            }
        }
    }
}