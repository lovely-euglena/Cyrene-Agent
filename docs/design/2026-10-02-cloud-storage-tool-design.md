# 云存储直连工具设计（FTP / FTPS / SFTP / WebDAV / S3）

> **日期**：2026-10-02
> **状态**：设计草案（待评审）
> **结论先行**：新增 `cyrene-native --storage-host` 有状态托管宿主（与 `--ssh-host` 同构：
> 档案 + DPAPI 凭据 + 会话复用 + stdio JSON 行协议），Electron 侧只加薄代理工具
> `cloud_*`（6 个）。协议实现全部在 .NET：**SFTP 用已引入的 SSH.NET**，
> **FTP/FTPS 用 FluentFTP**，**WebDAV 用 WebDAVClient**，
> **S3 用 AWSSDK.S3**（自定义 endpoint + path style，覆盖 MinIO/R2/B2 等 S3 兼容存储）。
> 不做 TS 客户端库路线，也不做自建 MCP server 路线（理由见 §3）。

---

## 1. 背景与目标

需求：给 Agent 加一个「直接操作云存储」的内置工具——列目录、读取、上传、下载、建目录、
移动/复制、删除远端文件，覆盖 **FTP / FTPS / SFTP / WebDAV / S3** 五类协议。

设计目标：

1. 复用已有基建：`.NET` 托管宿主（`--tool-host` / `--ssh-host` / `--mcp-host`）、
   权限审批链（risk/effectKind）、工具注册表与快照门禁、便携模式 data-dir。
2. 凭据只落 .NET 侧（DPAPI 加密），TS 层不持久化任何秘密（与 SSH 同约定）。
3. 工具面对模型友好：读写操作按风险分级，错误结构化（`success:false` + `errorCode`），
   与执行器的错误识别协议对齐。
4. 协议可逐批交付：FTP/FTPS/SFTP 一批，WebDAV/S3 一批，互不阻塞。

非目标（本期不做）：

- SCP（SSH.NET `ScpClient` 可后续补上）；
- 网盘 OAuth（百度网盘 / OneDrive / Google Drive 等消费级网盘）；
- 对象存储管理面（建桶 / 改 ACL / 生命周期）；断点续传、进度条、并发传输池；
- 独立于主程序的安装包外渠道（见 §3 的 MCP 备选）。

## 2. 可复用资产（现状）

| 资产 | 位置 | 复用方式 |
| --- | --- | --- |
| SSH 有状态宿主 | `dotnet/native-windows/Ssh/`（`SshHost` / `SshSessionManager` / `SshProfileStore`） | 整体结构照搬：`StorageHost` / `StorageSessionManager` / `StorageProfileStore` |
| DPAPI 凭据存储 | `SshProfileStore.cs`（`dpapi:` / `plain:` 前缀，兼容手编明文） | 复制同一加密约定，`storage-profiles.json` |
| 宿主薄代理 | `src/main/ssh/native-ssh-host.ts` | 复制为 `src/main/cloud-storage/native-storage-host.ts`（超时只放弃等待、不杀进程） |
| 工具面范式 | `src/main/ssh/ssh-tools.ts` | 5→6 个 `cloud_*` 工具，同样的描述风格（何时用 / 不要用于 / 参数） |
| 注册位与顺序门禁 | `src/main/orchestrator/tools/built-in-tools.ts` + `built-in-tools.snapshot.test.ts` | SSH 之后注册；快照列表同步追加 |
| 权限模型 | `src/main/permission-policy.ts` | `safe / network / fs-write` 三档覆盖：读用 network，写用 fs-write |
| 便携模式 | `src/main/portable/bootstrap` | data-dir 用 `app.getPath("userData")`，便携重定向自动生效（同 SSH） |
| 打包 | `electron-builder.yml` `extraResources` 收整个 native publish 目录 | NuGet 依赖随 publish 输出自动进包，**无需改打包配置** |

## 3. 方案对比与结论

| 方案 | 集成度 | 凭据安全 | 依赖位置 | 发布/更新 | 结论 |
| --- | --- | --- | --- | --- | --- |
| A. TS 工具 + npm 客户端库（basic-ftp / ssh2-sftp-client / webdav / @aws-sdk/client-s3） | 中（可直接写业务） | safeStorage/插件 storage，弱于 DPAPI | Electron main 进程 | 随主程序 | 否：5 套库进主进程，体积与攻击面都增加；且与「此类模块下沉 .NET」的既定路线相悖 |
| B. .NET 有状态宿主 `--storage-host` + `cloud_*` 薄工具 | 高（与 SSH 完全同构） | DPAPI CurrentUser，秘密不过 TS | `cyrene-native`（已在) | 随主程序 | **采用** |
| C. 自建 MCP server（C#，走 MCP 安装/市场） | 中（MCP annotations 只能表达 fs-read/fs-write，表不出 network，缺失档案/设置体验） | 由 MCP server 自管 | 独立进程/发行物 | 独立于主程序更新 | 备选：未来若要「插件仓库分发」再抽同款 .NET 库封装；首方能力不适合作 MCP |

