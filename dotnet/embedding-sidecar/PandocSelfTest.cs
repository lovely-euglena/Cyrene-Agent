using System.Text;

namespace CyreneEmbedSidecar;

/// <summary>
/// `cyrene-embed verify-pandoc [pandocPath]` 自检：
///   纯函数（扩展名路由 / 版本解析 / markdown 清洗 / 路径解析）全量断言；
///   若本机有 pandoc（参数 / PATH），再做一次真实 .rst → markdown 转换。
/// 任一项失败退出码 1，便于 CI/本地回归。
/// </summary>
public static class PandocSelfTest
{
    public static int Run(string? pandocPath)
    {
        var pass = 0;
        var fail = 0;
        var tempDirs = new List<string>();

        void Check(string name, bool ok)
        {
            if (ok)
            {
                pass++;
                Console.WriteLine($"[PASS] {name}");
            }
            else
            {
                fail++;
                Console.WriteLine($"[FAIL] {name}");
            }
        }

        try
        {
            // ── 扩展名路由 ──
            Check("扩展名路由 .docx→docx", PandocConverter.GetReader(".docx") == "docx");
            Check("扩展名路由 .ADOC→asciidoc（大小写不敏感）", PandocConverter.GetReader(".ADOC") == "asciidoc");
            Check("扩展名路由 .tex→latex", PandocConverter.GetReader(".tex") == "latex");
            Check("非 pandoc 扩展名 .pdf 拒绝", !PandocConverter.IsPandocExt(".pdf"));

            // ── 版本解析 ──
            Check("版本解析 3.1.2", PandocConverter.ParseVersion("pandoc 3.1.2\nFeatures: +server") == "3.1.2");
            Check("版本解析 pandoc.exe 2.19.2", PandocConverter.ParseVersion("pandoc.exe 2.19.2") == "2.19.2");
            Check("版本解析无版本返回 null", PandocConverter.ParseVersion("no version") is null);

            // ── markdown 清洗 ──
            var dirty = string.Join("\n", new[]
            {
                "![封面](media/image1.png){width=\"5in\"}",
                "",
                "",
                "",
                "<div class=\"x\">正文<br>换行</div>",
                "[]()",
                "残留\u0007控制符",
                "链接 <https://example.com> 保留",
            });
            var (cleaned, _) = PandocConverter.CleanMarkdown(dirty);
            Check("清洗：图片占位", cleaned.Contains("[图片：封面]"));
            Check("清洗：图片路径移除", !cleaned.Contains("media/image1.png"));
            Check("清洗：属性块移除", !cleaned.Contains("{width=\"5in\"}"));
            Check("清洗：HTML 壳移除", !cleaned.Contains("<div"));
            Check("清洗：br 转换行", cleaned.Contains("正文\n换行"));
            Check("清洗：空链接移除", !cleaned.Contains("[]()"));
            Check("清洗：控制字符移除", !cleaned.Contains('\u0007'));
            Check("清洗：自动链接保留", cleaned.Contains("<https://example.com>"));
            Check("清洗：3+ 空行折叠", !cleaned.Contains("\n\n\n"));
            Check("清洗：无 alt 图片 → [图片]", PandocConverter.CleanMarkdown("![](a.png)").Text == "[图片]");

            var longText = new string('a', PandocConverter.MaxCleanChars + 100);
            var (truncatedText, truncated) = PandocConverter.CleanMarkdown(longText);
            Check("清洗：超限截断标记", truncated && truncatedText.EndsWith("> [内容过长，已截断]"));

            // ── 路径解析 ──
            var tempDir = Directory.CreateTempSubdirectory("cyrene-pandoc-selftest-").FullName;
            tempDirs.Add(tempDir);
            var fakeExe = Path.Combine(tempDir, OperatingSystem.IsWindows() ? "pandoc.exe" : "pandoc");
            File.WriteAllText(fakeExe, "");
            Check("路径解析：自定义文件", PandocConverter.ResolveExecutable($"  {fakeExe}  ") == fakeExe);
            Check("路径解析：自定义目录", PandocConverter.ResolveExecutable(tempDir) == fakeExe);
            Check("路径解析：无效自定义路径不回退", PandocConverter.ResolveExecutable(Path.Combine(tempDir, "missing", "pandoc")) is null);

            // ── 真实转换（本机有 pandoc 时） ──
            var exe = PandocConverter.ResolveExecutable(pandocPath);
            if (exe is null)
            {
                Console.WriteLine("[SKIP] 未检测到 Pandoc（可用参数指定路径：verify-pandoc <pandoc.exe>）");
            }
            else
            {
                var probe = PandocConverter.Probe(exe);
                Check($"探测：--version 解析（{probe?.Version ?? "null"}）", probe is not null);
                Check("探测：reader 能力表非空", probe is { InputFormats.Count: > 0 });

                var rstPath = Path.Combine(tempDir, "sample.rst");
                File.WriteAllText(rstPath, "标题\n====\n\nhello **world**\n", Encoding.UTF8);
                var converted = PandocConverter.ConvertFile(rstPath, pandocPath, () => false);
                Check("真实转换：.rst 成功", converted.Ok);
                Check("真实转换：内容正确", converted.Ok && (converted.Text ?? "").Contains("hello **world**"));

                var missing = PandocConverter.ConvertFile(rstPath, Path.Combine(tempDir, "missing", "pandoc.exe"), () => false);
                Check("真实转换：无效路径给出可操作错误", !missing.Ok && (missing.Reason ?? "").Contains("Pandoc"));

                var cancelled = PandocConverter.ConvertFile(rstPath, pandocPath, () => true);
                Check("真实转换：取消即时中止", !cancelled.Ok && cancelled.Code == "cancelled");
            }
        }
        finally
        {
            foreach (var dir in tempDirs)
            {
                try
                {
                    Directory.Delete(dir, recursive: true);
                }
                catch
                {
                    // 清理失败不影响自检结论
                }
            }
        }

        Console.WriteLine($"[verify-pandoc] {pass} passed, {fail} failed");
        return fail == 0 ? 0 : 1;
    }
}
