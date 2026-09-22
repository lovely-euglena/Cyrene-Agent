# Cyrene-Agent 编译与打包指南（Linux 交叉构建 Windows 版）

> 适用：v2.0.0 线（feat/lazy-chat-window 分支）。本仓库在 **Linux 构建机**上
> 交叉打包 Windows x64 便携版——Windows 本机构建也可参考，但无需「平台变体
> 补装」等交叉构建专属步骤。

## 目录

1. [环境要求](#1-环境要求)
2. [首次配置](#2-首次配置)
3. [日常构建流程](#3-日常构建流程)
4. [发布分卷上传](#4-发布分卷上传)
5. [常见坑（血泪版）](#5-常见坑血泪版)
6. [构建产物结构](#6-构建产物结构)

---

## 1. 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | 24 LTS | npm 10+ |
| .NET SDK | 10.0 | 原生窗口 + .NET 插件轨 |
| Rust（可选） | stable | 仅截图功能（cyrene-screenshot.exe，Linux 构建机无法产出，见 §5） |
| 磁盘 | ≥ 15GB | node_modules ~5GB + release 产物 ~5GB + xz 中间文件 |

Electron 的 Windows 二进制需预下载到独立目录（npm 安装的 electron 是
Linux 版，打包时要用 win 版）：

```bash
# 一次性：下载 Electron win-x64 zip 解压到 win-dist/
# 版本号与 package.json 的 electron 字段一致
mkdir -p ~/win-dist && cd ~/win-dist
unzip electron-v<版本>-win32-x64.zip
```

## 2. 首次配置

```bash
git clone https://gitee.com/ygwill/cyrene-agent.git
cd cyrene-agent
npm install --registry=https://registry.npmmirror.com
```

**关键一步——平台变体 native 补装**（交叉构建的核心坑）：

> npm 只安装当前 OS 的 optionalDependencies 变体。Windows 运行时需要
> `win32-x64-msvc` 变体，缺失会导致**主进程启动即崩溃**，报错形如
> `Cannot find module '@node-rs/jieba-win32-x64-msvc'`（Node 22+ 的
> 错误信息会带 `npm i <pkg>` 提示）。

```bash
# 必须带 --force：win32 包声明了 os 字段，Linux 上 npm 默认拒绝安装（EBADPLATFORM）
npm install --no-save --no-package-lock --force --registry=https://registry.npmmirror.com \
  @lancedb/lancedb-win32-x64-msvc@0.30.0 \
  @node-rs/jieba-win32-x64-msvc@2.0.3 \
  @ast-grep/napi-win32-x64-msvc@0.45.3
```

版本号以主包 `optionalDependencies` 声明为准（升级依赖后要重新核对）。
**防复发脚本**会替你检查：

```bash
node scripts/ensure-win-natives.mjs
# 缺失时 exit 1 并打印补装命令；齐全时输出 "win32 变体齐全 ✓"
```

> ⚠️ `--no-save` 装的包**不进 package.json**——任何后续 `npm install` 都会把它们
> prune 掉。每次 npm 操作后重新跑一遍 ensure-win-natives.mjs 确认。

## 3. 日常构建流程

三段编译（JS 双端 + .NET）→ 打包 → 压缩，全链约 **2.5~3 小时**：

```bash
# ① 主进程 + preload（tsc）
npm run build:main
npm run build:preload

# ② 渲染层（vite，~1 分钟）
npx vite build

# ③ .NET 原生窗口（五窗：splash/侧栏/日程/设置/插件管理）
cd dotnet/native-windows
dotnet publish -c Release -r win-x64 --self-contained false
cd ../..

# ④ electron-builder（win 便携版，模块收集+asar 约 40~60 分钟）
npx electron-builder --win dir --x64 -c.electronDist=<你的win-dist路径>
```

产物：`release/win-unpacked/Cyrene.exe`（~1.2-1.4GB 目录）。

打包前务必自检：

```bash
node scripts/ensure-win-natives.mjs && npx tsc -p tsconfig.main.json --noEmit
```

## 4. 发布分卷上传

Gitee 单附件限制 100MB，xz 压缩后分卷：

```bash
cd release
# 压缩（~90 分钟，1.4G → ~380MB）
tar -cf - -C win-unpacked . | xz -6 -T1 - > Cyrene-Portable-2.0.0-test.N-x64.tar.xz
# 分卷（95MB × 4）
split -b 95m -d Cyrene-Portable-2.0.0-test.N-x64.tar.xz Cyrene-Portable-2.0.0-test.N-x64.tar.xz.part.

# 建 release（Gitee API）
curl -X POST "https://gitee.com/api/v5/repos/ygwill/cyrene-agent/releases?access_token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag_name":"v2.0.0-test.N","name":"...","body":"placeholder","prerelease":true,"target_commitish":"feat/lazy-chat-window"}'

# 逐卷上传（注意 95MB 一卷上传耗时 ~3 分钟，curl 客户端易 504——
# 服务端通常已收到，失败先查附件列表再重试，避免重复传）
curl -X POST "https://gitee.com/api/v5/repos/ygwill/cyrene-agent/releases/<id>/attach_files?access_token=$TOKEN" \
  -F "file=@Cyrene-Portable-2.0.0-test.N-x64.tar.xz.part.00"

# 更新说明（PATCH 必须带 tag_name，否则 400）
curl -X PATCH "https://gitee.com/api/v5/repos/ygwill/cyrene-agent/releases/<id>?access_token=$TOKEN" \
  --data-urlencode "tag_name=v2.0.0-test.N" \
  --data-urlencode "name=..." \
  --data-urlencode "body@release-notes.md"
```

**用户侧解压**（写入 release 说明）：

```bat
:: 4 个 part 同目录
copy /b *.part.* full.tar.xz
tar -xJf full.tar.xz
Cyrene.exe
```

## 5. 常见坑（血泪版）

| 坑 | 症状 | 解法 |
|---|---|---|
| **win 变体缺失** | Windows 启动即崩，报错带 `npm i @node-rs/jieba-win32-x64-msvc` | §2 的 `--force` 补装；打包链首挂 `ensure-win-natives.mjs` |
| npm install 后变体又没了 | 同上 | `--no-save` 包不进 lockfile，重跑 ensure 脚本 |
| native `.node` 进了 asar | 启动崩溃（动态 require 读不了 asar 虚拟路径） | electron-builder.yml 的 `asarUnpack` 白名单（已含 lancedb/onnx/jieba/ast-grep，**新增 native 依赖必须同步登记**） |
| `.NET csproj` 注释 | MSB4025 XML 解析失败 | 注释里不能出现连续 `--`（如 `--self-contained`，改 `/p:SelfContained=false`） |
| 上传 504 | curl 报 Gateway Timeout | **先查附件列表**——大概率已传成功，盲目重试会产生重复附件 |
| PATCH release 400 | `tag_name is missing` | Gitee API 的 PATCH 必须带 tag_name 字段 |
| rxjs 双拷贝 | tsc 报 `Observable` 类型不相交 | `@ag-ui/client` 嵌套 rxjs 与顶层版本冲突，删 `node_modules/@ag-ui/client/node_modules/rxjs` |
| 打包时 `duplicate dependency references` 警告 | 日志刷屏 | 无害，忽略 |

**已知产物缺失**（Linux 构建机限制，非 bug）：
- `cyrene-screenshot.exe`（截图，需 Windows + Rust）
- `mpv`（语音转码）、`mingit`（git 工具）
- SRT 沙箱增强（srt-win 二进制）

缺失时对应功能自动降级或禁用，不阻塞其余功能。

## 5.5 分发产物（一键脚本形态，v2.0.0-test.4+）

xz 流式压缩对"下载/合并损坏"零容忍（一处坏=整包废），人工 `copy /b`
易错序漏卷。标准分发形态改为**一键脚本链**：

```bash
xz -t Cyrene-Portable-2.0.0-test.N-x64.tar.xz          # ① 压缩后必验
split -b 95m -d <tar.xz> <tar.xz>.part.                 # ② 95MB 分卷
sha256sum <tar.xz>.part.* <tar.xz> > SHA256SUMS.txt     # ③ 逐卷+总包校验表
```

用户侧：全部下载到同一目录 → 双击 `一键解压运行.bat`（certutil 逐卷
校验→点名坏卷→合并→总校验→tar 解压→启动）。脚本源码在
`scripts/portable-unzip.bat`（GBK 编码保 cmd 中文兼容），发版时随分卷
一起上传并按版本号改 BASE 变量。

**发版前必做回验**：下载任一分卷回来对 SHA256（Gitee 传输层可能损坏，
test.3 的翻车现场）。

**S3 第二分发渠道**：Gitee 仓库附件配额 1GB，满时新版本发不上去。
上传脚本 请先 export CYRENE_S3_AK / CYRENE_S3_SK（凭证走 CYRENE_S3_AK/SK 环境变量）：

请先 export CYRENE_S3_AK / CYRENE_S3_SK
请先 export CYRENE_S3_AK / CYRENE_S3_SK
直链形态：（公共读）。

## 6. 构建产物结构

```text
release/win-unpacked/
├── Cyrene.exe                      # Electron 主程序
├── resources/
│   ├── app.asar                    # 主进程+渲染层（~760MB）
│   ├── app.asar.unpacked/
│   │   └── node_modules/           # native/白名单包（playwright/onnx/lancedb...）
│   ├── native-windows/
│   │   ├── cyrene-native.exe       # .NET 五窗 + 分离托盘
│   │   └── *.dll
│   ├── components/                 # Live2D 模型等
│   └── cyrene-skills/              # 技能包
└── （其余 Electron 运行时）
```

运行时桌面环境要求：**.NET 10 Desktop Runtime**（原生窗口默认启用；
缺失自动回退 Electron 渲染，不影响可用性）。

## 发版渠道（test.6 起）

- **Gitee Releases**：95MB 分卷（.part.00~03）+ `一键解压运行.bat`（合并/校验/解压/启动全自动）+ `SHA256SUMS-test.6.txt`
- **S3 直链**（第二渠道，无配额压力）：全量 tar.xz **不分卷** + **zip 版**（`Cyrene-Portable-2.0.0-test.6-x64.zip`，解压器直接展开，无需脚本）
  - 上传：`python3 scripts/upload-release-s3.py <file>`（需 `CYRENE_S3_AK/SK` 环境变量）
  - zip 版自 test.6 起提供（跨平台用户免装 tar）
- 回验：上传后下载抽样校验 SHA256（防传输损坏，test.4 的教训）
