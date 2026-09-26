# 「语音」设置页迁移到原生设置窗（TTS / ASR）

> 日期：2026-09-26 · 范围：Electron `tts` / `asr` 面板 → WPF「语音合成 TTS」「语音识别 ASR」section
> 关联：`2026-09-26-native-settings-migration-final.md`（一期按用户要求留在 Electron，本次按用户要求迁移完成）

## 0. 旧页内容 → 新实现

| 旧控件 | 新实现 | 说明 |
|---|---|---|
| 播放交互：自动朗读开关 | 工具卡开关 → `tts save {ttsAutoRead}` | 即时保存 |
| 自动朗读文本切分开关 + 切分模式（一句/一段） | 开关 + 档位组（关闭时置灰） | 切分模式即时保存 |
| 语速（0.5~2）/ 音量（0~1）滑杆 | 原生滑杆 + 数值标签 | 250ms 防抖后保存 |
| 引擎选择（关闭/MiniMax/MiMo/Mossland/GPT-SoVITS/自定义云端） | 引擎按钮组 | 只切本地可见性，不重建 section |
| MiniMax：Key/音色/模型/流式/增强/测试/保存 | 字段 + 下拉 + 开关 + 测试按钮 + 保存配置行 | 模型下拉即时保存；文本字段待「保存配置」 |
| MiniMax 音色快速复刻（文件/示例/文本/命名/开始/须知） | 同字段 + `clone-minimax` 动作 + 须知弹窗 | 成功自动写入音色 ID；失败自动换新 ID |
| GPT-SoVITS：url/参考音频/文本/格式/超时/测试/保存 | 同字段（参考音频点选后即时保存） | 格式下拉即时保存；超时 10s~1h |
| 自定义云端：url/key/voice/格式/超时/测试/保存 | 同字段（超时 1s~120s） | 测试带当前语速/音量 |
| 小米 MiMo：key/克隆音频/风格/测试/保存 | 同字段（点选音频即时保存） | |
| Mossland：key/模型/音色/试听文本/格式/测试/保存 | 同字段 | 模型/格式随「保存配置」落盘（旧页同款） |
| Mossland 音色克隆（参考音频/名称/描述/上传） | 同字段 + `clone-mossland` 动作 | 成功后回填 + 提示保存 |
| Mossland 音色列表（拉取 + 使用） | `list-mossland-voices` 动作 + 原生列表行 | 「使用」回填音色 ID 并标脏 |
| ASR 引擎选择（关闭/阿里云/Mossland/本地占位） | 档位组 | 本地 = 语音输入插件提供（选择后等插件租约接管，见 09-27 修复批） |
| 阿里云配置（AppKey/AK ID/Secret/语言） | 字段 + 档位组 | 文本失焦/回车提交（旧页 800ms 防抖） |
| Mossland 配置（API Key，与 TTS 共用） | 字段（写 `ttsMosslandKey`） | |
| 通话设置（VAD 静默/音量阈值/显示转写） | 数值框 + 滑杆 + 开关 | 静默 100~60000ms；阈值 0.001~0.5 |

## 1. 数据 / 动作

- **快照**：`state.settings.tts` / `state.settings.asr`
  - `buildTtsSectionSnapshot`：旧页 `loadTtsConfig` 同款默认回填（空 baseUrl → localhost:9880、
    空风格提示/Mossland 模型/试听文本回落默认、数值越界 clamp）。
  - `buildAsrSectionSnapshot`：旧页 `loadAsrConfig` 同口径（mossland key 与 TTS 共用）。
- **动作**：`NATIVE_SECTION_ACTIONS.tts = ["save", "test", "clone-minimax", "clone-mossland",
  "list-mossland-voices"]`，`asr = ["save"]`（契约测试扫描 C# 锁定）。
- **保存**：`saveGeneralSettings` 直接落盘（TTS 字段无搜索 MCP / Playwright 联动；
  与 `TTS_SAVE_SETTINGS` 同存储），经 `sanitizeNativeTtsSave` / `sanitizeNativeAsrSave` 白名单。
