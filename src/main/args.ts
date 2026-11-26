/**
 * 命令行参数解析。 desktop-agent [ask <问题> | toggle | show]
 *
 * 再启动一次程序时，参数会经单实例通道交给已经在跑的那个实例（见 index.ts 的 second-instance）。
 */

/** 取 `ask <问题>` 里的问题；不是这个用法或问题为空时返回 null。 */
export function askText(argv: readonly string[]): string | null {
  const index = argv.indexOf("ask");
  if (index === -1) return null;
  return argv[index + 1]?.trim() || null;
}

/** 是否是 `toggle`：有焦点就收起，没显示就唤起。 */
export function wantsToggle(argv: readonly string[]): boolean {
  return argv.includes("toggle");
}
