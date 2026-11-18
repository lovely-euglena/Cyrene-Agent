// pixi-live2d-display 全局配置的 sidecar 镜像（T3）。
// 数值与 pld src/config.ts 默认值一致；web 轨未覆盖这些默认值（manager.ts 直接 Live2DModel.from）。
// 像素/行为对照以这些默认值为准。

namespace CyreneLive2D.Motion;

public static class Live2DConfig
{
    /// <summary>普通动作淡入淡出默认时长（ms）。model.json/motion.json 未定义时用。</summary>
    public static float MotionFadingDurationMs = 500;

    /// <summary>idle 动作淡入淡出默认时长（ms）。</summary>
    public static float IdleMotionFadingDurationMs = 2000;

    /// <summary>表情淡入淡出默认时长（ms）——仅 Cubism2 用；Cubism4 表情走 exp3.json（默认 1s）。</summary>
    public static float ExpressionFadingDurationMs = 500;

    /// <summary>动作播放时是否保留表情（pld 默认 true → 动作不覆盖表情）。</summary>
    public static bool PreserveExpressionOnMotion = true;

    /// <summary>动作音效。sidecar 无音频轨；Cyrene 模型 motion 无 Sound 定义，置 false。</summary>
    public static bool Sound = false;
}