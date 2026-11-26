import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUiRequest } from "@shared/protocol";

// store 模块顶层就引用 agentClient（IPC 出口），单测里统一换成内存桩。
vi.mock("@/services/agentClient", () => ({
  agentClient: {
    state: vi.fn(async () => ({
      sessionId: "session-1",
      messages: [],
      running: false,
    })),
    send: vi.fn(async () => ({ stopReason: "stop" })),
    abort: vi.fn(async () => undefined),
    newSession: vi.fn(async () => undefined),
    switchSession: vi.fn(async () => undefined),
    stats: vi.fn(async () => ({ userMessages: 0 })),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    respondExtensionUi: vi.fn(async () => undefined),
  },
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

describe("useAgentStore 扩展 UI 对话框（REQ-338）", () => {
  beforeEach(() => {
    // 重置到干净状态并固定当前会话，避免 sessionId 过滤丢事件。
    useAgentStore.setState({
      sessionId: SID,
      extensionUi: null,
      messages: [],
      running: false,
    });
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

  it("待决 select 期间到达的 notify 不顶掉对话框，转消息流（卡死修复）", () => {
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
    const notices = useAgentStore.getState().messages.filter((m) => m.role === "notice");
    expect(notices.at(-1)?.text).toBe("绑定成功");
  });

  it("无待决对话框时 notify 照旧进槽位", () => {
    useAgentStore.getState().applyEvent({
      type: "extensionUi",
      sessionId: SID,
      request: { kind: "notify", id: "", message: "hello", level: "info" },
    });
    expect(useAgentStore.getState().extensionUi?.kind).toBe("notify");
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
