// 云存储托管工具（.NET --storage-host 的薄代理）。
//
// 连接/会话本体在 cyrene-native --storage-host 进程里（有状态、keepalive、懒重连），
// 这里只负责：参数校验/档案名解析 → JSON 行调用 → 结果透传。
// 密码/AccessKey 只经由 cloud_profile_save 写入 .NET 侧（DPAPI 加密落盘），
// 本层不持久化任何凭据。
//
// 路径坐标系：所有远端 path 相对档案 rootPath（"" 或 "/" = 根）；越界由 .NET 侧拒绝。

import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";

export interface StorageHostCaller {
  (op: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

const STORAGE_MODES = ["learn", "code", "work"] as const;

/** 传输类操作默认/上限（ms）：默认 10 分钟，上限 1 小时。 */
const TRANSFER_TIMEOUT_DEFAULT = 600_000;
const TRANSFER_TIMEOUT_MAX = 3_600_000;

interface StorageProfileView {
  id: string;
  name: string;
  protocol: string;
  host?: string;
  port?: number;
  username?: string;
  rootPath?: string;
  privateKeyPath?: string | null;
  baseUrl?: string;
  bucket?: string;
  endpoint?: string;
  hasPassword?: boolean;
  hasPassphrase?: boolean;
  hasAccessKey?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  const code = (error as { errorCode?: unknown })?.errorCode;
  return typeof code === "string" && code ? code : "STORAGE_IO_ERROR";
}

function retryable(error: unknown): boolean {
  return (error as { retryable?: unknown })?.retryable === true;
}

/** 结构化错误（执行器识别 success:false）。 */
function errorPayload(error: unknown, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    success: false,
    errorCode: errorCode(error),
    message: errorMessage(error),
    retryable: retryable(error),
    ...extra,
  });
}

function okPayload(data: Record<string, unknown>): string {
  return JSON.stringify({ success: true, ...data });
}

function clampTimeout(value: unknown, fallback = TRANSFER_TIMEOUT_DEFAULT): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), 1_000), TRANSFER_TIMEOUT_MAX);
}

async function listProfiles(call: StorageHostCaller): Promise<StorageProfileView[]> {
  const data = await call("profiles.list", {}, 15_000);
  return Array.isArray(data) ? (data as StorageProfileView[]) : [];
}

/** 档案引用解析：id 精确匹配 > 名称忽略大小写 > 主机/baseUrl/bucket 忽略大小写。 */
async function resolveProfileId(call: StorageHostCaller, reference: string): Promise<string> {
  const ref = reference.trim();
  const profiles = await listProfiles(call);
  const byId = profiles.find((p) => p.id === ref);
  if (byId) return byId.id;
  const lower = ref.toLowerCase();
  const byName = profiles.find((p) => (p.name ?? "").toLowerCase() === lower);
  if (byName) return byName.id;
  const byHost = profiles.find((p) => (p.host ?? "").toLowerCase() === lower);
  if (byHost) return byHost.id;
  const byBaseUrl = profiles.find((p) => (p.baseUrl ?? "").toLowerCase() === lower);
  if (byBaseUrl) return byBaseUrl.id;
  const byBucket = profiles.find((p) => (p.bucket ?? "").toLowerCase() === lower);
  if (byBucket) return byBucket.id;
  const available = profiles.map((p) => p.name || p.host || p.baseUrl || p.bucket || p.id).join("、") || "（无）";
  throw new Error(`云存储档案不存在：${ref}。当前可用：${available}`);
}

