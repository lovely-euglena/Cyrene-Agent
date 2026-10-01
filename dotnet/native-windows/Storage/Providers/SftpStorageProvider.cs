using System.Diagnostics;
using System.IO;
using Renci.SshNet;
using Renci.SshNet.Common;
using Renci.SshNet.Sftp;

namespace CyreneNative.Storage;

/// <summary>SFTP Provider（SSH.NET SftpClient）。密码/私钥认证与 --ssh-host 同源。</summary>
internal sealed class SftpStorageProvider : IStorageProvider
{
    private readonly StorageProfile _profile;
    private SftpClient? _client;

    public SftpStorageProvider(StorageProfile profile)
    {
        _profile = profile;
    }

    public bool IsConnected => _client?.IsConnected == true;

    public void Connect()
    {
        if (_client?.IsConnected == true) return;

        var methods = new List<AuthenticationMethod>();
        if (_profile.AuthType == "privateKey" && !string.IsNullOrWhiteSpace(_profile.PrivateKeyPath))
        {
            var key = string.IsNullOrEmpty(_profile.Passphrase)
                ? new PrivateKeyFile(_profile.PrivateKeyPath)
                : new PrivateKeyFile(_profile.PrivateKeyPath, _profile.Passphrase);
            methods.Add(new PrivateKeyAuthenticationMethod(_profile.Username, key));
        }
        else
        {
            methods.Add(new PasswordAuthenticationMethod(_profile.Username, _profile.Password ?? ""));
        }

        var info = new ConnectionInfo(_profile.Host, _profile.Port, _profile.Username, methods.ToArray())
        {
            Timeout = TimeSpan.FromSeconds(20),
        };
        _client?.Dispose();
        _client = new SftpClient(info)
        {
            KeepAliveInterval = TimeSpan.FromSeconds(15),
        };
        _client.Connect();
    }

    /// <summary>
    /// 注意：存在性判断一律走「父目录列表」（而非 GetAttributes/Exists）。
    /// 部分 S3 网关型 SFTP（如 Rains3）对不存在的路径也返回属性，GetAttributes 不可信。
    /// </summary>
    public StorageEntry? Stat(string relPath)
    {
        if (relPath.Length == 0) return RootEntry();
        var match = FindEntry(Abs(relPath));
        return match is null ? null : ToEntry(match);
    }

    public List<StorageEntry> List(string relPath, int maxEntries, out bool truncated)
    {
        var entries = new List<StorageEntry>(maxEntries);
        truncated = false;
        foreach (var file in Client.ListDirectory(Abs(relPath)))
        {
            if (file.Name is "." or "..") continue;
            if (entries.Count >= maxEntries) { truncated = true; break; }
            entries.Add(ToEntry(file));
        }
        return entries;
    }

    public Stream OpenRead(string relPath) => Client.OpenRead(Abs(relPath));

    public void Put(string relPath, Stream source, long length, bool createParents)
    {
        var abs = Abs(relPath);
        if (createParents) EnsureDir(ParentOf(abs));
        Client.UploadFile(source, abs, canOverride: true);
    }

    public void Download(string relPath, Stream destination)
        => Client.DownloadFile(Abs(relPath), destination);

    public void Delete(string relPath, bool recursive)
    {
        var entry = Stat(relPath) ?? throw StorageException.NotFound($"远端不存在：{relPath}");
        var abs = Abs(relPath);
        if (entry.Type == "dir")
        {
            if (!recursive)
            {
                var hasChildren = Client.ListDirectory(abs).Any(f => f.Name is not ("." or ".."));
                if (hasChildren) throw StorageException.Io($"目录非空（需要 recursive=true）：{relPath}");
            }
            DeleteDirRecursive(abs);
        }
        else
        {
            Client.DeleteFile(abs);
        }
    }

    public void Mkdir(string relPath, bool recursive)
    {
        if (relPath.Length == 0) return;
        var abs = Abs(relPath);
        if (recursive) EnsureDir(abs);
        else Client.CreateDirectory(abs);
    }

