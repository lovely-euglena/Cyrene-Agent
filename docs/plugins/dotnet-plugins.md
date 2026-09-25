# Cyrene .NET 插件开发指南（双轨制第二轨）

> 适用于 Cyrene-Agent v2.0.0+。本文是 .NET 插件轨的完整开发文档；
> Node 插件（第一轨）见 [plugin-authoring.md](./plugin-authoring.md)。

## 为什么有两条轨

| | Node 插件（默认） | .NET 插件 |
|---|---|---|
| 运行位置 | 宿主 Electron 主进程内 | **独立子进程** |
| 隔离 | 无（与宿主同生共死） | 进程级（崩溃不影响主程序） |
| 适用 | 网络转发 / OAuth / 文件导出等 IO 型 | **性能敏感 / 系统级**（硬件采样、本地推理、重度计算） |
| 运行时要求 | 随宿主 | 用户机 .NET 10 Runtime（主程序原生窗口已要求，无额外负担） |
| 生态 | 现有 13+ 插件 | 全新 |

两条轨在宿主侧共用同一套 PluginManager：启停、设置面板、市场分发、
权限声明完全一致——区别只在 `manifest.json` 的 `runtime` 字段与入口类型。

## 5 分钟上手

### 1. 建工程

```bash
dotnet new console -n MyPlugin
cd MyPlugin
```

引用 SDK（两种方式任选）：

```bash
# 方式 A：项目引用（推荐，跟随主仓库构建）
dotnet add reference ../Cyrene-Agent/dotnet/plugin-sdk/Cyrene.PluginSdk/Cyrene.PluginSdk.csproj
# 方式 B：直接拷贝 SDK 目录下的 .cs 源文件进工程（零依赖）
```

### 2. 写插件类

```csharp
using System.Text.Json;
using Cyrene.PluginSdk;

public sealed class MyPlugin : CyrenePluginBase
{
    [CyreneTool("greet", "问候", "生成一句问候语",
        Schema = """{"type":"object","properties":{"name":{"type":"string","description":"对方名字"}},"required":["name"]}""")]
    public object Greet(JsonElement args)
    {
        var name = args.TryGetProperty("name", out var n) ? n.GetString() : "朋友";
        Log($"greet 被调用: {name}");           // 走协议 log 帧（勿用 Console.WriteLine!）
        return new { message = $"你好，{name}！", at = DateTime.Now };
    }
}
```

`Program.cs` 一行：

```csharp
CyrenePluginBase.Run(new MyPlugin());
```

### 3. 发布

```bash
dotnet publish -c Release -r win-x64 /p:SelfContained=false
```

framework-dependent 发布：产物是几百 KB 的 exe + dll，
依赖用户机的 .NET 10 Runtime（主程序原生窗口同样依赖，用户已具备）。

### 4. 组装插件目录

```text
my-plugin/
  manifest.json
  MyPlugin.exe        ← publish 产物（exe + 全部 dll）
  ...dll
```

`manifest.json`：

```json
{
  "apiVersion": 1,
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "description": "示例 .NET 插件",
  "author": "你",
  "runtime": "dotnet",
  "entry": "MyPlugin.exe",
  "defaultEnabled": false
}
```

与 Node 插件仅两处不同：
- `"runtime": "dotnet"`（缺省为 `"node"`，存量插件无需改动）
- `entry` 指向 `.exe` 而非 `.cjs`

### 5. 安装

ZIP 打包（结构同 Node 插件：根目录或唯一顶层目录含 manifest.json）后，
在 **插件管理窗（原生）→ 插件市场 / ZIP 导入** 安装，或解压到：

```text
%APPDATA%\light2d-cyrene\plugins\my-plugin\
```

## 能力 API（IPC / 事件 / 提示词 / 存储 / open）

v2 桥（宿主 init 携带 `protocolVersion: 2` 时启用）让 .NET 插件获得与 Node 轨同源的
宿主能力；命名空间、冲突检测、超时与回收全部复用宿主 `PluginContext`。
以下注册都写在 `OnStartupAsync` 里（随 `ready` 一次性声明；ready 之后再调用会动态补登记）。

### 插件私有 IPC（面板交互）

```csharp
RegisterIpc("settings", (args, token) => Task.FromResult<object?>(new { ok = true, count = args.Length }));
// 面板/渲染端经 plugin:my-plugin:settings 调用；返回值序列化为 JSON，抛异常自动转错误
```

### 事件（订阅宿主 / 发布自有）

