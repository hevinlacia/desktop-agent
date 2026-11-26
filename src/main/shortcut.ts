import { globalShortcut } from "electron";
import { normalizeAccelerator } from "../shared/accelerator";

/**
 * 注册唤起快捷键，返回实际生效的写法；都失败时返回 null。
 *
 * Linux Wayland 下 Electron 通过桌面 portal 绑定快捷键，需要应用有合法身份
 * （package.json 的 desktopName 对应已安装的 .desktop 文件）；打包后才完整生效。
 */
export function registerToggleShortcut(accelerator: string, toggle: () => void): string | null {
  globalShortcut.unregisterAll();
  const normalized = normalizeAccelerator(accelerator);
  const candidates = normalized === accelerator ? [accelerator] : [accelerator, normalized];
  for (const candidate of candidates) {
    try {
      // 非法写法会抛异常；被其他应用占用则返回 false。
      if (globalShortcut.register(candidate, toggle)) return candidate;
    } catch {
      // 换下一种写法再试
    }
  }
  return null;
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}