    public void Move(string fromRel, string toRel, bool overwrite)
    {
        if (overwrite) DeleteIfExists(toRel);
        try
        {
            Client.RenameFile(Abs(fromRel), Abs(toRel));
        }
        catch (Exception ex)
        {
            // 部分 S3 网关型 SFTP（如 Rains3）不支持 SSH_FXP_RENAME：复制 + 删除兜底
            var mapped = StorageErrors.Map(ex);
            if (mapped.Code is not ("STORAGE_IO_ERROR" or "STORAGE_UNSUPPORTED")) throw;
            Copy(fromRel, toRel, overwrite: true);
            Delete(fromRel, recursive: true);
        }
    }

    public void Copy(string fromRel, string toRel, bool overwrite)
    {
        if (overwrite) DeleteIfExists(toRel);
        var tmp = Path.GetTempFileName();
        try
        {
            using (var fs = File.Create(tmp)) Download(fromRel, fs);
            using var rs = File.OpenRead(tmp);
            Put(toRel, rs, rs.Length, createParents: true);
        }
        finally
        {
            try { File.Delete(tmp); } catch { /* 尽力清理 */ }
        }
    }

    public long Test()
    {
        var sw = Stopwatch.StartNew();
        Connect();
        Client.ListDirectory(Abs("")).FirstOrDefault();
        sw.Stop();
        return sw.ElapsedMilliseconds;
    }

    public void Dispose()
    {
        try { _client?.Dispose(); } catch { /* 已断开 */ }
        _client = null;
    }

    // ── 内部 ───────────────────────────────────────────────

    private SftpClient Client => _client ?? throw StorageException.Io("SFTP 会话尚未建立");

    private string Abs(string rel) => StoragePaths.CombinePosix(_profile.RootPath, rel);

    private static string LastSegment(string abs)
    {
        var trimmed = abs.TrimEnd('/');
        var idx = trimmed.LastIndexOf('/');
        return idx < 0 ? trimmed : trimmed[(idx + 1)..];
    }

    private static string ParentOf(string abs)
    {
        var idx = abs.TrimEnd('/').LastIndexOf('/');
        return idx <= 0 ? "/" : abs.TrimEnd('/')[..idx];
    }

    private static StorageEntry RootEntry() => new() { Name = "", Path = "", Type = "dir" };

    private StorageEntry ToEntry(ISftpFile file) => new()
    {
        Name = file.Name,
        Path = StoragePaths.ToRelative(_profile.RootPath, file.FullName),
        Type = file.IsDirectory ? "dir" : (file.IsSymbolicLink ? "link" : "file"),
        Size = file.IsDirectory ? null : file.Length,
        ModifiedAt = file.LastWriteTimeUtc == default
            ? null
            : file.LastWriteTimeUtc.ToUniversalTime().ToString("O"),
    };

    /// <summary>在父目录列表里找目标条目（存在性判断的唯一可信来源）。</summary>
    private ISftpFile? FindEntry(string abs)
    {
        var parent = ParentOf(abs);
        var name = LastSegment(abs);
        try
        {
            foreach (var file in Client.ListDirectory(parent))
            {
                if (file.Name == name) return file;
            }
        }
        catch (SftpPathNotFoundException)
        {
            return null;
        }
        return null;
    }

    private bool DirExists(string abs) => FindEntry(abs)?.IsDirectory == true;

    private void EnsureDir(string abs)
    {
        if (abs.Length <= 1) return;
        var parts = abs.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        var current = "";
        foreach (var part in parts)
        {
            current += "/" + part;
            if (!DirExists(current)) Client.CreateDirectory(current);
        }
    }

    private void DeleteDirRecursive(string abs)
    {
        foreach (var file in Client.ListDirectory(abs))
        {
            if (file.Name is "." or "..") continue;
            if (file.IsDirectory) DeleteDirRecursive(file.FullName);
            else Client.DeleteFile(file.FullName);
        }
        Client.DeleteDirectory(abs);
    }

    private void DeleteIfExists(string relPath)
    {
        if (Stat(relPath) is null) return;
        Delete(relPath, recursive: true);
    }
}
