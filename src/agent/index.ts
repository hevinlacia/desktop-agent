/**
 * Agent 子进程入口（utilityProcess）。
 * 通过 process.parentPort 与主进程收发结构化消息，协议见 src/shared/agentIpc.ts。
 */
import type { AgentRequest, AgentToMain } from "../shared/agentIpc";
import { AgentHost, errorMessage } from "./host";

type PiModule = typeof import("@earendil-works/pi-coding-agent");

// pi 是纯 ESM 包，而这份产物是 CJS：用原生动态 import 加载，绕开打包器对 import() 的改写。
const loadPi = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<PiModule>;

const send = (message: AgentToMain): void => {
  process.parentPort.postMessage(message);
};
const log = (level: "info" | "warn" | "error", message: string): void => {
  send({ kind: "log", level, message });
};

let host: Promise<AgentHost> | null = null;
// 串行处理：命令之间保持先后顺序，init 必须最先完成。
let queue: Promise<unknown> = Promise.resolve();

process.parentPort.on("message", (event: { data: unknown }) => {
  const req = event.data as AgentRequest;
  queue = queue.then(
    () => handle(req),
    () => handle(req),
  );
});

async function handle(req: AgentRequest): Promise<void> {
  try {
    if (req.cmd === "init") {
      // 消息监听必须同步挂上（否则会漏掉 init），所以 pi 延迟到这里才加载。
      host ??= loadPi("@earendil-works/pi-coding-agent").then((pi) => AgentHost.create(pi, req.options, send));
      await host;
      send({ id: req.id, ok: true, data: null });
      return;
    }
    if (req.cmd === "shutdown") {
      if (host) await (await host).shutdown();
      send({ id: req.id, ok: true, data: null });
      return;
    }
    if (!host) throw new Error("Agent 尚未初始化，无法处理 " + req.cmd);
    const data = await (await host).handle(req);
    send({ id: req.id, ok: true, data });
  } catch (err) {
    log("error", errorMessage(err));
    send({ id: req.id, ok: false, error: errorMessage(err) });
  }
}

// 扩展或依赖里的异步错误不应该直接带走整个子进程，上报给主进程即可。
process.on("unhandledRejection", (reason) => {
  log("warn", `未处理的 Promise 拒绝：${errorMessage(reason)}`);
});
process.on("uncaughtException", (err) => {
  log("error", `未捕获异常：${errorMessage(err)}`);
});
