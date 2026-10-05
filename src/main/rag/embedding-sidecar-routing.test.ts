// .NET embedding sidecar 客户端模型路由（IKIH28 第二引擎）：
//   - embed/search/doc-import 请求携带 modelDir + modelKey；
//   - 新 sidecar（池化路由）：ready 的 modelKey 与请求不符也直接试发，成功不重启；
//   - 旧 sidecar（无池）：响应维度与请求模型不符/请求失败 → 回收重启一次再试。
// 用受控 FakeChild（不 spawn 真进程）驱动帧协议。
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_MODELS } from "./embedding-pipeline";

const state = vi.hoisted(() => {
  const children: any[] = [];

  function createFakeChild(): any {
    const listeners = new Map<string, Array<(...args: any[]) => void>>();
    const on = (event: string, fn: (...args: any[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(fn);
      listeners.set(event, arr);
      return child;
    };
    const once = (event: string, fn: (...args: any[]) => void) => {
      const wrapper = (...args: any[]) => {
        const arr = listeners.get(event) ?? [];
        const index = arr.indexOf(wrapper);
        if (index >= 0) arr.splice(index, 1);
        fn(...args);
      };
      return on(event, wrapper);
    };
    const emit = (event: string, ...args: any[]) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
    };

    const stdinState = { buffer: Buffer.alloc(0), frames: [] as Array<{ header: any; json: string }> };
    const stdin = {
      end: () => undefined,
      on: () => undefined,
      write: (chunk: Buffer | string) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        stdinState.buffer = Buffer.concat([stdinState.buffer, buf]);
        while (stdinState.buffer.length >= 4) {
          const length = stdinState.buffer.readInt32LE(0);
          if (length <= 0 || stdinState.buffer.length < 4 + length) break;
          const json = stdinState.buffer.subarray(4, 4 + length).toString("utf8");
          stdinState.buffer = stdinState.buffer.subarray(4 + length);
          stdinState.frames.push({ header: JSON.parse(json), json });
        }
        return true;
      },
    };

    const stdoutListeners = new Map<string, Array<(...args: any[]) => void>>();
    const stdout = {
      on: (event: string, fn: (...args: any[]) => void) => {
        const arr = stdoutListeners.get(event) ?? [];
        arr.push(fn);
        stdoutListeners.set(event, arr);
      },
    };
    const emitStdout = (event: string, ...args: any[]) => {
      for (const fn of [...(stdoutListeners.get(event) ?? [])]) fn(...args);
    };

    const frameBytes = (header: Record<string, unknown>, vectors: Float32Array[]) => {
      const json = Buffer.from(JSON.stringify(header), "utf8");
      const prefix = Buffer.alloc(4);
      prefix.writeInt32LE(json.length);
      const parts: Buffer[] = [prefix, json];
      for (const vector of vectors) {
        parts.push(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
      }
      return Buffer.concat(parts);
    };

    const child: any = {
      stdin,
      stdout,
      exitCode: null as number | null,
      on,
      once,
      emit,
      kill: () => {
        queueMicrotask(() => {
          child.exitCode = 1;
          emit("exit", 1);
        });
        return true;
      },
      emitReady: (modelKey: string, dim: number) => {
        emitStdout("data", frameBytes({ id: 0, op: "ready", modelKey, dim }, []));
      },
      emitVectors: (requestId: number, vectors: Float32Array[], headerExtra: Record<string, unknown> = {}) => {
        const dim = vectors[0]?.length ?? 0;
        emitStdout("data", frameBytes({ id: requestId, ok: true, count: vectors.length, dim, ...headerExtra }, vectors));
      },
      emitErrorResponse: (requestId: number, error: string) => {
        emitStdout("data", frameBytes({ id: requestId, ok: false, error }, []));
      },
      lastHeader: () => stdinState.frames[stdinState.frames.length - 1]?.header,
      frames: () => stdinState.frames.map((frame) => frame.header),
    };
    return child;
  }

  return { children, createFakeChild };
});

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "/tmp/cyrene-sidecar-test",
    getAppPath: () => "/tmp/cyrene-sidecar-test",
  },
}));

vi.mock("child_process", () => ({
  spawn: () => {
    const child = state.createFakeChild();
    state.children.push(child);
    return child;
  },
}));

vi.mock("../child-processes", () => ({ trackChildProcess: () => undefined }));

vi.mock("./model-status", () => ({
  getProjectModelDir: (kind: string, modelKey: string) => `/models/${kind}/${modelKey}`,
}));

import { EmbeddingSidecarClient } from "./embedding-sidecar";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const vector = (dims: number, fill = 0.5) => new Float32Array(dims).fill(fill);

function lastChild(): any {
  return state.children[state.children.length - 1];
}

