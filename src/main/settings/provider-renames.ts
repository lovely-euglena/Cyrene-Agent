/**
 * 厂商重命名映射（唯一事实源）。
 *
 * 已存盘的 model-settings.json 里 provider 字段（以及 perProvider 字典的键）
 * 仍是旧名；normalize 阶段做一次性迁移，把旧名的 perProvider 数据搬到新名下，
 * provider 字段也改写为新名。迁移后写盘一次即清除痕迹。
 *
 * 密钥库建槽（secrets-keyring 迁移）与 normalize 共用本映射：否则重命名用户的
 * key 会以旧名入 vault，normalize 改名后 `model:provider:<新名>` 查不到（复审 P2-4④）。
 *
 * 后续如果再次重命名，**只追加键值对**，不要删除老条目，避免回归。
 */
export const PROVIDER_RENAMES: Record<string, string> = {
  "MiniMax": "MiniMax（稀宇科技）",
  "DeepSeek": "DeepSeek（深度求索）",
  "智谱 GLM": "GLM（智谱）",
  "通义千问（DashScope）": "Qwen（通义千问）",
};

/** 旧名 → 新名；未登记的原样返回。 */
export function renamedProvider(provider: string): string {
  return PROVIDER_RENAMES[provider] ?? provider;
}
