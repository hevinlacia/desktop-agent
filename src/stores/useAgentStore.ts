/**
 * 单一状态源（Zustand）。
 *
 * 设计要点：
 * 1. **流式拼接在这里做，不在组件里**。组件只读 `live` 快照，避免每帧重建数组。
 * 2. **权威内容优先**：`blockEnd` 与 `messageCommitted` 覆盖流式缓冲，因为 pi 的
 *    delta 是纯增量（wire 层去掉了 partial 快照），只有 `*_end` 的 content 可信。
 * 3. **按 sessionId 过滤**：切会话时旧会话的迟到事件必须丢弃，否则串流。
 */
import { create } from "zustand";
import type {
  AgentEvent,
  ChatMessage,
  ContentBlock,
  ExtensionUiRequest,
  ModelInfo,
  SessionState,
  SessionStats,
  Usage,
  WindowMode,
} from "@/types/protocol";
import { agentClient, configClient, windowClient } from "@/services/agentClient";
import type { AppConfig } from "@/types/protocol";

export interface LiveBlock {
  contentIndex: number;
  kind: "text" | "thinking" | "toolCall";
  text: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
}

export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  args: unknown;
  phase: "running" | "done" | "error";
  output: string;
  durationMs?: number;
}

interface AgentStore {
  // ---- 会话 ----
  sessionId: string | null;
  sessionFile: string | null;
  sessionName: string | null;
  cwd: string;
  model: ModelInfo | null;
  thinkingLevel: string;
  messages: ChatMessage[];
  stats: SessionStats | null;
  lastUsage: Usage | null;

  // ---- 运行态 ----
  running: boolean;
  compacting: boolean;
  live: LiveBlock[];
  toolExec: Record<string, ToolExecution>;
  extensionUi: ExtensionUiRequest | null;

  // ---- UI ----
  mode: WindowMode;
  bootError: string | null;
  config: AppConfig | null;
  ready: boolean;

  // ---- actions ----
  bootstrap: () => Promise<void>;
  applyEvent: (event: AgentEvent) => void;
  send: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  newSession: () => Promise<void>;
  switchSession: (path: string) => Promise<void>;
  refreshStats: () => Promise<void>;
  setMode: (mode: WindowMode) => Promise<void>;
  respondUi: (confirmed: boolean, value?: string) => Promise<void>;
  dismissUi: () => void;
  setBootError: (msg: string | null) => void;
  reloadConfig: () => Promise<void>;
  saveConfig: (cfg: AppConfig) => Promise<void>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
}

const EMPTY: Pick<
  AgentStore,
  "messages" | "live" | "toolExec" | "lastUsage" | "stats" | "extensionUi"
> = {
  messages: [],
  live: [],
  toolExec: {},
  lastUsage: null,
  stats: null,
  extensionUi: null,
};

