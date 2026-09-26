using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace CyreneNative;

/// <summary>
/// 设置窗「插件」section（对位 Electron plugins 面板 / 工具配置）：
/// 内置工具卡（天气 / 高德出行 / 联网搜索 / 邮件 / Playwright / 本地文件权限）
/// + 添加 MCP Server + 管理已安装插件（.NET 插件管理窗）。
///
/// 数据：state.settings.plugins（native-settings-sections.buildPluginsSectionSnapshot）
/// 动作：cmd settings plugins { save / set-permission-level / add-mcp-server }
/// 说明：保存走宿主 plugins save（触发搜索 MCP / Playwright MCP 同步副作用），
/// 不复用 settings.set；已安装插件/市场/限额在插件管理窗中管理。
/// </summary>
public sealed partial class SettingsWindow
{
    private FrameworkElement BuildPluginsSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakePanelHeading(
            NativeTheme.VectorGlyph(Glyphs.Card, 24, NativeTheme.TextDefaultBrush),
            "工具配置",
            "管理昔涟可调用的工具能力；关闭后调度层不会使用对应工具。"));
        panel.Children.Add(MakeSectionStatus("plugins"));

        var plugins = GetNode("plugins");
        var weatherSource = GetString(plugins, "weatherSource", "open-meteo");
        var searchEngine = GetString(plugins, "searchEngine", "off");
        var permissionLevel = GetString(plugins, "permissionLevel", "read-only");
        var amapKey = GetString(plugins, "amapKey");

        void SaveField(string field, object? value) =>
            RequestRouter.SendSettingsAction(
                "plugins", "save", new Dictionary<string, object?> { [field] = value });

        CheckBox Toggle(bool initial, Action<bool> onChange)
        {
            var toggle = new CheckBox
            {
                IsChecked = initial,
                Style = NativeTheme.SwitchStyle,
                Cursor = Cursors.Hand,
                VerticalAlignment = VerticalAlignment.Center,
            };
            toggle.Checked += (_, _) => onChange(true);
            toggle.Unchecked += (_, _) => onChange(false);
            return toggle;
        }

        void WirePassword(PasswordBox box, string field)
        {
            box.LostFocus += (_, _) => SaveField(field, box.Password.Trim());
            box.KeyDown += (_, e) =>
            {
                if (e.Key == Key.Enter) SaveField(field, box.Password.Trim());
            };
        }

        void WireText(TextBox box, string field)
        {
            box.LostFocus += (_, _) => SaveField(field, box.Text.Trim());
            box.KeyDown += (_, e) =>
            {
                if (e.Key == Key.Enter) SaveField(field, box.Text.Trim());
            };
        }

        // ── 天气查询 ──
        var weatherCard = MakeToolCard("⛅", "天气查询",
            "查指定城市的实时天气与预报。Open-Meteo 免配置，或用高德 Key。",
            Toggle(GetBool(plugins, "weatherEnabled"), v => SaveField("weatherEnabled", v)),
            out var weatherBody);
        if (GetBool(plugins, "weatherEnabled"))
        {
            weatherBody.Children.Add(MakeDescribedRow("天气源", "Open-Meteo 免配置；高德天气国内更准。",
                MakeChoiceGroup(
                    new[]
                    {
                        ("open-meteo", "Open-Meteo（免配置）", true),
                        ("amap", "高德天气（需 Key）", true),
                    },
                    weatherSource,
                    v => SaveField("weatherSource", v))));
            if (weatherSource == "amap")
            {
                var weatherKey = MakePluginsPasswordBox(amapKey);
                WirePassword(weatherKey, "amapKey");
                weatherBody.Children.Add(MakeDescribedRow("高德 Key",
                    "lbs.amap.com 注册「Web服务」Key；与出行共用同一个 Key。", weatherKey));
            }
        }
        panel.Children.Add(weatherCard);

        // ── 高德出行 ──
        var travelCard = MakeToolCard("🚗", "高德出行",
            "查驾车/步行/骑行/公交的路线规划和预计时间。需要高德 Key。",
            Toggle(GetBool(plugins, "travelEnabled"), v => SaveField("travelEnabled", v)),
            out var travelBody);
        if (GetBool(plugins, "travelEnabled"))
        {
            var travelKey = MakePluginsPasswordBox(amapKey);
            WirePassword(travelKey, "amapKey");
            travelBody.Children.Add(MakeDescribedRow("高德 Key",
                "高德开放平台 → 控制台 → 应用管理 → 创建「Web服务」类型 Key；与天气共用。", travelKey));
        }
        panel.Children.Add(travelCard);

        // ── 联网搜索 ──
        var searchCard = MakeToolCard("🔍", "联网搜索",
            "让昔涟能搜索互联网获取实时信息。选择一个搜索源并填入对应 Key。",
            Toggle(searchEngine != "off", v =>
            {
                if (v) SaveField("searchEngine", searchEngine == "off" ? "bocha" : searchEngine);
                else SaveField("searchEngine", "off");
            }),
            out var searchBody);
        if (searchEngine != "off")
        {
            searchBody.Children.Add(MakeDescribedRow("搜索源", "切换后展开对应 Key 输入。",
                MakeChoiceGroup(
                    new[]
                    {
                        ("bocha", "博查 Bocha", true),
                        ("tavily", "Tavily", true),
                        ("minimax", "MiniMax", true),
                        ("anySearch", "AnySearch", true),
                    },
                    searchEngine,
                    v => SaveField("searchEngine", v))));
            var (keyField, keyHint, keyValue) = searchEngine switch
            {
                "tavily" => ("searchTavilyKey", "tavily.com 注册获取", GetString(plugins, "searchTavilyKey")),
                "minimax" => ("searchMinimaxKey", "MiniMax 平台 API Key；需先安装 uvx（Python）", GetString(plugins, "searchMinimaxKey")),
                "anySearch" => ("searchAnySearchKey", "anysearch.com 注册获取", GetString(plugins, "searchAnySearchKey")),
                _ => ("searchBochaKey", "open.bochaai.com 注册获取", GetString(plugins, "searchBochaKey")),
            };
            var searchKey = MakePluginsPasswordBox(keyValue);
            WirePassword(searchKey, keyField);
            searchBody.Children.Add(MakeDescribedRow("API Key", keyHint, searchKey));
        }
        panel.Children.Add(searchCard);

        // ── 邮件发送 ──
        var emailCard = MakeToolCard("✉️", "邮件发送",
            "通过 SMTP 发送邮件，可带附件。需填写邮箱 SMTP 授权码（非登录密码）。",
            Toggle(GetBool(plugins, "emailEnabled"), v => SaveField("emailEnabled", v)),
            out var emailBody);
        if (GetBool(plugins, "emailEnabled"))
        {
            var hostBox = MakePluginsTextBox(GetString(plugins, "emailSmtpHost"), 220);
            WireText(hostBox, "emailSmtpHost");
            emailBody.Children.Add(MakeDescribedRow("SMTP 主机", "如 smtp.qq.com", hostBox));

            var portValue = GetInt(plugins, "emailSmtpPort", 465);
            var portBox = MakePluginsTextBox(portValue.ToString(), 100);
            portBox.LostFocus += (_, _) =>
            {
                if (int.TryParse(portBox.Text.Trim(), out var port) && port > 0 && port <= 65535)
                {
                    SaveField("emailSmtpPort", port);
                }
                else
                {
                    portBox.Text = portValue.ToString();
                }
            };
            emailBody.Children.Add(MakeDescribedRow("端口", "常用 465（SSL）或 587（STARTTLS）。", portBox));

            emailBody.Children.Add(MakeDescribedRow("SSL 加密", "465 端口通常开启。",
                Toggle(GetBool(plugins, "emailSmtpSecure", true), v => SaveField("emailSmtpSecure", v))));

            var userBox = MakePluginsTextBox(GetString(plugins, "emailSmtpUser"), 260);
            WireText(userBox, "emailSmtpUser");
            emailBody.Children.Add(MakeDescribedRow("发件邮箱", "如 your@qq.com", userBox));

            var passBox = MakePluginsPasswordBox(GetString(plugins, "emailSmtpPass"), 260);
            WirePassword(passBox, "emailSmtpPass");
            emailBody.Children.Add(MakeDescribedRow("SMTP 授权码",
                "非邮箱登录密码；QQ邮箱 → 设置 → 账户 → 开启 SMTP 服务 获取授权码。", passBox));

            var nameBox = MakePluginsTextBox(GetString(plugins, "emailFromName"), 220);
            WireText(nameBox, "emailFromName");
            emailBody.Children.Add(MakeDescribedRow("发件人名称（可选）", "显示为「来自 昔涟」。", nameBox));
        }
        panel.Children.Add(emailCard);

        // ── 本地文件（权限档位） ──
        var fileCard = MakeToolCard("📁", "本地文件",
            "控制昔涟对本地文件的访问范围与命令执行方式。",
            null,
            out var fileBody);
        fileBody.Children.Add(new TextBlock
        {
            Text = PermissionNote(permissionLevel),
            FontSize = 12.5,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 6),
        });
        fileBody.Children.Add(MakeChoiceGroup(
            new[]
            {
                ("project-read-only", "完全只读", true),
                ("read-only", "只读", true),
                ("per-action", "每次审批", true),
                ("full", "完全访问", true),
            },
            permissionLevel,
            level =>
            {
                if (level == permissionLevel)
                {
                    RefreshSection("plugins");
                    return;
                }
                if (level == "full")
                {
                    var dialog = new FullAccessConfirmDialog { Owner = _window };
                    if (dialog.ShowDialog() != true)
                    {
                        RefreshSection("plugins");
                        return;
                    }
                }
                RequestRouter.SendSettingsAction(
                    "plugins", "set-permission-level",
                    new Dictionary<string, object?> { ["level"] = level },
                    (ok, error, _) =>
                    {
                        if (ok) return;
                        _lastNotices["plugins"] = ($"切换失败：{(error is { Length: > 0 } ? error : "未知错误")}", "error");
                        RenderNotice("plugins");
                    });
            }));
        panel.Children.Add(fileCard);

        // ── 浏览器自动化（Playwright） ──
        panel.Children.Add(MakeToolCard("🌐", "浏览器自动化（Playwright）",
            "让她能点网页、填表单、截图、跑 UI 流程。使用系统自带 Edge 浏览器，无需额外下载。",
            Toggle(GetBool(plugins, "playwrightMcpEnabled"), v => SaveField("playwrightMcpEnabled", v)),
            out _));

        // ── 操作入口 ──
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0) };
        actions.Children.Add(MakeActionButton("添加 MCP Server", () =>
        {
            var dialog = new McpAddDialog { Owner = _window };
            if (dialog.ShowDialog() != true) return;
            RequestRouter.SendSettingsAction(
                "plugins", "add-mcp-server",
                new Dictionary<string, object?> { ["command"] = dialog.Command, ["name"] = dialog.Name },
                (ok, error, _) =>
                {
                    if (ok) return;
                    _lastNotices["plugins"] = ($"添加失败：{(error is { Length: > 0 } ? error : "未知错误")}", "error");
                    RenderNotice("plugins");
                });
        }, primary: true, minWidth: 150));
        actions.Children.Add(MakeActionButton("管理已安装插件",
            () => RequestRouter.SendCommand("plugins", "open"), minWidth: 150));
        panel.Children.Add(actions);
        panel.Children.Add(MakeHint("已安装插件、插件市场与存储/内存限额在插件管理窗中管理；第三方插件设置面板在 Electron 侧承载。"));

        return panel;
    }

    // ── 控件工厂 ──

    /// <summary>内置工具卡（图标 + 标题/说明 + 可选开关 + 配置区）。</summary>
    private static Border MakeToolCard(
        string glyph,
        string title,
        string description,
        CheckBox? toggle,
        out StackPanel body)
    {
        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition());
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var copy = new StackPanel();
        var titleRow = new StackPanel { Orientation = Orientation.Horizontal };
        titleRow.Children.Add(new TextBlock
        {
            Text = glyph,
            FontSize = 15,
            Margin = new Thickness(0, 0, 8, 0),
            VerticalAlignment = VerticalAlignment.Center,
        });
        titleRow.Children.Add(new TextBlock
        {
            Text = title,
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Center,
        });
        copy.Children.Add(titleRow);
        copy.Children.Add(new TextBlock
        {
            Text = description,
            FontSize = 12.5,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 3, 0, 0),
        });
        Grid.SetColumn(copy, 0);
        head.Children.Add(copy);
        if (toggle is not null)
        {
            Grid.SetColumn(toggle, 1);
            head.Children.Add(toggle);
        }

        body = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        var content = new StackPanel();
        content.Children.Add(head);
        content.Children.Add(body);
        return new Border
        {
            Child = content,
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(14),
            Padding = new Thickness(14, 12, 14, 12),
            Margin = new Thickness(0, 6, 0, 6),
            Effect = NativeTheme.CardShadow(),
        };
    }

    private static PasswordBox MakePluginsPasswordBox(string value, double width = 320) => new()
    {
        Password = value,
        Width = width,
        FontSize = 14,
        Padding = new Thickness(6, 4, 6, 4),
        VerticalContentAlignment = VerticalAlignment.Center,
    };

    private static TextBox MakePluginsTextBox(string value, double width = 320) => new()
    {
        Text = value,
        Width = width,
        FontSize = 14,
        Padding = new Thickness(6, 4, 6, 4),
        VerticalContentAlignment = VerticalAlignment.Center,
    };

    /// <summary>权限档位说明（与旧版 PERMISSION_NOTES 同口径）。</summary>
    private static string PermissionNote(string level) => level switch
    {
        "project-read-only" => "完全只读：昔涟只能在当前项目目录内只读，不能修改任何文件，也不能执行命令。",
        "per-action" => "每次审批：每次涉及文件或安装的操作，昔涟都会在聊天里弹卡片让你确认。",
        "full" => "完全访问：昔涟可以自由调用本地命令（如 git/npm/pip）。请只在你完全信任的情况下使用。",
        _ => "只读：昔涟不会修改本地任何文件，也不能为你安装新工具。",
    };
}

