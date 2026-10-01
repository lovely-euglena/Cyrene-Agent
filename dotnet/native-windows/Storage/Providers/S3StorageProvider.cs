using System.IO;
using System.Net;
using Amazon;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;

namespace CyreneNative.Storage;

/// <summary>
/// S3 / S3 兼容对象存储 Provider（AWSSDK.S3）。
/// 自定义 endpoint + path style 覆盖 MinIO / Cloudflare R2 / B2 等；目录是前缀语义，
/// mkdir 落一个尾斜杠空对象做标记，删除目录 = 前缀批量删除。
///
/// 注意：AWSSDK v4 是 async-only API（同步方法已移除），本 Provider 在宿主
/// Task.Run 线程上同步等待（无 SynchronizationContext，不存在死锁风险）。
/// </summary>
internal sealed class S3StorageProvider : IStorageProvider
{
    private const long MaxInlineCopy = 8 * 1024 * 1024;
    private const int DeleteBatch = 1000;

    private readonly StorageProfile _profile;
    private readonly IAmazonS3 _client;
    private readonly string _prefix;
    private bool _connected;

    public S3StorageProvider(StorageProfile profile)
    {
        _profile = profile;
        _prefix = StoragePaths.NormalizeS3Prefix(profile.RootPath);
        var cfg = new AmazonS3Config
        {
            ForcePathStyle = profile.PathStyle,
            Timeout = TimeSpan.FromMinutes(10),
            ConnectTimeout = TimeSpan.FromSeconds(15),
        };
        if (!string.IsNullOrWhiteSpace(profile.Endpoint))
        {
            var endpoint = profile.Endpoint.TrimEnd('/');
            if (!endpoint.StartsWith("http", StringComparison.OrdinalIgnoreCase)) endpoint = "https://" + endpoint;
            cfg.ServiceURL = endpoint;
            if (!string.IsNullOrWhiteSpace(profile.Region)) cfg.AuthenticationRegion = profile.Region;
        }
        else
        {
            try
            {
                var region = string.IsNullOrWhiteSpace(profile.Region) ? "us-east-1" : profile.Region;
                cfg.RegionEndpoint = RegionEndpoint.GetBySystemName(region);
            }
            catch (Exception ex)
            {
                throw new StorageException("STORAGE_PROFILE_ERROR", $"无效 region：{profile.Region}（{ex.Message}）");
            }
        }
        _client = new AmazonS3Client(
            new BasicAWSCredentials(profile.AccessKeyId ?? "", profile.SecretAccessKey ?? ""),
            cfg);
    }

    public bool IsConnected => _connected;

    public void Connect()
    {
        Test();
    }

    public StorageEntry? Stat(string relPath)
    {
        if (relPath.Length == 0) return new StorageEntry { Name = "", Path = "", Type = "dir" };
        var key = Key(relPath);
        var meta = TryGetMetadata(key);
        if (meta is not null)
        {
            if (key.EndsWith('/'))
                return new StorageEntry { Name = LastSegment(key), Path = relPath, Type = "dir" };
            return new StorageEntry
            {
                Name = LastSegment(key),
                Path = relPath,
                Type = "file",
                Size = meta.ContentLength,
                ModifiedAt = meta.LastModified?.ToUniversalTime().ToString("O"),
            };
        }
        if (HasPrefix(key + "/"))
            return new StorageEntry { Name = LastSegment(key), Path = relPath, Type = "dir" };
        return null;
    }

    public List<StorageEntry> List(string relPath, int maxEntries, out bool truncated)
    {
        var prefix = PrefixFor(relPath);
        var entries = new List<StorageEntry>(Math.Min(maxEntries, 256));
        truncated = false;
        string? token = null;
        while (true)
        {
            var resp = ListV2(new ListObjectsV2Request
            {
                BucketName = _profile.Bucket,
                Prefix = prefix,
                Delimiter = "/",
                MaxKeys = 1000,
                ContinuationToken = token,
            });
            foreach (var common in resp.CommonPrefixes ?? new List<string>())
            {
                var dirKey = common.TrimEnd('/');
                if (dirKey.Length == 0 || dirKey == prefix.TrimEnd('/')) continue;
                if (entries.Count >= maxEntries) { truncated = true; return entries; }
                entries.Add(new StorageEntry { Name = LastSegment(dirKey), Path = JoinRel(relPath, LastSegment(dirKey)), Type = "dir" });
            }
            foreach (var obj in resp.S3Objects ?? new List<S3Object>())
            {
                if (obj.Key == prefix || obj.Key.EndsWith('/')) continue; // 目录标记
                if (entries.Count >= maxEntries) { truncated = true; return entries; }
                entries.Add(new StorageEntry
                {
                    Name = LastSegment(obj.Key),
                    Path = JoinRel(relPath, LastSegment(obj.Key)),
                    Type = "file",
                    Size = obj.Size,
                    ModifiedAt = obj.LastModified?.ToUniversalTime().ToString("O"),
                });
            }
            if (resp.IsTruncated != true) return entries;
            token = resp.NextContinuationToken;
            if (string.IsNullOrEmpty(token)) return entries;
        }
    }

