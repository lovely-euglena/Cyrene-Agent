/**
 * 密钥 keyring（Phase 1 / A2+A4）。
 *
 * 职责：
 *  - vault key 命名（唯一事实源）：model:provider:<provider> / model:profile:<id> /
 *    vision / tts:<field> / asr:<field>；
 *  - 启动编排 initSecretsVault()：拉起宿主 → 迁移明文（import → 回读校验 →
 *    .bak → 源清空，幂等）→ 标记 migrated → hydrate keyring；
 *  - 同步取用：getSecret() 供 model-settings / general-settings 加载路径填 key；
 *  - 掩码：maskModelSettingsForUi / maskGeneralSettingsForUi（A3，设置页只回掩码）。
 *
 * host 缺失策略（设计 §8 用例 4/5 + PR19 复审 P1-1/P2-6）：迁移前回退明文
 * （告警一次）；迁移后/已 hydrate 后宿主缺失 → 密钥事实源仍在 vault：掩码照常
 * （vaultAuthoritative），保存仅对「含非空 key 或 SENTINEL」的 patch 硬失败
 * （E_SECRETS_HOST_LOST，不写明文、不清盘），非 key patch 正常持久化且落盘 key
 * 槽逐槽取磁盘原值；migrated 状态在宿主缺失时读盘上 secrets-vault.json 的
 * migratedAt 明文标记判定。
 */
import fs from "node:fs";
import path from "node:path";
import { resolveDotnetConfig } from "../dotnet-backend/config";
import { activeSecretsClient, secretsDataDir } from "../dotnet-backend/secrets-client";
import { renamedProvider } from "./provider-renames";

// ── vault key 命名 ──

export function vaultKeyForProvider(provider: string): string {
  return `model:provider:${provider}`;
}
export function vaultKeyForProfile(profileId: string): string {
  return `model:profile:${profileId}`;
}
export const VAULT_KEY_VISION = "vision";
export function vaultKeyForTtsField(field: string): string {
  return `tts:${field}`;
}
export function vaultKeyForAsrField(field: string): string {
  return `asr:${field}`;
}

/** UI 显式清 key 的哨兵（JSON IPC 不丢 undefined 的替代）。 */
export const SECRET_CLEAR_SENTINEL = "__CYRENE_CLEAR_KEY__";

// ── keyring 状态 ──

const keyring = new Map<string, string>();
let hydrated = false;
let vaultMigrated = false;
let warnedFallback = false;

export function isVaultMode(): boolean {
  try {
    return resolveDotnetConfig().secretsHost;
  } catch {
    return false;
  }
}

/**
 * vault 可写（PR19 复审 P1-1）：配置开 ∧ keyring 已 hydrate ∧ 宿主存活。
 * 仅此状态允许新 key 写入 vault、以及把内存真值清盘痕（strip 清空）。
 */
export function isVaultWritable(): boolean {
  return isVaultMode() && hydrated && isSecretsHostAlive();
}

/**
 * 密钥事实源在 vault（PR19 复审 P1-1）：配置开 ∧（已 hydrate ∨ 已迁移 ∨ 盘上
 * migratedAt 标记）。掩码与保存分类共用此判据——hydrated 后宿主猝死（迁移未发生）
 * 时事实源仍是 vault（keyring 内存真值），既不能明文写盘，也不能空串覆盖丢钥。
 */
export function isVaultAuthoritative(): boolean {
  return isVaultMode() && (hydrated || vaultMigrated || readVaultMigratedMarker());
}

/**
 * 保存时是否把「空/缺失 key」按「不改」保内存旧值（PR19 复审 P1-1）：
 * vault 模式开但不可写（未 hydrate 的明文回退态 / 已 hydrate 后宿主猝死态）。
 * 两种状态下渲染端都可能回传陈旧掩码空串，需在内存合并前回填旧值。
 */
export function shouldPreservePlaintextKeys(): boolean {
  return isVaultMode() && !isVaultWritable();
}

/** hydrate 完成回调（复审 P0-6：先建的 settings 缓存原地回填用；避免循环 import）。 */
const hydratedListeners: Array<() => void> = [];
export function onKeyringHydrated(cb: () => void): void {
  if (hydrated) cb();
  else hydratedListeners.push(cb);
}

