// 本地音乐 Agent 工具（music_library / music_now_playing / music_play / music_manage）：
//   - 播放与曲库在 cyrene-native 进程（MusicService），工具通过 native 帧协议读写；
//   - 权限：专用档 musicAgentAccess（off/read/control/manage），工具内 fail-closed；
//     档位在音乐窗口或 设置 → 偏好设置 → 音乐 中调整（宿主持久化）。
//
// risk 说明：音乐工具不触碰任意文件系统（曲库=用户显式添加的音乐文件夹），
// 播放控制与曲库管理由专用权限档作为唯一同意闸门，因此声明 safe；
// P2 标签/歌词写文件会额外叠加全局 fs-write 审批。

import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";
import { getActiveNativeClient } from "../windows/native-windows-bridge";
import { getMusicAgentAccess, type MusicAgentAccess } from "./music-manager";

interface MusicTrackDto {
  path: string;
  folder: string;
  title: string;
  artist: string;
  album: string;
  ext: string;
  size: number;
}

interface MusicNowPlaying {
  status: string;
  path: string | null;
  title: string;
  artist: string;
  album: string;
  positionSec: number;
  durationSec: number;
  paused: boolean;
  volume: number;
  mode: string;
  queueIndex: number;
  queueCount: number;
  hasLyrics: boolean;
  lyricLine: string;
  lyricTranslation: string | null;
}

interface MusicQueryData {
  tracks: MusicTrackDto[];
  total: number;
  folders: Array<{ path: string; trackCount: number }>;
  scanning: boolean;
}

const MUSIC_ACCESS_LABEL: Record<MusicAgentAccess, string> = {
  off: "关闭",
  read: "只读",
  control: "控制播放",
  manage: "管理曲库",
};

const MUSIC_ACCESS_RANK: Record<MusicAgentAccess, number> = { off: 0, read: 1, control: 2, manage: 3 };

function requireMusicAccess(required: MusicAgentAccess): string | null {
  const current = getMusicAgentAccess();
  if (MUSIC_ACCESS_RANK[current] >= MUSIC_ACCESS_RANK[required]) return null;
  return `[错误] 音乐权限不足（当前：${MUSIC_ACCESS_LABEL[current]}，需要：${MUSIC_ACCESS_LABEL[required]}）。请在音乐窗口或 设置 → 偏好设置 → 音乐 中调整。`;
}

