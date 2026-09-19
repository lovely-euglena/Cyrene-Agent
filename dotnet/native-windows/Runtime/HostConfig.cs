using System.IO;
using System.Text.Json;

namespace CyreneNative.Runtime;

/// <summary>
/// 便携模式路径解析（阶段 9 L；L1/L2/L3 统一解析器）。
///
/// 规则（与 TS 侧 dotnet-backend/config.ts 同语义，双端一致）：
///   1. CYRENE_PORTABLE=1：data = exe 同级 ./data（不可写直接报错——
///      L8 不静默回退）；config = ./config（--data/--config 可覆盖 L17）
///   2. 常规模式：data = %APPDATA%/cyrene
///   3. 铁律（B10/L6）：不写注册表、不写系统目录；日志进 ./data/logs（L7）
/// 所有 host（tool/rag/voice/agent/loop/memory）数据落点统一从
/// DataRoot 派生（L3）——禁止各 host 自拼路径。
/// </summary>
public sealed class HostConfig
{
    public string DataRoot { get; }
    public string ConfigRoot { get; }
    public bool Portable { get; }

    private HostConfig(string dataRoot, string configRoot, bool portable)
    {
        DataRoot = dataRoot; ConfigRoot = configRoot; Portable = portable;
    }

    public static bool IsPortableEnabled()
    {
        var env = Environment.GetEnvironmentVariable("CYRENE_PORTABLE");
        return env is "1" or "true" or "on";
    }

    /// <summary>argv 里找 --data/--config 覆盖（L17 命令行优先）。</summary>
    public static HostConfig Load(string[] args)
    {
        var portable = IsPortableEnabled();
        var exeDir = AppContext.BaseDirectory;
        string? argData = null, argConfig = null;
        for (var i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == "--data") argData = args[i + 1];
            if (args[i] == "--config") argConfig = args[i + 1];
        }

        if (portable)
        {
            var data = argData ?? Path.Combine(exeDir, "data");
            var cfg = argConfig ?? Path.Combine(exeDir, "config");
            try
            {
                Directory.CreateDirectory(data);   // 可写性即权限探测
                Directory.CreateDirectory(cfg);
            }
            catch (UnauthorizedAccessException ex)
            {
                // L8：便携模式下不可写 = 明确失败，不静默改道系统目录
                throw new InvalidOperationException($"便携模式数据目录不可写: {data}（{ex.Message}）");
            }
            return new HostConfig(data, cfg, true);
        }

        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var normalData = argData ?? Path.Combine(appData, "cyrene");
        Directory.CreateDirectory(normalData);
        return new HostConfig(normalData, argConfig ?? Path.Combine(normalData, "config"), false);
    }

    /// <summary>各 host 数据落点（L3/L5）：rag/memory/voice/loop 统一派生。</summary>
    public string HostData(string hostName) => Path.Combine(DataRoot, hostName);
    public string LogsDir => Path.Combine(DataRoot, "logs");
    public string DbPath(string hostName, string file) => Path.Combine(HostData(hostName), file);
}
