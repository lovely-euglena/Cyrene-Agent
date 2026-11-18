import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startShellJob, subscribeShellJobTerminal, clearShellJobTerminalSubscribers } from "./shell-job-manager";

/** #182 终态事件订阅：settleJob 唯一入口发出、先到先得每任务至多一发、
 * 订阅方异常不影响其余订阅。 */
describe("subscribeShellJobTerminal", () => {
  const tempDirs: string[] = [];
  function makeLogDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-job-evt-"));
    tempDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    clearShellJobTerminalSubscribers();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settleJob 每任务至多发一次终态事件，快照字段完整", async () => {
    const events: Array<{ jobId: string; status: string; exitCode: number | null; command: string; logFile: string }> = [];
    const unsubscribe = subscribeShellJobTerminal((evt) => events.push(evt));
    const { jobId } = startShellJob({
      spec: { command: process.execPath, args: ["-e", "process.exit(3)"], cwd: process.cwd(), env: {}, windowsVerbatimArguments: false, ranViaSandbox: false },
      command: "node -e exit3",
      shell: "bash",
      logDir: makeLogDir(),
      totalMs: 10_000,
    });
    await vi.waitFor(() => expect(events.length).toBe(1), { timeout: 5_000 });
    expect(events[0].jobId).toBe(jobId);
    expect(events[0].status).toBe("exited");
    expect(events[0].exitCode).toBe(3);
    expect(events[0].command).toBe("node -e exit3");
    expect(events[0].logFile).toContain(jobId);
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(1); // 先到先得，不重复发
    unsubscribe();
  });

  it("订阅方抛错不影响其余订阅者", async () => {
    const seen: string[] = [];
    const off1 = subscribeShellJobTerminal(() => { throw new Error("boom"); });
    const off2 = subscribeShellJobTerminal((evt) => seen.push(evt.status));
    startShellJob({
      spec: { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd(), env: {}, windowsVerbatimArguments: false, ranViaSandbox: false },
      command: "node ok",
      shell: "bash",
      logDir: makeLogDir(),
      totalMs: 10_000,
    });
    await vi.waitFor(() => expect(seen.length).toBe(1), { timeout: 5_000 });
    expect(seen[0]).toBe("exited");
    off1();
    off2();
  });
});
