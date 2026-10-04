# 手机 PWA：查看与继续话题 · 设计（IKJK2L）

> **日期**：2026-10-04
> **状态**：已实现（IKJK2L 批次；验证见 §7）
> **关联**：RFC `docs/design/2026-10-03-cloud-cyrene-rfc.md`（§1–§2：② VPC / `src/pwa` 建议位置 / Q5 / Q7）·
> 协议 `docs/specs/2026-10-04-sync-protocol-v0.md` · 服务端 `dotnet/cloud-server/README.md` ·
> 里程碑「云端昔涟：不落」Phase 1（IKJK2G–IKJK2N）

## 0. 目标与范围

**验收（IKJK2L）**：桌面离线时，手机可打开最近会话、发送文字并得到回复。

Phase 1 文本范围：

- 最小聊天页：会话列表 + 消息流 + 发送框（不含附件 / 工具条目 / 语音）；
- 配对登录（兑换 device token）；`/v1/sync` fetch / push 接入；
- 离线只读缓存（Service Worker 应用壳 + 事件快照）；
- 构建产物由 cloud-server 静态托管（**VPS 运行期零 Node**）。

非目标（后续批次）：手机端新建会话、编辑 / 重生成入口、推送通知、多 remote 管理。

## 1. 技术选型

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 框架 | **原生 TS + DOM**（零运行时依赖） | 页面极小（打包 ~17KB JS / gzip ~6.4KB）；不引入 React 等运行时，构建依赖仅 vite + tsc |
| 构建 | 独立嵌套包 `src/pwa`（自带 package.json / lock） | 与桌面端工具链解耦；Docker 构建阶段只装少量包；产物进 `dotnet/cloud-server/wwwroot/` |
| 协议复用 | 直接 import `src/main/sync/sync-protocol.ts` | 双端同一校验器（fixtures 锁定契约），PWA 不复制协议逻辑 |
| 托管 | cloud-server `UseStaticFiles`（wwwroot） | 同源 → 无 CORS；反代只需 Caddy 一层 |

## 2. 关键决策（RFC Q5 / Q7）

- **Q5（token 存放与 CORS / CSRF 面）**：token 与事件缓存同存 `localStorage`（键 `cyrene.pwa.cache.v1`）。
  - 同源托管 → 无 CORS；鉴权用 `Authorization: Bearer`（非 Cookie）→ **无 CSRF 面**；
  - 残余风险 = XSS：页面全量 `textContent` 渲染（无 innerHTML），服务端对 HTML 附 CSP
    （`script-src 'self'` 等，见 `Program.cs`）；token 可随时在服务端 revoke / rotate。
- **Q7（收到回复的机制）**：**前台轮询**（3s；`document.hidden` 暂停，可见性恢复立即拉一次）。
  - Phase 1 单用户、事件量小；SSE / 长轮询需要新端点与新故障面，按需再评估；
  - 幂等由事件 `eventId` 保证，重复拉取无副作用。

## 3. 结构与数据流

```text
src/pwa/
├─ core/                纯逻辑（vitest 直测）
│  ├─ sync-protocol     ← 复用 src/main/sync/sync-protocol.ts（协议 v0 校验器）
│  ├─ event-store       幂等合并 + 规范排序（(lamport, deviceId, seq)）
│  ├─ materializer      重放 → 活动分支消息流（与 DialogLoop.Replay 逐条对齐）+ 会话摘要
│  ├─ event-factory     user 消息事件构造（水位 / 幂等 id / 协议校验 fail-fast）
│  ├─ sync-client       /v1/pair、/v1/sync/fetch、/v1/sync/push（JSONL）
│  └─ cache             localStorage 快照（token / 游标 / 事件；配额兜底裁剪）
├─ ui/                  视图（原生 DOM：登录 / 会话列表 / 聊天；消息区增量更新、输入框持久）
└─ public/              manifest / icon / sw.js（应用壳离线缓存）
```

数据流：`fetch(since=cursor)` → `mergeEvents`（幂等 + 规范排序）→ 缓存落盘 → `replaySession` → 渲染；
发送：`createUserMessageEvent` → 乐观渲染 → `push`（失败回滚）→ 轮询拉回服务端生成回复。

