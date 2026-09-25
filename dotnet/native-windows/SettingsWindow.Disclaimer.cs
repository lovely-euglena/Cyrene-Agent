using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace CyreneNative;

/// <summary>
/// 设置窗「免责声明」section（WPF 重写，纯静态内容 + 外链）。
/// 文案对齐 Electron 设置页 data-panel="disclaimer"；外链用系统浏览器打开。
/// </summary>
public sealed partial class SettingsWindow
{
    private FrameworkElement BuildDisclaimerSection()
    {
        var panel = new StackPanel();
        panel.Children.Add(MakeHeader("免责声明"));
        panel.Children.Add(MakeHint("使用本软件前，请阅读并理解以下条款。"));

        void Block(string title, params string[] paragraphs)
        {
            panel.Children.Add(MakeSubHeader(title));
            foreach (var paragraph in paragraphs)
            {
                panel.Children.Add(MakeHint(paragraph));
            }
        }

        Block("1. 项目性质与版权声明",
            "本 AI 陪伴程序为个人粉丝非商用同人项目；“昔涟”角色人设取材于米哈游（miHoYo）旗下游戏《崩坏：星穹铁道》。角色名称、世界观、原画、官方文案等全部知识产权及著作权均归属米哈游。",
            "本项目无官方授权，不属于官方软件，双方不存在任何合作关系。");

        Block("2. 使用范围与禁止行为",
            "项目仅限个人本地私人使用，严禁任何商用行为，包括但不限于售卖程序、直播盈利、付费社群运营、商业推广变现，以及对外谎称本程序为官方产品。",
            "程序内表情包为个人收集素材，仅限个人本地使用，禁止批量向外分发传播。");

        Block("3. 用户责任",
            "用户与 AI 产生的对话内容，责任由使用者自行承担。",
            "不得使用本软件发布违法、低俗、造谣、恶意抹黑原 IP、违背公序良俗的内容；违规后果由用户自行承担，开发者不承担任何连带责任。");

        Block("4. 项目无担保声明",
            "本项目为实验性开源项目，不保障程序稳定性。因程序漏洞、硬件故障、本地聊天数据丢失等产生的任何损失，开发者不予赔付。",
            "本软件按“原样”提供，不附带任何明示或默示的担保。");

        Block("5. 版权方联络通道",
            "若米哈游 / HoYoverse 权利方认为本软件存在侵犯权益的情形，请通过以下方式联系，作者承诺在收到通知后 7 个工作日内积极配合处理或下架。",
            "邮箱：1357502569@qq.com（邮件标题请注明【版权事宜】）");
        panel.Children.Add(MakeLinkRow("B站：Playa0 作者空间", "https://space.bilibili.com/260670644"));
        panel.Children.Add(MakeLinkRow("GitHub：Playa-0v0/Cyrene-Agent", "https://github.com/Playa-0v0/Cyrene-Agent"));

        Block("6. 用户反馈与 Bug 提交",
            "如您遇到问题、Bug 或有功能建议，欢迎通过邮箱 1357502569@qq.com（标题建议带【反馈】或【Bug】）或 B 站私信 Playa0 提交。",
            "普通用户反馈我会尽力查看，但不保证及时回复；版权事宜享有最高响应优先级。");
        panel.Children.Add(MakeLinkRow("GitHub Issues", "https://github.com/Playa-0v0/Cyrene-Agent/issues"));

        Block("7. AI 生成内容与使用心态提醒",
            "本软件中所有 AI 角色的对话、回应及行为均由大语言模型实时生成，角色人设和性格为虚构设定，并非真实个体。AI 的输出不具备真实情感、自我意识或主观意图。",
            "所有对话内容均为 AI 生成，不代表任何真实个体的观点或情感；本软件为娱乐性质的辅助工具，不可替代真实的社交关系、亲情、友情或专业心理咨询。",
            "请勿对 AI 角色产生情感依赖，或将虚拟互动视为现实人际关系的替代品；建议在享受陪伴体验的同时，保持与现实世界的健康社交联系。");

        Block("8. 特别鸣谢",
            "特别鸣谢 B 站 UP 主「是依七哒」制作并分享的 Live2D 模型相关资源。本项目仍为个人非商用同人项目，相关素材版权归属原权利方；如有侵权或使用不当，将积极配合处理。");

        Block("9. 贡献者致谢",
            "感谢所有通过 GitHub 提交 Pull Request 为项目做出贡献的开发者，也感谢所有在 Issues 中提交反馈、建议以及 Star 支持本项目的朋友。");
        panel.Children.Add(MakeLinkRow("Cyrene-Agent 贡献者页面", "https://github.com/Playa-0v0/Cyrene-Agent/graphs/contributors"));

        Block("10. 协议效力",
            "安装或使用本软件即视为您已阅读、理解并同意本免责声明的全部条款。");

        return panel;
    }

    /// <summary>外链行：按钮用系统默认浏览器打开。</summary>
    private static Border MakeLinkRow(string text, string url)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 4) };
        row.Children.Add(MakeButton(text, () => OpenExternal(url), minWidth: 220));
        return MakeRow("", row);
    }

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
