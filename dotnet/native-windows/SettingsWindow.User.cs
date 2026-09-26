using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace CyreneNative;

/// <summary>
/// 设置窗「用户信息」section（WPF 重写，对齐 Electron settings 页 pearl-white）：
///   - 面板卡 + 标题砖（聊天用户图标）+「我的信息 / 你的个人标识与云端账号（即将支持）」
///   - memory-card：头像行（64 圆形头像 + 上传头像幽灵胶囊 + 尺寸说明）
///   - 用户字段（100px 标签列 + 控件）：昵称 / 性别三档（保密·男生·女生，带图标）/
///     称呼偏好 / 生日（文本框 + 日历弹层）/ 默认城市 / 时区（白名单下拉）
///   - 底部说明（默认城市用于天气、时区仅用于时间计算）
///
/// 提交语义对齐 user/panel.ts：昵称输入即存（200ms 防抖），其余失焦/回车或选择即存；
/// 性别点击即写；时区只接受快照白名单 value。
/// </summary>
public sealed partial class SettingsWindow
{
    private const string UserPanelSubtitle = "你的个人标识与云端账号（即将支持）";
    private const string UserAvatarHint = "支持 JPG、PNG，建议 1:1 比例";
    private const string UserFieldHint = "这些信息会告诉昔涟，让她知道怎么称呼你、你在哪。默认城市用于天气等需要定位的工具；时区仅用于时间计算，不代表所在城市。";

    private FrameworkElement BuildUserSection()
    {
        var user = GetNode("user");

        var content = new StackPanel();
        var panel = new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(24),
            Padding = new Thickness(20),
            Child = content,
            Effect = NativeTheme.CardShadow(),
        };

        content.Children.Add(MakePanelHeading(
            NativeTheme.VectorGlyph(Glyphs.ChatUser, 24, NativeTheme.TextDefaultBrush),
            "我的信息",
            UserPanelSubtitle));

