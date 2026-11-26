/**
 * Agent 子进程管理：拉起 utilityProcess、请求/回复配对、事件转发与崩溃重启。
 *
 * pi SDK 跑在独立进程里：Agent 的工具（bash / write）不和主进程混在一起，
 * 子进程出问题也不会带走窗口。
 */
import { utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import path from "node:path";
import type {
  AgentEvent,
  ExtensionUiResponse,
  PromptOutcome,
  SessionState,
  SessionStats,
  SessionSummary,
} from "../shared/protocol";
import type { AgentInitOptions, AgentRequest, AgentStatus, AgentToMain, LogLevel } from "../shared/agentIpc";

const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 1_500;

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 没人在等的时候也要有兜底，否则 ready 被拒绝会变成未处理的 Promise 拒绝。
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export class AgentProcess {
  private child: UtilityProcess | null = null;
  private ready: Deferred<void> = deferred();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** 为 true 时子进程退出不算崩溃（主动停止 / 退出应用）。 */
  private stopping = false;
  private restarts = 0;
  private options: AgentInitOptions | null = null;
  private lastError = "";

  readonly onEvent = new Set<(event: AgentEvent) => void>();
  readonly onLog = new Set<(level: LogLevel, message: string) => void>();
  readonly onStatus = new Set<(status: AgentStatus) => void>();

  /** 拉起子进程并等它就绪；失败时 reject，原因可直接展示给用户。 */
  async start(options: AgentInitOptions): Promise<void> {
    this.options = options;
    this.stopping = false;
    this.restarts = 0;
    await this.spawn(options);
  }

  /** 启动参数变了（工作目录、持久化、扩展开关）：停掉旧进程，按新参数重来。 */
  async restart(options: AgentInitOptions): Promise<void> {
    this.options = options;
    await this.stop();
    this.stopping = false;
    this.restarts = 0;
    await this.spawn(options);
  }

  /** 正常退出：先让子进程有序收尾（等会话落盘），超时再强杀。 */
  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.stop();
  }

  private spawn(options: AgentInitOptions): Promise<void> {
    const ready = deferred<void>();
    this.ready = ready;
    this.lastError = "";
    let settled = false;
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) ready.reject(err);
      else {
        ready.resolve();
        this.notifyStatus("ready");
      }
    };
    const timer = setTimeout(() => {
      settle(
        new Error(
          `Agent 子进程 ${READY_TIMEOUT_MS / 1000} 秒内未就绪${this.lastError ? `：${this.lastError}` : ""}`,
        ),
      );
    }, READY_TIMEOUT_MS);

    const child = utilityProcess.fork(path.join(__dirname, "agent.js"), [], {
      env: { ...process.env },
      stdio: "pipe",
      serviceName: "pi-agent",
    });
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.emitLog("info", chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => this.emitLog("warn", chunk.toString()));
    child.on("message", (message: AgentToMain) => this.receive(message));
    child.on("spawn", () => {
      // 启动握手：子进程 init 完成后才回响应，期间主进程照常处理窗口。
      this.post({ id: this.nextId++, cmd: "init", options }).then(
        () => settle(null),
        (err: Error) => settle(err),
      );
    });
    child.on("exit", (code) => {
      // stop() 已把这个子进程从 current 上摘掉：属于正常替换，不走崩溃逻辑。
      if (this.child !== child) return;
      clearTimeout(timer);
      this.child = null;
      const err = new Error(this.lastError || `Agent 子进程已退出（code=${code}）`);
      this.failPending(err);
      settle(err);
      this.onCrash();
    });

    return ready.promise;
  }

  private onCrash() {
    if (this.stopping || !this.options) return;
    if (this.restarts >= MAX_RESTARTS) {
      this.notifyStatus("crashed");
      return;
    }
    this.restarts += 1;
    this.notifyStatus("restarting");
    const options = this.options;
    setTimeout(() => {
      if (!this.stopping) void this.spawn(options).catch(() => undefined);
    }, RESTART_DELAY_MS);
  }

  private async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      await Promise.race([
        this.post({ id: this.nextId++, cmd: "shutdown" }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SHUTDOWN_TIMEOUT_MS)),
      ]);
    } catch {
      // 子进程可能已经不在了
    }
    child.kill();
    this.failPending(new Error("Agent 子进程已停止"));
  }

  private receive(message: AgentToMain) {
    if ("kind" in message) {
      if (message.kind === "event") for (const fn of this.onEvent) fn(message.event);
      else this.emitLog(message.level, message.message);
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.ok) waiter.resolve(message.data);
    else waiter.reject(new Error(message.error));
  }

  private post(req: AgentRequest): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Agent 子进程未运行"));
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject });
      child.postMessage(req);
    });
  }

  /** 所有请求都等子进程就绪后再发，调用方不必关心启动时序。 */
  private async send<T>(make: (id: number) => AgentRequest): Promise<T> {
    await this.ready.promise;
    return (await this.post(make(this.nextId++))) as T;
  }

  state() {
    return this.send<SessionState>((id) => ({ id, cmd: "state" }));
  }

  prompt(text: string, streamingBehavior?: "steer" | "followUp") {
    return this.send<PromptOutcome>((id) => ({
      id,
      cmd: "prompt",
      text,
      ...(streamingBehavior ? { streamingBehavior } : {}),
    }));
  }

  abort() {
    return this.send<void>((id) => ({ id, cmd: "abort" }));
  }

  newSession() {
    return this.send<void>((id) => ({ id, cmd: "newSession" }));
  }

  switchSession(sessionPath: string) {
    return this.send<void>((id) => ({ id, cmd: "switchSession", sessionPath }));
  }

  sessions() {
    return this.send<SessionSummary[]>((id) => ({ id, cmd: "sessions" }));
  }

  stats() {
    return this.send<SessionStats>((id) => ({ id, cmd: "stats" }));
  }

  setModel(provider: string, modelId: string) {
    return this.send<void>((id) => ({ id, cmd: "setModel", provider, modelId }));
  }

  setThinkingLevel(level: string) {
    return this.send<void>((id) => ({ id, cmd: "setThinkingLevel", level }));
  }

  respondExtensionUi(response: ExtensionUiResponse) {
    return this.send<void>((id) => ({ id, cmd: "extensionUiResponse", response }));
  }

  private failPending(err: Error) {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }

  private emitLog(level: LogLevel, text: string) {
    const message = text.trim();
    if (!message) return;
    if (level === "error") this.lastError = message;
    for (const fn of this.onLog) fn(level, message);
  }

  private notifyStatus(status: AgentStatus) {
    for (const fn of this.onStatus) fn(status);
  }
}