## 4. 重放语义（与桌面 / 服务端一致）

| 事件 | PWA 物化视图（= `DialogLoop.Replay`） |
| --- | --- |
| `message.append`(user) | 开新轮；`turnId` 记录 rewind 锚点 |
| `message.append`(assistant) | 挂到对应 turnId 的轮（无 turnId 挂当前轮） |
| `turn_rewind` keep_user | 保留锚点 user（eventId 指向 rewind），裁掉其后全部（重生成） |
| `turn_rewind` replace_user | 锚点 user 换 `replacementUser` 文本，其后全部裁掉 |
| `tombstone` | 移除目标轮（user + 紧随 assistant 段） |
| `session.create` | 只进会话元数据（标题 / 创建时间） |

单测锁定（含未知锚点 no-op、孤立 assistant 忽略）；会话摘要按最近活动倒序。

## 5. 缓存与离线

- 事件上限 `MAX_CACHED_EVENTS=5000`（localStorage ~5MB；超出丢最旧）；配额不足时对半裁剪重试，
  最后兜底只存身份 + 游标（事件清空，内存态继续）；
- 离线：SW 应用壳 + 事件快照 → 只读浏览 + 「离线：显示本地缓存（只读）」横幅；恢复联网自动消失；
- **SW 升级策略（复审后调整）**：导航请求 **network-first**（重新部署后首个在线导航即取新 `index.html`，
  消除「旧壳引用已下架哈希资源」的白屏窗口）；静态资源缓存优先 + 后台刷新（`assets/` 内容哈希不可变）；
  离线时导航回退缓存壳；缓存名带版本（`cyrene-pwa-shell-v2`），activate 清理旧版本；
- **cursor 持久化**：拉取游标推进即落盘——即使整页事件被协议校验丢弃，也不会重复拉取同一页；
- **不支持离线发送**：push 失败回滚本地事件并提示；
- 窗口化 / 增量物化留 Phase 2（与服务端 `LoadSessionAsync` 的 TODO 对齐）。

## 6. 构建 / 部署接入

- 本地：`npm --prefix src/pwa run build` → `dotnet/cloud-server/wwwroot/`（gitignore）；
  `npm --prefix src/pwa run dev` 起 vite（代理 `/v1`、`/healthz` → 127.0.0.1:7789）；
- 静态托管（`Program.cs`）：`wwwroot` 存在即启用；`assets/`（带哈希）长缓存，
  `index.html` / `sw.js` / manifest 不缓存；HTML 附 CSP；
- CI（`dotnet-backend`）：嵌套包 `npm ci + build` → `dotnet publish`（wwwroot 随产物）→
  云冒烟（+3 项静态断言）→ `vitest run src/pwa` → Playwright（Edge 通道）e2e；
- Docker：多阶段（node 构建 PWA → dotnet publish → aspnet 运行镜像拷 `wwwroot`）；
  构建上下文 = **仓库根**（`.dockerignore` 白名单，运行镜像零 Node）。

## 7. 验证（2026-10-04，Windows 本地）

- PWA 单测：`npx vitest run src/pwa` —— **33/33**（重放 / 合并排序 / 事件构造 / 客户端 / 缓存）；
  实现期由单测抓到并修复 `saveCache` 配额兜底死循环（`Math.floor(1/2)=0` → `slice(0)` 不收缩）；
- 云冒烟：`python scripts/dotnet-cloud-sync-test.py <dll>` —— **51/51**
  （Windows；含 3 项 PWA 静态托管断言）；
- 端到端（Microsoft Edge 通道）：`node scripts/pwa-e2e-test.mjs <dll>` —— **10/10**：配对登录 →
  打开桌面会话（桌面离线）→ 手机发送 → 收到服务端生成回复 → 刷新保持登录态 → 离线只读缓存；
- 构建：`npm run build`（tsc + vite）0 错误；产物 ~17KB JS（gzip ~6.4KB）/ 3.5KB CSS（gzip ~1.2KB）。
