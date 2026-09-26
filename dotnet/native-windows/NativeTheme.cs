using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Shapes;

namespace CyreneNative;

/// <summary>
/// .NET 原生窗口共享视觉主题，对齐渲染层 pearl-white 设计 token：
///   主色粉 #FF5B8A（hover #E84A78）、辅助紫 #9F7AEA、
///   应用底 #F7F7FA / 卡片白、边框 #E5E5EA / #D2D2D7、
///   正文 #1D1D1F / 次要 #6F6876、圆角 8-12、柔和阴影。
///
/// 用 XamlReader 载入 ControlTemplate（比 FrameworkElementFactory 直观、少踩坑）。
/// Apply(window) 注入隐式样式：所有 TextBox / Button / CheckBox（开关）/ Slider
/// 自动套用，避免逐个控件手改。ComboBox 保持系统样式（自定义模板对可编辑
/// 下拉风险高）。
/// </summary>
public static class NativeTheme
{
    public static readonly FontFamily Font = new("Microsoft YaHei UI, Segoe UI, sans-serif");
    public static readonly FontFamily Mono = new("Consolas, Cascadia Mono, monospace");

    public static readonly Color Pink = Color.FromRgb(0xFF, 0x5B, 0x8A);
    public static readonly Color PinkDark = Color.FromRgb(0xE8, 0x4A, 0x78);
    public static readonly Color PinkSoft = Color.FromRgb(0xFF, 0xEC, 0xF2);
    public static readonly Color Violet = Color.FromRgb(0x9F, 0x7A, 0xEA);
    public static readonly Color TextStrong = Color.FromRgb(0x1D, 0x1D, 0x1F);
    public static readonly Color TextDefault = Color.FromRgb(0x2C, 0x2C, 0x2E);
    public static readonly Color TextMuted = Color.FromRgb(0x6F, 0x68, 0x76);
    public static readonly Color BorderSoft = Color.FromRgb(0xE5, 0xE5, 0xEA);
    public static readonly Color BorderStrong = Color.FromRgb(0xD2, 0xD2, 0xD7);
    public static readonly Color SurfaceApp = Color.FromRgb(0xF7, 0xF7, 0xFA);
    public static readonly Color SurfaceNav = Color.FromRgb(0xF5, 0xF5, 0xF7);

    // ── pearl-white 设置页组件原语（settings.css / theme.css 的浅色实现合成到白底） ──
    /// <summary>--rb-pink-50（选中卡/图标砖底色）。</summary>
    public static readonly Color Pink50 = Color.FromRgb(0xFF, 0xF1, 0xF6);
    /// <summary>--rb-pink-200（卡片描边）。</summary>
    public static readonly Color Pink200 = Color.FromRgb(0xFF, 0xB1, 0xCB);
    /// <summary>--rb-pink-600（选中态文字/hover）。</summary>
    public static readonly Color Pink600 = Color.FromRgb(0xE8, 0x4A, 0x78);
    /// <summary>预设卡未选中底（rgba(0,0,0,0.02) 合成白）。</summary>
    public static readonly Color CardSoftBg = Color.FromRgb(0xFA, 0xFA, 0xFA);
    /// <summary>浅色按钮底（--rb-bg-2 #FAFAFC，官网链/重置钮）。</summary>
    public static readonly Color ButtonSoftBg = Color.FromRgb(0xFA, 0xFA, 0xFC);
    /// <summary>默认徽标底（rgba(236,72,153,0.22) 合成白）。</summary>
    public static readonly Color BadgePinkBg = Color.FromRgb(0xFB, 0xD7, 0xE9);
    /// <summary>视觉徽标底（rgba(120,180,255,0.20) 合成白）。</summary>
    public static readonly Color BadgeVisionBg = Color.FromRgb(0xE4, 0xF0, 0xFF);
    /// <summary>档案卡选中底（rgba(236,72,153,0.16) 合成白）。</summary>
    public static readonly Color ProfileActiveBg = Color.FromRgb(0xFC, 0xE2, 0xEF);
    /// <summary>档案卡选中描边（rgba(255,182,220,0.30) 合成白）。</summary>
    public static readonly Color ProfileActiveBorder = Color.FromRgb(0xFF, 0xE9, 0xF5);
    /// <summary>档案卡未选中描边（rgba(255,182,220,0.14) 合成白）。</summary>
    public static readonly Color ProfileIdleBorder = Color.FromRgb(0xFF, 0xF5, 0xFA);
    /// <summary>开关未选中轨道（pearl-white .switch__track #F1EEF4）。</summary>
    public static readonly Color SwitchOffTrack = Color.FromRgb(0xF1, 0xEE, 0xF4);
    /// <summary>开关描边（pearl-white #D8D2DC）。</summary>
    public static readonly Color SwitchBorder = Color.FromRgb(0xD8, 0xD2, 0xDC);
    /// <summary>API 提示条描边（rgba(255,182,220,0.13) 合成白）。</summary>
    public static readonly Color NoteBorder = Color.FromRgb(0xFF, 0xF6, 0xFA);

    public static readonly SolidColorBrush Pink50Brush = Brush(Pink50);
    public static readonly SolidColorBrush Pink200Brush = Brush(Pink200);
    public static readonly SolidColorBrush Pink600Brush = Brush(Pink600);
    public static readonly SolidColorBrush CardSoftBgBrush = Brush(CardSoftBg);
    public static readonly SolidColorBrush ButtonSoftBgBrush = Brush(ButtonSoftBg);
    public static readonly SolidColorBrush BadgePinkBrush = Brush(BadgePinkBg);
    public static readonly SolidColorBrush BadgeVisionBrush = Brush(BadgeVisionBg);
    public static readonly SolidColorBrush NoteBorderBrush = Brush(NoteBorder);

    public static SolidColorBrush Brush(Color color)
    {
        var brush = new SolidColorBrush(color);
        brush.Freeze();
        return brush;
    }

    public static readonly SolidColorBrush PinkBrush = Brush(Pink);
    public static readonly SolidColorBrush PinkDarkBrush = Brush(PinkDark);
    public static readonly SolidColorBrush PinkSoftBrush = Brush(PinkSoft);
    public static readonly SolidColorBrush VioletBrush = Brush(Violet);
    public static readonly SolidColorBrush TextStrongBrush = Brush(TextStrong);
    public static readonly SolidColorBrush TextDefaultBrush = Brush(TextDefault);
    public static readonly SolidColorBrush TextMutedBrush = Brush(TextMuted);
    public static readonly SolidColorBrush BorderSoftBrush = Brush(BorderSoft);
    public static readonly SolidColorBrush BorderStrongBrush = Brush(BorderStrong);
    public static readonly SolidColorBrush SurfaceAppBrush = Brush(SurfaceApp);
    public static readonly SolidColorBrush SurfaceNavBrush = Brush(SurfaceNav);

