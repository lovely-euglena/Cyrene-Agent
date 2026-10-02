# Shell 命令守卫：哪些必须拦、如何防绕过、拦不住什么

- 日期：2026-10-02
- 相关代码：`src/main/orchestrator/shell-execution-policy.ts`、`src/main/orchestrator/tools/builtin-tools/run-shell-tool.ts`
- 相关：WSL 接入设计（`run_shell` shell="wsl"、`isWslManagementCommand`）

## 0. 一句话结论

字符串守卫是**安全带，不是安全边界**。它只拦「不可逆 + 灾难范围 + 助手无正当理由」的操作；
真正的边界是**权限审批 + SRT 沙箱 + WSL 权限分档**。解释器/编码混淆类绕过静态分析基本拦不住，
`尽力而为`，拦不住就交给审批与沙箱，不要为了「看起来安全」而把正常开发命令全禁掉。

## 1. 防线分层（从强到弱）

| 层 | 机制 | 管得住什么 |
| --- | --- | --- |
| 1 | 权限档位 + 审批（`permission.ts` / `permission-policy.ts`） | 是否允许发起 shell 操作；per-action 档逐条问 |
| 2 | SRT 沙箱（`sandbox-exec.ts`） | cmd/bash 的**文件系统边界**（写仅限工作区）、网络默认拒绝；wrap 失败 fail-closed |
| 3 | WSL 权限分档（方案 A） | WSL 不在 SRT 边界内：只读放行，写/未知需完全信任档 |
| 4 | 结构隔离 | shell="wsl" 的 argv 由主进程构造，模型碰不到 wsl.exe 参数，管理操作结构不可达 |
| 5 | 字符串守卫（本文） | 明显灾难命令 + WSL 管理命令；**兜底性质，可被混淆绕过** |

前 4 层是边界；第 5 层是「哪怕用户选了完全信任档，也顺手拦一下显然会把自己机器搞没的命令」。

## 2. 必须拦（不可逆 + 灾难范围 + 无正当理由）

这些在**任何档位**都拒绝，因为一旦执行几乎无法恢复，而且一个编码助手没有正当理由去做：

| 类别 | 代表 | 为什么 |
| --- | --- | --- |
| 磁盘/分区/格式化 | `format`、`diskpart`、`mkfs.*`、`fdisk`、`parted`、`mkswap`、`wipefs` | 抹掉数据/分区表，不可逆 |
| 原始设备写 | `dd of=/dev/*` | 覆写磁盘/引导 |
| 电源/会话 | `shutdown`、`reboot`、`halt`、`poweroff`、`logoff`、`Restart-Computer` | 中断用户一切工作 |
| 引导/恢复/备份删除 | `bcdedit`、`bootrec`、`vssadmin delete shadows`、`wbadmin delete`、`reagentc`、`manage-bde` | 让机器无法启动/无法恢复（勒索软件标志手法） |
| 整盘/系统目录递归删除 | `del /f/s/q C:\`、`rd /s/q C:\`、`Remove-Item -Recurse -Force C:\`、`rm -rf /`、`rm -rf ~`、`rm -rf /mnt/c` | 抹掉系统/用户数据 |
| fork 炸弹 | `:(){ :|:&};:` | 拖垮机器 |
| 注册表/账户破坏 | `reg delete HKLM/HKCR`、`net user <n> <pwd>`、`net localgroup ... /add` | 破坏系统配置/劫持账户 |
| 持久化 | `schtasks /create`、`sc create/delete`、`New-Service`、`reg add ...\Run` | 助手没有理由操纵系统任务/服务，属恶意特征 |
| 防火墙关闭 | `netsh advfirewall ... state off`、`Set-NetFirewallProfile -Enabled False` | 关闭防护，配合下载执行 |
| 下载即执行/常见混淆 | `curl|wget ... | sh`、`powershell -enc`、`iex(iwr ...)`、`certutil -urlcache/-decode`、`mshta`、`rundll32 javascript:`、`regsvr32 /i:http`、`bitsadmin /transfer`、`wmic process call create` | 远程载荷落地执行的典型形态 |
| WSL 发行版管理 | `wsl --install/--unregister/--manage/--shutdown/...` | 用户明确要求：AI 只能执行命令、查看发行版 |

## 3. 不硬拦（交给审批/沙箱，不要误伤）

这些要么可逆、要么是日常开发操作，硬拦会毁掉可用性、并制造「过滤=安全」的错觉：

- `rm -rf node_modules` / `rm -rf ./dist` / `del *.log`：正常清理。
- `git reset --hard` / `git push --force`：有风险但属工作流，由审批/沙箱兜底。
- `apt install/remove`、`npm uninstall`、`pip uninstall`：由 WSL 方案 A（写需完全信任）兜底。
- `docker`、`kubectl`、`node`、`python` 等任意脚本执行：无法也无需枚举。

这里的取舍原则：**只有「连完全信任档都不应该自动跑」的操作才进硬拦名单。**

## 4. 防绕过：尽力而为的机制与诚实结论

已实现的两层：

1. **命令位置扫描**：按 `&& || ; & | \n ( ) \`` 切段，每段跳过包装器（`cmd/bash/powershell/sudo/timeout/...`）与选项/数字参数，
   取首个「真命令」的 basename 比对。可穿透：
   - 串联/管道：`echo x && format C:`、`ls | format C:`
   - launcher：`cmd /c format`、`powershell -Command "shutdown /s"`、`bash -lc "mkfs.ext4 ..."`
   - 包装器：`sudo rm -rf /`、`timeout 10 shutdown`
   - 路径/大小写/扩展名/引号：`C:\...\shutdown.exe`、`FORMAT.COM`、`"format"`
