using System.Collections.Generic;

namespace CyreneNative.Secrets;

/// <summary>
/// 密钥提供抽象（服务器版依赖倒置口子，llm-host 只读共享 vault）。
///
/// 桌面版：cyrene-native 注入 DPAPI（CurrentUser）实现（DpapiSecretProvider，
/// vault 落 data-dir，文件格式见 native-windows/Secrets/SecretVault.cs）；
/// 冒烟壳/服务端：注入各自的实现（明文测试保护器 / 服务端密钥管理）。
/// cyrene-core 只见此接口——DPAPI 等平台能力不进核心库（洁净闸）。
/// </summary>
public interface ISecretProvider
{
    /// <summary>取密钥；不存在或不可用返回 null（调用方据此报 E_LLM_HOST_AUTH_MISSING）。</summary>
    string? Get(string name);

    /// <summary>写入/覆盖密钥（DPAPI 加密落盘，原子写）。</summary>
    void Put(string name, string value);

    /// <summary>删除密钥；返回是否确有删除。</summary>
    bool Delete(string name);

    /// <summary>列条目：只有 key 名与时间戳，绝不含 value（验收用例 3）。</summary>
    IReadOnlyList<SecretEntryInfo> List();

    /// <summary>保护器是否可用（DPAPI 异常 / vault 文件不可写时为 false）。</summary>
    bool IsAvailable { get; }
}

/// <summary>密钥条目元信息（无 value）。</summary>
public sealed record SecretEntryInfo(string Name, string CreatedAt, string UpdatedAt);
