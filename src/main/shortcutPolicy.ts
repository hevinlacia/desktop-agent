/**
 * 全局快捷键的注册策略（纯函数，不碰 Electron，方便单测）。
 *
 * 背景（REQ-342）：Linux Wayland 下 `globalShortcut` 走桌面 portal，Chromium 每次注册都用
 * **新的随机 shortcut id**，KDE 按 (应用, id) 记授权 —— 每次进程启动都算一次新请求，于是每次都弹
 * 「全局快捷键权限请求」。开发态更糟：主进程一改就重启，改几行代码弹几次；而开发态本来也绑不上
 * （没有已安装的 .desktop 身份，`register()` 返回 true 也不代表能用）。所以开发态默认不注册。
 */

/** 注册失败的两种正常原因（不是错误，不需要在界面上报错）。 */
export type SkipReason = "off" | "dev";

export type ShortcutPlan =
  | { register: true; accelerator: string }
  | { register: false; reason: SkipReason };

/**
 * 决定这次要不要注册快捷键。
 *
 * - `accelerator` 为空（用户在设置里清空）= 关闭全局快捷键，交给系统自定义快捷键调命令行；
 * - 打包版正常注册；
 * - 开发态默认跳过，`DESKTOP_AGENT_SHORTCUT=1` 时强制注册（要调试 portal 链路时才用）。
 */
export function planShortcut(input: {
  accelerator: string;
  packaged: boolean;
  optIn: boolean;
}): ShortcutPlan {
  const accelerator = input.accelerator.trim();
  if (!accelerator) return { register: false, reason: "off" };
  if (!input.packaged && !input.optIn) return { register: false, reason: "dev" };
  return { register: true, accelerator };
}

/** 开发态强制注册的开关取值（`1` / `true` / `portal` 都认）。 */
export function isShortcutOptIn(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "portal";
}