2. **灾难惯用法正则**：对归一化整串匹配特征鲜明的模式（`rm -rf /`、`vssadmin delete shadows`、`curl | sh`、`-enc` 等），
   覆盖命令名表达不了的场景。

| 绕过手法 | 静态能否拦 | 结论/兜底 |
| --- | --- | --- |
| 路径/大小写/扩展名/引号 | ✅ | basename + 去引号 + 去扩展名 |
| 串联 / 管道 / 子 shell | ✅（近似） | 分段取命令位置 |
| `cmd /c`、`powershell -Command`、`bash -c` | ✅（常见形态） | 包装器跳过选项后取真命令 |
| `sudo`/`timeout` 前缀 | ✅（多数） | 跳过包装器与数字；`sudo -u user cmd` 会漏 |
| **别名/函数**（`alias x='rm -rf /'`） | ⚠️ 部分 | 每次 run_shell 新起 shell，别名不跨调用；同串定义+使用会被整串正则命中。带混淆则漏 |
| **解释器内构造**（`node -e`、`eval`、`$'\x72\x6d'`、base64、`%VAR%` 间接） | ❌ | 静态分析不可能可靠；`node/python/...` 是核心工具，不能全禁。靠审批+沙箱 |
| 8.3 短名 / UNC / ADS / `\\?\` | ❌ | 无法可靠归一化。靠沙箱 |
| 跨调用的分步执行（先下载、再执行） | ❌ | 单条命令静态不可关联。靠审批 |
| 编码/超长/多行混淆 | ❌ | 同上 |

> 用户判断正确：解释性语言攻击静态分析基本拦不住。本层的目标不是「防住蓄意攻击者」，
> 而是「防止模型/用户一句话误伤机器」，以及抬高明显恶意操作的成本。

## 5. 维护指引

- 新增硬拦命令：只加「不可逆 + 灾难范围 + 无正当理由」的；优先用**惯用法正则**而非扩大命令名集合。
- 每次新增都要配 **negative 测试**（确保 `echo format`、`rm -rf node_modules` 之类不误伤）。
- 一旦发现某条把正常开发命令拦了，宁可移除它、交给沙箱，也不要为了覆盖边缘 case 而牺牲可用性。
- 不要因为加了字符串规则就降低审批/沙箱的强度——它们才是边界。
