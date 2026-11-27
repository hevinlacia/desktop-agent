import { describe, expect, it } from "vitest";
import { createPlainTheme } from "./plain-theme";

describe("createPlainTheme（REQ-339：theme.fg 必须是函数）", () => {
  const theme = createPlainTheme();

  it("fg/bg 是函数且原样返回文本", () => {
    expect(typeof theme.fg).toBe("function");
    expect(typeof theme.bg).toBe("function");
    expect(theme.fg("accent", "todo ✓ 2/3")).toBe("todo ✓ 2/3");
    expect(theme.bg("surface", "x")).toBe("x");
  });

  it("样式方法是恒等函数", () => {
    expect(theme.bold("a")).toBe("a");
    expect(theme.italic("a")).toBe("a");
    expect(theme.underline("a")).toBe("a");
    expect(theme.strikethrough("a")).toBe("a");
    expect(theme.inverse("a")).toBe("a");
    expect(theme.style("a", { fg: "accent" })).toBe("a");
  });

  it("返回装 getter 形状完整（getTheme/getAllThemes 不再给 undefined）", () => {
    expect(theme.getColorMode()).toBeTruthy();
    expect(typeof theme.getThinkingBorderColor()).toBe("function");
    expect(theme.getThinkingBorderColor()("t")).toBe("t");
    expect(typeof theme.getBashModeBorderColor()).toBe("function");
    // colors 取任意令牌拿空串，不抛
    expect(theme.colors["accent"]).toBe("");
  });
});
