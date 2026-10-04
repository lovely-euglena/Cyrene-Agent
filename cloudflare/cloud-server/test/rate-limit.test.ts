/// <reference types="node" />
/**
 * 限流单测（IKJN79 评审 P1 修复）：核心档不覆盖限流阈值，这里用 node:sqlite 跑真实 SQL
 * （与 DO SQLite 同方言），锁定固定窗口语义：计数 / 超限 / 窗口滚动 / 键隔离 / 过期清理。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { hitRateLimit, RATE_WINDOW_MS, type RateLimitSql } from "../src/rate-limit";

/** node:sqlite 适配到 DO SqlStorage 的最小 exec 形态（DO exec 立即执行；SELECT 返回游标）。 */
function sqlAdapter(db: DatabaseSync): RateLimitSql {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      if (/^\s*select/i.test(query)) {
        return { toArray: () => statement.all(...(bindings as never[])) };
      }
      statement.run(...(bindings as never[]));
      return { toArray: () => [] };
    },
  };
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE rate_limits (
    key TEXT NOT NULL,
    window INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (key, window)
  )`);
  return db;
}

describe("hitRateLimit（DO 固定窗口）", () => {
  it("阈值内放行、超限拒绝（limit=2 → 第 3 次 429）", () => {
    const sql = sqlAdapter(createDb());
    const now = 1_800_000_000_000;
    expect(hitRateLimit(sql, "pair:i:1.2.3.4", 2, now)).toBe(false);
    expect(hitRateLimit(sql, "pair:i:1.2.3.4", 2, now)).toBe(false);
    expect(hitRateLimit(sql, "pair:i:1.2.3.4", 2, now)).toBe(true);
  });

  it("键隔离：不同分区互不影响", () => {
    const sql = sqlAdapter(createDb());
    const now = 1_800_000_000_000;
    hitRateLimit(sql, "pair:p:master", 1, now);
    expect(hitRateLimit(sql, "pair:p:master", 1, now)).toBe(true);
    expect(hitRateLimit(sql, "pair:i:5.6.7.8", 1, now)).toBe(false);
  });

  it("窗口滚动：下一窗口重新计数", () => {
    const sql = sqlAdapter(createDb());
    const now = 1_800_000_000_000;
    hitRateLimit(sql, "sync:p:dev_1", 1, now);
    expect(hitRateLimit(sql, "sync:p:dev_1", 1, now)).toBe(true);
    expect(hitRateLimit(sql, "sync:p:dev_1", 1, now + RATE_WINDOW_MS)).toBe(false);
  });

  it("过期清理：仅保留当前与上一窗口的行", () => {
    const sql = sqlAdapter(createDb());
    const now = 1_800_000_000_000;
    hitRateLimit(sql, "pair:i:1", 10, now - RATE_WINDOW_MS * 5);
    hitRateLimit(sql, "pair:i:1", 10, now - RATE_WINDOW_MS);
    hitRateLimit(sql, "pair:i:1", 10, now);
    const rows = sql.exec("SELECT window FROM rate_limits ORDER BY window").toArray() as Array<{ window: number }>;
    expect(rows).toHaveLength(2);
  });
});