afterEach(() => {
  state.children.length = 0;
});

describe("EmbeddingSidecarClient: 模型路由", () => {
  it("embed 请求携带 modelDir + modelKey（启动默认=请求模型）", async () => {
    const client = new EmbeddingSidecarClient("fake.exe");
    const dims = LOCAL_MODELS.bgem3.dims;

    const pending = client.embedTexts("bgem3", ["hello"]);
    expect(state.children).toHaveLength(1);
    lastChild().emitReady("bgem3", dims);
    await flush();

    const header = lastChild().lastHeader();
    expect(header).toMatchObject({
      op: "embed",
      modelKey: "bgem3",
      modelDir: "/models/embedding/bgem3",
      texts: ["hello"],
    });

    lastChild().emitVectors(header.id, [vector(dims)]);
    const vectors = await pending;
    expect(vectors[0].length).toBe(dims);
  });

  it("新 sidecar 池化路由：ready modelKey 不符但响应正确 → 不重启", async () => {
    const client = new EmbeddingSidecarClient("fake.exe");
    const bgem3Dims = LOCAL_MODELS.bgem3.dims;
    const e5Dims = LOCAL_MODELS["e5-small"].dims;

    // 进程按 bgem3 启动
    const first = client.embedTexts("bgem3", ["a"]);
    lastChild().emitReady("bgem3", bgem3Dims);
    await flush();
    lastChild().emitVectors(lastChild().lastHeader().id, [vector(bgem3Dims)]);
    await first;

    // 请求 e5-small：新协议带 modelDir/modelKey 让池路由，成功则不回收
    const second = client.embedTexts("e5-small", ["b"]);
    await flush();
    expect(state.children).toHaveLength(1);
    const header = lastChild().lastHeader();
    expect(header).toMatchObject({ modelKey: "e5-small", modelDir: "/models/embedding/e5-small" });
    lastChild().emitVectors(header.id, [vector(e5Dims)]);

    const vectors = await second;
    expect(vectors[0].length).toBe(e5Dims);
    expect(state.children).toHaveLength(1);
  });

  it("旧 sidecar（无池）响应维度不符 → 回退重启一次，用请求模型重试", async () => {
    const client = new EmbeddingSidecarClient("fake.exe");
    const bgem3Dims = LOCAL_MODELS.bgem3.dims;
    const e5Dims = LOCAL_MODELS["e5-small"].dims;

    const first = client.embedTexts("bgem3", ["a"]);
    lastChild().emitReady("bgem3", bgem3Dims);
    await flush();
    lastChild().emitVectors(lastChild().lastHeader().id, [vector(bgem3Dims)]);
    await first;
    expect(state.children).toHaveLength(1);

    // 旧进程忽略 modelDir，用 bgem3 算了 e5-small 的请求 → 1024 维 ≠ 384
    const second = client.embedTexts("e5-small", ["b"]);
    await flush();
    const staleHeader = lastChild().lastHeader();
    expect(staleHeader).toMatchObject({ modelKey: "e5-small" });
    lastChild().emitVectors(staleHeader.id, [vector(bgem3Dims)]);

    // 客户端检测维度不符 → dispose + 重新 spawn（新进程按 e5-small 启动）
    await flush();
    expect(state.children).toHaveLength(2);
    lastChild().emitReady("e5-small", e5Dims);
    await flush();
    const retryHeader = lastChild().lastHeader();
    expect(retryHeader).toMatchObject({
      modelKey: "e5-small",
      modelDir: "/models/embedding/e5-small",
    });
    lastChild().emitVectors(retryHeader.id, [vector(e5Dims)]);

    const vectors = await second;
    expect(vectors[0].length).toBe(e5Dims);
    expect(state.children).toHaveLength(2);
  });

  it("请求失败（旧进程行为不符）→ 重启一次后成功", async () => {
    const client = new EmbeddingSidecarClient("fake.exe");
    const bgem3Dims = LOCAL_MODELS.bgem3.dims;
    const e5Dims = LOCAL_MODELS["e5-small"].dims;

    const first = client.embedTexts("bgem3", ["a"]);
    lastChild().emitReady("bgem3", bgem3Dims);
    await flush();
    lastChild().emitVectors(lastChild().lastHeader().id, [vector(bgem3Dims)]);
    await first;

    const second = client.embedTexts("e5-small", ["b"]);
    await flush();
    const failedHeader = lastChild().lastHeader();
    // 旧 sidecar 回显错误（例如不认识池协议）
    lastChild().emitErrorResponse(failedHeader.id, "unsupported model");

    await flush();
    expect(state.children).toHaveLength(2);
    lastChild().emitReady("e5-small", e5Dims);
    await flush();
    const retryHeader = lastChild().lastHeader();
    lastChild().emitVectors(retryHeader.id, [vector(e5Dims)]);

    await expect(second).resolves.toHaveProperty("0.length", e5Dims);
  });
});

