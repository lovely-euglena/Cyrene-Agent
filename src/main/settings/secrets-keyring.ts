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
 * host 缺失策略（设计 §8 用例 4/5）：迁移前回退明文（告警一次）；迁移后宿主缺失
 * → keyring 空（调用 401 明确报错）且保存路径拒绝写明文（vaultMigrated 守卫）。
 */
import fs from "node:fs";
import path from "node:path";
import { resolveDotnetConfig } from "../dotnet-backend/config";
import { activeSecretsClient } from "../dotnet-backend/secrets-client";

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
 * vault 实际可用（复审 P0-8）：配置开 且 keyring 已 hydrate。
 * hydrated 只能经宿主成功 list/get 达成——宿主缺失/崩溃（迁移未发生）时为 false，
 * 保存路径据此整体回退明文语义（不清盘、不静默丢用户输入，设计 §4.5 用例 4）。
 */
export function isVaultActive(): boolean {
  return isVaultMode() && hydrated;
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
      console.log("[secrets] vault 关闭（CYRENE_SECRETS_HOST=0）：密钥维持明文 JSON 存储");
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
    if (vaultMigrated) {
      // 迁移后宿主缺失：明确报错（设计用例 5——不写明文、不静默回退）
      console.error("[secrets] E_SECRETS_HOST_LOST：密钥已迁移 vault 但宿主不可用——请检查 cyrene-native 安装；保存路径已拒绝写明文");
    } else if (!warnedFallback) {
      warnedFallback = true;
      console.warn("[secrets] 宿主不可用（迁移前）：回退明文 JSON 读取（告警一次）");
    }
    return { mode: true, hostUp: false, migrated: 0, hydrated };
  }

  // 已迁移判定（vault 里 migratedAt 标记）
  try {
    const status = await client.status();
    vaultMigrated = status.migrated === true;
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
    if (!wasHydrated) for (const cb of hydratedListeners.splice(0)) cb();
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
        push(`perProvider.${provider}`, vaultKeyForProvider(provider), entry?.apiKey);
      }
    }
    const profiles = modelSettingsRaw.modelProfiles as Array<{ id?: string; apiKey?: unknown }> | undefined;
    if (Array.isArray(profiles)) {
      for (const p of profiles) {
        if (p?.id) push(`modelProfile.${p.id}`, vaultKeyForProfile(p.id), p.apiKey);
      }
    }
    push("vision", VAULT_KEY_VISION, (modelSettingsRaw.vision as { apiKey?: unknown } | undefined)?.apiKey);
    // 极老配置兜底（复审提示项）：仅顶层 apiKey（无 perProvider 命中）→ 按当前 provider 槽入库
    const currentProvider = typeof modelSettingsRaw.provider === "string" ? modelSettingsRaw.provider : "";
    const providerHit = currentProvider
      && perProvider && typeof perProvider === "object" && perProvider[currentProvider];
    if (currentProvider && !providerHit) {
      push(`topLevel.${currentProvider}`, vaultKeyForProvider(currentProvider), modelSettingsRaw.apiKey);
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
    fs.copyFileSync(p, `${p}.pre-secrets.bak`);
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), "utf8");
  }
  console.log(`[secrets] 迁移完成：${hits.length} 条明文 key 已入 vault，源 JSON 已清痕（.bak 保留）`);
  return hits.length;
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
 * vault 模式保存语义（A3「空=不改」）：
 *  - 非空 string → setSecret（vault + keyring 同步），值保留在内存对象；
 *  - "" → 视为「不改」：从 incoming 摘除该字段，让 merge 保住旧值；
 *  - SECRET_CLEAR_SENTINEL → 删 vault 条目 + 置 ""（用户显式清除）。
 * 返回磁盘写入副本（全部 key 置空）；调用方继续用原对象回内存。
 */
export function vaultifyModelSettingsForSave(incoming: Record<string, unknown>): void {
  if (!isVaultActive()) return; // 复审 P0-8：host 缺失（迁移未发生）→ 整体回退明文保存语义
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

/** 磁盘副本：全部 key 字段置空（vault 激活时专用；源 JSON 清痕铁律。复审 P0-8：未激活时原样返回）。 */
export function stripKeysForDisk<T>(settings: T): T {
  if (!isVaultActive()) return settings;
  const copy = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
  for (const field of SECRET_GENERAL_FIELDS) {
    if (typeof copy[field.jsonField] === "string") copy[field.jsonField] = "";
  }
  const per = copy.perProvider as Record<string, Record<string, unknown>> | undefined;
  if (per && typeof per === "object") {
    for (const entry of Object.values(per)) {
      if (entry && "apiKey" in entry) entry.apiKey = "";
    }
  }
  const profiles = copy.modelProfiles as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(profiles)) {
    for (const p of profiles) if (p && "apiKey" in p) p.apiKey = "";
  }
  const vision = copy.vision as Record<string, unknown> | undefined;
  if (vision && "apiKey" in vision) vision.apiKey = "";
  if (typeof copy.apiKey === "string") copy.apiKey = "";
  return copy as T;
}

// ── 掩码（A3：设置页读取只回掩码/hasKey） ──

export interface KeyMask { hasKey: boolean }

/** 掩码模型设置快照（vault 模式专用；非 vault 模式维持明文展示不变）。 */
export function maskModelSettingsForUi<T>(settings: T): T {
  if (!isVaultMode()) return settings;
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

/** 掩码 general 设置快照（TTS/ASR key → "" + has<Field> 布尔）。 */
export function maskGeneralSettingsForUi<T>(settings: T): T {
  if (!isVaultMode()) return settings;
  const copy = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
  for (const field of SECRET_GENERAL_FIELDS) {
    const v = copy[field.jsonField];
    copy[`has${field.jsonField.charAt(0).toUpperCase()}${field.jsonField.slice(1)}`] =
      typeof v === "string" && v.trim() !== "";
    if (typeof v === "string" && v.trim() !== "") copy[field.jsonField] = "";
  }
  return copy as T;
}

/** general 保存路径的 vaultify（同 model 语义：空=不改 / SENTINEL=清；P0-8：host 缺失时整体回退明文）。 */
export function vaultifyGeneralSettingsForSave(incoming: Record<string, unknown>): void {
  if (!isVaultActive()) return;
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
