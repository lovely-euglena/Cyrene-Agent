/**
 * 便携模式启动引导。
 *
 * ⚠️ 必须是 src/main/index.ts 的第一条 import —— ESM 按 import 顺序求值，
 * 这里在模块加载期同步读取指针文件并 app.setPath("userData")，保证后续任何
 * 业务模块（单实例锁、日志、设置存储……）读到的都是最终目录。
 */

import { applyPortableDataDirAtStartup } from "./portable-runtime";

applyPortableDataDirAtStartup();