    /// <summary>投影基色（对齐 --rb-shadow 的冷灰基调）。</summary>
    public static readonly Color ShadowColor = Color.FromRgb(0x1F, 0x23, 0x30);

    /// <summary>卡片投影：对齐 pearl-white --rb-shadow-card（1px 贴地 + 大扩散浅影）。</summary>
    public static DropShadowEffect CardShadow() => new()
    {
        Color = ShadowColor,
        BlurRadius = 14,
        ShadowDepth = 1,
        Direction = 270,
        Opacity = 0.10,
        RenderingBias = RenderingBias.Performance,
    };

    /// <summary>窗口投影：贴在日常内容壳下方的一层（比卡片投影更大更深）。</summary>
    public static DropShadowEffect WindowShadow() => new()
    {
        Color = ShadowColor,
        BlurRadius = 26,
        ShadowDepth = 3,
        Direction = 270,
        Opacity = 0.22,
        RenderingBias = RenderingBias.Performance,
    };

    /// <summary>给卡片套投影（Effect 每元素独立，避免共享冻结带来的动画限制）。</summary>
    public static void ApplyCardShadow(FrameworkElement element) => element.Effect = CardShadow();

    /// <summary>
    /// 无边框透明窗的投影层：与内容壳同圆角、纯白底，仅用于把 Effect 的
    /// 阴影画在窗口透明留白里（内容壳用同样的 margin 盖在它上面）。
    /// 消费方需把窗口宽高各 +2*margin，视觉尺寸保持不变。
    /// </summary>
    public static Border MakeWindowShadowLayer(double radius, double margin = 16) => new()
    {
        CornerRadius = new CornerRadius(radius),
        Background = Brushes.White,
        Margin = new Thickness(margin),
        Effect = WindowShadow(),
        SnapsToDevicePixels = true,
    };

    /// <summary>hover 抬升动效时长（对齐 Electron 120ms）。</summary>
    public static readonly Duration HoverDuration = new(TimeSpan.FromMilliseconds(120));

    /// <summary>开关滑块动效（对齐 Electron 180ms cubic-bezier(.2,.8,.2,1)）。</summary>
    public static readonly IEasingFunction SwitchEase = new CubicEase { EasingMode = EasingMode.EaseOut };

    private const string Ns =
        "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
        "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"";

    private static Style Parse(string xaml) => (Style)XamlReader.Parse(xaml);

