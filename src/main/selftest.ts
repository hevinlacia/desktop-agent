/**
 * 端到端自检：不依赖截屏工具，直接问渲染进程「你实际渲染成了什么样」。
 *
 * 用法：设置环境变量 DESKTOP_AGENT_SELFTEST=<输出目录> 后启动应用。
 * 流程：等 Agent 就绪 → 完整形态下取布局快照与窗口截图 → 宿主切到悬浮窗 → 再取一次
 * → 回到完整形态，走界面路径真实提问一轮 → 经 `desktop-agent ask` 从外部再提问一轮
 * → 点一个链接，确认只交给系统浏览器 → 写 result.json 后退出。
 * 退出码：0 通过；1 断言失败；2 超时。
 *
 * 自检模式下会话不落盘（见 index.ts 的 agentOptions），测试提问不会出现在 pi 的会话列表里。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, shell, type BrowserWindow, type NativeImage } from "electron";
import type { AgentProcess } from "./agentProcess";
import type { AgentStatus } from "../shared/agentIpc";
import type { AgentEvent, ChatMessage } from "../shared/protocol";

const FULL_SIDEBAR_WIDTH = 224;
const COMPACT_SIDEBAR_WIDTH = 40;
const TIMEOUT_MS = 150_000;
const AGENT_DEADLINE_MS = 15_000;
const PROMPT_DEADLINE_MS = 60_000;
const SELF_PROMPT = "请只回复两个字：收到。不要调用任何工具。";
const ASK_PROMPT = "这是通过 desktop-agent ask 发来的自检提问，请只回复两个字：收到。不要调用任何工具。";

type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

interface LayoutProbe {
  sidebarWidth: number;
  hasInput: boolean;
  /** 会话列表里已渲染的行数。 */
  sessionRows: number;
  /** 消息区里 assistant / user 气泡的数量、文字。 */
  assistantCount: number;
  userTexts: string[];
  /** 最后一条 assistant 消息的文字（去掉首尾空白）。 */
  lastAssistantText: string;
  /** 渲染进程自认为可见还是隐藏。 */
  visibility: string;
  title: string;
}

export interface SelfTestContext {
  win: BrowserWindow;
  agent: AgentProcess;
  /** 最近一次 Agent 状态通知。 */
  agentStatus: () => AgentStatus | null;
  switchMode(mode: "compact" | "full"): void;
}

