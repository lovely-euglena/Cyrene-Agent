/**
 * DPAPI 密钥库宿主客户端（Phase 1 / A1）。
 *
 * cyrene-native --secrets-host（stdio JSON 行，与 --ssh-host 同构）：vault 落
 * --data-dir/secrets-vault.json（DPAPI CurrentUser 加密）；TS 仅经本地帧协议取用，
 * 不再持久化任何密钥（源 JSON 清痕由 secrets-keyring 迁移完成）。
 *
 * 开关：CYRENE_SECRETS_HOST / cyrene.conf secretsHost（双轨 opt-in，默认 0）。
 */
import { resolveDotnetConfig } from "./config";
import { type SecretsStatusData } from "./llm-host-protocol";
import { LineHostClient } from "./host-clients";

export interface SecretEntryMeta {
  name: string;
  createdAt: string;
  updatedAt: string;
}

let dataDirCache: string | null = null;

/** vault data-dir（userData；Electron 不可用时的测试兜底 = cwd/.secrets-smoke）。 */
export function secretsDataDir(): string {
  if (dataDirCache) return dataDirCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as { app?: { getPath: (k: string) => string } };
    dataDirCache = electron.app?.getPath("userData") ?? process.cwd();
  } catch {
    dataDirCache = process.cwd();
  }
  return dataDirCache;
}

/** 测试注入口。 */
export function __setSecretsDataDirForTests(dir: string | null): void {
  dataDirCache = dir;
}

export class SecretsHostClient extends LineHostClient {
  enabled(): boolean {
    return resolveDotnetConfig().secretsHost;
  }
  constructor() {
    super("--secrets-host", 10_000);
  }
  protected extraArgs(): string[] {
    return ["--data-dir", secretsDataDir()];
  }

  async status(): Promise<SecretsStatusData> {
    const r = await this.call("secret.status", {});
    return ((r as { data?: SecretsStatusData }).data ?? {}) as SecretsStatusData;
  }
  async get(name: string): Promise<string | null> {
    const r = (await this.call("secret.get", { name })) as { data?: { value: string | null } };
    return r.data?.value ?? null;
  }
  async put(name: string, value: string): Promise<void> {
    await this.call("secret.put", { name, value });
  }
  async remove(name: string): Promise<boolean> {
    const r = (await this.call("secret.delete", { name })) as { data?: { removed?: boolean } };
    return r.data?.removed === true;
  }
  async list(): Promise<SecretEntryMeta[]> {
    const r = (await this.call("secret.list", {})) as { data?: { entries?: SecretEntryMeta[] } };
    return r.data?.entries ?? [];
  }
  /** 批量导入（迁移用）；返回导入条数。 */
  async import(values: Record<string, string>): Promise<number> {
    const r = (await this.call("secret.import", { values })) as { data?: { imported?: number } };
    return r.data?.imported ?? 0;
  }
  async markMigrated(): Promise<void> {
    await this.call("secret.mark-migrated", {});
  }
}

export const secretsHostClient = new SecretsHostClient();

/** 测试注入口：替换单例（迁移编排测试用桩客户端）。 */
export function __setSecretsHostClientForTests(client: SecretsHostClient | null): void {
  clientForTests = client;
}

let clientForTests: SecretsHostClient | null = null;

/** 迁移编排统一入口（可注入桩）。 */
export function activeSecretsClient(): SecretsHostClient {
  return clientForTests ?? secretsHostClient;
}
