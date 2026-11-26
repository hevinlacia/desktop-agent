import type {
  AgentEvent,
  AppConfig,
  ExtensionUiResponse,
  PromptOutcome,
  SessionState,
  SessionStats,
  SessionSummary,
  WindowMode,
} from "./protocol";

/**
 * 渲染进程与主进程之间的通道名。preload 只放行这里列出的事件与命令。
 * 命名沿用 `协议://用途` 的形式，`agent://event` 承载 `AgentEvent` 流。
 */
export const AGENT_EVENT_CHANNEL = "agent://event";
export const AGENT_RESET_CHANNEL = "agent://reset";
export const AGENT_BOOT_ERROR_CHANNEL = "agent://boot-error";
export const EXTERNAL_ASK_CHANNEL = "external://ask";
export const WINDOW_MODE_CHANNEL = "window://mode-changed";

export const EVENT_CHANNELS = [
  AGENT_EVENT_CHANNEL,
  AGENT_RESET_CHANNEL,
  AGENT_BOOT_ERROR_CHANNEL,
  EXTERNAL_ASK_CHANNEL,
  WINDOW_MODE_CHANNEL,
] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];

/** 各事件通道的 payload 类型。 */
export interface EventPayloads {
  "agent://event": AgentEvent;
  "agent://reset": null;
  "agent://boot-error": string;
  "external://ask": string;
  "window://mode-changed": WindowMode;
}

/** 渲染进程可以调用的命令。主进程必须为每一项注册处理器（类型上强制）。 */
export const COMMANDS = [
  "agent_state",
  "agent_send",
  "agent_abort",
  "agent_new_session",
  "agent_switch_session",
  "agent_stats",
  "agent_set_model",
  "agent_set_thinking_level",
  "agent_extension_ui_response",
  "agent_sessions",
  "window_hide",
  "window_switch_mode",
  "window_mode",
  "window_resize",
  "config_get",
  "config_set",
] as const;
export type CommandName = (typeof COMMANDS)[number];

/** 各命令的入参与返回类型。 */
export interface CommandIO {
  agent_state: { args: null; result: SessionState };
  agent_send: {
    args: { text: string; streamingBehavior?: "steer" | "followUp" };
    result: PromptOutcome;
  };
  agent_abort: { args: null; result: void };
  agent_new_session: { args: null; result: void };
  agent_switch_session: { args: { sessionPath: string }; result: void };
  agent_stats: { args: null; result: SessionStats };
  agent_set_model: { args: { provider: string; modelId: string }; result: void };
  agent_set_thinking_level: { args: { level: string }; result: void };
  agent_extension_ui_response: { args: { response: ExtensionUiResponse }; result: void };
  agent_sessions: { args: null; result: SessionSummary[] };
  window_hide: { args: null; result: void };
  window_switch_mode: { args: { mode: WindowMode }; result: void };
  window_mode: { args: null; result: WindowMode };
  window_resize: { args: { width: number | null; height: number | null }; result: void };
  config_get: { args: null; result: AppConfig };
  config_set: { args: { config: AppConfig }; result: AppConfig };
}

/** 命令的统一返回：成功带 data，失败带可直接展示给用户的 error。 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** preload 暴露给渲染进程的全部能力。 */
export interface DesktopAgentBridge {
  invoke<C extends CommandName>(cmd: C, args?: CommandIO[C]["args"]): Promise<IpcResult<CommandIO[C]["result"]>>;
  on<C extends EventChannel>(channel: C, handler: (payload: EventPayloads[C]) => void): () => void;
}
