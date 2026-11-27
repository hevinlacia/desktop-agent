import { globalShortcut } from "electron";
import { normalizeAccelerator } from "../shared/accelerator";

/**
 * 注册唤起快捷键，返回实际生效的写法；都失败时返回 null。
 *
 * Linux Wayland 下 Electron 通过桌面 portal 绑定快捷键，需要应用有合法身份
 * （package.json 的 desktopName 对应已安装的 .desktop 文件）；打包后才完整生效。
 *
 * 注意：这里**不再先 `unregisterAll()`**。portal 每次注册都会生成新的随机 shortcut id，
 * KDE 按 id 记授权，先清空再注册等于每次都申请一遍权限（REQ-342）。换绑时由调用方
 * 用 `unregisterShortcut` 精确释放旧的那一个。
 */
export function registerToggleShortcut(accelerator: string, toggle: () => void): string | null {
  for (const candidate of candidates(accelerator)) {
    try {
      // 非法写法会抛异常；被其他应用占用则返回 false。
      if (globalShortcut.register(candidate, toggle)) return candidate;
    } catch {
      // 换下一种写法再试
    }
  }
  return null;
}

/** 释放单个快捷键（旧写法与新写法都试，避免残留）。 */
export function unregisterShortcut(accelerator: string): void {
  for (const candidate of candidates(accelerator)) {
    try {
      globalShortcut.unregister(candidate);
    } catch {
      // 非法写法本来就没注册成功，忽略
    }
  }
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}

/** 原写法与规整后的写法（旧配置的 `Meta+X` → `Super+X`）各试一次。 */
function candidates(accelerator: string): string[] {
  const normalized = normalizeAccelerator(accelerator);
  return normalized === accelerator ? [accelerator] : [accelerator, normalized];
}
