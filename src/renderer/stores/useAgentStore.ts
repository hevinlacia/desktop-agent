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
  AppConfig,
  ChatMessage,
  ContentBlock,
  ExtensionUiRequest,
  ModelInfo,
  SessionState,
  SessionStats,
  Usage,
  WindowMode,
} from "@shared/protocol";
import { agentClient, cachedCommands, configClient, windowClient } from "@/services/agentClient";
import { ensureGroups, openSession } from "@shared/session-groups";
import { SESSION_MESSAGES_PAGE } from "@shared/protocol";

/** 悬浮窗展开会话侧边栏时的窗口高度（逻辑像素）：表头 + 约 8 行会话。 */
export const COMPACT_SIDEBAR_WINDOW_HEIGHT = 420;

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
  /** 更早的消息（「加载更早」往前翻页累积，REQ-346）；state 只带最近一页。 */
  olderMessages: ChatMessage[];
  /** 更早还有没有消息。 */
  hasOlder: boolean;
  /** 正在拉更早的消息。 */
  loadingOlder: boolean;
  stats: SessionStats | null;
  lastUsage: Usage | null;

  // ---- 运行态 ----
  running: boolean;
  /** 正在执行扩展斜杠命令（不跑模型）：与 running 区分，避免误显示「等待模型响应」。 */
  commandRunning: boolean;
  compacting: boolean;
  /** 重启/恢复会话期间的进度提示（REQ-344 ④）：这个窗口期没有事件流，不提示就像卡死。 */
  sessionBusy: "restart" | "resume" | null;
  live: LiveBlock[];
  toolExec: Record<string, ToolExecution>;
  extensionUi: ExtensionUiRequest | null;

  // ---- UI ----
  mode: WindowMode;
  /** 悬浮窗里的会话侧边栏是否展开。不持久化：每次进入悬浮窗形态都从收起开始。 */
  compactSidebarOpen: boolean;
  /** 悬浮窗里斜杠命令联想列表需要的高度（逻辑像素），0 = 没有弹出。弹出时窗口临时加高。 */
  compactCommandPopupHeight: number;
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
  /** 往前翻一页更早的消息（REQ-346：大会话首屏只渲染最近一页）。 */
  loadEarlier: () => Promise<void>;
  /** 重新取一次会话状态并 hydrate（扩展发起的切换、外部改动后用）。 */
  refreshSession: () => Promise<void>;
  restoreAfterRestart: () => Promise<void>;
  refreshStats: () => Promise<void>;
  setMode: (mode: WindowMode) => Promise<void>;
  /** 宿主改了窗口形态：只同步状态，不回写宿主。 */
  applyHostMode: (mode: WindowMode) => void;
  setCompactSidebarOpen: (open: boolean) => Promise<void>;
  setCompactCommandPopupHeight: (height: number) => Promise<void>;
  respondUi: (confirmed: boolean, value?: string) => Promise<void>;
  dismissUi: () => void;
  setBootError: (msg: string | null) => void;
  /** 往对话流推一条界面提示（info 级）。 */
  pushNotice: (text: string) => void;
  /** 把当前会话登记到激活分组的「打开」清单（新会话、重启后恢复都走它）。 */
  registerCurrentSession: () => Promise<void>;
  /** 把指定会话文件登记进激活分组（newSession 拿到 state 后直接调）。 */
  registerSessionFile: (file: string) => Promise<void>;
  /**
   * 在激活分组里新建会话（侧边栏按钮与分组头共用）。
   * 空分组且目录与当前 runtime cwd 不同时，先以该目录启动一次（只有这种情况要重启）。
   */
  createSessionInActiveGroup: () => Promise<void>;
  reloadConfig: () => Promise<void>;
  saveConfig: (cfg: AppConfig) => Promise<void>;
  setModel: (provider: string, modelId: string) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
}

const EMPTY: Pick<
  AgentStore,
  "messages" | "olderMessages" | "hasOlder" | "loadingOlder" | "live" | "toolExec" | "lastUsage" | "stats" | "extensionUi"