补充说明：MCP 路线对 `readOnlyHint → fs-read`、`destructiveHint → fs-write` 的映射
（`mcp-adapter.ts`）能兜住权限，但档案管理、测试连接、设置页接入、便携 data-dir 都要重造一遍；
且用户需要先「安装 MCP server」才能用。首方内置能力用 B 最省成本、体验最好。

## 4. 总体架构

```text
Electron Main（TS）
  cloud_profiles / cloud_profile_save / cloud_read /
  cloud_download / cloud_upload / cloud_manage      ← src/main/cloud-storage/storage-tools.ts
        │  (op, params) JSON 行
        ▼
  native-storage-host.ts（薄代理；超时不杀进程，退出拒在途）
        │  spawn: cyrene-native --storage-host --data-dir <userData>
        ▼
cyrene-native（.NET，常驻子进程）
  StorageHost.cs            协议循环（ready/result/log/shutdown，stdin EOF 收尾）
  StorageProfileStore.cs    storage-profiles.json（DPAPI；列表投影不含秘密）
  StorageSessionManager.cs  每档案会话（懒连接/keepalive/信号量串行/空闲回收）
  Providers/
    FtpStorageProvider.cs      ftp / ftps（explicit、implicit）  → FluentFTP
    SftpStorageProvider.cs     sftp                                → SSH.NET
    WebDavStorageProvider.cs   webdav / webdavs                    → WebDAVClient
    S3StorageProvider.cs       s3（自定义 endpoint、path style）  → AWSSDK.S3
    IStorageProvider.cs        统一操作面：ls/read/write/delete/mkdir/move/copy/test
    StoragePaths.cs            远端路径规范化 + root 钳制
```

要点：

- 与 `--ssh-host` 同构：一个常驻子进程、stdio JSON 行协议、`trackChildProcess` 收尸、
  宿主退出（stdin EOF）统一 CloseAll 后退出。
- 会话按档案隔离并**串行化**（FTP/SFTP 客户端非线程安全；长传输会占住该档案的队列，
  与 SSH 同语义，文档写明）。
- 空闲会话（默认 10 分钟）自动断开，下次调用懒重连。

## 5. 技术选型（.NET 依赖）

| 协议 | 库 | 版本（拟） | 许可 | 说明 |
| --- | --- | --- | --- | --- |
| SFTP | SSH.NET（已引用） | 2026.0.0 | MIT | 与 `--ssh-host` 同库；`SftpClient` 直接可用 |
| FTP / FTPS | FluentFTP | 55.0.0 | MIT | explicit（AUTH TLS, 21）/ implicit（990）都支持；UTF-8、被动模式成熟 |
| WebDAV | WebDAVClient | 2.7.0 | MIT | saguiitay/WebDAVClient，2026-05 更新；PROPFIND 兼容性交给库 |
| S3 | AWSSDK.S3 | 4.0.104 | Apache-2.0 | 官方 SDK；`ServiceURL` + `ForcePathStyle` 覆盖 MinIO/R2/B2；multipart 自动 |

补充：

- S3「自定义 endpoint + path style」是**必做**项（NAS/自建 MinIO 大多不支持 virtual-host 风格）。
- FTPS / WebDAV 常见自签证书：档案提供 `allowInvalidCert`（默认 false），开启时明确提示风险。
- 体积：AWSSDK 系列约数 MB（publish 目录增量），桌面安装包可接受；如后续在意可换最小实现（不推荐，见 §13）。
- WebDAV 若遇兼容性坑（`WebDAVClient` 对个别服务器 PROPFIND 解析不佳），退路是自带极简客户端
  （`HttpClient` + `HttpMethod("PROPFIND")` + XML 解析），接口不变、只换 Provider 实现。

## 6. 档案模型（`<data-dir>/storage-profiles.json`）