    public Stream OpenRead(string relPath)
    {
        using var resp = Get(new GetObjectRequest
        {
            BucketName = _profile.Bucket,
            Key = Key(relPath),
        });
        var buffer = new MemoryStream();
        resp.ResponseStream.CopyTo(buffer, 64 * 1024);
        if (buffer.Length > MaxInlineCopy)
            throw StorageException.Unsupported("对象超过内联读取上限，请用 cloud_download 下载到本地");
        buffer.Position = 0;
        return buffer;
    }

    public void Put(string relPath, Stream source, long length, bool createParents)
    {
        var request = new PutObjectRequest
        {
            BucketName = _profile.Bucket,
            Key = Key(relPath),
            InputStream = source,
            AutoCloseStream = false,
        };
        if (length >= 0) request.Headers.ContentLength = length;
        PutObject(request);
    }

    public void Download(string relPath, Stream destination)
    {
        using var resp = Get(new GetObjectRequest
        {
            BucketName = _profile.Bucket,
            Key = Key(relPath),
        });
        resp.ResponseStream.CopyTo(destination, 64 * 1024);
    }

    public void Delete(string relPath, bool recursive)
    {
        if (relPath.Length == 0) throw StorageException.Invalid("不能删除档案根目录");
        var key = Key(relPath);
        var entry = Stat(relPath) ?? throw StorageException.NotFound($"远端不存在：{relPath}");
        if (entry.Type != "dir")
        {
            DeleteObject(new DeleteObjectRequest { BucketName = _profile.Bucket, Key = key });
            return;
        }

        var prefix = key + "/";
        if (!recursive)
        {
            var probe = ListV2(new ListObjectsV2Request
            {
                BucketName = _profile.Bucket,
                Prefix = prefix,
                MaxKeys = 1,
            });
            if ((probe.S3Objects?.Count ?? 0) > 0)
                throw StorageException.Io($"目录非空（需要 recursive=true）：{relPath}");
        }

        var keys = ListAllKeys(prefix);
        if (ObjectExists(key)) keys.Add(key); // 目录标记对象
        DeleteKeys(keys);
    }

    public void Mkdir(string relPath, bool recursive)
    {
        if (relPath.Length == 0) return;
        // 前缀语义：recursive 无差异；落一个尾斜杠空对象便于其他客户端看到目录
        var request = new PutObjectRequest
        {
            BucketName = _profile.Bucket,
            Key = Key(relPath) + "/",
            InputStream = new MemoryStream(),
            AutoCloseStream = false,
        };
        request.Headers.ContentLength = 0;
        PutObject(request);
    }

    public void Move(string fromRel, string toRel, bool overwrite)
    {
        Copy(fromRel, toRel, overwrite);
        Delete(fromRel, recursive: true);
    }

    public void Copy(string fromRel, string toRel, bool overwrite)
    {
        var entry = Stat(fromRel) ?? throw StorageException.NotFound($"远端不存在：{fromRel}");
        var fromKey = Key(fromRel);
        var toKey = Key(toRel);
        if (entry.Type != "dir")
        {
            CopyObjectKey(fromKey, toKey);
            return;
        }

        if (fromKey.Length == 0) throw StorageException.Invalid("不能复制档案根目录");
        var fromPrefix = fromKey + "/";
        var toPrefix = toKey.Length == 0 ? "" : toKey + "/";
        var keys = ListAllKeys(fromPrefix);
        if (ObjectExists(fromKey)) keys.Add(fromKey); // 目录标记本身
        foreach (var sourceKey in keys)
        {
            var suffix = sourceKey == fromKey ? "" : sourceKey[fromPrefix.Length..];
            CopyObjectKey(sourceKey, toPrefix + suffix);
        }
    }

