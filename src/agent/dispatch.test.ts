import { describe, expect, it } from "vitest";
import { shouldPreempt } from "./dispatch";

describe("shouldPreempt", () => {
  it("扩展对话框回答与中止绕过串行队列（否则自己等自己）", () => {
    expect(shouldPreempt("extensionUiResponse")).toBe(true);
    expect(shouldPreempt("abort")).toBe(true);
  });

  it("其余命令保持串行保序", () => {
    for (const cmd of ["init", "prompt", "state", "newSession", "switchSession", "shutdown"] as const) {
      expect(shouldPreempt(cmd)).toBe(false);
    }
  });
});
