using System.Diagnostics;
using System.IO;
using FluentFTP;
using FluentFTP.Exceptions;

namespace CyreneNative.Storage;

/// <summary>FTP / FTPS（explicit / implicit）Provider，基于 FluentFTP。</summary>
internal sealed class FtpStorageProvider : IStorageProvider
{
    private readonly StorageProfile _profile;
    private readonly FtpClient _client;

    public FtpStorageProvider(StorageProfile profile)
    {
        _profile = profile;
        _client = new FtpClient(profile.Host, profile.Username, profile.Password ?? "", profile.Port);
        var cfg = _client.Config;
        cfg.ConnectTimeout = 15_000;
        cfg.ReadTimeout = 30_000;
        cfg.DataConnectionConnectTimeout = 15_000;
        cfg.DataConnectionReadTimeout = 120_000;
        cfg.EncryptionMode = profile.Protocol == "ftps"
            ? (profile.TlsMode == "implicit" ? FtpEncryptionMode.Implicit : FtpEncryptionMode.Explicit)
            : FtpEncryptionMode.None;
        cfg.ValidateAnyCertificate = profile.AllowInvalidCert;
        cfg.DataConnectionType = profile.Passive ? FtpDataConnectionType.AutoPassive : FtpDataConnectionType.AutoActive;
        // 真实文件名可能含 %（如 "100% done.txt"）：关闭 URL 编码拦截；
        // 控制字符（CR/LF/NUL）注入防护保持开启，路径越界由 StoragePaths 侧钳制。
        cfg.SanitizeUrlEncoding = false;
        cfg.SanitizeControlChars = true;
    }

    public bool IsConnected => _client.IsConnected;

    public void Connect()
    {
        if (!_client.IsConnected) _client.Connect();
    }

    public StorageEntry? Stat(string relPath)
    {
        if (relPath.Length == 0) return RootEntry();
        var info = TryObjectInfo(Abs(relPath));
        return info is null ? null : ToEntry(info, relPath);
    }

    public List<StorageEntry> List(string relPath, int maxEntries, out bool truncated)
    {
        var items = _client.GetListing(Abs(relPath), FtpListOption.Auto);
        var entries = new List<StorageEntry>(Math.Min(items.Length, maxEntries));
        truncated = false;
        foreach (var item in items)
        {
            if (item.Name is "." or "..") continue;
            if (entries.Count >= maxEntries) { truncated = true; break; }
            entries.Add(ToEntry(item, StoragePaths.ToRelative(_profile.RootPath, item.FullName ?? "")));
        }
        return entries;
    }

    public Stream OpenRead(string relPath) => _client.OpenRead(Abs(relPath), FtpDataType.Binary);

    public void Put(string relPath, Stream source, long length, bool createParents)
    {
        var abs = Abs(relPath);
        if (createParents)
        {
            var parent = ParentOf(abs);
            if (parent.Length > 1 && !_client.DirectoryExists(parent)) _client.CreateDirectory(parent, true);
        }
        _client.UploadStream(source, abs, FtpRemoteExists.Overwrite, createRemoteDir: createParents);
    }

    public void Download(string relPath, Stream destination)
        => _client.DownloadStream(destination, Abs(relPath));

    public void Delete(string relPath, bool recursive)
    {
        var abs = Abs(relPath);
        var info = TryObjectInfo(abs) ?? throw StorageException.NotFound($"远端不存在：{relPath}");
        if (info.Type == FtpObjectType.Directory)
        {
            if (!recursive) EnsureDirEmpty(abs, relPath);
            _client.DeleteDirectory(abs, FtpListOption.Recursive);
        }
        else
        {
            _client.DeleteFile(abs);
        }
    }

    public void Mkdir(string relPath, bool recursive)
    {
        if (relPath.Length == 0) return;
        _client.CreateDirectory(Abs(relPath), force: recursive);
    }

    public void Move(string fromRel, string toRel, bool overwrite)
    {
        if (overwrite) DeleteIfExists(toRel);
        try
        {
            _client.Rename(Abs(fromRel), Abs(toRel));
        }
        catch (Exception ex)
        {
            // 部分服务器 RENAME 受限：复制 + 删除兜底
            var mapped = StorageErrors.Map(ex);
            if (mapped.Code is not ("STORAGE_IO_ERROR" or "STORAGE_UNSUPPORTED")) throw;
            CopyTree(fromRel, toRel);
            Delete(fromRel, recursive: true);
        }
    }

    public void Copy(string fromRel, string toRel, bool overwrite)
    {
        if (overwrite) DeleteIfExists(toRel);
        CopyTree(fromRel, toRel);
    }

    /// <summary>文件/目录递归复制（目录逐层建、文件走本地临时文件中转）。</summary>
    private void CopyTree(string fromRel, string toRel)
    {
        var entry = Stat(fromRel) ?? throw StorageException.NotFound($"远端不存在：{fromRel}");
        if (entry.Type == "dir")
        {
            Mkdir(toRel, recursive: true);
            foreach (var child in List(fromRel, 10_000, out _))
            {
                CopyTree(child.Path, JoinRel(toRel, child.Name));
            }
            return;
        }

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

    private static string JoinRel(string parent, string name)
        => parent.Length == 0 ? name : parent + "/" + name;

    public long Test()
    {
        var sw = Stopwatch.StartNew();
        Connect();
        _client.GetListing(Abs(""), FtpListOption.NoPath);
        sw.Stop();
        return sw.ElapsedMilliseconds;
    }

    public void Dispose()
    {
        try { _client.Dispose(); } catch { /* 已断开 */ }
    }

    // ── 内部 ───────────────────────────────────────────────

    private string Abs(string rel) => StoragePaths.CombinePosix(_profile.RootPath, rel);

    private static string ParentOf(string abs)
    {
        var idx = abs.LastIndexOf('/');
        return idx <= 0 ? "/" : abs[..idx];
    }

    private static StorageEntry RootEntry() => new() { Name = "", Path = "", Type = "dir" };

    private FtpListItem? TryObjectInfo(string abs)
    {
        try
        {
            return _client.GetObjectInfo(abs);
        }
        catch (FtpCommandException ex) when (ex.CompletionCode == "550")
        {
            return null;
        }
    }

    private void DeleteIfExists(string relPath)
    {
        if (TryObjectInfo(Abs(relPath)) is null) return;
        Delete(relPath, recursive: true);
    }

    private void EnsureDirEmpty(string abs, string relPath)
    {
        var hasChildren = _client.GetListing(abs, FtpListOption.Auto)
            .Any(i => i.Name is not ("." or ".."));
        if (hasChildren) throw StorageException.Io($"目录非空（需要 recursive=true）：{relPath}");
    }

    private StorageEntry ToEntry(FtpListItem item, string rel)
    {
        var type = item.Type switch
        {
            FtpObjectType.Directory => "dir",
            FtpObjectType.Link => "link",
            _ => "file",
        };
        return new StorageEntry
        {
            Name = item.Name ?? "",
            Path = rel,
            Type = type,
            Size = type == "file" ? item.Size : null,
            ModifiedAt = item.Modified == DateTime.MinValue ? null : item.Modified.ToString("O"),
        };
    }
}
