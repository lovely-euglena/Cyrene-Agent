# 本地音乐播放器（WPF）设计

> 2026-10-02 · 状态：设计（待实施）
> 关联：`cyrene-native` 窗口宿主 / HostProtocol / 工具权限档 / `D:\code\MusicTag`（元数据参考）

## 1. 背景与目标

旧版音乐播放器是为网易云音乐设计的（在线歌单/`MusicCardData` 卡片），代码已删除，
仅保留历史卡片渲染、mpv 探测与随包 mpv 资源。本次重新设计的是**本地曲库播放器**：

- **WPF 原生窗口**（挂在 `cyrene-native serve` 窗口宿主，不再用 Electron 窗口）；
- **音乐文件夹管理**：多根目录、递归扫描、增量刷新、移除；
- **LRC 显示**：侧车 `.lrc` + 内嵌歌词，逐行高亮、自动滚动、点击跳转；
- **元数据处理**：读写标签/封面/歌词，做法对标 `D:\code\MusicTag`（lofty → .NET 用 TagLib#）；
- **与 Agent 互通**：Agent 可查询曲库/播放状态、控制播放、管理文件夹；
  权限单独成档、在设置里改（`off / read / control / manage`）。

非目标（本期不做）：在线歌单/网易云账号、联网搜词补封面（P3 可选）、频谱可视化、歌词逐字卡拉OK。

## 2. 现状（已核对）

| 事项 | 结论 |
| --- | --- |
| 原生窗口宿主 | `cyrene-native serve` 单进程多窗口；`RequestRouter` 按 `win.spawn.kind` 建窗；stdio 4B 长度 + JSON 帧；`state.*` 下发、`cmd` 事件上行 |
| TS 桥 | `NativeWindowsClient`（`native-windows-host.ts`）+ `initNativeWindowsBridge`（cmd 分发） |
| mpv | `resources/bin/mpv/mpv.exe` 随包分发；`detectMpvBinary()` 保留（飞书转码在用） |
| 音乐残留 | `MusicCardData`（历史消息兼容）、`musicPlayerWindow` 声明未用、CITA 测试里 `music` 域 |
| 权限模型 | 全局文件档 5 档（project-read-only/read-only/scoped/per-action/full）+ 工具 risk 6 级 + `policyFor` 矩阵 + per-action 审批卡片 |
| SQLite | `Microsoft.Data.Sqlite 9.0.0` 已在 CyreneNative.csproj 引用 |
| MusicTag | Tauri2+Rust+`lofty`；格式 FLAC/MP3/APE/WAV/M4A；字段 title/artist/album/albumArtist/track/trackTotal/year/genre/cover/lyrics；歌词源 embedded/sidecar/none；保存全量覆盖、空字段即删除；MP3 写 ID3v2.4；改名撞名拒绝 |

## 3. 总体架构

```
Electron 主进程（TS）
  ├─ music-tools.ts         Agent 工具（library/now_playing/play/manage）
  ├─ music-manager.ts       设置（文件夹/权限/mpv 路径）→ state.music 推送
  └─ native-windows-bridge  music 分支：窗口开关、cmd 事件、music.* 请求
        │  stdio 帧协议（扩展 music.* + state.music + ReplyOk(data)）
        ▼
cyrene-native serve（.NET）
  ├─ MusicService（进程内单例，窗口无关）
  │    ├─ LibraryStore      SQLite：tracks/folders，增量扫描
  │    ├─ MpvController     mpv 子进程 + named-pipe JSON IPC
  │    ├─ LrcProvider       侧车/内嵌歌词读取与解析
  │    └─ TagService        TagLib# 读写（P2）
  └─ MusicWindow（WPF 视图，kind="music"）：曲库列表 + 播放详情 + 歌词面板
```

要点：**播放与曲库不依赖窗口存在**——关窗后 Agent 仍可控制播放；窗口只是视图，
打开时用 `state.music` 全量同步，之后增量推送。

## 4. 播放引擎

首选 **mpv 子进程 + named-pipe JSON IPC**：

- 启动：`mpv.exe --no-video --idle=yes --force-window=no --input-ipc-server=\\.\pipe\cyrene-music-<pid>`
  （exe 路径由 TS 用 `detectMpvBinary()` 探测后经 `music.config` 下发，与飞书转码共用同一资源）；
