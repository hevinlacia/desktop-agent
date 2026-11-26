import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { mapSessionEvent, toChatMessage, toUsage } from "./mapping";
import type { ChatMessage } from "@shared/protocol";

const SID = "session-1";

/** 构造 pi 的 assistant 消息：字段很多，这里只填映射会读到的，其余给占位值。 */
function assistant(overrides: Partial<Assistant> & { content?: Assistant["content"] } = {}): Assistant {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "p",
    model: "m",
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: 1700000000000,
    ...overrides,
  } as Assistant;
}

type Assistant = Extract<
  Extract<AgentSessionEvent, { type: "message_end" }>["message"],
  { role: "assistant" }
>;

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function update(se: object, partial = assistant()) {
  return { type: "message_update", message: partial, assistantMessageEvent: { partial, ...se } } as AgentSessionEvent;
}

describe("mapSessionEvent", () => {
  it("运行生命周期：agent_start / agent_settled 转发，agent_end 不转发", () => {
    expect(mapSessionEvent({ type: "agent_start" }, SID)).toEqual([{ type: "runStarted", sessionId: SID }]);
    expect(mapSessionEvent({ type: "agent_end", messages: [], willRetry: false }, SID)).toEqual([]);
    expect(mapSessionEvent({ type: "agent_settled", aborted: true }, SID)).toEqual([
      { type: "runSettled", sessionId: SID, aborted: true },
    ]);
  });

  it("流式文本：delta 原样透传，空的 delta 丢弃，*_end 给出权威块", () => {
    expect(mapSessionEvent(update({ type: "text_delta", contentIndex: 1, delta: "你" }), SID)).toEqual([
      { type: "textDelta", sessionId: SID, contentIndex: 1, delta: "你" },
    ]);
    expect(mapSessionEvent(update({ type: "text_delta", contentIndex: 1, delta: "" }), SID)).toEqual([]);
    expect(mapSessionEvent(update({ type: "thinking_end", contentIndex: 2, content: "想一想" }), SID)).toEqual([
      { type: "blockEnd", sessionId: SID, contentIndex: 2, block: { type: "thinking", thinking: "想一想" } },
    ]);
  });

  it("工具调用：start 从 partial.content 取 id/name，end 带完整参数", () => {
    const call = { type: "toolCall" as const, id: "call_1", name: "bash", arguments: { command: "ls" } };
    const partial = assistant({ content: [call] });
    expect(
      mapSessionEvent({ type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial } }, SID),
    ).toEqual([{ type: "toolCallStart", sessionId: SID, toolCallId: "call_1", toolName: "bash" }]);
    expect(
      mapSessionEvent({ type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call, partial } }, SID),
    ).toEqual([{ type: "toolCallEnd", sessionId: SID, toolCallId: "call_1", args: { command: "ls" } }]);
  });

  it("消息结束：用户消息不回传，assistant 提交权威内容，空的 pending 消息跳过", () => {
    expect(
      mapSessionEvent({ type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } }, SID),
    ).toEqual([]);

    const pending = mapSessionEvent({ type: "message_end", message: assistant({ stopReason: "pending" }) }, SID);
    expect(pending).toEqual([]);

    const done = mapSessionEvent(
      { type: "message_end", message: assistant({ content: [{ type: "text", text: "完成" }] }) },
      SID,
    );
    expect(done).toEqual([
      {
        type: "messageCommitted",
        sessionId: SID,
        message: expect.objectContaining({ role: "assistant", blocks: [{ type: "text", text: "完成" }] }),
      },
    ]);
  });

  it("工具执行：结束时只把文本块拼成 content", () => {
    const events = mapSessionEvent(
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "image", data: "", mimeType: "image/png" }] },
        isError: false,
        durationMs: 12,
      },
      SID,
    );
    expect(events).toEqual([
      { type: "toolExecEnd", sessionId: SID, toolCallId: "call_1", isError: false, durationMs: 12, content: "a\nb" },
    ]);
  });

  it("其余：压缩、会话名、自动重试提示", () => {
    expect(mapSessionEvent({ type: "compaction_start", reason: "threshold" }, SID)).toEqual([
      { type: "compaction", sessionId: SID, phase: "start", reason: "threshold" },
    ]);
    expect(mapSessionEvent({ type: "session_info_changed", name: "新名字" }, SID)).toEqual([
      { type: "sessionInfo", sessionId: SID, name: "新名字" },
    ]);
    expect(mapSessionEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "x" }, SID)).toEqual([
      expect.objectContaining({
        type: "messageCommitted",
        message: expect.objectContaining({ role: "notice", text: "模型调用失败，正在重试（1/3）" }),
      }),
    ]);
  });
});

describe("toChatMessage", () => {
  it("user：字符串与数组两种内容，数组时统计图片数", () => {
    expect(toChatMessage({ role: "user", content: "你好", timestamp: 5 })).toEqual<ChatMessage>({
      role: "user",
      text: "你好",
      images: 0,
      timestamp: 5,
    });
    const withImage = toChatMessage({
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image", data: "…", mimeType: "image/png" },
      ],
      timestamp: 5,
    });
    expect(withImage).toEqual<ChatMessage>({ role: "user", text: "看图", images: 1, timestamp: 5 });
  });

  it("system：正文取 sections；compactionSummary 转提示；其余角色不呈现", () => {
    expect(toChatMessage({ role: "system", content: "", sections: { a: "一", b: null, c: "二" }, timestamp: 1 })).toEqual<ChatMessage>({
      role: "system",
      text: "一\n\n二",
      timestamp: 1,
    });
    const summary = toChatMessage({ role: "compactionSummary", summary: "x".repeat(300), tokensBefore: 42, timestamp: 1 });
    expect(summary).toEqual<ChatMessage>({
      role: "notice",
      text: `上下文已压缩（压缩前 42 tokens）：${"x".repeat(200)}`,
      timestamp: 1,
    });
    expect(toChatMessage({ role: "bashExecution", command: "ls", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 })).toBeNull();
  });
});

describe("toUsage", () => {
  it("cost.total → costTotal，reasoning 有值才带上", () => {
    expect(toUsage({ ...zeroUsage(), input: 10, totalTokens: 15, cost: { ...zeroUsage().cost, total: 0.5 } })).toEqual({
      input: 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      costTotal: 0.5,
    });
    expect(toUsage({ ...zeroUsage(), reasoning: 3 })).toMatchObject({ reasoning: 3 });
  });
});
