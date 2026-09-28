using System.IO;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace CyreneNative;

/// <summary>
/// 原生窗口统一应用图标：从同级 Cyrene.exe（Electron 主程序）提取关联图标，
/// 进程内缓存（WPF ImageSource / WinForms Icon 各一份）；失败返回 null，不影响窗口。
/// 这些窗口自绘标题栏，图标主要用于任务栏与 Alt+Tab。
/// </summary>
internal static class AppIcons
{
    private static bool _imageResolved;
    private static ImageSource? _image;
    private static bool _formResolved;
    private static System.Drawing.Icon? _formIcon;

    /// <summary>WPF 窗口图标（冻结位图，可跨窗口复用）。</summary>
    public static ImageSource? Image
    {
        get
        {
            if (!_imageResolved)
            {
                _imageResolved = true;
                _image = ResolveImage();
            }
            return _image;
        }
    }

    /// <summary>WinForms 窗体图标（缓存实例，随进程存活）。</summary>
    public static System.Drawing.Icon? FormIcon
    {
        get
        {
            if (!_formResolved)
            {
                _formResolved = true;
                _formIcon = ResolveFormIcon();
            }
            return _formIcon;
        }
    }

    private static string? ResolveExe()
    {
        try
        {
            var exe = TrayHost.ResolveElectronExe();
            return File.Exists(exe) ? exe : null;
        }
        catch
        {
            return null;
        }
    }

    private static ImageSource? ResolveImage()
    {
        try
        {
            var exe = ResolveExe();
            if (exe is null) return null;
            using var icon = System.Drawing.Icon.ExtractAssociatedIcon(exe);
            if (icon is null) return null;
            var source = Imaging.CreateBitmapSourceFromHIcon(
                icon.Handle,
                new Int32Rect(0, 0, icon.Width, icon.Height),
                BitmapSizeOptions.FromEmptyOptions());
            source.Freeze();
            return source;
        }
        catch
        {
            return null;
        }
    }

    private static System.Drawing.Icon? ResolveFormIcon()
    {
        try
        {
            var exe = ResolveExe();
            return exe is null ? null : System.Drawing.Icon.ExtractAssociatedIcon(exe);
        }
        catch
        {
            return null;
        }
    }
}
