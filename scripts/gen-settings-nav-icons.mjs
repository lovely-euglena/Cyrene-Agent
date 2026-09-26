// 从 Electron 设置页导航生成 WPF 图标常量文件（dotnet/native-windows/SettingsNavIcons.cs）
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根目录：脚本可能从任意 cwd 调用
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const html = fs.readFileSync(path.join(root, "src/renderer/settings/index.html"), "utf8");
const navRe = /<button type="button" class="nav-item[^"]*" data-section="([^"]+)">([\s\S]*?)<\/button>/g;
let m;
const svgIcons = [];
const imgIcons = [];
const meta = []; // {section, title, hint}

// 单色线稿（-white.png）：旧页 pearl-white 主题换深色线稿；WPF 用前景色着色渲染，
// 直接贴白色原图在浅色导航底上不可见。
const TINT_ICONS = new Set(["icons/cyrene-avatar-line-white.png"]);

while ((m = navRe.exec(html)) !== null) {
  const section = m[1];
  let body = m[2];
  // 去掉 <defs>（含 clipPath，仅用于裁剪，不是可视图形）
  body = body.replace(/<defs>[\s\S]*?<\/defs>/g, "");
  const img = body.match(/<img[^>]*src="([^"]+)"/);
  // 旧页 src 相对 settings/ 目录（../icons/x.png），assets 下为 icons/x.png：去掉 "../" 前缀
  if (img) {
    const src = img[1].replace("../", "");
    imgIcons.push([section, src, TINT_ICONS.has(src)]);
    continue;
  }
  const svg = body.match(/<svg[\s\S]*?<\/svg>/);
  if (!svg) continue;
  const svgText = svg[0];
  const viewBox = (svgText.match(/viewBox="([^"]+)"/) || [])[1] ?? "0 0 48 48";
  const hasStroke = /stroke="currentColor"/.test(svgText);
  const filled = !hasStroke;
  const parts = [];
  for (const p of svgText.matchAll(/<path[^>]*d="([^"]+)"/g)) parts.push(p[1].trim());
  for (const r of svgText.matchAll(/<rect[^>]*\/>/g)) {
    const get = (k) => (r[0].match(new RegExp(k + '="([^"]+)"')) || [])[1];
    const x = +(get("x") ?? 0), y = +(get("y") ?? 0), w = +(get("width") ?? 0), h = +(get("height") ?? 0);
    const rx = +(get("rx") ?? 0);
    parts.push(
      rx > 0
        ? `M${x + rx} ${y} H${x + w - rx} A${rx} ${rx} 0 0 1 ${x + w} ${y + rx} V${y + h - rx} A${rx} ${rx} 0 0 1 ${x + w - rx} ${y + h} H${x + rx} A${rx} ${rx} 0 0 1 ${x} ${y + h - rx} V${y + rx} A${rx} ${rx} 0 0 1 ${x + rx} ${y} Z`
        : `M${x} ${y} H${x + w} V${y + h} H${x} Z`,
    );
  }
  svgIcons.push([section, viewBox, filled, parts.join(" ")]);
}

// 旧页「关于」是通用设置里的行（无导航图标）；WPF 独立 section 用应用图标
imgIcons.push(["about", "icons/cyrene-pink.png", false]);

// 各 section 的标题/说明（旧版 settings-nav / section-title / section-hint 语义）
const titles = {
  general: ["通用设置", "控制状态栏、日程栏、基础音频和系统行为"],
  preferences: ["偏好设置", "设置聊天窗口和输出行为的默认偏好"],
  appearance: ["外观设置", "桌宠显示、窗口样式与聊天排版"],
  api: ["API 设置", "填写模型服务配置，保存在本地"],
  "api-advanced": ["高级设置", "超时与并发等运行期参数"],
  cyrene: ["昔涟设置", "管理 Agent 行为、记忆、RAG 与权限"],
  memory: ["记忆", "长期画像、近况与事件片段"],
  user: ["我的信息", "你的个人标识与本地资料"],
  tasks: ["定时任务", "让昔涟按时执行任务"],
  tokens: ["Token 用量", "本地统计的模型请求用量"],
  plugins: ["工具配置", "插件管理与市场"],
  channels: ["连接手机", "渠道配置（Electron 窗口）"],
  tts: ["TTS 设置", "语音合成（Electron 页面）"],
  asr: ["ASR 设置", "语音识别（Electron 页面）"],
  disclaimer: ["免责声明", "免责声明与使用条款"],
  about: ["关于", "版本与运行环境"],
};
for (const [section, [title, hint]] of Object.entries(titles)) meta.push([section, title, hint]);

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const lines = [];
lines.push("// 本文件由脚本从 src/renderer/settings/index.html 的导航 SVG 生成——勿手改。");
lines.push("// 重新生成：node scripts/gen-settings-nav-icons.mjs");
lines.push("using System.Collections.Generic;");
lines.push("using System.Windows;");
lines.push("using System.Windows.Controls;");
lines.push("using System.Windows.Data;");
lines.push("using System.Windows.Media;");
lines.push("using System.Windows.Shapes;");
lines.push("");
lines.push("namespace CyreneNative;");
lines.push("");
lines.push("/// <summary>设置窗导航图标（SVG 几何或图片，按旧版设置页原样复刻）。</summary>");
lines.push("public static class SettingsNavIcons");
lines.push("{");
lines.push("    private static readonly Dictionary<string, (string ViewBox, bool Filled, string Data)> GeometryIcons = new()");
lines.push("    {");
for (const [section, viewBox, filled, data] of svgIcons) {
  lines.push(`        ["${section}"] = ("${viewBox}", ${filled ? "true" : "false"}, "${esc(data)}"),`);
}
lines.push("    };");
lines.push("");
lines.push("    private static readonly Dictionary<string, (string Path, bool Tint)> ImageIcons = new()");
lines.push("    {");
for (const [section, src, tint] of imgIcons) lines.push(`        ["${section}"] = ("${src}", ${tint ? "true" : "false"}),`);
lines.push("    };");
lines.push("");
lines.push("    /// <summary>section → (标题, 说明)：内容区标题栏用（对齐旧版 section-title/hint）。</summary>");
lines.push("    public static readonly Dictionary<string, (string Title, string Hint)> SectionMeta = new()");
lines.push("    {");
for (const [section, title, hint] of meta) lines.push(`        ["${section}"] = ("${esc(title)}", "${esc(hint)}"),`);
lines.push("    };");
lines.push("");
lines.push("    /// <summary>创建 18×18 导航图标；未知 section 返回 null。</summary>");
lines.push("    public static FrameworkElement? Create(string section)");
lines.push("    {");
lines.push("        if (ImageIcons.TryGetValue(section, out var imageSpec))");
lines.push("        {");
lines.push("            var source = NativeTheme.TryLoadAssetImage(imageSpec.Path);");
lines.push("            if (imageSpec.Tint)");
lines.push("            {");
lines.push("                // 单色线稿：以导航前景色着色（OpacityMask），与几何图标同色系");
lines.push("                var tinted = new Rectangle { Width = 18, Height = 18 };");
lines.push("                tinted.SetBinding(Shape.FillProperty, new Binding(\"Foreground\") { RelativeSource = new RelativeSource(RelativeSourceMode.FindAncestor, typeof(RadioButton), 1) });");
lines.push("                if (source is not null) tinted.OpacityMask = new ImageBrush(source) { Stretch = Stretch.Uniform };");
lines.push("                return tinted;");
lines.push("            }");
lines.push("            var image = new Image { Width = 18, Height = 18, Stretch = Stretch.Uniform };");
lines.push("            if (source is not null) image.Source = source;");
lines.push("            return image;");
lines.push("        }");
lines.push("        if (!GeometryIcons.TryGetValue(section, out var spec)) return null;");
lines.push("        var path = new Path");
lines.push("        {");
lines.push("            Data = Geometry.Parse(spec.Data),");
lines.push("            Stretch = Stretch.Uniform,");
lines.push("            StrokeThickness = 4,");
lines.push("            StrokeLineJoin = PenLineJoin.Round,");
lines.push("            StrokeStartLineCap = PenLineCap.Round,");
lines.push("            StrokeEndLineCap = PenLineCap.Round,");
lines.push("        };");
lines.push("        if (spec.Filled)");
lines.push("        {");
lines.push("            // StreamGeometry 默认 FillRule=EvenOdd，与 SVG fill-rule=evenodd 一致");
lines.push("            path.SetBinding(Shape.FillProperty, new Binding(\"Foreground\") { RelativeSource = new RelativeSource(RelativeSourceMode.FindAncestor, typeof(RadioButton), 1) });");
lines.push("        }");
lines.push("        else");
lines.push("        {");
lines.push("            path.SetBinding(Shape.StrokeProperty, new Binding(\"Foreground\") { RelativeSource = new RelativeSource(RelativeSourceMode.FindAncestor, typeof(RadioButton), 1) });");
lines.push("        }");
lines.push("        return new Viewbox { Width = 18, Height = 18, Child = path, Stretch = Stretch.Uniform };");
lines.push("    }");
lines.push("}");

fs.writeFileSync(path.join(root, "dotnet/native-windows/SettingsNavIcons.cs"), lines.join("\n") + "\n", "utf8");
console.log("written dotnet/native-windows/SettingsNavIcons.cs");
console.log("svg:", svgIcons.map((i) => i[0]).join(", "));
console.log("img:", imgIcons.map((i) => i[0]).join(", "));
