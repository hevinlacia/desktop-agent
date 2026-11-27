import { describe, expect, it } from "vitest";
import { defaultConfig, resolveConfig, resolveSize } from "./config";
import { normalizeAccelerator } from "./accelerator";

const HOME = "/home/someone";

describe("resolveConfig", () => {
  it("文件缺失或不是对象时给默认值", () => {
    expect(resolveConfig(null, HOME)).toEqual(defaultConfig(HOME));
    expect(resolveConfig("oops", HOME)).toEqual(defaultConfig(HOME));
  });

  it("旧版 Tauri 配置里的 piBinary / piArgs 被丢弃，其余字段沿用", () => {
    const cfg = resolveConfig({ cwd: "/tmp", piBinary: "/x/pi", piArgs: ["--model", "a"], compactWidth: 900 }, HOME);
    expect(cfg).toMatchObject({ cwd: "/tmp", compactWidth: 900 });
    expect(cfg).not.toHaveProperty("piBinary");
    expect(cfg).not.toHaveProperty("piArgs");
  });

  it("非法值回退默认值，布尔缺失时保持默认开启", () => {
    const cfg = resolveConfig(
      { cwd: "   ", toggleShortcut: 42, compactWidth: -1, compactHeight: "132", fullHeight: Number.NaN, persistSession: "yes" },
      HOME,
    );
    expect(cfg).toEqual(defaultConfig(HOME));
  });

  it("toggleShortcut 清空 = 关闭全局快捷键，不能被回退成默认值", () => {
    expect(resolveConfig({ toggleShortcut: "" }, HOME).toggleShortcut).toBe("");
    expect(resolveConfig({ toggleShortcut: "  " }, HOME).toggleShortcut).toBe("");
    expect(resolveConfig({ toggleShortcut: " Super+Space " }, HOME).toggleShortcut).toBe("Super+Space");
    // 完全没写这个字段时才是默认值
    expect(resolveConfig({}, HOME).toggleShortcut).toBe(defaultConfig(HOME).toggleShortcut);
  });

  it("lastModel 要 provider 和 id 都齐全，否则当作没有", () => {
    expect(resolveConfig({ lastModel: { provider: "p", id: "m" } }, HOME).lastModel).toEqual({ provider: "p", id: "m" });
    expect(resolveConfig({ lastModel: { provider: "p" } }, HOME).lastModel).toBeNull();
    expect(resolveConfig({ lastModel: "p/m" }, HOME).lastModel).toBeNull();
    expect(defaultConfig(HOME).lastModel).toBeNull();
  });

  it("工作目录开头的 ~ 展开为家目录，其余路径原样保留", () => {
    expect(resolveConfig({ cwd: "~" }, HOME).cwd).toBe(HOME);
    expect(resolveConfig({ cwd: "~/Developer/tools" }, HOME).cwd).toBe(`${HOME}/Developer/tools`);
    expect(resolveConfig({ cwd: "/tmp/a~b" }, HOME).cwd).toBe("/tmp/a~b");
    expect(resolveConfig({ cwd: "~other/x" }, HOME).cwd).toBe("~other/x");
  });

  it("尺寸低于下限时回退", () => {
    const cfg = resolveConfig({ compactHeight: 10, fullHeight: 50 }, HOME);
    expect(cfg.compactHeight).toBe(defaultConfig(HOME).compactHeight);
    expect(cfg.fullHeight).toBe(defaultConfig(HOME).fullHeight);
  });
});

describe("resolveSize", () => {
  const cur = { width: 720, height: 132 };

  it("未指定的轴沿用当前值", () => {
    expect(resolveSize({ width: null, height: 420 }, cur)).toEqual({ width: 720, height: 420 });
    expect(resolveSize({ width: 720, height: 132 }, cur)).toBeNull();
    expect(resolveSize({ width: null, height: null }, cur)).toBeNull();
  });

  it("低于下限与非法值分别夹取、忽略", () => {
    expect(resolveSize({ width: 132, height: 10 }, cur)).toEqual({ width: 420, height: 56 });
    expect(resolveSize({ width: Number.NaN, height: Number.POSITIVE_INFINITY }, cur)).toBeNull();
  });
});

describe("normalizeAccelerator", () => {
  it("旧配置的 KWin 写法 Meta 映射为 Electron 的 Super", () => {
    expect(normalizeAccelerator("Meta+Space")).toBe("Super+Space");
    expect(normalizeAccelerator(" meta + Shift + A ")).toBe("Super+Shift+A");
  });

  it("已是 Electron 写法时原样返回", () => {
    expect(normalizeAccelerator("CommandOrControl+Alt+A")).toBe("CommandOrControl+Alt+A");
  });
});

describe("会话常驻池配置（REQ-346）", () => {
  it("缺省时池大小=10、闲置挂起=10 分钟", () => {
    const cfg = resolveConfig(null, "/home/u");
    expect(cfg.sessionPoolSize).toBe(10);
    expect(cfg.sessionIdleSuspendMinutes).toBe(10);
  });

  it("合法值原样保留；非法/越界回默认或夹取", () => {
    const ok = resolveConfig({ sessionPoolSize: 20, sessionIdleSuspendMinutes: 30 }, "/home/u");
    expect(ok.sessionPoolSize).toBe(20);
    expect(ok.sessionIdleSuspendMinutes).toBe(30);

    const small = resolveConfig({ sessionPoolSize: 0 }, "/home/u");
    expect(small.sessionPoolSize).toBe(10); // 低于下限 → 默认 10（num 语义：越界用 fallback）

    const zero = resolveConfig({ sessionIdleSuspendMinutes: 0 }, "/home/u");
    expect(zero.sessionIdleSuspendMinutes).toBe(0); // 0 = 不挂起，合法

    const junk = resolveConfig({ sessionPoolSize: "很多", sessionIdleSuspendMinutes: -5 }, "/home/u");
    expect(junk.sessionPoolSize).toBe(10);
    expect(junk.sessionIdleSuspendMinutes).toBe(10);
  });
});
