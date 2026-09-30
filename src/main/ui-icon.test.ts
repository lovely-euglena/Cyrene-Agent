import { describe, expect, it } from "vitest";
import { normalizeUiIcon } from "../shared/ui-icon";

describe("ui icon settings", () => {
  it.each([
    ["cyrene-sticker", "cyrene-sticker"],
    ["cyrene-pink", "cyrene-pink"],
    ["cyrene-sun", "cyrene-sun"],
    ["classic", "cyrene-sticker"],
    ["unknown", "cyrene-sticker"],
    [undefined, "cyrene-sticker"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeUiIcon(input)).toBe(expected);
  });
});
