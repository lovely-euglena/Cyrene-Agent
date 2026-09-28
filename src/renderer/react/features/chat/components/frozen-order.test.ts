import { describe, expect, it } from "vitest";
import { applyFrozenOrder, freezeOrder } from "./frozen-order";

interface Item {
  id: string;
  on: boolean;
}

const getId = (item: Item) => item.id;
const rank = (item: Item) => (item.on ? 0 : 1);

describe("frozen-order（面板开关不跳位）", () => {
  it("冻结后开关切换不改变位置", () => {
    const before: Item[] = [
      { id: "b", on: true },
      { id: "a", on: false },
    ];
    const order = freezeOrder(before, getId, rank);
    // 开关互换：位置保持冻结时的顺序（b 仍在 a 前）
    const after: Item[] = [
      { id: "b", on: false },
      { id: "a", on: true },
    ];
    expect(applyFrozenOrder(after, order, getId).map(getId)).toEqual(["b", "a"]);
  });

  it("重新冻结（下次进入/切 tab）后按新状态重排", () => {
    const items: Item[] = [
      { id: "b", on: false },
      { id: "a", on: true },
    ];
    const fresh = freezeOrder(items, getId, rank);
    expect(applyFrozenOrder(items, fresh, getId).map(getId)).toEqual(["a", "b"]);
  });

  it("冻结表按 rank 后 id 稳定排序", () => {
    const items: Item[] = [
      { id: "z", on: false },
      { id: "c", on: true },
      { id: "a", on: true },
      { id: "b", on: false },
    ];
    const order = freezeOrder(items, getId, rank);
    expect(applyFrozenOrder(items, order, getId).map(getId)).toEqual(["a", "c", "b", "z"]);
  });

  it("不在冻结表内的新增项排到最后", () => {
    const order = freezeOrder([{ id: "a", on: true }], getId, rank);
    const items: Item[] = [
      { id: "new", on: true },
      { id: "a", on: true },
    ];
    expect(applyFrozenOrder(items, order, getId).map(getId)).toEqual(["a", "new"]);
  });
});