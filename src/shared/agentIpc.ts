import type {
  AgentEvent,
  ExtensionUiResponse,
  PromptOutcome,
  SessionState,
  SessionStats,
  SessionSummary,
} from "./protocol";

/**
 * 主进程 ↔ Agent 子进程（utilityProcess）的消息契约。
 * 用 utilityProcess 的结构化消息通道，不走 JSONL。
 */

export interface AgentInitOptions {
  cwd: string;
  persistSession: boolean;
  extensions: boolean;
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
  | { id: number; cmd: "stats" }
  | { id: number; cmd: "setModel"; provider: string; modelId: string }
  | { id: number; cmd: "setThinkingLevel"; level: string }
  | { id: number; cmd: "extensionUiResponse"; response: ExtensionUiResponse }
  | { id: number; cmd: "shutdown" };

/** 各命令成功时的返回类型。 */
export interface AgentReplies {
  init: null;
  state: SessionState;
  prompt: PromptOutcome;
  abort: null;
  newSession: null;
  switchSession: null;
  sessions: SessionSummary[];
  stats: SessionStats;
  setModel: null;
  setThinkingLevel: null;
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
