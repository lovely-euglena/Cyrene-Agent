using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using Amazon.S3;
using Renci.SshNet.Common;
using FtpExceptions = FluentFTP.Exceptions;

namespace CyreneNative.Storage;

/// <summary>
/// 云存储统一异常：errorCode 供宿主帧与 TS 工具结构化错误透传。
/// 错误码清单见 docs/design/2026-10-02-cloud-storage-tool-design.md §7。
/// </summary>
internal sealed class StorageException : Exception
{
    public string Code { get; }
    public bool Retryable { get; }

    public StorageException(string code, string message, bool retryable = false, Exception? inner = null)
        : base(message, inner)
    {
        Code = code;
        Retryable = retryable;
    }

    /// <summary>连接类故障（供会话管理层决定丢会话懒重连）。</summary>
    public bool ConnectionLost => Code is "STORAGE_CONNECT_FAILED" or "STORAGE_TIMEOUT";

    public static StorageException Invalid(string message)
        => new("STORAGE_PATH_INVALID", message);

    public static StorageException NotFound(string message)
        => new("STORAGE_NOT_FOUND", message);

    public static StorageException AlreadyExists(string message)
        => new("STORAGE_ALREADY_EXISTS", message);

    public static StorageException Unsupported(string message)
        => new("STORAGE_UNSUPPORTED", message);

    public static StorageException Io(string message, Exception? inner = null)
        => new("STORAGE_IO_ERROR", message, false, inner);
}

/// <summary>各协议库异常 → 统一 StorageException 的唯一映射点。</summary>
internal static class StorageErrors
{
    public static StorageException Map(Exception ex)
    {
        if (ex is StorageException se) return se;

        switch (ex)
        {
            // ── SSH.NET（SFTP）────────────────────────────────
            case SshAuthenticationException:
                return new StorageException("STORAGE_AUTH_FAILED", $"认证失败：{ex.Message}");
            case SftpPermissionDeniedException:
                return new StorageException("STORAGE_AUTH_FAILED", $"权限不足：{ex.Message}");
            case SshConnectionException:
                return new StorageException("STORAGE_CONNECT_FAILED", $"连接中断：{ex.Message}", true, ex);
            case SftpPathNotFoundException:
                return new StorageException("STORAGE_NOT_FOUND", ex.Message);

            // ── FluentFTP（FTP/FTPS）──────────────────────────
            case FtpExceptions.FtpAuthenticationException:
                return new StorageException("STORAGE_AUTH_FAILED", $"认证失败：{ex.Message}");
            case FtpExceptions.FtpCommandException fce:
                // 550 覆盖 not found / no such file；具体以服务器文字为准
                if (fce.CompletionCode == "550")
                    return new StorageException("STORAGE_NOT_FOUND", fce.Message);
                if (fce.CompletionCode is "530" or "532")
                    return new StorageException("STORAGE_AUTH_FAILED", fce.Message);
                return new StorageException("STORAGE_IO_ERROR", fce.Message, false, ex);

            // ── AWSSDK（S3）───────────────────────────────────
            case AmazonS3Exception s3ex:
                return s3ex.StatusCode switch
                {
                    HttpStatusCode.NotFound => new StorageException("STORAGE_NOT_FOUND", s3ex.Message),
                    HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized =>
                        new StorageException("STORAGE_AUTH_FAILED", s3ex.Message),
                    HttpStatusCode.Conflict => new StorageException("STORAGE_ALREADY_EXISTS", s3ex.Message),
                    _ => new StorageException("STORAGE_IO_ERROR", s3ex.Message, false, ex),
                };

            // ── 网络/IO 通用 ───────────────────────────────────
            case TimeoutException:
                return new StorageException("STORAGE_TIMEOUT", $"操作超时：{ex.Message}", true, ex);
            case TaskCanceledException or OperationCanceledException:
                return new StorageException("STORAGE_TIMEOUT", "操作被取消", true, ex);
            case SocketException:
                return new StorageException("STORAGE_CONNECT_FAILED", $"网络不可达：{ex.Message}", true, ex);
            case HttpRequestException hre:
                return new StorageException("STORAGE_CONNECT_FAILED", $"请求失败：{hre.Message}", true, ex);
            case UnauthorizedAccessException:
                return new StorageException("STORAGE_AUTH_FAILED", ex.Message);
            case FileNotFoundException:
                return new StorageException("STORAGE_NOT_FOUND", ex.Message);
            case DirectoryNotFoundException:
                return new StorageException("STORAGE_NOT_FOUND", ex.Message);
            case IOException:
                return new StorageException("STORAGE_IO_ERROR", ex.Message, false, ex);
            case InvalidOperationException:
                return new StorageException("STORAGE_IO_ERROR", ex.Message, false, ex);
            default:
                return new StorageException("STORAGE_IO_ERROR", ex.Message, false, ex);
        }
    }
}