/// <summary>
/// 切换到「完全访问」的延迟确认（旧版：风险提示 + 5 秒倒计时后才能点确认）。
/// </summary>
internal sealed class FullAccessConfirmDialog : Window
{
    private readonly Button _confirm;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1) };
    private int _remain = 5;

    public FullAccessConfirmDialog()
    {
        Title = "切换到完全访问？";
        Width = 440;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        NativeTheme.Apply(this);

        var root = new StackPanel { Margin = new Thickness(20, 14, 20, 16) };
        root.Children.Add(new TextBlock
        {
            Text = "⚠️ 这意味着昔涟可以在你的电脑上自由执行命令，包括 git clone、npm install、删除文件等。请只在你完全信任她的判断时启用。",
            FontSize = 14,
            Foreground = NativeTheme.TextStrongBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 8, 0, 0),
        });
        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 14, 0, 0),
        };
        actions.Children.Add(MakeDialogButton(this, "再想想", () =>
        {
            DialogResult = false;
            Close();
        }));
        _confirm = MakeDialogButton(this, $"我了解风险（{_remain} 秒）", () =>
        {
            DialogResult = true;
            Close();
        }, primary: true);
        _confirm.IsEnabled = false;
        actions.Children.Add(_confirm);
        root.Children.Add(actions);
        NativeTheme.ApplyDialogShell(this, "切换到完全访问？", root);

        _timer.Tick += (_, _) =>
        {
            _remain -= 1;
            if (_remain <= 0)
            {
                _timer.Stop();
                _confirm.IsEnabled = true;
                _confirm.Content = "我了解风险，启用";
                return;
            }
            _confirm.Content = $"我了解风险（{_remain} 秒）";
        };
        _timer.Start();
    }

    private static Button MakeDialogButton(Window owner, string text, Action onClick, bool primary = false)
    {
        var button = new Button
        {
            Content = text,
            MinWidth = 96,
            Margin = new Thickness(8, 0, 0, 0),
            Style = primary ? NativeTheme.PrimaryButtonStyle : NativeTheme.SecondaryButtonStyle,
        };
        button.Click += (_, _) => onClick();
        return button;
    }
}

