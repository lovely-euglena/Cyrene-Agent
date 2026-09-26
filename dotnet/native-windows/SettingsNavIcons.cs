// 本文件由脚本从 src/renderer/settings/index.html 的导航 SVG 生成——勿手改。
// 重新生成：node scripts/gen-settings-nav-icons.mjs
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Media;
using System.Windows.Shapes;

namespace CyreneNative;

/// <summary>设置窗导航图标（SVG 几何或图片，按旧版设置页原样复刻）。</summary>
public static class SettingsNavIcons
{
    private static readonly Dictionary<string, (string ViewBox, bool Filled, string Data)> GeometryIcons = new()
    {
        ["user"] = ("0 0 48 48", false, "M44 8H4V38H19L24 43L29 38H44V8Z M33 32C33 27.5817 28.9706 24 24 24C19.0294 24 15 27.5817 15 32"),
        ["tasks"] = ("0 0 48 48", false, "M23.9998 44.3332C34.1251 44.3332 42.3332 36.1251 42.3332 25.9999C42.3332 15.8747 34.1251 7.66656 23.9998 7.66656C13.8746 7.66656 5.6665 15.8747 5.6665 25.9999C5.6665 36.1251 13.8746 44.3332 23.9998 44.3332Z M23.7594 15.3536L23.7582 26.3624L31.5305 34.1347 M4 9.00001L11 4.00001 M44 9.00001L37 4.00001"),
        ["plugins"] = ("0 0 24 24", true, "M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z"),
        ["preferences"] = ("0 0 48 48", false, "M12 35.0137H9H4V8.01273C4 6.90868 4.89543 6.01367 6 6.01367H42C43.1046 6.01367 44 6.90868 44 8.01273V35.0137H36 M24 32L14 42H34L24 32Z"),
        ["appearance"] = ("0 0 48 48", false, "M24 44C29.9601 44 26.3359 35.136 30 31C33.1264 27.4709 44 29.0856 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z M28 17C29.6569 17 31 15.6569 31 14C31 12.3431 29.6569 11 28 11C26.3431 11 25 12.3431 25 14C25 15.6569 26.3431 17 28 17Z M16 21C17.6569 21 19 19.6569 19 18C19 16.3431 17.6569 15 16 15C14.3431 15 13 16.3431 13 18C13 19.6569 14.3431 21 16 21Z M17 34C18.6569 34 20 32.6569 20 31C20 29.3431 18.6569 28 17 28C15.3431 28 14 29.3431 14 31C14 32.6569 15.3431 34 17 34Z"),
        ["general"] = ("0 0 48 48", false, "M18.2838 43.1713C14.9327 42.1736 11.9498 40.3213 9.58787 37.867C10.469 36.8227 11 35.4734 11 34.0001C11 30.6864 8.31371 28.0001 5 28.0001C4.79955 28.0001 4.60139 28.01 4.40599 28.0292C4.13979 26.7277 4 25.3803 4 24.0001C4 21.9095 4.32077 19.8938 4.91579 17.9995C4.94381 17.9999 4.97188 18.0001 5 18.0001C8.31371 18.0001 11 15.3138 11 12.0001C11 11.0488 10.7786 10.1493 10.3846 9.35011C12.6975 7.1995 15.5205 5.59002 18.6521 4.72314C19.6444 6.66819 21.6667 8.00013 24 8.00013C26.3333 8.00013 28.3556 6.66819 29.3479 4.72314C32.4795 5.59002 35.3025 7.1995 37.6154 9.35011C37.2214 10.1493 37 11.0488 37 12.0001C37 15.3138 39.6863 18.0001 43 18.0001C43.0281 18.0001 43.0562 17.9999 43.0842 17.9995C43.6792 19.8938 44 21.9095 44 24.0001C44 25.3803 43.8602 26.7277 43.594 28.0292C43.3986 28.01 43.2005 28.0001 43 28.0001C39.6863 28.0001 37 30.6864 37 34.0001C37 35.4734 37.531 36.8227 38.4121 37.867C36.0502 40.3213 33.0673 42.1736 29.7162 43.1713C28.9428 40.752 26.676 39.0001 24 39.0001C21.324 39.0001 19.0572 40.752 18.2838 43.1713Z M24 31C27.866 31 31 27.866 31 24C31 20.134 27.866 17 24 17C20.134 17 17 20.134 17 24C17 27.866 20.134 31 24 31Z"),
        ["api"] = ("0 0 48 48", false, "M29 16L35.5 22 M20 26L37 7 M35 11L42 17.5"),
        ["api-advanced"] = ("0 0 48 48", false, "M34.0003 41L44 24L34.0003 7H14.0002L4 24L14.0002 41H34.0003Z M24 29C26.7614 29 29 26.7614 29 24C29 21.2386 26.7614 19 24 19C21.2386 19 19 21.2386 19 24C19 26.7614 21.2386 29 24 29Z"),
        ["channels"] = ("0 0 48 48", false, "M22 10L26 10 M20 38H28 M14 4 H34 A3 3 0 0 1 37 7 V41 A3 3 0 0 1 34 44 H14 A3 3 0 0 1 11 41 V7 A3 3 0 0 1 14 4 Z"),
        ["tts"] = ("0 0 48 48", false, "M9 23C9 31.2843 15.7157 38 24 38C32.2843 38 39 31.2843 39 23 M24 38V44 M24 4 H24 A7 7 0 0 1 31 11 V24 A7 7 0 0 1 24 31 H24 A7 7 0 0 1 17 24 V11 A7 7 0 0 1 24 4 Z"),
        ["asr"] = ("0 0 48 48", false, "M36 32V32C40.4183 32 44 28.4183 44 24C44 19.5817 40.4183 16 36 16 M12 16C7.58172 16 4 19.5817 4 24C4 28.4183 7.58172 32 12 32V32 M12 32V31.5V29V24V16C12 9.37258 17.3726 4 24 4C30.6274 4 36 9.37258 36 16V32C36 38.6274 30.6274 44 24 44"),
        ["tokens"] = ("0 0 48 48", false, "M4 42H44 M8 28 H14 V42 H8 Z M21 18 H27 V42 H21 Z M34 6 H40 V42 H34 Z"),
        ["disclaimer"] = ("0 0 48 48", false, "M35 10V4H8C7.44772 4 7 4.44772 7 5V38H13 M21 22H33 M21 30H33 M13 10 H41 V44 H13 Z"),
    };

