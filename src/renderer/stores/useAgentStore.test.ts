import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUiRequest, SlashCommand } from "@shared/protocol";

// store 模块顶层就引用 agentClient（IPC 出口），单测里统一换成内存桩。
const commands: SlashCommand[] = [
  { name: "panel-req-list", description: "绑定需求", source: "extension" },
  { name: "review", description: "模板", source: "prompt" },
];

const sendOutcome = vi.hoisted(() => ({ value: "started" as "started" | "queued" | "handled" }));

vi.mock("@/services/agentClient", () => ({
  agentClient: {
    state: vi.fn(async () => ({
      sessionId: "session-1",
      messages: [],
      running: false,
    })),
    send: vi.fn(async () => sendOutcome.value),
    abort: vi.fn(async () => undefined),
    newSession: vi.fn(async () => undefined),
    switchSession: vi.fn(async () => undefined),
    stats: vi.fn(async () => ({ userMessages: 0 })),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    respondExtensionUi: vi.fn(async () => undefined),
  },
  cachedCommands: vi.fn(async () => commands),
  configClient: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
  },
  windowClient: {
    mode: vi.fn(async () => "full" as const),
    hide: vi.fn(async () => undefined),
    switchMode: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => false),
    toggleMaximize: vi.fn(async () => undefined),
  },
}));

import { useAgentStore } from "./useAgentStore";
import { agentClient } from "@/services/agentClient";

const SID = "session-1";

function selectRequest(id: string): ExtensionUiRequest {
  return {
    kind: "select",
    id,
    title: "选择要绑定的需求",
    options: Array.from({ length: 30 }, (_, i) => `REQ-${i} | 需求 ${i}`),
  };
}

const notices = () => useAgentStore.getState().messages.filter((m) => m.role === "notice");
const userMessages = () => useAgentStore.getState().messages.filter((m) => m.role === "user");

describe("useAgentStore 扩展 UI 对话框（REQ-338）", () => {
  beforeEach(() => {
    useAgentStore.setState({
      sessionId: SID,
      extensionUi: null,
      messages: [],
      running: false,
      commandRunning: false,
    });
    sendOutcome.value = "started";
    vi.mocked(agentClient.send).mockClear();
  });

  it("select 请求进入对话框槽位", () => {
    useAgentStore.getState().applyEvent({
      type: "extensionUi",
      sessionId: SID,
      request: selectRequest("ui-1"),
    });
    expect(useAgentStore.getState().extensionUi?.kind).toBe("select");
    expect(useAgentStore.getState().extensionUi?.id).toBe("ui-1");
  });

  it("notify 永远进消息流，不占对话框槽位（否则绑定提示会静默丢失）", () => {
    useAgentStore.getState().applyEvent({
      type: "extensionUi",
      sessionId: SID,
      request: { kind: "notify", id: "", message: "✅ 已绑定需求 REQ-1", level: "info" },
    });
    expect(useAgentStore.getState().extensionUi).toBeNull();
    expect(notices().at(-1)?.text).toBe("✅ 已绑定需求 REQ-1");
  });

  it("待决 select 期间到达的 notify 既不顶掉对话框也不丢", () => {
    useAgentStore.getState().applyEvent({
      type: "extensionUi",
      sessionId: SID,
      request: selectRequest("ui-1"),
    });
    useAgentStore.getState().applyEvent({
      type: "extensionUi",
      sessionId: SID,
      request: { kind: "notify", id: "", message: "绑定成功", level: "info" },
    });
    const ui = useAgentStore.getState().extensionUi;
    expect(ui?.kind).toBe("select");
    expect(ui?.id).toBe("ui-1");
    expect(notices().at(-1)?.text).toBe("绑定成功");
  });

  it("待决对话框不会被另一个对话框顶掉（锁住的 promise 不结算）", () => {
    useAgentStore.getState().applyEvent({
      type: "extensionUi",
      sessionId: SID,
      request: selectRequest("ui-1"),
    });
    useAgentStore.getState().applyEvent({
      type: "extensionUi",
      sessionId: SID,
      request: { kind: "confirm", id: "ui-2", title: "确认?", message: "x" },
    });
    expect(useAgentStore.getState().extensionUi?.id).toBe("ui-1");
  });

  it("respondUi 的 select 空串作答兜底到第一个选项", async () => {
    useAgentStore.getState().applyEvent({
      type: "extensionUi",
      sessionId: SID,
      request: selectRequest("ui-1"),
    });
    await useAgentStore.getState().respondUi(true, "");
    expect(vi.mocked(agentClient.respondExtensionUi).mock.lastCall?.[0]).toEqual({
      kind: "select",
      id: "ui-1",
      value: "REQ-0 | 需求 0",
    });
    expect(useAgentStore.getState().extensionUi).toBeNull();
  });
});

