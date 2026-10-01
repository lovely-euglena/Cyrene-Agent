using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CyreneOcr;

/// <summary>
/// CyreneOcr 进程入口 —— 本地 OCR 一次性侧车。
///
/// 命令行：
///   CyreneOcr --ocr --image &lt;path&gt; [--lang &lt;tag&gt;] [--positions]
///   CyreneOcr --list-languages
///
/// 协议（stdout 单行 JSON；诊断走 stderr）：
///   成功: {"ok":true,"text":"...","language":"zh-Hans-CN","durationMs":123,"lineCount":2,
///          "lines":[{"text":"...","words":[{"text":"...","x":1,"y":2,"width":3,"height":4}]}]}
///   失败: {"ok":false,"error":"OCR_IMAGE_NOT_FOUND|...","message":"..."}
///   语言: {"ok":true,"languages":[{"tag":"...","name":"..."}],"default":"..."}
///
/// 引擎：Windows.Media.Ocr（系统内置，无需下载模型；识别语言取决于系统已安装的
/// OCR 语言包）。云端 OCR 不在此进程实现——见主程序 src/main/ocr/ 的 provider 抽象。
/// </summary>
public static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = Encoding.UTF8;
        }
        catch
        {
            // 无控制台/编码不可设时忽略：stdout 仍按默认编码写出
        }

        return Run(args);
    }

    private static int Run(string[] args)
    {
        string mode = "ocr";
        string? imagePath = null;
        string? lang = null;
        var withPositions = false;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--ocr":
                    mode = "ocr";
                    break;
                case "--list-languages":
                    mode = "list-languages";
                    break;
                case "--image":
                    imagePath = RequireValue(args, ref i);
                    break;
                case "--lang":
                    lang = RequireValue(args, ref i);
                    break;
                case "--positions":
                    withPositions = true;
                    break;
                default:
                    Write(new ErrorResult(false, "OCR_ARGS_INVALID", $"未知参数: {args[i]}"));
                    return 0;
            }
        }

        if (mode == "list-languages")
        {
            return RunListLanguages();
        }

        if (string.IsNullOrWhiteSpace(imagePath))
        {
            Write(new ErrorResult(false, "OCR_ARGS_INVALID", "--ocr 需要 --image <path>"));
            return 0;
        }

        return RunOcr(imagePath!, lang, withPositions);
    }

    private static int RunListLanguages()
    {
        try
        {
            var languages = OcrRunner.AvailableLanguages()
                .Select(l => new LanguageResult(l.Tag, l.Name))
                .ToList();
            Write(new LanguagesResult(true, languages, OcrRunner.ResolveAutoLanguageTag()));
        }
        catch (Exception ex)
        {
            Write(new ErrorResult(false, "OCR_FAILED", ex.Message));
        }
        return 0;
    }

    private static int RunOcr(string imagePath, string? lang, bool withPositions)
    {
        try
        {
            var outcome = OcrRunner.RecognizeAsync(imagePath, lang, withPositions).GetAwaiter().GetResult();
            var lines = withPositions
                ? outcome.Lines
                    .Select(line => new LineResult(
                        line.Text,
                        line.Words.Select(w => new WordResult(w.Text, w.X, w.Y, w.W, w.H)).ToList()))
                    .ToList()
                : null;
            Write(new OcrResult(
                true,
                outcome.Text,
                outcome.Language,
                outcome.DurationMs,
                outcome.Lines.Count,
                lines));
        }
        catch (OcrException ex)
        {
            Write(new ErrorResult(false, ex.Code, ex.Message));
        }
        catch (Exception ex)
        {
            Write(new ErrorResult(false, "OCR_FAILED", ex.Message));
        }
        return 0;
    }

    private static string RequireValue(string[] args, ref int index)
    {
        if (index + 1 >= args.Length) throw new ArgumentException($"{args[index]} 缺少参数");
        index++;
        return args[index];
    }

    private static void Write(object payload)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(payload, JsonOptions));
        Console.Out.Flush();
    }

    // ── 输出 DTO ────────────────────────────────────────────

    private sealed record OcrResult(
        bool Ok,
        string Text,
        string Language,
        long DurationMs,
        int LineCount,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] List<LineResult>? Lines);

    private sealed record LineResult(string Text, List<WordResult> Words);

    private sealed record WordResult(string Text, double X, double Y, double Width, double Height);

    private sealed record ErrorResult(bool Ok, string Error, string Message);

    private sealed record LanguageResult(string Tag, string Name);

    private sealed record LanguagesResult(
        bool Ok,
        List<LanguageResult> Languages,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Default);
}
