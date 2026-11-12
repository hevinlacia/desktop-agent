/**
 * 前后端唯一契约。Rust 侧的 `UnifiedAgentEvent` 与此文件逐字段对应，
 * 改这里必须同步改 `src-tauri/src/agent/mod.rs`。
 */

/** 后端适配器种类。将来接自研引擎时往这里加，前端其余代码不动。 */
export type AdapterKind = "pi";

/** 一次运行的生命周期状态。 */
export type RunState = "idle" | "running" | "settled";

/** Agent 事件。所有事件都带 `sessionId`，前端据此过滤（多会话时必要）。 */
export type AgentEvent =
  | { type: "runStarted"; sessionId: string }
  | { type: "runSettled"; sessionId: string; aborted: boolean }
  | { type: "turnStarted"; sessionId: string }
  | { type: "textDelta"; sessionId: string; contentIndex: number; delta: string }
  | { type: "thinkingDelta"; sessionId: string; contentIndex: number; delta: string }
  /** 权威块内容，用于校正流式拼接结果（覆盖而非追加）。 */
  | { type: "blockEnd"; sessionId: string; contentIndex: number; block: ContentBlock }
  | { type: "toolCallStart"; sessionId: string; toolCallId: string; toolName: string }
  | { type: "toolCallEnd"; sessionId: string; toolCallId: string; args: unknown }
  | { type: "toolExecStart"; sessionId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "toolExecEnd"; sessionId: string; toolCallId: string; isError: boolean; durationMs?: number; content: string }
  | { type: "usage"; sessionId: string; usage: Usage }
  | { type: "messageCommitted"; sessionId: string; message: ChatMessage }
  | { type: "sessionInfo"; sessionId: string; name?: string; sessionFile?: string }
  | { type: "compaction"; sessionId: string; phase: "start" | "end"; reason?: string }
  | { type: "error"; sessionId: string; message: string }
  /** 需要用户在 UI 上作答的扩展对话框（权限确认等）。 */
  | { type: "extensionUi"; sessionId: string; request: ExtensionUiRequest };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; toolCallId: string; toolName: string; args: unknown };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  costTotal: number;
}

/** 会话消息（已归一，前端直接渲染）。 */
export type ChatMessage =
  | { role: "user"; text: string; images: number; timestamp: number }
  | {
      role: "assistant";
      blocks: ContentBlock[];
      timestamp: number;
      stopReason?: string;
      errorMessage?: string;
      usage?: Usage;
    }
  | {
      role: "tool";
      toolCallId: string;
      toolName: string;
      content: string;
      isError: boolean;
      timestamp: number;
    }
  | { role: "system"; text: string; timestamp: number }
  | { role: "notice"; text: string; timestamp: number; level?: "info" | "error" };

export type ExtensionUiRequest =
  | { kind: "select"; id: string; title: string; options: string[]; timeout?: number }
  | { kind: "confirm"; id: string; title: string; message: string; timeout?: number }
  | { kind: "input"; id: string; title: string; placeholder?: string }
  | { kind: "editor"; id: string; title: string; prefill?: string }
  | { kind: "notify"; id: string; message: string; level: "info" | "warning" | "error" };

export type ExtensionUiResponse =
  | { kind: "select"; id: string; value: string }
  | { kind: "confirm"; id: string; confirmed: boolean }
  | { kind: "input"; id: string; value: string }
  | { kind: "editor"; id: string; value: string }
  | { kind: "cancelled"; id: string };

/** `agent_state` 返回的会话快照。 */
export interface SessionState {
  sessionId: string | null;
  sessionFile: string | null;
  sessionName: string | null;
  cwd: string;
  model: ModelInfo | null;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  messages: ChatMessage[];
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  reasoning: boolean;
}

export interface SessionStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalMessages: number;
  tokens: Usage;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

/** 托盘/快捷键能触发的窗口形态。 */
export type WindowMode = "compact" | "full";

export interface AppConfig {
  /** pi 可执行文件路径，留空则走 PATH。 */
  piBinary: string;
  /** Agent 的工作目录。 */
  cwd: string;
  /** 传给 pi 的附加参数（如 --model / --exclude-tools）。 */
  piArgs: string[];
  /** 是否沿用 pi 的持久化会话（false 则 --no-session，每次全新）。 */
  persistSession: boolean;
  /** 快捷键（KWin 语法，如 "Meta+Space"）。 */
  toggleShortcut: string;
  compactWidth: number;
  compactHeight: number;
}