    private static readonly System.Lazy<Style> FocusRingLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="Control">
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="Control">
        <Border CornerRadius="9" BorderBrush="#FF5B8A" BorderThickness="1.5" Margin="1"
                SnapsToDevicePixels="True" Opacity="0.9"/>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
"""));

    /// <summary>粉色焦点环（键盘可达性；鼠标点击不显示）。</summary>
    public static Style FocusRingStyle => FocusRingLazy.Value;

    /// <summary>给控件样式挂上焦点环。</summary>
    private static Style WithFocusRing(Style style)
    {
        style.Setters.Add(new Setter(Control.FocusVisualStyleProperty, FocusRingStyle));
        return style;
    }

    // ── 窗口标题栏圆钮（对齐 Electron pearl-white .win-btn / .sidebar__winbtn） ──
    // pearl-white 下所有窗口按钮统一为「白底圆钮 + 细边框」：28px（侧栏/日程/对话框）、
    // 30px（设置/插件）；hover = 粉描边 + 浅灰底 + 边框加深；按下底色再深一档。

    /// <summary>hover 底色（--rb-hover-light rgba(0,0,0,0.04) 合成到白底）。</summary>
    private static readonly SolidColorBrush ButtonHoverBrush = Brush(Color.FromRgb(0xF5, 0xF5, 0xF5));
    /// <summary>按下底色（--rb-active-light rgba(0,0,0,0.08) 合成到白底）。</summary>
    private static readonly SolidColorBrush ButtonPressedBrush = Brush(Color.FromRgb(0xEB, 0xEB, 0xEB));

    private static readonly System.Lazy<Style> WindowButton28Lazy = new(() => BuildWindowButtonStyle(28));
    private static readonly System.Lazy<Style> WindowButton30Lazy = new(() => BuildWindowButtonStyle(30));

    public static Style WindowButton28Style => WindowButton28Lazy.Value;
    public static Style WindowButton30Style => WindowButton30Lazy.Value;

    private static Style BuildWindowButtonStyle(double size)
    {
        var style = new Style(typeof(Button));
        style.Setters.Add(new Setter(FrameworkElement.WidthProperty, size));
        style.Setters.Add(new Setter(FrameworkElement.HeightProperty, size));
        style.Setters.Add(new Setter(Control.ForegroundProperty, TextDefaultBrush));
        style.Setters.Add(new Setter(Control.FocusableProperty, false));
        style.Setters.Add(new Setter(Control.CursorProperty, Cursors.Hand));
        style.Setters.Add(new Setter(FrameworkElement.MarginProperty, new Thickness(2, 0, 2, 0)));
        var template = new ControlTemplate(typeof(Button));
        var bg = new FrameworkElementFactory(typeof(Border), "bg");
        bg.SetValue(Border.BackgroundProperty, Brushes.White);
        bg.SetValue(Border.BorderBrushProperty, BorderSoftBrush);
        bg.SetValue(Border.BorderThicknessProperty, new Thickness(1));
        bg.SetValue(Border.CornerRadiusProperty, new CornerRadius(size / 2));
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
        presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
        presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
        bg.AppendChild(presenter);
        template.VisualTree = bg;
        var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
        hover.Setters.Add(new Setter(Control.ForegroundProperty, PinkDarkBrush));
        hover.Setters.Add(new Setter(Border.BackgroundProperty, ButtonHoverBrush) { TargetName = "bg" });
        hover.Setters.Add(new Setter(Border.BorderBrushProperty, BorderStrongBrush) { TargetName = "bg" });
        template.Triggers.Add(hover);
        var pressed = new Trigger { Property = Button.IsPressedProperty, Value = true };
        pressed.Setters.Add(new Setter(Border.BackgroundProperty, ButtonPressedBrush) { TargetName = "bg" });
        template.Triggers.Add(pressed);
        style.Setters.Add(new Setter(Control.TemplateProperty, template));
        return WithFocusRing(style);
    }

    /// <summary>图标描边/填充跟随所在 Button 的 Foreground（hover 变粉自动生效）。</summary>
    private static void BindToButtonForeground(System.Windows.Shapes.Shape shape, DependencyProperty property) =>
        BindingOperations.SetBinding(shape, property, new Binding("Foreground")
        {
            RelativeSource = new RelativeSource(RelativeSourceMode.FindAncestor, typeof(Button), 1),
        });

    /// <summary>SVG path 数据 → WPF 轮廓图标（48 视框等比缩放到 size；可选固定颜色）。</summary>
    public static FrameworkElement VectorGlyph(string svgData, double size = 16, Brush? color = null, double strokeWidth = 4, string? fillData = null)
    {
        var canvas = new Canvas { Width = 48, Height = 48, IsHitTestVisible = false };
        var path = new System.Windows.Shapes.Path
        {
            Data = Geometry.Parse(svgData),
            StrokeThickness = strokeWidth,
            StrokeLineJoin = PenLineJoin.Round,
            StrokeStartLineCap = PenLineCap.Round,
            StrokeEndLineCap = PenLineCap.Round,
            Fill = Brushes.Transparent,
            Stroke = color ?? TextMutedBrush,
        };
        if (color is null) BindToButtonForeground(path, System.Windows.Shapes.Shape.StrokeProperty);
        canvas.Children.Add(path);
        if (fillData is not null)
        {
            // 同一图标里的实心部分（如聊天气泡的三个点）：填充跟随 Foreground
            var filled = new System.Windows.Shapes.Path
            {
                Data = Geometry.Parse(fillData),
                Fill = color ?? TextMutedBrush,
                Stroke = null,
            };
            if (color is null) BindToButtonForeground(filled, System.Windows.Shapes.Shape.FillProperty);
            canvas.Children.Add(filled);
        }
        return new Viewbox { Width = size, Height = size, Child = canvas, Stretch = Stretch.Uniform, IsHitTestVisible = false };
    }

    /// <summary>单色填充图标（如线稿头像）：指定视框等比缩放，NoneZero 填充规则（对齐 SVG 默认）。</summary>
    public static FrameworkElement FilledGlyph(string data, double size, Brush color, double viewBox = 48)
    {
        var geometry = Geometry.Parse(data);
        if (geometry is PathGeometry pathGeometry) pathGeometry.FillRule = FillRule.Nonzero;
        var path = new System.Windows.Shapes.Path { Data = geometry, Fill = color, Stroke = null };
        var canvas = new Canvas { Width = viewBox, Height = viewBox, IsHitTestVisible = false };
        canvas.Children.Add(path);
        return new Viewbox { Width = size, Height = size, Child = canvas, Stretch = Stretch.Uniform, IsHitTestVisible = false };
    }

    /// <summary>最小化字形：9/10×2 圆角条（Electron 的两套尺寸）。</summary>
    public static FrameworkElement MinimizeGlyph(double size)
    {
        var width = size >= 30 ? 10.0 : 9.0;
        var rect = new Rectangle { Width = width, Height = 2, RadiusX = 1, RadiusY = 1 };
        BindToButtonForeground(rect, System.Windows.Shapes.Shape.FillProperty);
        return rect;
    }

    /// <summary>关闭字形：两条 1.4 圆帽斜线。</summary>
    public static FrameworkElement CloseGlyph(double size)
    {
        var span = size >= 30 ? 10.0 : 9.0;
        var path = new System.Windows.Shapes.Path
        {
            Data = Geometry.Parse($"M2,2 L{span - 2},{span - 2} M{span - 2},2 L2,{span - 2}"),
            StrokeThickness = 1.4,
            StrokeStartLineCap = PenLineCap.Round,
            StrokeEndLineCap = PenLineCap.Round,
            StrokeLineJoin = PenLineJoin.Round,
            Fill = Brushes.Transparent,
        };
        BindToButtonForeground(path, System.Windows.Shapes.Shape.StrokeProperty);
        return path;
    }

    /// <summary>圆钮工厂：内容 + 尺寸 + 提示 + 动作。</summary>
    public static Button MakeCircleButton(FrameworkElement content, double size, string tip, Action onClick)
    {
        var btn = new Button
        {
            Content = content,
            ToolTip = tip,
            Style = size >= 30 ? WindowButton30Style : WindowButton28Style,
        };
        btn.Click += (_, _) => onClick();
        return btn;
    }

    /// <summary>最小化按钮（窗口圆钮）。用委托取窗口：调用方可在 _window 赋值前构建标题栏。</summary>
    public static Button MakeMinimizeButton(Func<Window> window, double size = 28) =>
        MakeCircleButton(MinimizeGlyph(size), size, "最小化", () => window().WindowState = WindowState.Minimized);

    /// <summary>关闭按钮（窗口圆钮）。</summary>
    public static Button MakeCloseButton(Func<Window> window, double size = 28) =>
        MakeCircleButton(CloseGlyph(size), size, "关闭", () => window().Close());

    /// <summary>白卡浮层 Tooltip（图表/数据点提示；对齐 pearl-white 阴影语言）。</summary>
    private static readonly System.Lazy<Style> ToolTipLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="ToolTip">
  <Setter Property="Foreground" Value="#1D1D1F"/>
  <Setter Property="FontSize" Value="12.5"/>
  <Setter Property="HasDropShadow" Value="False"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="ToolTip">
        <Border Background="White" BorderBrush="#E5E5EA" BorderThickness="1" CornerRadius="8" Padding="10,7">
          <Border.Effect>
            <DropShadowEffect Color="#1F2330" BlurRadius="14" ShadowDepth="2" Direction="270" Opacity="0.16" RenderingBias="Performance"/>
          </Border.Effect>
          <ContentPresenter/>
        </Border>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
"""));

    private static readonly System.Lazy<Style> TextBoxLazy = new(() => WithFocusRing(Parse($$"""
<Style {{Ns}} TargetType="TextBox">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="14"/>
  <Setter Property="Foreground" Value="#1D1D1F"/>
  <Setter Property="CaretBrush" Value="#FF5B8A"/>
  <Setter Property="SelectionBrush" Value="#FFB1CB"/>
  <Setter Property="Background" Value="White"/>
  <Setter Property="BorderBrush" Value="#D2D2D7"/>
  <Setter Property="BorderThickness" Value="1"/>
  <Setter Property="Padding" Value="8,6"/>
  <Setter Property="VerticalContentAlignment" Value="Center"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="TextBox">
        <Border x:Name="bd" CornerRadius="8" Background="{TemplateBinding Background}"
                BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}">
          <ScrollViewer x:Name="PART_ContentHost" Margin="{TemplateBinding Padding}" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsKeyboardFocused" Value="True">
            <Setter TargetName="bd" Property="BorderBrush" Value="#FF5B8A"/>
            <Setter TargetName="bd" Property="Effect">
              <Setter.Value>
                <DropShadowEffect Color="#FF5B8A" BlurRadius="8" ShadowDepth="0" Opacity="0.24" RenderingBias="Performance"/>
              </Setter.Value>
            </Setter>
          </Trigger>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bd" Property="BorderBrush" Value="#FFB1CB"/>
          </Trigger>
          <Trigger Property="IsEnabled" Value="False">
            <Setter TargetName="bd" Property="Opacity" Value="0.55"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
""")));

    private static readonly System.Lazy<Style> SecondaryButtonLazy = new(() => WithFocusRing(Parse($$"""
<Style {{Ns}} TargetType="Button">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="14"/>
  <Setter Property="Foreground" Value="#2C2C2E"/>
  <Setter Property="Padding" Value="14,0"/>
  <Setter Property="Height" Value="32"/>
  <Setter Property="Cursor" Value="Hand"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="Button">
        <Border x:Name="bd" CornerRadius="8" Background="White" BorderBrush="#D2D2D7" BorderThickness="1">
          <Border.RenderTransform>
            <TranslateTransform/>
          </Border.RenderTransform>
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="{TemplateBinding Padding}"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#FFF5F8"/>
            <Setter TargetName="bd" Property="BorderBrush" Value="#FFB1CB"/>
            <Trigger.EnterActions>
              <BeginStoryboard>
                <Storyboard>
                  <DoubleAnimation Storyboard.TargetName="bd"
                                   Storyboard.TargetProperty="(UIElement.RenderTransform).(TranslateTransform.Y)"
                                   To="-1" Duration="0:0:0.12">
                    <DoubleAnimation.EasingFunction>
                      <QuadraticEase EasingMode="EaseOut"/>
                    </DoubleAnimation.EasingFunction>
                  </DoubleAnimation>
                </Storyboard>
              </BeginStoryboard>
            </Trigger.EnterActions>
            <Trigger.ExitActions>
              <BeginStoryboard>
                <Storyboard>
                  <DoubleAnimation Storyboard.TargetName="bd"
                                   Storyboard.TargetProperty="(UIElement.RenderTransform).(TranslateTransform.Y)"
                                   To="0" Duration="0:0:0.12"/>
                </Storyboard>
              </BeginStoryboard>
            </Trigger.ExitActions>
          </Trigger>
          <Trigger Property="IsPressed" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#FFECF2"/>
          </Trigger>
          <Trigger Property="IsEnabled" Value="False">
            <Setter TargetName="bd" Property="Opacity" Value="0.5"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
""")));

    private static readonly System.Lazy<Style> PrimaryButtonLazy = new(() => WithFocusRing(Parse($$"""
<Style {{Ns}} TargetType="Button">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="14"/>
  <Setter Property="FontWeight" Value="SemiBold"/>
  <Setter Property="Foreground" Value="White"/>
  <Setter Property="Padding" Value="16,0"/>
  <Setter Property="Height" Value="32"/>
  <Setter Property="Cursor" Value="Hand"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="Button">
        <Border x:Name="bd" CornerRadius="8" Background="#FF5B8A" BorderBrush="#FF5B8A" BorderThickness="1">
          <Border.RenderTransform>
            <TranslateTransform/>
          </Border.RenderTransform>
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="{TemplateBinding Padding}"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#E84A78"/>
            <Setter TargetName="bd" Property="BorderBrush" Value="#E84A78"/>
            <Trigger.EnterActions>
              <BeginStoryboard>
                <Storyboard>
                  <DoubleAnimation Storyboard.TargetName="bd"
                                   Storyboard.TargetProperty="(UIElement.RenderTransform).(TranslateTransform.Y)"
                                   To="-1" Duration="0:0:0.12">
                    <DoubleAnimation.EasingFunction>
                      <QuadraticEase EasingMode="EaseOut"/>
                    </DoubleAnimation.EasingFunction>
                  </DoubleAnimation>
                </Storyboard>
              </BeginStoryboard>
            </Trigger.EnterActions>
            <Trigger.ExitActions>
              <BeginStoryboard>
                <Storyboard>
                  <DoubleAnimation Storyboard.TargetName="bd"
                                   Storyboard.TargetProperty="(UIElement.RenderTransform).(TranslateTransform.Y)"
                                   To="0" Duration="0:0:0.12"/>
                </Storyboard>
              </BeginStoryboard>
            </Trigger.ExitActions>
          </Trigger>
          <Trigger Property="IsPressed" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#C43A64"/>
          </Trigger>
          <Trigger Property="IsEnabled" Value="False">
            <Setter TargetName="bd" Property="Opacity" Value="0.5"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
""")));

    private static readonly System.Lazy<Style> SwitchLazy = new(() => WithFocusRing(Parse($$"""
<Style {{Ns}} TargetType="CheckBox">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="14"/>
  <Setter Property="Foreground" Value="#2C2C2E"/>
  <Setter Property="Cursor" Value="Hand"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="CheckBox">
        <StackPanel Orientation="Horizontal" Background="Transparent">
          <Border x:Name="track" Width="54" Height="30" CornerRadius="15" Background="#F1EEF4"
                  BorderBrush="#D8D2DC" BorderThickness="1" VerticalAlignment="Center">
            <Border x:Name="thumb" Width="20" Height="20" CornerRadius="10" Background="White"
                    BorderBrush="#D8D2DC" BorderThickness="1"
                    HorizontalAlignment="Left" Margin="4,0,0,0">
              <Border.RenderTransform>
                <TranslateTransform/>
              </Border.RenderTransform>
              <Border.Effect>
                <DropShadowEffect BlurRadius="6" ShadowDepth="1" Direction="270" Opacity="0.18" RenderingBias="Performance"/>
              </Border.Effect>
            </Border>
          </Border>
          <ContentPresenter Margin="10,0,0,0" VerticalAlignment="Center" RecognizesAccessKey="True"/>
        </StackPanel>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="track" Property="BorderBrush" Value="#FFB1CB"/>
          </Trigger>
          <Trigger Property="IsChecked" Value="True">
            <Setter TargetName="track" Property="Background">
              <Setter.Value>
                <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
                  <GradientStop Color="#FFE5EF" Offset="0"/>
                  <GradientStop Color="#FFD6E4" Offset="1"/>
                </LinearGradientBrush>
              </Setter.Value>
            </Setter>
            <Setter TargetName="track" Property="BorderBrush" Value="#FFB1CB"/>
            <Setter TargetName="thumb" Property="BorderBrush" Value="#FFB1CB"/>
            <Setter TargetName="track" Property="Effect">
              <Setter.Value>
                <DropShadowEffect Color="#FFD6E4" BlurRadius="10" ShadowDepth="0" Opacity="0.85"
                                  RenderingBias="Performance"/>
              </Setter.Value>
            </Setter>
            <Trigger.EnterActions>
              <BeginStoryboard>
                <Storyboard>
                  <DoubleAnimation Storyboard.TargetName="thumb"
                                   Storyboard.TargetProperty="(UIElement.RenderTransform).(TranslateTransform.X)"
                                   To="24" Duration="0:0:0.18">
                    <DoubleAnimation.EasingFunction>
                      <CubicEase EasingMode="EaseOut"/>
                    </DoubleAnimation.EasingFunction>
                  </DoubleAnimation>
                </Storyboard>
              </BeginStoryboard>
            </Trigger.EnterActions>
            <Trigger.ExitActions>
              <BeginStoryboard>
                <Storyboard>
                  <DoubleAnimation Storyboard.TargetName="thumb"
                                   Storyboard.TargetProperty="(UIElement.RenderTransform).(TranslateTransform.X)"
                                   To="0" Duration="0:0:0.18">
                    <DoubleAnimation.EasingFunction>
                      <CubicEase EasingMode="EaseOut"/>
                    </DoubleAnimation.EasingFunction>
                  </DoubleAnimation>
                </Storyboard>
              </BeginStoryboard>
            </Trigger.ExitActions>
          </Trigger>
          <Trigger Property="IsEnabled" Value="False">
            <Setter TargetName="track" Property="Opacity" Value="0.5"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
""")));

    private static readonly System.Lazy<Style> SliderLazy = new(() => WithFocusRing(Parse($$"""
<Style {{Ns}} TargetType="Slider">
  <Setter Property="Height" Value="24"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="Slider">
        <Grid VerticalAlignment="Center">
          <Border Height="4" CornerRadius="2" Background="#EDEDF2"/>
          <Track x:Name="PART_Track">
            <Track.DecreaseRepeatButton>
              <RepeatButton Command="Slider.DecreaseLarge" Focusable="False">
                <RepeatButton.Template>
                  <ControlTemplate TargetType="RepeatButton">
                    <Border Background="#FF5B8A" Height="4" CornerRadius="2"/>
                  </ControlTemplate>
                </RepeatButton.Template>
              </RepeatButton>
            </Track.DecreaseRepeatButton>
            <Track.IncreaseRepeatButton>
              <RepeatButton Command="Slider.IncreaseLarge" Focusable="False">
                <RepeatButton.Template>
                  <ControlTemplate TargetType="RepeatButton">
                    <Border Background="Transparent" Height="4"/>
                  </ControlTemplate>
                </RepeatButton.Template>
              </RepeatButton>
            </Track.IncreaseRepeatButton>
            <Track.Thumb>
              <Thumb Width="16" Height="16">
                <Thumb.Template>
                  <ControlTemplate TargetType="Thumb">
                    <Ellipse x:Name="thumb" Fill="White" Stroke="#FF5B8A" StrokeThickness="2"/>
                    <ControlTemplate.Triggers>
                      <Trigger Property="IsMouseOver" Value="True">
                        <Setter TargetName="thumb" Property="Stroke" Value="#E84A78"/>
                      </Trigger>
                      <Trigger Property="IsDragging" Value="True">
                        <Setter TargetName="thumb" Property="Fill" Value="#FFECF2"/>
                      </Trigger>
                    </ControlTemplate.Triggers>
                  </ControlTemplate>
                </Thumb.Template>
              </Thumb>
            </Track.Thumb>
          </Track>
        </Grid>
        <ControlTemplate.Triggers>
          <Trigger Property="IsEnabled" Value="False">
            <Setter Property="Opacity" Value="0.5"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
""")));

    private static readonly System.Lazy<Style> NavItemLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="RadioButton">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="14"/>
  <Setter Property="FontWeight" Value="Medium"/>
  <Setter Property="Foreground" Value="#2C2C2E"/>
  <Setter Property="Cursor" Value="Hand"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="RadioButton">
        <Border x:Name="bg" CornerRadius="12" Background="Transparent" BorderBrush="Transparent"
                BorderThickness="1" Margin="0,1,0,1" Padding="10,8">
          <ContentPresenter VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bg" Property="Background" Value="#FFF1F6"/>
            <Setter TargetName="bg" Property="BorderBrush" Value="#FFB1CB"/>
            <Setter Property="Foreground" Value="#E84A78"/>
          </Trigger>
          <Trigger Property="IsChecked" Value="True">
            <Setter TargetName="bg" Property="Background" Value="#FFF1F6"/>
            <Setter TargetName="bg" Property="BorderBrush" Value="#FFB1CB"/>
            <Setter Property="Foreground" Value="#E84A78"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