```jsonc
{
  "version": 1,
  "profiles": [
    {
      "id": "8f3…",            // 自动生成
      "name": "家里 NAS",       // 展示名，唯一性不强制，解析按 id > name > host
      "protocol": "sftp",       // ftp | ftps | sftp | webdav | s3
      "host": "192.168.1.10",
      "port": 22,
      "username": "cyrene",
      "rootPath": "/data",      // 远端根；所有工具路径相对它，且钳制不逃逸
      "secretEnc": "dpapi:…",   // 协议相关的秘密字段（见下表），只写加密形态
      "createdAt": "…", "updatedAt": "…"
    }
  ]
}
```

各协议字段（`profiles.upsert` 的参数同构）：

| protocol | 必填 | 可选 | 秘密字段（DPAPI） |
| --- | --- | --- | --- |
| `ftp` | host | port(21), username, rootPath, passive(默认 true) | `password` |
| `ftps` | host | port(21 explicit / 990 implicit), username, rootPath, `tlsMode`(explicit\|implicit，默认 explicit), allowInvalidCert | `password` |
| `sftp` | host | port(22), username, `authType`(password\|privateKey), privateKeyPath, rootPath | `password` / `passphrase` |
| `webdav` | `baseUrl`(http/https) | username, rootPath, authType(basic\|digest\|none), allowInvalidCert | `password` |
| `s3` | `bucket` | endpoint(空=AWS), region, `pathStyle`(默认有 endpoint 时 true), `prefix`(=rootPath) | `accessKeyId` + `secretAccessKey`（+ sessionToken?） |

细节沿用 SSH 档案约定的三条：

1. **DPAPI（CurrentUser）加密落盘**，不可用时降级 `plain:` 并如实记录；读取兼容手编明文，下次保存自动升级。
2. **列表投影**（`profiles.list`）只回 `hasPassword` 等布尔位，不透出任何秘密与加密串。
3. **`fromSshProfile` 便利项**：`profiles.upsert` 传 `fromSshProfile:"<SSH 档案名>"` 时，
   从同目录 `ssh-profiles.json` 复制 host/port/username/auth/密码到新 SFTP 档案（一次性拷贝，
   运行时不跨库耦合）。

## 7. 宿主协议（`cyrene-native --storage-host`）

帧协议与 `SshHost` 完全一致：`ready` 帧、`{"op":"result","callId","ok":true,"data"}`、
错误 `"ok":false,"error"`、诊断走 `log` 帧；`shutdown` / stdin EOF 幂等退出。

| op | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `profiles.list` | — | `[{id,name,protocol,host,port,username,rootPath,hasPassword,...}]` | 无秘密 |
| `profiles.upsert` | `profile` | 保存后的公开投影 | add/update（有 id 即 update） |
| `profiles.remove` | `id` | `true/false` | — |
| `profiles.test` | `profileId` | `{ok, latencyMs, error?}` | 设置页「测试连接」/ 未来工具 |
| `status` | — | `{sessions:[{profileId,state,lastUsedAt}]}` | 会话状态 |
| `ls` | `profileId,path,maxEntries?` | `{entries:[{name,path,type,size,modifiedAt}],truncated}` | type: dir/file/link |
| `read` | `profileId,path,maxBytes?` | `{kind:"dir"…}` 或 `{kind:"file",text,truncated,encoding}` / `{kind:"binary",size}` | 目录→列表；文件→小文本内联（默认上限 256KB，二进制不返回内容） |
| `write` | `profileId,path,content?/localPath?,overwrite?,createParents?` | `{bytes}` | 本地文件或文本内容写入远端 |
| `copyFrom` | `profileId,path,localPath,overwrite?,timeoutMs?` | `{bytes}` | 远端→本地（下载） |
| `copyTo` | `profileId,localPath,path,overwrite?,timeoutMs?` | `{bytes}` | 本地→远端（上传） |
| `mkdir` | `profileId,path,recursive?` | `true` | — |
| `delete` | `profileId,paths[],recursive?` | `{deleted:[…],failed:[…]}` | 逐条结果，部分失败不整单失败 |
| `move` | `profileId,from,to,overwrite?` | `true` | 同档案内 |
| `copy` | `profileId,from,to,overwrite?` | `true` | 同档案内 |
| `close` | `profileId?`（缺省全部） | `true` | — |
| `shutdown` | — | 进程退出 | — |

错误码（统一 `errorCode`，TS 层原样透传给模型）：

```text
STORAGE_PROFILE_NOT_FOUND / STORAGE_AUTH_FAILED / STORAGE_CONNECT_FAILED
STORAGE_TIMEOUT / STORAGE_NOT_FOUND / STORAGE_ALREADY_EXISTS
STORAGE_PATH_INVALID / STORAGE_UNSUPPORTED / STORAGE_IO_ERROR / STORAGE_BINARY_FILE
```

## 8. 工具面（TS，`cloud_*`，6 个）

