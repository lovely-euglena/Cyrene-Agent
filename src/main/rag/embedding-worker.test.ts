import { describe, expect, it, vi } from "vitest";
import {
  EmbeddingWorkerClient,
  type EmbeddingWorkerPort,
} from "./embedding-worker";

interface ControlledWorker {
  worker: EmbeddingWorkerPort;
  emit: (message: unknown) => void;
  emitExit: (code: number) => void;
  posted: Array<{ message: any; transfer?: unknown[] }>;
  terminate: ReturnType<typeof vi.fn>;
}

function createControlledWorker(): ControlledWorker {
  const posted: Array<{ message: any; transfer?: unknown[] }> = [];
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const on = (event: string, listener: (...args: any[]) => void) => {
    const entries = listeners.get(event) ?? [];
    entries.push(listener);
    listeners.set(event, entries);
  };
  const terminate = vi.fn().mockResolvedValue(0);
  return {
    worker: {
      postMessage: (message: any, transfer?: unknown[]) => {
        posted.push({ message, transfer });
      },
      on: on as EmbeddingWorkerPort["on"],
      unref: vi.fn(),
      terminate,
    },
    emit: (message: unknown) => listeners.get("message")?.forEach((l) => l(message)),
    emitExit: (code: number) => listeners.get("exit")?.forEach((l) => l(code)),
    posted,
    terminate,
  };
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeResult(requestId: number, dim: number, count: number): any {
  const buffers = Array.from({ length: count }, () => {
    const buffer = new ArrayBuffer(dim * 4);
    new Float32Array(buffer).fill(1);
    return buffer;
  });
  return { type: "result", requestId, dim, buffers };
}

describe("EmbeddingWorkerClient", () => {
  it("performs init handshake then resolves embed requests by requestId", async () => {
    const controlled = createControlledWorker();
    const client = new EmbeddingWorkerClient(() => controlled.worker);

    const pending = client.embedTexts("bgem3", ["hello"]);
    // 握手未完成前只有 init 消息
    expect(controlled.posted.map((p) => p.message.type)).toEqual(["init"]);
    expect(controlled.posted[0].message).toMatchObject({ modelKey: "bgem3" });
    expect(controlled.worker.unref).toHaveBeenCalled();

    controlled.emit({ type: "ready", requestId: 1 });
    await flushMicrotasks();
    expect(controlled.posted[1].message).toMatchObject({ type: "embed", texts: ["hello"] });

    controlled.emit(makeResult(2, 4, 1));

    const vectors = await pending;
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0].length).toBe(4);
    expect(client.getWorkerDiagnostics().workerRunning).toBe(true);
  });

  it("rejects embed request when worker reports an error message", async () => {
    const controlled = createControlledWorker();
    const client = new EmbeddingWorkerClient(() => controlled.worker);

    const pending = client.embedTexts("bgem3", ["hello"]);
    controlled.emit({ type: "ready", requestId: 1 });
    await flushMicrotasks();
    controlled.emit({ type: "error", requestId: 2, reason: "model missing" });

    await expect(pending).rejects.toThrow(/model missing/);
    // 出错请求已从 pending 表清理
    expect(client.getWorkerDiagnostics().pendingRequests).toBe(0);
  });

  it("fails pending requests when the worker exits after the request was posted", async () => {
    const workers: ControlledWorker[] = [];
    const client = new EmbeddingWorkerClient(() => {
      const controlled = createControlledWorker();
      workers.push(controlled);
      return controlled.worker;
    });

    const pending = client.embedTexts("bgem3", ["hello"]);
    workers[0].emit({ type: "ready", requestId: 1 });
    await flushMicrotasks(); // embed 已发出、在 pending 表里
    workers[0].emitExit(1);

    await expect(pending).rejects.toThrow(/exited with code 1/);
    expect(client.getWorkerDiagnostics().workerRunning).toBe(false);

    // 下一次调用应当重启 worker（新的 init 握手、requestId 续号）
    const second = client.embedTexts("bgem3", ["world"]);
    expect(workers).toHaveLength(2);
    expect(workers[1].posted[0].message).toMatchObject({ type: "init", modelKey: "bgem3" });
    expect(workers[1].posted[0].message.requestId).toBeGreaterThan(1);
    workers[1].emit({ type: "ready", requestId: workers[1].posted[0].message.requestId });
    await flushMicrotasks();
    workers[1].emit(makeResult(workers[1].posted[1].message.requestId, 4, 1));
    await expect(second).resolves.toHaveProperty("0.length", 4);
  });

  it("retries through a respawn when the worker dies between ready and embed (race window)", async () => {
    const workers: ControlledWorker[] = [];
    const client = new EmbeddingWorkerClient(() => {
      const controlled = createControlledWorker();
      workers.push(controlled);
      return controlled.worker;
    });

    const pending = client.embedTexts("bgem3", ["hello"]);
    workers[0].emit({ type: "ready", requestId: 1 });
    // 不 flush：boot 刚 resolve、embed 尚未发出时 worker 立即崩溃
    workers[0].emitExit(1);

    // ensureActiveWorker 检测到 this.worker 已被清空 → 内部重试 → 新 worker
    await flushMicrotasks();
    expect(workers).toHaveLength(2);
    expect(workers[1].posted[0].message).toMatchObject({ type: "init", modelKey: "bgem3" });
    workers[1].emit({ type: "ready", requestId: workers[1].posted[0].message.requestId });
    await flushMicrotasks();
    workers[1].emit(makeResult(workers[1].posted[1].message.requestId, 4, 1));
    await expect(pending).resolves.toHaveProperty("0.length", 4);
  });

  it("returns empty array without spawning a worker for empty input", async () => {
    const createWorker = vi.fn(() => createControlledWorker().worker);
    const client = new EmbeddingWorkerClient(createWorker);

    expect(await client.embedTexts("bgem3", [])).toEqual([]);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("late exit/error from a replaced worker does not clobber the new worker", async () => {
    const workers: ControlledWorker[] = [];
    const client = new EmbeddingWorkerClient(() => {
      const controlled = createControlledWorker();
      workers.push(controlled);
      return controlled.worker;
    });

    // 第一个请求：worker 0 完成
    const first = client.embedTexts("bgem3", ["hello"]);
    workers[0].emit({ type: "ready", requestId: 1 });
    await flushMicrotasks();
    workers[0].emit(makeResult(2, 4, 1));
    await first;

    // 切模型 → worker 1 启动并 ready
    const second = client.embedTexts("bgem3-alt", ["world"]);
    expect(workers[0].terminate).toHaveBeenCalled();
    expect(workers).toHaveLength(2);
    const initId = workers[1].posted[0].message.requestId;
    workers[1].emit({ type: "ready", requestId: initId });
    await flushMicrotasks();

    // 旧 worker 的 exit 事件此刻才晚到（terminate 是异步的）：
    // 新 worker 的 pending 与引用不能被误杀
    workers[0].emitExit(0);

    // 新 worker 正常完成请求
    workers[1].emit(makeResult(workers[1].posted[1].message.requestId, 4, 1));
    await expect(second).resolves.toHaveProperty("0.length", 4);
    // 诊断仍显示 worker 1 在运行（未被 resetForRespawn 清掉）
    expect(client.getWorkerDiagnostics().workerRunning).toBe(true);
  });

  it("terminates the old worker and respawns when the model key changes", async () => {
    const workers: ControlledWorker[] = [];
    const client = new EmbeddingWorkerClient(() => {
      const controlled = createControlledWorker();
      workers.push(controlled);
      return controlled.worker;
    });

    const first = client.embedTexts("bgem3", ["hello"]);
    workers[0].emit({ type: "ready", requestId: 1 });
    await flushMicrotasks();
    workers[0].emit(makeResult(2, 4, 1));
    await first;

    // 切换模型 key：旧 worker 应被 terminate，新 worker 重新握手
    const second = client.embedTexts("bgem3-alt", ["world"]);
    expect(workers[0].terminate).toHaveBeenCalled();
    expect(workers[1].posted[0].message).toMatchObject({ type: "init", modelKey: "bgem3-alt" });
    const initId = workers[1].posted[0].message.requestId;
    workers[1].emit({ type: "ready", requestId: initId });
    await flushMicrotasks();
    workers[1].emit(makeResult(workers[1].posted[1].message.requestId, 4, 1));
    await second;
    expect(client.getWorkerDiagnostics().modelKey).toBe("bgem3-alt");
  });

  it("dispose rejects pending requests and clears state", async () => {
    const controlled = createControlledWorker();
    const client = new EmbeddingWorkerClient(() => controlled.worker);

    const pending = client.embedTexts("bgem3", ["hello"]);
    client.dispose("test");

    await expect(pending).rejects.toThrow(/Embedding worker disposed: test/);
    expect(client.getWorkerDiagnostics().workerRunning).toBe(false);
  });
});
