# 云存储使用说明（FTP / FTPS / SFTP / WebDAV / S3）

> 2026-10-02 · 设计文档：`docs/design/2026-10-02-cloud-storage-tool-design.md`

让昔涟直接操作远端文件：列目录、读小文件、上传、下载、建目录、移动/复制、删除。
连接与凭据由 `cyrene-native --storage-host` 托管（DPAPI 加密落盘，仅当前用户可解）。

## 配置（设置 → 云存储）

1. 打开设置页「云存储」，点「＋ 添加存储」。
2. 选协议，填参数，点「保存并测试连接」。
3. 保存后的档案会出现在列表里，可随时「测试 / 编辑 / 删除」。

各协议必填项：

| 协议 | 必填 | 说明 |
| --- | --- | --- |
| SFTP | 主机、用户名、密码或私钥 | 默认端口 22；已有 SSH 档案时可用工具 `cloud_profile_save` 的 `fromSshProfile` 一次性导入 |
| FTP | 主机 | 默认 21、匿名或用户名密码；家用/公网服务器保持被动模式 |
| FTPS | 主机 | 默认 explicit（AUTH TLS，21）；隐式模式端口通常 990；自签证书需勾选「允许自签证书」 |
| WebDAV | 服务器地址 | 如 `https://webdav.example.com/dav`；账号 + 应用密码；支持 Basic/Digest/无需认证 |
| S3 | Bucket | AWS 官方留空 Endpoint；MinIO/R2 等自填 Endpoint 并开启 Path style；Region 按服务商要求 |

「根目录 / Key 前缀」限制 AI 的操作范围（留空 = 服务器根 / 整个 bucket），
所有工具路径都相对它解析，`..` 越界会被直接拒绝。

## 让昔涟操作（工具）

| 工具 | 用途 |
| --- | --- |
| `cloud_profiles` | 列出档案与连接状态 |
| `cloud_profile_save` | 新增/修改/删除档案（也可让 AI 帮你配） |
| `cloud_read` | 列目录；小文本文件直接返回内容；大文件/二进制回元数据 |
| `cloud_download` | 下载到本地（默认不覆盖已存在文件） |
| `cloud_upload` | 上传本地文件，或直接把文本内容写成远端文件 |
| `cloud_manage` | mkdir / delete / move / copy（删除需显式路径，非空目录需显式 recursive） |

对话示例：

- 「看看我 NAS 上 `/备份` 里有什么」
- 「把这份报告传到网盘 `/documents` 下」
- 「把服务器上的 `/logs/app.log` 下载到桌面」

权限：只读档位只能列目录/读文本；上传/下载/删除等写操作需要「指定目录 / 每次审批 /
完全访问」档位（沿用现有本地文件权限档位，无新增设置）。

## 各协议注意事项

- **FTP/FTPS**：服务器差异较大（UTF-8 文件名、被动端口）；连不上时先试关闭被动模式。
- **WebDAV**：部分服务（如 123 云盘）不支持 MOVE/COPY，会自动退化为流式复制；
  删除可能最终一致（列表几秒后才消失）。
- **SFTP**：S3 网关型 SFTP（如 Rains3）可能不支持重命名，移动会自动退化为复制 + 删除。
- **S3**：目录是前缀语义（无真实空目录）；单对象上限 5GB（PutObject）。

## 冒烟脚本（开发/验证用）

```bash
# 全流程 24 项断言（mkdir/write/read/download/copy/move/delete + 边界场景）
node scripts/diagnostics/cloud-storage-smoke.mjs --profile '{"protocol":"sftp","host":"...","port":22,"username":"...","password":"..."}'

# 只看根目录（确认 rootPath 该填什么）
node scripts/diagnostics/cloud-storage-smoke.mjs --inspect --profile '<json>'

# 指定实际发布产物（默认自动找 dotnet build / release/win-unpacked）
node scripts/diagnostics/cloud-storage-smoke.mjs --exe release/win-unpacked/resources/native-windows/cyrene-native.exe --profile '<json>'
```

所有测试操作都在远端 `cyrene-smoke-<时间戳>/` 目录内，结束自动删除（`--keep` 保留现场）。
