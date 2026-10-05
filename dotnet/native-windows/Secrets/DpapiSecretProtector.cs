using System;
using System.Security.Cryptography;
using System.Text;

namespace CyreneNative.Secrets;

/// <summary>
/// DPAPI（CurrentUser）值保护器——vault 平台实现的 native-windows 留守部分。
/// net10.0-windows 框架自带 ProtectedData；加密绑定当前用户 + 机器，
/// 便携模式换机器解密失败由 vault 层给引导（重录）。
/// </summary>
public sealed class DpapiSecretProtector : ISecretProtector
{
    public string Scheme => "dpapi";

    public bool IsAvailable => OperatingSystem.IsWindows();

    public string Protect(string plain)
    {
        var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.CurrentUser);
        return "dpapi:" + Convert.ToBase64String(bytes);
    }

    public string? Unprotect(string stored)
    {
        if (!stored.StartsWith("dpapi:", StringComparison.Ordinal)) return null;
        try
        {
            var bytes = ProtectedData.Unprotect(
                Convert.FromBase64String(stored["dpapi:".Length..]), null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(bytes);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[secrets] 解密失败（换机器/换用户？）: {ex.Message}");
            return null;
        }
    }
}
