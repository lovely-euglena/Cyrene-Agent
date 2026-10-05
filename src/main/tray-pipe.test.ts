import { describe, expect, it } from "vitest";
import {
  __resetTrayPipeLinkForTests,
  __setTrayPipeLinkForTests,
  acquireTrayPipeLink,
  drainTrayLines,
  isTrayPipeAvailable,
  type TrayPipeLink,
} from "./tray-pipe";

describe("drainTrayLines（JSON 行分帧纯函数）", () => {
  it("切出完整行并保留残段", () => {
    const first = drainTrayLines("", '{"a":1}\n{"b"');
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.rest).toBe('{"b"');
    const second = drainTrayLines(first.rest, ':2}\n\n');
    expect(second.lines).toEqual(['{"b":2}']);
    expect(second.rest).toBe("");
  });

  it("CRLF 与空行容错", () => {
    const r = drainTrayLines("", '{"x":1}\r\n\n  \n');
    expect(r.lines).toEqual(['{"x":1}']);
    expect(r.rest).toBe("");
  });
});

describe("isTrayPipeAvailable", () => {
  it("返回布尔值（非 Windows / 无管道环境不抛异常）", () => {
    expect(typeof isTrayPipeAvailable()).toBe("boolean");
  });
});

describe("共享链路测试注入口", () => {
  it("注入替身后 acquire 返回替身；重置后恢复真实单例", () => {
    const fake: TrayPipeLink = {
      isConnected: () => false,
      connect: async () => false,
      send: () => { /* noop */ },
      onLine: () => () => { /* noop */ },
      onConnectionChange: () => () => { /* noop */ },
      dispose: () => { /* noop */ },
    };
    __setTrayPipeLinkForTests(fake);
    expect(acquireTrayPipeLink()).toBe(fake);
    __resetTrayPipeLinkForTests();
    expect(acquireTrayPipeLink()).not.toBe(fake);
    __resetTrayPipeLinkForTests();
  });
});
