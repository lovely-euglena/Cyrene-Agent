using System;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// 设置窗「免责声明」section（WPF 重写，逐项对齐 Electron settings 页 pearl-white）：
///   - 面板卡 + 标题砖（文件页图标）+「免责声明与使用条款 / 使用本软件前，请阅读并理解以下条款。」
///   - 每节一张 disclaimer-section 卡（14/16 内边距、18 圆角、白底描边）：
///     标题 14/500 + 段落 14/23.8 muted + 无序列表（18px 项目符号列）
///   - 外链以内联粉色链接呈现（下划线为半透明粉，hover 深一档），由系统浏览器打开；
///     列表项图标：邮箱（描边）/ bilibili（品牌粉填充）/ GitHub（填充）
/// 文案与 index.html data-panel="disclaimer" 完全一致。
/// </summary>
public sealed partial class SettingsWindow
{
    private const string DisclaimerSubtitle = "使用本软件前，请阅读并理解以下条款。";
    private const double DisclaimerLineHeight = 23.8; // 14px × 1.7

    private FrameworkElement BuildDisclaimerSection()
    {
        var root = new StackPanel();
        root.Children.Add(MakePanelHeading(
            NativeTheme.VectorGlyph(Glyphs.Document, 24, NativeTheme.TextDefaultBrush),
            "免责声明与使用条款",
            DisclaimerSubtitle));

        var content = new StackPanel();
        root.Children.Add(content);

        content.Children.Add(MakeDisclaimerSection("1. 项目性质与版权声明",
            DisclaimerParagraph(RunText("本 AI 陪伴程序为个人粉丝非商用同人项目，“昔涟”角色人设取材于米哈游（miHoYo）旗下游戏《崩坏：星穹铁道》。角色名称、世界观、原画、官方文案等全部知识产权及著作权均归属米哈游。")),
            DisclaimerParagraph(RunText("本项目无官方授权，不属于官方软件，双方不存在任何合作关系。"))));

        content.Children.Add(MakeDisclaimerSection("2. 使用范围与禁止行为",
            DisclaimerParagraph(RunText("项目仅限个人本地私人使用，严禁任何商用行为，包括但不限于售卖程序、直播盈利、付费社群运营、商业推广变现，以及对外谎称本程序为官方产品。")),
            DisclaimerParagraph(RunText("程序内表情包为个人收集素材，仅限个人本地使用，禁止批量向外分发传播。"))));

        content.Children.Add(MakeDisclaimerSection("3. 用户责任",
            DisclaimerParagraph(RunText("用户与 AI 产生的对话内容，责任由使用者自行承担。")),
            DisclaimerParagraph(RunText("不得使用本软件发布违法、低俗、造谣、恶意抹黑原作 IP、违背公序良俗的内容；违规后果由用户自行承担，开发者不承担任何连带责任。"))));

        content.Children.Add(MakeDisclaimerSection("4. 项目无担保声明",
            DisclaimerParagraph(RunText("本项目为实验性开源项目，不保障程序稳定性。因程序漏洞、硬件故障、本地聊天数据丢失等产生的任何损失，开发者不予赔付。")),
            DisclaimerParagraph(RunText("本软件按“原样”提供，不附带任何明示或默示的担保。"))));

        content.Children.Add(MakeDisclaimerSection("5. 版权方联络通道",
            DisclaimerParagraph(RunText("若米哈游 / HoYoverse 权利方认为本软件存在侵犯权益的情形，请通过以下方式联系，作者承诺在收到通知后 7 个工作日内积极配合处理或下架。")),
            DisclaimerListItem(MailIcon(), RunText("电子邮箱：1357502569@qq.com（邮件标题请注明【版权事宜】）")),
            DisclaimerListItem(BilibiliIcon(),
                RunLink("B站：Playa0 作者空间", "https://space.bilibili.com/260670644"),
                RunText("（私信请注明【版权联络】）")),
            DisclaimerListItem(GithubIcon(),
                RunText("GitHub："),
                RunLink("Playa-0v0/Cyrene-Agent", "https://github.com/Playa-0v0/Cyrene-Agent"))));

        content.Children.Add(MakeDisclaimerSection("6. 用户反馈与 Bug 提交",
            DisclaimerParagraph(RunText("如您遇到问题、Bug 或有功能建议，欢迎通过以下渠道提交。")),
            DisclaimerListItem(MailIcon(), RunText("发送邮件至 1357502569@qq.com（标题建议带【反馈】或【Bug】）")),
            DisclaimerListItem(BilibiliIcon(),
                RunLink("B站私信 Playa0", "https://space.bilibili.com/260670644"),
                RunText("（开头注明【反馈/Bug】）")),
            DisclaimerListItem(GithubIcon(),
                RunLink("GitHub Issues", "https://github.com/Playa-0v0/Cyrene-Agent/issues"),
                RunText("（提交 Bug / 功能建议）")),
            DisclaimerParagraph(RunText("普通用户反馈我会尽力查看，但不保证及时回复；版权事宜享有最高响应优先级。"))));

        content.Children.Add(MakeDisclaimerSection("7. AI 生成内容与使用心态提醒",
            DisclaimerParagraph(RunText("本软件中所有 AI 角色的对话、回应及行为均由大语言模型实时生成，角色人设和性格为虚构设定，并非真实个体。AI 的输出不具备真实情感、自我意识或主观意图。")),
            DisclaimerParagraph(RunText("请注意：")),
            DisclaimerListItem(null, RunText("所有对话内容均为 AI 生成，不代表任何真实个体的观点或情感。")),
            DisclaimerListItem(null, RunText("本软件为娱乐性质的辅助工具，不可替代真实的社交关系、亲情、友情或专业心理咨询。")),
            DisclaimerListItem(null, RunText("请勿对 AI 角色产生情感依赖，或将虚拟互动视为现实人际关系的替代品。")),
            DisclaimerListItem(null, RunText("建议您在享受陪伴体验的同时，保持与现实世界的健康社交联系。"))));

        content.Children.Add(MakeDisclaimerSection("8. 特别鸣谢",
            DisclaimerParagraph(
                RunText("特别鸣谢 B站 UP 主 "),
                RunLink("是依七哒", "https://space.bilibili.com/457683484"),
                RunText(" 制作并分享的 Live2D 模型相关资源，为本项目的桌宠展示提供了重要参考与支持。本项目仍为个人非商用同人项目，相关素材版权归属原权利方；如有侵权或使用不当，将积极配合处理。"))));

        content.Children.Add(MakeDisclaimerSection("9. 贡献者致谢",
            DisclaimerParagraph(
                RunText("感谢所有通过 GitHub 提交 Pull Request 为项目做出贡献的开发者。完整贡献者列表请查看："),
                RunLink("Cyrene-Agent 贡献者页面 →", "https://github.com/Playa-0v0/Cyrene-Agent/graphs/contributors?from=2026%2F5%2F30")),
            DisclaimerParagraph(RunText("同时也感谢所有在 Issues 中提交反馈、建议以及 Star 支持本项目的朋友。"))));

        content.Children.Add(MakeDisclaimerSection("10. 协议效力",
            DisclaimerParagraph(RunText("安装或使用本软件即视为您已阅读、理解并同意本免责声明的全部条款。"))));

        return new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(24),
            Padding = new Thickness(20),
            Child = root,
            Effect = NativeTheme.CardShadow(),
        };
    }

    // ── 免责声明块（对齐 .disclaimer-section） ──

    private static Border MakeDisclaimerSection(string title, params FrameworkElement[] blocks)
    {
        var body = new StackPanel();
        body.Children.Add(MakeText(title, 14, NativeTheme.TextStrongBrush, weight: FontWeights.Medium,
            lineHeight: 21, margin: new Thickness(0, 0, 0, 8)));
        foreach (var block in blocks) body.Children.Add(block);
        return new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(18),
            Padding = new Thickness(16, 14, 16, 14),
            Effect = NativeTheme.CardShadow(),
            Margin = new Thickness(0, 0, 0, 12),
            Child = body,
        };
    }

    private static TextBlock DisclaimerParagraph(params Inline[] inlines) => DisclaimerRichText(23.8, inlines);

    /// <summary>列表项：18px 项目符号列 + 可选行内图标 + 富文本（.disclaimer-section ul > li）。</summary>
    private static FrameworkElement DisclaimerListItem(FrameworkElement? icon, params Inline[] inlines)
    {
        var text = DisclaimerRichText(DisclaimerLineHeight, inlines);
        var grid = new Grid { Margin = new Thickness(0, 0, 0, 8) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        var bullet = MakeText("•", 14, NativeTheme.TextMutedBrush, lineHeight: DisclaimerLineHeight);
        Grid.SetColumn(bullet, 0);
        grid.Children.Add(bullet);

        if (icon is null)
        {
            Grid.SetColumn(text, 1);
            grid.Children.Add(text);
            return grid;
        }
        var row = new Grid();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition());
        icon.VerticalAlignment = VerticalAlignment.Top;
        icon.Margin = new Thickness(0, 4, 6, 0);
        Grid.SetColumn(icon, 0);
        row.Children.Add(icon);
        Grid.SetColumn(text, 1);
        row.Children.Add(text);
        Grid.SetColumn(row, 1);
        grid.Children.Add(row);
        return grid;
    }

    private static TextBlock DisclaimerRichText(double lineHeight, Inline[] inlines)
    {
        var text = new TextBlock
        {
            FontSize = 14,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            LineHeight = lineHeight,
            LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
            Margin = new Thickness(0, 0, 0, 8),
        };
        foreach (var inline in inlines) text.Inlines.Add(inline);
        return text;
    }

    private static Run RunText(string text) => new(text);

    /// <summary>内联链接（.disclaimer-section a：粉字 + 半透明粉下划线，hover 深一档）。</summary>
    private static Hyperlink RunLink(string text, string url)
    {
        var link = new Hyperlink(new Run(text))
        {
            Foreground = NativeTheme.Pink600Brush,
            TextDecorations = LinkUnderline,
            Cursor = Cursors.Hand,
        };
        link.Click += (_, _) => OpenExternal(url);
        link.MouseEnter += (_, _) => link.Foreground = NativeTheme.Pink700Brush;
        link.MouseLeave += (_, _) => link.Foreground = NativeTheme.Pink600Brush;
        return link;
    }

    /// <summary>下划线：与 Electron border-bottom rgba(232,74,120,0.34) 同观感。</summary>
    private static readonly TextDecorationCollection LinkUnderline = BuildLinkUnderline();

    private static TextDecorationCollection BuildLinkUnderline()
    {
        var decoration = new TextDecoration
        {
            Location = TextDecorationLocation.Underline,
            Pen = new Pen(new SolidColorBrush(Color.FromArgb(0x8C, 0xE8, 0x4A, 0x78)), 1),
            PenOffset = 2,
        };
        var collection = new TextDecorationCollection { decoration };
        collection.Freeze();
        return collection;
    }

    // ── 列表项图标（16px） ──

    private static FrameworkElement MailIcon() => NativeTheme.VectorGlyph(Glyphs.Mail, 16, NativeTheme.TextMutedBrush);

    private static FrameworkElement BilibiliIcon() => NativeTheme.FilledGlyph(Glyphs.Bilibili, 16,
        new SolidColorBrush(Color.FromRgb(0xFB, 0x72, 0x99)), viewBox: 24);

    private static FrameworkElement GithubIcon() => NativeTheme.FilledGlyph(Glyphs.Github, 16,
        NativeTheme.TextMutedBrush, viewBox: 24);

    private static void OpenExternal(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }
        catch
        {
            // 打开失败不致命（无默认浏览器等）
        }
    }
}
