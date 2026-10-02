using System.IO;

namespace CyreneNative.Music;

/// <summary>
/// `cyrene-native --selftest music` 自检：
///   LRC 解析（元信息/多标签/offset/双语/查找）+ 侧车发现 +
///   SQLite 曲库（增量扫描/更新/删除/检索/文件夹统计）。
/// 任一项失败退出码 1；mpv 播放由冒烟脚本单独覆盖（需要音频设备）。
/// </summary>
public static class MusicSelfTest
{
    public static int Run()
    {
        var pass = 0;
        var fail = 0;
        var tempRoot = Directory.CreateTempSubdirectory("cyrene-music-selftest-").FullName;

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
            // ── LRC 解析 ──
            var lrc = LrcParser.Parse(string.Join("\n", new[]
            {
                "[ti:测试歌曲]",
                "[ar:歌手]",
                "[al:专辑]",
                "[offset:500]",
                "[00:01.50]第一行",
                "[00:01.50]Translation",
                "[00:03.00][00:05.00]重复行",
                "非法行忽略",
            }));
            Check("LRC 元信息 ti/ar/al", lrc.Title == "测试歌曲" && lrc.Artist == "歌手" && lrc.Album == "专辑");
            Check("LRC offset", lrc.OffsetMs == 500);
            Check("LRC 双语合并", lrc.Lines.Count > 0 && lrc.Lines[0].Text == "第一行" && lrc.Lines[0].Translation == "Translation");
            Check("LRC 一行多标签展开", lrc.Lines.Count == 3 && lrc.Lines[2].TimeMs == 5000);
            Check("LRC 当前行（应用 offset）", LrcParser.FindLineIndex(lrc.Lines, lrc.OffsetMs, 2100) == 0);
            Check("LRC 当前行（末行）", LrcParser.FindLineIndex(lrc.Lines, lrc.OffsetMs, 5600) == 2);
            Check("LRC 当前行（早于首行）", LrcParser.FindLineIndex(lrc.Lines, lrc.OffsetMs, 100) == -1);

            // ── 侧车歌词发现 ──
            var musicDir = Path.Combine(tempRoot, "Album");
            Directory.CreateDirectory(musicDir);
            var audioPath = Path.Combine(musicDir, "Artist - Title.mp3");
            File.WriteAllText(audioPath, "fake-mp3");
            File.WriteAllText(Path.Combine(musicDir, "Artist - Title.lrc"), "[00:01.00]hi");
            var sidecar = LrcParser.ParseSidecar(audioPath);
            Check("LRC 侧车发现", sidecar is { Lines.Count: 1 } && sidecar.Lines[0].Text == "hi");
            Check("LRC 无侧车返回 null", LrcParser.ParseSidecar(Path.Combine(musicDir, "missing.mp3")) is null);

            // ── 文件名推导 ──
            var (title, artist) = MusicLibrary.DeriveNames(audioPath);
            Check("文件名推导 歌手-标题", title == "Title" && artist == "Artist");
            var (plainTitle, plainArtist) = MusicLibrary.DeriveNames(Path.Combine(musicDir, "just-title.flac"));
            Check("文件名推导 无分隔", plainTitle == "just-title" && plainArtist == "");

            // ── SQLite 曲库 ──
            var dbPath = Path.Combine(tempRoot, "library.db");
            var library = new MusicLibrary(dbPath);
            File.WriteAllText(Path.Combine(musicDir, "plain.flac"), "fake-flac");
            File.WriteAllText(Path.Combine(musicDir, "notes.txt"), "not music");

            var first = library.Scan(new[] { musicDir }, () => false);
            Check("扫描新增 2 首（txt 忽略）", first.Added == 2 && first.Total == 2);

            var second = library.Scan(new[] { musicDir }, () => false);
            Check("重复扫描无变化", second.Added == 0 && second.Updated == 0 && second.Removed == 0);

            var searched = library.Query("Title", null);
            Check("检索命中", searched.Count == 1 && searched[0].Title == "Title" && searched[0].Artist == "Artist");

            var all = library.Query(null, musicDir);
            Check("按目录过滤", all.Count == 2);

            File.AppendAllText(Path.Combine(musicDir, "plain.flac"), "changed");
            var third = library.Scan(new[] { musicDir }, () => false);
            Check("内容变化触发更新", third.Updated == 1 && third.Total == 2);

            File.Delete(Path.Combine(musicDir, "plain.flac"));
            var fourth = library.Scan(new[] { musicDir }, () => false);
            Check("删除文件触发清理", fourth.Removed == 1 && fourth.Total == 1);

            var folders = library.ListFolders();
            Check("文件夹统计", folders.Count == 1 && folders[0].TrackCount == 1);

            Check("取消扫描即时返回", library.Scan(new[] { musicDir }, () => true).Total == 1);

            // 中途取消必须整笔回滚：不把已处理曲目误删、也不写入半成品
            var beforeMidCancel = library.Count();
            var cancelCalls = 0;
            var midCancel = library.Scan(new[] { musicDir }, () => ++cancelCalls > 1);
            Check("扫描中途取消回滚不误删", midCancel.Total == beforeMidCancel && library.Count() == beforeMidCancel);

            // 目录被移除/不再存在：残留曲目应被清理，而不是永久留在库里
            var purged = library.Scan(Array.Empty<string>(), () => false);
            Check("移除目录后清理残留曲目", purged.Removed == 1 && purged.Total == 0 && library.Count() == 0);

            // ── 音频输出设备列表解析 ──
            var parsedDevices = MusicService.ParseAudioDeviceList(
                "List of detected audio devices:\n  'auto' (Autoselect device)\n  'wasapi/{332e5418}' (扬声器 (USB Audio))\n");
            Check("音频设备解析（含描述内括号）", parsedDevices.Count == 2
                && parsedDevices[0].Name == "auto"
                && parsedDevices[1].Name == "wasapi/{332e5418}"
                && parsedDevices[1].Description == "扬声器 (USB Audio)");
        }
        finally
        {
            try
            {
                Directory.Delete(tempRoot, recursive: true);
            }
            catch
            {
                // 清理失败不影响自检结论
            }
        }

        Console.WriteLine($"[selftest music] {pass} passed, {fail} failed");
        return fail == 0 ? 0 : 1;
    }
}
