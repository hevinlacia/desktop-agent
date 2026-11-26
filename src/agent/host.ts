/**
 * Agent 子进程的宿主：直接调用 pi 官方 SDK，把会话事件归一化后发给主进程。
 *
 * 结构参照 pi 自带的 RPC 模式：
 * - `AgentSessionRuntime` 负责新建 / 切换会话；每次替换后必须重新订阅事件并重新绑定扩展。
 * - 扩展的 UI 请求（确认、选择、输入、通知）通过 `ExtensionUIContext` 转发给主进程，
 *   等渲染进程作答后再 resolve，扩展代码本身无感知。
 */
import fs from "node:fs";
import type * as Pi from "@earendil-works/pi-coding-agent";
import type { AgentSession, CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import type {
  AgentEvent,
  AgentEventBody,
  ChatMessage,
  ExtensionUiRequestBody,
  ExtensionUiResponse,
  PromptOutcome,
  SessionState,
  SessionStats,
  SessionSummary,
} from "@shared/protocol";
import type { AgentInitOptions, AgentRequest, LogLevel } from "@shared/agentIpc";
import { mapSessionEvent, toChatMessage, toModelInfo, toSessionSummary } from "./mapping";

type ExtensionBindings = Parameters<AgentSession["bindExtensions"]>[0];
type ExtensionUIContext = NonNullable<ExtensionBindings["uiContext"]>;
type DialogOptions = { signal?: AbortSignal; timeout?: number };
type ThinkingLevel = Parameters<AgentSession["setThinkingLevel"]>[0];

interface PendingDialog {
  kind: ExtensionUiRequestBody["kind"];
  settle: (response: ExtensionUiResponse | "timeout") => void;
}

export class AgentHost {
  private constructor(
    private readonly pi: typeof Pi,
    private readonly options: AgentInitOptions,
    private readonly send: (message: AgentToMainLike) => void,
  ) {}

  static async create(
    pi: typeof Pi,
    options: AgentInitOptions,
    send: (message: AgentToMainLike) => void,
  ): Promise<AgentHost> {
    const host = new AgentHost(pi, options, send);
    await host.start();
    return host;
  }

  private readonly pendingDialogs = new Map<string, PendingDialog>();
  private dialogSeq = 0;
  private runtime!: InstanceType<typeof Pi.AgentSessionRuntime>;
  private session!: AgentSession;
  private unsubscribe: (() => void) | undefined;

  // ---- 生命周期 ---------------------------------------------------------

  private async start() {
    const { pi, options } = this;
    const cwd = options.cwd;
    const agentDir = pi.getAgentDir();
    // 不持久化时用内存会话：关闭应用即丢弃，不在 pi 的会话目录留文件。
    const sessionManager = options.persistSession
      ? pi.SessionManager.create(cwd)
      : pi.SessionManager.inMemory(cwd);

    const createRuntime: CreateAgentSessionRuntimeFactory = async (target) => {
      const settingsManager = pi.SettingsManager.create(target.cwd, target.agentDir);
      const services = await pi.createAgentSessionServices({
        cwd: target.cwd,
        agentDir: target.agentDir,
        settingsManager,
        modelRuntimeSignal: AbortSignal.timeout(15_000),
        resourceLoaderOptions: {
          // 没有终端可显示安装输出，交给 pi 自己捕获。
          packageCommandOutput: "capture",
          noExtensions: !options.extensions,
          // CLI 默认带的三类内置扩展，SDK 会话默认不带；补齐以保持和命令行一致。
          extensionFactories: [
            pi.createCodemodeExtension(),
            pi.createToolSearchExtension(),
            pi.createMcpExtension(),
          ],
        },
      });
      const created = await pi.createAgentSessionFromServices({
        services,
        sessionManager: target.sessionManager,
        sessionStartEvent: target.sessionStartEvent,
      });
      return { ...created, services, diagnostics: [] };
    };

    this.runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
    this.runtime.setRebindSession(() => this.rebind());
    await this.rebind();
  }

  /** 会话被替换（新建 / 切换）后调用：旧订阅全部作废。 */
  private async rebind() {
    this.session = this.runtime.session;
    this.unsubscribe?.();
    // 先订阅再绑定扩展：session_start 处理器里产生的事件也要能送达。
    this.unsubscribe = this.session.subscribe((event) => {
      for (const mapped of mapSessionEvent(event, this.session.sessionId)) {
        this.send({ kind: "event", event: mapped });
      }
    });

    await this.session.bindExtensions({
      uiContext: this.createUiContext(),
      // 与 pi 的 RPC 模式相同：告诉扩展「没有 TUI」。
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => this.session.waitForIdle(),
        newSession: (opts) => this.runtime.newSession(opts),
        fork: async (entryId, forkOptions) => {
          const result = await this.runtime.fork(entryId, forkOptions);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, opts) => {
          const result = await this.session.navigateTree(targetId, opts);
          return { cancelled: result.cancelled };
        },
        switchSession: (sessionPath, opts) => this.runtime.switchSession(sessionPath, opts),
        reload: () => this.session.reload(),
      },
      onError: (err) => this.emitError(`扩展错误：${err.error}`),
    });

    for (const d of this.runtime.takeUnreportedDiagnostics()) this.log(diagnosticLevel(d.type), d.message);
  }

  async shutdown() {
    // dispose 会等凭据写入完成，避免 OAuth 刷新令牌丢失。
    await this.runtime.dispose();
  }

  // ---- 命令 -------------------------------------------------------------

  async handle(req: AgentRequest): Promise<unknown> {
    switch (req.cmd) {
      case "state":
        return this.state();
      case "prompt":
        return this.prompt(req.text, req.streamingBehavior);
      case "abort":
        await this.session.abort();
        return null;
      case "newSession": {
        const result = await this.runtime.newSession();
        if (result.cancelled) throw new Error("新会话被扩展取消");
        return null;
      }
      case "switchSession": {
        const result = await this.runtime.switchSession(req.sessionPath);
        if (result.cancelled) throw new Error("切换会话被扩展取消");
        return null;
      }
      case "sessions":
        return this.sessions();
      case "stats":
        return this.stats();
      case "setModel": {
        const model = this.session.modelRuntime.getModel(req.provider, req.modelId);
        if (!model) {
          throw new Error(`找不到模型 ${req.provider}/${req.modelId}，请确认 pi 里已配置该 provider`);
        }
        await this.session.setModel(model);
        return null;
      }
      case "setThinkingLevel":
        this.session.setThinkingLevel(req.level as ThinkingLevel);
        return null;
      case "extensionUiResponse":
        this.resolveDialog(req.response);
        return null;
      case "init":
      case "shutdown":
        throw new Error(`${req.cmd} 不应到达这里`);
      default:
        return null;
    }
  }

  private state(): SessionState {
    const s = this.session;
    return {
      sessionId: s.sessionId || null,
      sessionFile: s.sessionFile ?? null,
      sessionName: s.sessionName ?? null,
      cwd: this.runtime.cwd,
      model: toModelInfo(s.model),
      thinkingLevel: s.thinkingLevel,
      isStreaming: s.isStreaming,
      isCompacting: s.isCompacting,
      messages: s.messages.map(toChatMessage).filter((m): m is ChatMessage => m !== null),
    };
  }

  /**
   * `prompt()` 在整轮运行结束后才 resolve，所以用 `preflightResult` 尽早拿到受理结果：
   * started = 已开跑；queued = 排队（steer / followUp）；handled = 被扩展命令直接处理。
   */
  private prompt(text: string, streamingBehavior?: "steer" | "followUp"): Promise<PromptOutcome> {
    return new Promise<PromptOutcome>((resolve) => {
      let done = false;
      const settle = (outcome: PromptOutcome) => {
        if (!done) {
          done = true;
          resolve(outcome);
        }
      };
      this.session
        .prompt(text, { streamingBehavior, preflightResult: (disposition) => settle(disposition) })
        .then(
          () => settle("started"),
          (err: unknown) => {
            this.emitError(errorMessage(err));
            settle("handled");
          },
        );
    });
  }

  private async sessions(): Promise<SessionSummary[]> {
    const list = await this.pi.SessionManager.list(this.runtime.cwd);
    return list
      .map((info) => toSessionSummary(info, fileSize(info.path)))
      .sort((a, b) => b.modifiedMs - a.modifiedMs);
  }

  private stats(): SessionStats {
    const s = this.session.getSessionStats();
    return {
      userMessages: s.userMessages,
      assistantMessages: s.assistantMessages,
      toolCalls: s.toolCalls,
      totalMessages: s.totalMessages,
      tokens: {
        input: s.tokens.input,
        output: s.tokens.output,
        cacheRead: s.tokens.cacheRead,
        cacheWrite: s.tokens.cacheWrite,
        totalTokens: s.tokens.total,
        costTotal: s.cost,
      },
      contextUsage: s.contextUsage && {
        tokens: s.contextUsage.tokens,
        contextWindow: s.contextUsage.contextWindow,
        percent: s.contextUsage.percent,
      },
    };
  }

  // ---- 扩展 UI ----------------------------------------------------------

  private createUiContext(): ExtensionUIContext {
    const select = (title: string, options: string[], opts?: DialogOptions) =>
      this.ask({ kind: "select", title, options, timeout: opts?.timeout }, opts, (r) =>
        r?.kind === "select" ? r.value : undefined,
      );
    const confirm = (title: string, message: string, opts?: DialogOptions) =>
      this.ask({ kind: "confirm", title, message, timeout: opts?.timeout }, opts, (r) =>
        r?.kind === "confirm" ? r.confirmed : false,
      );
    const input = (title: string, placeholder?: string, opts?: DialogOptions) =>
      this.ask({ kind: "input", title, placeholder }, opts, (r) =>
        r?.kind === "input" ? r.value : undefined,
      );
    const editor = (title: string, prefill?: string, opts?: DialogOptions) =>
      this.ask({ kind: "editor", title, prefill }, opts, (r) =>
        r?.kind === "editor" ? r.value : undefined,
      );
    const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
      this.emit({ type: "extensionUi", request: { kind: "notify", id: "", message, level } });
    };

    const base = {
      select,
      confirm,
      input,
      editor,
      notify,
      onTerminalInput: () => () => undefined,
      theme: { fg: "#cccccc", bg: "#111111" },
    };

    // 其余是 TUI 专用能力（状态栏、组件、主题切换……），对桌面宿主没有意义，一律空实现，
    // 与 pi 的 RPC 模式一致。必须逐个显式列出：pi 把 UI 上下文交给扩展时会拷贝方法，
    // 用 Proxy 兜底「未知属性返回空函数」是无效的。
    const noop = () => undefined;
    return {
      ...base,
      onTerminalInput: () => noop,
      setStatus: noop,
      setWorkingMessage: noop,
      setWorkingVisible: noop,
      setWorkingIndicator: noop,
      setHiddenThinkingLabel: noop,
      setWidget: noop,
      setFooter: noop,
      setHeader: noop,
      setTitle: noop,
      custom: async () => {
        throw new Error("扩展的自定义界面组件（ctx.ui.custom）在桌面端不受支持");
      },
      pasteToEditor: noop,
      setEditorText: noop,
      getEditorText: () => "",
      addAutocompleteProvider: noop,
      setEditorComponent: noop,
      getEditorComponent: () => undefined,
      theme: new Proxy({}, { get: () => "#999999" }),
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "桌面宿主不支持切换主题" }),
      getToolsExpanded: () => false,
      setToolsExpanded: noop,
    } as unknown as ExtensionUIContext;
  }

  /** 发起一次对话框请求，等渲染进程作答；超时或 abort 时按默认值结算。 */
  private ask<T>(
    request: ExtensionUiRequestBody,
    opts: DialogOptions | undefined,
    pick: (response: ExtensionUiResponse | undefined) => T,
  ): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(pick(undefined));
    const id = `ui-${++this.dialogSeq}`;
    return new Promise<T>((resolve) => {
      const finish = (response: ExtensionUiResponse | "timeout") => {
        opts?.signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
        this.pendingDialogs.delete(id);
        resolve(pick(response === "timeout" ? undefined : response));
      };
      const onAbort = () => finish("timeout");
      const timer = opts?.timeout ? setTimeout(() => finish("timeout"), opts.timeout) : undefined;
      this.pendingDialogs.set(id, { kind: request.kind, settle: finish });
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      this.emit({ type: "extensionUi", request: { ...request, id } });
    });
  }

  private resolveDialog(response: ExtensionUiResponse) {
    this.pendingDialogs.get(response.id)?.settle(response);
  }

  // ---- 工具 -------------------------------------------------------------

  private emit(event: AgentEventBody) {
    this.send({ kind: "event", event: { ...event, sessionId: this.session.sessionId } as AgentEvent });
  }

  private emitError(message: string) {
    this.emit({ type: "error", message });
  }

  private log(level: LogLevel, message: string) {
    this.send({ kind: "log", level, message });
  }
}

type AgentToMainLike =
  | { kind: "event"; event: AgentEvent }
  | { kind: "log"; level: LogLevel; message: string };

function diagnosticLevel(type: "info" | "warning" | "error"): LogLevel {
  return type === "warning" ? "warn" : type;
}

function fileSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