```csharp
Events.On("host:turn:finished", (payload, token) =>
{
    Log("一轮结束");
    return Events.EmitAsync("turn_seen", new { at = DateTimeOffset.UtcNow });
});
```

### 每轮提示词贡献

```csharp
RegisterPromptProvider(new PromptProvider
{
    Id = "ctx",
    Modes = ["code"],
    Sources = ["conversation"],
    Provide = (input, token) => Task.FromResult($"[state] mode={input.Mode}"),
});
```

### 私有存储（与 Node 轨同格式，可跨轨迁移）

```csharp
Storage.Set("lastRun", DateTimeOffset.UtcNow);
var last = Storage.Get<DateTimeOffset?>("lastRun");
```

### 宿主服务（deps）

先在 manifest 声明能力，再用 `Deps.*` 调用（未声明即调用会抛 `NotSupportedException`；
宿主侧错误以 `PluginHostException.Code` 返回，错误码与 Node 轨 `E_*` 一致）：

```json
{ "deps": ["llm", "secrets", "conversations", "workspace", "scheduler", "channels"] }
```

```csharp
// 复用宿主模型（排队/限流/重试/用量统计全走宿主）
var text = await Deps.Llm.GenerateTextAsync(
    new[] { new LlmMessage { Role = "user", Content = "把这段话翻译成英文：……" } },
    new LlmGenerateOptions { MaxTokens = 512, Purpose = "translate" });

// 宿主安全存储（密文，插件命名空间隔离）
await Deps.Secrets.SetAsync("apiKey", "sk-...");
var key = await Deps.Secrets.GetAsync("apiKey");

// 只读会话 / 工作区
var page = await Deps.Conversations.ListAsync(new ConversationListInput { Limit = 20 });
var binding = await Deps.Workspace.GetBindingAsync(conversationId);

// 插件定时任务（创建即停用，需用户在宿主界面授权）
await Deps.Scheduler.CreateTaskAsync(new ScheduledTaskInput
{
    Title = "每日提醒", Schedule = ScheduleConfig.Daily("09:00"),
    Prompt = "提醒我今天的安排", Mode = "work", AllowedToolIds = ["builtin_calendar"],
});

// 渠道发现
var hasFeishu = await Deps.Channels.HasAsync("feishu");
```

> `deps.llm.runGoal`（无头目标循环）尚未开放；渠道 adapter / 语音输入租约规划中。

### open（自有窗口）

重写 `OnOpenAsync` 即视为声明 open 能力，管理窗「打开」按钮随之可用；
窗口由插件进程自管，进程退出即随之关闭。

> 旧宿主（init 不带 `protocolVersion`）下这些 API 会抛 `NotSupportedException`
> 并在 `ready` 前以 `startup_failed` 致命帧退出——插件只用工具能力时不受影响。

## 协议参考

宿主与插件经 **stdin/stdout 的 JSON 行协议** 通信（UTF-8，`\n` 分帧）。
SDK 已完整封装——以下仅排查问题或从零实现其他语言时需要。

### 宿主 → 插件

```jsonc
{"op":"init","apiVersion":1,"manifest":{...},"dataDir":"<插件私有数据目录>"}   // 启动握手
{"op":"invoke","callId":"c1","tool":"greet","args":{"name":"昔涟"}}           // 工具调用
{"op":"cancel","id":"c1","reason":"abort|timeout"}                            // 取消在途调用（尽力）
{"op":"shutdown"}                                                             // 优雅关停
```

### 插件 → 宿主

```jsonc
{"op":"ready","tools":[{"id":"greet","name":"问候","description":"...","inputSchema":{...}}]}  // init 应答
{"op":"result","callId":"c1","ok":true,"data":{...}}        // invoke 成功
{"op":"result","callId":"c1","ok":false,"error":"..."}      // invoke 失败
{"op":"log","level":"info|warn|error","message":"..."}     // 诊断日志
{"op":"error","code":"api_version_mismatch","message":"...","fatal":true}  // 致命错误 → 退出
```

### v2 桥（宿主 `protocolVersion:2` 时启用）

```jsonc
// 通用请求 / 应答（两个方向同构；id 由请求方生成）
{"op":"call","id":"h1","method":"ipc.dispatch","params":{...}}   // 宿主 → 插件
{"op":"reply","id":"h1","ok":true,"data":{...}}                  // 插件 → 宿主
{"op":"reply","id":"h1","ok":false,"error":"..."}
{"op":"notify","method":"event.deliver","params":{"event":"host:turn:finished","payload":{...}}}
```