export function createStorageTools(call: StorageHostCaller): ToolDefinition[] {
  const cloudProfilesTool: ToolDefinition = {
    id: "cloud_profiles",
    name: "云存储档案列表",
    description:
      "列出已配置的云存储档案（FTP/FTPS/SFTP/WebDAV/S3）与当前连接状态（不返回密码）。\n\n" +
      "何时用：\n" +
      "- 用户说「看看配了哪些网盘/服务器」「传到我 NAS 上」前，先确认档案名称\n" +
      "- 执行 cloud_read / cloud_download / cloud_upload / cloud_manage 前不确定用哪个档案\n\n" +
      "不要用于：\n" +
      "- 增删改档案（那是 cloud_profile_save）\n" +
      "- 本地文件（那是 Read / list_dir）\n\n" +
      "参数：无。返回档案的 id / 名称 / 协议 / 主机或地址 / 根路径与活跃连接。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    verificationPolicy: "none",
    modes: [...STORAGE_MODES],
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      try {
        const profiles = await listProfiles(call);
        const status = await call("status", {}, 15_000);
        return okPayload({
          profiles: profiles.map((p) => ({
            id: p.id,
            name: p.name,
            protocol: p.protocol,
            host: p.host || undefined,
            port: p.port || undefined,
            username: p.username || undefined,
            rootPath: p.rootPath || undefined,
            baseUrl: p.baseUrl || undefined,
            bucket: p.bucket || undefined,
            endpoint: p.endpoint || undefined,
            privateKeyPath: p.privateKeyPath ?? undefined,
            hasPassword: p.hasPassword === true,
            hasAccessKey: p.hasAccessKey === true,
          })),
          sessions: (status as { sessions?: unknown } | null)?.sessions ?? [],
        });
      } catch (error) {
        return errorPayload(error);
      }
    },
  };

  const cloudProfileSaveTool: ToolDefinition = {
    id: "cloud_profile_save",
    name: "保存云存储档案",
    description:
      "新增 / 修改 / 删除云存储档案（FTP/FTPS/SFTP/WebDAV/S3）。密码 / AccessKey 经 DPAPI 加密保存在本机，仅当前用户可解。\n\n" +
      "何时用：\n" +
      "- 用户说「加一个 FTP：主机 xxx，用户名 yyy」「把我的 S3/MinIO 配上」\n" +
      "- 用户要改端口 / 换密钥 / 改根目录 / 删掉某个档案\n\n" +
      "不要用于：\n" +
      "- 只是想传文件（用 cloud_upload / cloud_download）\n" +
      "- 用户没明确要求保存凭据时，不要把密码写进档案\n\n" +
      "参数：action（add/update/remove，必填）。\n" +
      "通用：name、protocol（ftp/ftps/sftp/webdav/s3，默认 sftp）、host、port、username、rootPath（远端根，默认 /）。\n" +
      "ftps：tlsMode（explicit/implicit）、allowInvalidCert（自签证书才开）。\n" +
      "sftp：authType=password 传 password；authType=privateKey 传 privateKeyPath（可选 passphrase）。\n" +
      "  已有 SSH 档案时可用 fromSshProfile 一次性导入主机/认证（仅 sftp）。\n" +
      "webdav：baseUrl（http/https 地址，必填）、webdavAuthType（basic/digest/none）。\n" +
      "s3：bucket（必填）、endpoint（MinIO/R2 等自建地址，留空 = AWS）、region、pathStyle、accessKeyId、secretAccessKey。\n" +
      "test（可选，默认 false）：保存后自动测试连接。",
    enabled: true,
    risk: "fs-write",
    effectKind: "mutation",
    verificationPolicy: "none",
    modes: [...STORAGE_MODES],
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "add / update / remove", enum: ["add", "update", "remove"] },
        id: { type: "string", description: "档案 id（update/remove 可用；add 时省略）" },
        name: { type: "string", description: "展示名；update/remove 也可用它指定目标" },
        protocol: { type: "string", description: "ftp / ftps / sftp / webdav / s3", enum: ["ftp", "ftps", "sftp", "webdav", "s3"] },
        host: { type: "string", description: "主机名或 IP（ftp/ftps/sftp）" },
        port: { type: "number", description: "端口（默认 ftp 21 / ftps 21 或 990 / sftp 22）" },
        username: { type: "string", description: "登录用户名" },
        rootPath: { type: "string", description: "远端根路径/前缀（默认 /；s3 为 key 前缀）" },
        tlsMode: { type: "string", description: "ftps 加密模式：explicit（默认）/ implicit", enum: ["explicit", "implicit"] },
        allowInvalidCert: { type: "boolean", description: "允许自签证书（默认 false）" },
        passive: { type: "boolean", description: "FTP 被动模式（默认 true）" },
        authType: { type: "string", description: "sftp 认证：password（默认）/ privateKey", enum: ["password", "privateKey"] },
        password: { type: "string", description: "登录密码（authType=password）" },
        privateKeyPath: { type: "string", description: "私钥文件绝对路径（authType=privateKey）" },
        passphrase: { type: "string", description: "私钥口令（可选）" },
        baseUrl: { type: "string", description: "WebDAV 地址，如 https://nas:5006/dav" },
        webdavAuthType: { type: "string", description: "WebDAV 认证：basic（默认）/ digest / none", enum: ["basic", "digest", "none"] },
        bucket: { type: "string", description: "S3 bucket 名" },
        endpoint: { type: "string", description: "S3 自建 endpoint（MinIO/R2 等；留空 = AWS）" },
        region: { type: "string", description: "S3 region（默认 us-east-1）" },
        pathStyle: { type: "boolean", description: "S3 path style（自建 endpoint 默认 true）" },
        accessKeyId: { type: "string", description: "S3 Access Key ID" },
        secretAccessKey: { type: "string", description: "S3 Secret Access Key" },
        sessionToken: { type: "string", description: "S3 临时会话令牌（可选）" },
        fromSshProfile: { type: "string", description: "从已有 SSH 档案一次性导入 sftp 连接信息（档案名/id）" },
        test: { type: "boolean", description: "保存后测试连接（默认 false）" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args.action ?? "").trim();
      try {
        if (action === "remove") {
          const reference = String(args.id ?? args.name ?? "").trim();
          if (!reference) return errorPayload(new Error("需要提供 id 或 name"));
          const profileId = await resolveProfileId(call, reference);
          await call("profiles.remove", { id: profileId }, 15_000);
          return `已删除云存储档案：${reference}`;
        }
        if (action !== "add" && action !== "update") {
          return errorPayload(new Error("action 必须是 add / update / remove"));
        }

        let id = typeof args.id === "string" ? args.id.trim() : "";
        const nameArg = typeof args.name === "string" ? args.name.trim() : "";
        if (!id && nameArg) {
          const existing = (await listProfiles(call)).find((p) => (p.name ?? "").toLowerCase() === nameArg.toLowerCase());
          if (existing) id = existing.id;
        }

        const profile: Record<string, unknown> = {
          id: id || undefined,
          name: nameArg || undefined,
          protocol: typeof args.protocol === "string" ? args.protocol.trim() : undefined,
          host: typeof args.host === "string" ? args.host.trim() : undefined,
          port: typeof args.port === "number" ? args.port : undefined,
          username: typeof args.username === "string" ? args.username.trim() : undefined,
          rootPath: typeof args.rootPath === "string" ? args.rootPath.trim() : undefined,
          tlsMode: typeof args.tlsMode === "string" ? args.tlsMode.trim() : undefined,
          allowInvalidCert: typeof args.allowInvalidCert === "boolean" ? args.allowInvalidCert : undefined,
          passive: typeof args.passive === "boolean" ? args.passive : undefined,
          authType: typeof args.authType === "string" ? args.authType.trim() : undefined,
          password: typeof args.password === "string" && args.password ? args.password : undefined,
          privateKeyPath: typeof args.privateKeyPath === "string" ? args.privateKeyPath.trim() : undefined,
          passphrase: typeof args.passphrase === "string" && args.passphrase ? args.passphrase : undefined,
          baseUrl: typeof args.baseUrl === "string" ? args.baseUrl.trim() : undefined,
          webdavAuthType: typeof args.webdavAuthType === "string" ? args.webdavAuthType.trim() : undefined,
          bucket: typeof args.bucket === "string" ? args.bucket.trim() : undefined,
          endpoint: typeof args.endpoint === "string" ? args.endpoint.trim() : undefined,
          region: typeof args.region === "string" ? args.region.trim() : undefined,
          pathStyle: typeof args.pathStyle === "boolean" ? args.pathStyle : undefined,
          accessKeyId: typeof args.accessKeyId === "string" && args.accessKeyId ? args.accessKeyId : undefined,
          secretAccessKey: typeof args.secretAccessKey === "string" && args.secretAccessKey ? args.secretAccessKey : undefined,
          sessionToken: typeof args.sessionToken === "string" && args.sessionToken ? args.sessionToken : undefined,
        };
        const fromSshProfile = typeof args.fromSshProfile === "string" && args.fromSshProfile.trim()
          ? args.fromSshProfile.trim()
          : undefined;

        const saved = (await call("profiles.upsert", { profile, fromSshProfile }, 20_000)) as StorageProfileView | null;
        let message = `已保存云存储档案：${saved?.name ?? nameArg ?? profile.host ?? profile.bucket}（id=${saved?.id ?? "?"}，${saved?.protocol ?? profile.protocol}）`;

        if (args.test === true && saved?.id) {
          try {
            const result = (await call("profiles.test", { profileId: saved.id }, 30_000)) as { latencyMs?: number } | null;
            message += `；连接测试通过（${result?.latencyMs ?? "?"}ms）`;
          } catch (error) {
            message += `；连接测试失败：${errorMessage(error)}`;
          }
        }
        return message;
      } catch (error) {
        return errorPayload(error);
      }
    },
  };

  const cloudReadTool: ToolDefinition = {
    id: "cloud_read",
    name: "读取云存储路径",
    description:
      "读取云存储上的目录列表或小文件内容（远端不落盘）。目录返回条目列表；文本文件直接返回内容；二进制/大文件返回元数据与下载建议。\n\n" +
      "何时用：\n" +
      "- 用户说「看看网盘里有什么」「读一下服务器上那个配置文件」\n" +
      "- 上传/下载前确认远端路径存在、大小写是否正确\n\n" +
      "不要用于：\n" +
      "- 大文件或二进制文件（那是 cloud_download）\n" +
      "- 本机文件（那是 Read / list_dir）\n\n" +
      "参数：profile（必填，档案 id / 名称 / 主机或 bucket，可先调 cloud_profiles 查）；\n" +
      "path（可选，相对档案根，默认根目录）；maxBytes（可选，文本内联上限，默认 256KB，最大 2MB）；\n" +
      "maxEntries（可选，目录条目上限，默认 500，最大 2000）。",
    enabled: true,
    risk: "network",
    effectKind: "read",
    verificationPolicy: "none",
    modes: [...STORAGE_MODES],
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "档案 id、名称、主机或 bucket" },
        path: { type: "string", description: "相对档案根的路径（默认根目录）" },
        maxBytes: { type: "number", description: "文本内联上限字节数（默认 262144）" },
        maxEntries: { type: "number", description: "目录条目上限（默认 500）" },
      },
      required: ["profile"],
    },
    execute: async (args) => {
      const reference = String(args.profile ?? "").trim();
      if (!reference) return errorPayload(new Error("需要 profile 参数"));
      try {
        const profileId = await resolveProfileId(call, reference);
        const data = await call("read", {
          profileId,
          path: typeof args.path === "string" ? args.path : undefined,
          maxBytes: typeof args.maxBytes === "number" ? args.maxBytes : undefined,
          maxEntries: typeof args.maxEntries === "number" ? args.maxEntries : undefined,
        }, 60_000);
        return okPayload({ profile: profileId, ...(data as Record<string, unknown>) });
      } catch (error) {
        return errorPayload(error, { profile: reference });
      }
    },
  };

  const cloudDownloadTool: ToolDefinition = {
    id: "cloud_download",
    name: "下载云存储文件",
    description:
      "把云存储上的文件下载到本地路径（大文件/二进制用这个）。\n\n" +
      "何时用：\n" +
      "- 用户说「把服务器上那个文件拉下来」「下载到桌面」\n" +
      "- cloud_read 提示文件是二进制或超过内联上限\n\n" +
      "不要用于：\n" +
      "- 只想看内容的小文本文件（cloud_read 更省事）\n" +
      "- 目录（不能下载目录）\n\n" +
      "参数：profile（必填）；path（必填，远端相对路径）；localPath（必填，本地保存路径）；\n" +
      "overwrite（可选，默认 false，本地已存在时需显式 true）；timeout_ms（可选，默认 600000，上限 3600000）。",
    enabled: true,
    risk: "fs-write",
    effectKind: "mutation",
    verificationPolicy: "none",
    modes: [...STORAGE_MODES],
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "档案 id、名称、主机或 bucket" },
        path: { type: "string", description: "远端相对路径（必填）" },
        localPath: { type: "string", description: "本地保存路径（必填）" },
        overwrite: { type: "boolean", description: "覆盖本地已存在文件（默认 false）" },
        timeout_ms: { type: "number", description: "下载上限毫秒数（默认 600000，上限 3600000）" },
      },
      required: ["profile", "path", "localPath"],
    },
    execute: async (args) => {
      const reference = String(args.profile ?? "").trim();
      const remotePath = String(args.path ?? "").trim();
      const localPath = String(args.localPath ?? "").trim();
      if (!reference || !remotePath || !localPath) {
        return errorPayload(new Error("需要 profile、path、localPath"));
      }
      const timeoutMs = clampTimeout(args.timeout_ms);
      try {
        const profileId = await resolveProfileId(call, reference);
        const data = await call("download", {
          profileId,
          path: remotePath,
          localPath,
          overwrite: args.overwrite === true,
        }, timeoutMs + 15_000);
        return okPayload({ profile: profileId, ...(data as Record<string, unknown>) });
      } catch (error) {
        return errorPayload(error, { profile: reference, path: remotePath, localPath });
      }
    },
  };

  const cloudUploadTool: ToolDefinition = {
    id: "cloud_upload",
    name: "上传到云存储",
    description:
      "把本地文件或直接文本内容上传到云存储（远端不存在父目录时自动创建）。\n\n" +
      "何时用：\n" +
      "- 用户说「把这个文件传到网盘/服务器」「帮我生成一个 xxx 放到远端」\n" +
      "- 把刚生成的报告/配置写入远端目录\n\n" +
      "不要用于：\n" +
      "- 下载（那是 cloud_download）\n" +
      "- 建目录/删除/移动（那是 cloud_manage）\n\n" +
      "参数：profile（必填）；path（必填，远端目标相对路径）；\n" +
      "localPath（本地文件路径）与 content（直接写入的文本内容）二选一；\n" +
      "overwrite（可选，默认 false，远端已存在时需显式 true）；createParents（可选，默认 true）；\n" +
      "timeout_ms（可选，默认 600000，上限 3600000）。",
    enabled: true,
    risk: "fs-write",
    effectKind: "mutation",
    verificationPolicy: "none",
    modes: [...STORAGE_MODES],
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "档案 id、名称、主机或 bucket" },
        path: { type: "string", description: "远端目标相对路径（必填）" },
        localPath: { type: "string", description: "本地文件路径（与 content 二选一）" },
        content: { type: "string", description: "直接写入的文本内容（与 localPath 二选一）" },
        overwrite: { type: "boolean", description: "覆盖远端已存在文件（默认 false）" },
        createParents: { type: "boolean", description: "自动创建远端父目录（默认 true）" },
        timeout_ms: { type: "number", description: "上传上限毫秒数（默认 600000，上限 3600000）" },
      },
      required: ["profile", "path"],
    },
    execute: async (args) => {
      const reference = String(args.profile ?? "").trim();
      const remotePath = String(args.path ?? "").trim();
      if (!reference || !remotePath) return errorPayload(new Error("需要 profile 与 path"));
      const hasContent = typeof args.content === "string";
      const hasLocal = typeof args.localPath === "string" && args.localPath.trim().length > 0;
      if (!hasContent && !hasLocal) return errorPayload(new Error("需要 localPath 或 content"));
      if (hasContent && hasLocal) return errorPayload(new Error("localPath 与 content 只能二选一"));
      const timeoutMs = clampTimeout(args.timeout_ms);
      try {
        const profileId = await resolveProfileId(call, reference);
        const data = await call("write", {
          profileId,
          path: remotePath,
          content: hasContent ? args.content : undefined,
          localPath: hasLocal ? String(args.localPath).trim() : undefined,
          overwrite: args.overwrite === true,
          createParents: args.createParents !== false,
        }, timeoutMs + 15_000);
        return okPayload({ profile: profileId, ...(data as Record<string, unknown>) });
      } catch (error) {
        return errorPayload(error, { profile: reference, path: remotePath });
      }
    },
  };

  const cloudManageTool: ToolDefinition = {
    id: "cloud_manage",
    name: "管理云存储路径",
    description:
      "管理云存储上的目录与文件：新建目录（mkdir）、删除（delete）、移动（move）、复制（copy）。\n\n" +
      "何时用：\n" +
      "- 用户说「在网盘上建个文件夹」「把 A 移到 B」「删掉远端那个文件」「复制一份」\n\n" +
      "不要用于：\n" +
      "- 上传/下载（那是 cloud_upload / cloud_download）\n" +
      "- 查看（那是 cloud_read）\n\n" +
      "参数：profile（必填）；action（必填：mkdir/delete/move/copy）。\n" +
      "mkdir：path（必填）、recursive（可选，默认 true）。\n" +
      "delete：paths（必填，相对路径数组）、recursive（可选，默认 false；删除非空目录需显式 true）。\n" +
      "move/copy：from、to（必填）、overwrite（可选，默认 false）。\n" +
      "安全说明：删除不可恢复，操作前先与用户确认目标路径。",
    enabled: true,
    risk: "fs-write",
    effectKind: "mutation",
    verificationPolicy: "none",
    modes: [...STORAGE_MODES],
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "档案 id、名称、主机或 bucket" },
        action: { type: "string", description: "mkdir / delete / move / copy", enum: ["mkdir", "delete", "move", "copy"] },
        path: { type: "string", description: "mkdir 的目标路径" },
        paths: {
          type: "array",
          description: "delete 的目标路径数组",
          items: { type: "string" },
        },
        recursive: { type: "boolean", description: "mkdir 默认 true；delete 非空目录需显式 true" },
        from: { type: "string", description: "move/copy 源路径" },
        to: { type: "string", description: "move/copy 目标路径" },
        overwrite: { type: "boolean", description: "move/copy 覆盖目标（默认 false）" },
      },
      required: ["profile", "action"],
    },
    execute: async (args) => {
      const reference = String(args.profile ?? "").trim();
      const action = String(args.action ?? "").trim();
      if (!reference || !action) return errorPayload(new Error("需要 profile 与 action"));
      try {
        const profileId = await resolveProfileId(call, reference);
        if (action === "mkdir") {
          const path = String(args.path ?? "").trim();
          if (!path) return errorPayload(new Error("mkdir 需要 path"));
          const data = await call("mkdir", {
            profileId,
            path,
            recursive: args.recursive !== false,
          }, 60_000);
          return okPayload({ profile: profileId, action, ...(data as Record<string, unknown>) });
        }
        if (action === "delete") {
          const paths = Array.isArray(args.paths)
            ? args.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
            : [];
          if (paths.length === 0) return errorPayload(new Error("delete 需要非空 paths 数组"));
          const data = await call("delete", {
            profileId,
            paths,
            recursive: args.recursive === true,
          }, 300_000);
          return okPayload({ profile: profileId, action, ...(data as Record<string, unknown>) });
        }
        if (action === "move" || action === "copy") {
          const from = String(args.from ?? "").trim();
          const to = String(args.to ?? "").trim();
          if (!from || !to) return errorPayload(new Error(`${action} 需要 from 与 to`));
          const data = await call(action, {
            profileId,
            from,
            to,
            overwrite: args.overwrite === true,
          }, 300_000);
          return okPayload({ profile: profileId, action, ...(data as Record<string, unknown>) });
        }
        return errorPayload(new Error("action 必须是 mkdir / delete / move / copy"));
      } catch (error) {
        return errorPayload(error, { profile: reference, action });
      }
    },
  };

  return [cloudProfilesTool, cloudProfileSaveTool, cloudReadTool, cloudDownloadTool, cloudUploadTool, cloudManageTool];
}

/** 默认实例：懒加载 .NET 宿主客户端（避免测试/启动期拉起子进程）。 */
export const storageTools = createStorageTools(async (op, params, timeoutMs) => {
  const { nativeStorageHost } = await import("./native-storage-host");
  return nativeStorageHost.call(op, params, timeoutMs);
});