export function isKeyringHydrated(): boolean {
  return hydrated;
}

export function isVaultMigrated(): boolean {
  return vaultMigrated;
}

/**
 * 迁移标记磁盘读取（IKJNX1 #1）：宿主缺失时无法经 status() 拿 migrated，改读
 * <data-dir>/secrets-vault.json 的明文 migratedAt（.NET SecretVault.cs 明示该
 * 字段是「host 缺失策略依据」）。文件缺失 / 解析失败 / 非 string → false（按未迁移）。
 */
function readVaultMigratedMarker(): boolean {
  try {
    const p = path.join(secretsDataDir(), "secrets-vault.json");
    if (!fs.existsSync(p)) return false;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { migratedAt?: unknown };
    return typeof raw.migratedAt === "string" && raw.migratedAt !== "";
  } catch {
    return false;
  }
}

/** 宿主存活判定（同步；测试桩可无 isAlive——缺省视为存活，保持兼容）。 */
function isSecretsHostAlive(): boolean {
  const c = activeSecretsClient() as { isAlive?: () => boolean };
  return typeof c.isAlive === "function" ? c.isAlive() : true;
}

const SECRETS_HOST_LOST_MESSAGE =
  "E_SECRETS_HOST_LOST: 密钥已迁移至 vault，但宿主不可用——保存已拒绝（不写明文、不清盘）。请检查 cyrene-native 安装后重试。";

type VaultSaveRoute = "plaintext" | "vault" | "readonly";

/** key 值判定：非空 string 或显式清除 SENTINEL。 */
function isSecretValue(value: unknown): boolean {
  return value === SECRET_CLEAR_SENTINEL || (typeof value === "string" && value.trim() !== "");
}

/** incoming 是否携带非空 key / SENTINEL（model 四类槽位：顶层 / perProvider / 档案 / vision）。 */
function modelIncomingHasSecret(incoming: Record<string, unknown>): boolean {
  if (isSecretValue(incoming.apiKey)) return true;
  const per = incoming.perProvider as Record<string, Record<string, unknown>> | undefined;
  if (per && typeof per === "object") {
    for (const entry of Object.values(per)) {
      if (entry && typeof entry === "object" && isSecretValue(entry.apiKey)) return true;
    }
  }
  const profiles = incoming.modelProfiles as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(profiles)) {
    for (const p of profiles) {
      if (p && typeof p === "object" && isSecretValue(p.apiKey)) return true;
    }
  }
  const vision = incoming.vision as Record<string, unknown> | undefined;
  return !!(vision && typeof vision === "object" && isSecretValue(vision.apiKey));
}

/** incoming 是否携带非空 key / SENTINEL（general 的 SECRET_GENERAL_FIELDS）。 */
function generalIncomingHasSecret(incoming: Record<string, unknown>): boolean {
  return SECRET_GENERAL_FIELDS.some((field) => isSecretValue(incoming[field.jsonField]));
}

/**
 * 保存路由（PR19 复审 P1-1/P2-6）：
 *  - 非 vault 模式 → plaintext（明文语义不变）；
 *  - vault 可写 → vault（空=不改 / SENTINEL 删 / 非空入 vault）；
 *  - authoritative 但不可写 → readonly：仅当 incoming 含非空 key / SENTINEL 时抛
 *    E_SECRETS_HOST_LOST（不清盘、不写明文）；其余 patch 正常持久化（非 key 字段
 *    照写，key 槽由 stripKeysForDisk 取磁盘原值）；
 *  - 非 authoritative（未 hydrate 且未迁移）→ plaintext（迁移前回退明文）。
 */
function routeVaultSave(incomingHasSecret: boolean): VaultSaveRoute {
  if (!isVaultMode()) return "plaintext";
  if (hydrated && isSecretsHostAlive()) return "vault";
  if (hydrated || vaultMigrated || readVaultMigratedMarker()) {
    if (incomingHasSecret) throw new Error(SECRETS_HOST_LOST_MESSAGE);
    return "readonly";
  }
  return "plaintext";
}