        // ── memory-card：头像行 + 字段 ──
        var memory = new StackPanel();
        var memoryCard = new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(16),
            Padding = new Thickness(18),
            Child = memory,
            Effect = NativeTheme.CardShadow(),
        };

        var avatarRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 6) };
        avatarRow.Children.Add(MakeUserAvatar(GetString(user, "avatarDataUrl")));
        var avatarActions = new StackPanel { Margin = new Thickness(16, 0, 0, 0) };
        avatarActions.Children.Add(MakeUploadAvatarButton());
        avatarActions.Children.Add(MakeText(UserAvatarHint, 11, NativeTheme.TextMutedBrush,
            lineHeight: 16.5, margin: new Thickness(0, 4, 0, 0)));
        avatarRow.Children.Add(avatarActions);
        memory.Children.Add(avatarRow);

        var fields = new StackPanel { Margin = new Thickness(0, 30, 0, 0) };
        fields.Children.Add(MakeUserField("昵称",
            MakeUserTextInput("nickname", GetString(user, "nickname"), "你想让昔涟怎么称呼你", live: true)));
        fields.Children.Add(MakeUserField("性别", MakeGenderSelect(GetString(user, "gender", "secret"))));
        fields.Children.Add(MakeUserField("称呼偏好",
            MakeUserTextInput("callPreference", GetString(user, "callPreference"), "例如：伙伴（留空用昵称）")));
        fields.Children.Add(MakeUserField("生日", MakeBirthdayInput(GetString(user, "birthday"))));
        fields.Children.Add(MakeUserField("默认城市",
            MakeUserTextInput("defaultCity", GetString(user, "defaultCity"), "例如：上海、北京、广州（用于天气等）")));
        fields.Children.Add(MakeUserField("时区", MakeTimezoneSelect(user)));
        fields.Children.Add(MakeText(UserFieldHint, 11, NativeTheme.TextMutedBrush, lineHeight: 16.5));
        memory.Children.Add(fields);

        content.Children.Add(memoryCard);
        return panel;
    }

    // ── 头像 ──

    /// <summary>64 圆形头像：有 data URL 用 ImageBrush（圆角裁切），否则虚线圆 + 半透明占位图标。</summary>
    private static FrameworkElement MakeUserAvatar(string avatarDataUrl)
    {
        var host = new Grid { Width = 64, Height = 64 };
        var decoded = TryDecodeDataUrl(avatarDataUrl);
        if (decoded is not null)
        {
            host.Children.Add(new Border
            {
                CornerRadius = new CornerRadius(32),
                Background = new ImageBrush(decoded)
                {
                    Stretch = Stretch.UniformToFill,
                    AlignmentX = AlignmentX.Center,
                    AlignmentY = AlignmentY.Center,
                },
            });
            return host;
        }
        host.Children.Add(new Ellipse
        {
            Stroke = NativeTheme.BorderStrongBrush,
            StrokeThickness = 2,
            StrokeDashArray = new DoubleCollection { 3, 2 },
            Fill = Brushes.White,
        });
        var placeholder = NativeTheme.VectorGlyph(Glyphs.ChatUser, 22, NativeTheme.TextMutedBrush);
        placeholder.Opacity = 0.5;
        host.Children.Add(placeholder);
        return host;
    }

    /// <summary>上传头像（.ghost-btn 幽灵胶囊：图标 + 文本）。</summary>
    private static Button MakeUploadAvatarButton()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(NativeTheme.VectorGlyph(Glyphs.AvatarUpload, 16, NativeTheme.TextDefaultBrush));
        var label = MakeText("上传头像", 14, NativeTheme.TextDefaultBrush, weight: FontWeights.Medium, lineHeight: 21,
            margin: new Thickness(6, 0, 0, 0));
        label.VerticalAlignment = VerticalAlignment.Center;
        row.Children.Add(label);
        var button = new Button
        {
            Content = row,
            Style = NativeTheme.GhostPillStyle,
            HorizontalAlignment = HorizontalAlignment.Left,
        };
        button.Click += (_, _) => RequestRouter.SendPickAvatar();
        return button;
    }

    // ── 字段行 ──

    /// <summary>用户字段行（100px 标签 + 12px 间距 + 控件；.tts-field）。</summary>
    private static FrameworkElement MakeUserField(string label, FrameworkElement control)
    {
        var grid = new Grid { Margin = new Thickness(0, 0, 0, 20) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(100) });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        var labelText = MakeText(label, 13, NativeTheme.TextDefaultBrush, weight: FontWeights.SemiBold, lineHeight: 19.5);
        labelText.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(labelText, 0);
        grid.Children.Add(labelText);
        control.Margin = new Thickness(12, 0, 0, 0);
        Grid.SetColumn(control, 1);
        grid.Children.Add(control);
        return grid;
    }

    /// <summary>小输入框 + 占位提示；失焦/回车提交（live=true 时输入停止 200ms 也提交）。</summary>
    private FrameworkElement MakeUserTextInput(string field, string initial, string placeholder, bool live = false)
    {
        var box = new TextBox { Text = initial, Style = NativeTheme.InputSmallStyle };
        var lastCommitted = initial;
        void Commit()
        {
            var text = box.Text.Trim();
            if (text == lastCommitted) return;
            lastCommitted = text;
            SetUserProfile(field, text);
        }
        box.LostFocus += (_, _) => Commit();
        box.KeyDown += (_, e) =>
        {
            if (e.Key == Key.Enter) Commit();
        };
        if (live)
        {
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(200) };
            timer.Tick += (_, _) =>
            {
                timer.Stop();
                Commit();
            };
            box.TextChanged += (_, _) =>
            {
                timer.Stop();
                timer.Start();
            };
            _debounceTimers.Add(timer);
        }

        var host = new Grid();
        host.Children.Add(box);
        var hint = MakeText(placeholder, 13, NativeTheme.TextMutedBrush, margin: new Thickness(13, 0, 0, 0));
        hint.TextWrapping = TextWrapping.NoWrap;
        hint.TextTrimming = TextTrimming.CharacterEllipsis;
        hint.VerticalAlignment = VerticalAlignment.Center;
        hint.IsHitTestVisible = false;
        hint.Visibility = box.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        box.TextChanged += (_, _) => hint.Visibility = box.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        host.Children.Add(hint);
        return host;
    }

    /// <summary>性别三档（.gender-select：等宽按钮 + 图标，点击即写）。</summary>
    private FrameworkElement MakeGenderSelect(string current)
    {
        var group = new StackPanel { Orientation = Orientation.Horizontal };
        var buttons = new List<(Border Host, TextBlock Label, string Value)>();
        void SetActive(string value)
        {
            foreach (var (host, label, buttonValue) in buttons)
            {
                var active = buttonValue == value;
                host.Background = active ? NativeTheme.Pink50Brush : Brushes.Transparent;
                host.BorderBrush = NativeTheme.Pink200Brush;
                label.Foreground = active ? NativeTheme.Pink600Brush : NativeTheme.TextMutedBrush;
            }
        }
        void AddGender(string value, string text, string glyph, Brush glyphBrush)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            row.Children.Add(NativeTheme.VectorGlyph(glyph, 16, glyphBrush));
            var label = MakeText(text, 12, current == value ? NativeTheme.Pink600Brush : NativeTheme.TextMutedBrush,
                weight: FontWeights.SemiBold, lineHeight: 17, margin: new Thickness(4, 0, 0, 0));
            label.VerticalAlignment = VerticalAlignment.Center;
            row.Children.Add(label);
            var host = new Border
            {
                CornerRadius = new CornerRadius(12),
                Padding = new Thickness(8, 7, 8, 7),
                BorderBrush = NativeTheme.Pink200Brush,
                BorderThickness = new Thickness(1),
                Background = current == value ? NativeTheme.Pink50Brush : Brushes.Transparent,
                Cursor = Cursors.Hand,
                Child = row,
            };
            host.MouseLeftButtonUp += (_, _) =>
            {
                if (value == current) return;
                current = value;
                SetActive(value);
                SetUserProfile("gender", value);
            };
            host.MouseEnter += (_, _) => label.Foreground = NativeTheme.Pink600Brush;
            host.MouseLeave += (_, _) =>
            {
                if (value != current) label.Foreground = NativeTheme.TextMutedBrush;
            };
            host.Margin = new Thickness(buttons.Count == 0 ? 0 : 6, 0, 0, 0);
            buttons.Add((host, label, value));
            group.Children.Add(host);
        }
        AddGender("secret", "保密", Glyphs.Shield, NativeTheme.TextMutedBrush);
        AddGender("male", "男生", Glyphs.Male, new SolidColorBrush(Color.FromRgb(0x4A, 0x9E, 0xFF)));
        AddGender("female", "女生", Glyphs.Female, new SolidColorBrush(Color.FromRgb(0xEC, 0x48, 0x99)));
        return group;
    }

    /// <summary>生日：yyyy-MM-dd 文本框 + 日历弹层（对齐 Electron date input 的取景器）。</summary>
    private FrameworkElement MakeBirthdayInput(string initial)
    {
        var box = new TextBox
        {
            Text = initial,
            Style = NativeTheme.InputSmallStyle,
            BorderThickness = new Thickness(0),
            Background = Brushes.Transparent,
            Padding = new Thickness(0),
        };
        var lastCommitted = initial;
        void Commit()
        {
            var text = box.Text.Trim();
            if (text == lastCommitted) return;
            if (text.Length > 0 && TryParseDateOnly(text) is null) return; // 非法日期不提交
            lastCommitted = text;
            SetUserProfile("birthday", text);
        }
        box.LostFocus += (_, _) => Commit();
        box.KeyDown += (_, e) =>
        {
            if (e.Key == Key.Enter) Commit();
        };

        var host = new Border
        {
            Height = 39,
            CornerRadius = new CornerRadius(10),
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderStrongBrush,
            BorderThickness = new Thickness(1),
            Child = new Grid
            {
                ColumnDefinitions =
                {
                    new ColumnDefinition(),
                    new ColumnDefinition { Width = GridLength.Auto },
                },
            },
        };
        var grid = (Grid)host.Child;
        box.Margin = new Thickness(12, 0, 4, 0);
        Grid.SetColumn(box, 0);
        grid.Children.Add(box);

        var calendar = new Calendar
        {
            SelectionMode = CalendarSelectionMode.SingleDate,
            DisplayDate = TryParseDateOnly(initial) ?? DateTime.Today,
        };
        if (TryParseDateOnly(initial) is { } selected) calendar.SelectedDate = selected;
        var popup = new Popup
        {
            PlacementTarget = null,
            Placement = PlacementMode.Bottom,
            StaysOpen = false,
            AllowsTransparency = true,
        };
        popup.Child = new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(6),
            Effect = NativeTheme.CardShadow(),
            Child = calendar,
        };
        var picker = new Button
        {
            Content = NativeTheme.VectorGlyph(Glyphs.CalendarSmall, 16, NativeTheme.TextMutedBrush),
            Width = 34,
            Height = 37,
            Style = NativeTheme.FlatIconButtonStyle,
            Cursor = Cursors.Hand,
            ToolTip = "选择日期",
        };
        picker.Click += (_, _) =>
        {
            popup.PlacementTarget = picker;
            popup.IsOpen = !popup.IsOpen;
        };
        calendar.SelectedDatesChanged += (_, _) =>
        {
            if (calendar.SelectedDate is not { } date) return;
            var text = date.ToString("yyyy-MM-dd");
            box.Text = text;
            if (text != lastCommitted)
            {
                lastCommitted = text;
                SetUserProfile("birthday", text);
            }
            popup.IsOpen = false;
        };
        box.GotKeyboardFocus += (_, _) => host.BorderBrush = NativeTheme.PinkBrush;
        box.LostKeyboardFocus += (_, _) => host.BorderBrush = NativeTheme.BorderStrongBrush;
        Grid.SetColumn(picker, 1);
        grid.Children.Add(picker);
        return host;
    }

    /// <summary>时区下拉：选项来自宿主快照（与渲染页共享白名单）。</summary>
    private FrameworkElement MakeTimezoneSelect(JsonElement user)
    {
        var current = GetString(user, "timezone", "Asia/Shanghai");
        var options = user.ValueKind == JsonValueKind.Object
            && user.TryGetProperty("timezoneOptions", out var opts)
            && opts.ValueKind == JsonValueKind.Array ? opts : default;

        var combo = new ComboBox
        {
            Height = 37,
            FontSize = 13,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            ToolTip = "时区（仅用于时间计算）",
        };
        var selectedIndex = 0;
        if (options.ValueKind == JsonValueKind.Array)
        {
            var index = 0;
            foreach (var opt in options.EnumerateArray())
            {
                var value = GetString(opt, "value");
                combo.Items.Add(GetString(opt, "label", value));
                if (value == current) selectedIndex = index;
                index++;
            }
        }
        combo.SelectedIndex = combo.Items.Count > 0 ? selectedIndex : -1;
        combo.SelectionChanged += (_, _) =>
        {
            var index = combo.SelectedIndex;
            if (options.ValueKind != JsonValueKind.Array || index < 0 || index >= options.GetArrayLength()) return;
            var value = GetString(options[index], "value");
            if (value.Length > 0 && value != current)
            {
                current = value;
                SetUserProfile("timezone", value);
            }
        };
        return combo;
    }
}
