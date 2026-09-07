// mpv 二进制探测——供 feishu 语音 Opus 转码等非音乐场景复用。
// （原属 music/mpv-controller.ts，音乐播放器功能删除后抽出保留；
//  mpv 播放器资源 resources/bin/mpv 仍随包分发。）
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function detectMpvBinary(): string {
  const platform = os.platform();
  if (platform === "win32") {
    // Search order:
    //   1. electron-builder extraResources (packaged)  → process.resourcesPath/bin/mpv/mpv.exe
    //   2. dev-time staged binary                       → <repo>/resources/bin/mpv/mpv.exe
    //   3. system install                               → Program Files\mpv\mpv.exe
    //   4. PATH                                        → mpv
    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
    const candidates = [
      path.join(process.resourcesPath ?? "", "bin", "mpv", "mpv.exe"),
      path.join(repoRoot, "resources", "bin", "mpv", "mpv.exe"),
      path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "mpv", "mpv.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "mpv", "mpv.exe"),
      "mpv", // PATH
    ];
    for (const c of candidates) {
      try {
        if (c === "mpv" || fs.existsSync(c)) {
          console.log("[mpv] detectMpvBinary →", c);
          return c;
        }
      } catch { /* ignore */ }
    }
    console.warn("[mpv] detectMpvBinary: no candidate found, falling back to PATH 'mpv'");
    return "mpv";
  }
  // macOS: Homebrew /opt/homebrew/bin/mpv, /usr/local/bin/mpv
  // Linux: /usr/bin/mpv, /usr/local/bin/mpv
  return "mpv";
}