/** 同步取密钥（loadModelSettings / loadGeneralSettings 的热路径）。 */
export function getSecret(name: string): string | undefined {
  return keyring.get(name);
}

/** 同步更新 keyring + 异步落 vault（save 路径；vault 失败仅记日志，下次启动迁移兜底）。 */
export function setSecret(name: string, value: string): void {
  keyring.set(name, value);
  const client = activeSecretsClient();
  void client.put(name, value).catch((err: unknown) => {
    console.error(`[secrets] put ${name} 失败:`, err instanceof Error ? err.message : err);
  });
}

export function deleteSecret(name: string): void {
  keyring.delete(name);
  const client = activeSecretsClient();
  void client.remove(name).catch(() => { /* 宿主缺失时静默（本来就清不掉） */ });
}

// ── 启动编排 ──

export interface SecretsInitResult {
  mode: boolean;
  hostUp: boolean;
  migrated: number;
  hydrated: boolean;
}

/**
 * 启动入口（app.whenReady 早期、任何设置消费之前）。幂等。
 * 迁移内容：模型 perProvider/profiles/vision + general 的 TTS/ASR key。
 */
export async function initSecretsVault(
  settingsJsonPath: string,
  generalJsonPath: string,
): Promise<SecretsInitResult> {
  if (!isVaultMode()) {
    if (!warnedFallback) {
      warnedFallback = true;
      // 复审 P2-4⑥：开关关闭不等于「明文仍可见」——已迁移过的 vault 不会被读取，
      // 密钥不可见（重新开启恢复）；仅从未迁移的配置维持明文存储
      console.log("[secrets] vault 关闭（CYRENE_SECRETS_HOST=0）：不读取 vault；若此前已迁移，密钥将不可见（重新开启恢复）");
    }
    return { mode: false, hostUp: false, migrated: 0, hydrated: false };
  }
  const client = activeSecretsClient();
  let hostUp = false;
  try {
    hostUp = await client.ensureStarted();
  } catch (err) {
    console.error("[secrets] 宿主启动失败:", err instanceof Error ? err.message : err);
  }
  if (!hostUp) {
    // IKJNX1 #1：宿主缺失时 migrated 状态改读盘上标记（status() 不可达）
    if (!vaultMigrated) vaultMigrated = readVaultMigratedMarker();
    if (vaultMigrated) {
      // 迁移后宿主缺失：明确报错（设计用例 5——不写明文、不静默回退；保存路径硬失败）
      console.error("[secrets] E_SECRETS_HOST_LOST：密钥已迁移 vault 但宿主不可用——请检查 cyrene-native 安装；保存路径已拒绝写明文");
    } else if (!warnedFallback) {
      warnedFallback = true;
      console.warn("[secrets] 宿主不可用（迁移前）：回退明文 JSON 读取（告警一次）");
    }
    return { mode: true, hostUp: false, migrated: 0, hydrated };
  }

  // 已迁移判定（vault 里 migratedAt 标记）+ 保护器可用性（复审 P2-2⑦）
  try {
    const status = await client.status();
    vaultMigrated = status.migrated === true;
    // 保护器不可用（非 Windows / DPAPI 故障）：put 必失败。若继续 hydrate，掩码会
    // 按「已激活」清空 UI、保存 put 静默失败 + 磁盘清痕 → 丢钥。此处维持未激活回退态。
    if (status.available === false) {
      console.error("[secrets] 值保护器不可用（available=false）：跳过迁移与 hydrate，保存维持明文回退");
      return { mode: true, hostUp: true, migrated: 0, hydrated };
    }
  } catch { /* status 失败按未迁移处理 */ }

  let migrated = 0;
  try {
    migrated = await migratePlaintextKeys(settingsJsonPath, generalJsonPath);
    if (migrated > 0 || !vaultMigrated) await client.markMigrated();
    vaultMigrated = true;
  } catch (err) {
    console.error("[secrets] 迁移失败（保持明文，下次启动重试）:", err instanceof Error ? err.message : err);
  }

  await hydrateKeyring();
  return { mode: true, hostUp: true, migrated, hydrated };
}

