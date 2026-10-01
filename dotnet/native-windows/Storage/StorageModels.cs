using System.Text.Json.Serialization;

namespace CyreneNative.Storage;

/// <summary>
/// 云存储档案（内存形态，含解密后的秘密）。落盘 DTO 见 StorageProfileRecord。
/// 协议：ftp / ftps / sftp / webdav / s3，字段按协议取用。
/// </summary>
internal sealed class StorageProfile
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>ftp | ftps | sftp | webdav | s3（空 = sftp）</summary>
    public string Protocol { get; set; } = "";

    // ── 通用连接 ───────────────────────────────────────────
    public string Host { get; set; } = "";
    public int Port { get; set; }
    public string Username { get; set; } = "";
    /// <summary>root|path 前缀：所有工具路径相对它解析，且钳制不逃逸。</summary>
    public string RootPath { get; set; } = "/";

    // ── ftps / tls ────────────────────────────────────────
    /// <summary>explicit | implicit（仅 ftps；空 = explicit）</summary>
    public string TlsMode { get; set; } = "";
    public bool AllowInvalidCert { get; set; }
    /// <summary>FTP 被动模式（默认）；false = 主动模式</summary>
    public bool Passive { get; set; } = true;

    // ── sftp ──────────────────────────────────────────────
    /// <summary>password | privateKey（空 = password）</summary>
    public string AuthType { get; set; } = "";
    public string? PrivateKeyPath { get; set; }

    // ── webdav ────────────────────────────────────────────
    public string BaseUrl { get; set; } = "";
    /// <summary>basic | digest | none（HttpClientHandler 自然协商；空 = basic）</summary>
    public string WebDavAuthType { get; set; } = "";

    // ── s3 ────────────────────────────────────────────────
    public string Bucket { get; set; } = "";
    /// <summary>空 = AWS 官方；自定义 endpoint 覆盖 MinIO/R2/B2 等</summary>
    public string Endpoint { get; set; } = "";
    public string Region { get; set; } = "";
    public bool PathStyle { get; set; }

    // ── 秘密（只在内存/请求里出现，落盘一律 *Enc）────────────
    public string? Password { get; set; }
    public string? Passphrase { get; set; }
    public string? AccessKeyId { get; set; }
    public string? SecretAccessKey { get; set; }
    public string? SessionToken { get; set; }

    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
}

/// <summary>落盘 DTO：敏感字段只写 *Enc 形态；兼容手编明文（读取后不写回）。</summary>
internal sealed class StorageProfileRecord
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Protocol { get; set; } = "sftp";
    public string Host { get; set; } = "";
    public int Port { get; set; }
    public string Username { get; set; } = "";
    public string RootPath { get; set; } = "/";
    public string TlsMode { get; set; } = "explicit";
    public bool AllowInvalidCert { get; set; }
    public bool Passive { get; set; } = true;
    public string AuthType { get; set; } = "password";
    public string? PrivateKeyPath { get; set; }
    public string BaseUrl { get; set; } = "";
    public string WebDavAuthType { get; set; } = "basic";
    public string Bucket { get; set; } = "";
    public string Endpoint { get; set; } = "";
    public string Region { get; set; } = "";
    public bool PathStyle { get; set; }

    public string? PasswordEnc { get; set; }
    public string? PassphraseEnc { get; set; }
    public string? AccessKeyIdEnc { get; set; }
    public string? SecretAccessKeyEnc { get; set; }
    public string? SessionTokenEnc { get; set; }

    public string? Password { get; set; }
    public string? Passphrase { get; set; }
    public string? AccessKeyId { get; set; }
    public string? SecretAccessKey { get; set; }
    public string? SessionToken { get; set; }

    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
}

/// <summary>列目录/stat 的统一条目；Path 相对档案根（与工具入参同坐标系）。</summary>
internal sealed class StorageEntry
{
    public string Name { get; set; } = "";
    public string Path { get; set; } = "";
    /// <summary>dir | file | link</summary>
    public string Type { get; set; } = "file";
    public long? Size { get; set; }
    public string? ModifiedAt { get; set; }
}
