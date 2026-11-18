/**
 * #152：文档/文件写入工具未绑定项目时的输出根。
 *
 * 旧默认是桌面（"用户好找"），实际污染桌面且与会话上下文脱节——统一改为
 * userData/workspace 专用输出目录，首用自动创建。
 *
 * 独立成模块的原因：fs-tools 与 document-tools 都要用，且 fs-tools 模块顶层
 * 注册工具，从 document-tools import fs-tools 会引入初始化顺序耦合（测试里
 * 暴露为 registry 引用错误），这里保持零依赖。
 */
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export function fallbackOutputRoot(): string {
  const root = path.join(app.getPath("userData"), "workspace");
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    // 创建失败时写入方会因目录不存在自然报错，这里不打断解析
  }
  return root;
}
