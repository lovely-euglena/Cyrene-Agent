// 离屏渲染测试（T6 逐像素对照基建）：加载模型 → 设参数 → 渲一帧 → 落 PNG。
// 渲染器落地后填充；当前仅模型加载冒烟。
//
// 用法：cyrene-live2d --render-test --model-dir <dir> --out <png> [--params k=v,...] [--width N --height N]

namespace CyreneLive2D.SelfTest;

public static class RenderTest
{
    public static int Run(string[] args)
    {
        Console.Error.WriteLine("[render-test] 渲染器尚未落地（T2）——当前仅验证模型加载。");
        return 2;
    }
}
