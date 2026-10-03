import { describe, expect, it } from "vitest";
import { buildStickerTextIndex, matchStickerText } from "./sticker-text-matcher";

describe("sticker-text-matcher", () => {
  it("builds entries from description and phrases (deduped, trimmed)", () => {
    const index = buildStickerTextIndex(
      { a: { phrases: [" 你好 ", "你好", ""] }, b: { description: "抱抱" } },
      { c: { phrases: ["嘻嘻"] } },
    );
    expect(index).toEqual([
      { id: "a", text: "你好" },
      { id: "b", text: "抱抱" },
      { id: "c", text: "嘻嘻" },
    ]);
  });

  it("matches a sticker whose text overlaps the query", () => {
    const index = [
      { id: "hug", text: "抱抱\n求安慰" },
      { id: "playful", text: "调皮\n你看人家嘛" },
    ];
    expect(matchStickerText("来抱抱，好累", index, 0.55)?.id).toBe("hug");
  });

  it("returns null when query or index is empty", () => {
    expect(matchStickerText("", [{ id: "a", text: "抱抱" }])).toBeNull();
    expect(matchStickerText("抱抱", [])).toBeNull();
  });

  it("returns null when nothing shares a token with the query", () => {
    const index = [{ id: "hug", text: "抱抱" }];
    expect(matchStickerText("今天天气不错去散步", index, 0.55)).toBeNull();
  });
});
