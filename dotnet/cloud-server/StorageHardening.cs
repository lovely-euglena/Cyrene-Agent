namespace CyreneCloud.Storage;

/// <summary>Linux 上收紧凭据权限（best-effort）：数据目录 0700、DB 0600（-wal/-shm 继承 DB 权限）。</summary>
public static class StorageHardening
{
    public static void TryHarden(string dbPath)
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

            if (File.Exists(dbPath))
            {
                File.SetUnixFileMode(dbPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
        }
        catch
        {
            // best-effort：失败不阻断启动（systemd UMask=0077 / 容器 chmod 已兜底）
        }
    }
}
