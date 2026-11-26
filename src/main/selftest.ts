/**
 * 端到端自检：不依赖截屏工具，直接问渲染进程「你实际渲染成了什么样」。
 *
 * 用法：设置环境变量 DESKTOP_AGENT_SELFTEST=<输出目录> 后启动应用。
 * 流程：等 Agent 就绪 → 完整形态下取布局快照与窗口截图 → 宿主切到悬浮窗 → 再取一次
 * → 回到完整形态，走界面路径真实提问一轮 → 经 `desktop-agent ask` 从外部再提问一轮
 * → 点一个链接，确认只交给系统浏览器 → 输入 / 验证斜杠命令联想
 * → 改一次工作目录再改回 → 最大化 / 切形态 / 还原 → 写 result.json 后退出。
 * 退出码：0 通过；1 断言失败；2 超时。
 *
 * 自检模式下会话不落盘（见 index.ts 的 agentOptions），测试提问不会出现在 pi 的会话列表里。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, shell, type BrowserWindow, type NativeImage } from "electron";
import type { AgentProcess } from "./agentProcess";
import type { AgentStatus } from "../shared/agentIpc";
import type { AgentEvent, AppConfig, ChatMessage } from "../shared/protocol";

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
  /** 输入框当前内容与联想列表的行数（0 = 没有弹出）。 */
  inputValue: string;
  commandSuggestions: number;
  /** 标题栏上是否出现了「还原」按钮（即窗口处于最大化）。 */
  restoreButton: boolean;
  title: string;
}

