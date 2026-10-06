/**
 * 事件导出器测试（IKJK2I A 簇）。
 *
 * 用真实 ConversationTranscriptStore + ConversationJournalService 在 mkdtemp 构造 CTA 数据，
 * 覆盖：4 类映射 / rewind keep+replace / 墓碑 / presentation 合并与白名单 / internal 与空文本
 * 跳过 / 标题修订 / 幂等 / 崩溃重入 / 水位与时钟单调 / 迁移驱动。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionMeta } from "../../shared/chat-types";
import { ConversationJournalService } from "../orchestrator/conversation-journal-service";
import { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";
import { SyncEventStore } from "./event-store";
import { createSyncExporter, type SyncExporter } from "./exporter";
import { validateSyncEvent, SYNC_PRESENTATION_PATCH_KEYS, type SyncEventV0 } from "./sync-protocol";
import { createSyncState, loadSyncState, saveSyncState, type SyncState } from "./sync-state";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface HarnessOptions {
  ensureMigrated?: (sessionId: string) => Promise<void>;
  wrapAuditEntries?: (entries: TranscriptEntry[], sessionId: string) => TranscriptEntry[];
}

interface ExporterHarness {
  root: string;
  syncDir: string;
  transcriptStore: ConversationTranscriptStore;
  journal: ConversationJournalService;
  eventStore: SyncEventStore;
  state: SyncState;
  metas: ChatSessionMeta[];
  ensureMigrated: ReturnType<typeof vi.fn>;
  exporter: SyncExporter;
}

async function createHarness(options: HarnessOptions = {}): Promise<ExporterHarness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-sync-exporter-"));
  roots.push(root);
  const transcriptStore = new ConversationTranscriptStore(root);
  const journal = new ConversationJournalService(transcriptStore);
  const syncDir = path.join(root, "sync");
  const eventStore = await SyncEventStore.open({ syncDir });
  const state = createSyncState();
  const metas: ChatSessionMeta[] = [];
  const ensureMigrated = vi.fn(options.ensureMigrated ?? (async () => {}));
  const exporter = createSyncExporter({
    userDataPath: root,
    state,
    store: eventStore,
    listSessions: async () => metas.map((meta) => ({ ...meta })),
    ensureMigrated: (sessionId) => ensureMigrated(sessionId),
    readAuditEntries: async (sessionId) => {
      const entries = await transcriptStore.readAuditEntries(sessionId);
      return options.wrapAuditEntries ? options.wrapAuditEntries(entries, sessionId) : entries;
    },
  });
  return { root, syncDir, transcriptStore, journal, eventStore, state, metas, ensureMigrated, exporter };
}

/** 用既有 deps 重新构建导出器（模拟重启 / 注入落后 state）。 */
function buildExporter(
  harness: ExporterHarness,
  overrides: { state?: SyncState; store?: SyncEventStore } = {},
): SyncExporter {
  return createSyncExporter({
    userDataPath: harness.root,
    state: overrides.state ?? harness.state,
    store: overrides.store ?? harness.eventStore,
    listSessions: async () => harness.metas.map((meta) => ({ ...meta })),
    ensureMigrated: async () => {},
    readAuditEntries: (sessionId) => harness.transcriptStore.readAuditEntries(sessionId),
  });
}

function addMeta(harness: ExporterHarness, input: { id: string; title: string; createdAt: number }): ChatSessionMeta {
  const meta: ChatSessionMeta = {
    id: input.id,
    title: input.title,
    identityId: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    messageCount: 0,
    mode: "chat",
  };
  harness.metas.push(meta);
  return meta;
}

async function appendAssistant(
  journal: ConversationJournalService,
  conversationId: string,
  runId: string,
  turnId: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const sink = journal.createRunSink({ conversationId, runId, assistantTurnId: turnId });
  return sink.appendAssistant({
    message: { role: "assistant", content: text, ...extra } as Parameters<typeof sink.appendAssistant>[0]["message"],
  });
}

function eventsById(store: SyncEventStore): Map<string, SyncEventV0> {
  return new Map(store.getLocalEvents().map((event) => [event.eventId, event]));
}