"""));

    private static readonly System.Lazy<Style> FlatIconButtonLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="Button">
  <Setter Property="Width" Value="40"/>
  <Setter Property="Height" Value="40"/>
  <Setter Property="FontSize" Value="12"/>
  <Setter Property="Foreground" Value="#6F6876"/>
  <Setter Property="Focusable" Value="False"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="Button">
        <Border x:Name="bd" Background="Transparent">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#F0F0F4"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
"""));

    private static readonly System.Lazy<Style> DangerButtonLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="Button">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="14"/>
  <Setter Property="Foreground" Value="#D7263D"/>
  <Setter Property="Padding" Value="14,0"/>
  <Setter Property="Height" Value="32"/>
  <Setter Property="Cursor" Value="Hand"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="Button">
        <Border x:Name="bd" CornerRadius="8" Background="White" BorderBrush="#E8B4BC" BorderThickness="1">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="{TemplateBinding Padding}"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#FDF1F3"/>
            <Setter TargetName="bd" Property="BorderBrush" Value="#D7263D"/>
          </Trigger>
          <Trigger Property="IsEnabled" Value="False">
            <Setter TargetName="bd" Property="Opacity" Value="0.5"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
"""));

    private static readonly System.Lazy<Style> SuccessButtonLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="Button">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="14"/>
  <Setter Property="Foreground" Value="#2E7D32"/>
  <Setter Property="Padding" Value="14,0"/>
  <Setter Property="Height" Value="32"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="Button">
        <Border x:Name="bd" CornerRadius="8" Background="#E8F5E9" BorderBrush="#B7DFC1" BorderThickness="1">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="{TemplateBinding Padding}"/>
        </Border>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
"""));

    /// <summary>
    /// 设置页大输入框（对齐 Electron .field input pearl-white）：
    /// 高 48、圆角 14、字号 16、内边距 11/12、白底 + #D2D2D7 描边，聚焦粉色描边 + 柔光。
    /// </summary>
    private static readonly System.Lazy<Style> InputLargeLazy = new(() => WithFocusRing(Parse($$"""
<Style {{Ns}} TargetType="TextBox">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="16"/>
  <Setter Property="Height" Value="48"/>
  <Setter Property="Foreground" Value="#1D1D1F"/>
  <Setter Property="CaretBrush" Value="#FF5B8A"/>
  <Setter Property="SelectionBrush" Value="#FFB1CB"/>
  <Setter Property="Background" Value="White"/>
  <Setter Property="BorderBrush" Value="#D2D2D7"/>
  <Setter Property="BorderThickness" Value="1"/>
  <Setter Property="Padding" Value="12,0"/>
  <Setter Property="VerticalContentAlignment" Value="Center"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="TextBox">
        <Border x:Name="bd" CornerRadius="14" Background="{TemplateBinding Background}"
                BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}">
          <ScrollViewer x:Name="PART_ContentHost" Margin="{TemplateBinding Padding}" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsKeyboardFocused" Value="True">
            <Setter TargetName="bd" Property="BorderBrush" Value="#FF5B8A"/>
            <Setter TargetName="bd" Property="Effect">
              <Setter.Value>
                <DropShadowEffect Color="#FF5B8A" BlurRadius="10" ShadowDepth="0" Opacity="0.22" RenderingBias="Performance"/>
              </Setter.Value>
            </Setter>
          </Trigger>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bd" Property="BorderBrush" Value="#FFB1CB"/>
          </Trigger>
          <Trigger Property="IsEnabled" Value="False">
            <Setter TargetName="bd" Property="Opacity" Value="0.55"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
""")));

    /// <summary>同 InputLarge 的密码框（API Key 遮蔽；模板要素与 TextBox 一致）。</summary>
    private static readonly System.Lazy<Style> PasswordLargeLazy = new(() => WithFocusRing(Parse($$"""
<Style {{Ns}} TargetType="PasswordBox">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="16"/>
  <Setter Property="Height" Value="48"/>
  <Setter Property="Foreground" Value="#1D1D1F"/>
  <Setter Property="CaretBrush" Value="#FF5B8A"/>
  <Setter Property="SelectionBrush" Value="#FFB1CB"/>
  <Setter Property="Background" Value="White"/>
  <Setter Property="BorderBrush" Value="#D2D2D7"/>
  <Setter Property="BorderThickness" Value="1"/>
  <Setter Property="Padding" Value="12,0"/>
  <Setter Property="VerticalContentAlignment" Value="Center"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="PasswordBox">
        <Border x:Name="bd" CornerRadius="14" Background="{TemplateBinding Background}"
                BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}">
          <ScrollViewer x:Name="PART_ContentHost" Margin="{TemplateBinding Padding}" VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsKeyboardFocused" Value="True">
            <Setter TargetName="bd" Property="BorderBrush" Value="#FF5B8A"/>
            <Setter TargetName="bd" Property="Effect">
              <Setter.Value>
                <DropShadowEffect Color="#FF5B8A" BlurRadius="10" ShadowDepth="0" Opacity="0.22" RenderingBias="Performance"/>
              </Setter.Value>
            </Setter>
          </Trigger>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bd" Property="BorderBrush" Value="#FFB1CB"/>
          </Trigger>
          <Trigger Property="IsEnabled" Value="False">
            <Setter TargetName="bd" Property="Opacity" Value="0.55"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
""")));

    /// <summary>
    /// 胶囊主按钮（对齐 Electron pearl-white .save-btn）：全圆角、粉底白字、
    /// 内边距 10/16、行高 42；hover 深一档 + 粉色柔光。
    /// </summary>
    private static readonly System.Lazy<Style> PillPrimaryLazy = new(() => WithFocusRing(Parse($$"""
<Style {{Ns}} TargetType="Button">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="14"/>
  <Setter Property="FontWeight" Value="SemiBold"/>
  <Setter Property="Foreground" Value="White"/>
  <Setter Property="Padding" Value="16,0"/>
  <Setter Property="Height" Value="42"/>
  <Setter Property="Cursor" Value="Hand"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="Button">
        <Border x:Name="bd" CornerRadius="21" Background="#FF5B8A" BorderBrush="#FF5B8A" BorderThickness="1">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="{TemplateBinding Padding}"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#E84A78"/>
            <Setter TargetName="bd" Property="BorderBrush" Value="#E84A78"/>
            <Setter TargetName="bd" Property="Effect">
              <Setter.Value>
                <DropShadowEffect Color="#FF5B8A" BlurRadius="16" ShadowDepth="2" Direction="270"
                                  Opacity="0.32" RenderingBias="Performance"/>
              </Setter.Value>
            </Setter>
          </Trigger>
          <Trigger Property="IsPressed" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#C43A64"/>
          </Trigger>
          <Trigger Property="IsEnabled" Value="False">
            <Setter TargetName="bd" Property="Opacity" Value="0.55"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
""")));

    private static readonly System.Lazy<Style> TabItemLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="TabItem">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="14"/>
  <Setter Property="Foreground" Value="#6F6876"/>
  <Setter Property="Cursor" Value="Hand"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="TabItem">
        <Border x:Name="bd" CornerRadius="8" Margin="0,0,8,0" Padding="16,8" Background="Transparent">
          <ContentPresenter ContentSource="Header" VerticalAlignment="Center" HorizontalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#FAFAFC"/>
          </Trigger>
          <Trigger Property="IsSelected" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#FFECF2"/>
            <Setter Property="Foreground" Value="#E84A78"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