export interface SelfTestContext {
  win: BrowserWindow;
  agent: AgentProcess;
  /** 最近一次 Agent 状态通知。 */
  agentStatus: () => AgentStatus | null;
  switchMode(mode: "compact" | "full"): void;
  /** 改配置（与设置面板保存走同一个函数）与读当前配置。 */
  applyConfig(config: AppConfig): AppConfig;
  getConfig(): AppConfig;
  toggleMaximize(): void;
  isMaximized(): boolean;
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
      // 只带上锁路径、不带自检开关：第二个实例把参数交给已经在跑的实例就退出，
      // 不给它任何变成完整实例的机会。
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DESKTOP_AGENT_USERDATA: app.getPath("userData"),
      };
      delete env.DESKTOP_AGENT_SELFTEST;
      const second = spawn(
        process.execPath,
        [...(app.isPackaged ? [] : [app.getAppPath()]), "ask", ASK_PROMPT],
        { stdio: "ignore", env },
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

    // 7) 斜杠命令联想：输入 / 弹出命令列表，方向键 + Tab 把命令名补进输入框。
    //    补全只改输入框内容、不提交，所以这一步不花模型调用。
    await typeInto(ctx.win, "/");
    const suggested = await waitFor(ctx.win, (p) => p.commandSuggestions > 0, 5_000);
    const commands: Record<string, unknown> = { suggestions: suggested.commandSuggestions };
    report.commands = commands;
    if (suggested.commandSuggestions === 0) throw new Error("输入 / 后没有出现命令联想列表");
    // DOM 里有不等于看得见：记下列表的位置和命中测试，截图前给合成器留一帧时间。
    const popup = (await ctx.win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('[role="listbox"][aria-label="斜杠命令"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 12);
      return {
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex,
        hit: hit ? hit.tagName + "." + String(hit.className).slice(0, 60) : null,
      };
    })()`)) as Record<string, unknown> | null;
    commands.popup = popup;
    await sleep(350);
    await snapshot(ctx.win, outDir, "4-commands.png");
    await pressKey(ctx.win, "ArrowDown");
    await pressKey(ctx.win, "Tab");
    const completed = await probeLayout(ctx.win);
    commands.completed = completed.inputValue;
    if (!/^\/\S+ $/.test(completed.inputValue)) {
      throw new Error(`Tab 补全后输入框应为「/命令名 」，实际：${JSON.stringify(completed.inputValue)}`);
    }
    if (completed.commandSuggestions !== 0) throw new Error("补全后联想列表应关闭");
    await typeInto(ctx.win, "");

    // 8) 工作目录可改：保存新目录后 Agent 按新参数重启，会话状态里的 cwd 跟着变；改回原值同理。
    const originalConfig = ctx.getConfig();
    const tryCwd = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-agent-selftest-cwd-"));
    try {
      ctx.applyConfig({ ...originalConfig, cwd: tryCwd });
      const switched = await until(async () => (await ctx.agent.state()).cwd === tryCwd, 30_000);
      ctx.applyConfig(originalConfig);
      const restoredCwd = await until(async () => (await ctx.agent.state()).cwd === originalConfig.cwd, 30_000);
      report.cwdSwitch = { switched, restored: restoredCwd };
      if (!switched || !restoredCwd) {
        throw new Error(`改工作目录后 Agent 没有按新目录重启：${JSON.stringify(report.cwdSwitch)}`);
      }
    } finally {
      fs.rmSync(tryCwd, { recursive: true, force: true });
    }

    // 9) 最大化：状态记进配置并通知渲染进程；切到悬浮窗会还原，切回来恢复；还原后配置跟着更新。
    //    这一段依赖合成器的异步时序，只跑一轮说明不了问题，连做三轮把竞态压实。
    const rounds: Array<Record<string, unknown>> = [];
    report.maximize = { rounds };
    for (let round = 1; round <= 3; round++) {
      const state: Record<string, unknown> = {};
      rounds.push(state);
      ctx.toggleMaximize();
      state.maximized = await until(() => ctx.isMaximized(), 3_000);
      state.restoreButton = (await waitFor(ctx.win, (p) => p.restoreButton, 3_000)).restoreButton;
      state.remembered = ctx.getConfig().fullMaximized;
      if (state.maximized !== true || state.restoreButton !== true) {
        throw new Error(`第 ${round} 轮：最大化后窗口没有变成最大化，或渲染进程没收到状态`);
      }
      if (!ctx.getConfig().fullMaximized) throw new Error(`第 ${round} 轮：最大化偏好没有写进配置`);

      ctx.switchMode("compact");
      const compactOk = await until(
        () => !ctx.isMaximized() && sizeOf(ctx.win).height === ctx.getConfig().compactHeight,
        3_000,
      );
      state.afterCompact = {
        maximized: ctx.isMaximized(),
        remembered: ctx.getConfig().fullMaximized,
        size: sizeOf(ctx.win),
      };
      if (!compactOk) {
        throw new Error(`第 ${round} 轮：最大化状态下切到悬浮窗后尺寸不对：${JSON.stringify(sizeOf(ctx.win))}`);
      }

      ctx.switchMode("full");
      const afterBack = {
        maximized: await until(() => ctx.isMaximized(), 3_000),
        remembered: ctx.getConfig().fullMaximized,
      };
      state.afterBack = afterBack;
      if (afterBack.maximized !== true) {
        throw new Error(`第 ${round} 轮：切回对话窗口后没有按偏好恢复最大化`);
      }

      ctx.toggleMaximize();
      const restored = await until(() => !ctx.isMaximized(), 3_000);
      await sleep(200);
      const afterRestore = { maximized: ctx.isMaximized(), remembered: ctx.getConfig().fullMaximized };
      state.afterRestore = afterRestore;
      if (!restored || afterRestore.maximized || afterRestore.remembered) {
        throw new Error(`第 ${round} 轮：还原后窗口状态或配置没有更新`);
      }
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
      inputValue: document.querySelector("textarea")?.value ?? "",
      commandSuggestions: document.querySelectorAll('[data-role="command-suggestion"]').length,
      restoreButton: !!document.querySelector('button[aria-label="还原"]'),
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

/** 像用户一样在输入框里打字。受控输入框直接改 value 不会触发 React：要先走原生 setter 再派发 input 事件。 */
async function typeInto(win: BrowserWindow, text: string): Promise<void> {
  const typed = (await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector("textarea");
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`)) as boolean;
  if (!typed) throw new Error("没有找到输入框");
}

/** 在输入框上按一个键。只派发 keydown：输入框的快捷键都靠它。 */
function pressKey(win: BrowserWindow, key: string): Promise<void> {
  return win.webContents.executeJavaScript(`(() => {
    document.querySelector("textarea").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key)},
        code: ${JSON.stringify(key)},
        bubbles: true,
        cancelable: true,
      }),
    );
  })()`) as Promise<void>;
}

/** 打字并回车。分两次执行：等 React 处理完 input 事件、状态落定后再回车。 */
async function typeAndSubmit(win: BrowserWindow, text: string): Promise<void> {
  await typeInto(win, text);
  await pressKey(win, "Enter");
}

/** 轮询到条件成立为止；超时返回 false。条件里的请求可能因 Agent 重启被拒，捕获后重试。 */
async function until(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return true;
    } catch {
      // 重试
    }
    await sleep(150);
  }
  return false;
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
