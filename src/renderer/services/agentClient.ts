/**
 * 宿主 IPC 唯一出口。UI 层不允许直接碰 window.desktopAgent，一律经过这里。
 *
 * 好处：换宿主（Electron → 其他壳）或加 mock / 浏览器调试模式时只改这一个文件。
 */
import type {
  AgentEvent,
  AppConfig,
  ExtensionUiResponse,
  PromptOutcome,
  SessionSummary,
  SlashCommand,
  WindowMode,
} from "@shared/protocol";
import type { CommandIO, CommandName, EventChannel, EventPayloads, IpcResult } from "@shared/bridge";

function bridge() {
  if (!("desktopAgent" in window) || !window.desktopAgent) {
    throw new Error("宿主桥接未就绪（window.desktopAgent 不存在）：页面需要在 Electron 里打开");
  }
  return window.desktopAgent;
}

async function call<C extends CommandName>(
  cmd: C,
  args?: CommandIO[C]["args"],
): Promise<CommandIO[C]["result"]> {
  const result: IpcResult<CommandIO[C]["result"]> = await bridge().invoke(cmd, args);
  // 失败时宿主带回的是可直接展示的文案。
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function listen<C extends EventChannel>(channel: C, handler: (payload: EventPayloads[C]) => void): () => void {
  return bridge().on(channel, handler);
}

/** 订阅 agent 事件流。返回取消订阅函数。 */
export function onAgentEvent(handler: (event: AgentEvent) => void): () => void {
  return listen("agent://event", handler);
}

/** 订阅外部唤起时直接发送的文本。 */
export function onExternalAsk(handler: (text: string) => void): () => void {
  return listen("external://ask", handler);
}

/** 订阅「新建会话」广播（托盘菜单触发），用于清空前端视图。 */
export function onReset(handler: () => void): () => void {
  return listen("agent://reset", () => handler());
}

/** 订阅启动期/运行期的宿主告警（例如快捷键注册失败、Agent 重启）。 */
export function onBootError(handler: (message: string) => void): () => void {
  return listen("agent://boot-error", handler);
}

/** 订阅宿主发起的窗口形态变更（托盘/快捷键/二次启动等绕过前端的入口）。 */
export function onModeChanged(handler: (mode: WindowMode) => void): () => void {
  return listen("window://mode-changed", handler);
}

/** 订阅对话窗口的最大化状态变化（按钮、窗口管理器快捷键都会触发）。 */
export function onMaximizedChanged(handler: (maximized: boolean) => void): () => void {
  return listen("window://maximized-changed", handler);
}

export const agentClient = {
  state: () => call("agent_state"),
  send: (text: string, opts?: { streamingBehavior?: "steer" | "followUp" }): Promise<PromptOutcome> =>
    call("agent_send", { text, streamingBehavior: opts?.streamingBehavior }),
  abort: () => call("agent_abort"),
  newSession: () => call("agent_new_session"),
  switchSession: (sessionPath: string) => call("agent_switch_session", { sessionPath }),
  stats: () => call("agent_stats"),
  setModel: (provider: string, modelId: string) => call("agent_set_model", { provider, modelId }),
  setThinkingLevel: (level: string) => call("agent_set_thinking_level", { level }),
  respondExtensionUi: (response: ExtensionUiResponse) =>
    call("agent_extension_ui_response", { response }),
  sessions: () => call("agent_sessions"),
  /** 斜杠命令联想用的命令列表（扩展命令 / prompt 模板 / skill）。 */
  commands: () => call("agent_commands"),
  /** 切换模型用的可选列表（当前有可用凭据的模型）。 */
  models: () => call("agent_models"),
  /** 当前会话绑定的 Agent Panel 需求（右侧信息栏）。 */
  panelRequirements: (sessionId: string | null) => call("panel_requirements", { sessionId }),
};

export const windowClient = {
  hide: () => call("window_hide"),
  switchMode: (mode: WindowMode) => call("window_switch_mode", { mode }),
  /** 宿主侧的真实形态。启动时必须取一次：初始形态在页面加载前就已定好。 */
  mode: () => call("window_mode"),
  /** 对话窗口的最大化状态；切到对话窗口后要重新取一次（宿主会按记住的偏好恢复）。 */
  isMaximized: () => call("window_is_maximized"),
  toggleMaximize: () => call("window_toggle_maximize"),
  /** 临时调整窗口尺寸（悬浮窗展开会话列表时加高）；省略的轴保持不变。 */
  resize: (size: { width?: number; height?: number }) =>
    call("window_resize", { width: size.width ?? null, height: size.height ?? null }),
};

export const configClient = {
  get: () => call("config_get"),
  set: (config: AppConfig) => call("config_set", { config }),
  /** 弹出系统的目录选择框；用户取消时返回 null。 */
  pickDirectory: (defaultPath: string) => call("dialog_pick_directory", { defaultPath }),
};

export type { SessionSummary };

/** 斜杠命令列表的缓存有效期：扩展和 skill 可能在运行中变化，但不必每次发送都问一遍。 */
const COMMANDS_TTL_MS = 30_000;
let commandsCache: { list: SlashCommand[]; fetchedAt: number } | null = null;

/**
 * 带缓存的命令列表（联想、以及 `send()` 判断「是不是扩展命令」共用）。
 * 取不到就当没有命令——调用方按普通输入处理，不会卡住发送。
 */
export async function cachedCommands(): Promise<SlashCommand[]> {
  if (commandsCache && Date.now() - commandsCache.fetchedAt < COMMANDS_TTL_MS) {
    return commandsCache.list;
  }
  try {
    const list = await agentClient.commands();
    commandsCache = { list, fetchedAt: Date.now() };
    return list;
  } catch {
    // 失败不写缓存：下次发送再试。返回空表示「不知道」，调用方降级。
    return commandsCache?.list ?? [];
  }
}
