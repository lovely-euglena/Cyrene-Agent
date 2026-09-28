// MCP Adapter — 将 MCP server 的工具发现和调用适配到 ToolRegistry
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolDefinition, toolRegistry, type ToolEffectKind } from "./tools/registry/tool-registry";
import type { ToolRiskLevel } from "../permission";
import { mcpDotnetHost } from "./mcp-dotnet-host";

const LOG_PREFIX = "[MCP Adapter]";

export interface McpServerConfig {
  id: string;              // 唯一标识
  name: string;            // 展示名
  transport: "stdio" | "sse";
  command?: string;         // stdio 必填,sse 不用
  args?: string[];         // 命令行参数
  env?: Record<string, string>;
  cwd?: string;
  url?: string;            // sse 必填,stdio 不用
  /** 按 toolName 显式覆盖 effectKind（serverId + toolName 作为 key） */
  effectKindOverrides?: Record<string, ToolEffectKind>;
}

/** MCP Tool annotations（MCP 协议 2025-03-26 版） */
interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  [key: string]: unknown;
}

interface McpServerState {
  config: McpServerConfig;
  client?: Client;         // TS 直连轨专用
  transport?: Transport;   // TS 直连轨专用
  /** .NET 桥宿主轨专用：连接由 cyrene-native --mcp-host 管理 */
  viaDotnet?: boolean;
  connected: boolean;
  toolIds: string[];       // 已注册到 ToolRegistry 的工具 ID 列表
}

/**
 * 从 MCP Tool annotations 推导 effectKind。
 *
 * 优先级（保守策略）：
 * 1. 本地显式 override（最高优先级）
 * 2. destructiveHint=true → external_side_effect（第三方 annotations 矛盾时采用保守策略）
 * 3. readOnlyHint=true → read
 * 4. 无匹配 → unknown（会被 ExecutionPolicyGuard 拒绝）
 *
 * 注意：destructiveHint=false 不等于 readOnlyHint=true。
 * 第三方 annotations 同时设置 readOnlyHint + destructiveHint 时，destructive 优先（不放行）。
 */
function resolveMcpEffectKind(
  annotations: McpToolAnnotations | undefined,
  overrides: Record<string, ToolEffectKind> | undefined,
  toolName: string,
): ToolEffectKind {
  // 优先级 1：本地显式 override
  if (overrides && overrides[toolName]) {
    return overrides[toolName];
  }
  if (!annotations) return "unknown";
  // 优先级 2：destructiveHint=true（保守策略，不放行）
  if (annotations.destructiveHint === true) return "external_side_effect";
  // 优先级 3：readOnlyHint=true
  if (annotations.readOnlyHint === true) return "read";
  // 优先级 4：无匹配 → unknown
  return "unknown";
}

/**
 * 从 MCP annotations / effectKind override 推导权限风险级（保守策略）：
 * 1. 本地显式 override：按效果映射（read → fs-read；unknown → undeclared；其余 → fs-write）
 * 2. destructiveHint=true → fs-write（只读档拒绝、每次审批档询问）
 * 3. readOnlyHint=true → fs-read（与 fs-read 工具同档：只读/指定目录档放行）
 * 4. 无匹配 → undeclared（缺省不得当成 safe；只读/指定目录档拒绝、每次审批档询问）
 */
export function resolveMcpRisk(
  annotations: McpToolAnnotations | undefined,
  overrides: Record<string, ToolEffectKind> | undefined,
  toolName: string,
): ToolRiskLevel {
  const override = overrides?.[toolName];
  if (override) {
    if (override === "read") return "fs-read";
    if (override === "unknown") return "undeclared";
    return "fs-write";
  }
  if (!annotations) return "undeclared";
  if (annotations.destructiveHint === true) return "fs-write";
  if (annotations.readOnlyHint === true) return "fs-read";
  return "undeclared";
}

/**
 * 连接一个 MCP server，发现其工具并注册到 ToolRegistry。
 * 返回注册的工具 ID 列表。
 */
