using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;
namespace CyreneNative;

/// <summary>
/// splash 启动屏（WPF 透明窗）。替代 Electron splash BrowserWindow：
/// - 布局对齐 create-splash-window.ts：520×520 居中、透明、无框、
///   置顶、跳过任务栏、鼠标穿透、不可移动
/// - loading.png logo（160×160）+ 三球弹跳动画（复刻 splash.html
///   的 loader__jumping：延迟 0/300/600ms、周期 1.2s）
/// - 首帧渲染完成即发 win.shown（对齐 Electron 的 onShown 回调
///   ——最短展示时长从实际 show 起算）
/// </summary>
public sealed class SplashWindow : NativeWindow
{
    private readonly Window _window;

    public override string Kind => "splash";
    public override bool IsClosed => _window == null;

    public SplashWindow()
    {
        var screen = SystemParameters.WorkArea;
        const int size = 520;

        var root = new Grid();

        // logo（找不到图片时静默跳过，仅显示动画）
        var logoPath = System.IO.Path.Combine(AppContext.BaseDirectory, "assets", "loading.png");
        if (File.Exists(logoPath))
        {
            var logo = new Image
            {
                Source = new BitmapImage(new Uri(logoPath)),
                Width = 160,
                Height = 160,
                Stretch = Stretch.Uniform,
            };
            root.Children.Add(logo);
        }

        // 三球弹跳动画（复刻 CSS loader__jumping）
        var loader = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Bottom,
            Margin = new Thickness(0, 0, 0, 90),
        };
        var colors = new[] { "#e499ff", "#e499ff", "#c98cff", "#c98cff", "#e499ff" };
        // nth-child(2n)=紫、(3n)=延迟600ms：5 球按 CSS 规则交替
        var delays = new[] { 0, 300, 600, 0, 300 };
        for (var i = 0; i < 5; i++)
        {
            var circle = new Ellipse
            {
                Width = 9,
                Height = 9,
                Fill = new SolidColorBrush((Color)ColorConverter.ConvertFromString(
                    i % 2 == 0 ? "#e499ff" : "#c98cff")),
                Margin = new Thickness(3.5, 0, 3.5, 0),
            };
            var jump = new DoubleAnimation
            {
                From = 0,
                To = -15,
                Duration = TimeSpan.FromSeconds(0.3),
                AutoReverse = false,
                EasingFunction = new QuadraticEase(),
            };
            // 完整周期 1.2s：0→-15（25%）、-15→0（50%）、0→5→0（75-100%）
            var anim = new DoubleAnimationUsingKeyFrames
            {
                Duration = TimeSpan.FromSeconds(1.2),
                RepeatBehavior = RepeatBehavior.Forever,
                BeginTime = TimeSpan.FromMilliseconds(delays[i]),
            };
            anim.KeyFrames.Add(new EasingDoubleKeyFrame(0, KeyTime.FromPercent(0)));
            anim.KeyFrames.Add(new EasingDoubleKeyFrame(-15, KeyTime.FromPercent(0.25)));
            anim.KeyFrames.Add(new EasingDoubleKeyFrame(0, KeyTime.FromPercent(0.5)));
            anim.KeyFrames.Add(new EasingDoubleKeyFrame(5, KeyTime.FromPercent(0.75)));
            anim.KeyFrames.Add(new EasingDoubleKeyFrame(0, KeyTime.FromPercent(1.0)));
            var translate = new TranslateTransform();
            circle.RenderTransform = translate;
            translate.BeginAnimation(TranslateTransform.YProperty, anim);
            loader.Children.Add(circle);
        }
        root.Children.Add(loader);

        _window = new Window
        {
            Width = size,
            Height = size,
            Left = Math.Round((screen.Width - size) / 2 + screen.Left),
            Top = Math.Round((screen.Height - size) / 2 + screen.Top),
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ResizeMode = ResizeMode.NoResize,
            WindowStartupLocation = WindowStartupLocation.Manual,
            Topmost = true,
            ShowInTaskbar = false,
            ShowActivated = false,
            Content = root,
        };

        _window.SourceInitialized += (_, _) =>
        {
            // 鼠标穿透（对齐 setIgnoreMouseEvents(true)）
            var hwnd = new System.Windows.Interop.WindowInteropHelper(_window).Handle;
            const int gwlExStyle = -20;
            const int wsExTransparent = 0x20;
            const int wsExLayered = 0x80000;
            var style = NativeMethods.GetWindowLong(hwnd, gwlExStyle);
            NativeMethods.SetWindowLong(hwnd, gwlExStyle, style | wsExTransparent | wsExLayered);
        };
        _window.Closed += (_, _) => RaiseClosed();
    }

    public override void ShowWindow()
    {
        _window.Show();
        // 首帧渲染完成：cmd 事件（action=shown）驱动宿主侧 onShown —— 与
        // Electron ready-to-show → show → onShown 语义对齐。只发 cmd 帧
        // （win.shown 事件帧已删：宿主 handleFrame 对无 action 的事件帧
        // 走 default 分支，只会产生 unhandled warn 噪声）
        _window.Dispatcher.BeginInvoke(DispatcherPriority.Loaded, () =>
        {
            RequestRouter.SendCommand("splash", "shown");
        });
    }

    public override void Activate() => _window.Activate();
    public override void Close() => _window.Dispatcher.Invoke(() => _window.Close());
    public override void ApplyLayout(System.Text.Json.JsonElement layout)
    {
        // splash 固定居中，不参与布局联动
    }
}

internal static class NativeMethods
{
    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);

    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
    public static extern int SetWindowLong(System.IntPtr hWnd, int nIndex, int dwNewLong);
}