| id | name | risk | effectKind | 说明 |
| --- | --- | --- | --- | --- |
| `cloud_profiles` | 云存储档案列表 | `safe` | `read` | 列档案 + 活跃会话；解析档案引用（id > 名称 > 主机）的公共前置 |
| `cloud_profile_save` | 保存云存储档案 | `fs-write` | `mutation` | add/update/remove；密码只经此进 .NET；支持 `test:true` 保存后自检 |
| `cloud_read` | 读取云存储路径 | `network` | `read` | 目录→列表；文件→小文本内联（截断标记）；二进制→元数据 + 提示用下载 |
| `cloud_download` | 下载云存储文件 | `fs-write` | `mutation` | 远端→本地文件（默认不覆盖、自动建本地父目录） |
| `cloud_upload` | 上传到云存储 | `fs-write` | `mutation` | 本地文件或直接文本内容→远端文件（默认不覆盖、可建远端父目录） |
| `cloud_manage` | 管理云存储路径 | `fs-write` | `mutation` | action: mkdir / delete / move / copy；delete 需显式 path，recursive 显式 |

设计取舍：

- **读用 `network`、写用 `fs-write`**（与 `permission-policy.ts` 档位语义对齐）：
  只读档可以列目录/读文本，但不能落盘/改远端；`safe` 只留给不走网络、不改状态的
  `cloud_profiles`（同 `ssh_profiles`）。
- 不做 `cloud_open/close`：连接全懒加载（区别于 SSH 的显式 open），少一个工具；
  断开需求由 `cloud_manage` 之外不暴露（宿主有 `close` op 供设置页/后续用）。
- 不新增独立 `stat`：`cloud_read` 对文件已返回元数据。
- 工具有 `modes: learn/code/work`（同 SSH），描述风格沿用「何时用 / 不要用于 / 参数」。
- 错误一律 `JSON.stringify({ success:false, errorCode, message, retryable })`；
  成功结果也带 `success:true`（与 OCR 工具的结构化协议对齐，执行器识别稳定）。

## 9. 安全与权限

1. **凭据**：只经 `cloud_profile_save` 传入，落盘即 DPAPI 加密；TS 侧无缓存、无日志。
2. **路径钳制**：所有远端路径相对 `rootPath` 解析，规范化后越出 root（`..`）直接
   `STORAGE_PATH_INVALID`，确保档案凭据不能借工具翻出配置目录之外的整盘。
3. **本地路径**：下载/上传的本地路径由模型提供、按 `fs-write` 档位走审批；
   文件名不含 `..` 之外不做额外沙箱（与 `run_shell` 同级信任），文档明确这一点。
4. **覆盖保护**：`write / copyFrom / copyTo / move / copy` 默认 `overwrite:false`，
   已存在即 `STORAGE_ALREADY_EXISTS`；删除必须显式列 path，`recursive` 必须显式传。
5. **限额**：`read` 内联 ≤256KB；`ls` 默认 ≤500 条（带 truncated）；传输超时
   1s–1h（默认 10 分钟），超时只放弃等待（宿主侧尽力取消，会话保留）。
6. **TLS**：FTPS/WebDAV 默认校验证书；`allowInvalidCert` 需用户显式开启（描述里警告）。
7. **权限档位效果**：只读档 = 只能 `cloud_profiles` + `cloud_read`；
   指定目录/每次审批档才可写（与现有 `policyFor` 一致，无新档位）。

## 10. 改动清单（文件级）

新增（.NET）：

- `dotnet/native-windows/Storage/StorageHost.cs`（协议循环，照 `SshHost.cs`）
- `dotnet/native-windows/Storage/StorageProfileStore.cs`（照 `SshProfileStore.cs`）
- `dotnet/native-windows/Storage/StorageSessionManager.cs`
- `dotnet/native-windows/Storage/StoragePaths.cs`
- `dotnet/native-windows/Storage/Providers/{IStorageProvider,FtpStorageProvider,SftpStorageProvider,WebDavStorageProvider,S3StorageProvider}.cs`
- 改 `dotnet/native-windows/Program.cs`：加 `--storage-host` 分支
- 改 `dotnet/native-windows/CyreneNative.csproj`：`FluentFTP`、`WebDAVClient`、`AWSSDK.S3`

新增（TS）：

- `src/main/cloud-storage/native-storage-host.ts`（照 `native-ssh-host.ts`）
- `src/main/cloud-storage/storage-tools.ts` + `storage-tools.test.ts`（假 caller，照 `ssh-tools.test.ts`）
- 改 `src/main/orchestrator/tools/built-in-tools.ts`：SSH 工具之后注册
- 改 `src/main/orchestrator/tools/built-in-tools.snapshot.test.ts`：追加 6 个 id 到门禁列表

