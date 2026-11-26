import { describe, expect, it } from "vitest";
import { askText, wantsToggle } from "./args";

// 真实的 argv：第一个元素是可执行文件路径，后面可能混有 Chromium 自己的开关。
const argv = ["/opt/Desktop Agent/desktop-agent", "--enable-features=Foo", "ask", " 帮我看下这个报错 ", "--"];

describe("askText", () => {
  it("取 ask 后面的参数并去掉首尾空白", () => {
    expect(askText(argv)).toBe("帮我看下这个报错");
  });

  it("问题为空时视为没有提问", () => {
    expect(askText(["desktop-agent", "ask", "   "])).toBeNull();
    expect(askText(["desktop-agent", "ask"])).toBeNull();
  });

  it("不是 ask 用法时返回 null", () => {
    expect(askText(["desktop-agent", "toggle"])).toBeNull();
    expect(askText([])).toBeNull();
  });
});

describe("wantsToggle", () => {
  it("只有明确写了 toggle 才算", () => {
    expect(wantsToggle(["desktop-agent", "toggle"])).toBe(true);
    expect(wantsToggle(["desktop-agent", "ask", "请 toggle 一下"])).toBe(false);
  });
});
