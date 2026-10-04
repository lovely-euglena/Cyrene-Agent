import { describe, expect, it } from "vitest";
import {
  base64Url,
  formatPairCode,
  normalizeDeviceName,
  normalizePairCode,
  PAIR_CODE_ALPHABET,
  randomPairCode,
  sha256Hex,
  timingSafeEqual,
} from "../src/util";

describe("配对码", () => {
  it("随机码 8 位且字符集受限", () => {
    for (let index = 0; index < 50; index++) {
      const code = randomPairCode();
      expect(code).toHaveLength(8);
      for (const char of code) expect(PAIR_CODE_ALPHABET).toContain(char);
    }
  });

  it("显示格式 XXXX-XXXX（长度 9）", () => {
    expect(formatPairCode("ABCD2345")).toBe("ABCD-2345");
    expect(formatPairCode("ABCD2345")).toHaveLength(9);
  });

  it("规范化：大小写 / 空格 / 连字符容错", () => {
    expect(normalizePairCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizePairCode(" ABCD 2345 ")).toBe("ABCD2345");
  });

  it("规范化：非法输入返回 null", () => {
    expect(normalizePairCode("ABCD-234")).toBeNull(); // 太短
    expect(normalizePairCode("ABCD-23456")).toBeNull(); // 太长
    expect(normalizePairCode("ABCD-234O")).toBeNull(); // O 不在字母表
    expect(normalizePairCode("")).toBeNull();
    expect(normalizePairCode(undefined)).toBeNull();
    expect(normalizePairCode(42)).toBeNull();
  });
});

describe("设备名", () => {
  it("空白 → 默认名", () => {
    expect(normalizeDeviceName("   ")).toBe("未命名设备");
    expect(normalizeDeviceName(undefined)).toBe("未命名设备");
  });

  it("超长截断到 64 码元", () => {
    expect(normalizeDeviceName("a".repeat(80))).toBe("a".repeat(64));
  });

  it("截断不切断代理对（63a + emoji → 63a）", () => {
    expect(normalizeDeviceName("a".repeat(63) + "😀")).toBe("a".repeat(63));
  });

  it("trim 首尾空白", () => {
    expect(normalizeDeviceName("  手机  ")).toBe("手机");
  });
});

describe("哈希与编码", () => {
  it("sha256 十六进制（已知向量）", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("timingSafeEqual 等价比较", async () => {
    expect(await timingSafeEqual("secret", "secret")).toBe(true);
    expect(await timingSafeEqual("secret", "Secret")).toBe(false);
  });

  it("base64url 无填充且 URL 安全", () => {
    const encoded = base64Url(new Uint8Array(32).fill(0xfb));
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(encoded.length).toBeGreaterThan(40);
  });
});