describe("EmbeddingSidecarClient: 请求字段透传（P2-8①）", () => {
  it("search 请求携带 modelDir + modelKey（池按目录路由）", async () => {
    const client = new EmbeddingSidecarClient("fake.exe");
    const e5Dims = LOCAL_MODELS["e5-small"].dims;

    const pending = client.searchHybrid("e5-small", { ragDataDir: "/rag", query: "hello", topK: 3 });
    lastChild().emitReady("e5-small", e5Dims);
    await flush();

    const header = lastChild().lastHeader();
    expect(header).toMatchObject({
      op: "search",
      modelKey: "e5-small",
      modelDir: "/models/embedding/e5-small",
      ragDataDir: "/rag",
      query: "hello",
      topK: 3,
    });
    lastChild().emitVectors(header.id, [], { dim: e5Dims, results: [] });
    await expect(pending).resolves.toMatchObject({ entries: [] });
  });

  it("rerank 请求显式携带 rerankerDir（不依赖启动默认）", async () => {
    const client = new EmbeddingSidecarClient("fake.exe");
    const bgem3Dims = LOCAL_MODELS.bgem3.dims;

    const pending = client.rerankScores("query", ["doc-a"], "/models/reranker/bge-reranker-v2-m3");
    lastChild().emitReady("bgem3", bgem3Dims);
    await flush();

    const header = lastChild().lastHeader();
    expect(header).toMatchObject({
      op: "rerank",
      query: "query",
      documents: ["doc-a"],
      rerankerDir: "/models/reranker/bge-reranker-v2-m3",
    });
    lastChild().emitVectors(header.id, [new Float32Array([0.7])]);
    const scores = await pending;
    expect(scores).toHaveLength(1);
    expect(scores[0]).toBeCloseTo(0.7, 5);
  });

  it("doc-import 请求携带 modelDir + modelKey，响应回显一致时通过", async () => {
    const client = new EmbeddingSidecarClient("fake.exe");
    const e5Dims = LOCAL_MODELS["e5-small"].dims;

    const pending = client.docImport("e5-small", { filePath: "D:/docs/a.pdf", ragDataDir: "/rag" });
    lastChild().emitReady("e5-small", e5Dims);
    await flush();

    const header = lastChild().lastHeader();
    expect(header).toMatchObject({
      op: "doc-import",
      modelKey: "e5-small",
      modelDir: "/models/embedding/e5-small",
      filePath: "D:/docs/a.pdf",
      ragDataDir: "/rag",
    });
    lastChild().emitVectors(header.id, [], { dim: e5Dims, modelKey: "e5-small", kind: "pdf", chunks: 3 });
    await expect(pending).resolves.toMatchObject({ kind: "pdf", chunks: 3 });
  });
});

describe("EmbeddingSidecarClient: doc-import 路由确认（P1-2，旧 exe）", () => {
  it("旧 exe：响应无 dim/modelKey 且进程非请求模型 → 先重启再发，不静默接受", async () => {
    const client = new EmbeddingSidecarClient("fake.exe");
    const bgem3Dims = LOCAL_MODELS.bgem3.dims;
    const e5Dims = LOCAL_MODELS["e5-small"].dims;

    // 进程按 bgem3 启动（旧 exe）
    const first = client.embedTexts("bgem3", ["a"]);
    lastChild().emitReady("bgem3", bgem3Dims);
    await flush();
    lastChild().emitVectors(lastChild().lastHeader().id, [vector(bgem3Dims)]);
    await first;

    const pending = client.docImport("e5-small", { filePath: "D:/docs/a.pdf", ragDataDir: "/rag" });
    await flush();
    await flush();

    // 旧进程上不得发出 doc-import（错模型向量不可撤销）；已按 e5-small 重启
    expect(state.children).toHaveLength(2);
    expect(state.children[0].lastHeader().op).toBe("embed");

    // 旧 exe ready 键仍失真（恒报 bgem3），但 dim 如实 384 → 确认路由
    lastChild().emitReady("bgem3", e5Dims);
    await flush();
    const header = lastChild().lastHeader();
    expect(header).toMatchObject({ op: "doc-import", modelKey: "e5-small" });
    // 旧 exe 响应无 dim/modelKey：ready 维度已确认 → 接受（路由由 spawn 参数保证）
    lastChild().emitVectors(header.id, [], { kind: "pdf", chunks: 3 });
    await expect(pending).resolves.toMatchObject({ kind: "pdf", chunks: 3 });
  });

  it("旧 exe：重启后 ready 维度仍无法确认 → 失败，不发请求（不写入错误向量）", async () => {
    const client = new EmbeddingSidecarClient("fake.exe");
    const bgem3Dims = LOCAL_MODELS.bgem3.dims;

    const first = client.embedTexts("bgem3", ["a"]);
    lastChild().emitReady("bgem3", bgem3Dims);
    await flush();
    lastChild().emitVectors(lastChild().lastHeader().id, [vector(bgem3Dims)]);
    await first;

    // 立即挂 rejection 处理器，避免异步拒绝被 Node 记为 unhandled
    const outcome = client
      .docImport("e5-small", { filePath: "D:/docs/a.pdf", ragDataDir: "/rag" })
      .then(() => null, (error: Error) => error);
    await flush();
    await flush();
    expect(state.children).toHaveLength(2);

    // 重启后 ready 维度仍与请求不符 → 无法确认路由
    lastChild().emitReady("bgem3", bgem3Dims);
    await flush();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/cannot confirm routing after restart/);
    // 不得向进程发出 doc-import 请求
    expect(state.children[1].frames().some((header) => header.op === "doc-import")).toBe(false);
  });
});

