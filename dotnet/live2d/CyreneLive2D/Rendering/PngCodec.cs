// BGRA（顶行序）↔ PNG：System.Drawing（GDI+，Windows 内置，零 NuGet）。
// Format32bppArgb 内存字节序 = B,G,R,A，与 D3D11 回读缓冲一致，无需换序。
// 供 --render-test 落盘与 captureFrame 协议 op 使用。

using System.Drawing;
using System.Drawing.Imaging;

namespace CyreneLive2D.Rendering;

internal static class PngCodec
{
    public static void Save(string path, byte[] bgra, int width, int height)
    {
        using var bmp = ToBitmap(bgra, width, height);
        bmp.Save(path, ImageFormat.Png);
    }

    public static byte[] Encode(byte[] bgra, int width, int height)
    {
        using var bmp = ToBitmap(bgra, width, height);
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        return ms.ToArray();
    }

    private static Bitmap ToBitmap(byte[] bgra, int width, int height)
    {
        if (bgra.Length < width * height * 4) throw new ArgumentException("BGRA 缓冲尺寸不足。");
        var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        var data = bmp.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try
        {
            // GDI+ stride 可能含行尾填充——逐行拷贝
            for (var y = 0; y < height; y++)
            {
                System.Runtime.InteropServices.Marshal.Copy(bgra, y * width * 4, data.Scan0 + y * data.Stride, width * 4);
            }
        }
        finally
        {
            bmp.UnlockBits(data);
        }
        return bmp;
    }
}