    public long Test()
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        ListV2(new ListObjectsV2Request
        {
            BucketName = _profile.Bucket,
            Prefix = PrefixFor(""),
            MaxKeys = 1,
        });
        _connected = true;
        sw.Stop();
        return sw.ElapsedMilliseconds;
    }

    public void Dispose() => _client.Dispose();

    // ── AWSSDK v4 async-only → 宿主线程同步等待 ───────────────

    private ListObjectsV2Response ListV2(ListObjectsV2Request request)
        => _client.ListObjectsV2Async(request).GetAwaiter().GetResult();

    private GetObjectMetadataResponse GetMetadata(GetObjectMetadataRequest request)
        => _client.GetObjectMetadataAsync(request).GetAwaiter().GetResult();

    private GetObjectResponse Get(GetObjectRequest request)
        => _client.GetObjectAsync(request).GetAwaiter().GetResult();

    private void PutObject(PutObjectRequest request)
        => _client.PutObjectAsync(request).GetAwaiter().GetResult();

    private void DeleteObject(DeleteObjectRequest request)
        => _client.DeleteObjectAsync(request).GetAwaiter().GetResult();

    private void DeleteObjects(DeleteObjectsRequest request)
        => _client.DeleteObjectsAsync(request).GetAwaiter().GetResult();

    private void CopyObject(CopyObjectRequest request)
        => _client.CopyObjectAsync(request).GetAwaiter().GetResult();

    // ── 内部 ───────────────────────────────────────────────

    private string Key(string rel) => StoragePaths.CombineS3(_prefix, rel);

    private string PrefixFor(string rel)
    {
        var key = Key(rel);
        return key.Length == 0 ? "" : key + "/";
    }

    private GetObjectMetadataResponse? TryGetMetadata(string key)
    {
        try
        {
            return GetMetadata(new GetObjectMetadataRequest
            {
                BucketName = _profile.Bucket,
                Key = key,
            });
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    private bool HasPrefix(string prefix)
    {
        var resp = ListV2(new ListObjectsV2Request
        {
            BucketName = _profile.Bucket,
            Prefix = prefix,
            MaxKeys = 1,
        });
        return (resp.S3Objects?.Count ?? 0) > 0 || (resp.CommonPrefixes?.Count ?? 0) > 0;
    }

    private bool ObjectExists(string key) => TryGetMetadata(key) is not null;

    private List<string> ListAllKeys(string prefix)
    {
        var keys = new List<string>();
        string? token = null;
        while (true)
        {
            var resp = ListV2(new ListObjectsV2Request
            {
                BucketName = _profile.Bucket,
                Prefix = prefix,
                ContinuationToken = token,
            });
            foreach (var obj in resp.S3Objects ?? new List<S3Object>()) keys.Add(obj.Key);
            if (resp.IsTruncated != true) break;
            token = resp.NextContinuationToken;
            if (string.IsNullOrEmpty(token)) break;
        }
        return keys;
    }

    private void DeleteKeys(List<string> keys)
    {
        for (var i = 0; i < keys.Count; i += DeleteBatch)
        {
            var batch = keys.Skip(i).Take(DeleteBatch).Select(k => new KeyVersion { Key = k }).ToList();
            try
            {
                DeleteObjects(new DeleteObjectsRequest
                {
                    BucketName = _profile.Bucket,
                    Objects = batch,
                    Quiet = true,
                });
            }
            catch (Exception)
            {
                // 部分 S3 兼容服务（Rains3/Ceph 系）对多对象删除挑剔（如强制 Content-MD5）：
                // 逐个删除兜底；单个删除也失败时抛出真实错误
                foreach (var key in batch)
                {
                    DeleteObject(new DeleteObjectRequest { BucketName = _profile.Bucket, Key = key.Key });
                }
            }
        }
    }

    private void CopyObjectKey(string sourceKey, string destKey)
    {
        CopyObject(new CopyObjectRequest
        {
            SourceBucket = _profile.Bucket,
            SourceKey = sourceKey,
            DestinationBucket = _profile.Bucket,
            DestinationKey = destKey,
        });
    }

    private static string LastSegment(string key)
    {
        var trimmed = key.TrimEnd('/');
        var idx = trimmed.LastIndexOf('/');
        return idx < 0 ? trimmed : trimmed[(idx + 1)..];
    }

    private static string JoinRel(string parent, string name)
        => parent.Length == 0 ? name : parent + "/" + name;
}
