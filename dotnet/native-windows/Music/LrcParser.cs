using System.IO;
using System.Text.RegularExpressions;

namespace CyreneNative;

/// <summary>
/// LRC 歌词解析（纯函数，供 MusicService 与 verify-music 自检复用）。
///
/// 支持：
///   - 时间标签 [mm:ss.xx] / [mm:ss.xxx] / [mm:ss:xx]，一行多标签展开；
///   - 元信息 [ti:] [ar:] [al:] [by:] 与 [offset:]（毫秒整体偏移，可为负）；
///   - 同时间戳多行 = 主行 + 翻译行（合并为 Translation，显示时分两行）；
///   - 非法行忽略不抛。
/// </summary>
public static class LrcParser
{
    public sealed record LrcLine(long TimeMs, string Text, string? Translation);

    public sealed record LrcDocument(
        string? Title,
        string? Artist,
        string? Album,
        long OffsetMs,
        List<LrcLine> Lines);

    private static readonly Regex TimeTagRe = new(
        @"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]",
        RegexOptions.Compiled);

    private static readonly Regex MetaRe = new(
        @"^\[(ti|ar|al|by|offset):(.*)\]$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static LrcDocument Parse(string content)
    {
        var rawLines = new List<(long TimeMs, string Text)>();
        string? title = null, artist = null, album = null;
        long offsetMs = 0;

        foreach (var raw in content.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0) continue;

            var meta = MetaRe.Match(line);
            if (meta.Success)
            {
                var key = meta.Groups[1].Value.ToLowerInvariant();
                var value = meta.Groups[2].Value.Trim();
                switch (key)
                {
                    case "ti": title = value.Length > 0 ? value : title; break;
                    case "ar": artist = value.Length > 0 ? value : artist; break;
                    case "al": album = value.Length > 0 ? value : album; break;
                    case "offset" when long.TryParse(value, out var parsedOffset): offsetMs = parsedOffset; break;
                }
                continue;
            }

            var matches = TimeTagRe.Matches(line);
            if (matches.Count == 0) continue;
            var text = TimeTagRe.Replace(line, "").Trim();
            foreach (Match match in matches)
            {
                var minutes = long.Parse(match.Groups[1].Value);
                var seconds = long.Parse(match.Groups[2].Value);
                var fraction = match.Groups[3].Value;
                long fractionMs = fraction.Length switch
                {
                    1 => long.Parse(fraction) * 100,
                    2 => long.Parse(fraction) * 10,
                    3 => long.Parse(fraction),
                    _ => 0,
                };
                rawLines.Add((minutes * 60_000 + seconds * 1000 + fractionMs, text));
            }
        }

        var lines = new List<LrcLine>();
        foreach (var group in rawLines.GroupBy(entry => entry.TimeMs).OrderBy(group => group.Key))
        {
            var texts = group.Select(entry => entry.Text).ToList();
            var primary = texts.FirstOrDefault(text => text.Length > 0) ?? "";
            var secondary = texts.Skip(1).FirstOrDefault(text => text.Length > 0);
            lines.Add(new LrcLine(group.Key, primary, secondary));
        }

        return new LrcDocument(title, artist, album, offsetMs, lines);
    }

    /// <summary>读取侧车歌词（同名 .lrc，大小写不敏感）；不存在或读取失败返回 null。</summary>
    public static LrcDocument? ParseSidecar(string audioPath)
    {
        try
        {
            var directory = Path.GetDirectoryName(audioPath);
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory)) return null;
            var baseName = Path.GetFileNameWithoutExtension(audioPath);
            var lrcPath = Directory
                .EnumerateFiles(directory, baseName + ".lrc", SearchOption.TopDirectoryOnly)
                .FirstOrDefault();
            if (lrcPath is null) return null;
            return Parse(File.ReadAllText(lrcPath));
        }
        catch
        {
            return null;
        }
    }

    /// <summary>二分查找当前行下标（应用 offset；无匹配返回 -1）。</summary>
    public static int FindLineIndex(IReadOnlyList<LrcLine> lines, long offsetMs, long positionMs)
    {
        var target = positionMs - offsetMs;
        var low = 0;
        var high = lines.Count - 1;
        var result = -1;
        while (low <= high)
        {
            var mid = (low + high) / 2;
            if (lines[mid].TimeMs <= target)
            {
                result = mid;
                low = mid + 1;
            }
            else
            {
                high = mid - 1;
            }
        }
        return result;
    }
}
