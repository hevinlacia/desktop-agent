/**
 * Tauri IPC 唯一出口。UI 层不允许直接 `invoke`，一律经过这里。
 *
 * 好处：换 host（Tauri → 其他壳）或加 mock/浏览器调试模式时只改这一个文件。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentEvent,
  AppConfig,
  ExtensionUiResponse,
  ModelInfo,
  SessionState,
  SessionStats,
  WindowMode,
} from "@/types/protocol";

export interface SessionSummary {
  path: string;
  sessionId: string;
  name: string | null;
  modifiedMs: number;
  sizeBytes: number;
}

export const EVENT_CHANNEL = "agent://event";

/** 订阅 agent 事件流。返回取消订阅函数。 */
export function onAgentEvent(handler: (event: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>(EVENT_CHANNEL, (e) => handler(e.payload));
}

/** 订阅外部唤起（D-Bus / CLI `ask`）。 */
export function onExternalAsk(handler: (text: string) => void): Promise<UnlistenFn> {
  return listen<string>("external://ask", (e) => handler(e.payload));
}

/** 订阅"新建会话"广播，用于清空前端视图。 */
export function onReset(handler: () => void): Promise<UnlistenFn> {
  return listen("agent://reset", () => handler());
}

/** 启动期错误（例如 pi 找不到）。 */
export function onBootError(handler: (message: string) => void): Promise<UnlistenFn> {
  return listen<{ message: string }>("agent://boot-error", (e) => handler(e.payload.message));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    // Tauri 把字符串错误原样抛回，其余类型转 JSON 以防丢信息。
    throw new Error(typeof e === "string" ? e : JSON.stringify(e));
  }
}

export const agentClient = {
  state: () => call<SessionState>("agent_state"),
  send: (text: string, opts?: { streamingBehavior?: "steer" | "followUp" }) =>
    call<"started" | "queued" | "handled">("agent_send", {
      text,
      streamingBehavior: opts?.streamingBehavior ?? null,
    }),
  abort: () => call<void>("agent_abort"),
  newSession: () => call<void>("agent_new_session"),
  switchSession: (sessionPath: string) =>
    call<void>("agent_switch_session", { sessionPath }),
  stats: () => call<SessionStats>("agent_stats"),
  models: () => call<ModelInfo[]>("agent_models"),
  setModel: (provider: string, modelId: string) =>
    call<void>("agent_set_model", { provider, modelId }),
  setThinkingLevel: (level: string) =>
    call<void>("agent_set_thinking_level", { level }),
  setSessionName: (name: string) => call<void>("agent_set_session_name", { name }),
  respondExtensionUi: (response: ExtensionUiResponse) =>
    call<void>("agent_extension_ui_response", { response }),
  restart: () => call<SessionState>("agent_restart"),
  sessions: () => call<SessionSummary[]>("agent_sessions"),
};

export const windowClient = {
  show: (mode: WindowMode) => call<void>("window_show", { mode }),
  hide: () => call<void>("window_hide"),
  toggle: () => call<void>("window_toggle"),
  switchMode: (mode: WindowMode) => call<void>("window_switch_mode", { mode }),
};

export const configClient = {
  get: () => call<AppConfig>("config_get"),
  set: (config: AppConfig) => call<void>("config_set", { config }),
  path: () => call<string>("config_path"),
  kwinInstall: () => call<boolean>("kwin_install"),
  kwinUninstall: () => call<void>("kwin_uninstall"),
};
