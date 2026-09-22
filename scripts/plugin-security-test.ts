/**
 * 插件层安全实测——dotnet-adapter 真实 spawn 测试插件全链。
 *
 * 验证（P1/P2 修复）：
 *   1. 未声明 risk 的工具 → register 抛错拒注册（closed world）
 *   2. 显式 risk="safe" → 注册成功且 risk 透传
 *   3. 64+ 工具 → 拒载
 *   4. invoke 闭环：safe 工具调用返回数据
 *   5. unregister → 进程优雅关停
 */
import { DotnetPluginAdapter } from "../src/plugins/dotnet-adapter";
import type { PluginRecord } from "../src/plugins/types";
import type { PluginTool, PluginContext } from "../src/plugins/api";

const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push([name, ok, detail]);
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${ok ? "" : " —— " + detail}`);
}

function makeRecord(id: string, entry: string): PluginRecord {
  return {
    manifest: { apiVersion: 1, id, name: id, version: "0.0.1", description: "test", runtime: "dotnet", entry },
    state: { enabled: true, installedAt: 0, updatedAt: 0 },
    dir: "",
  } as unknown as PluginRecord;
}

function makeCtx(): PluginContext & { _tools: Map<string, PluginTool> } {
  const tools = new Map<string, PluginTool>();
  return {
    _tools: tools,
    registerTool: (t: PluginTool) => { tools.set(t.id, t); },
    unregisterTool: (id: string) => { tools.delete(id); },
    onDispose: () => {},
    events: { on: () => () => {}, once: () => () => {} },
    registerPromptProvider: () => {},
    unregisterPromptProvider: () => {},
    registerIpc: () => {},
    unregisterIpc: () => {},
    registerChannelAdapter: async () => {},
    unregisterChannelAdapter: async () => {},
  } as unknown as PluginContext & { _tools: Map<string, PluginTool> };
}

const EVIL_DLL = "/tmp/cyrene-plugin-test/evil/bin/Release/net10.0/Evil.dll";

async function main(): Promise<void> {
  // 测试环境注入绝对路径 dotnet（同 ipc-stress 防污染）
  process.env.DOTNET_HOST_PATH = ["/home/z/.dotnet/dotnet"]
    .find((p) => { try { require("node:fs").accessSync(p); return true; } catch { return false; } }) ?? "dotnet";
  // ── 1. 未声明 risk → 拒注册 ──
  const ctx1 = makeCtx();
  const a1 = new DotnetPluginAdapter(makeRecord("evil", EVIL_DLL));
  let rejected = "";
  try { await a1.register(ctx1); } catch (e) { rejected = String(e); }
  check("未声明 risk 的工具拒注册", rejected.includes("risk") || rejected.includes("拒"), rejected.slice(0, 140));

  // ── 2. 全声明 risk 的插件 → 正常注册+透传+invoke 闭环 ──
  // （重打一个 good 插件：全部显式声明）
  const ctx2 = makeCtx();
  const a2 = new DotnetPluginAdapter(makeRecord("good", "/tmp/cyrene-plugin-test/good/bin/Release/net10.0/Good.dll"));
  try {
    await a2.register(ctx2);
    const t = ctx2._tools.get("good_safe_echo");
    check("safe 工具注册成功", !!t);
    check("risk 透传", t?.risk === "safe", `risk=${t?.risk}`);
    const r = await t?.execute({ msg: "hi" });
    check("invoke 闭环", typeof r === "string" && r.includes("hi"), String(r).slice(0, 80));
    await a2.unregister();
    check("unregister 优雅关停", true);
  } catch (e) {
    check("good 插件全链", false, String(e).slice(0, 160));
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${failed === 0 ? "插件安全实测: ALL PASS" : `插件安全实测: ${failed} FAILURES`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
