namespace CyreneNative.Storage;

/// <summary>档案协议 → Provider 实例的唯一构造点。</summary>
internal static class StorageProviderFactory
{
    public static IStorageProvider Create(StorageProfile profile) => profile.Protocol switch
    {
        "ftp" or "ftps" => new FtpStorageProvider(profile),
        "sftp" => new SftpStorageProvider(profile),
        "webdav" => new WebDavStorageProvider(profile),
        "s3" => new S3StorageProvider(profile),
        _ => throw new StorageException("STORAGE_PROFILE_ERROR", $"未知协议：{profile.Protocol}"),
    };
}