- 控制：`loadfile / set pause / seek / set volume / playlist-next|prev / set loop-file|loop-playlist / set shuffle`；
- 状态：`observe_property`（`time-pos`/`duration`/`pause`/`eof-reached`/`volume`/`media-title`）
  或 200ms 轮询，二者取一（P1 用 observe + 轮询兜底）；
- 进程管理：随 MusicService 生命周期；应用退出 / 宿主 stdin EOF 时 kill；崩溃自动重启一次并回到 idle。

备选：NAudio（`MediaFoundationReader` + `WasapiOut`），仅当 mpv 缺失时给 MP3/FLAC/M4A/WAV
兜底（P2 再评估）。理由：mpv 已随包、格式覆盖最广（FLAC/APE/WavPack/Opus 等），进程隔离，
UI 卡顿不影响声音。

播放状态机：`idle → loading → playing ⇄ paused → stopped`；播放模式：顺序 / 列表循环 /
单曲循环 / 随机；支持 seek、音量、下一首/上一首、播放列表增删与清空。

## 5. 曲库与音乐文件夹管理

- **文件夹**：多根目录，递归；增删入口 = 窗口设置区 + Agent `music_manage`（manage 档）；
  列表存 general settings `musicFolders: string[]`（TS 侧权威，`music.config` 下发给 native）。
- **扫描**：扩展名白名单 `.mp3 .flac .m4a .aac .ogg .opus .wav .ape .wv .wma`；
  后台线程扫描，SQLite 批量事务；**增量**按 `path + size + mtime` 比对，手动「重新扫描」全量；
  FileSystemWatcher 监听变动放 P2。
- **表结构（SQLite `userData/music-library.db`）**：
  - `folders(path PRIMARY KEY, added_at, last_scan_at)`
  - `tracks(id INTEGER PK, path UNIQUE, folder, title, artist, album, album_artist, track_no,
    duration_ms, format, size, mtime, has_cover, has_lyrics, lyrics_source, updated_at)`
  - 查询：标题/歌手/专辑 LIKE + 排序（P1 内存过滤足够，P2 上 FTS5）。
- **封面缓存**：`userData/music-cache/covers/<sha1>.<ext>`；首次读取标签时抽取并压缩
  （≤512px），窗口用 `BitmapImage` 懒加载。
- **读取回退**：标签缺失/坏标签时用文件名（`歌手 - 标题`）与所在文件夹（专辑）兜底，
  与 MusicTag「坏标签只读不炸」同款策略。

## 6. LRC 歌词

- 来源优先级：**侧车 `<basename>.lrc`**（同目录、同名）→ **内嵌**（TagLib# `Tag.Lyrics`）
  → 无（显示「暂无歌词」）。
- 解析器（独立纯函数，便于单测）：
  - 时间标签 `[mm:ss.xx]` / `[mm:ss.xxx]`，一行多标签展开为多条；
  - 元信息 `[ti:] [ar:] [al:] [by:]` 与 `[offset:]`（毫秒整体偏移）；
  - 双语/翻译：同一时间戳的多行保留为「主行 + 副行」；
  - 非法行忽略不抛。
- 显示：当前行高亮 + 平滑滚动；点击某行 seek；无时间标签时按纯文本展示。
- Agent 互通：`music_now_playing` 返回当前曲目 + 当前歌词行（read 档即可）；
  整首歌词查询放 `music_library` 的可选 `include`（P2）。

## 7. 元数据处理（对标 MusicTag，.NET 实现）

选型 **TagLib#**（NuGet `TagLibSharp`）：覆盖 MP3(ID3v2)/FLAC(Vorbis)/M4A(MP4)/APE/WAV，
支持图片与歌词字段，是 `lofty` 在 .NET 侧的等价物。

字段映射（MusicTag `Song` → TagLib#）：

| MusicTag | TagLib# | 备注 |
| --- | --- | --- |
| title | `Tag.Title` | |
| artist | `Tag.FirstPerformer` / `Performers` | 多值保留 |
| album | `Tag.Album` | |
| album_artist | `Tag.FirstAlbumArtist` / `AlbumArtists` | |
| track / track_total | `Tag.Track` / `Tag.TrackCount` | |
| year | `Tag.Year` | |
| genre | `Tag.FirstGenre` / `Genres` | |
| lyrics | `Tag.Lyrics` | ID3v2 `USLT` / Vorbis `LYRICS` |
| cover(+mime) | `Tag.Pictures[0]` | ID3 `APIC` / FLAC `METADATA_BLOCK_PICTURE` / MP4 `covr` |