function upsertLive(live: LiveBlock[], next: LiveBlock): LiveBlock[] {
  const idx = live.findIndex(
    (b) =>
      b.contentIndex === next.contentIndex &&
      (b.toolCallId ?? "") === (next.toolCallId ?? ""),
  );
  if (idx === -1) return [...live, next].sort((a, b) => a.contentIndex - b.contentIndex);
  const copy = live.slice();
  copy[idx] = next;
  return copy;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  sessionId: null,
  sessionFile: null,
  sessionName: null,
  cwd: "",
  model: null,
  thinkingLevel: "off",
  messages: [],
  stats: null,
  lastUsage: null,
  running: false,
  compacting: false,
  live: [],
  toolExec: {},
  extensionUi: null,
  mode: "compact",
  bootError: null,
  config: null,
  ready: false,

  async bootstrap() {
    try {
      const [state, config] = await Promise.all([
        agentClient.state(),
        configClient.get().catch(() => null),
      ]);
      set({
        ...hydrate(state),
        config,
        ready: true,
        bootError: null,
      });
      void get().refreshStats();
    } catch (e) {
      set({ bootError: e instanceof Error ? e.message : String(e), ready: true });
    }
  },

  applyEvent(event) {
    const current = get().sessionId;
    // 会话切换期间旧事件必须丢弃，否则会串到新会话视图里。
    if (event.sessionId && current && event.sessionId !== current) return;

    switch (event.type) {
      case "runStarted":
        set({ running: true, live: [] });
        break;

      case "runSettled":
        set((s) => ({
          running: false,
          live: [],
          // 运行结束但没收到 committed 时（如 aborted），给一条提示消息。
          messages:
            event.aborted && s.live.length === 0
              ? [...s.messages, notice("已中止本次运行")]
              : s.messages,
        }));
        void get().refreshStats();
        break;

      case "turnStarted":
        if (!get().running) set({ running: true });
        break;

      case "textDelta":
        set((s) => ({
          live: upsertLive(s.live, {
            contentIndex: event.contentIndex,
            kind: "text",
            text: growText(s.live, event.contentIndex, event.delta),
          }),
        }));
        break;

      case "thinkingDelta":
        set((s) => ({
          live: upsertLive(s.live, {
            contentIndex: event.contentIndex,
            kind: "thinking",
            text: growText(s.live, event.contentIndex, event.delta),
          }),
        }));
        break;

      case "blockEnd": {
        const block = event.block;
        const kind =
          block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : "toolCall";
        const text =
          block.type === "text"
            ? block.text
            : block.type === "thinking"
              ? block.thinking
              : "";
        set((s) => ({
          // 用权威内容覆盖，修掉任何拼接偏差。
          live: upsertLive(s.live, {
            contentIndex: event.contentIndex,
            kind,
            text,
            ...(block.type === "toolCall"
              ? {
                  toolCallId: block.toolCallId,
                  toolName: block.toolName,
                  args: block.args,
                }
              : {}),
          }),
        }));
        break;
      }

      case "toolCallStart":
        set((s) => ({
          live: upsertLive(s.live, {
            contentIndex: nextToolIndex(s.live),
            kind: "toolCall",
            text: "",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          }),
        }));
        break;

      case "toolCallEnd":
        set((s) => ({
          live: s.live.map((b) =>
            b.toolCallId === event.toolCallId ? { ...b, args: event.args } : b,
          ),
        }));
        break;

      case "toolExecStart":
        set((s) => ({
          toolExec: {
            ...s.toolExec,
            [event.toolCallId]: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              phase: "running",
              output: "",
            },
          },
        }));
        break;

      case "toolExecEnd":
        set((s) => {
          const prev = s.toolExec[event.toolCallId];
          return {
            toolExec: {
              ...s.toolExec,
              [event.toolCallId]: {
                toolCallId: event.toolCallId,
                // pi 的 tool_execution_end 不带 toolName（已在 start 时记录），回退到上一次值。
                toolName: prev?.toolName ?? "",
                args: prev?.args ?? null,
                phase: event.isError ? "error" : "done",
                output: event.content,
                ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
              } satisfies ToolExecution,
            },
          };
        });
        break;

      case "usage":
        set({ lastUsage: event.usage });
        break;

      case "messageCommitted":
        set((s) => ({
          // assistant 消息落地后清空对应 live 缓冲，避免重影。
          messages: [...s.messages, event.message],
          live: event.message.role === "assistant" ? [] : s.live,
        }));
        break;

      case "sessionInfo":
        set((s) => ({
          sessionName: event.name ?? s.sessionName,
          sessionFile: event.sessionFile ?? s.sessionFile,
        }));
        break;

      case "compaction":
        set((s) => ({
          compacting: event.phase === "start",
          messages:
            event.phase === "end"
              ? [...s.messages, notice(`上下文压缩完成（${event.reason ?? "threshold"}）`)]
              : s.messages,
        }));
        break;

      case "extensionUi":
        set({ extensionUi: event.request });
        break;

      case "error":
        set((s) => ({
          running: false,
          messages: [...s.messages, notice(event.message, "error")],
        }));
        break;
    }
  },

  async send(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    // 乐观插入用户消息：pi 不回传 user 事件，等 messageCommitted 会缺一条。
    set((s) => ({
      messages: [...s.messages, { role: "user", text: trimmed, images: 0, timestamp: Date.now() }],
      running: true,
      live: [],
    }));
    try {
      // 运行中继续发消息按 steer 排队，符合"边看边纠偏"的使用习惯。
      await agentClient.send(trimmed, {
        streamingBehavior: get().running ? "steer" : undefined,
      });
    } catch (e) {
      set((s) => ({
        running: false,
        messages: [...s.messages, notice(errText(e), "error")],
      }));
    }
  },

  async abort() {
    try {
      await agentClient.abort();
    } finally {
      set({ running: false, live: [] });
    }
  },

  async newSession() {
    set({ ...EMPTY, running: false, compacting: false });
    await agentClient.newSession();
    const state = await agentClient.state();
    set(hydrate(state));
  },

  async switchSession(path) {
    set({ ...EMPTY, running: false, compacting: false });
    await agentClient.switchSession(path);
    const state = await agentClient.state();
    set(hydrate(state));
  },

  async refreshStats() {
    try {
      set({ stats: await agentClient.stats() });
    } catch {
      // stats 失败不影响主流程（例如会话还没落盘）。
    }
  },

  async setMode(mode) {
    set({ mode });
    await windowClient.switchMode(mode).catch(() => undefined);
  },

  async respondUi(confirmed, value) {
    const req = get().extensionUi;
    if (!req) return;
    set({ extensionUi: null });
    try {
      switch (req.kind) {
        case "confirm":
          await agentClient.respondExtensionUi({ kind: "confirm", id: req.id, confirmed });
          break;
        case "select":
          await agentClient.respondExtensionUi({
            kind: "select",
            id: req.id,
            value: value ?? req.options[0] ?? "",
          });
          break;
        case "input":
        case "editor":
          await agentClient.respondExtensionUi({ kind: req.kind, id: req.id, value: value ?? "" });
          break;
        case "notify":
          break;
      }
    } catch (e) {
      set((s) => ({ messages: [...s.messages, notice(errText(e), "error")] }));
    }
  },

  dismissUi() {
    const req = get().extensionUi;
    if (!req) return;
    set({ extensionUi: null });
    void agentClient
      .respondExtensionUi({ kind: "cancelled", id: req.id })
      .catch(() => undefined);
  },

  setBootError(msg) {
    set({ bootError: msg });
  },

  async reloadConfig() {
    set({ config: await configClient.get() });
  },

  async saveConfig(cfg) {
    await configClient.set(cfg);
    set({ config: cfg });
    const state = await agentClient.state();
    set(hydrate(state));
  },

  async setModel(provider, modelId) {
    await agentClient.setModel(provider, modelId);
    const state = await agentClient.state();
    set({ model: state.model });
  },

  async setThinkingLevel(level) {
    await agentClient.setThinkingLevel(level);
    set({ thinkingLevel: level });
  },
}));

