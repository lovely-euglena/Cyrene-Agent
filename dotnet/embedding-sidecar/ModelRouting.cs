using System.Text;

namespace CyreneEmbedSidecar;

/// <summary>
/// 模型目录/键的路由与推导（纯函数；verify-models 直接断言，不加载模型）。
///
/// 协议口径（与 TS 侧冻结）：
///   - embed / search / doc-import 请求的 modelDir 可选，缺省 = serve 启动目录；
///   - modelKey 优先取显式启动参数，否则从目录名推导（日志 / ready 帧用）。
/// </summary>
public static class ModelRouting
{
    /// <summary>目录规范化：绝对路径 + 去尾分隔符（池键与比较统一口径）。</summary>
    public static string NormalizeModelDir(string modelDir)
    {
        if (string.IsNullOrWhiteSpace(modelDir))
        {
            throw new ArgumentException("modelDir is empty", nameof(modelDir));
        }
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(modelDir));
    }

    /// <summary>请求 modelDir 缺省回退启动目录（null / 空白 = 缺省）。</summary>
    public static string ResolveModelDir(string? requestDir, string defaultDir)
        => string.IsNullOrWhiteSpace(requestDir) ? defaultDir : NormalizeModelDir(requestDir);

    /// <summary>
    /// 从目录名推导 modelKey（无显式启动参数时的兜底）：命中已知模型目录名
    /// 映射时返回宿主注册键（与 TS embedding-pipeline.ts LOCAL_MODELS /
    /// model-status 键一致，避免 ready 键与宿主期望不符触发防御式重启）；
    /// 未知目录回退「末级目录名小写、去掉非字母数字」。
    /// 'bge-m3' → 'bgem3'，'multilingual-e5-small' → 'e5-small'。
    /// TS 侧仍可显式传 serve 第 3 参数覆盖。
    /// </summary>
    public static string DeriveModelKey(string modelDir)
    {
        var name = Path.GetFileName(Path.TrimEndingDirectorySeparator(modelDir));
        switch (name.ToLowerInvariant())
        {
            case "bge-m3":
                return "bgem3";
            case "multilingual-e5-small":
                return "e5-small";
        }

        var sb = new StringBuilder(name.Length);
        foreach (var ch in name)
        {
            if (char.IsAsciiLetterOrDigit(ch)) sb.Append(char.ToLowerInvariant(ch));
        }
        return sb.Length > 0 ? sb.ToString() : "model";
    }
}
