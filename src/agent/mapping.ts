/**
 * pi SDK 事件 / 消息 → 前端契约的归一化。全部是纯函数。
 *
 * 职责边界：只做「形状转换」，不解释业务语义；前端只消费 `AgentEvent`。
 * 这里的类型全部从 `AgentSessionEvent` 推导，避免直接依赖 pi 的内部包。
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  AgentEvent,
  AgentEventBody,
  ChatMessage,
  ContentBlock,
  ModelInfo,
  SessionSummary,
  Usage,
} from "@shared/protocol";

type SessionMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"];
type StreamEvent = Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];
type AssistantMessage = Extract<SessionMessage, { role: "assistant" }>;
type PiUsage = AssistantMessage["usage"];
type PiContent = AssistantMessage["content"][number];

export type { SessionMessage as PiSessionMessage };

const DEFAULT_STREAM_ERROR = "模型流式输出异常";

/**
 * 把一条 pi 会话事件翻译成 0..n 条前端事件。
 *
 * 不转发的：`agent_end`（不等于结束，前端等 `agent_settled`）、`turn_end`、
 * `queue_update`、`entry_appended` 等。
 */
export function mapSessionEvent(event: AgentSessionEvent, sessionId: string): AgentEvent[] {
  const ev = (e: AgentEventBody): AgentEvent => ({ ...e, sessionId } as AgentEvent);

  switch (event.type) {
    case "agent_start":
      return [ev({ type: "runStarted" })];
    case "turn_start":
      return [ev({ type: "turnStarted" })];
    case "agent_settled":
      return [ev({ type: "runSettled", aborted: event.aborted })];
    case "message_update":
      return mapStreamEvent(event.assistantMessageEvent, sessionId);
    case "message_end": {
      // 流式刚建立时 pi 会先给出一条空消息，不算正式提交。
      if (event.message.role === "assistant" && event.message.content.length === 0) {
        if (event.message.stopReason === "pending") return [];
      }
      const message = toChatMessage(event.message);
      // 用户消息由前端乐观插入，这里不回传，避免重复。
      return message && message.role !== "user" ? [ev({ type: "messageCommitted", message })] : [];
    }
    case "tool_execution_start":
      return [ev({ type: "toolExecStart", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args })];
    case "tool_execution_end":
      return [
        ev({
          type: "toolExecEnd",
          toolCallId: event.toolCallId,
          isError: event.isError,
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          content: resultText(event.result),
        }),
      ];
    case "compaction_start":
      return [ev({ type: "compaction", phase: "start", reason: event.reason })];
    case "compaction_end":
      return [ev({ type: "compaction", phase: "end", reason: event.reason })];
    case "session_info_changed":
      return [ev({ type: "sessionInfo", name: event.name })];
    case "auto_retry_start":
      return [
        ev({
          type: "messageCommitted",
          message: {
            role: "notice",
            text: `模型调用失败，正在重试（${event.attempt}/${event.maxAttempts}）`,
            timestamp: Date.now(),
          },
        }),
      ];
    default:
      return [];
  }
}

function mapStreamEvent(se: StreamEvent, sessionId: string): AgentEvent[] {
  const ev = (e: AgentEventBody): AgentEvent => ({ ...e, sessionId } as AgentEvent);

  switch (se.type) {
    case "text_delta":
      return se.delta ? [ev({ type: "textDelta", contentIndex: se.contentIndex, delta: se.delta })] : [];
    case "thinking_delta":
      return se.delta ? [ev({ type: "thinkingDelta", contentIndex: se.contentIndex, delta: se.delta })] : [];
    case "text_end":
      return [ev({ type: "blockEnd", contentIndex: se.contentIndex, block: { type: "text", text: se.content } })];
    case "thinking_end":
      return [
        ev({ type: "blockEnd", contentIndex: se.contentIndex, block: { type: "thinking", thinking: se.content } }),
      ];
    case "toolcall_start": {
      const call = se.partial.content[se.contentIndex];
      return call?.type === "toolCall"
        ? [ev({ type: "toolCallStart", toolCallId: call.id, toolName: call.name })]
        : [];
    }
    case "toolcall_end":
      return [
        ev({ type: "toolCallEnd", toolCallId: se.toolCall.id, args: se.toolCall.arguments }),
      ];
    case "done":
      return [ev({ type: "usage", usage: toUsage(se.message.usage) })];
    case "error":
      return [ev({ type: "error", message: se.error.errorMessage ?? DEFAULT_STREAM_ERROR })];
    default:
      // start / text_start / thinking_start / toolcall_delta：前端不需要。
      return [];
  }
}