function hydrate(state: SessionState): Partial<AgentStore> {
  return {
    sessionId: state.sessionId,
    sessionFile: state.sessionFile,
    sessionName: state.sessionName,
    cwd: state.cwd,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    messages: state.messages,
    running: state.isStreaming,
    compacting: state.isCompacting,
    live: [],
    toolExec: {},
  };
}

/** 拼接：找到已有块则追加 delta，否则新建。 */
function growText(live: LiveBlock[], contentIndex: number, delta: string): string {
  const found = live.find((b) => b.contentIndex === contentIndex);
  return (found?.text ?? "") + delta;
}

/** toolCall 没有可靠的 contentIndex 时，排在所有已知块之后。 */
function nextToolIndex(live: LiveBlock[]): number {
  const max = live.reduce((m, b) => Math.max(m, b.contentIndex), -1);
  return max + 1;
}

function notice(text: string, level: "error" | "info" = "info"): ChatMessage {
  return { role: "notice", text, timestamp: Date.now(), ...(level === "error" ? { level } : {}) };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 供组件读取：committed 消息里的 toolCall 块 → 对应执行结果。 */
export function findToolExec(
  toolExec: Record<string, ToolExecution>,
  toolCallId: string,
): ToolExecution | undefined {
  return toolExec[toolCallId];
}

/** 把 live 块转成渲染用的 ContentBlock，复用同一套渲染组件。 */
export function liveToBlocks(live: LiveBlock[]): ContentBlock[] {
  return live.map((b) => {
    if (b.kind === "text") return { type: "text", text: b.text } as ContentBlock;
    if (b.kind === "thinking") return { type: "thinking", thinking: b.text } as ContentBlock;
    return {
      type: "toolCall",
      toolCallId: b.toolCallId ?? "",
      toolName: b.toolName ?? "",
      args: b.args ?? null,
    } as ContentBlock;
  });
}
