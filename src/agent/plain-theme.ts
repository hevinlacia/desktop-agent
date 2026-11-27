/**
 * 桌面宿主用的「素主题」：所有着色/样式都是恒等函数（原样返回文本）。
 *
 * 为什么需要：pi 的 `ctx.ui.theme` 契约里 `fg`/`bg` 是**函数**——`theme.fg(color, text)`。
 * 桌面端早先用 `new Proxy({}, { get: () => "#999999" })` 顶替，任何属性都返回字符串，
 * 于是扩展里 `ctx.ui.theme.fg("accent", …)` 会炸成 `ctx.ui.theme.fg is not a function`
 * （REQ-339 实测：恢复会话后 `todo-list` 在 `session_start` 里调它，界面弹「扩展错误」）。
 *
 * 桌面端没有终端、也不需要 ANSI 着色，所以正确做法是提供**完整形状**的桩：函数在、
 * 参数照收、返回原文。扩展的 TUI 渲染代码因此不会崩，桌面 UI 也拿到干净的文本。
 */

const identity = (text: string): string => text;

/** 两参形式（fg/bg）里第二个参数才是要显示的文本。 */
const passthrough = (_style: string, text: string): string => text;

export interface PlainTheme {
  name: string;
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  underline: (text: string) => string;
  inverse: (text: string) => string;
  strikethrough: (text: string) => string;
  style: (text: string, options?: unknown) => string;
  colors: Record<string, string>;
  getFgAnsi: () => string;
  getBgAnsi: () => string;
  getColorMode: () => string;
  getThinkingBorderColor: () => (text: string) => string;
  getBashModeBorderColor: () => (text: string) => string;
}

/** 造一个素主题。每次重新造：扩展可能往上面挂东西，别让它们互相污染。 */
export function createPlainTheme(): PlainTheme {
  return {
    name: "plain",
    fg: passthrough,
    bg: passthrough,
    bold: identity,
    italic: identity,
    underline: identity,
    inverse: identity,
    strikethrough: identity,
    style: (text: string) => text,
    // 取色令牌：桌面端无终端色，返回空串（调用方一般只做拼接）。
    colors: new Proxy(
      {},
      {
        get: () => "",
      },
    ) as Record<string, string>,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => identity,
    getBashModeBorderColor: () => identity,
  };
}
