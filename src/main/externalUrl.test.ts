import { describe, expect, it } from "vitest";
import { isWebUrl } from "./externalUrl";

describe("isWebUrl", () => {
  it("http 与 https 放行", () => {
    expect(isWebUrl("https://github.com/hevinlacia/desktop-agent?a=1#readme")).toBe(true);
    expect(isWebUrl("http://localhost:3000/")).toBe(true);
  });

  it("其它协议一律拒绝", () => {
    expect(isWebUrl("file:///home/user/.ssh/id_rsa")).toBe(false);
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("mailto:a@b.c")).toBe(false);
  });

  it("解析不了的字符串拒绝", () => {
    expect(isWebUrl("")).toBe(false);
    expect(isWebUrl("not a url")).toBe(false);
    expect(isWebUrl("github.com")).toBe(false);
  });
});