| 方向 | 方法 | 说明 |
|---|---|---|
| 宿主→插件 | `ipc.dispatch` | 面板/渲染端调用插件私有 channel（30s 兜底超时） |
| 宿主→插件 | `prompt.provide` | 每轮提示词组装（宿主注册表 2s 超时，这里 5s 兜底清理） |
| 宿主→插件 | `plugin.open` | 管理窗「打开」按钮（15s 超时） |
| 插件→宿主 | `events.emit` | 发布插件事件（宿主限定 `plugin:<id>:*` 命名空间） |
| 插件→宿主 | `events.subscribe` / `events.unsubscribe` | 动态增删宿主事件订阅 |
| 插件→宿主 | `ipc.register` / `ipc.unregister` | 动态增删 IPC channel |
| 插件→宿主 | `prompt.register` / `prompt.unregister` | 动态增删提示词 Provider |
| 插件→宿主 | `deps.channels.has` | 渠道只读发现 |
| 插件→宿主 | `deps.llm.generateText` | 宿主模型（排队/超时/用量归因全走宿主） |
| 插件→宿主 | `deps.secrets.get` / `set` / `delete` | 宿主安全存储（E_* 错误码透传） |
| 插件→宿主 | `deps.conversations.list` / `getMessages` | 只读会话（游标分页） |
| 插件→宿主 | `deps.workspace.getBinding` | 只读工作区绑定 |
| 插件→宿主 | `deps.scheduler.createTask` / `listTasks` / `updateTask` / `deleteTask` / `getHistory` | 插件定时任务 |

`ready` 声明（宿主据此注册，不等动态调用）：

```jsonc
{"op":"ready","protocolVersion":2,
 "tools":[...],
 "ipc":["settings"],
 "events":["host:turn:finished"],
 "promptProviders":[{"id":"ctx","modes":["code"],"sources":["conversation"]}],
 "capabilities":{"open":true}}
```

### 时序与约束

- 宿主 spawn 插件 → 发 `init` → 插件须 **30 秒内** 回 `ready`（超时判启动失败）
- 工具 id 在 manifest 侧自动加 `插件id_` 前缀（`[CyreneTool("greet")]` → 全 id `my-plugin_greet`）
- **stdout 被协议独占**：任何非 JSON 行会被宿主丢弃——诊断走 `Log()` 或 stderr
- `shutdown` 后 5 秒未退出，宿主强制结束进程
- 单次 `invoke` 宿主兜底超时 **300 秒**（`CYRENE_PLUGIN_INVOKE_TIMEOUT_MS` 可调）；工具应自觉
  控制时长，超时调用以错误返回、插件进程继续存活
- 宿主超时或用户取消（AbortSignal）时会补发 `cancel` 帧；工具声明了
  `(JsonElement, CancellationToken)` 签名即可立即中止计算，未声明则忽略（旧 SDK 也安全忽略）
- 协议主版本不符：插件回 `{"op":"error","code":"api_version_mismatch",...}` 并退出，宿主拒绝握手
- v2 桥启用条件：宿主 init 带 `protocolVersion:2` **且** 插件 ready 回 `protocolVersion>=2`；
  任一缺失都按 v1 运行（旧插件/旧宿主互不感知）
- 插件意外退出：在途调用立即失败，本代 v2 注册（IPC/事件/提示词/open）全部撤销；
  宿主会在**下次工具调用时自动重启一次**（自愈），重启 ready 后按新声明重建；
  重启失败才把错误抛给调用方，同时插件状态在管理窗显示为 failed

## SDK API

### `CyrenePluginBase`

| 成员 | 说明 |
|---|---|
| `static Run(CyrenePluginBase)` | 启动协议循环（阻塞至 shutdown） |
| `string DataDir { get; }` | 插件私有数据目录（`userData/plugin-data/<pluginId>`，init 下发） |
| `void Log(string, string level = "info")` | 结构化日志（协议 log 帧） |
| `PluginStorage Storage { get; }` | 私有 KV（与 Node 轨同格式 `<DataDir>/<key>.json`，原子写） |
| `PluginEvents Events { get; }` | `On/Off` 订阅宿主事件、`EmitAsync` 发布插件事件 |
| `PluginDeps Deps { get; }` | 宿主服务：`Llm` / `Secrets` / `Conversations` / `Workspace` / `Scheduler` / `Channels`（按 manifest.deps 声明可用） |
| `void RegisterIpc(string channel, handler)` | 注册私有 IPC（handler 收 `JsonElement[]` + `CancellationToken`） |
| `void UnregisterIpc(string channel)` | 注销私有 IPC |
| `void RegisterPromptProvider(PromptProvider)` | 注册每轮提示词 Provider |
| `void UnregisterPromptProvider(string id)` | 注销提示词 Provider |
| `Task EmitEventAsync(string, object?)` | 发布插件事件的语法糖（等价 `Events.EmitAsync`） |
| `virtual Task OnStartupAsync(CancellationToken ct)` | init 之后、`ready` 之前调用（注册能力/初始化） |
| `virtual Task OnShutdownAsync(CancellationToken ct)` | 收到 `shutdown` 帧时调用（5s 内返回，超时被强杀） |
| `virtual Task OnOpenAsync(CancellationToken ct)` | 重写即声明 open 能力（管理窗「打开」按钮） |