async function musicRequest<T>(
  op: string,
  payload: Record<string, unknown> = {},
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const client = getActiveNativeClient();
  if (!client) {
    return { ok: false, error: "[错误] 原生窗口组件未启用，本地音乐不可用" };
  }
  try {
    const data = await client.requestData<T>({ op, ...payload });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: `[错误] 音乐组件请求失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function toTrackSummary(track: MusicTrackDto): Record<string, unknown> {
  return {
    path: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album,
    ext: track.ext,
  };
}

export const musicLibraryTool: ToolDefinition = {
  id: "music_library",
  name: "搜索本地音乐",
  description:
    "搜索本地音乐曲库（用户在音乐播放器中添加的文件夹）。返回匹配曲目的标题/歌手/专辑/路径与曲库统计。\n\n" +
    "何时用：\n" +
    "- 用户问'我本地有什么歌''找一下 XX 的歌''曲库里有多少首'\n" +
    "- 播放前先确认曲名/路径（再用 music_play）\n" +
    "- 用户问音乐文件夹列表\n\n" +
    "参数：search（可选，按标题/歌手/专辑模糊匹配）；folder（可选，限定音乐文件夹绝对路径）；limit（可选，默认 50，最大 200）。\n" +
    "需要音乐权限档 ≥ 只读（设置 → 偏好设置 → 音乐）。",
  enabled: true,
  risk: "safe",
  modes: ["work", "chat"],
  effectKind: "read" as const,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      search: { type: "string", description: "搜索词（标题/歌手/专辑，模糊匹配）" },
      folder: { type: "string", description: "限定音乐文件夹的绝对路径（可选）" },
      limit: { type: "number", description: "返回上限，默认 50，最大 200" },
    },
    required: [],
  },
  async execute(args) {
    const denied = requireMusicAccess("read");
    if (denied) return denied;
    const search = typeof args.search === "string" ? args.search.trim() : "";
    const folder = typeof args.folder === "string" ? args.folder : "";
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.round(args.limit))) : 50;
    const result = await musicRequest<MusicQueryData>("music.query", { search, folder, limit });
    if (!result.ok) return result.error;
    return JSON.stringify({
      total: result.data.total,
      scanning: result.data.scanning,
      folders: result.data.folders,
      tracks: result.data.tracks.map(toTrackSummary),
    });
  },
};

export const musicNowPlayingTool: ToolDefinition = {
  id: "music_now_playing",
  name: "当前播放",
  description:
    "查询本地音乐播放器当前状态：曲目、进度、暂停、音量、播放模式与当前歌词行（含翻译）。\n\n" +
    "何时用：\n" +
    "- 用户问'现在在放什么''这首歌叫什么''放到哪了''这句歌词是什么'\n" +
    "- 想围绕正在播放的音乐聊天\n\n" +
    "无参数。需要音乐权限档 ≥ 只读。",
  enabled: true,
  risk: "safe",
  modes: ["work", "chat"],
  effectKind: "read" as const,
  verificationPolicy: "none" as const,
  inputSchema: { type: "object", properties: {}, required: [] },
  async execute() {
    const denied = requireMusicAccess("read");
    if (denied) return denied;
    const result = await musicRequest<MusicNowPlaying>("music.now-playing");
    if (!result.ok) return result.error;
    return JSON.stringify(result.data);
  },
};

export const musicPlayTool: ToolDefinition = {
  id: "music_play",
  name: "控制本地音乐播放",
  description:
    "控制本地音乐播放器：播放指定曲目/搜索结果、暂停/继续、上一首/下一首、停止、调音量、跳进度、切换播放模式。\n\n" +
    "何时用：\n" +
    "- 用户说'放首歌''播放 XX''来点音乐''换一首''大点声''暂停一下''继续'\n" +
    "- 用户点名歌手/歌名（先用 search 直接播放匹配结果）\n\n" +
    "参数：\n" +
    "- action（可选）：play（默认）| toggle | pause | resume | next | prev | stop | volume | mode | seek\n" +
    "- path（可选）：精确曲目路径（来自 music_library）\n" +
    "- search（可选）：按标题/歌手搜索并播放匹配结果（作为播放队列）\n" +
    "- paths（可选）：路径数组，作为播放队列\n" +
    "- volume（0-100，action=volume 时）；seconds（action=seek 时）；mode（list|single|shuffle，action=mode 时）\n" +
    "- 无 path/search/paths 且无 action 时等价于 toggle（播放/暂停切换）\n\n" +
    "需要音乐权限档 ≥ 控制播放。",
  enabled: true,
  risk: "safe",
  modes: ["work", "chat"],
  effectKind: "external_side_effect" as const,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "play | toggle | pause | resume | next | prev | stop | volume | mode | seek" },
      path: { type: "string", description: "精确曲目路径" },
      search: { type: "string", description: "搜索并播放匹配曲目" },
      paths: { type: "array", items: { type: "string" }, description: "播放队列路径数组" },
      volume: { type: "number", description: "音量 0-100（action=volume）" },
      seconds: { type: "number", description: "跳转秒数（action=seek）" },
      mode: { type: "string", description: "播放模式 list|single|shuffle（action=mode）" },
    },
    required: [],
  },
  async execute(args) {
    const denied = requireMusicAccess("control");
    if (denied) return denied;

    const action = typeof args.action === "string" ? args.action : "";
    const hasTarget = typeof args.path === "string" && args.path.trim().length > 0
      || typeof args.search === "string" && args.search.trim().length > 0
      || Array.isArray(args.paths) && args.paths.length > 0;

    if (action && action !== "play") {
      const payload: Record<string, unknown> = { action };
      if (action === "volume") {
        if (typeof args.volume !== "number" || !Number.isFinite(args.volume)) return "[错误] action=volume 需要 volume 参数（0-100）";
        payload.volume = Math.round(args.volume);
      }
      if (action === "seek") {
        if (typeof args.seconds !== "number" || !Number.isFinite(args.seconds)) return "[错误] action=seek 需要 seconds 参数";
        payload.seconds = args.seconds;
      }
      if (action === "mode") {
        if (args.mode !== "list" && args.mode !== "single" && args.mode !== "shuffle") {
          return "[错误] action=mode 需要 mode 参数：list | single | shuffle";
        }
        payload.mode = args.mode;
      }
      const result = await musicRequest<{ ok: boolean; error?: string; nowPlaying?: MusicNowPlaying }>("music.control", payload);
      if (!result.ok) return result.error;
      if (result.data.ok === false) return `[错误] ${result.data.error ?? "控制失败"}`;
      return JSON.stringify(result.data.nowPlaying ?? {});
    }

    if (!hasTarget) {
      const result = await musicRequest<{ ok: boolean; error?: string; nowPlaying?: MusicNowPlaying }>("music.control", { action: "toggle" });
      if (!result.ok) return result.error;
      if (result.data.ok === false) return `[错误] ${result.data.error ?? "控制失败"}`;
      return JSON.stringify(result.data.nowPlaying ?? {});
    }

    const payload: Record<string, unknown> = {};
    if (typeof args.path === "string" && args.path.trim()) payload.path = args.path.trim();
    if (typeof args.search === "string" && args.search.trim()) payload.search = args.search.trim();
    if (Array.isArray(args.paths)) payload.paths = args.paths.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    const result = await musicRequest<{ ok: boolean; error?: string; nowPlaying?: MusicNowPlaying }>("music.play", payload);
    if (!result.ok) return result.error;
    if (result.data.ok === false) return `[错误] ${result.data.error ?? "播放失败"}`;
    return JSON.stringify(result.data.nowPlaying ?? {});
  },
};

export const musicManageTool: ToolDefinition = {
  id: "music_manage",
  name: "管理音乐文件夹",
  description:
    "管理本地音乐播放器的音乐文件夹：添加/移除文件夹、重新扫描曲库、查看文件夹列表。\n\n" +
    "何时用：\n" +
    "- 用户说'把 D:\\Music 加到音乐库''移除某个音乐文件夹''重新扫描一下音乐'\n" +
    "- 用户问音乐文件夹有哪些\n\n" +
    "参数：action = add-folder（需 path）| remove-folder（需 path）| rescan | list。\n" +
    "需要音乐权限档 = 管理曲库（最高档）。",
  enabled: true,
  risk: "safe",
  modes: ["work", "chat"],
  effectKind: "external_side_effect" as const,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "add-folder | remove-folder | rescan | list" },
      path: { type: "string", description: "文件夹绝对路径（add-folder / remove-folder）" },
    },
    required: ["action"],
  },
  async execute(args) {
    const denied = requireMusicAccess("manage");
    if (denied) return denied;

    const action = typeof args.action === "string" ? args.action : "";
    if (action === "rescan") {
      const result = await musicRequest<{ ok: boolean; scanning: boolean }>("music.rescan");
      if (!result.ok) return result.error;
      return JSON.stringify({ ok: true, scanning: result.data.scanning });
    }
    if (action === "list") {
      const result = await musicRequest<MusicQueryData>("music.query", { limit: 1 });
      if (!result.ok) return result.error;
      return JSON.stringify({ folders: result.data.folders, total: result.data.total, scanning: result.data.scanning });
    }
    if (action === "add-folder" || action === "remove-folder") {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!path) return `[错误] action=${action} 需要 path 参数`;
      const result = await musicRequest<{ ok: boolean; error?: string; folders?: unknown }>("music.folders", {
        action: action === "add-folder" ? "add" : "remove",
        path,
      });
      if (!result.ok) return result.error;
      if (result.data.ok === false) return `[错误] ${result.data.error ?? "操作失败"}`;
      return JSON.stringify({ ok: true, folders: result.data.folders ?? [] });
    }
    return "[错误] action 仅支持 add-folder | remove-folder | rescan | list";
  },
};

export const musicTools: ToolDefinition[] = [
  musicLibraryTool,
  musicNowPlayingTool,
  musicPlayTool,
  musicManageTool,
];
