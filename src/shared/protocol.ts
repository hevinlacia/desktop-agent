/**
 * 三个进程共享的唯一契约：主进程、Agent 子进程、渲染进程都从这里取类型。
 * 改这里必须同时检查产出方 `src/agent/mapping.ts` 与消费方
 * `src/renderer/stores/useAgentStore.ts`。
 */

/** Agent 事件。所有事件都带 `sessionId`，前端据此丢弃切会话后的迟到事件。 */
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
  | {
      type: "toolExecEnd";
      sessionId: string;
      toolCallId: string;
      isError: boolean;
      durationMs?: number;
      content: string;
    }
  | { type: "usage"; sessionId: string; usage: Usage }
  | { type: "messageCommitted"; sessionId: string; message: ChatMessage }
  | { type: "sessionInfo"; sessionId: string; name?: string; sessionFile?: string }
  /**
   * 会话被替掉（新建 / 切换）。扩展自己发起的切换不经过渲染进程，渲染层必须靠这条
   * 事件跟上，否则新会话的事件会被当成「过期会话」全部丢掉（界面看起来死掉）。
   * 这条事件必须在 sessionId 过滤之前处理。
   */
  | { type: "sessionReplaced"; sessionId: string; previousSessionId: string | null }
  | { type: "compaction"; sessionId: string; phase: "start" | "end"; reason?: string }
  | { type: "error"; sessionId: string; message: string }
  /** 需要用户在 UI 上作答的扩展对话框（权限确认等）。 */
  | { type: "extensionUi"; sessionId: string; request: ExtensionUiRequest };

/**
 * 对联合类型逐分支 Omit。直接 `Omit<联合, K>` 会把各分支揉成一个对象、丢掉判别字段。
 * 不导出：外面只用下面两个结果类型。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends T ? Omit<T, K> : never;

/** 事件体：子进程补上 `sessionId` 再发出。 */
export type AgentEventBody = DistributiveOmit<AgentEvent, "sessionId">;

/** 扩展 UI 请求体：宿主补上 `id`（用来把作答回配给发起的扩展调用）。 */
export type ExtensionUiRequestBody = DistributiveOmit<ExtensionUiRequest, "id">;

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

/** 会话列表里的一项。列表按工作目录分组，来自 pi 的会话目录。 */
export interface SessionSummary {
  path: string;
  sessionId: string;
  name: string | null;
  modifiedMs: number;
  sizeBytes: number;
  messageCount: number;
}

/** `agent_send` 的受理结果：立即开跑 / 排队（steer、followUp）/ 被扩展命令直接处理。 */
export type PromptOutcome = "started" | "queued" | "handled";

/**
 * 斜杠命令联想的一项，与 pi 自带 RPC 模式的 get_commands 同源：
 * 扩展注册的命令、prompt 模板、skill（名字带 `skill:` 前缀）。
 * 联想只负责把命令名补进输入框；回车提交仍走普通 prompt()，由 pi 自己识别并执行 / 展开。
 */
export interface SlashCommand {
  name: string;
  description: string;
  source: "extension" | "prompt" | "skill";
  /** 参数提示，例如 `<provider:model>`；没有就不带。 */
  argumentHint?: string;
}

/** 托盘/快捷键能触发的窗口形态。 */
export type WindowMode = "compact" | "full";

/** 定位一个模型：provider + 模型 id。 */
export interface ModelRef {
  provider: string;
  id: string;
}

export interface AppConfig {
  /** Agent 工作目录：工具 cwd、项目资源发现、会话按此目录分组。 */
  cwd: string;
  /** 是否把会话落盘到 pi 的会话目录（false = 每次全新、不保存）。 */
  persistSession: boolean;
  /** 是否加载 pi 的扩展 / skills（~/.pi/agent 与项目目录下的资源）。 */
  extensions: boolean;
  /** 全局快捷键，Electron accelerator 写法，如 "Super+Space"。 */
  toggleShortcut: string;
  /** 悬浮窗尺寸。 */
  compactWidth: number;
  compactHeight: number;
  /** 完整窗口尺寸。 */
  fullWidth: number;
  fullHeight: number;
  /** 对话窗口是否最大化。记住用户的选择：切到悬浮窗再回来、下次启动都照此恢复。 */
  fullMaximized: boolean;
  /** 上个会话使用的模型：新建会话时沿用。为空或该模型已不可用时回落到 pi 的默认模型。 */
  lastModel: ModelRef | null;
}