"""));

    private static readonly System.Lazy<Style> TabControlLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="TabControl">
  <Setter Property="Background" Value="Transparent"/>
  <Setter Property="BorderBrush" Value="Transparent"/>
  <Setter Property="BorderThickness" Value="0"/>
  <Setter Property="Padding" Value="0"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="TabControl">
        <DockPanel>
          <TabPanel IsItemsHost="True" DockPanel.Dock="Top" Margin="8,8,8,10" Background="Transparent"/>
          <Border Background="Transparent">
            <ContentPresenter ContentSource="SelectedContent"/>
          </Border>
        </DockPanel>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
"""));

    private static readonly System.Lazy<Style> ScrollBarLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="ScrollBar">
  <Setter Property="Background" Value="Transparent"/>
  <Setter Property="Width" Value="10"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="ScrollBar">
        <Grid Background="Transparent">
          <Track x:Name="PART_Track" IsDirectionReversed="True">
            <Track.DecreaseRepeatButton>
              <RepeatButton Command="ScrollBar.PageUpCommand" Opacity="0" Focusable="False" IsTabStop="False"/>
            </Track.DecreaseRepeatButton>
            <Track.Thumb>
              <Thumb MinHeight="24">
                <Thumb.Template>
                  <ControlTemplate TargetType="Thumb">
                    <Border x:Name="tb" Background="#D2D2D7" CornerRadius="4" Margin="2"/>
                    <ControlTemplate.Triggers>
                      <Trigger Property="IsMouseOver" Value="True">
                        <Setter TargetName="tb" Property="Background" Value="#FFB1CB"/>
                      </Trigger>
                      <Trigger Property="IsDragging" Value="True">
                        <Setter TargetName="tb" Property="Background" Value="#FF5B8A"/>
                      </Trigger>
                    </ControlTemplate.Triggers>
                  </ControlTemplate>
                </Thumb.Template>
              </Thumb>
            </Track.Thumb>
            <Track.IncreaseRepeatButton>
              <RepeatButton Command="ScrollBar.PageDownCommand" Opacity="0" Focusable="False" IsTabStop="False"/>
            </Track.IncreaseRepeatButton>
          </Track>
        </Grid>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
  <Style.Triggers>
    <Trigger Property="Orientation" Value="Horizontal">
      <Setter Property="Width" Value="Auto"/>
      <Setter Property="Height" Value="10"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ScrollBar">
            <Grid Background="Transparent">
              <Track x:Name="PART_Track">
                <Track.DecreaseRepeatButton>
                  <RepeatButton Command="ScrollBar.PageLeftCommand" Opacity="0" Focusable="False" IsTabStop="False"/>
                </Track.DecreaseRepeatButton>
                <Track.Thumb>
                  <Thumb MinWidth="24">
                    <Thumb.Template>
                      <ControlTemplate TargetType="Thumb">
                        <Border x:Name="tb" Background="#D2D2D7" CornerRadius="4" Margin="2"/>
                        <ControlTemplate.Triggers>
                          <Trigger Property="IsMouseOver" Value="True">
                            <Setter TargetName="tb" Property="Background" Value="#FFB1CB"/>
                          </Trigger>
                          <Trigger Property="IsDragging" Value="True">
                            <Setter TargetName="tb" Property="Background" Value="#FF5B8A"/>
                          </Trigger>
                        </ControlTemplate.Triggers>
                      </ControlTemplate>
                    </Thumb.Template>
                  </Thumb>
                </Track.Thumb>
                <Track.IncreaseRepeatButton>
                  <RepeatButton Command="ScrollBar.PageRightCommand" Opacity="0" Focusable="False" IsTabStop="False"/>
                </Track.IncreaseRepeatButton>
              </Track>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Trigger>
  </Style.Triggers>