export async function runSelfTest(ctx: SelfTestContext, outDir: string): Promise<number> {
  fs.mkdirSync(outDir, { recursive: true });
  const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
  let code = 2;

  try {
    await withDeadline(run(), TIMEOUT_MS, "自检 150 秒超时");
    report.ok = true;
    code = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.error = message;
    console.error(`[selftest] 失败：${message}`);
    code = /超时|未返回/.test(message) ? 2 : 1;
  }

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(report, null, 2) + "\n");
  if (code === 0) console.log(`[selftest] 通过，结果见 ${path.join(outDir, "result.json")}`);
  return code;

  async function run(): Promise<void> {
    // 1) Agent 就绪，能拿到会话状态与会话列表
    const state = await withDeadline(ctx.agent.state(), AGENT_DEADLINE_MS, "Agent 15 秒内未返回会话状态");
    report.agentStatus = ctx.agentStatus();
    report.session = {
      sessionId: state.sessionId,
      model: state.model?.id ?? null,
      messages: state.messages.length,
      isStreaming: state.isStreaming,
    };
    report.sessionCount = (await withDeadline(ctx.agent.sessions(), AGENT_DEADLINE_MS, "会话列表 15 秒内未返回"))
      .length;
    const sessionCount = report.sessionCount as number;

    // 2) 完整形态：侧边栏展开、输入框存在（说明 React 已挂载）、会话列表渲染出行
    ctx.switchMode("full");
    const full = await waitFor(
      ctx.win,
      (p) => p.hasInput && (sessionCount === 0 || p.sessionRows > 0),
      8_000,
    );
    report.full = { layout: full, windowSize: sizeOf(ctx.win) };
    await sleep(350);
    await snapshot(ctx.win, outDir, "1-full.png");
    if (!full.hasInput) throw new Error("完整形态下没有输入框：渲染进程可能没有启动");
    assertWidth("完整形态", full.sidebarWidth, FULL_SIDEBAR_WIDTH);
    if (sessionCount > 0 && full.sessionRows === 0) {
      throw new Error(`会话列表为空：Agent 报告有 ${sessionCount} 个会话，但列表没有渲染出任何一行`);
    }

    // 3) 宿主切到悬浮窗：渲染进程必须跟着换布局，窗口尺寸跟着变
    ctx.switchMode("compact");
    await sleep(400);
    const compact = await probeLayout(ctx.win);
    report.compact = { layout: compact, windowSize: sizeOf(ctx.win) };
    await sleep(350);
    await snapshot(ctx.win, outDir, "2-compact.png");
    assertWidth("悬浮窗形态", compact.sidebarWidth, COMPACT_SIDEBAR_WIDTH);
    if (sizeOf(ctx.win).height >= 300) {
      throw new Error(`切到悬浮窗后窗口高度应明显变小，实际 ${JSON.stringify(sizeOf(ctx.win))}`);
    }

    // 4) 真实对话往返，走用户实际使用的路径：点「新建会话」→ 在输入框打字 → 回车。
    //    证明 pi SDK、凭据、IPC、事件链路、消息渲染整条路都通。
    ctx.switchMode("full");
    const before = await ctx.agent.state();
    if (!(await clickNewSession(ctx.win))) throw new Error("没有找到「新建会话」按钮");
    // 等主进程完成会话替换，再留给渲染进程一次刷新的时间：
    // 渲染进程会丢弃「不属于当前会话」的事件，太早提问会被当成过期事件。
    const switchDeadline = Date.now() + AGENT_DEADLINE_MS;
    while ((await ctx.agent.state()).sessionId === before.sessionId && Date.now() < switchDeadline) {
      await sleep(100);
    }
    if ((await ctx.agent.state()).sessionId === before.sessionId) {
      throw new Error("点「新建会话」后 15 秒内会话没有切换");
    }
    await sleep(400);

    const round = trackRun(ctx.agent);
    try {
      await typeAndSubmit(ctx.win, SELF_PROMPT);
      const outcome = await awaitReply(round, "提问");
      const rendered = await waitFor(ctx.win, (p) => p.assistantCount > 0, 5_000);
      report.reply = { ...outcome, events: round.events, text: rendered.lastAssistantText.slice(0, 120) };
      await sleep(350);
      await snapshot(ctx.win, outDir, "3-reply.png");
      if (rendered.assistantCount === 0) throw new Error("Agent 已回复，但消息区没有渲染出 assistant 消息");
    } finally {
      round.stop();
    }

    // 5) 外部提问：`desktop-agent ask "<问题>"`。第二个实例拿不到单实例锁，
    //    只把参数转交给已经在跑的这个实例，然后自己退出。
    const beforeAsk = await probeLayout(ctx.win);
    const ask = trackRun(ctx.agent);
    try {
      const second = spawn(
        process.execPath,
        [...(app.isPackaged ? [] : [app.getAppPath()]), "ask", ASK_PROMPT],
        { stdio: "ignore" },
      );
      second.on("error", (err) => console.error("[selftest] 启动第二个实例失败：", err));
      second.unref();
      const outcome = await awaitReply(ask, "外部提问");
      const rendered = await waitFor(
        ctx.win,
        (p) => p.assistantCount > beforeAsk.assistantCount && p.userTexts.includes(ASK_PROMPT),
        5_000,
      );
      report.ask = { ...outcome, events: ask.events, text: rendered.lastAssistantText.slice(0, 120) };
      if (rendered.assistantCount <= beforeAsk.assistantCount) {
        throw new Error("外部提问已收到回复，但消息区没有新增 assistant 消息");
      }
      if (!rendered.userTexts.includes(ASK_PROMPT)) throw new Error("外部提问没有出现在消息区");
    } finally {
      ask.stop();
    }

    // 6) 链接安全：回复里的链接只能由系统浏览器打开，应用窗口自己不导航、不开新窗口。
    //    自检里把 shell.openExternal 换成只记录不真开，免得弹出浏览器。
    const opened: string[] = [];
    const originalOpenExternal = shell.openExternal;
    shell.openExternal = ((url: string) => {
      opened.push(url);
      return Promise.resolve();
    }) as typeof shell.openExternal;
    let newWindows = 0;
    const onCreated = () => {
      newWindows += 1;
    };
    app.on("browser-window-created", onCreated);
    try {
      const url = "https://example.com/desktop-agent-selftest";
      await ctx.win.webContents.executeJavaScript(`(() => {
        const a = document.createElement("a");
        a.href = ${JSON.stringify(url)};
        a.target = "_blank";
        a.textContent = "selftest";
        document.body.appendChild(a);
        a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        a.remove();
      })()`);
      await sleep(500);
      const location = (await ctx.win.webContents.executeJavaScript("location.href")) as string;
      report.link = { opened, newWindows, location };
      if (opened[0] !== url) {
        throw new Error(`点击链接后应交给系统浏览器打开 ${url}，实际：${JSON.stringify(opened)}`);
      }
      if (newWindows !== 0) throw new Error(`点击链接不应开新窗口，实际开了 ${newWindows} 个`);
      if (!/^(file:|https?:\/\/localhost[:/])/.test(location)) {
        throw new Error(`点击链接后应用窗口发生了导航：${location}`);
      }
    } finally {
      shell.openExternal = originalOpenExternal;
      app.off("browser-window-created", onCreated);
    }
  }

  /** 等一轮运行收尾，核对 Agent 侧的最终消息没有报错，返回耗时与停止原因。 */
  async function awaitReply(run: RunTracker, label: string): Promise<{ durationMs: number; stopReason: string | null }> {
    const startedAt = Date.now();
    await withDeadline(run.started, AGENT_DEADLINE_MS, `${label} 15 秒内 Agent 没有开跑`);
    const aborted = await withDeadline(
      run.settled,
      PROMPT_DEADLINE_MS,
      `Agent ${PROMPT_DEADLINE_MS / 1000} 秒内没有完成${label}的回复`,
    );
    if (aborted) throw new Error(`${label}的回复被中止`);

    // 以 Agent 侧的最终消息为准判断成败：模型报错时 stopReason / errorMessage 会带原因。
    const last = (await ctx.agent.state()).messages
      .filter((m): m is AssistantMessage => m.role === "assistant")
      .at(-1);
    if (!last) throw new Error(`${label}收尾后 Agent 状态里没有 assistant 消息`);
    if (last.errorMessage || last.stopReason === "error") {
      throw new Error(`${label}时模型返回错误：${last.errorMessage ?? "(没有说明)"}`);
    }
    return { durationMs: Date.now() - startedAt, stopReason: last.stopReason ?? null };
  }
}