行为对齐 MusicTag：

- **保存 = 全量覆盖，空字段即删除**（不保留旧值）；
- MP3 写 **ID3v2.4**，禁止 v2.3；
- **原子写**：写临时副本 → `File.Replace` 替换（MusicTag 的 `fs_atomic` 思路；比直接写回更稳）；
- 坏标签只读：解析失败时禁用保存并给出原因；
- 改名（`artist - title` 模板、撞名拒绝）放 P2；
- 批量标签编辑**不做**（与 MusicTag「一次一首」一致），Agent 写标签也一次一首。

封面写入选 WPF `BitmapEncoder` 压缩（≤1MB，JPEG/PNG/WebP→JPEG），不引入额外图像库。

## 8. Agent 互通与权限

### 8.1 工具面（内置 TS，`src/main/music/music-tools.ts`）

| 工具 | risk | 能力 |
| --- | --- | --- |
| `music_library` | `safe` | 搜索曲目/专辑/歌手、列文件夹、曲库统计、当前播放状态 |
| `music_now_playing` | `safe` | 当前曲目、进度、播放模式、当前歌词行 |
| `music_play` | `input-control` | 播放指定曲目/搜索结果、暂停/继续、上下一首、seek、音量、模式 |
| `music_manage` | `fs-write` | 添加/移除音乐文件夹、重新扫描；（P2）写标签/歌词、改名 |

工具内部统一走 `MusicBridge`：native 宿主未起时按需 `spawnWindow("music")`（仅打开窗口场景；
纯查询/控制可无窗运行）。

### 8.2 专用权限档（设置里改）

新增 general settings 字段：

```ts
musicAgentAccess: "off" | "read" | "control" | "manage"  // 默认 "read"
```

- **主闸门**：所有 `music_*` 工具调用时读取该档位；`off` 直接返回结构化
  「音乐权限未开启，去设置 → 昔涟 → 音乐 打开」且不执行任何操作（fail-closed）。
  `read` 只放行两个 safe 工具；`control` 放行 `music_play`；`manage` 放行 `music_manage`。
- **双重闸门**：`manage` 中会修改用户文件的动作（P2 标签/改名）额外过
  `checkPermission({ risk: "fs-write" })`，即同时受全局文件档位与审批卡约束。
- **设置入口**（两处同源）：
  1. 音乐窗口设置区（播放器内最顺手）；
  2. 设置 → 昔涟 → 「音乐」行（WPF native 设置窗，Electron 设置同步白名单）。
- 工具目录可见性：`off` 时仍注册但调用即拒绝（P1 简单可靠；P2 再评估动态隐藏）。

### 8.3 事件互通

- `state.music` 推送：曲目/播放状态/歌词行变化（节流 1s），窗口与主进程各取所需；
- P2：播放状态变化接入 CITA/主动聊天上下文（已有 `music` 域残留可复用），
  例如用户说「这首好听」时 Agent 知道在放什么。

## 9. WPF 窗口设计（`MusicWindow.cs`，kind="music"）

布局（自上而下）：

```
┌ 搜索框 ──────────────── 文件夹下拉 ─ 重新扫描 ┐
│ 曲库列表（封面缩略图/标题/歌手/专辑/时长）      │
│ ─────────────────────────────────────────── │
│ 播放详情：大封面 | 标题/歌手/专辑 | 歌词滚动面板 │
│ 控制条：上一首 播放/暂停 下一首 | 进度 | 音量 | 模式 │
└ 设置抽屉：音乐文件夹管理、Agent 权限、mpv 路径状态 ┘
```

- 主题/圆角跟随 `NativeTheme` 与 `win.radius`；窗口尺寸记忆走既有 window-state 模式；
- 文件夹选择用 .NET `OpenFolderDialog`（net10.0-windows 自带）；
- 列表虚拟化（`VirtualizingStackPanel`）保证万级曲库流畅；
- 双击曲目播放，右键「在资源管理器中显示 / 加入播放列表」。

