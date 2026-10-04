/**
 * 固定窗口限流（DO SQLite 计数；抽为独立模块以便单测）。
 *
 * 已知差异（见 README「与 .NET 版差异」）：CF 为绝对分钟对齐窗口，.NET 为按分区首请求
 * 起算的分段窗口；两者均为固定窗口近似，阈值口径一致。
 *
 * 验证口径：核心档套件不覆盖限流阈值；本模块由 test/rate-limit.test.ts 单测，
 * 并由 cf-worker 工作流以低阈值实例（CLOUD_RATE_PAIR_PER_MIN=2）断言 429。
 */

export const RATE_WINDOW_MS = 60_000;

/** 仅依赖 exec 的最小 SQL 接口（生产 = DO SqlStorage；测试 = node:sqlite 适配器）。 */
export interface RateLimitSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** 命中计数 +1 并返回是否超限（key 应为已认证主体或客户端 IP 分区）。 */
export function hitRateLimit(sql: RateLimitSql, key: string, limit: number, nowMs = Date.now()): boolean {
  const window = Math.floor(nowMs / RATE_WINDOW_MS);
  sql.exec("DELETE FROM rate_limits WHERE window < ?", window - 1);
  sql.exec(
    "INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET count = count + 1",
    key,
    window,
  );
  const row = sql.exec("SELECT count FROM rate_limits WHERE key = ? AND window = ?", key, window).toArray()[0];
  const count = row !== undefined ? Number((row as { count: unknown }).count) : 1;
  return count > limit;
}
