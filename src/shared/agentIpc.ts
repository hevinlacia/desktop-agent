import type {
  AgentEvent,
  EarlierMessagesResult,
  ExtensionUiResponse,
  ModelInfo,
  ModelRef,
  NewSessionResult,
  PromptOutcome,
  SessionState,
  SessionStats,
  SessionSummary,
  SlashCommand,
} from "./protocol";

/**
 * 主进程 ↔ Agent 子进程（utilityProcess）的消息契约。
 * 用 utilityProcess 的结构化消息通道，不走 JSONL。
 */

export interface AgentInitOptions {
  cwd: string;
  persistSession: boolean;
  extensions: boolean;
  /** 上个会话使用的模型：启动时的新会话与之后新建的会话沿用。 */
  lastModel: ModelRef | null;
  /** 会话常驻池大小（REQ-346）：最近用过的会话各持一个运行时，池内切换瞬时。 */
  sessionPoolSize: number;
  /** 闲置挂起毫秒数：超过就释放池内会话的运行时（0 = 不挂起）。 */
  sessionIdleSuspendMs: number;
}

export type LogLevel = "info" | "warn" | "error";

/** 主进程 → 子进程。`id` 用于把回复与请求对上。 */
export type AgentRequest =
  | { id: number; cmd: "init"; options: AgentInitOptions }
  | { id: number; cmd: "state" }
  | { id: number; cmd: "prompt"; text: string; streamingBehavior?: "steer" | "followUp" }
  | { id: number; cmd: "abort" }
  | { id: number; cmd: "newSession" }
  | { id: number; cmd: "switchSession"; sessionPath: string }
  | { id: number; cmd: "sessions" }
  /** 跨所有工作目录的会话（历史会话用：历史不绑定 cwd）。 */
  | { id: number; cmd: "sessionsAll"; cwds: string[] }
  | { id: number; cmd: "commands" }
  | { id: number; cmd: "models" }
  | { id: number; cmd: "stats" }
  | { id: number; cmd: "setModel"; provider: string; modelId: string }
  | { id: number; cmd: "setThinkingLevel"; level: string }
  | { id: number; cmd: "setPoolConfig"; poolSize: number; idleSuspendMs: number }
  | { id: number; cmd: "earlierMessages"; fromEnd: number; count: number }
  | { id: number; cmd: "extensionUiResponse"; response: ExtensionUiResponse }
  | { id: number; cmd: "shutdown" };

/** 各命令成功时的返回类型。 */
export interface AgentReplies {
  init: null;
  state: SessionState;
  prompt: PromptOutcome;
  abort: null;
  newSession: NewSessionResult;
  switchSession: null;
  sessions: SessionSummary[];
  commands: SlashCommand[];
  models: ModelInfo[];
  stats: SessionStats;
  setModel: null;
  setThinkingLevel: null;
  setPoolConfig: null;
  earlierMessages: EarlierMessagesResult;
  extensionUiResponse: null;
  shutdown: null;
}

/** 子进程 → 主进程。 */
export type AgentToMain =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string }
  | { kind: "event"; event: AgentEvent }
  | { kind: "log"; level: LogLevel; message: string };

export type AgentStatus = "ready" | "restarting" | "crashed";