- **试听 / 克隆 / 列表**：`src/main/settings/native-voice-actions.ts` 复用 `src/main/tts/*`
  同一批引擎（minimax / gptsovits / custom-cloud / mimo / mossland），不复制协议逻辑：
  - 试听合成写系统临时目录（`cyrene-tts-test-<uuid>.<ext>`），返回路径给 WPF
    （MediaPlayer 播放；播完/换曲/关窗清理）。
  - MiniMax 克隆：上传配音文件 →（可选）上传示例音频 → 训练；audioDemo 下载失败不影响主流程。
- **文件选择**：WPF `OpenFileDialog`（不再经 Electron dialog）。
- **回执超时**：`RequestRouter.SendSettingsAction` 新增 `timeout` 参数（缺省 15s 不变）；
  测试 4 分钟、克隆 5 分钟、列表 2 分钟。

## 2. 行为口径（不变量）

1. Provider 文本字段只有点「保存配置」才落盘；开关 / 下拉 / 滑杆 / 引擎选择即时保存
   （滑杆 250ms 防抖）——与旧页一致，避免每键一 IPC 打断输入法。
2. `tts save` **不重推快照、不重建 section**（表单焦点不丢）；引擎切换只切本地可见性。
   窗口重开时快照自然是最新值。
3. 试听 / 克隆 / 列表都必须带 `requestId` 回执；长任务用显式放宽的超时，不得改缺省值。
4. WPF 不直接改 general settings：一律 `cmd settings tts/asr`，由宿主校验落盘。
5. MiniMax 克隆成功自动写 `ttsMinimaxVoiceId`；失败自动换新音色 ID（服务端已建但响应丢失的兜底）。
6. Mossland「使用此音色」只回填 + 标脏（旧页同款，需再点「保存配置」）；克隆成功例外（自动保存）。
7. ASR 本地档位：语义为「识别由语音输入插件提供」（`speech-input` 租约）。原生档位可选，
   选择后通话进入等待状态（不启动内置云 ASR），插件取得租约即接管；
   详见 `2026-09-27-settings-polish-batch.md`（2026-09-26 版曾临时禁用该档位，已修订）。
8. `ELECTRON_ONLY_SETTINGS_SECTIONS = ["channels"]`（语音不再回 Electron 页）；
   契约测试锁定 `AddSection(native:true)` ↔ `IsNativeSection` ↔ 路由三方一致。

## 3. 验证

- 契约测试：动作集合锁定（tts/asr）、`sanitizeNativeTtsSave`/`sanitizeNativeAsrSave`
  （枚举回落 / 数值 clamp / 文本裁剪）、快照投影（默认回填 / 越界 clamp）、路由裁决
  （tts/asr → WPF，channels → Electron）、C# 动作扫描（`SettingsWindow.Tts.cs` /
  `SettingsWindow.Asr.cs` / `SettingsWindow.Plugins.cs` 已纳入扫描集合）。
- 单测：`native-voice-actions.test.ts` —— 试听参数映射与临时文件、必填校验、
  audioDemo 下载成功/失败降级、克隆参数与列表投影。
- 离屏渲染（临时钩子，验后已移除）：TTS（MiniMax 配置 + 复刻块）、TTS（Mossland 配置 +
  克隆 + 音色列表）、ASR（阿里云配置 + 通话设置）全部正确。
- `dotnet build -c Release` / `tsc -p tsconfig.main.json` 0 错。

## 4. 遗留（有意）

- 引擎卡品牌图标用文字按钮（WPF 不便复刻 SVG 渐变 logo）；「复刻须知」用纯文本弹窗
  （旧页富文本 modal 的等价形式）。
- 试听音频经系统临时文件 + WPF MediaPlayer 播放，不经过渲染页 Blob 通道。
- 聊天朗读 / 通话链路（自动朗读、早播切分、VAD）本身不变，本次只迁移设置入口。