export async function connectMcpServer(config: McpServerConfig): Promise<string[]> {
  console.log(LOG_PREFIX, "连接 MCP server:", config.name, "(" + config.id + ")");

  // 首选 .NET 桥宿主轨：连接管理/重连/超时/进程树清理全部下沉到
  // cyrene-native（host 不可用时回退 TS 直连，行为同旧版）
  if (await mcpDotnetHost.ensureStarted()) {
    return connectMcpServerViaDotnet(config);
  }

  let transport: Transport;
  if (config.transport === "sse") {
    if (!config.url) {
      throw new Error("sse transport requires url");
    }
    transport = new SSEClientTransport(new URL(config.url));
  } else {
    if (!config.command) {
      throw new Error("stdio transport requires command");
    }
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    });
  }

  // 监听 transport 错误
  transport.onerror = (err: Error) => {
    console.error(LOG_PREFIX, "transport 错误 [" + config.name + "]:", err.message);
  };
  // transport 关闭（server 进程退出/SSE 断开）：立即卸载工具注册，
  // 否则模型仍会看到失效工具，调用全部报错（僵尸工具）。
  transport.onclose = () => {
    const st = mcpServerStates.get(config.id);
    if (!st || st.viaDotnet) return;
    console.warn(LOG_PREFIX, "transport 关闭，卸载工具:", config.name);
    for (const toolId of st.toolIds) {
      toolRegistry.unregister(toolId);
    }
    st.toolIds = [];
    st.connected = false;
    // 保留 state 记录（connected=false），管理页可见断连状态而非凭空消失
  };

  const client = new Client(
    { name: "cyrene", version: "0.8.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    console.log(LOG_PREFIX, "已连接到", config.name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "连接失败 [" + config.name + "]:", msg);
    // 连接失败时清理 transport
    try { await transport.close(); } catch (_) { /* ignore */ }
    throw err;
  }

  // 发现工具
  let mcpTools: Array<{
    name: string;
    description?: string;
    annotations?: McpToolAnnotations;
    inputSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  }> = [];

  try {
    const result = await client.listTools();
    mcpTools = result.tools as Array<{
      name: string;
      description?: string;
      annotations?: McpToolAnnotations;
      inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
      };
    }>;
    console.log(LOG_PREFIX, "发现 " + mcpTools.length + " 个工具:", mcpTools.map(t => t.name).join(", "));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "listTools 失败 [" + config.name + "]:", msg);
    await client.close();
    throw err;
  }

  // 注册到 ToolRegistry
  const registeredIds: string[] = [];
  for (const mt of mcpTools) {
    // 用短横线拼接，不用冒号——Kimi 等厂商 function.name 正则不允许冒号
    // （Kimi: ^[a-zA-Z_][a-zA-Z0-9-_]$）。短横线所有厂商都接受。
    const toolId = config.id + "-" + mt.name;

    // 如果已存在同名工具，跳过
    if (toolRegistry.getById(toolId)) {
      console.warn(LOG_PREFIX, "工具已存在，跳过:", toolId);
      continue;
    }

    // 从 annotations 或 override 解析 effectKind
    const resolvedEffectKind = resolveMcpEffectKind(mt.annotations, config.effectKindOverrides, mt.name);
    if (resolvedEffectKind === "unknown") {
      console.warn(LOG_PREFIX, `工具 ${toolId} 的 effectKind 为 unknown（无 annotations 且无 override），将被 ExecutionPolicyGuard 拒绝`);
    }

    const toolDef: ToolDefinition = {
      id: toolId,
      name: "[" + config.name + "] " + mt.name,
      description: mt.description || mt.name,
      enabled: true,
      risk: resolveMcpRisk(mt.annotations, config.effectKindOverrides, mt.name),
      effectKind: resolvedEffectKind,
      inputSchema: {
        type: "object",
        properties: mt.inputSchema?.properties as Record<string, { type: string; description: string }> || {},
        required: mt.inputSchema?.required,
      },
      // TODO: 未来若 MCP 工具需要 ToolContext，在此将 ctx 映射为 MCP 协议 arguments 的隐藏字段。
      // 当前 MCP 工具 execute 签名不带 ctx，按需接入时改签名为 (args, ctx?) 并在这里处理。
      execute: async (args: Record<string, unknown>) => {
        console.log(LOG_PREFIX, "调用工具:", toolId, JSON.stringify(args));
        try {
          const result = await client.callTool({
            name: mt.name,
            arguments: args,
          });
          // 提取文本内容
          const texts: string[] = [];
          if (result.content && Array.isArray(result.content)) {
            for (const block of result.content) {
              if (block && typeof block === "object" && (block as { type: string }).type === "text") {
                texts.push(String((block as { text: string }).text));
              }
            }
          }
          const output = texts.join("\n") || JSON.stringify(result.content);
          if (result.isError === true) {
            throw new Error(`E_MCP_TOOL_FAILED${output ? `: ${output}` : ""}`);
          }
          console.log(LOG_PREFIX, "工具返回 [" + toolId + "]:", output.slice(0, 200));
          return output;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(LOG_PREFIX, "工具调用失败 [" + toolId + "]:", msg);
          if (msg.startsWith("E_MCP_TOOL_FAILED")) throw err;
          throw new Error(`E_MCP_TOOL_FAILED: ${msg}`);
        }
      },
    };

    toolRegistry.register(toolDef);
    registeredIds.push(toolId);
    console.log(LOG_PREFIX, "已注册工具:", toolId);
  }

  // 保存状态
  const state: McpServerState = {
    config,
    client,
    transport,
    connected: true,
    toolIds: registeredIds,
  };
  mcpServerStates.set(config.id, state);

  console.log(LOG_PREFIX, "MCP server 就绪:", config.name, "(" + registeredIds.length + " 个工具)");
  return registeredIds;
}