/// <summary>添加 MCP Server 对话框（旧版：命令 + 名称两步输入合并为一次）。</summary>
internal sealed class McpAddDialog : Window
{
    private readonly TextBox _commandBox = new();
    private readonly TextBox _nameBox = new();
    private readonly TextBlock _status = new()
    {
        FontSize = 12.5,
        Foreground = new SolidColorBrush(Color.FromRgb(0xD3, 0x3A, 0x3A)),
        Margin = new Thickness(0, 6, 0, 0),
        TextWrapping = TextWrapping.Wrap,
    };

    public string Command => _commandBox.Text.Trim();

    public string Name => _nameBox.Text.Trim();

    public McpAddDialog()
    {
        Title = "添加 MCP Server";
        Width = 520;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        NativeTheme.Apply(this);

        var root = new StackPanel { Margin = new Thickness(20, 14, 20, 16) };
        root.Children.Add(new TextBlock
        {
            Text = "填写 MCP Server 启动命令（如 node C:\\my-mcp-server\\index.js），添加后会自动连接并注册其工具。",
            FontSize = 13,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 4),
        });

        Configure(_commandBox, 480, "node C:\\my-mcp-server\\index.js --flag");
        root.Children.Add(Field("启动命令", _commandBox, "走 MCP stdio 协议；命令不存在或启动即退出时添加会失败。"));
        Configure(_nameBox, 240, "如：我的工具");
        root.Children.Add(Field("名称（可选）", _nameBox, "留空默认「未命名 MCP」；名称用于工具列表展示。"));
        root.Children.Add(_status);

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 14, 0, 0),
        };
        actions.Children.Add(MakeButton("取消", () =>
        {
            DialogResult = false;
            Close();
        }));
        actions.Children.Add(MakeButton("添加", Save, primary: true));
        root.Children.Add(actions);
        NativeTheme.ApplyDialogShell(this, "添加 MCP Server", root);
    }

    private static void Configure(TextBox box, double width, string placeholder)
    {
        box.Width = width;
        box.FontSize = 14;
        box.Padding = new Thickness(6, 4, 6, 4);
        box.VerticalContentAlignment = VerticalAlignment.Center;
        box.HorizontalAlignment = HorizontalAlignment.Left;
        box.ToolTip = placeholder;
    }

    private static StackPanel Field(string label, TextBox box, string? hint = null)
    {
        var row = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
        row.Children.Add(new TextBlock
        {
            Text = label,
            FontSize = 13,
            Foreground = NativeTheme.TextDefaultBrush,
            Margin = new Thickness(0, 0, 0, 4),
        });
        row.Children.Add(box);
        if (!string.IsNullOrEmpty(hint))
        {
            row.Children.Add(new TextBlock
            {
                Text = hint,
                FontSize = 12.5,
                Foreground = NativeTheme.TextMutedBrush,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 4, 0, 0),
            });
        }
        return row;
    }

    private Button MakeButton(string text, Action onClick, bool primary = false)
    {
        var button = new Button
        {
            Content = text,
            MinWidth = 84,
            Margin = new Thickness(8, 0, 0, 0),
            Style = primary ? NativeTheme.PrimaryButtonStyle : NativeTheme.SecondaryButtonStyle,
        };
        button.Click += (_, _) => onClick();
        return button;
    }

    private void Save()
    {
        if (Command.Length == 0)
        {
            _status.Text = "请填写启动命令";
            return;
        }
        DialogResult = true;
        Close();
    }
}
