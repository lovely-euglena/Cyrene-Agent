import type { ChatAppearanceSettings } from "../../shared/chat-appearance";
import type { UiTheme } from "../../shared/ui-theme";
import type { UiFont } from "../../shared/ui-font";
import type { UiIcon } from "../../shared/ui-icon";
import type { UiLanguage } from "../../shared/ui-language";
import type { MessageTypography } from "../../shared/message-typography";
import type {
  DefaultChatMode,
  MobileMessageSegmentationMode,
  ProactiveChatMode,
  ProactiveDeliveryTarget,
  SegmentedOutputMode,
} from "../../shared/preferences";
import type { CustomStyleConfig, StyleId } from "../../shared/style-sampling";
import type { ToolModeOverrides } from "../orchestrator/tools/registry/tool-registry";
import type { SkillModeOverrides } from "../skills/types";
import type { LspServerOverride } from "../lsp/types";

/**
 * 通用设置（GeneralSettings）：与模型配置无关的 UI、TTS、工具开关、快捷键等。
 * 统一保存到 general-settings.json。
 */
export interface GeneralSettings extends ChatAppearanceSettings {
  /** 功能插件开关表：pluginId -> enabled */
  plugins: Record<string, boolean>;
  /**
   * 插件运行时总开关（默认关闭省内存）：false 时启动跳过插件系统
   * （PluginManager + 市场服务不构造，IPC 不注册）；运行期可在设置/
   * 插件管理窗动态启停。
   */
  pluginRuntimeEnabled?: boolean;
  /** 记住设置与音乐窗口的位置和大小（上游 2026-09-24 新增）。 */
  rememberWindowState: boolean;
  /**
   * 缓存目录覆盖（数据/缓存分离）：绝对路径；undefined = 默认策略
   * （便携模式 = 程序目录旁 cache/，否则系统缓存目录）。
   * 模型/TTS/渠道媒体/插件市场包等可重建产物走该目录，重启生效。
   */
  cacheDirOverride?: string;
  /**
   * 插件资源限制（插件管理窗「设置」页可配；undefined = 未配置，
   * 回退环境变量/内置默认）。0 = 不限。
   * - pluginStorageQuotaMb：单插件 KV 存储配额（MiB，默认 64）
   * - pluginMemoryLimitMb：.NET 插件进程内存上限（MiB，默认 2048）
   */
  pluginStorageQuotaMb?: number;
  pluginMemoryLimitMb?: number;
  /** Harness 同时执行已明确安全工具的上限；1 表示完全串行。 */
  maxParallelToolCalls: number;
  /** 子代理系统提示词是否叠加所选黄金裔的人设。 */
  taskCharacterPersonaEnabled: boolean;
  /** 子代理固定使用的模型档案与档案内模型；未设置时跟随主 Agent。 */
  taskModelProfileId?: string;
  taskModel?: string;
  citaEnabled: boolean;
  citaSemanticEngine: "remote";
  /** Chat 模式的轻量社交上下文；默认关闭，开启后每轮最多多一次异步抽取调用。 */
  chatSocialContextEnabled: boolean;
  /** 朋友圈功能总开关：关闭后 UI 隐藏、Chat 上下文不注入、昔涟不反应不发帖。 */
  momentsEnabled: boolean;
  /** Chat 模式注入近期朋友圈动态背景；默认开启（只读本地数据，无额外 LLM 调用）。 */
  chatMomentsContextEnabled: boolean;
  /** 昔涟主动发帖；默认关闭（审慎，与 proactiveChatMode 默认 off 一致）。 */
  cyreneMomentsPostingEnabled: boolean;
  /** 昔涟对朋友圈动态的点赞/评论反应；默认开启（Feed 内被动行为，不打扰）。 */
  cyreneMomentsReactionsEnabled: boolean;
  /** 角色对朋友圈动态的点赞/评论/互聊；默认开启（有独立日调用上限兜底成本）。 */
  momentsCharacterReactionsEnabled: boolean;
  /** 朋友圈热闹程度：控制每条动态的抽签人数分布与角色日调用上限。
   *  quiet=现状（冷场常见），natural=冷场减半，lively=上限 5 人冷场罕见。 */
  momentsLiveliness: "quiet" | "natural" | "lively";
  /** 聊天气泡段落间距（em，0.2~1.2，默认 0.5）；渲染应用待接入。 */
  chatParaSpacing: number;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  /** 桌宠缩放因子：1.0=默认，0.5~2.0，窗口与模型同步等比缩放。 */
  petZoom: number;
  /** 桌宠窗口 X 坐标，未保存时为 undefined */
  petWindowX?: number;
  /** 桌宠窗口 Y 坐标，未保存时为 undefined */
  petWindowY?: number;
  disableGpuElectron?: boolean;
  sidebarVisible: boolean;
  tasksVisible: boolean;
  /** 提醒中心音效总开关：关闭后所有 toast 静音，弹窗行为不受影响。 */
  toastSoundEnabled: boolean;
  launchAtLogin: boolean;
  /** 界面语言：已支持中文、英文、日文，其余语言待翻译补齐后开放。 */
  language: UiLanguage;
  uiTheme: UiTheme;
  windowCornerRadius: number;
  /** @deprecated 旧版透明窗口开关，仅保留用于配置兼容。 */
  uiThemeRadius: boolean;
  uiFont: UiFont;
  uiIcon: UiIcon;
  /**
   * 用户是否显式选择过桌面图标。旧版本默认「晴光」会在任意设置保存时被写死，
   * 与「用户主动选择」无法区分；缺省（undefined/false）视为未选择，加载时
   * 跟随当前默认（见 settings-facade 的 uiIcon 迁移）。显式选择后置 true。
   */
  uiIconChosen?: boolean;
  /** 昔涟回复正文的排版（字号/行距/字距/字重），只作用于 AI 回复气泡。 */
  messageTypography: MessageTypography;
  /** 聊天窗口打开时默认选中的模式。 */
  defaultChatMode: DefaultChatMode;
  /** 聊天窗口当前风格，启动时恢复；本轮请求仍以 renderer 显式 styleId 为准。 */
  currentStyleId: StyleId;
  /** 全局自定义风格采样配置。 */
  customStyle: CustomStyleConfig;
  /** 聊天气泡分段输出偏好。 */
  segmentedOutputMode: SegmentedOutputMode;
  /** 手机渠道文本消息分段发送偏好。 */
  mobileMessageSegmentation: MobileMessageSegmentationMode;
  /** 主动聊天功能开关占位；当前不接实际逻辑。 */
  proactiveChatMode: ProactiveChatMode;
  /** 主动消息最终投递到本地、微信或飞书。 */
  proactiveDeliveryTarget: ProactiveDeliveryTarget;
  // TTS 配置
  ttsEngine: "off" | "minimax" | "gptsovits" | "custom-cloud" | "mimo" | "mossland";
  ttsAutoRead: boolean;
  ttsSpeed: number;
  ttsVolume: number;
  /** 自动语音早播的文本切分是否开启：关闭时不再流式切分，收完整条回复再整段朗读。 */
  ttsEarlyReadSplitEnabled: boolean;
  /** 自动语音早播的文本切分方式：sentence=一句一切（默认，现状）；paragraph=一段一切（仅空行段落切分）。 */
  ttsEarlyReadSplitMode: "sentence" | "paragraph";
  // MiniMax
  ttsMinimaxKey: string;
  ttsMinimaxVoiceId: string;
  /** MiniMax 合成模型：speech-2.8-hd(高保真¥3.5/万字符) | speech-2.8-turbo(极速¥2.0/万字符) */
  ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  /** MiniMax 流式播放（边合成边播，首字延迟低）；false=完整合成收完再播 */
  ttsStreaming: boolean;
  /** MiniMax 语音增强：自动插入 (laughs)、(breath) 等语气词标签 */
  ttsMinimaxVocalEnhance: boolean;
  // GPT-SoVITS（本地）
  ttsGptsovitsBaseUrl: string;
  ttsGptsovitsRefAudioPath: string;
  ttsGptsovitsPromptText: string;
  ttsGptsovitsFormat: "wav" | "mp3";
  /** GPT-SoVITS 单次合成超时（毫秒）。本地推理长文本可能较慢，默认 3 分钟。 */
  ttsGptsovitsTimeoutMs: number;
  // 自定义云端 TTS
  ttsCustomCloudEndpointUrl: string;
  ttsCustomCloudApiKey: string;
  ttsCustomCloudVoiceId: string;
  ttsCustomCloudFormat: "wav" | "mp3";
  ttsCustomCloudTimeoutMs: number;
  // 小米 MiMo TTS
  ttsMimoKey: string;
  ttsMimoVoiceAudioPath: string;
  ttsMimoStylePrompt: string;
  // Mossland TTS
  ttsMosslandKey: string;
  ttsMosslandVoiceId: string;
  ttsMosslandModel: string;
  ttsMosslandTestText: string;
  ttsMosslandFormat: "mp3" | "wav";
  /** 天气源：open-meteo(免配置默认) | amap(高德,需填key) */
  weatherSource: "open-meteo" | "amap";
  /** 天气插件是否启用（开关） */
  weatherEnabled: boolean;
  /** 高德天气 key（https://lbs.amap.com 注册 Web服务 key） */
  amapKey: string;
  /** 🚗出行工具是否启用 */
  travelEnabled: boolean;
  /** 🖥️ 浏览器自动化（Playwright MCP）是否启用。默认 false，需用户手动开启。 */
  playwrightMcpEnabled: boolean;
  /** 📁 文件系统 MCP（官方 server-filesystem，允许目录为下载文件夹）是否启用。默认 false。 */
  filesystemMcpEnabled: boolean;
  // 联网搜索：选哪个搜索源 + 对应 key
  searchEngine: "off" | "bocha" | "tavily" | "minimax" | "anySearch";
  searchBochaKey: string;
  searchTavilyKey: string;
  searchMinimaxKey: string;
  searchAnySearchKey: string;
  /** ✉️邮件发送插件是否启用 */
  emailEnabled: boolean;
  /** SMTP 主机，如 smtp.qq.com */
  emailSmtpHost: string;
  /** SMTP 端口，如 465（SSL）/ 587（STARTTLS） */
  emailSmtpPort: number;
  /** 使用 SSL/TLS（465 通常 true，587 通常 false；用户可覆盖） */
  emailSmtpSecure: boolean;
  /** 发件邮箱地址 */
  emailSmtpUser: string;
  /** SMTP 授权码（非邮箱登录密码） */
  emailSmtpPass: string;
  /** 发件人显示名（可选） */
  emailFromName: string;
  // 邮件收信（IMAP）：认证复用 emailSmtpUser/emailSmtpPass（同一邮箱账号 + 授权码）
  /** IMAP 服务器（收信）；留空 = 未配置收信能力 */
  emailImapHost: string;
  /** IMAP 端口，默认 993（SSL） */
  emailImapPort: number;
  /** IMAP 使用 SSL/TLS（993 通常 true，143 通常 false） */
  emailImapSecure: boolean;
  /** 🎧ASR 服务商：off(关闭) | aliyun(阿里云) | mossland(MOSI) | minimax | local(本地,占位) */
  asrEngine: "off" | "aliyun" | "mossland" | "minimax" | "local";
  /** 阿里云智能语音交互 AppKey */
  asrAliyunAppKey: string;
  /** 阿里云 RAM AccessKey ID */
  asrAliyunAccessKeyId: string;
  /** 阿里云 RAM AccessKey Secret */
  asrAliyunAccessKeySecret: string;
  /** MiniMax 语音识别 API Key */
  asrMinimaxKey: string;
  /** ASR 识别语言：zh(中文) | en(英文) | auto(自动) */
  asrLanguage: "zh" | "en" | "auto";
  /** VAD 静默检测阈值（毫秒），500~2000，默认 1000 */
  asrVadSilenceMs: number;
  /** VAD 音量阈值（0~1），默认 0.01。环境吵或麦克风音量低时可调 */
  asrVadThreshold: number;
  /** 通话中显示文字转写 */
  asrShowTranscript: boolean;
  /** RAG 模型下载镜像源：official=官方源；hf-mirror=国内镜像。模型为手动安装时不影响。 */
  ragDownloadMirror: "official" | "hf-mirror";
  /** 截图全局热键（Electron Accelerator 格式，如 "Alt+Shift+S"） */
  screenshotHotkey: string;
  /** 截图后端：builtin=内置原生助手；snipaste=外部 Snipaste 命令行 */
  screenshotBackend: "builtin" | "snipaste";
  /** Snipaste.exe 路径；空字符串 = 自动检测（PATH / 常见目录 / 注册表） */
  snipastePath: string;
  /** Pandoc.exe 路径；空字符串 = 自动探测 PATH（文档转换：docx/odt/rtf/epub 等） */
  pandocPath: string;
  /**
   * 🐧 WSL 执行开关（默认关闭）：开启后 run_shell 可选择 shell="wsl" 在 Windows 上
   * 已安装的 WSL 发行版内执行命令；关闭时不探测不 spawn（零开销）。
   */
  wslEnabled?: boolean;
  /** 默认 WSL 发行版名；空字符串 = 使用 WSL 自身配置的默认发行版。 */
  wslDistro?: string;
  /**
   * 精确 token 统计（默认关闭）：开启后由 .NET cyrene-token 宿主按模型官方
   * tokenizer 精确计数（含上下文用量环），词表按需从 ModelScope/HF 下载并缓存；
   * 关闭、模型无词表或下载失败时回退现有启发式估算，不影响对话。
   */
  tokenStatsEnabled?: boolean;
  /** tokenizer 下载源偏好（下载管理在 .NET 宿主内完成，失败自动回退其它源）。 */
  tokenStatsSource?: "modelscope" | "hf-mirror" | "huggingface";
  /** 本地音乐文件夹（绝对路径；音乐窗管理，Agent 查询/管理共用）。 */
  musicFolders: string[];
  /** Agent 音乐权限档：off=关闭 / read=只读查询 / control=控制播放 / manage=管理曲库。 */
  musicAgentAccess: "off" | "read" | "control" | "manage";
  /** 音频输出设备名（mpv --audio-device）；空字符串 = 自动选择。设备名与机器相关。 */
  musicAudioDevice: string;
  /** 🔍本地 OCR（图像文字识别）工具开关 */
  ocrEnabled: boolean;
  /** OCR 服务商：off(关闭) | local(本地，Windows 内置) | cloud(云端，预留未接入) */
  ocrProvider: "off" | "local" | "cloud";
  /** OCR 识别语言 tag（如 zh-Hans-CN）；空字符串 = 自动（跟随系统） */
  ocrLanguage: string;
  /** 云端 OCR 预留配置（当前未接入；provider=cloud 时使用） */
  ocrCloudBaseUrl: string;
  ocrCloudApiKey: string;
  ocrCloudModel: string;
  /** 工具-模式覆盖层：用户自定义每个工具在 learn/code/work 模式下的可见性。
   *  key = toolId，value = { mode: enabled }。覆盖优先于工具声明的 modes 字段。
   *  空对象 = 全部按默认（modes 字段或全可见），由设置面板 UI 写入。 */
  toolModeOverrides: ToolModeOverrides;
  /** Chat 模式工具增强总开关：false=纯聊天（现状零影响）；true=勾选的工具
   *  经 toolModeOverrides.chat 放行，chat 会话走 CyreneHarness native function calling。 */
  chatToolsEnabled: boolean;
  /** Skill-模式覆盖层：用户自定义每个 skill 在 work/code/learn 模式下的可见性。
   *  key = skillId，value = { mode: enabled }。覆盖优先于 skill 声明的 modes 字段。
   *  空对象 = 全部按默认（modes 字段或全可见），由设置面板 UI 写入。 */
  skillModeOverrides: SkillModeOverrides;
  /** Code 模式使用的用户自管语言服务命令覆盖。 */
  lspServerOverrides: LspServerOverride[];
  /**
   * Git 提交作者名（昔涟创建提交时使用；默认 Cyrene）。
   * 内置 git 禁用了全局配置，提交身份完全由这里提供。
   */
  gitCommitAuthorName: string;
  /**
   * Git 提交作者邮箱（必填）：未填写时 git_commit 会拒绝提交并提示来设置里补填。
   */
  gitCommitAuthorEmail: string;
  /** 最近绑定的项目文件夹（绝对路径），按最近使用时间倒序，最多保留 10 个。 */
  recentProjects: string[];
  /** 用户明确接受的免责声明版本；空字符串表示尚未接受当前条款。 */
  disclaimerAcceptedVersion?: string;
}
