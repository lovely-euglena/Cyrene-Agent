using System.Diagnostics;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;

namespace CyreneOcr;

internal sealed class OcrException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal sealed record OcrWord(string Text, double X, double Y, double W, double H);

internal sealed record OcrLine(string Text, IReadOnlyList<OcrWord> Words);

internal sealed record OcrOutcome(string Text, IReadOnlyList<OcrLine> Lines, string Language, long DurationMs);

/// <summary>
/// Windows.Media.Ocr 封装：解码图片 → 合成到白底（透明截图友好）→ 识别。
/// 引擎与语言包均来自操作系统，无模型文件、无网络依赖。
/// </summary>
internal static class OcrRunner
{
    public static IReadOnlyList<(string Tag, string Name)> AvailableLanguages()
    {
        return OcrEngine.AvailableRecognizerLanguages
            .Select(l => (l.LanguageTag, l.DisplayName))
            .ToList();
    }

    /// <summary>用户配置语言可用时返回其 tag，否则回退首个可用语言（供设置页展示默认值）。</summary>
    public static string? ResolveAutoLanguageTag()
    {
        var profile = OcrEngine.TryCreateFromUserProfileLanguages();
        if (profile is not null) return profile.RecognizerLanguage.LanguageTag;
        return OcrEngine.AvailableRecognizerLanguages.FirstOrDefault()?.LanguageTag;
    }

    public static async Task<OcrOutcome> RecognizeAsync(string imagePath, string? language, bool withPositions)
    {
        if (!File.Exists(imagePath))
        {
            throw new OcrException("OCR_IMAGE_NOT_FOUND", $"图片不存在: {imagePath}");
        }

        StorageFile file;
        try
        {
            file = await StorageFile.GetFileFromPathAsync(imagePath);
        }
        catch (Exception ex)
        {
            throw new OcrException("OCR_IMAGE_READ_FAILED", $"无法打开图片: {ex.Message}");
        }

        SoftwareBitmap? bitmap = null;
        try
        {
            using var stream = await file.OpenAsync(FileAccessMode.Read);
            var decoder = await BitmapDecoder.CreateAsync(stream);
            bitmap = await DecodeToWhiteBackgroundAsync(decoder);
        }
        catch (OcrException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new OcrException("OCR_DECODE_FAILED", $"图片解码失败: {ex.Message}");
        }

        try
        {
            var engine = ResolveEngine(language);
            var sw = Stopwatch.StartNew();
            var result = await engine.RecognizeAsync(bitmap);
            sw.Stop();

            var lines = result.Lines
                .Select(line => new OcrLine(
                    line.Text,
                    line.Words
                        .Select(w => new OcrWord(w.Text, w.BoundingRect.X, w.BoundingRect.Y, w.BoundingRect.Width, w.BoundingRect.Height))
                        .ToList()))
                .ToList();

            return new OcrOutcome(result.Text, lines, engine.RecognizerLanguage.LanguageTag, sw.ElapsedMilliseconds);
        }
        finally
        {
            bitmap?.Dispose();
        }
    }

    private static OcrEngine ResolveEngine(string? language)
    {
        if (!string.IsNullOrWhiteSpace(language))
        {
            var tag = language.Trim();
            OcrEngine? engine = null;
            try
            {
                engine = OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language(tag));
            }
            catch
            {
                // 非法 tag 交给下方统一报错
            }
            if (engine is not null) return engine;

            var available = string.Join(", ", OcrEngine.AvailableRecognizerLanguages.Select(l => l.LanguageTag));
            throw new OcrException(
                "OCR_LANG_UNAVAILABLE",
                $"系统未安装 OCR 语言包 {tag}；可用语言：{available}");
        }

        var auto = OcrEngine.TryCreateFromUserProfileLanguages();
        if (auto is not null) return auto;

        var first = OcrEngine.AvailableRecognizerLanguages.FirstOrDefault();
        if (first is not null)
        {
            var fallback = OcrEngine.TryCreateFromLanguage(first);
            if (fallback is not null) return fallback;
        }

        throw new OcrException("OCR_NO_LANGUAGE", "系统未安装任何 OCR 语言包，请在 Windows 设置中添加语言");
    }

    /// <summary>
    /// 解码为 BGRA8 并合成到白底：透明/带 alpha 的截图若直接识别，
    /// 透明区域会被引擎当成黑色，深色文字将不可读。
    /// </summary>
    private static async Task<SoftwareBitmap> DecodeToWhiteBackgroundAsync(BitmapDecoder decoder)
    {
        SoftwareBitmap premultiplied;
        try
        {
            premultiplied = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        }
        catch
        {
            using var raw = await decoder.GetSoftwareBitmapAsync();
            premultiplied = SoftwareBitmap.Convert(raw, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        }

        try
        {
            return FlattenWithWhiteBackground(premultiplied);
        }
        finally
        {
            premultiplied.Dispose();
        }
    }

    private static unsafe SoftwareBitmap FlattenWithWhiteBackground(SoftwareBitmap source)
    {
        var width = source.PixelWidth;
        var height = source.PixelHeight;
        var target = new SoftwareBitmap(BitmapPixelFormat.Bgra8, width, height, BitmapAlphaMode.Premultiplied);

        using var sourceBuffer = source.LockBuffer(BitmapBufferAccessMode.Read);
        using var targetBuffer = target.LockBuffer(BitmapBufferAccessMode.ReadWrite);
        using var sourceRef = sourceBuffer.CreateReference();
        using var targetRef = targetBuffer.CreateReference();

        var src = BitmapPixels.GetBufferPointer(sourceRef, out _);
        var dst = BitmapPixels.GetBufferPointer(targetRef, out _);
        var pixels = width * height;
        for (var i = 0; i < pixels; i++)
        {
            var offset = i * 4;
            var a = src[offset + 3];
            var white = (byte)(255 - a);
            dst[offset + 0] = (byte)Math.Min(255, src[offset + 0] + white);
            dst[offset + 1] = (byte)Math.Min(255, src[offset + 1] + white);
            dst[offset + 2] = (byte)Math.Min(255, src[offset + 2] + white);
            dst[offset + 3] = 255;
        }

        return target;
    }
}