/**
 * 断开并清理一个 MCP server 及其注册的工具。
 */
export async function disconnectMcpServer(serverId: string): Promise<boolean> {
  console.log(LOG_PREFIX, "断开 MCP server:", serverId);
  const state = mcpServerStates.get(serverId);
  if (!state) {
    console.warn(LOG_PREFIX, "未找到 MCP server:", serverId);
    return false;
  }

  // 从 ToolRegistry 移除工具
  for (const toolId of state.toolIds) {
    toolRegistry.unregister(toolId);
    console.log(LOG_PREFIX, "已移除工具:", toolId);
  }

  if (state.viaDotnet) {
    // .NET 轨：断开由 host 管理（级联清理 MCP server 进程树）
    await mcpDotnetHost.disconnectServer(serverId);
    mcpServerStates.delete(serverId);
    return true;
  }

  try {
    await state.client!.close();
    console.log(LOG_PREFIX, "已断开:", serverId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "client.close 失败 [" + serverId + "]:", msg);
    // 即使 client.close 失败，也尝试关闭 transport
    try { await state.transport?.close(); } catch (_) { /* ignore */ }
  }

  state.connected = false;
  mcpServerStates.delete(serverId);
  return true;
}

/**
 * 获取所有已连接的 MCP server 状态。
 */
export function getMcpServerStates(): Array<{
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
  toolIds: string[];
}> {
  return Array.from(mcpServerStates.values()).map(s => ({
    id: s.config.id,
    name: s.config.name,
    connected: s.connected,
    toolCount: s.toolIds.length,
    toolIds: [...s.toolIds],
  }));
}

// ── .NET 桥宿主轨 ──────────────────────────────────────────────

interface DotnetToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations?: Record<string, unknown>;
}

/** 桥事件监听只挂一次（host 是单例，重复挂会重复注册工具） */
let dotnetListenersBound = false;

function bindDotnetListeners(): void {
  if (dotnetListenersBound) return;
  dotnetListenersBound = true;
  // 重连成功/tools 变化：刷新该 server 的工具注册（先卸旧再挂新）
  mcpDotnetHost.onToolsChanged((serverId, tools) => {
    const state = mcpServerStates.get(serverId);
    if (!state?.viaDotnet) return;
    console.log(LOG_PREFIX, "[dotnet] 工具表更新:", serverId, tools.length, "个");
    unregisterServerTools(serverId);
    registerDotnetTools(serverId, state.config, tools as DotnetToolDescriptor[]);
    state.toolIds = tools.map((t) => `${serverId}-${t.name}`);
    state.connected = true;
  });
  // 断连/重连中：卸载工具（模型不会再看到失效工具）
  mcpDotnetHost.onStateChanged((serverId, st, error) => {
    const state = mcpServerStates.get(serverId);
    if (!state?.viaDotnet) return;
    console.log(LOG_PREFIX, "[dotnet] 状态:", serverId, st, error ?? "");
    if (st === "disconnected") {
      unregisterServerTools(serverId);
      state.toolIds = [];
      state.connected = false;
    } else if (st === "reconnecting") {
      unregisterServerTools(serverId);
      state.toolIds = [];
      state.connected = false;
    }
    // connected：等 tools 帧刷新（onToolsChanged 处理）
  });
}