> = {
  messages: [],
  olderMessages: [],
  hasOlder: false,
  loadingOlder: false,
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
  commandRunning: false,
  compacting: false,
  sessionBusy: null,
  live: [],
  toolExec: {},
  extensionUi: null,
  mode: "compact",
  compactSidebarOpen: false,
  compactCommandPopupHeight: 0,
  bootError: null,
  config: null,
  ready: false,
  olderMessages: [],
  hasOlder: false,
  loadingOlder: false,

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
    // 扩展发起的会话替换：新会话 id 与当前不同，必须抢在过滤之前接住，
    // 否则这条事件自己也会被丢掉，界面从此再也收不到任何新会话事件。
    if (event.type === "sessionReplaced") {
      // 刚到的界面提示（例如扩展发的「已恢复会话 …」）要保留：它们是 UI 反馈，
      // 不属于会话内容，跟着会话重置一起清掉就再也看不到了。
      const keepFrom = Date.now() - NOTICE_KEEP_MS;
      set((s) => ({
        ...EMPTY,
        sessionId: event.sessionId,
        running: false,
        compacting: false,
        messages: s.messages.filter((m) => m.role === "notice" && m.timestamp >= keepFrom),
      }));
      void get().refreshSession();
      return;
    }
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

      case "extensionUi": {
        const incoming = event.request;
        // notify 是只读提示（绑定成功/失败等），永远进消息流。
        // 旧实现把它塞进对话框槽位，而槽位只渲染 select/confirm/input/editor，
        // notify 就静默丢了——绑定成功了却看不到任何提示（REQ-338 复测）。
        if (incoming.kind === "notify") {
          set((s) => ({
            messages: [
              ...s.messages,
              notice(incoming.message, incoming.level === "error" ? "error" : "info"),
            ],
          }));
          break;
        }
        // 待决对话框也不能被另一个对话框顶掉：锁住的 promise 会永远不结算。
        if (get().extensionUi) {
          set((s) => ({
            messages: [
              ...s.messages,
              notice("已忽略一个新对话框（另有对话框未关闭）", "error"),
            ],
          }));
          break;
        }
        set({ extensionUi: incoming });
        break;
      }

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
    // 斜杠命令先查是不是扩展命令：扩展命令只是交互入口（弹窗、绑定、开关），pi 在
    // prompt() 里直接执行并回 "handled"，不跑模型。所以既不该把命令文本当成对话内容，
    // 也不该进入「等待模型响应」（REQ-338 复测）。
    const isCommand = trimmed.startsWith("/") && (await isExtensionCommandInput(trimmed));
    const stamp = Date.now();
    // 本次发送是否自己置起了 running（只有自己置起的才能自己收回）。
    const ownsRun = !isCommand;
    const alreadyRunning = get().running;
    if (isCommand) {
      set({ commandRunning: true });
    } else {
      // 乐观插入用户消息：pi 不回传 user 事件，等 messageCommitted 会缺一条。
      set((s) => ({
        messages: [...s.messages, userMessage(trimmed, stamp)],
        running: true,
        live: [],
      }));
    }
    try {
      // 运行中继续发消息按 steer 排队，符合"边看边纠偏"的使用习惯。
      const outcome = await agentClient.send(trimmed, {
        streamingBehavior: get().running ? "steer" : undefined,
      });
      if (outcome === "handled") {
        // 命令跑完了（没跑模型）：收工，并撕掉乐观插入的那条命令行。
        // 注意不能盲清 running：模型正在跑时插一条扩展命令，那条运行不归本次发送管。
        set((s) => ({
          running: ownsRun || !alreadyRunning ? false : s.running,
          commandRunning: false,
          live: ownsRun ? [] : s.live,
          messages: s.messages.filter((m) => !(m.role === "user" && m.timestamp === stamp)),
        }));
      } else if (isCommand) {
        // 命令缓存过期（命令已删/改名）：pi 当普通输入跑了模型，补回消息与状态。
        set((s) => ({
          commandRunning: false,
          running: true,
          messages: [...s.messages, userMessage(trimmed, stamp)],
        }));
      }
    } catch (e) {
      set((s) => ({
        running: false,
        commandRunning: false,
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
    // 契约（REQ-344 ②）：宿主 newSession 直接返回新会话文件，登记不再依赖事后猜时序。
    const info = await agentClient.newSession();
    const state = await agentClient.state();
    set(hydrate(state));
    const file = info.sessionFile ?? state.sessionFile;
    if (file) await get().registerSessionFile(file);
  },

  async switchSession(path) {
    set({ ...EMPTY, running: false, compacting: false });
    await agentClient.switchSession(path);
    const state = await agentClient.state();
    set(hydrate(state));
  },

  async loadEarlier() {
    const { hasOlder, loadingOlder } = get();
    if (!hasOlder || loadingOlder) return;
    set({ loadingOlder: true });
    try {
      const fromEnd = get().olderMessages.length + get().messages.length;
      const res = await agentClient.earlierMessages(fromEnd, SESSION_MESSAGES_PAGE);
      set((s) => ({ olderMessages: [...res.messages, ...s.olderMessages], hasOlder: res.hasMore }));
    } catch (e) {
      set((s) => ({ messages: [...s.messages, notice(errText(e), "error")] }));
    } finally {
      set({ loadingOlder: false });
    }
  },

  /**
   * Agent 重启后（改 extensions、空分组首次新建等）恢复现场。
   * 只做「新建会话」：切分组已改为不重启（pi 会跟随会话自己的 cwd）。
   */
  async restoreAfterRestart() {
    // 重启后的恢复有重试退避，慢时十几秒：期间挂进度提示（REQ-344 ④）。
    set({ sessionBusy: "resume" });
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await get().newSession();
          await get().registerCurrentSession();
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
        }
      }
    } finally {
      set({ sessionBusy: null });
    }
  },

  async refreshSession() {
    // 只 hydrate，不清空：调用方已经按需重置（sessionReplaced 分支）。
    try {
      const next = hydrate(await agentClient.state());
      // 会话替换前后产生的界面提示再贴回底部，否则刚弹出的「已恢复/已切换」看不到。
      const keepFrom = Date.now() - NOTICE_KEEP_MS;
      const notices = get().messages.filter((m) => m.role === "notice" && m.timestamp >= keepFrom);
      set({ ...next, messages: [...(next.messages ?? []), ...notices] });
    } catch (e) {
      set((s) => ({ messages: [...s.messages, notice(errText(e), "error")] }));
    }
  },

  async refreshStats() {
    try {
      set({ stats: await agentClient.stats() });
    } catch {
      // stats 失败不影响主流程（例如会话还没落盘）。
    }
  },

  async setMode(mode) {
    set(enterMode(mode));
    await windowClient.switchMode(mode).catch(() => undefined);
  },

  applyHostMode(mode) {
    set(enterMode(mode));
  },

  async setCompactSidebarOpen(open) {
    set({ compactSidebarOpen: open });
    await resizeCompactWindow(get());
  },

  async setCompactCommandPopupHeight(height) {
    const next = Math.max(0, Math.round(height));
    if (get().compactCommandPopupHeight === next) return;
    set({ compactCommandPopupHeight: next });
    await resizeCompactWindow(get());
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
          // 空串不是有效作答（点选选项才有值）；兜底到第一个选项，避免扩展拿到 "" 后静默退出。
          await agentClient.respondExtensionUi({
            kind: "select",
            id: req.id,
            value: value || req.options[0] || "",
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

  pushNotice(text) {
    set((s) => ({ messages: [...s.messages, notice(text, "info")] }));
  },

  async createSessionInActiveGroup() {
    try {
      const cfg = await configClient.get();
      const st = ensureGroups(
        { groups: cfg.groups, activeGroupId: cfg.activeGroupId, openSessions: cfg.openSessions },
        cfg.cwd,
      );
      const group = st.groups.find((g) => g.id === st.activeGroupId);
      const opened = group ? (st.openSessions[group.id] ?? []) : [];
      if (group && opened.length === 0 && group.path !== cfg.cwd) {
        // pi 的 newSession 用当前 runtime cwd，所以空分组首次新建必须以该目录启动。
        set({ sessionBusy: "restart" });
        try {
          await get().saveConfig({
            ...cfg,
            groups: st.groups,
            activeGroupId: st.activeGroupId,
            openSessions: st.openSessions,
            cwd: group.path,
          });
        } catch (e) {
          set({ sessionBusy: null });
          throw e;
        }
        // saveConfig 返回后 Agent 异步重启，reset→restoreAfterRestart 接手置 "resume" 并清空。
        // reset 事件万一丢了提示会挂死：看门犬兆底清空（测试环境无 window，直接清）。
        if (typeof window !== "undefined") {
          window.setTimeout(() => {
            if (get().sessionBusy === "restart") set({ sessionBusy: null });
          }, 20_000);
        } else {
          set({ sessionBusy: null });
        }
        return; // 重启后 restoreAfterRestart 会新建 + 登记
      }
      await get().newSession();
      await get().registerCurrentSession();
    } catch (e) {
      set((s) => ({ messages: [...s.messages, notice(errText(e), "error")], sessionBusy: null }));
    }
  },

  async registerCurrentSession() {
    const file = get().sessionFile ?? (await agentClient.state().catch(() => null))?.sessionFile;
    if (file) await get().registerSessionFile(file);
  },

  async registerSessionFile(file) {
    try {
      const cfg = await configClient.get();
      const st = ensureGroups(
        { groups: cfg.groups, activeGroupId: cfg.activeGroupId, openSessions: cfg.openSessions },
        cfg.cwd,
      );
      const group = st.groups.find((g) => g.id === st.activeGroupId);
      if (!group) return;
      if ((st.openSessions[group.id] ?? []).includes(file)) return;
      const next = openSession(st, group.id, file);
      await get().saveConfig({
        ...cfg,
        groups: next.groups,
        activeGroupId: next.activeGroupId,
        openSessions: next.openSessions,
      });
    } catch {
      // 登记失败不影响当前对话；下次新建/切换会再登记。
    }
  },

  async reloadConfig() {
    set({ config: await configClient.get() });
  },

  async saveConfig(cfg) {
    await configClient.set(cfg);
    set({ config: cfg });
    // 保存已经生效。改 cwd / extensions 会让主进程重启 Agent，重启期间取状态会抛
    // 「Agent 子进程已停止」——这里绝不能让它冒泡：否则调用方（切分组、关会话）
    // 看起来失败且会把旧 config 写回去。恢复现场交给 reset → restoreAfterRestart。
    try {
      set(hydrate(await agentClient.state()));
    } catch {
      // Agent 正在重启，等它起来后由 onReset 恢复。
    }
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

/**
 * 悬浮窗只有 132px 高，叠在它上面的列表（会话侧边栏、斜杠命令联想）都需要把窗口临时加高。
 * 取两者各自所需高度的较大值；都不需要时恢复配置高度。
 */
async function resizeCompactWindow(state: AgentStore): Promise<void> {
  const base = state.config?.compactHeight;
  if (!base) return;
  const wanted = Math.max(
    state.compactSidebarOpen ? COMPACT_SIDEBAR_WINDOW_HEIGHT : base,
    base + state.compactCommandPopupHeight,
  );
  await windowClient.resize({ height: wanted }).catch(() => undefined);
}

/** 进入某形态时的状态变更。切到悬浮窗必须收起侧边栏：宿主会按 config 复位窗口高度。 */
function enterMode(mode: WindowMode): Partial<AgentStore> {
  return { mode, ...(mode === "compact" ? { compactSidebarOpen: false } : {}) };
}

function hydrate(state: SessionState): Partial<AgentStore> {
  return {
    sessionId: state.sessionId,
    sessionFile: state.sessionFile,
    sessionName: state.sessionName,
    cwd: state.cwd,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    messages: state.messages,
    // 会话切换/刷新后翻页状态重置（REQ-346）：新页从 state 带来的最近一页重新算。
    olderMessages: [],
    hasOlder: state.messagesTotal > state.messages.length,
    loadingOlder: false,
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

/** 扩展产出的界面提示（notice）在会话重置后仍保留这么久。 */
const NOTICE_KEEP_MS = 15_000;

function notice(text: string, level: "error" | "info" = "info"): ChatMessage {
  return { role: "notice", text, timestamp: Date.now(), ...(level === "error" ? { level } : {}) };
}

function userMessage(text: string, timestamp: number): ChatMessage {
  return { role: "user", text, images: 0, timestamp };
}

/**
 * 这条斜杠输入是不是「扩展命令」——与 pi 侧 prompt() 的判定同源：只有扩展命令会被
 * 直接执行、不跑模型。命令列表取不到时按普通输入处理（宁多跑一次，不吞用户输入）。
 */
async function isExtensionCommandInput(trimmed: string): Promise<boolean> {
  const token = trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
  if (!token) return false;
  const commands = await cachedCommands();
  return commands.some((command) => command.name === token && command.source === "extension");
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
