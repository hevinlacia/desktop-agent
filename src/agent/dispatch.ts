/**
 * 子进程命令调度判据（纯函数，便于单测）。
 *
 * 子进程用一条串行队列保序（init 必须最先、命令之间不乱序）。但有一类命令是
 * 「对**正在进行中**的请求作答」，排队等前一条命令结束就是自己等自己：
 *
 * - `extensionUiResponse`：回答扩展的对话框。`prompt` 里执行的扩展命令可能正
 *   卡在 `ctx.ui.select()` 上等这条应答；排到 `prompt` 后面就永远轮不到。
 * - `abort`：中止正在跑的运行。它本来就只能在运行中才有意义，排队等于失效。
 *
 * 2026-11 REQ-338 实测：`/panel-req-list` 弹出需求列表、点选后界面再无反应，
 * 绑定不执行、后续提问一律卡住——就是这两类命令被排队造成的死锁。
 */
import type { AgentRequest } from "../shared/agentIpc";

/** 必须绕过串行队列、立即处理（但仍要走 host.handle 的正常应答）。 */
const PREEMPTIVE_COMMANDS = new Set<AgentRequest["cmd"]>(["extensionUiResponse", "abort"]);

export function shouldPreempt(cmd: AgentRequest["cmd"]): boolean {
  return PREEMPTIVE_COMMANDS.has(cmd);
}