/** 全量拉取 vault → keyring（幂等，可在迁移后反复调用）。 */
export async function hydrateKeyring(): Promise<void> {
  const client = activeSecretsClient();
  try {
    const entries = await client.list();
    const next = new Map<string, string>();
    for (const e of entries) {
      const value = await client.get(e.name);
      if (value != null) next.set(e.name, value);
    }
    keyring.clear();
    for (const [k, v] of next) keyring.set(k, v);
    const wasHydrated = hydrated;
    hydrated = true;
    if (!wasHydrated) {
      // 复审 P2-2⑦：单个回调抛错不得中断其余回调（回填链独立）
      for (const cb of hydratedListeners.splice(0)) {
        try { cb(); } catch (err) {
          console.error("[secrets] hydrate 回调失败:", err instanceof Error ? err.message : err);
        }
      }
    }
  } catch (err) {
    console.error("[secrets] hydrate 失败:", err instanceof Error ? err.message : err);
  }
}

/**
 * 反查 key 所在槽位（复审 P1-10 槽位漂移）：档案展开后真 key 可能在
 * model:profile:<id> 槽而 provider 槽为空——以内存真值（vendorConfig.apiKey）
 * 反查 keyring 命中的槽名；未命中回退 provider 槽（.NET 侧 AUTH_MISSING 时
 * facade 回退直连）。
 */
export function resolveVaultKeyForVendor(provider: string, apiKeyValue: string): string {
  if (apiKeyValue) {
    for (const [name, v] of keyring) {
      if (v === apiKeyValue) return name;
    }
  }
  return vaultKeyForProvider(provider);
}

// ── 迁移（A4：import → 回读校验 → .bak → 源清空） ──

interface RawKeyHit {
  /** JSON 路径描述（诊断用） */
  where: string;
  vaultKey: string;
  value: string;
}

/** 从两份源 JSON 收集明文 key（只认非空 string）。 */
export function collectPlaintextKeys(
  modelSettingsRaw: Record<string, unknown> | null,
  generalRaw: Record<string, unknown> | null,
): RawKeyHit[] {
  const hits: RawKeyHit[] = [];
  const push = (where: string, vaultKey: string, v: unknown) => {
    if (typeof v === "string" && v.trim()) hits.push({ where, vaultKey, value: v.trim() });
  };

  if (modelSettingsRaw) {
    const perProvider = modelSettingsRaw.perProvider as Record<string, { apiKey?: unknown }> | undefined;
    if (perProvider && typeof perProvider === "object") {
      for (const [provider, entry] of Object.entries(perProvider)) {
        // 复审 P2-4④：与 normalize 的 PROVIDER_RENAMES 同步建槽——否则重命名用户 key 迁移后查不到
        push(`perProvider.${provider}`, vaultKeyForProvider(renamedProvider(provider)), entry?.apiKey);
      }
    }
    const profiles = modelSettingsRaw.modelProfiles as Array<{ id?: string; apiKey?: unknown }> | undefined;
    if (Array.isArray(profiles)) {
      for (const p of profiles) {
        if (p?.id) push(`modelProfile.${p.id}`, vaultKeyForProfile(p.id), p.apiKey);
      }
    }
    push("vision", VAULT_KEY_VISION, (modelSettingsRaw.vision as { apiKey?: unknown } | undefined)?.apiKey);
    // 极老配置兜底（复审 P2-4③）：顶层 apiKey 仅在当前 provider 槽无「非空」key 时入库——
    // perProvider[provider] 存在但 apiKey 为空时顶层 key 也要保（否则被清痕丢失）
    const currentProvider = typeof modelSettingsRaw.provider === "string" ? modelSettingsRaw.provider : "";
    const providerEntry = currentProvider && perProvider && typeof perProvider === "object"
      ? perProvider[currentProvider]
      : undefined;
    const providerHasKey = typeof providerEntry?.apiKey === "string" && providerEntry.apiKey.trim() !== "";
    if (currentProvider && !providerHasKey) {
      push(`topLevel.${currentProvider}`, vaultKeyForProvider(renamedProvider(currentProvider)), modelSettingsRaw.apiKey);
    }
    // 顶层 apiKey 是 perProvider 镜像（有 perProvider 命中时不重复入库，清空即可）
  }

  if (generalRaw) {
    for (const field of SECRET_GENERAL_FIELDS) {
      push(field.jsonField, field.vaultKey, generalRaw[field.jsonField]);
    }
  }
  return hits;
}

