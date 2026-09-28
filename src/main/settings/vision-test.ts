// 视觉模型连通性测试：渲染设置页（IPC）与 native 设置窗（WPF「API」section）共用。
//
// 用一张 32x32 纯红 PNG（约 100 字节 base64）做测试图——纯色位图所有视觉模型都能识别，
// 比 SVG 兼容性好（SVG 是矢量，部分模型不支持）。32x32 是折中：足够小保持 payload 轻，
// 又满足千问等厂商对图片长宽 > 10 像素的限制。
// 验连通性（HTTP 2xx + 有内容返回）而非对答案——模型可能只说"一张红色图片"也算成功。

export const VISION_TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";

export interface VisionTestConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface VisionTestResult {
  ok: boolean;
  latency: number;
  sample?: string;
  error?: string;
}

export async function testVisionConnection(cfg: VisionTestConfig): Promise<VisionTestResult> {
  const start = Date.now();
  console.log("[Cyrene] test vision: model=" + cfg.model + " url=" + cfg.baseUrl);
  try {
    const { captionImage } = await import("../orchestrator/vision-captioner");
    const result = await captionImage(
      { base64: VISION_TEST_IMAGE_BASE64, mime: "image/png" },
      "这张图是什么颜色？用一个词回答。",
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
    );
    const latency = Date.now() - start;
    if (result.startsWith("[错误")) {
      return { ok: false, latency, error: result };
    }
    return { ok: true, latency, sample: result.slice(0, 80) };
  } catch (e) {
    return { ok: false, latency: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
  }
}