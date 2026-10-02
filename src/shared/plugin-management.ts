export type PluginRuntimeStatus =
  | "disabled"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  apiVersion: number;
  /** 双轨运行时：node（进程内加载）/ dotnet（独立子进程 + stdio 协议） */
  runtime: "node" | "dotnet";
  source: "builtin" | "user";
  /** 用户插件来源：market 表示经插件市场安装（宿主安装记录可查），local 表示本地 ZIP 导入 */
  origin?: "local" | "market";
  path: string;
  defaultEnabled: boolean;
  configuredEnabled: boolean;
  enabled: boolean;
  status: PluginRuntimeStatus;
  error?: string;
  hasUnregister: boolean;
  canOpen: boolean;
  /** Icon as a data URL when the plugin provides a valid image file. */
  icon?: string;
  /** 设置面板 HTML 裸文件名；仅已启用且校验通过时透出（渲染端据此挂载 iframe） */
  settingsPanel?: string;
  /** 面板挂载的设置分区；缺省挂「插件」分区 */
  settingsSection?: "channels" | "plugins";
  /** 声明的宿主依赖（如 speech-input = 本地语音输入能力） */
  deps?: string[];
}

export interface PluginScanIssue {
  root: string;
  path?: string;
  source: "builtin" | "user";
  message: string;
}

export interface PluginOverview {
  plugins: PluginListEntry[];
  issues: PluginScanIssue[];
}

/** 插件运行时状态：active=本次运行已启动；persisted=启动时是否自动启用（写入设置）。 */
export interface PluginRuntimeState {
  active: boolean;
  persisted: boolean;
}

/** 插件资源限制生效值（0 = 不限）。 */
export interface PluginResourceLimits {
  storageQuotaMb: number;
  memoryLimitMb: number;
  /** 是否由设置页显式配置（false = 来自环境变量/内置默认） */
  storageQuotaConfigured: boolean;
  memoryLimitConfigured: boolean;
}

/** 写入资源限制的原始值（校验与钳制在主进程，0 = 不限）。 */
export interface PluginResourceLimitsInput {
  storageQuotaMb: number;
  memoryLimitMb: number;
}

/** 插件市场条目（主进程校验 registry 后下发给渲染端的展示数据，不含 zip 地址与哈希） */
export interface MarketPluginEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  downloads: number;
  homepage?: string;
}

/** 可选的市场详情文件；列表索引始终是基础信息来源 */
export interface MarketPluginDetails {
  schemaVersion: 1;
  features: string[];
  requirements: string[];
  setup: string[];
  dataHandling: string[];
  documentationUrl?: string;
}

export type MarketPluginDetailsResult =
  | { ok: true; details: MarketPluginDetails }
  | { ok: false; error: string };

/** 插件市场索引源的健康状态：市场面板据此展示各源（Gitee / GitHub）的实时死活 */
export interface MarketSourceStatus {
  url: string;
  /** 拉取并通过校验 */
  ok: boolean;
  /** 是否为本次列表的实际数据源（按优先级取第一个可用源） */
  used: boolean;
}

export interface MarketListResult {
  ok: boolean;
  error?: string;
  plugins: MarketPluginEntry[];
  /** 各索引源的探测结果；旧版本宿主返回的结果可能没有该字段 */
  sources?: MarketSourceStatus[];
}

export type MarketInstallResult =
  | { ok: true; plugin: { id: string; name: string; version: string }; overview?: PluginOverview }
  | { ok: false; error: string };

export interface PluginManagementApi {
  list(): Promise<PluginOverview | PluginListEntry[]>;
  setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  open(id: string): Promise<{ ok: boolean; error?: string }>;
  rescan(): Promise<PluginOverview>;
  importZip(): Promise<{
    ok: boolean;
    canceled?: boolean;
    error?: string;
    plugin?: { id: string; name: string; version: string };
    overview?: PluginOverview;
  }>;
  uninstall(id: string): Promise<{ ok: boolean; error?: string; overview?: PluginOverview }>;
  marketList(preferred?: string): Promise<MarketListResult>;
  marketDetails(id: string, preferred?: string): Promise<MarketPluginDetailsResult>;
  marketInstall(id: string): Promise<MarketInstallResult>;
  /** 运行时状态（管理页在运行时未启用时也要能打开，见插件运行时管理壳） */
  getRuntimeState(): Promise<PluginRuntimeState>;
  /** 运行期启停；persist=false 时仅本次运行生效，不写回设置 */
  setRuntimeEnabled(enabled: boolean, options?: { persist?: boolean }): Promise<{
    ok: boolean;
    error?: string;
    overview?: PluginOverview;
  }>;
  /** 资源限制生效值（含是否来自设置页配置） */
  getLimits(): Promise<PluginResourceLimits>;
  setLimits(limits: PluginResourceLimitsInput): Promise<{
    ok: boolean;
    error?: string;
    limits?: PluginResourceLimits;
  }>;
}

/**
 * 设置面板桥的渲染端转发 API：pluginId 由设置页宿主脚本按 iframe 归属
 * 填入，不来自面板消息（主进程还会做 sender 窗口校验）。
 */
export interface PluginPanelApi {
  invoke(pluginId: string, channel: string, args: unknown[]): Promise<unknown>;
}