</Style>
"""));

    /// <summary>圆角窗口壳：无边框 + 全透明，内容由调用方的圆角 Border 提供。</summary>
    public static void MakeRounded(Window window)
    {
        window.WindowStyle = WindowStyle.None;
        window.AllowsTransparency = true;
        window.Background = Brushes.Transparent;
        window.ResizeMode = window.ResizeMode == ResizeMode.NoResize
            ? ResizeMode.NoResize
            : ResizeMode.CanResize;
    }

    /// <summary>把容器按圆角矩形裁剪（WPF Border 不会自动裁剪子元素到圆角）。</summary>
    public static void ClipRounded(FrameworkElement element, double radius)
    {
        void Apply()
        {
            if (element.ActualWidth <= 0 || element.ActualHeight <= 0) return;
            element.Clip = new RectangleGeometry(
                new Rect(0, 0, element.ActualWidth, element.ActualHeight), radius, radius);
        }
        element.SizeChanged += (_, _) => Apply();
        Apply();
    }

    /// <summary>扁平图标按钮（标题栏用）。</summary>
    public static Button MakeIconButton(string glyph, Action onClick)
    {
        var btn = new Button { Content = glyph, Style = FlatIconButtonStyle };
        btn.Click += (_, _) => onClick();
        return btn;
    }

    /// <summary>
    /// 无边框窗的圆角标题栏：标题 + 可选最小化 + 关闭，可拖动。
    /// 需与该窗的圆角壳（ClipRounded）配合，顶部两角才真正圆。
    /// buttonSize 28（对话框/小窗）或 30（大窗，对齐 Electron settings）。
    /// </summary>
    public static Border BuildTitleBar(
        Window window,
        string title,
        bool showMinimize = false,
        double buttonSize = 28,
        double titleSize = 14)
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        if (showMinimize) grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var titleText = new TextBlock
        {
            Text = title,
            FontSize = titleSize,
            FontWeight = FontWeights.SemiBold,
            Foreground = TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(16, 0, 0, 0),
        };
        Grid.SetColumn(titleText, 0);
        grid.Children.Add(titleText);

        var column = 1;
        if (showMinimize)
        {
            var minBtn = MakeMinimizeButton(() => window, buttonSize);
            Grid.SetColumn(minBtn, column++);
            grid.Children.Add(minBtn);
        }
        var closeBtn = MakeCloseButton(() => window, buttonSize);
        closeBtn.Margin = new Thickness(2, 0, buttonSize >= 30 ? 12 : 10, 0);
        Grid.SetColumn(closeBtn, column);
        grid.Children.Add(closeBtn);

        var bar = new Border
        {
            Background = Brushes.White,
            BorderBrush = BorderSoftBrush,
            BorderThickness = new Thickness(0, 0, 0, 1),
            CornerRadius = new CornerRadius(12, 12, 0, 0),
            Child = grid,
        };
        bar.MouseLeftButtonDown += (_, _) => { try { window.DragMove(); } catch { /* not pressed */ } };
        return bar;
    }

    private static readonly System.Lazy<Style> ComboBoxLazy = new(() => Parse("""