describe("useAgentStore 发送斜杠命令（REQ-338 复测）", () => {
  beforeEach(() => {
    useAgentStore.setState({
      sessionId: SID,
      extensionUi: null,
      messages: [],
      running: false,
      commandRunning: false,
    });
    vi.mocked(agentClient.send).mockClear();
  });

  it("扩展命令不进对话内容、不显示等待模型响应，执行完自动收尾", async () => {
    sendOutcome.value = "handled";
    await useAgentStore.getState().send("/panel-req-list");
    expect(userMessages()).toHaveLength(0);
    expect(useAgentStore.getState().running).toBe(false);
    expect(useAgentStore.getState().commandRunning).toBe(false);
  });

  it("扩展命令执行期间是「执行命令中」而非「等待模型响应」", async () => {
    sendOutcome.value = "handled";
    let midCommand: { running: boolean; commandRunning: boolean } | null = null;
    vi.mocked(agentClient.send).mockImplementationOnce(async () => {
      const s = useAgentStore.getState();
      midCommand = { running: s.running, commandRunning: s.commandRunning };
      return "handled" as const;
    });
    await useAgentStore.getState().send("/panel-req-list");
    expect(midCommand).toEqual({ running: false, commandRunning: true });
  });

  it("普通消息照旧乐观插入并保持运行态", async () => {
    sendOutcome.value = "started";
    await useAgentStore.getState().send("帮我看看这个报错");
    expect(userMessages()).toHaveLength(1);
    expect(useAgentStore.getState().running).toBe(true);
  });

  it("prompt 模板命令（非 extension）按普通输入对待", async () => {
    sendOutcome.value = "started";
    await useAgentStore.getState().send("/review");
    expect(userMessages()).toHaveLength(1);
  });

  it("命令缓存过期（pi 当成普通输入跑了模型）时补回消息", async () => {
    sendOutcome.value = "started";
    await useAgentStore.getState().send("/panel-req-list");
    expect(userMessages().map((m) => m.role === "user" && m.text)).toEqual(["/panel-req-list"]);
    expect(useAgentStore.getState().running).toBe(true);
  });

  it("模型跑着的时候插一条扩展命令，不能把那次运行收掉", async () => {
    sendOutcome.value = "handled";
    useAgentStore.setState({ running: true, live: [{ contentIndex: 0, kind: "text", text: "半截输出" }] });
    await useAgentStore.getState().send("/panel-req-list");
    const s = useAgentStore.getState();
    expect(s.running).toBe(true);
    expect(s.live).toHaveLength(1);
    expect(s.commandRunning).toBe(false);
    expect(userMessages()).toHaveLength(0);
  });
});

describe("useAgentStore 会话替换跟随（REQ-339）", () => {
  beforeEach(() => {
    useAgentStore.setState({
      sessionId: "old-session",
      extensionUi: null,
      messages: [],
      running: false,
      commandRunning: false,
    });
  });

  it("sessionReplaced 抢在 sessionId 过滤之前生效（否则界面再也收不到新会话事件）", async () => {
    useAgentStore.getState().applyEvent({
      type: "sessionReplaced",
      sessionId: "new-session",
      previousSessionId: "old-session",
    });
    expect(useAgentStore.getState().sessionId).toBe("new-session");
  });

  it("新会话事件不再被当成过期事件丢掉", () => {
    useAgentStore.getState().applyEvent({
      type: "sessionReplaced",
      sessionId: "new-session",
      previousSessionId: "old-session",
    });
    useAgentStore.getState().applyEvent({
      type: "runStarted",
      sessionId: "new-session",
    });
    expect(useAgentStore.getState().running).toBe(true);
  });

  it("会话替换保留刚到的界面提示（如「已恢复会话」）", () => {
    useAgentStore.getState().applyEvent({
      type: "extensionUi",
      sessionId: "old-session",
      request: { kind: "notify", id: "", message: "✅ 已恢复会话 abc", level: "info" },
    });
    useAgentStore.getState().applyEvent({
      type: "sessionReplaced",
      sessionId: "new-session",
      previousSessionId: "old-session",
    });
    const texts = useAgentStore
      .getState()
      .messages.filter((m) => m.role === "notice")
      .map((m) => (m.role === "notice" ? m.text : ""));
    expect(texts).toContain("✅ 已恢复会话 abc");
  });
});
