import { describe, expect, it } from "vitest";
import { isShortcutOptIn, planShortcut } from "./shortcutPolicy";

const packaged = { packaged: true, optIn: false };

describe("planShortcut", () => {
  it("打包版正常注册，去掉首尾空白", () => {
    expect(planShortcut({ accelerator: " Super+Space ", ...packaged })).toEqual({
      register: true,
      accelerator: "Super+Space",
    });
  });

  it("开发态默认跳过（避免每次热重启弹快捷键权限窗）", () => {
    expect(planShortcut({ accelerator: "Super+Space", packaged: false, optIn: false })).toEqual({
      register: false,
      reason: "dev",
    });
  });

  it("开发态显式 opt-in 时照常注册", () => {
    expect(planShortcut({ accelerator: "Super+Space", packaged: false, optIn: true })).toEqual({
      register: true,
      accelerator: "Super+Space",
    });
  });

  it("配置里清空 = 关闭全局快捷键，打包版也不注册", () => {
    expect(planShortcut({ accelerator: "", ...packaged })).toEqual({ register: false, reason: "off" });
    expect(planShortcut({ accelerator: "   ", ...packaged })).toEqual({ register: false, reason: "off" });
  });
});

describe("isShortcutOptIn", () => {
  it("认 1 / true / portal，忽略大小写与空白", () => {
    for (const v of ["1", "true", "TRUE", " portal "]) expect(isShortcutOptIn(v)).toBe(true);
  });

  it("未设置或其它取值一律不算", () => {
    for (const v of [undefined, "", "0", "false", "yes"]) expect(isShortcutOptIn(v)).toBe(false);
  });
});
