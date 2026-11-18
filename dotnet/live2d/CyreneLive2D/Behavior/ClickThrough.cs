// 逐像素点击穿透（T4）——移植 src/renderer/live2d/click-through.ts 的判定逻辑。
// 光标下像素 alpha ≥ 阈值（默认 10，含抗锯齿半透明边）→ 可交互；否则穿透。
// 状态幂等：仅在翻转时通知（避免 IPC 刷屏）；resume 重置状态强制重新评估。
// 窗口层（T2a）负责光标轮询 + WS_EX_TRANSPARENT 切换；此处为纯判定。
// 注意：sidecar 回读缓冲为顶向下 DIB（无 WebGL 的 Y 翻转）。

namespace CyreneLive2D.Behavior;

public static class ClickThrough
{
    public const int DefaultAlphaThreshold = 10;

    /// <summary>顶向下 RGBA 缓冲中 (x,y) 像素是否属于模型（alpha ≥ 阈值）。</summary>
    public static bool HitTestAlpha(byte[] pixels, int width, int height, int x, int y, int alphaThreshold = DefaultAlphaThreshold)
    {
        if (x < 0 || y < 0 || x >= width || y >= height) return false;
        return pixels[(y * width + x) * 4 + 3] >= alphaThreshold;
    }
}

/// <summary>交互状态幂等门（web currentState 语义）。</summary>
public sealed class ClickThroughState
{
    private bool? _current;

    /// <summary>返回需要通知的新状态；无变化返回 null。</summary>
    public bool? Update(bool interactive)
    {
        if (interactive == _current) return null;
        _current = interactive;
        return interactive;
    }

    /// <summary>resume：清空状态，下次评估必然通知。</summary>
    public void Reset() => _current = null;
}