using System;
using System.Collections.Generic;
using CyreneNative.Secrets;

namespace CyreneNative.Secrets;

/// <summary>
/// SecretVault → cyrene-core ISecretProvider 桥（llm-host 注入点）。
/// llm-host 只读共享 vault（设计拍板 #3）；Put/Delete 仅服务端自测用。
/// </summary>
public sealed class VaultSecretProvider : ISecretProvider
{
    private readonly SecretVault _vault;

    public VaultSecretProvider(SecretVault vault) => _vault = vault;

    public bool IsAvailable => _vault.ProtectorAvailable;

    public string? Get(string name)
    {
        try { return _vault.Get(name); }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[llm-host] secret.get 失败: {ex.Message}");
            return null;
        }
    }

    public void Put(string name, string value) => _vault.Put(name, value);

    public bool Delete(string name) => _vault.Delete(name);

    public IReadOnlyList<SecretEntryInfo> List() => _vault.List();
}
