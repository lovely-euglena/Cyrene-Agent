/**
 * 内置工具 .NET 轨路由（阶段 1 D：fs/git 下沉接线）。
 *
 * 包装策略（A2：同进程直接调用的宿主版，经 native-tool-host 帧协议）：
 *   register 时把白名单工具的 execute 包一层——
 *     CYRENE_TOOL_HOST=1 且 host 可用 → 发 fs_ 与 git 工具 调用给 ToolHost；
 *     任何失败（超时/崩溃/E_*）→ 回调原 TS execute（零行为差异）。
 *   白名单只收「已在 C# 侧完成语义对齐移植」的工具（FsGitTools.cs），
 *   白名单外工具不经包装——避免未移植工具走了半吊子路径。
 */
import type { ToolDefinition } from "./registry/tool-registry";
import { nativeToolHost } from "./native-tool-host";
import { resolveDotnetConfig } from "../../dotnet-backend/config";

/** C# 侧已完成语义移植的工具（FsGitTools.cs 对照表）。 */
const NATIVE_TOOL_MAP: Record<string, string> = {
  read_file: "fs_read_file",
  write_file: "fs_write_file",
  list_dir: "fs_list_dir",
};

export function wrapToolForNativeHost(tool: ToolDefinition): ToolDefinition {
  const nativeTool = NATIVE_TOOL_MAP[tool.id];
  if (!nativeTool || !resolveDotnetConfig().toolHost) return tool;
  const tsExecute = tool.execute.bind(tool);
  const wrapped: ToolDefinition = {
    ...tool,
    execute: async (args, ctx) => {
      try {
        const result = await nativeToolHost.call(nativeTool, args as Record<string, unknown>);
        if (typeof result === "string") return result;
        return JSON.stringify(result);
      } catch (error) {
        console.warn("[NativeToolRouter]", tool.id, "native 轨失败回退 TS:", error instanceof Error ? error.message : error);
        return tsExecute(args, ctx);
      }
    },
  };
  return wrapped;
}