/** general-settings 里走 vault 的字段（TTS/ASR；A5）。 */
export const SECRET_GENERAL_FIELDS: Array<{ jsonField: string; vaultKey: string }> = [
  { jsonField: "ttsMinimaxKey", vaultKey: "tts:minimax" },
  { jsonField: "ttsMimoKey", vaultKey: "tts:mimo" },
  { jsonField: "ttsMosslandKey", vaultKey: "tts:mossland" },
  { jsonField: "ttsCustomCloudApiKey", vaultKey: "tts:custom-cloud" },
  { jsonField: "asrAliyunAppKey", vaultKey: "asr:aliyun-app-key" },
  { jsonField: "asrAliyunAccessKeyId", vaultKey: "asr:aliyun-access-key-id" },
  { jsonField: "asrAliyunAccessKeySecret", vaultKey: "asr:aliyun-access-key-secret" },
  { jsonField: "asrMinimaxKey", vaultKey: "asr:minimax" },
];

/**
 * 迁移编排：收集 → import → 回读校验（逐条 get 比对）→ .bak → 源清空。
 * 幂等：无明文命中直接返回 0；清空后源文件不再有 key。
 */
export async function migratePlaintextKeys(
  settingsJsonPath: string,
  generalJsonPath: string,
): Promise<number> {
  const readJson = (p: string): Record<string, unknown> | null => {
    try {
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const modelRaw = readJson(settingsJsonPath);
  const generalRaw = readJson(generalJsonPath);
  const hits = collectPlaintextKeys(modelRaw, generalRaw);
  if (hits.length === 0) return 0;

  // import（逐条 put；vault 内已有同值则幂等覆盖）
  const client = activeSecretsClient();
  const imported = await client.import(Object.fromEntries(hits.map((h) => [h.vaultKey, h.value])));

  // 回读校验：任何一条不一致 → 整体中止（源未动，明文还在）
  for (const h of hits) {
    const back = await client.get(h.vaultKey);
    if (back !== h.value) {
      throw new Error(`回读校验失败 ${h.where} → ${h.vaultKey}（导入 ${imported} 条已回滚语义：源未清空）`);
    }
  }

  // .bak + 源清空（复审 P1-11：后缀区分 model-settings schema 迁移的 .bak，避免互覆）
  for (const [p, raw] of [[settingsJsonPath, modelRaw], [generalJsonPath, generalRaw]] as const) {
    if (!raw || !fs.existsSync(p)) continue;
    clearKeysInRaw(raw);
    const bakPath = `${p}.pre-secrets.bak`;
    fs.copyFileSync(p, bakPath);
    // 复审 P2-5：.bak 含全部明文 key——非 Windows 收紧 0600（规则 §2.5 落盘权限）
    tightenFileMode(bakPath);
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), "utf8");
  }
  console.log(`[secrets] 迁移完成：${hits.length} 条明文 key 已入 vault，源 JSON 已清痕（.bak 保留，权限 0600）`);
  return hits.length;
}