/** 注入读取器无法经 store 校验产生的构造条目（防御分支 / 白名单过滤用）。 */
function crafted(entry: Record<string, unknown>): TranscriptEntry {
  return entry as unknown as TranscriptEntry;
}

describe("createSyncExporter", () => {
  it("映射 4 类事件：session.create 先行 + user / assistant / rewind / tombstone，全部通过协议校验", async () => {
    const h = await createHarness();
    addMeta(h, { id: "s1", title: "标题一", createdAt: 1_000 });
    await h.journal.appendUser("s1", { turnId: "u1", text: "你好", at: 2_000 });
    const assistantId = await appendAssistant(h.journal, "s1", "run1", "a1", "答一");
    await h.journal.appendRewind("s1", { anchorUserTurnId: "u1", disposition: "keep_user", runId: "run2", at: 3_000 });
    await h.journal.appendUser("s1", { turnId: "u2", text: "第二问", at: 4_000 });
    await h.journal.withdrawUserTurn("s1", "u2");

    const result = await h.exporter.exportPending();
    expect(result).toEqual({ exported: 6, sessions: 1 });
    expect(h.ensureMigrated).toHaveBeenCalledTimes(1);
    expect(h.ensureMigrated).toHaveBeenCalledWith("s1");

    const byId = eventsById(h.eventStore);
    expect([...byId.keys()]).toEqual([
      "screate:s1:r1",
      "user:u1:r1",
      assistantId,
      "run2:rewind:u1",
      "user:u2:r1",
      "withdraw:u2",
    ]);

    const create = byId.get("screate:s1:r1")!;
    expect(create.type).toBe("session.create");
    expect(create.payload).toEqual({ title: "标题一", createdAt: new Date(1_000).toISOString() });
    expect(create.ts).toBe(new Date(1_000).toISOString());

    const user = byId.get("user:u1:r1")!;
    expect(user.type).toBe("message.append");
    expect(user.payload).toEqual({ role: "user", text: "你好", turnId: "u1" });
    expect(user.ts).toBe(new Date(2_000).toISOString());
    expect(user.sessionId).toBe("s1");
    expect(user.deviceId).toBe(h.state.deviceId);

    const assistant = byId.get(assistantId)!;
    expect(assistant.payload).toEqual({ role: "assistant", text: "答一", turnId: "a1" });

    const rewind = byId.get("run2:rewind:u1")!;
    expect(rewind.type).toBe("turn_rewind");
    expect(rewind.payload).toEqual({ anchorUserTurnId: "u1", disposition: "keep_user", reason: "regenerate" });
    expect("replacementUser" in rewind.payload).toBe(false);
    expect("revision" in rewind.payload).toBe(false);

    const tombstone = byId.get("withdraw:u2")!;
    expect(tombstone.type).toBe("tombstone");
    expect(tombstone.payload).toEqual({ targetUserTurnId: "u2", reason: "pending_withdrawn" });

    for (const event of h.eventStore.getLocalEvents()) expect(validateSyncEvent(event)).toBeNull();
  });

  it("turn_rewind replace_user：replacementUser 与信封 revision 移入载荷", async () => {
    const h = await createHarness();
    addMeta(h, { id: "s1", title: "t", createdAt: 1_000 });
    await h.journal.appendUser("s1", { turnId: "u1", text: "原稿", at: 2_000 });
    await h.journal.appendRewind("s1", {
      anchorUserTurnId: "u1",
      disposition: "replace_user",
      runId: "run-edit",
      at: 3_000,
      replacementUser: { turnId: "u1", text: "改稿" },
    });

    await h.exporter.exportPending();
    const rewind = eventsById(h.eventStore).get("run-edit:rewind:u1")!;
    expect(rewind.payload).toEqual({
      anchorUserTurnId: "u1",
      disposition: "replace_user",
      reason: "edit",
      replacementUser: { text: "改稿" },
      revision: 2,
    });
    expect(validateSyncEvent(rewind)).toBeNull();
  });

  it("assistant presentation：折叠最新补丁、白名单过滤、过滤后为空则整体省略", async () => {
    const h = await createHarness({
      wrapAuditEntries: (entries) => [
        ...entries,
        crafted({
          seq: 9_000, id: "crafted:p1", at: 3_000, kind: "presentation_patch",
          payload: { messageId: "a2", patchRevision: 1, patch: { content: "保留", 秘密: "过滤" } },
        }),
        crafted({
          seq: 9_001, id: "crafted:p2", at: 3_001, kind: "presentation_patch",
          payload: { messageId: "a3", patchRevision: 1, patch: { 秘密: "全滤" } },
        }),
      ],
    });
    addMeta(h, { id: "s1", title: "t", createdAt: 1_000 });
    await h.journal.appendUser("s1", { turnId: "u1", text: "问", at: 2_000 });
    const a1 = await appendAssistant(h.journal, "s1", "run1", "a1", "答一");
    const a2 = await appendAssistant(h.journal, "s1", "run2", "a2", "答二");
    const a3 = await appendAssistant(h.journal, "s1", "run3", "a3", "答三");
    await h.journal.appendPresentation("s1", "a1", 1, { content: "第一版", reasoning: "想" });
    await h.journal.appendPresentation("s1", "a1", 2, { content: "第二版" });

    await h.exporter.exportPending();
    const byId = eventsById(h.eventStore);

    const first = byId.get(a1)!;
    expect(first.payload.presentation).toEqual({
      patchRevision: 2,
      patch: { content: "第二版", reasoning: "想" },
    });

    const second = byId.get(a2)!;
    expect(second.payload.presentation).toEqual({ patchRevision: 1, patch: { content: "保留" } });

    const third = byId.get(a3)!;
    expect("presentation" in third.payload).toBe(false);

    for (const event of h.eventStore.getLocalEvents()) {
      const presentation = event.payload.presentation as { patch?: Record<string, unknown> } | undefined;
      if (!presentation?.patch) continue;
      for (const key of Object.keys(presentation.patch)) {
        expect(SYNC_PRESENTATION_PATCH_KEYS).toContain(key);
      }
    }
  });

  it("跳过 visibility=internal / 空文本 assistant 与缺失 turnId 的 user（防御）", async () => {
    const h = await createHarness({
      wrapAuditEntries: (entries) => [
        ...entries,
        crafted({ seq: 9_000, id: "crafted:no-turn", at: 5_000, kind: "user", payload: { text: "无锚点" } }),
      ],
    });
    addMeta(h, { id: "s1", title: "t", createdAt: 1_000 });
    await h.journal.appendUser("s1", { turnId: "u1", text: "问", at: 2_000 });
    const internal = await appendAssistant(h.journal, "s1", "run-internal", "a-int", "内部内容", { visibility: "internal" });
    const empty = await appendAssistant(h.journal, "s1", "run-empty", "a-empty", "");

    const result = await h.exporter.exportPending();
    expect(result.exported).toBe(2);
    const ids = h.eventStore.getLocalEvents().map((event) => event.eventId);
    expect(ids).toEqual(["screate:s1:r1", "user:u1:r1"]);
    expect(ids).not.toContain(internal);
    expect(ids).not.toContain(empty);
    expect(ids).not.toContain("crafted:no-turn");
  });

  it("session.create 标题修订：重命名发 r2、同题幂等、超长截断至 200", async () => {
    const h = await createHarness();
    const meta = addMeta(h, { id: "s1", title: "旧名", createdAt: 1_000 });
    await h.journal.appendUser("s1", { turnId: "u1", text: "问", at: 2_000 });

    await h.exporter.exportPending();
    let byId = eventsById(h.eventStore);
    expect(byId.get("screate:s1:r1")!.payload).toEqual({
      title: "旧名",
      createdAt: new Date(1_000).toISOString(),
    });

    meta.title = "新名";
    const renamed = await h.exporter.exportPending();
    expect(renamed).toEqual({ exported: 1, sessions: 1 });
    byId = eventsById(h.eventStore);
    expect(byId.get("screate:s1:r2")!.payload.title).toBe("新名");
    expect(h.eventStore.getLocalEvents()
      .filter((event) => event.eventId.startsWith("screate:s1:"))
      .map((event) => event.eventId)).toEqual(["screate:s1:r1", "screate:s1:r2"]);

    meta.title = "新名";
    expect((await h.exporter.exportPending()).exported).toBe(0);

    const longTitle = "长".repeat(260);
    meta.title = longTitle;
    await h.exporter.exportPending();
    const r3 = eventsById(h.eventStore).get("screate:s1:r3")!;
    expect(r3.payload.title).toBe(longTitle.slice(0, 200));
    expect((r3.payload.title as string).length).toBe(200);

    // 截断后与 lastTitle 相同：不再发新修订。
    meta.title = `${longTitle.slice(0, 200)}后缀`;
    expect((await h.exporter.exportPending()).exported).toBe(0);
  });

  it("空会话：仅 session.create，水位保持 0，重复导出零新增", async () => {
    const h = await createHarness();
    addMeta(h, { id: "s1", title: "空会话", createdAt: 1_000 });
    expect(await h.exporter.exportPending()).toEqual({ exported: 1, sessions: 1 });
    expect(h.state.conversations.s1).toEqual({ exportedThroughSeq: 0, titleRevision: 1, lastTitle: "空会话" });
    expect(await h.exporter.exportPending()).toEqual({ exported: 0, sessions: 0 });
    expect(h.eventStore.getLocalCount()).toBe(1);
  });

  it("幂等：state 落盘 + store 重开后重复执行零新增，水位推进到 audit 最大 seq", async () => {
    const h = await createHarness();
    addMeta(h, { id: "s1", title: "t", createdAt: 1_000 });
    await h.journal.appendUser("s1", { turnId: "u1", text: "问", at: 2_000 });
    await appendAssistant(h.journal, "s1", "run1", "a1", "答");
    await h.journal.appendPresentation("s1", "a1", 1, { content: "答" });
    await h.exporter.exportPending();

    const before = { lamport: h.state.lamport, seq: h.state.seq, count: h.eventStore.getLocalCount() };
    const audit = await h.transcriptStore.readAuditEntries("s1");
    expect(h.state.conversations.s1.exportedThroughSeq).toBe(audit.at(-1)!.seq);

    await saveSyncState(h.syncDir, h.state);
    const reopenedStore = await SyncEventStore.open({ syncDir: h.syncDir });
    const reloadedState = await loadSyncState(h.syncDir);
    const exporter = buildExporter(h, { state: reloadedState, store: reopenedStore });

    expect(await exporter.exportPending()).toEqual({ exported: 0, sessions: 0 });
    expect(reopenedStore.getLocalCount()).toBe(before.count);
    expect(reloadedState.lamport).toBe(before.lamport);
    expect(reloadedState.seq).toBe(before.seq);
  });

  it("崩溃重入：state 落后重扫不重复导出，新事件时钟严格大于 outbox 高水位", async () => {
    const h = await createHarness();
    addMeta(h, { id: "s1", title: "t", createdAt: 1_000 });
    await h.journal.appendUser("s1", { turnId: "u1", text: "第一问", at: 2_000 });
    await appendAssistant(h.journal, "s1", "run1", "a1", "第一答");
    await h.exporter.exportPending();

    const afterFirst = h.eventStore.getLocalEvents();
    const highLamport = Math.max(...afterFirst.map((event) => event.lamport));
    const highSeq = Math.max(...afterFirst.map((event) => event.seq));

    await h.journal.appendUser("s1", { turnId: "u2", text: "第二问", at: 5_000 });
    await appendAssistant(h.journal, "s1", "run2", "a2", "第二答");

    // 模拟「事件 append 成功但 state 未持久化」：state 回退到导出前（deviceId 保留）。
    h.state.lamport = 0;
    h.state.seq = 0;
    h.state.conversations = {};

    const reopenedStore = await SyncEventStore.open({ syncDir: h.syncDir });
    const exporter = buildExporter(h, { store: reopenedStore });
    const result = await exporter.exportPending();

    expect(result).toEqual({ exported: 2, sessions: 1 });
    expect(reopenedStore.getLocalCount()).toBe(afterFirst.length + 2);
    const all = reopenedStore.getLocalEvents();
    expect(new Set(all.map((event) => event.eventId)).size).toBe(all.length);

    const existingIds = new Set(afterFirst.map((event) => event.eventId));
    const fresh = all.filter((event) => !existingIds.has(event.eventId));
    expect(fresh.map((event) => event.eventId).sort()).toEqual(["run2:assistant:n0", "user:u2:r1"]);
    for (const event of fresh) {
      expect(event.lamport).toBeGreaterThan(highLamport);
      expect(event.seq).toBeGreaterThan(highSeq);
    }
    // 重扫不重复分配 screate；水位推进到 audit 最大 seq。
    expect(all.filter((event) => event.eventId === "screate:s1:r1")).toHaveLength(1);
    const audit = await h.transcriptStore.readAuditEntries("s1");
    expect(h.state.conversations.s1.exportedThroughSeq).toBe(audit.at(-1)!.seq);
  });

  it("会话按 createdAt 升序（并列按 id）；全局 lamport / seq 严格单调", async () => {
    const h = await createHarness();
    addMeta(h, { id: "z", title: "同刻", createdAt: 5_000 });
    addMeta(h, { id: "a", title: "同刻", createdAt: 5_000 });
    addMeta(h, { id: "m", title: "更早", createdAt: 1_000 });
    await h.journal.appendUser("m", { turnId: "um", text: "m", at: 1_100 });
    await h.journal.appendUser("z", { turnId: "uz", text: "z", at: 5_100 });
    await h.journal.appendUser("a", { turnId: "ua", text: "a", at: 5_200 });

    await h.exporter.exportPending();
    const events = h.eventStore.getLocalEvents();
    expect(events.map((event) => event.eventId)).toEqual([
      "screate:m:r1", "user:um:r1",
      "screate:a:r1", "user:ua:r1",
      "screate:z:r1", "user:uz:r1",
    ]);
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index].lamport).toBeGreaterThan(events[index - 1].lamport);
      expect(events[index].seq).toBeGreaterThan(events[index - 1].seq);
    }
  });

  it("不导出 compaction_checkpoint / presentation_patch 等条目自身", async () => {
    const h = await createHarness();
    addMeta(h, { id: "s1", title: "t", createdAt: 1_000 });
    await h.journal.appendUser("s1", { turnId: "u1", text: "问", at: 2_000 });
    await appendAssistant(h.journal, "s1", "run1", "a1", "答");
    await h.journal.appendPresentation("s1", "a1", 1, { content: "答" });
    await h.transcriptStore.append("s1", {
      kind: "compaction_checkpoint",
      id: "cp1",
      at: 4_000,
      payload: {
        baseThroughSeq: 0,
        sourceThroughSeq: 2,
        sourceDigest: "digest",
        replacement: { role: "assistant", content: "摘要" },
        trigger: "manual",
      },
    });

    await h.exporter.exportPending();
    const ids = h.eventStore.getLocalEvents().map((event) => event.eventId);
    expect(ids).not.toContain("presentation:a1:r1");
    expect(ids).not.toContain("cp1");
  });

  it("迁移驱动：对全量会话按序调用 ensureMigrated（含无新事件轮次）", async () => {
    const h = await createHarness();
    addMeta(h, { id: "z", title: "z", createdAt: 5_000 });
    addMeta(h, { id: "a", title: "a", createdAt: 1_000 });
    await h.journal.appendUser("a", { turnId: "ua", text: "a", at: 1_100 });

    const readSpy = vi.spyOn(h.transcriptStore, "readAuditEntries");
    await h.exporter.exportPending();
    expect(h.ensureMigrated.mock.calls.map(([sessionId]) => sessionId)).toEqual(["a", "z"]);
    const ensureOrder = h.ensureMigrated.mock.invocationCallOrder;
    const readOrder = readSpy.mock.invocationCallOrder;
    expect(ensureOrder).toHaveLength(2);
    expect(readOrder).toHaveLength(2);
    for (let index = 0; index < ensureOrder.length; index += 1) {
      expect(ensureOrder[index]).toBeLessThan(readOrder[index]);
    }

    await h.exporter.exportPending();
    expect(h.ensureMigrated.mock.calls.map(([sessionId]) => sessionId)).toEqual(["a", "z", "a", "z"]);
  });
});