<Style xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="ComboBox">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="14"/>
  <Setter Property="Foreground" Value="#1D1D1F"/>
  <Setter Property="MinHeight" Value="32"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="ComboBox">
        <Grid>
          <ToggleButton x:Name="Toggle" Focusable="False" ClickMode="Press"
                        IsChecked="{Binding IsDropDownOpen, Mode=TwoWay, RelativeSource={RelativeSource TemplatedParent}}">
            <ToggleButton.Template>
              <ControlTemplate TargetType="ToggleButton">
                <Border x:Name="bd" CornerRadius="8" Background="White" BorderBrush="#D2D2D7" BorderThickness="1">
                  <Grid>
                    <Grid.ColumnDefinitions>
                      <ColumnDefinition Width="*"/>
                      <ColumnDefinition Width="Auto"/>
                    </Grid.ColumnDefinitions>
                    <ContentPresenter Grid.Column="0" Margin="11,0,6,0" VerticalAlignment="Center"
                                      Content="{Binding SelectionBoxItem, RelativeSource={RelativeSource AncestorType=ComboBox}}"
                                      ContentTemplate="{Binding SelectionBoxItemTemplate, RelativeSource={RelativeSource AncestorType=ComboBox}}"/>
                    <TextBlock Grid.Column="1" Text="⌄" FontSize="13" Margin="0,0,11,0"
                               VerticalAlignment="Center" Foreground="#6F6876"/>
                  </Grid>
                </Border>
                <ControlTemplate.Triggers>
                  <Trigger Property="IsMouseOver" Value="True">
                    <Setter TargetName="bd" Property="BorderBrush" Value="#FFB1CB"/>
                  </Trigger>
                  <Trigger Property="IsChecked" Value="True">
                    <Setter TargetName="bd" Property="BorderBrush" Value="#FF5B8A"/>
                  </Trigger>
                </ControlTemplate.Triggers>
              </ControlTemplate>
            </ToggleButton.Template>
          </ToggleButton>
          <Popup x:Name="PART_Popup" AllowsTransparency="True" Placement="Bottom" Focusable="False"
                 IsOpen="{TemplateBinding IsDropDownOpen}" PopupAnimation="Slide">
            <Border Background="White" BorderBrush="#D2D2D7" BorderThickness="1" CornerRadius="8"
                    Margin="0,4,0,0" MinWidth="{TemplateBinding ActualWidth}"
                    MaxHeight="{TemplateBinding MaxDropDownHeight}">
              <ScrollViewer VerticalScrollBarVisibility="Auto">
                <StackPanel IsItemsHost="True" KeyboardNavigation.DirectionalNavigation="Contained"/>
              </ScrollViewer>
            </Border>
          </Popup>
        </Grid>
        <ControlTemplate.Triggers>
          <Trigger Property="IsEnabled" Value="False">
            <Setter Property="Opacity" Value="0.55"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