export function toUsage(usage: PiUsage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    totalTokens: usage.totalTokens,
    costTotal: usage.cost.total,
  };
}

export function toContentBlock(block: PiContent): ContentBlock | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", thinking: block.thinking };
    case "toolCall":
      return { type: "toolCall", toolCallId: block.id, toolName: block.name, args: block.arguments };
    default:
      return null;
  }
}

/** pi 消息 → 前端消息。无法呈现的角色（bash 执行记录、自定义消息等）返回 null。 */
export function toChatMessage(message: SessionMessage): ChatMessage | null {
  switch (message.role) {
    case "user": {
      const text = typeof message.content === "string" ? message.content : textParts(message.content).join("\n");
      const images =
        typeof message.content === "string" ? 0 : message.content.filter((c) => c.type === "image").length;
      return { role: "user", text, images, timestamp: message.timestamp };
    }
    case "assistant": {
      const blocks = message.content.map(toContentBlock).filter((b): b is ContentBlock => b !== null);
      return {
        role: "assistant",
        blocks,
        timestamp: message.timestamp,
        stopReason: message.stopReason,
        ...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
        usage: toUsage(message.usage),
      };
    }
    case "toolResult": {
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: resultText({ content: message.content }),
        isError: message.isError,
        timestamp: message.timestamp,
      };
    }
    case "system": {
      // system 消息的正文放在 sections 里，拼起来仅用于调试展示。
      const sections = message.sections
        ? Object.values(message.sections).filter((s): s is string => typeof s === "string")
        : [];
      return { role: "system", text: sections.join("\n\n"), timestamp: message.timestamp };
    }
    case "compactionSummary":
      return {
        role: "notice",
        text: `上下文已压缩（压缩前 ${message.tokensBefore} tokens）：${message.summary.slice(0, 200)}`,
        timestamp: message.timestamp,
      };
    default:
      return null;
  }
}

type PiModel = NonNullable<AgentSession["model"]>;

export function toModelInfo(model: PiModel | undefined): ModelInfo | null {
  if (!model) return null;
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
  };
}

export function toSessionSummary(
  info: { path: string; id: string; name?: string; modified: Date; messageCount: number },
  sizeBytes: number,
): SessionSummary {
  return {
    path: info.path,
    sessionId: info.id,
    name: info.name ?? null,
    modifiedMs: info.modified.getTime(),
    sizeBytes,
    messageCount: info.messageCount,
  };
}

function textParts(content: ReadonlyArray<{ type: string; text?: string }>): string[] {
  const out: string[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") out.push(part.text);
  }
  return out;
}

/** 工具结果只呈现文本块，图片块不转成文字。 */
function resultText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) return "";
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content) ? truncateOutput(textParts(content as { type: string; text?: string }[]).join("\n")) : "";
}

/**
 * 工具输出进入 IPC/渲染层的截断（REQ-346 修复轮）：WMS 大会话单页消息可达 20-30MB，
 * 全量克隆传输 + 渲染是池命中后仍慢的隐性成本。保留头尾（头 12KB + 尾 4KB），
 * 标注总长度；完整原文始终在 pi 会话文件里，桌面端只是查看器。
 */
const TOOL_OUTPUT_MAX = 16 * 1024;
const TOOL_OUTPUT_TAIL = 4 * 1024;

function truncateOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_MAX) return text;
  const head = text.slice(0, TOOL_OUTPUT_MAX - TOOL_OUTPUT_TAIL);
  const tail = text.slice(-TOOL_OUTPUT_TAIL);
  const kb = Math.round(text.length / 102.4) / 10;
  return `${head}\n…（输出已截断，完整共 ${kb}KB，原文见 pi 会话文件）\n${tail}`;
}