/** 非 Windows 平台把文件权限收紧至 0600（owner rw）；Windows 跳过；失败告警但不阻断迁移。 */
function tightenFileMode(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    // 复审 P2-7：chmod 失败不再静默——.bak 含明文 key，权限收紧失败必须可观察
    console.warn(
      `[secrets] 收紧文件权限失败（不阻断迁移）: ${filePath}`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** 原地清空 raw 对象里的全部 key 字段（顶层镜像 + 集合内条目）。 */
function clearKeysInRaw(raw: Record<string, unknown>): void {
  for (const field of SECRET_GENERAL_FIELDS) {
    if (typeof raw[field.jsonField] === "string") (raw as Record<string, unknown>)[field.jsonField] = "";
  }
  if (!("perProvider" in raw) && !("modelProfiles" in raw) && !("vision" in raw) && !("apiKey" in raw)) return;
  const perProvider = raw.perProvider as Record<string, Record<string, unknown>> | undefined;
  if (perProvider && typeof perProvider === "object") {
    for (const entry of Object.values(perProvider)) {
      if (entry && typeof entry === "object" && "apiKey" in entry) entry.apiKey = "";
    }
  }
  const profiles = raw.modelProfiles as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(profiles)) {
    for (const p of profiles) if (p && "apiKey" in p) p.apiKey = "";
  }
  const vision = raw.vision as Record<string, unknown> | undefined;
  if (vision && typeof vision === "object" && "apiKey" in vision) vision.apiKey = "";
  if (typeof raw.apiKey === "string") raw.apiKey = "";
}

// ── 加载路径：keyring → settings（同步） ──

/** 把 keyring 的值填回 settings（内存对象始终持真值，消费方零改动）。 */
export function applyKeyringToModelSettings(settings: {
  provider: string;
  apiKey?: string;
  perProvider?: Record<string, { apiKey?: string }> | null;
  modelProfiles?: Array<{ id: string; apiKey?: string }> | null;
  vision?: { apiKey?: string } | null;
}): void {
  if (!hydrated) return;
  const per = settings.perProvider;
  if (per) {
    for (const [provider, entry] of Object.entries(per)) {
      const v = getSecret(vaultKeyForProvider(provider));
      if (v != null && entry) entry.apiKey = v;
    }
  }
  if (settings.modelProfiles) {
    for (const p of settings.modelProfiles) {
      const v = getSecret(vaultKeyForProfile(p.id));
      if (v != null) p.apiKey = v;
    }
  }
  if (settings.vision) {
    const v = getSecret(VAULT_KEY_VISION);
    if (v != null) settings.vision.apiKey = v;
  }
  const active = settings.provider ? getSecret(vaultKeyForProvider(settings.provider)) : undefined;
  if (active != null) settings.apiKey = active;
}

export function applyKeyringToGeneralSettings(settings: Record<string, unknown>): void {
  if (!hydrated) return;
  for (const field of SECRET_GENERAL_FIELDS) {
    const v = getSecret(field.vaultKey);
    if (v != null) settings[field.jsonField] = v;
  }
}

// ── 保存路径：settings → vault + 磁盘清痕 ──

/**
 * vault 模式保存语义（A3「空=不改」；路由见 routeVaultSave，仅 writable 执行）：
 *  - 非空 string → setSecret（vault + keyring 同步），值保留在内存对象；
 *  - "" → 视为「不改」：从 incoming 摘除该字段，让 merge 保住旧值；
 *  - SECRET_CLEAR_SENTINEL → 删 vault 条目 + 置 ""（用户显式清除）。
 * 磁盘副本由 stripKeysForDisk 生成；调用方继续用原对象回内存。
 */
export function vaultifyModelSettingsForSave(incoming: Record<string, unknown>): void {
  // PR19 复审 P1-1/P2-6：writable → vault 路径；authoritative 不可写 → 仅含 key
  // 的 patch 抛 E_SECRETS_HOST_LOST（非 key patch 继续持久化）；其余回退明文。
  if (routeVaultSave(modelIncomingHasSecret(incoming)) !== "vault") return;
  const provider = typeof incoming.provider === "string" ? incoming.provider : "";
  handleTopLevelKey(incoming, provider ? vaultKeyForProvider(provider) : "", "apiKey");

  const per = incoming.perProvider as Record<string, Record<string, unknown>> | undefined;
  if (per && typeof per === "object") {
    for (const [p, entry] of Object.entries(per)) {
      if (entry && typeof entry === "object" && "apiKey" in entry) {
        handleTopLevelKey(entry, vaultKeyForProvider(p), "apiKey");
      }
    }
  }
  const profiles = incoming.modelProfiles as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(profiles)) {
    for (const p of profiles) {
      if (p && typeof p === "object" && "apiKey" in p && typeof p.id === "string") {
        handleTopLevelKey(p, vaultKeyForProfile(p.id), "apiKey");
      }
    }
  }
  const vision = incoming.vision as Record<string, unknown> | undefined;
  if (vision && typeof vision === "object" && "apiKey" in vision) {
    handleTopLevelKey(vision, VAULT_KEY_VISION, "apiKey");
  }
}