"""));

    private static readonly System.Lazy<Style> ComboBoxItemLazy = new(() => Parse("""
<Style xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="ComboBoxItem">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="14"/>
  <Setter Property="Foreground" Value="#2C2C2E"/>
  <Setter Property="Padding" Value="10,7"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="ComboBoxItem">
        <Border x:Name="bd" CornerRadius="6" Background="Transparent" Margin="4,2" Padding="{TemplateBinding Padding}">
          <ContentPresenter VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsHighlighted" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#FFECF2"/>
          </Trigger>
          <Trigger Property="IsSelected" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#F0EFF5"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
"""));

    /// <summary>主题化 Tooltip（白卡浮层 + 阴影），文本自动换行。</summary>
    public static ToolTip MakeTooltip(string text) => new()
    {
        Content = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, MaxWidth = 360 },
        Style = ToolTipStyle,
    };

    /// <summary>从 assets 目录加载图片（缺失返回 null，UI 退化为无图）。</summary>
    public static ImageSource? TryLoadAssetImage(string relativePath)
    {
        try
        {
            var path = System.IO.Path.Combine(System.AppContext.BaseDirectory, "assets", relativePath);
            if (!System.IO.File.Exists(path)) return null;
            var image = new System.Windows.Media.Imaging.BitmapImage();
            image.BeginInit();
            image.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
            image.UriSource = new System.Uri(path);
            image.EndInit();
            image.Freeze();
            return image;
        }
        catch
        {
            return null;
        }
    }

    public static Style TextBoxStyle => TextBoxLazy.Value;
    public static Style InputLargeStyle => InputLargeLazy.Value;
    public static Style PasswordLargeStyle => PasswordLargeLazy.Value;
    public static Style PillPrimaryStyle => PillPrimaryLazy.Value;
    public static Style SecondaryButtonStyle => SecondaryButtonLazy.Value;
    public static Style PrimaryButtonStyle => PrimaryButtonLazy.Value;
    public static Style DangerButtonStyle => DangerButtonLazy.Value;
    public static Style SuccessButtonStyle => SuccessButtonLazy.Value;
    public static Style SwitchStyle => SwitchLazy.Value;
    public static Style SliderStyle => SliderLazy.Value;
    public static Style NavItemStyle => NavItemLazy.Value;
    public static Style FlatIconButtonStyle => FlatIconButtonLazy.Value;
    public static Style ComboBoxStyle => ComboBoxLazy.Value;
    public static Style ComboBoxItemStyle => ComboBoxItemLazy.Value;
    public static Style TabItemStyle => TabItemLazy.Value;
    public static Style TabControlStyle => TabControlLazy.Value;
    public static Style ScrollBarStyle => ScrollBarLazy.Value;
    public static Style ToolTipStyle => ToolTipLazy.Value;

    /// <summary>把主题套到窗口：字体 + 隐式控件样式（只影响未显式设置 Style 的控件）。</summary>
    public static void Apply(Window window)
    {
        window.FontFamily = Font;
        window.Foreground = TextDefaultBrush;
        window.Resources[typeof(TextBox)] = TextBoxStyle;
        window.Resources[typeof(Button)] = SecondaryButtonStyle;
        window.Resources[typeof(CheckBox)] = SwitchStyle;
        window.Resources[typeof(Slider)] = SliderStyle;
        window.Resources[typeof(TabItem)] = TabItemStyle;
        window.Resources[typeof(TabControl)] = TabControlStyle;
        window.Resources[typeof(ScrollBar)] = ScrollBarStyle;
        window.Resources[typeof(ToolTip)] = ToolTipStyle;
        // ComboBox 模板仅支持非可编辑模式（可编辑下拉需 PART_EditableTextBox 特殊处理，
        // 代码库中的可编辑模型下拉已改为「文本框 + 建议下拉」组合）
        window.Resources[typeof(ComboBox)] = ComboBoxStyle;
        window.Resources[typeof(ComboBoxItem)] = ComboBoxItemStyle;
    }
}
