// 文档导入（.NET sidecar 路径，Phase C）：
//   读取 / 扩展名与二进制路由 / 分块 / embedding / 向量库落盘 / 文档缓存
//   全部在 sidecar 进程完成；本模块只做队列契约适配：
//   - 进度通知帧（op=progress）→ job.reportProgress
//   - 取消桥接：job.onCancel → doc-import-cancel 通知帧
//   - 结果映射为 DocumentIndexJobResult（与 worker 路径同构）
//
// 装配：default-dependencies.configureDocumentIndex 依据 isSidecarEnabled() 选择
// 本 runner 或原 worker_thread runner（失败回退语义由调用侧决定）。

import * as path from "path";
import { app } from "electron";
import { getEmbeddingSidecarClient } from "./embedding-sidecar";
import { DEFAULT_MODEL_KEY } from "./embedding-pipeline";
import type {
  DocumentIndexJobResult,
  DocumentIndexJobStatus,
  QueuedDocumentIndexJob,
} from "./document-index-queue";

function getRagDataDir(): string {
  return path.join(app.getPath("userData"), "rag-data");
}

export async function runDocumentImportJobViaSidecar(
  job: QueuedDocumentIndexJob,
): Promise<DocumentIndexJobResult> {
  const client = getEmbeddingSidecarClient();
  const name = path.basename(job.input.filePath);
  if (!client) {
    return { kind: "error", name, reason: "embedding sidecar unavailable" };
  }

  let requestId = -1;
  const unsubscribe = job.onCancel(() => {
    if (requestId >= 0) client.cancelDocImport(requestId);
  });

  try {
    const header = await client.docImport(
      DEFAULT_MODEL_KEY,
      { filePath: job.input.filePath, ragDataDir: getRagDataDir() },
      {
        onProgress: (progress) => {
          job.reportProgress({
            status: progress.status as DocumentIndexJobStatus,
            completedChunks: progress.completedChunks,
            totalChunks: progress.totalChunks,
          });
        },
        onStarted: (id) => {
          requestId = id;
        },
      },
    );

    const kind = String(header.kind ?? "");
    const resultName = typeof header.name === "string" ? header.name : name;

    if (kind === "indexed") {
      const importId = typeof header.importId === "string" ? header.importId : "";
      const chunks = typeof header.chunks === "number" ? header.chunks : 0;
      if (!importId) {
        job.reportProgress({ status: "failed", reason: "importId missing in sidecar response" });
        return { kind: "error", name: resultName, reason: "importId missing in sidecar response" };
      }
      return { kind: "indexed", name: resultName, chunks, importId, cached: header.cached === true };
    }
    if (kind === "text") {
      return { kind: "text", name: resultName, text: String(header.text ?? "") };
    }
    if (kind === "empty") {
      return { kind: "empty", name: resultName };
    }
    if (kind === "cancelled") {
      return { kind: "error", name: resultName, reason: "cancelled" };
    }
    if (kind === "unsupported") {
      const reason = String(header.reason ?? "unsupported");
      job.reportProgress({ status: "failed", reason });
      return { kind: "unsupported", name: resultName, reason };
    }
    const reason = String(header.reason ?? header.error ?? "doc-import failed");
    job.reportProgress({ status: "failed", reason });
    return { kind: "error", name: resultName, reason };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    job.reportProgress({ status: "failed", reason });
    return { kind: "error", name, reason };
  } finally {
    unsubscribe();
  }
}
