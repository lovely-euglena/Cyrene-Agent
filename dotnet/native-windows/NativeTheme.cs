using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Markup;
using System.Windows.Media;
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

    private const string Ns =
        "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" " +
        "xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"";

    private static Style Parse(string xaml) => (Style)XamlReader.Parse(xaml);

    private static readonly System.Lazy<Style> TextBoxLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="TextBox">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="12.5"/>
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
"""));

    private static readonly System.Lazy<Style> SecondaryButtonLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="Button">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="12.5"/>
  <Setter Property="Foreground" Value="#2C2C2E"/>
  <Setter Property="Padding" Value="14,0"/>
  <Setter Property="Height" Value="32"/>
  <Setter Property="Cursor" Value="Hand"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="Button">
        <Border x:Name="bd" CornerRadius="8" Background="White" BorderBrush="#D2D2D7" BorderThickness="1">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="{TemplateBinding Padding}"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#FFF5F8"/>
            <Setter TargetName="bd" Property="BorderBrush" Value="#FFB1CB"/>
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
"""));

    private static readonly System.Lazy<Style> PrimaryButtonLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="Button">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="12.5"/>
  <Setter Property="FontWeight" Value="SemiBold"/>
  <Setter Property="Foreground" Value="White"/>
  <Setter Property="Padding" Value="16,0"/>
  <Setter Property="Height" Value="32"/>
  <Setter Property="Cursor" Value="Hand"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="Button">
        <Border x:Name="bd" CornerRadius="8" Background="#FF5B8A" BorderBrush="#FF5B8A" BorderThickness="1">
          <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="{TemplateBinding Padding}"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bd" Property="Background" Value="#E84A78"/>
            <Setter TargetName="bd" Property="BorderBrush" Value="#E84A78"/>
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
"""));

    private static readonly System.Lazy<Style> SwitchLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="CheckBox">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="12.5"/>
  <Setter Property="Foreground" Value="#2C2C2E"/>
  <Setter Property="Cursor" Value="Hand"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="CheckBox">
        <StackPanel Orientation="Horizontal" Background="Transparent">
          <Border x:Name="track" Width="40" Height="22" CornerRadius="11" Background="#E5E5EA" VerticalAlignment="Center">
            <Ellipse x:Name="thumb" Width="16" Height="16" Fill="White" HorizontalAlignment="Left" Margin="3,0,0,0"/>
          </Border>
          <ContentPresenter Margin="10,0,0,0" VerticalAlignment="Center" RecognizesAccessKey="True"/>
        </StackPanel>
        <ControlTemplate.Triggers>
          <Trigger Property="IsChecked" Value="True">
            <Setter TargetName="track" Property="Background" Value="#FF5B8A"/>
            <Setter TargetName="thumb" Property="HorizontalAlignment" Value="Right"/>
            <Setter TargetName="thumb" Property="Margin" Value="0,0,3,0"/>
          </Trigger>
          <Trigger Property="IsEnabled" Value="False">
            <Setter TargetName="track" Property="Opacity" Value="0.5"/>
          </Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
"""));

    private static readonly System.Lazy<Style> SliderLazy = new(() => Parse($$"""
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
                    <Ellipse Fill="White" Stroke="#FF5B8A" StrokeThickness="2"/>
                  </ControlTemplate>
                </Thumb.Template>
              </Thumb>
            </Track.Thumb>
          </Track>
        </Grid>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>
"""));

    private static readonly System.Lazy<Style> NavItemLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="RadioButton">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="13"/>
  <Setter Property="Foreground" Value="#2C2C2E"/>
  <Setter Property="Cursor" Value="Hand"/>
  <Setter Property="Template">
    <Setter.Value>
      <ControlTemplate TargetType="RadioButton">
        <Border x:Name="bg" CornerRadius="8" Background="Transparent" Margin="8,2,8,2" Padding="12,9">
          <ContentPresenter VerticalAlignment="Center"/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property="IsMouseOver" Value="True">
            <Setter TargetName="bg" Property="Background" Value="#FFFFFF"/>
          </Trigger>
          <Trigger Property="IsChecked" Value="True">
            <Setter TargetName="bg" Property="Background" Value="#FFECF2"/>
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
  <Setter Property="FontSize" Value="12.5"/>
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
  <Setter Property="FontSize" Value="12.5"/>
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

    private static readonly System.Lazy<Style> TabItemLazy = new(() => Parse($$"""
<Style {{Ns}} TargetType="TabItem">
  <Setter Property="FontFamily" Value="Microsoft YaHei UI"/>
  <Setter Property="FontSize" Value="13"/>
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
    /// </summary>
    public static Border BuildTitleBar(Window window, string title, bool showMinimize = false)
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        if (showMinimize) grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var titleText = new TextBlock
        {
            Text = title,
            FontSize = 13,
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
            var minBtn = MakeIconButton("—", () => window.WindowState = WindowState.Minimized);
            Grid.SetColumn(minBtn, column++);
            grid.Children.Add(minBtn);
        }
        var closeBtn = MakeIconButton("✕", () => window.Close());
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
  <Setter Property="FontSize" Value="12.5"/>
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
  <Setter Property="FontSize" Value="12.5"/>
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

    public static Style TextBoxStyle => TextBoxLazy.Value;
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
        // ComboBox 模板仅支持非可编辑模式（可编辑下拉需 PART_EditableTextBox 特殊处理，
        // 代码库中的可编辑模型下拉已改为「文本框 + 建议下拉」组合）
        window.Resources[typeof(ComboBox)] = ComboBoxStyle;
        window.Resources[typeof(ComboBoxItem)] = ComboBoxItemStyle;
    }
}
