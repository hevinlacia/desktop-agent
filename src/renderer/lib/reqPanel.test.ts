import { describe, expect, it } from "vitest";
import { pollDue, requirementPageUrl, REQ_PANEL_POLL_MS } from "./reqPanel";

describe("pollDue", () => {
  const gate = { visible: true, collapsed: false };

  it("从未成功刷新过：可见未折叠就立即刷", () => {
    expect(pollDue(1000, null, gate)).toBe(true);
  });

  it("距上次成功刷新满一个周期才刷，差一点不刷", () => {
    const t0 = 100_000;
    expect(pollDue(t0 + REQ_PANEL_POLL_MS - 1, t0, gate)).toBe(false);
    expect(pollDue(t0 + REQ_PANEL_POLL_MS, t0, gate)).toBe(true);
  });

  it("页面隐藏 / 折叠成窄轨时不刷（即使早已到期）", () => {
    const t0 = 100_000;
    const late = t0 + REQ_PANEL_POLL_MS * 10;
    expect(pollDue(late, t0, { ...gate, visible: false })).toBe(false);
    expect(pollDue(late, t0, { ...gate, collapsed: true })).toBe(false);
    expect(pollDue(late, null, { ...gate, visible: false })).toBe(false);
  });

  it("intervalMs 可覆盖默认周期", () => {
    expect(pollDue(100_000 + 5_000, 100_000, { ...gate, intervalMs: 5_000 })).toBe(true);
    expect(pollDue(100_000 + 4_999, 100_000, { ...gate, intervalMs: 5_000 })).toBe(false);
  });
});

describe("requirementPageUrl", () => {
  it("拼接 /requirement?id= 并对 id 做 URL 编码", () => {
    expect(requirementPageUrl("http://hub:8788", "REQ-345")).toBe("http://hub:8788/requirement?id=REQ-345");
    expect(requirementPageUrl("http://hub:8788/", "REQ WMS-1")).toBe(
      "http://hub:8788/requirement?id=REQ%20WMS-1",
    );
  });

  it("hubUrl 为空 / 非法 / 非 http(s) 协议返回 null", () => {
    expect(requirementPageUrl("", "REQ-1")).toBeNull();
    expect(requirementPageUrl("not a url", "REQ-1")).toBeNull();
    expect(requirementPageUrl("file:///etc", "REQ-1")).toBeNull();
    expect(requirementPageUrl("javascript:alert(1)", "x")).toBeNull();
  });

  it("id 为空返回 null", () => {
    expect(requirementPageUrl("http://hub:8788", "")).toBeNull();
  });
});