interface RunTracker {
  /** Agent 开跑时 resolve。 */
  started: Promise<void>;
  /** Agent 收尾时 resolve，值表示是否被中止。 */
  settled: Promise<boolean>;
  /** 按类型计数的事件表。 */
  events: Record<string, number>;
  /** 停止跟踪。必须调用，否则监听会泄漏到下一次运行。 */
  stop(): void;
}

/** 订阅一轮运行：开跑、收尾、事件计数。 */
function trackRun(agent: AgentProcess): RunTracker {
  const events: Record<string, number> = {};
  let markStarted: () => void = () => undefined;
  let markSettled: (aborted: boolean) => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const settled = new Promise<boolean>((resolve) => {
    markSettled = resolve;
  });
  const listener = (event: AgentEvent) => {
    events[event.type] = (events[event.type] ?? 0) + 1;
    if (event.type === "runStarted") markStarted();
    else if (event.type === "runSettled") markSettled(event.aborted);
  };
  agent.onEvent.add(listener);
  return {
    started,
    settled,
    events,
    stop: () => {
      agent.onEvent.delete(listener);
    },
  };
}

function assertWidth(label: string, actual: number, expected: number): void {
  if (Math.round(actual) !== expected) {
    throw new Error(`${label}下侧边栏宽度应为 ${expected}，实际 ${actual}`);
  }
}

