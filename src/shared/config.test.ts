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
      { cwd: "   ", toggleShortcut: "", compactWidth: -1, compactHeight: "132", fullHeight: Number.NaN, persistSession: "yes" },
      HOME,
    );
    expect(cfg).toEqual(defaultConfig(HOME));
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