窗口上行命令（native→TS，经 `cmd` 事件 kind="music"）：
`play/pause/next/prev/seek/setVolume/setMode/addFolder/removeFolder/rescan/refreshLibrary/openLyric`。
TS 处理后回推 `state.music`（或由 native MusicService 直接处理，TS 只转发 Agent 侧请求）。

## 10. 协议与代码落点

协议扩展（`HostProtocol.cs` / `RequestRouter.cs`）：

- `ReplyOk(id, data)`：请求带数据回执（music 查询需要），TS 侧 `NativeWindowsClient` 增
  `requestData<T>(payload)`；旧 `ReplyOk(id)` 兼容不变；
- 新 op：`music.config`（mpv 路径/文件夹/权限）、`music.query`、`music.play`、`music.control`、
  `music.folders`、`music.rescan`（P2：`music.tags`）；
- 新推送：`state.music`；新窗口 kind：`"music"`。

| 层 | 文件 |
| --- | --- |
| WPF 窗口 | `dotnet/native-windows/MusicWindow.cs`、`Music/MusicService.cs`、`Music/LibraryStore.cs`、`Music/MpvController.cs`、`Music/LrcParser.cs`（P2：`Music/TagService.cs`） |
| 协议 | `dotnet/native-windows/HostProtocol.cs`、`RequestRouter.cs` |
| TS 桥 | `src/main/windows/native-windows-host.ts`、`native-windows-bridge.ts` |
| TS 业务 | `src/main/music/music-manager.ts`（设置/状态）、`src/main/music/music-tools.ts`（工具） |
| 设置 | `general-settings.ts`（`musicFolders`、`musicAgentAccess`）、`native-settings-protocol.ts` 白名单 |
| 打包 | 无新增二进制；`CyreneNative.csproj` 加 `TagLibSharp` |

数据落点：`userData/music-library.db`、`userData/music-cache/`；
文件夹与权限存 general settings（TS 权威，可随设置备份/迁移）。

入口：状态栏（SidebarWindow）新增「音乐」按钮 → `SendCommand("sidebar", "openMusic")` →
TS `spawnWindow("music")`；Agent 工具按需拉起；设置页也可打开。

## 11. 分阶段

- **P1（可用）**：MusicWindow 骨架 + 文件夹管理与扫描 + mpv 播放 + LRC 显示 +
  `music_library`/`music_now_playing`/`music_play` + 权限档设置 + 协议扩展 + 单测。
- **P2（完整）**：TagLib# 标签/封面/歌词读写（一次一首、原子写）、`music_manage` 标签能力、
  播放列表、FileSystemWatcher、改名、SMTC 全局媒体键、播放状态进 CITA。
- **P3（可选）**：联网补全（对标 MusicTag 的 LRCLIB 等源，需显式开启）、频谱、本地音乐卡片进聊天。

## 12. 测试与验收

- 单测（TS/.NET 各半）：LRC 解析（多标签/offset/双语/脏行）、增量扫描判定、
  标签字段映射与原子写（临时文件）、权限矩阵（off/read/control/manage × 工具）、
  协议帧（`ReplyOk(data)` 形状）。
- WPF 契约测试：`RequestRouter` 新 kind / music op 的 C# ↔ TS 形状一致（照 native-settings 契约测试模式）。
- 手工：中文/特殊字符路径、FLAC/APE/M4A、双语 LRC、关窗后 Agent 仍可控播放、
  四档权限行为、mpv 崩溃恢复。
- 验收：断网全功能可用；写标签失败不破坏原文件；`off` 档任何 music 工具都 fail-closed。

## 13. 风险与对策

| 风险 | 对策 |
| --- | --- |
| mpv IPC 兼容/残留进程 | 固定随包版本；退出/EOF kill；崩溃重启一次；管道名带 pid 防冲突 |
| TagLib# 对 APE/WAV 写支持有限 | 读优先；写失败明确报错不动原文件；P2 实测后按格式给能力表 |
| 大曲库扫描卡 UI | 后台线程 + SQLite 事务批写 + 列表虚拟化 |
| 权限绕过 | 专用档 + `fs-write` 双重闸门；off 一律 fail-closed；工具快照测试锁定 risk |
| 与旧 MusicCardData 混淆 | 新工具/状态不复用网易云 `MusicCardData`；历史卡片保持只读渲染 |