    private static readonly Dictionary<string, (string Path, bool Tint)> ImageIcons = new()
    {
        ["memory"] = ("icons/mimi.png", false),
        ["cyrene"] = ("icons/cyrene-avatar-line-white.png", true),
        ["about"] = ("icons/cyrene-pink.png", false),
    };

    /// <summary>section → (标题, 说明)：内容区标题栏用（对齐旧版 section-title/hint）。</summary>
    public static readonly Dictionary<string, (string Title, string Hint)> SectionMeta = new()
    {
        ["general"] = ("通用设置", "控制状态栏、日程栏、基础音频和系统行为"),
        ["preferences"] = ("偏好设置", "设置聊天窗口和输出行为的默认偏好"),
        ["appearance"] = ("外观设置", "桌宠显示、窗口样式与聊天排版"),
        ["api"] = ("API 设置", "填写模型服务配置，保存在本地"),
        ["api-advanced"] = ("高级设置", "超时与并发等运行期参数"),
        ["cyrene"] = ("昔涟设置", "管理 Agent 行为、记忆、RAG 与权限"),
        ["memory"] = ("记忆", "长期画像、近况与事件片段"),
        ["user"] = ("我的信息", "你的个人标识与本地资料"),
        ["tasks"] = ("定时任务", "让昔涟按时执行任务"),
        ["tokens"] = ("Token 用量", "本地统计的模型请求用量"),
        ["plugins"] = ("工具配置", "插件管理与市场"),
        ["channels"] = ("连接手机", "渠道配置（Electron 窗口）"),
        ["tts"] = ("TTS 设置", "语音合成（Electron 页面）"),
        ["asr"] = ("ASR 设置", "语音识别（Electron 页面）"),
        ["disclaimer"] = ("免责声明", "免责声明与使用条款"),
        ["about"] = ("关于", "版本与运行环境"),
    };

    /// <summary>创建 18×18 导航图标；未知 section 返回 null。</summary>
    public static FrameworkElement? Create(string section)
    {
        if (ImageIcons.TryGetValue(section, out var imageSpec))
        {
            var source = NativeTheme.TryLoadAssetImage(imageSpec.Path);
            if (imageSpec.Tint)
            {
                // 单色线稿：以导航前景色着色（OpacityMask），与几何图标同色系
                var tinted = new Rectangle { Width = 18, Height = 18 };
                tinted.SetBinding(Shape.FillProperty, new Binding("Foreground") { RelativeSource = new RelativeSource(RelativeSourceMode.FindAncestor, typeof(RadioButton), 1) });
                if (source is not null) tinted.OpacityMask = new ImageBrush(source) { Stretch = Stretch.Uniform };
                return tinted;
            }
            var image = new Image { Width = 18, Height = 18, Stretch = Stretch.Uniform };
            if (source is not null) image.Source = source;
            return image;
        }
        if (!GeometryIcons.TryGetValue(section, out var spec)) return null;
        var path = new Path
        {
            Data = Geometry.Parse(spec.Data),
            Stretch = Stretch.Uniform,
            StrokeThickness = 4,
            StrokeLineJoin = PenLineJoin.Round,
            StrokeStartLineCap = PenLineCap.Round,
            StrokeEndLineCap = PenLineCap.Round,
        };
        if (spec.Filled)
        {
            // StreamGeometry 默认 FillRule=EvenOdd，与 SVG fill-rule=evenodd 一致
            path.SetBinding(Shape.FillProperty, new Binding("Foreground") { RelativeSource = new RelativeSource(RelativeSourceMode.FindAncestor, typeof(RadioButton), 1) });
        }
        else
        {
            path.SetBinding(Shape.StrokeProperty, new Binding("Foreground") { RelativeSource = new RelativeSource(RelativeSourceMode.FindAncestor, typeof(RadioButton), 1) });
        }
        return new Viewbox { Width = 18, Height = 18, Child = path, Stretch = Stretch.Uniform };
    }
}
