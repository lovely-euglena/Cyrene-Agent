// 说话荡秋千（T4）——逐式移植 src/renderer/live2d/speaking-motion.ts。
// start：以 IDLE 优先级播放 Tick3 组「荡秋千（待机）」（找不到名字回退索引 3）；
//        动作 Param32 关键帧喂物理摆锤（PhysicsSetting1）→ 自然惯性。
// stop：切断全部动作，把秋千独占参数 [Param32,Param13,Param14] 以 350ms
//       easeOutCubic 缓回 0；若全 |v|<0.001 则不挂恢复钩子。
// 恢复钩子常驻（t>=1 后持续写 0）——帧首 loadParameters 会还原动作期基值，
// 必须每帧压制（web 轨同语义）。时间显式注入。

using CyreneLive2D.Model;
using CyreneLive2D.Motion;

namespace CyreneLive2D.Behavior;

public sealed class SpeakingMotionController
{
    private const string SwingGroup = "Tick3";
    private const string SwingMotionName = "荡秋千（待机）";
    private const int FallbackSwingIndex = 3;
    private const double RestoreDurationMs = 350;
    private static readonly string[] SwingParams = { "Param32", "Param13", "Param14" };

    private readonly CubismModel _model;
    private readonly MotionManager _motions;

    private bool _restoreActive;
    private double _restoreStart;
    private double[] _restoreFrom = Array.Empty<double>();

    public bool IsRestoring => _restoreActive;

    public SpeakingMotionController(CubismModel model, MotionManager motions)
    {
        _model = model;
        _motions = motions;
    }

    public void Start(double nowMs)
    {
        DetachRestore();
        int index = FindSwingIndex();
        if (index < 0) return;
        // IDLE 优先级：仅在无动作时入场；任何 NORMAL 动作可打断。
        _motions.StartMotion(SwingGroup, index, MotionPriority.Idle);
    }

    public void Stop(double nowMs)
    {
        DetachRestore();
        _motions.StopAllMotions();
        AttachRestore(nowMs);
    }

    /// <summary>帧更新（恢复钩子位，beforeModelUpdate）。</summary>
    public void Tick(double nowMs)
    {
        if (!_restoreActive) return;
        double t = Math.Min(1, (nowMs - _restoreStart) / RestoreDurationMs);
        double fade = 1 - EaseOutCubic(t);
        for (int i = 0; i < SwingParams.Length; i++)
        {
            _model.SetParameterValueById(SwingParams[i], (float)(_restoreFrom[i] * fade), 1f);
        }
    }

    private static double EaseOutCubic(double t)
    {
        double inv = 1 - t;
        return 1 - inv * inv * inv;
    }

    private int FindSwingIndex()
    {
        if (!_motions.Definitions.TryGetValue(SwingGroup, out var defs) || defs.Length == 0) return -1;
        for (int i = 0; i < defs.Length; i++)
        {
            if (defs[i].Name == SwingMotionName) return i;
        }
        return FallbackSwingIndex < defs.Length ? FallbackSwingIndex : -1;
    }

    private void AttachRestore(double nowMs)
    {
        _restoreFrom = new double[SwingParams.Length];
        for (int i = 0; i < SwingParams.Length; i++)
        {
            _restoreFrom[i] = _model.GetParameterValueById(SwingParams[i]);
        }
        if (_restoreFrom.All(v => Math.Abs(v) < 0.001)) return;

        _restoreStart = nowMs;
        _restoreActive = true;
    }

    private void DetachRestore()
    {
        _restoreActive = false;
        _restoreFrom = Array.Empty<double>();
    }
}