function handleTopLevelKey(obj: Record<string, unknown>, vaultKey: string, field: string): void {
  const v = obj[field];
  if (v === SECRET_CLEAR_SENTINEL) {
    if (vaultKey) deleteSecret(vaultKey);
    obj[field] = "";
    return;
  }
  if (typeof v !== "string") return;
  if (v.trim() === "") {
    // 空 = 不改：摘除字段（merge 语义保旧值）；真清空走 SENTINEL
    delete obj[field];
    return;
  }
  if (vaultKey) setSecret(vaultKey, v.trim());
}

/** 读取磁盘 JSON（缺失 / 解析失败 / 非对象 → null）。 */
function readDiskJson(diskPath: string | undefined): Record<string, unknown> | null {
  if (!diskPath) return null;
  try {
    if (!fs.existsSync(diskPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(diskPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** 磁盘非空 string 原值（否则 ""）。 */
function diskString(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : "";
}

/**
 * key 槽逐槽对齐磁盘原值（PR19 复审 P1-1；authoritative 但不可写专用）。
 * 「磁盘有非空值 → 用磁盘值；磁盘无该槽 → 置 ''」，绝不取内存/keyring/incoming。
 * 磁盘有值而副本缺槽时补回磁盘原结构（vision / perProvider）；档案删除语义优先，
 * 磁盘独有档案不复活。
 */
function applyDiskKeyValues(copy: Record<string, unknown>, disk: Record<string, unknown> | null): void {
  // general：TTS/ASR 字段
  for (const field of SECRET_GENERAL_FIELDS) {
    if (typeof copy[field.jsonField] === "string" || diskString(disk?.[field.jsonField])) {
      copy[field.jsonField] = diskString(disk?.[field.jsonField]);
    }
  }
  // 顶层 apiKey（perProvider 镜像）
  if (typeof copy.apiKey === "string" || diskString(disk?.apiKey)) {
    copy.apiKey = diskString(disk?.apiKey);
  }
  // perProvider.*.apiKey（并集：磁盘独有槽补回）
  const per = copy.perProvider && typeof copy.perProvider === "object"
    ? copy.perProvider as Record<string, Record<string, unknown>>
    : undefined;
  const diskPer = disk?.perProvider && typeof disk.perProvider === "object"
    ? disk.perProvider as Record<string, { apiKey?: unknown } | undefined>
    : undefined;
  if (per || diskPer) {
    if (!copy.perProvider || typeof copy.perProvider !== "object") copy.perProvider = {};
    const target = copy.perProvider as Record<string, Record<string, unknown>>;
    for (const name of new Set([...Object.keys(per ?? {}), ...Object.keys(diskPer ?? {})])) {
      const entry = target[name];
      const hasSlot = !!entry && typeof entry === "object" && "apiKey" in entry;
      const value = diskString(diskPer?.[name]?.apiKey);
      if (hasSlot || value) target[name] = { ...(entry ?? {}), apiKey: value };
    }
  }
  // modelProfiles[].apiKey：按 id 对齐；磁盘已删除的档案不复活（删除语义优先）
  const profiles = copy.modelProfiles;
  if (Array.isArray(profiles)) {
    const diskProfiles = Array.isArray(disk?.modelProfiles)
      ? disk.modelProfiles as Array<{ id?: unknown; apiKey?: unknown } | undefined>
      : [];
    for (const p of profiles) {
      if (!p || typeof p !== "object" || !("apiKey" in p)) continue;
      const match = typeof p.id === "string" ? diskProfiles.find((d) => d?.id === p.id) : undefined;
      p.apiKey = diskString(match?.apiKey);
    }
  }
  // vision.apiKey（磁盘独有 key-only 配置补回原结构）
  const vision = copy.vision && typeof copy.vision === "object"
    ? copy.vision as Record<string, unknown>
    : undefined;
  const diskVision = disk?.vision && typeof disk.vision === "object"
    ? disk.vision as Record<string, unknown>
    : undefined;
  if (vision && "apiKey" in vision) {
    vision.apiKey = diskString(diskVision?.apiKey);
  } else if (diskString(diskVision?.apiKey)) {
    copy.vision = { ...diskVision };
  }
}

/**
 * 磁盘副本（PR19 复审 P1-1 三分支）：
 *  - vault 可写 → 全部 key 槽置空（源 JSON 清痕铁律）；
 *  - authoritative 但不可写 → key 槽逐槽取「磁盘原值」（磁盘无该槽 → ""），
 *    绝不把内存/keyring/incoming 明文写回盘，也不空串覆盖丢钥；
 *  - 非 authoritative（未 hydrate 且未迁移）→ 原样返回（明文回退语义）。
 * diskPath 传当前要写入的设置文件路径（model-settings.json / app-settings.json）。
 */
export function stripKeysForDisk<T>(settings: T, diskPath?: string): T {
  if (isVaultWritable()) {
    const copy = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
    clearKeysInRaw(copy);
    return copy as T;
  }
  if (isVaultAuthoritative()) {
    const copy = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
    applyDiskKeyValues(copy, readDiskJson(diskPath));
    return copy as T;
  }
  return settings;
}

// ── 掩码（A3：设置页读取只回掩码/hasKey） ──

/**
 * 掩码模型设置快照（vault 模式专用；非 vault 模式维持明文展示不变）。
 * PR19 复审 P1-1：门控 = vaultAuthoritative（hydrated ∨ 已迁移 ∨ 盘上标记）——
 * 事实源在 vault 即掩码；未 hydrate 且未迁移（迁移前回退明文）不掩码，渲染端
 * 持明文、回传不会清盘。掩码判据与保存/回填/WPF 快照统一。
 */
export function maskModelSettingsForUi<T>(settings: T): T {
  if (!isVaultAuthoritative()) return settings;
  const copy = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
  const mask = (obj: Record<string, unknown>, field = "apiKey"): void => {
    const v = obj[field];
    obj[`has${field.charAt(0).toUpperCase()}${field.slice(1)}`] = typeof v === "string" && v.trim() !== "";
    if (typeof v === "string" && v.trim() !== "") obj[field] = "";
  };
  mask(copy);
  const per = copy.perProvider as Record<string, Record<string, unknown>> | undefined;
  if (per) for (const entry of Object.values(per)) if (entry && typeof entry === "object") mask(entry);
  const profiles = copy.modelProfiles as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(profiles)) for (const p of profiles) if (p && typeof p === "object") mask(p);
  if (copy.vision && typeof copy.vision === "object") mask(copy.vision as Record<string, unknown>);
  return copy as T;
}

/** 掩码 general 设置快照（TTS/ASR key → "" + has<Field> 布尔）。同 model：门控 = vaultAuthoritative。 */
export function maskGeneralSettingsForUi<T>(settings: T): T {
  if (!isVaultAuthoritative()) return settings;
  const copy = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
  for (const field of SECRET_GENERAL_FIELDS) {
    const v = copy[field.jsonField];
    copy[`has${field.jsonField.charAt(0).toUpperCase()}${field.jsonField.slice(1)}`] =
      typeof v === "string" && v.trim() !== "";
    if (typeof v === "string" && v.trim() !== "") copy[field.jsonField] = "";
  }
  return copy as T;
}

/** general 保存路径的 vaultify（同 model：writable → 空=不改 / SENTINEL=清；authoritative
 *  不可写 → 仅含 key 的 patch 抛 E_SECRETS_HOST_LOST，非 key patch 继续持久化；其余回退明文）。 */
export function vaultifyGeneralSettingsForSave(incoming: Record<string, unknown>): void {
  if (routeVaultSave(generalIncomingHasSecret(incoming)) !== "vault") return;
  for (const field of SECRET_GENERAL_FIELDS) {
    handleTopLevelKey(incoming, field.vaultKey, field.jsonField);
  }
}

/** 测试后门。 */
export function __resetKeyringForTests(): void {
  keyring.clear();
  hydrated = false;
  vaultMigrated = false;
  warnedFallback = false;
}
