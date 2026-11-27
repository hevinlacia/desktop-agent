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
import type { AgentSession, AgentSessionRuntime, CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import type {
  AgentEvent,
  AgentEventBody,
  ChatMessage,
  ExtensionUiRequestBody,
  ExtensionUiResponse,
  ModelInfo,
  ModelRef,
  PromptOutcome,
  SessionState,
  SessionStats,
  SessionSummary,
  SlashCommand,
} from "@shared/protocol";
import type { AgentInitOptions, AgentRequest, LogLevel } from "@shared/agentIpc";
import type { EarlierMessagesResult } from "@shared/protocol";
import { mapSessionEvent, toChatMessage, toModelInfo, toSessionSummary } from "./mapping";
import { createPlainTheme } from "./plain-theme";
import { clampPoolSize, pageSlice, pickEvict, pickIdle, type PoolEntryState } from "./sessionPool";
import { scanGroupSessionDirs } from "./sessionScan";
import { SESSION_MESSAGES_PAGE } from "@shared/protocol";

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
  /** 上个会话使用的模型：新建会话时沿用。启动时取自配置，之后跟随用户的操作。 */
  private lastModel: ModelRef | null = null;
  private dialogSeq = 0;
  private runtime!: InstanceType<typeof Pi.AgentSessionRuntime>;
  private session!: AgentSession;

  // ---- 会话常驻池（REQ-346） ---------------------------------------------
  /** sessionFile → 常驻运行时。最近用过的会话各持一个完整 runtime，池内切换≈0 成本。 */
  private readonly pool = new Map<string, { runtime: AgentSessionRuntime; lastUsedAt: number }>();
  /** 当前接线的会话文件（池 key；内存会话为 null）。 */
  private currentFile: string | null = null;
  private poolSize = clampPoolSize(Number.NaN);
  private idleSuspendMs = 0;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private agentDir = "";

  /** 运行时工厂：start 与池内冷加载共用（原来内联在 start 里）。 */
  private readonly createRuntime: CreateAgentSessionRuntimeFactory = async (target) => {
    const settingsManager = this.pi.SettingsManager.create(target.cwd, target.agentDir);
    const services = await this.pi.createAgentSessionServices({
      cwd: target.cwd,
      agentDir: target.agentDir,
      settingsManager,
      modelRuntimeSignal: AbortSignal.timeout(15_000),
      resourceLoaderOptions: {
        // 没有终端可显示安装输出，交给 pi 自己捕获。
        packageCommandOutput: "capture",
        noExtensions: !this.options.extensions,
        // CLI 默认带的三类内置扩展，SDK 会话默认不带；补齐以保持和命令行一致。
        extensionFactories: [
          this.pi.createCodemodeExtension(),
          this.pi.createToolSearchExtension(),
          this.pi.createMcpExtension(),
        ],
      },
    });
    const created = await this.pi.createAgentSessionFromServices({
      services,
      sessionManager: target.sessionManager,
      sessionStartEvent: target.sessionStartEvent,
    });
    return { ...created, services, diagnostics: [] };
  };
  private unsubscribe: (() => void) | undefined;
  /** 上一次 rebind 时的会话 id：用来发现「不经过渲染进程的会话替换」（如扩展调 ctx.switchSession）。 */
  private lastSessionId: string | null = null;

  // ---- 生命周期 ---------------------------------------------------------

  private async start() {
    const { pi, options } = this;
    const cwd = options.cwd;
    const agentDir = pi.getAgentDir();
    this.agentDir = agentDir;
    this.poolSize = clampPoolSize(options.sessionPoolSize);
    this.idleSuspendMs = Math.max(0, Math.floor(options.sessionIdleSuspendMs) || 0);
    // 不持久化时用内存会话：关闭应用即丢弃，不在 pi 的会话目录留文件。
    const sessionManager = options.persistSession
      ? pi.SessionManager.create(cwd)
      : pi.SessionManager.inMemory(cwd);

    this.runtime = await pi.createAgentSessionRuntime(this.createRuntime, { cwd, agentDir, sessionManager });
    this.runtime.setRebindSession(() => this.rebind());
    await this.rebind();
    // 启动时的会话沿用上个会话使用的模型；没记过（或已不可用）就是 pi 的默认模型。
    await this.applyLastModel(this.options.lastModel);
    this.lastModel = refOf(this.session.model);

    // 闲置挂起扫描（REQ-346）：一分钟一次，把超时未用的池内会话 dispose 掉。
    this.idleTimer = setInterval(() => this.suspendIdle(), 60_000);
    this.idleTimer.unref?.();
  }

  /**
   * 会话被替换（新建 / 切换）后调用：旧订阅全部作废。
   * 这里只负责「当前 runtime 内部换了 session 对象」的池同步（重新入池 + 驱逐），接线在 wire 里。
   */
  private async rebind() {
    const rt = this.runtime;
    const file = rt.session.sessionFile ?? null;
    if (this.currentFile && this.currentFile !== file) {
      const prev = this.pool.get(this.currentFile);
      // runtime 内部替换（新建/扩展切换/fork）：旧 session 对象已被 pi 销毁，池 key 跟着 runtime 挪到新文件。
      if (prev?.runtime === rt) this.pool.delete(this.currentFile);
    }
    if (file) {
      this.pool.set(file, { runtime: rt, lastUsedAt: Date.now() });
      this.evictIfNeeded();
    }
    this.currentFile = file;
    await this.wire(rt, { bind: true });
  }

  /**
   * 把某个池内运行时接线为「当前会话」：重接事件订阅，必要时绑定扩展。
   * bind=true 用于刚创建/刚被 runtime 内部替换的新 session 对象（老 rebind 语义）；
   * 池内命中复用已绑定的 session 对象，**不重绑**（重绑会重复投递扩展事件/重复注册命令）。
   */
  private async wire(rt: AgentSessionRuntime, opts?: { bind?: boolean }) {
    this.session = rt.session;
    this.runtime = rt;

    // 先订阅再绑定扩展：session_start 处理器里产生的事件也要能送达；换接前先退订旧会话。
    this.unsubscribe?.();
    this.unsubscribe = this.session.subscribe((event) => {
      for (const mapped of mapSessionEvent(event, this.session.sessionId)) {
        this.send({ kind: "event", event: mapped });
      }
    });

    // 扩展发起的切换（如 /resume-session 调 ctx.switchSession）不经过渲染进程，
    // 渲染层不知道会话换了；不同步的话它会把新会话的事件全当成过期事件丢掉，
    // 界面看起来就死了。这里主动广播一条 sessionReplaced 让渲染层重新 hydrate。
    const previousSessionId = this.lastSessionId;
    this.lastSessionId = this.session.sessionId;
    if (previousSessionId && previousSessionId !== this.session.sessionId) {
      this.emit({ type: "sessionReplaced", previousSessionId });
    }

    if (!opts?.bind) return;
    // 先订阅再绑定扩展：session_start 处理器里产生的事件也要能送达。
    await this.session.bindExtensions({
      uiContext: this.createUiContext(),
      // 与 pi 的 RPC 模式相同：告诉扩展「没有 TUI」。
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => this.session.waitForIdle(),
        newSession: (opts) => this.newSession(opts),
        fork: async (entryId, forkOptions) => {
          const result = await this.runtime.fork(entryId, forkOptions);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, opts) => {
          const result = await this.session.navigateTree(targetId, opts);
          return { cancelled: result.cancelled };
        },
        switchSession: (sessionPath) => this.poolSwitch(sessionPath),
        reload: () => this.session.reload(),
      },
      onError: (err) => this.emitError(`扩展错误：${err.error}`),
    });

    for (const d of this.runtime.takeUnreportedDiagnostics()) this.log(diagnosticLevel(d.type), d.message);
  }

  // ---- 会话常驻池（REQ-346） ---------------------------------------------

  /**
   * 切换会话：池内命中直接换接（≈0 成本，旧会话不销毁——这就是「常驻」）；
   * 未命中冷加载一个独立 runtime 入池再激活（与旧 runtime.switchSession 同价）。
   * 与 pi 的 runtime.switchSession 的差异：池内命中不触发扩展 before-switch 钩子（桌面端没有用它）；
   * 旧会话不 teardown，由闲置挂起/驱逐回收。
   */
  private async poolSwitch(sessionPath: string, opts?: { cwdOverride?: string }): Promise<{ cancelled: boolean }> {
    const hit = this.pool.get(sessionPath);
    if (hit && !opts?.cwdOverride) {
      const t0 = Date.now();
      hit.lastUsedAt = t0;
      // session 对象没换（不重绑扩展），但 sessionId 变了要让渲染层重新 hydrate。
      await this.wire(hit.runtime);
      // 切到的会话自带模型，不覆盖；它成为之后新建会话时沿用的「上个会话使用的模型」。
      this.lastModel = refOf(this.session.model);
      this.log("info", `池内命中切换：${sessionPath}（${Date.now() - t0}ms，池 ${this.pool.size}/${this.poolSize}）`);
      return { cancelled: false };
    }
    const sm = this.pi.SessionManager.open(sessionPath, undefined, opts?.cwdOverride);
    const coldT0 = Date.now();
    const rt = await this.pi.createAgentSessionRuntime(this.createRuntime, {
      cwd: sm.getCwd(),
      agentDir: this.agentDir,
      sessionManager: sm,
      sessionStartEvent: { type: "session_start", reason: "resume" },
    });
    rt.setRebindSession(() => {
      // 只有「当前」运行时的内部替换（扩展发起新建/切换/fork）才需要重绑与池同步。
      if (rt !== this.runtime) return Promise.resolve();
      return this.rebind();
    });
    this.pool.set(sessionPath, { runtime: rt, lastUsedAt: Date.now() });
    this.evictIfNeeded();
    await this.wire(rt, { bind: true });
    this.lastModel = refOf(this.session.model);
    this.log("info", `冷加载会话入池：${sessionPath}（${Date.now() - coldT0}ms，池 ${this.pool.size}/${this.poolSize}）`);
    return { cancelled: false };
  }

  private evictIfNeeded() {
    while (this.pool.size > this.poolSize) {
      const victim = pickEvict(poolStates(this.pool), this.currentFile);
      if (!victim) return; // 全忙或只剩当前：允许暂时超员，忙会话不能杀
      this.pool.delete(victim);
      void this.disposeRuntime(victim, "evict");
    }
  }

  private suspendIdle() {
    for (const key of pickIdle(poolStates(this.pool), this.currentFile, Date.now(), this.idleSuspendMs)) {
      this.pool.delete(key);
      void this.disposeRuntime(key, "idle");
    }
  }

  private async disposeRuntime(key: string, reason: "evict" | "idle") {
    const hit = this.pool.get(key);
    try {
      if (hit) {
        this.log("info", `挂起会话（${reason}）：${key}`);
        await hit.runtime.dispose();
      }
    } catch (err) {
      this.log("warn", `挂起会话失败（忽略）：${errorMessage(err)}`);
    }
  }

  async shutdown() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    // dispose 会等凭据写入完成，避免 OAuth 刷新令牌丢失；池内所有运行时 + 当前（含内存会话）都收尾。
    const runtimes = new Set<AgentSessionRuntime>([this.runtime]);
    for (const p of this.pool.values()) runtimes.add(p.runtime);
    this.pool.clear();
    for (const rt of runtimes) {
      try {
        await rt.dispose();
      } catch (err) {
        this.log("warn", `会话收尾失败（忽略）：${errorMessage(err)}`);
      }
    }
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
        const result = await this.newSession();
        if (result.cancelled) throw new Error("新会话被扩展取消");
        // 契约（REQ-344 ②）：直接回新会话文件，登记不靠事后扫盘/猜时序。
        return { sessionFile: this.session.sessionFile ?? null };
      }
      case "switchSession": {
        const result = await this.poolSwitch(req.sessionPath);
        if (result.cancelled) throw new Error("切换会话被扩展取消");
        return null;
      }
      case "setPoolConfig": {
        this.poolSize = clampPoolSize(req.poolSize);
        this.idleSuspendMs = Math.max(0, Math.floor(req.idleSuspendMs) || 0);
        // 立即按新阈值收敛一次（调小池/调短挂起时不用等下一个扫描周期）。
        this.evictIfNeeded();
        this.suspendIdle();
        return null;
      }
      case "earlierMessages":
        return this.earlierMessages(req.fromEnd, req.count);
      case "sessions":
        return this.sessions();
      case "sessionsAll":
        this.lastSessionsAllCwds = req.cwds;
        return await this.sessionsAll(req.cwds);
      case "commands":
        return this.commands();
      case "models":
        return this.models();
      case "stats":
        return this.stats();
      case "setModel": {
        const model = this.session.modelRuntime.getModel(req.provider, req.modelId);
        if (!model) {
          throw new Error(`找不到模型 ${req.provider}/${req.modelId}，请确认 pi 里已配置该 provider`);
        }
        await this.session.setModel(model);
        this.lastModel = { provider: req.provider, id: req.modelId };
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
    const mapped = this.mappedMessages();
    return {
      sessionId: s.sessionId || null,
      sessionFile: s.sessionFile ?? null,
      sessionName: s.sessionName ?? null,
      cwd: this.runtime.cwd,
      model: toModelInfo(s.model),
      thinkingLevel: s.thinkingLevel,
      isStreaming: s.isStreaming,
      isCompacting: s.isCompacting,
      // 只带最近一页（REQ-346）：大会话全量过 IPC + 全量渲染是切换卡顿的另一半根因。
      messages: mapped.slice(-SESSION_MESSAGES_PAGE),
      messagesTotal: mapped.length,
    };
  }

  private mappedMessages(): ChatMessage[] {
    return this.session.messages.map(toChatMessage).filter((m): m is ChatMessage => m !== null);
  }

  /** 往前翻页拿更早的消息（MessageList 顶部「加载更早」）。 */
  private earlierMessages(fromEnd: number, count: number): EarlierMessagesResult {
    const mapped = this.mappedMessages();
    const page = pageSlice(mapped, fromEnd, count);
    return { messages: page.items, hasMore: page.hasMore, total: mapped.length };
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

  /** 跨所有工作目录的会话：历史会话分组不绑定 cwd，所以要看全局。 */
  // ---- 会话列表缓存（REQ-346 修复轮二） -----------------------------------
  // 实测：pi 的 listAll 对每个文件全量逐行 parse，1929 个文件几百 MB 时单次 12-16s，
  // 且 agent 命令队列串行，会把下一次 switchSession 堵在后面（表现为「点切换没反应」）。
  // 策略（性能优化 + 按需加载双层）：
  // ① 扫描本身换成 sessionScan 的头部读取（每文件只读 64KB，分组合计亚秒级）；
  // ② stale-while-revalidate：缓存新鲜直接回；过期立即回旧值并后台单航刷新；
  // ③ 渲染层只在历史面板可见时才调（懒加载），切换/新建零调用。
  private static readonly SESSIONS_CACHE_TTL_MS = 300_000;
  private sessionsAllCache: { key: string; at: number; list: SessionSummary[] } | null = null;
  private sessionsAllRefreshing = false;
  /** 最近一次 sessionsAll 的分组目录：新建会话失效后用它后台重扫。 */
  private lastSessionsAllCwds: string[] | null = null;

  private async sessionsAll(cwds: string[]): Promise<SessionSummary[]> {
    const t0 = Date.now();
    const key = [...new Set(cwds)].sort().join("|");
    const cached = this.sessionsAllCache;
    if (cached && cached.key === key && Date.now() - cached.at < AgentHost.SESSIONS_CACHE_TTL_MS) {
      return cached.list;
    }
    if (cached && cached.key === key) {
      // 缓存过期：旧值立即回（低优先级视图），后台刷新，不堵命令队列。
      this.refreshSessionsAllInBackground(cwds);
      return cached.list;
    }
    // 首次（或分组集合变化）：阻塞扫一次——分组口径下只读头部，很快。
    const list = await scanGroupSessionDirs(this.agentDir, cwds);
    this.sessionsAllCache = { key, at: Date.now(), list };
    this.log("info", `分组会话列表已扫描：${list.length} 条（${Date.now() - t0}ms）`);
    return list;
  }

  private refreshSessionsAllInBackground(cwds: string[]) {
    if (this.sessionsAllRefreshing) return;
    this.sessionsAllRefreshing = true;
    const t0 = Date.now();
    void (async () => {
      try {
        const list = await scanGroupSessionDirs(this.agentDir, cwds);
        this.sessionsAllCache = { key: [...new Set(cwds)].sort().join("|"), at: Date.now(), list };
        this.log("info", `分组会话列表已后台刷新：${list.length} 条（${Date.now() - t0}ms）`);
      } catch (err) {
        this.log("warn", `刷新分组会话列表失败（保留旧值）：${errorMessage(err)}`);
      } finally {
        this.sessionsAllRefreshing = false;
      }
    })();
  }

  private async sessions(): Promise<SessionSummary[]> {
    const list = await this.pi.SessionManager.list(this.runtime.cwd);
    return list
      .map((info) => toSessionSummary(info, fileSize(info.path)))
      .sort((a, b) => b.modifiedMs - a.modifiedMs);
  }

  /** 新会话落盘后调用：列表缓存失效并后台重扫，让新会话尽快出现在名字表/历史里。 */
  private invalidateSessionsCache() {
    this.sessionsAllCache = null;
    if (this.lastSessionsAllCwds) this.refreshSessionsAllInBackground(this.lastSessionsAllCwds);
  }

  /** 当前有可用凭据的模型，切换模型的下拉列表用。 */
  private async models(): Promise<ModelInfo[]> {
    const available = await this.session.modelRuntime.getAvailable();
    return available.map((model) => toModelInfo(model)).filter((m): m is ModelInfo => m !== null);
  }

  /** 与 pi 自带 RPC 模式的 get_commands 同源：扩展命令、prompt 模板、skill（名字带 skill: 前缀）。 */
  private commands(): SlashCommand[] {
    const s = this.session;
    return [
      ...s.extensionRunner.getRegisteredCommands().map((command) => ({
        name: command.invocationName,
        description: command.description ?? "",
        source: "extension" as const,
      })),
      ...s.promptTemplates.map((template) => ({
        name: template.name,
        description: template.description,
        source: "prompt" as const,
        ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
      })),
      ...s.resourceLoader.getSkills().skills.map((skill) => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill" as const,
      })),
    ];
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

  /** 新建会话（界面、托盘、扩展都走这里）：新会话沿用上个会话使用的模型。 */
  private async newSession(opts?: Parameters<AgentSessionRuntime["newSession"]>[0]) {
    const wanted = this.lastModel;
    const result = await this.runtime.newSession(opts);
    if (!result.cancelled) {
      await this.applyLastModel(wanted);
      // 新会话文件已落盘：列表缓存失效并后台重扫，名字表/历史里尽快出现（REQ-346）。
      this.invalidateSessionsCache();
    }
    this.lastModel = refOf(this.session.model);
    return result;
  }

  /** 新会话沿用指定模型；它已不可用（凭据没了、下线了）就保持默认，不打断。 */
  private async applyLastModel(wanted: ModelRef | null): Promise<void> {
    const s = this.session;
    if (!wanted || (s.model?.provider === wanted.provider && s.model?.id === wanted.id)) return;
    const model = s.modelRuntime.getModel(wanted.provider, wanted.id);
    if (!model) {
      this.log("warn", `上个会话的模型 ${wanted.provider}/${wanted.id} 已不可用，新会话用默认模型`);
      return;
    }
    try {
      await s.setModel(model);
    } catch (err) {
      this.log("warn", `上个会话的模型 ${wanted.provider}/${wanted.id} 用不了，新会话用默认模型：${errorMessage(err)}`);
    }
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
      // 素主题：契约里 fg/bg 是函数，恒等返回原文（见 plain-theme.ts，REQ-339）。
      theme: createPlainTheme(),
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
      theme: createPlainTheme(),
      getAllThemes: () => [createPlainTheme()],
      getTheme: () => createPlainTheme(),
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

function refOf(model: { provider: string; id: string } | undefined): ModelRef | null {
  return model ? { provider: model.provider, id: model.id } : null;
}

export function poolStates(pool: ReadonlyMap<string, { runtime: AgentSessionRuntime; lastUsedAt: number }>): Map<string, PoolEntryState> {
  const out = new Map<string, PoolEntryState>();
  for (const [key, value] of pool) {
    out.set(key, {
      lastUsedAt: value.lastUsedAt,
      busy: value.runtime.session.isStreaming || value.runtime.session.isCompacting,
    });
  }
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
