// 引擎 → 窗口壳的控制面（T2a）。PetEngine 经此接口下发窗口 op；
// 无头自测时 WindowControl=null，窗口 op 退化为无操作（协议仍回成功）。
// 坐标约定：本接口全部 DIP（与 Electron 主进程窗口语义一致）；
// DIP→物理像素换算由 PetWindowHost 内部完成。

namespace CyreneLive2D.Window;

public interface IWindowControl
{
    void Show();
    void Hide();
    void SetBoundsDip(int x, int y, int width, int height);
    void SetAlwaysOnTop(bool value);
    void SetInteractiveOverride(bool value);
}