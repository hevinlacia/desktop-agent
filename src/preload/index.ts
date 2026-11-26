import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  COMMANDS,
  EVENT_CHANNELS,
  type CommandIO,
  type CommandName,
  type DesktopAgentBridge,
  type EventChannel,
  type IpcResult,
} from "../shared/bridge";

// 只放行契约里列出的命令与事件，渲染进程拿不到任意通道。
const commands = new Set<string>(COMMANDS);
const events = new Set<string>(EVENT_CHANNELS);

function isChannel(channel: string): channel is EventChannel {
  return events.has(channel);
}

const bridge: DesktopAgentBridge = {
  invoke<C extends CommandName>(cmd: C, args?: CommandIO[C]["args"]) {
    if (!commands.has(cmd)) return Promise.reject(new Error(`未授权的命令：${cmd}`));
    // 主进程统一回 IpcResult，这里的类型断言对应 registerIpc 的包装。
    return ipcRenderer.invoke(cmd, args ?? null) as Promise<IpcResult<CommandIO[C]["result"]>>;
  },
  on(channel, handler) {
    if (!isChannel(channel)) throw new Error(`未授权的事件：${channel}`);
    const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload as never);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("desktopAgent", bridge);
