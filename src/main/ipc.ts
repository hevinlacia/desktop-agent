import { ipcMain } from "electron";
import { COMMANDS } from "../shared/bridge";
import type { CommandIO, CommandName, IpcResult } from "../shared/bridge";

/** 单个命令的处理器：入参与返回值类型都由契约推导，同步或异步都可以。 */
type Handler<C extends CommandName> = (
  args: CommandIO[C]["args"],
) => CommandIO[C]["result"] extends void
  ? void | Promise<void>
  : CommandIO[C]["result"] | Promise<CommandIO[C]["result"]>;

/** 每个命令都要有处理器，漏一个就过不了类型检查。 */
export type CommandHandlers = { [C in CommandName]: Handler<C> };

/**
 * 为契约里的每个命令注册处理器（漏一个就过不了类型检查）。
 * 统一包成 IpcResult：失败时把可读的 error 文案带回渲染进程，
 * 而不是 Electron 远程调用异常那层「Error invoking remote method ...」的包装。
 */
export function registerIpc(handlers: CommandHandlers): void {
  for (const cmd of COMMANDS) {
    const handler = handlers[cmd] as (args: unknown) => Promise<unknown> | unknown;
    ipcMain.handle(cmd, async (_event, args: unknown): Promise<IpcResult<unknown>> => {
      try {
        return { ok: true, data: await handler(args) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }
}
