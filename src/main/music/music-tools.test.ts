import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeWindowsClient } from "../windows/native-windows-host";

vi.mock("../windows/native-windows-bridge", () => ({
  getActiveNativeClient: vi.fn(),
}));
vi.mock("./music-manager", () => ({
  getMusicAgentAccess: vi.fn(),
}));

import { getActiveNativeClient } from "../windows/native-windows-bridge";
import { getMusicAgentAccess } from "./music-manager";
import { musicLibraryTool, musicManageTool, musicNowPlayingTool, musicPlayTool } from "./music-tools";

const mockedClient = vi.mocked(getActiveNativeClient);
const mockedAccess = vi.mocked(getMusicAgentAccess);

function fakeClient(response: unknown = { ok: true }) {
  const requestData = vi.fn().mockResolvedValue(response);
  return { requestData } as unknown as NativeWindowsClient & { requestData: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  mockedAccess.mockReturnValue("read");
  mockedClient.mockReturnValue(null);
});

describe("音乐工具权限档（fail-closed）", () => {
  it("off：四个工具全部拒绝，不发起请求", async () => {
    mockedAccess.mockReturnValue("off");
    const client = fakeClient();
    mockedClient.mockReturnValue(client as unknown as NativeWindowsClient);
    for (const tool of [musicLibraryTool, musicNowPlayingTool, musicPlayTool, musicManageTool]) {
      const result = await tool.execute({ action: "list" });
      expect(result).toContain("音乐权限不足");
    }
    expect(client.requestData).not.toHaveBeenCalled();
  });

  it("read：查询可用，控制/管理拒绝", async () => {
    const client = fakeClient({ tracks: [], total: 0, folders: [], scanning: false });
    mockedClient.mockReturnValue(client as unknown as NativeWindowsClient);
    expect(await musicLibraryTool.execute({})).toContain("total");
    expect(await musicNowPlayingTool.execute({})).toBeTruthy();
    expect(await musicPlayTool.execute({})).toContain("音乐权限不足");
    expect(await musicManageTool.execute({ action: "rescan" })).toContain("音乐权限不足");
  });

  it("control：播放可用，管理仍拒绝", async () => {
    mockedAccess.mockReturnValue("control");
    const client = fakeClient({ ok: true, nowPlaying: { status: "playing" } });
    mockedClient.mockReturnValue(client as unknown as NativeWindowsClient);
    expect(await musicPlayTool.execute({ search: "周杰伦" })).toContain("playing");
    expect(await musicManageTool.execute({ action: "list" })).toContain("音乐权限不足");
  });

  it("manage：管理可用", async () => {
    mockedAccess.mockReturnValue("manage");
    const client = fakeClient({ ok: true, folders: [{ path: "D:/Music", trackCount: 2 }] });
    mockedClient.mockReturnValue(client as unknown as NativeWindowsClient);
    const result = await musicManageTool.execute({ action: "add-folder", path: "D:/Music" });
    expect(result).toContain("D:/Music");
    expect(client.requestData).toHaveBeenCalledWith({ op: "music.folders", action: "add", path: "D:/Music" });
  });

  it("native 组件不可用时返回可操作错误", async () => {
    const result = await musicLibraryTool.execute({});
    expect(result).toContain("原生窗口组件未启用");
  });
});

describe("音乐工具请求形状", () => {
  it("music_play：搜索播放 → music.play；next → music.control", async () => {
    mockedAccess.mockReturnValue("control");
    const client = fakeClient({ ok: true, nowPlaying: { status: "playing" } });
    mockedClient.mockReturnValue(client as unknown as NativeWindowsClient);

    await musicPlayTool.execute({ search: " 周杰伦 " });
    expect(client.requestData).toHaveBeenNthCalledWith(1, { op: "music.play", search: "周杰伦" });

    await musicPlayTool.execute({ action: "next" });
    expect(client.requestData).toHaveBeenNthCalledWith(2, { op: "music.control", action: "next" });

    await musicPlayTool.execute({ action: "volume", volume: 55.4 });
    expect(client.requestData).toHaveBeenNthCalledWith(3, { op: "music.control", action: "volume", volume: 55 });
  });

  it("music_play：无目标无 action → toggle", async () => {
    mockedAccess.mockReturnValue("control");
    const client = fakeClient({ ok: true, nowPlaying: { status: "paused" } });
    mockedClient.mockReturnValue(client as unknown as NativeWindowsClient);
    await musicPlayTool.execute({});
    expect(client.requestData).toHaveBeenCalledWith({ op: "music.control", action: "toggle" });
  });

  it("music_manage：rescan → music.rescan；非法 action 拒绝", async () => {
    mockedAccess.mockReturnValue("manage");
    const client = fakeClient({ ok: true, scanning: true });
    mockedClient.mockReturnValue(client as unknown as NativeWindowsClient);
    await musicManageTool.execute({ action: "rescan" });
    expect(client.requestData).toHaveBeenCalledWith({ op: "music.rescan" });
    expect(await musicManageTool.execute({ action: "drop-table" })).toContain("action 仅支持");
  });
});