async function probeLayout(win: BrowserWindow): Promise<LayoutProbe> {
  return win.webContents.executeJavaScript(`(() => {
    const aside = document.querySelector("aside");
    const lastAssistant = [...document.querySelectorAll('[data-role="assistant"]')].at(-1);
    return {
      sidebarWidth: aside ? aside.getBoundingClientRect().width : 0,
      hasInput: !!document.querySelector("textarea"),
      sessionRows: document.querySelectorAll("aside div.overflow-y-auto > button").length,
      assistantCount: document.querySelectorAll('[data-role="assistant"]').length,
      userTexts: [...document.querySelectorAll('[data-role="user"]')].map((el) => el.textContent.trim()),
      lastAssistantText: lastAssistant ? lastAssistant.textContent.trim() : "",
      visibility: document.visibilityState,
      title: document.title,
    };
  })()`) as Promise<LayoutProbe>;
}

/** 在页面里点击侧边栏的「新建会话」，和用户手点走同一条路。 */
function clickNewSession(win: BrowserWindow): Promise<boolean> {
  return win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('aside button[title="新建会话"]');
    if (!button) return false;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  })()`) as Promise<boolean>;
}

/** 像用户一样在输入框里打字并回车。 */
async function typeAndSubmit(win: BrowserWindow, text: string): Promise<void> {
  // 受控输入框直接改 value 不会触发 React：要先走原生 setter 再派发 input 事件。
  const typed = (await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector("textarea");
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`)) as boolean;
  if (!typed) throw new Error("没有找到输入框");
  // 分两次执行：等 React 处理完 input 事件、状态落定后再回车。
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector("textarea");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }),
    );
  })()`);
}

/** 轮询布局快照直到满足条件；超时返回最后一次快照，由调用方断言。 */
async function waitFor(
  win: BrowserWindow,
  ready: (probe: LayoutProbe) => boolean,
  timeoutMs: number,
): Promise<LayoutProbe> {
  const deadline = Date.now() + timeoutMs;
  let last = await probeLayout(win);
  while (!ready(last) && Date.now() < deadline) {
    await sleep(150);
    last = await probeLayout(win);
  }
  return last;
}

function sizeOf(win: BrowserWindow): { width: number; height: number } {
  const [width, height] = win.getSize();
  return { width: width ?? 0, height: height ?? 0 };
}

async function snapshot(win: BrowserWindow, dir: string, name: string): Promise<void> {
  // 自检用离屏渲染，画面通过 paint 事件交付：请求一次完整重绘，取事件送来的那一帧。
  // capturePage 在离屏模式下可能返回旧帧，不用它。
  const image = await new Promise<NativeImage>((resolve, reject) => {
    const timer = setTimeout(() => {
      win.webContents.off("paint", onPaint);
      reject(new Error("自检截图超时：渲染进程 3 秒内没有出帧"));
    }, 3_000);
    const onPaint = (_event: unknown, _dirty: unknown, frame: NativeImage) => {
      clearTimeout(timer);
      win.webContents.off("paint", onPaint);
      resolve(frame);
    };
    win.webContents.on("paint", onPaint);
    win.webContents.invalidate();
  });
  fs.writeFileSync(path.join(dir, name), image.toPNG());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