describe("EmbeddingSidecarClient: 回退重启健壮性（P2-5）", () => {
  it("ready 键失真（旧 exe 恒报 bgem3）时，bgem3 请求的维度不符也触发回退", async () => {
    const client = new EmbeddingSidecarClient("fake.exe");
    const bgem3Dims = LOCAL_MODELS.bgem3.dims;
    const e5Dims = LOCAL_MODELS["e5-small"].dims;

    // 首个请求 e5-small：进程实际按 e5 启动，但旧 exe ready 恒报 bgem3
    const first = client.embedTexts("e5-small", ["a"]);
    lastChild().emitReady("bgem3", e5Dims);
    await flush();
    lastChild().emitVectors(lastChild().lastHeader().id, [vector(e5Dims)]);
    await first;

    // 请求 bgem3：possiblyUnrouted = (bgem3 === bgem3) = false，但实际进程是 e5
    const second = client.embedTexts("bgem3", ["b"]);
    await flush();
    const staleHeader = lastChild().lastHeader();
    lastChild().emitVectors(staleHeader.id, [vector(e5Dims)]);

    await flush();
    expect(state.children).toHaveLength(2);
    lastChild().emitReady("bgem3", bgem3Dims);
    await flush();
    const retryHeader = lastChild().lastHeader();
    expect(retryHeader).toMatchObject({ modelKey: "bgem3", modelDir: "/models/embedding/bgem3" });
    lastChild().emitVectors(retryHeader.id, [vector(bgem3Dims)]);

    await expect(second).resolves.toHaveProperty("0.length", bgem3Dims);
  });

  it("并发回退单飞：两次回退串行重启，互不打断（均成功）", async () => {
    const client = new EmbeddingSidecarClient("fake.exe");
    const bgem3Dims = LOCAL_MODELS.bgem3.dims;
    const e5Dims = LOCAL_MODELS["e5-small"].dims;

    const first = client.embedTexts("bgem3", ["a"]);
    lastChild().emitReady("bgem3", bgem3Dims);
    await flush();
    lastChild().emitVectors(lastChild().lastHeader().id, [vector(bgem3Dims)]);
    await first;

    // 两个 e5 请求并发进入回退
    const oldChild = state.children[0];
    const framesBefore = oldChild.frames().length;
    const requestA = client.embedTexts("e5-small", ["a1"]);
    const requestB = client.embedTexts("e5-small", ["b1"]);
    await flush();
    const embedFrames = oldChild.frames().slice(framesBefore).filter((header) => header.op === "embed");
    expect(embedFrames).toHaveLength(2);
    for (const frame of embedFrames) {
      oldChild.emitVectors(frame.id, [vector(bgem3Dims)]);
    }

    // A 先持锁重启并重试；B 排队等待，不会杀掉 A 的新进程
    await flush();
    await flush();
    expect(state.children).toHaveLength(2);
    lastChild().emitReady("e5-small", e5Dims);
    await flush();
    const retryA = lastChild().lastHeader();
    expect(retryA).toMatchObject({ modelKey: "e5-small" });
    lastChild().emitVectors(retryA.id, [vector(e5Dims)]);
    await expect(requestA).resolves.toHaveProperty("0.length", e5Dims);

    // A 完成后 B 才重启（串行单飞）
    await flush();
    await flush();
    expect(state.children).toHaveLength(3);
    lastChild().emitReady("e5-small", e5Dims);
    await flush();
    const retryB = lastChild().lastHeader();
    lastChild().emitVectors(retryB.id, [vector(e5Dims)]);
    await expect(requestB).resolves.toHaveProperty("0.length", e5Dims);
  });
});
