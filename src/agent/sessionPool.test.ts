import { describe, expect, it } from "vitest";
import { pageSlice, pickEvict, pickIdle, type PoolEntryState } from "./sessionPool";

function entry(lastUsedAt: number, busy = false): PoolEntryState {
  return { lastUsedAt, busy };
}

describe("pickEvict", () => {
  const entries = new Map<string, PoolEntryState>([
    ["a", entry(100)],
    ["b", entry(200)],
    ["c", entry(300)],
  ]);

  it("选最近使用最久的非当前会话", () => {
    expect(pickEvict(entries, "c")).toBe("a");
  });

  it("当前会话永不驱逐", () => {
    expect(pickEvict(entries, "a")).toBe("b");
  });

  it("忙碌会话跳过，全忙/全是当前时返回 null（允许超员）", () => {
    const busy = new Map<string, PoolEntryState>([
      ["a", entry(100, true)],
      ["b", entry(200)],
    ]);
    expect(pickEvict(busy, "b")).toBeNull();
    expect(pickEvict(entries, null)).toBe("a");
  });
});

describe("pickIdle", () => {
  it("只选非当前、不忙且超过 idleMs 的，按最久未用升序", () => {
    const entries = new Map<string, PoolEntryState>([
      ["a", entry(1000)],
      ["b", entry(2000)],
      ["c", entry(3000)],
      ["d", entry(1500, true)],
    ]);
    expect(pickIdle(entries, "c", 10_000, 5_000)).toEqual(["a", "b"]);
  });

  it("idleMs <= 0 表示不挂起，返回空", () => {
    const entries = new Map<string, PoolEntryState>([["a", entry(0)]]);
    expect(pickIdle(entries, null, 1_000_000, 0)).toEqual([]);
    expect(pickIdle(entries, null, 1_000_000, -1)).toEqual([]);
  });
});

describe("pageSlice", () => {
  const msgs = [1, 2, 3, 4, 5, 6, 7];

  it("skip 0 是最近一页（含最新），hasMore 标记更早还有", () => {
    expect(pageSlice(msgs, 0, 3)).toEqual({ items: [5, 6, 7], hasMore: true });
  });

  it("按已加载条数往前翻页，最后不足一页给剩余全部", () => {
    expect(pageSlice(msgs, 3, 3)).toEqual({ items: [2, 3, 4], hasMore: true });
    expect(pageSlice(msgs, 6, 3)).toEqual({ items: [1], hasMore: false });
    expect(pageSlice(msgs, 7, 3)).toEqual({ items: [], hasMore: false });
  });

  it("单页装得下全部时 hasMore=false", () => {
    expect(pageSlice(msgs, 0, 10)).toEqual({ items: msgs, hasMore: false });
  });

  it("count 越界值夹到 >=1，skip 负值当 0", () => {
    expect(pageSlice([1, 2], 0, 0)).toEqual({ items: [2], hasMore: true });
    expect(pageSlice([1, 2], -2, 5)).toEqual({ items: [1, 2], hasMore: false });
  });
});
