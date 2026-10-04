using System.Runtime.InteropServices;

namespace CyreneCloud.Storage;

/// <summary>
/// Linux 上收紧凭据权限（best-effort），三层兜底：
/// ① 进程 umask 0077——任何新建文件（含 SQLite 的 -wal/-shm）自创建即 0600；
/// ② 数据目录 0700——须在首次打开 DB 之前调用；
/// ③ DB 及 -wal/-shm 附属文件 0600——须在 Initialize（首次连接）之后调用。
/// </summary>
public static class StorageHardening
{
    [DllImport("libc", SetLastError = true)]
    private static extern uint umask(uint mask);

    /// <summary>进程级 umask 0077：越早调用越好（须在创建数据目录 / 打开 DB 之前）。</summary>
    public static void EnforceProcessUmask()
    {
        if (!OperatingSystem.IsLinux()) return;
        try
        {
            umask(63); // 八进制 0077：属主 rwx、其余全无
        }
        catch
        {
            // best-effort：失败不阻断启动（systemd UMask=0077 / 容器 chmod 已兜底）
        }
    }

    /// <summary>数据目录 0700——须在首次打开 DB 之前调用。</summary>
    public static void TryHardenDirectory(string dbPath)
    {
        if (!OperatingSystem.IsLinux()) return;
        try
        {
            var dir = Path.GetDirectoryName(dbPath);
            if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
            {
                File.SetUnixFileMode(dir,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
        }
        catch
        {
            // best-effort：失败不阻断启动（systemd UMask=0077 / 容器 chmod 已兜底）
        }
    }

    /// <summary>DB 及其 -wal/-shm 附属文件 0600——须在 Initialize（首次连接）之后调用。</summary>
    public static void TryHardenFiles(string dbPath)
    {
        if (!OperatingSystem.IsLinux()) return;
        try
        {
            foreach (var suffix in new[] { "", "-wal", "-shm" })
            {
                var path = dbPath + suffix;
                if (File.Exists(path))
                {
                    File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                }
            }
        }
        catch
        {
            // best-effort：失败不阻断启动（systemd UMask=0077 / 容器 chmod 已兜底）
        }
    }
}
