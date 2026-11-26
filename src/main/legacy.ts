/**
 * 旧版（Tauri）用 KWin 脚本实现全局快捷键：脚本装在 ~/.local/share/kwin/scripts/desktop-agent，
 * 并在 kwinrc 的 [Plugins] 里启用。它会在合成器层抢走 Meta+Space，
 * 新版基于 portal 注册的同一个快捷键就永远收不到。
 *
 * 这里只检测并提示，不替用户改桌面配置（卸载步骤见 README「从旧版迁移」）。
 */
import fs from "node:fs";
import path from "node:path";

const ENABLED_LINE = /^[ \t]*desktop-agentEnabled[ \t]*=[ \t]*true[ \t]*$/m;

export const LEGACY_KWIN_MESSAGE =
  "检测到旧版 Desktop Agent 的 KWin 脚本仍处于启用状态，它会占用 Meta+Space，让新版的快捷键失效。卸载步骤见 README「从旧版迁移」。";

/**
 * 检测旧版 KWin 集成是否仍启用；启用时返回给用户看的提示，否则返回 null。
 * kwinrc 参数仅供测试注入；默认读 ~/.config/kwinrc。
 */
export function legacyKWinWarning(
  homeDir: string,
  kwinrc: string = path.join(homeDir, ".config", "kwinrc"),
): string | null {
  let text = "";
  try {
    text = fs.readFileSync(kwinrc, "utf8");
  } catch {
    // 没有 kwinrc（非 KDE）或读不了：视为未启用
  }
  return ENABLED_LINE.test(text) ? LEGACY_KWIN_MESSAGE : null;
}
