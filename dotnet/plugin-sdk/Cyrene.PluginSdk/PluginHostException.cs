namespace Cyrene.PluginSdk;

/// <summary>
/// 宿主服务返回的稳定错误（code 与 Node 轨 <c>E_*</c> 一致）。
/// 插件只应依赖 <see cref="Code"/> 做分支处理，不要匹配 message 文案。
/// </summary>
public sealed class PluginHostException : Exception
{
    /// <summary>稳定错误码，如 E_CAPABILITY_UNAVAILABLE / E_INVALID_ARGUMENT。</summary>
    public string Code { get; }

    /// <summary>构造宿主错误（一般由 SDK 在解析 reply 帧时创建，插件无需自行构造）。</summary>
    public PluginHostException(string code, string message) : base(message)
    {
        Code = code;
    }
}