function unregisterServerTools(serverId: string): void {
  const state = mcpServerStates.get(serverId);
  if (!state) return;
  for (const toolId of state.toolIds) {
    toolRegistry.unregister(toolId);
  }
}

/** 把 host 发现的工具按宿主规范注册（effectKind 解析同 TS 直连轨）。 */
function registerDotnetTools(serverId: string, config: McpServerConfig, tools: DotnetToolDescriptor[]): string[] {
  const registeredIds: string[] = [];
  for (const mt of tools) {
    const toolId = serverId + "-" + mt.name;
    if (toolRegistry.getById(toolId)) {
      console.warn(LOG_PREFIX, "工具已存在，跳过:", toolId);
      continue;
    }
    const resolvedEffectKind = resolveMcpEffectKind(
      mt.annotations as McpToolAnnotations | undefined,
      config.effectKindOverrides,
      mt.name,
    );
    if (resolvedEffectKind === "unknown") {
      console.warn(LOG_PREFIX, `工具 ${toolId} 的 effectKind 为 unknown，将被 ExecutionPolicyGuard 拒绝`);
    }
    toolRegistry.register({
      id: toolId,
      name: "[" + config.name + "] " + mt.name,
      description: mt.description || mt.name,
      enabled: true,
      risk: resolveMcpRisk(
        mt.annotations as McpToolAnnotations | undefined,
        config.effectKindOverrides,
        mt.name,
      ),
      effectKind: resolvedEffectKind,
      inputSchema: {
        type: "object",
        properties: (mt.inputSchema?.properties as Record<string, { type: string; description: string }>) || {},
        required: mt.inputSchema?.required,
      },
      execute: async (args: Record<string, unknown>) => {
        console.log(LOG_PREFIX, "[dotnet] 调用:", toolId);
        try {
          const raw = await mcpDotnetHost.callTool(serverId, mt.name, args);
          const result = (raw ?? {}) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
          const texts: string[] = [];
          if (Array.isArray(result.content)) {
            for (const block of result.content) {
              if (block && typeof block === "object" && block.type === "text") {
                texts.push(String(block.text));
              }
            }
          }
          const output = texts.join("\n") || JSON.stringify(result.content);
          if (result.isError === true) {
            throw new Error(`E_MCP_TOOL_FAILED${output ? `: ${output}` : ""}`);
          }
          return output;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(LOG_PREFIX, "[dotnet] 工具调用失败 [" + toolId + "]:", msg);
          if (msg.startsWith("E_MCP_TOOL_FAILED")) throw err;
          throw new Error(`E_MCP_TOOL_FAILED: ${msg}`);
        }
      },
    });
    registeredIds.push(toolId);
    console.log(LOG_PREFIX, "已注册工具:", toolId);
  }
  return registeredIds;
}

async function connectMcpServerViaDotnet(config: McpServerConfig): Promise<string[]> {
  bindDotnetListeners();
  const tools = await mcpDotnetHost.connectServer(config.id, {
    transport: config.transport,
    command: config.command,
    args: config.args,
    env: config.env,
    url: config.url,
  });
  const registeredIds = registerDotnetTools(config.id, config, tools);
  mcpServerStates.set(config.id, {
    config,
    viaDotnet: true,
    connected: true,
    toolIds: registeredIds,
  });
  console.log(LOG_PREFIX, "[dotnet] MCP server 就绪:", config.name, "(" + registeredIds.length + " 个工具)");
  return registeredIds;
}

// 内部状态存储
const mcpServerStates = new Map<string, McpServerState>();