文档/测试/发布：

- 本设计文档；使用说明（后续 `docs/` 简版）
- `scripts/diagnostics/cloud-storage-smoke.mjs`（宿主协议冒烟，见 §11）
- 发布流程不变：`dotnet publish dotnet/native-windows -c Release -r win-x64 /p:SelfContained=false`
  → `electron-builder`（NuGet 依赖随 publish 目录进 `resources/native-windows/`）。
  注：`package:win:dir` 与 `.github/workflows/package-windows.yml` 目前都没有 native-windows
  发布步骤（历史缺口），随本功能一并补一个 `build:native` npm script 并接进两处。

## 11. 测试与冒烟

1. **TS 单测**（vitest，假 caller）：6 工具的注册/风险/参数校验/档案解析/错误码透传/
   超时钳制/覆盖保护语义——与 `ssh-tools.test.ts` 同粒度。
2. **.NET 冒烟脚本**（`scripts/diagnostics/cloud-storage-smoke.mjs`）：
   起本地临时服务 → `--storage-host` 走 `profiles.upsert → ls → write → read → copyTo/copyFrom →
   move/copy → delete` → 校验帧与文件落盘，最后清理。
3. **本地测试服务**（开发机可选装，不入包）：
   - SFTP：本机已装 Windows OpenSSH Server（`sshd`，默认停止，可启动）；或用用户的 NAS；
   - FTP/FTPS：Python `pyftpdlib`（可开 TLS）起临时实例；
   - WebDAV：Python `wsgidav` 或 `rclone serve webdav`；
   - S3：MinIO 单 exe 本地起（或用户现有的 S3 兼容服务）。
4. **真机 E2E**：Electron 起 `--storage-host`，对话里让模型使用 `cloud_*`（可参照 OCR 的实机验证）。

## 12. 分期与里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P1 | 宿主骨架 + 档案 + 协议循环 + SFTP + FTP/FTPS + 6 工具 + 单测 | `dotnet build` 0 错；vitest 新增用例全绿；本地 SFTP/FTP 冒烟通过 |
| P2 | WebDAV + S3（含自定义 endpoint/path style） | MinIO + 一个 WebDAV 服务冒烟通过 |
| P3 | 设置页：档案 CRUD + 测试连接（Electron 设置区，WPF 导航入口跳转，照 OCR 模式） | 界面可增删改查 + 测试连接；工具侧不变 |

P1/P2 按「宿主骨架 → 各 Provider → 工具面」分批提交，每个 Provider 独立 commit。

## 13. 风险与备选

| 风险 | 对策 |
| --- | --- |
| FTP 服务器差异（UTF-8 文件名、MLSD/LIST、被动端口） | FluentFTP 已处理大部分；档案可加 `utf8` 切换兜底 |
| WebDAV 服务器差异（Nextcloud/群晖/坚果云 PROPFIND 怪癖） | 用 WebDAVClient；真机各测一台；必要时换极简自带实现（接口不变） |
| FTPS/WebDAV 自签证书 | `allowInvalidCert` 显式开关 |
| 长传输占住档案队列 / 超时后的远端状态未知 | 文档写明；结果里如实标 timedOut；后续可加 cancel op + 进度事件 |
| AWSSDK 体积 | 只引 `AWSSDK.S3`；桌面包可接受，后续若敏感再评估 |
| 与 SSH 档案重复配置 SFTP | `fromSshProfile` 一次性导入，不引运行时耦合 |

备选路线（记录在案，不实施）：把同一套 Provider 代码抽成独立 .NET MCP server，交给
插件/市场渠道分发；届时工具面与权限注解（readOnlyHint/destructiveHint）可按 `mcp-adapter.ts`
的推导规则映射。本设计的分层（Provider 接口 + 档案/路径/会话组件）保证那时只需加一层 server 壳。

## 14. 评审结论（2026-10-02）

1. **方案 B 拍板**：`cyrene-native --storage-host` + `cloud_*` 薄工具。
2. **范围**：FTP / FTPS / SFTP / WebDAV / S3 一次做全，按 Provider 分批提交。
3. **设置页同批做**：档案 CRUD + 测试连接（Electron 设置区 + WPF 导航入口，照 OCR 模式）。
4. **冒烟环境**：本机自测（Windows OpenSSH sshd / 本地临时服务）；WebDAV 与 S3 由用户提供
   真实生产环境服务器做最终验证。