### `[CyreneTool(id, name, description)]`

- 方法签名：`object / Task / Task<T> Method(JsonElement args)`，参数也可以是空（`Method()`），
  或追加取消令牌 `Method(JsonElement args, CancellationToken ct)`；
  签名在 init 时校验，不合法只告警并跳过该工具（不注册）
- 可选属性 `Schema`：输入 JSON Schema 字符串（默认空对象；非法 JSON 会告警并回退空对象）
- 可选属性 `Risk`：风险级 `safe | fs-read | fs-write | shell | network | input-control`，
  透传给宿主权限策略（Permission Policy）参与审批分级；**写文件/执行命令/联网的工具
  务必显式声明**，缺省按 `safe` 处理（不触发对应审批）
- 返回值序列化为 JSON 回传；抛异常自动转 `ok:false`
- 支持 static 方法（工具方法无需实例状态时）

## 与 Node 插件的能力对照

| 能力 | Node 插件 | .NET 插件（当前版本） |
|---|---|---|
| 工具注册 | ✅ `ctx.registerTool` | ✅ `[CyreneTool]` |
| 插件私有 IPC | ✅ `ctx.registerIpc` | ✅ `RegisterIpc` |
| 事件订阅 / 发布 | ✅ `ctx.events` | ✅ `Events.On / EmitAsync` |
| 每轮提示词贡献 | ✅ `ctx.registerPromptProvider` | ✅ `RegisterPromptProvider` |
| 私有存储 | ✅ `ctx.storage` | ✅ `Storage`（同文件格式，可跨轨复用数据） |
| 自有窗口 | ✅ `open()`（宿主 BrowserWindow） | ✅ `OnOpenAsync`（插件进程自管 WPF 窗口） |
| 设置面板（HTML） | ✅ `settingsPanel` | ✅（同一机制，HTML 面板与运行时无关） |
| LLM 服务注入（deps） | ✅ | ✅ `Deps.Llm.GenerateTextAsync`（`runGoal` 规划中） |
| 密钥 / 会话 / 工作区 / 定时任务 | ✅ | ✅ `Deps.Secrets / Conversations / Workspace / Scheduler` |
| 渠道发现 | ✅ | ✅ `Deps.Channels.HasAsync`（注册渠道 adapter 规划中） |
| 渠道 adapter | ✅ | ❌（规划中） |
| 语音输入租约 | ✅ | ❌（规划中） |

> 渠道 adapter 与语音输入仍是 Node 轨的领域；.NET 轨现已覆盖工具、面板交互、上下文注入、
> 事件互通、宿主服务（LLM/密钥/会话/工作区/定时任务）与自有窗口。

## 安全模型（与 Node 轨一致）

- 插件进程拥有用户级本机权限——**只安装可信来源**
- 用户插件首次发现一律停用，须在管理窗手动启用
- ZIP 安装与市场分发走同一管线（身份校验 + sha256）

## 完整示例

可运行的最小示例在主仓库：

```text
dotnet/plugin-sdk/Example/          ← echo（同步）+ echo_async（Task<string>）+ echo_slow（取消）
                                       + IPC/提示词/事件/open/KV/deps 回归夹具 + manifest 模板
```

本地自测（不依赖宿主，直接喂协议帧）：

```bash
cd dotnet/plugin-sdk/Example
echo '{"op":"init","apiVersion":1,"protocolVersion":2,"manifest":{"id":"hello"},"dataDir":"/tmp/h"}' | dotnet run
# → {"op":"ready","protocolVersion":2,"tools":[...],"ipc":["ping"],...}
```

端到端协议自测（构建 SDK + Example，覆盖工具 / v2 桥 / 取消 / 版本不符）：

```bash
npm run test:dotnet-plugin-sdk
```
