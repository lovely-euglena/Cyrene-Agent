/**
 * 导出 dry-run 冒烟（IKJK2I A 簇，手动）。
 *
 * 默认跳过；显式开启才运行：
 *   CYRENE_SYNC_DRY_RUN=1 CYRENE_SYNC_DRY_RUN_USERDATA=<真实 userData> \
 *     npx vitest run src/main/sync/export-dry-run.manual.test.ts
 *
 * 只读语义：不触发迁移（ensureMigrated no-op）、不写真实 userData
 * （sync state/store 用临时目录；未建立 CTA 轨迹目录的会话跳过读取）。
 * 输出：会话 / 事件计数与样例。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatSessionMeta } from "../../shared/chat-types";
import { ConversationTranscriptStore, transcriptStorageKey } from "../orchestrator/conversation-transcript-store";
import { SyncEventStore } from "./event-store";
import { createSyncExporter } from "./exporter";
import { createSyncState } from "./sync-state";

const userDataPath = process.env.CYRENE_SYNC_DRY_RUN_USERDATA ?? "";
const enabled = process.env.CYRENE_SYNC_DRY_RUN === "1" && userDataPath !== "";

describe.skipIf(!enabled)("导出 dry-run（真实 userData，只读）", () => {
  it("扫描会话并导出到临时 sync 目录，打印计数与样例", async () => {
    const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-sync-dry-run-"));
    try {
      const indexFile = path.join(userDataPath, "cyrene-chats", "index.json");
      const metas = JSON.parse(fs.readFileSync(indexFile, "utf8")) as ChatSessionMeta[];
      const transcripts = new ConversationTranscriptStore(userDataPath);
      const store = await SyncEventStore.open({ syncDir });
      const state = createSyncState();
      const exporter = createSyncExporter({
        userDataPath,
        state,
        store,
        listSessions: async () => metas,
        ensureMigrated: async () => {}, // 只读冒烟：不触发 v1 → v2 迁移写入
        readAuditEntries: async (sessionId) => {
          // 未建立 CTA 轨迹目录的会话跳过读取：读取路径会为不存在的目录建库写盘。
          const dir = path.join(userDataPath, "transcripts", transcriptStorageKey(sessionId));
          if (!fs.existsSync(dir)) return [];
          return transcripts.readAuditEntries(sessionId);
        },
      });

      const result = await exporter.exportPending();
      const events = store.getLocalEvents();
      console.log(`[dry-run] sessions=${metas.length} exportedSessions=${result.sessions} exported=${result.exported} events=${events.length}`);
      const byType = new Map<string, number>();
      for (const event of events) byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
      console.log(`[dry-run] types=${JSON.stringify(Object.fromEntries(byType))}`);
      for (const event of events.slice(0, 20)) {
        console.log(`[dry-run] sample ${event.type} session=${event.sessionId} eventId=${event.eventId} payload=${JSON.stringify(event.payload).slice(0, 160)}`);
      }

      expect(events.length).toBe(result.exported);
      expect(state.lamport).toBeGreaterThanOrEqual(events.length);
    } finally {
      fs.rmSync(syncDir, { recursive: true, force: true });
    }
  });
});
