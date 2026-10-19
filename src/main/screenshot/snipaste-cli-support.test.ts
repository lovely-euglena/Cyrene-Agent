import { describe, expect, it } from "vitest";
import { detectSnipasteCliSupport, isQuickExit } from "./snipaste-cli-support";

describe("detectSnipasteCliSupport", () => {
  const read = (version: string | null) => (path: string) => {
    void path;
    return version;
  };

  it("Beta 标记（不区分大小写、ProductVersion/FileVersion 混排）→ beta", () => {
    expect(detectSnipasteCliSupport("C:\\snip\\Snipaste.exe", read("2.8.8 Beta"))).toBe("beta");
    expect(detectSnipasteCliSupport("C:\\snip\\Snipaste.exe", read("beta 2.8.8"))).toBe("beta");
    expect(detectSnipasteCliSupport("C:\\snip\\Snipaste.exe", read("2.8.8-BETA"))).toBe("beta");
  });

  it("有版本但无 Beta 标记 → stable", () => {
    expect(detectSnipasteCliSupport("C:\\snip\\Snipaste.exe", read("2.8.8"))).toBe("stable");
    expect(detectSnipasteCliSupport("C:\\snip\\Snipaste.exe", read("1.0.0"))).toBe("stable");
  });

  it("版本缺失/空白/读取异常 → unknown（走行为探测兜底）", () => {
    expect(detectSnipasteCliSupport("C:\\snip\\Snipaste.exe", read(null))).toBe("unknown");
    expect(detectSnipasteCliSupport("C:\\snip\\Snipaste.exe", read(""))).toBe("unknown");
    expect(detectSnipasteCliSupport("C:\\snip\\Snipaste.exe", read("   "))).toBe("unknown");
    const throwing = () => {
      throw new Error("boom");
    };
    expect(detectSnipasteCliSupport("C:\\snip\\Snipaste.exe", throwing)).toBe("unknown");
  });
});

describe("isQuickExit", () => {
  it("1.5s 内退出 = 秒退（参数被拒特征）；正常选区交互不命中", () => {
    expect(isQuickExit(0)).toBe(true);
    expect(isQuickExit(1499)).toBe(true);
    expect(isQuickExit(1500)).toBe(false);
    expect(isQuickExit(60_000)).toBe(false);
  });
});
