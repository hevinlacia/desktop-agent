/**
 * 主进程入口：装配窗口、托盘、快捷键、IPC 与 Agent 子进程。
 * 这里只做启动与编排，各能力的实现都在同目录的单个模块里。
 */
import { app, dialog, type Tray } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentProcess } from "./agentProcess";
import { getConfig, loadConfig, saveConfig } from "./config";
import { legacyKWinWarning } from "./legacy";
import { registerIpc, type CommandHandlers } from "./ipc";
import { registerToggleShortcut, unregisterShortcut, unregisterShortcuts } from "./shortcut";
import { isShortcutOptIn, planShortcut } from "./shortcutPolicy";
import { runSelfTest } from "./selftest";
import { fetchSessionRequirements } from "./panel-client";
import { createTray } from "./tray";
import {
  createMainWindow,
  currentMode,
  hideWindow,
  isMaximized,
  mainWindow,
  markQuitting,
  reapplyMode,
  resizeWindow,
  showWindow,
  switchMode,
  toggleMaximize,
  toggleWindow,
} from "./window";
import { AGENT_BOOT_ERROR_CHANNEL, AGENT_EVENT_CHANNEL, AGENT_RESET_CHANNEL, EXTERNAL_ASK_CHANNEL } from "../shared/bridge";
import { askText, wantsToggle } from "./args";
import type { EventChannel, EventPayloads } from "../shared/bridge";
import type { AgentInitOptions, AgentStatus } from "../shared/agentIpc";
import type { AppConfig } from "../shared/protocol";

const agent = new AgentProcess();
let tray: Tray | null = null;
let lastAgentStatus: AgentStatus | null = null;

// 配置固定放在 appData/desktop-agent（Linux: ~/.config/desktop-agent），单实例锁也在这个目录。
app.setName("desktop-agent");

// 自检与正式版互不干扰：自检用独立的 userData（单实例锁和配置都按它算）。
// 不然用户正开着应用时，自检实例拿不到锁会静默退出，还会把用户的窗口弹到前台。
// 自检里拉起的第二个实例只继承 DESKTOP_AGENT_USERDATA、不继承自检开关：它只负责转交参数，
// 绝不能自己也变成一个跑自检的完整实例（否则会一环扣一环地互相拉起）。
const selfTestDir = process.env.DESKTOP_AGENT_SELFTEST
  ? path.resolve(process.env.DESKTOP_AGENT_SELFTEST)
  : null;
const userDataOverride = selfTestDir
  ? path.join(selfTestDir, "userData")
  : process.env.DESKTOP_AGENT_USERDATA || null;
if (userDataOverride) app.setPath("userData", userDataOverride);

if (!app.requestSingleInstanceLock()) {
  // 已有实例在跑：它那边会收到 second-instance 并把窗口带到前台，这里直接退出。
  app.quit();
} else {
  wireAppEvents();
  app
    .whenReady()
    .then(boot)
    .catch((err: unknown) => {
      console.error("启动失败：", err);
      app.quit();
    });
}

/** 系统的目录选择框。用户取消时返回 null。 */
async function pickDirectory(defaultPath: string | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "选择 Agent 的工作目录",
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath && isDirectory(defaultPath) ? { defaultPath } : {}),
  };
  const win = mainWindow();
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 退出后删除自检用的 userData。只认「某个目录/userData」这一种形状，路径不是这样就不删——
 * 它来自环境变量，不能因为一个奇怪的取值删错东西。
 */
function scheduleUserDataCleanup(dir: string): void {
  const parent = path.dirname(dir);
  if (path.basename(dir) !== "userData" || parent === path.parse(dir).root || parent === os.homedir()) return;
  spawn("sh", ["-c", 'sleep 2; rm -rf -- "$1"', "desktop-agent-cleanup", dir], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function wireAppEvents(): void {
  // 再启动一次 = 想看界面；`desktop-agent toggle` / `desktop-agent ask "<问题>"` 也走这里，
  // 参数由已经在跑的实例处理，新实例拿不到单实例锁后自行退出。
  app.on("second-instance", (_event, argv: string[]) => {
    // 外部程序代用户提问，等同于在输入框里发了一句。
    const text = askText(argv);
    if (text !== null) {
      showWindow("full");
      sendToRenderer(EXTERNAL_ASK_CHANNEL, text);
      return;
    }
    if (wantsToggle(argv)) toggleWindow();
    else showWindow("full");
  });
  // 关窗只是隐藏，没有窗口也不退出，靠托盘 / 快捷键再唤起。
  app.on("window-all-closed", () => undefined);
  app.on("activate", () => showWindow("full"));
  // 所有退出路径（托盘退出、Cmd+Q、系统注销发来的 SIGTERM）都会先到这里：
  // 先置退出标志，否则「关窗只是隐藏」会拦下退出流程里的关窗请求，应用就退不出去。
  app.on("before-quit", markQuitting);
  app.on("will-quit", (event) => {
    // 真正退出前等 Agent 收尾（会话落盘）。拦下默认退出后必须自己调 app.exit。
    event.preventDefault();
    unregisterShortcuts();
    tray?.destroy();
    const startedAt = Date.now();
    void agent
      .shutdown()
      .catch((err: unknown) => console.error("Agent 关闭失败：", err))
      .finally(() => {
        console.log(`[quit] Agent 已收尾（${Date.now() - startedAt}ms），退出`);
        app.exit();
      });
  });

  agent.onEvent.add((event) => sendToRenderer(AGENT_EVENT_CHANNEL, event));
  agent.onLog.add((level, message) => {
    if (level === "error") console.error(`[agent] ${message}`);
    else if (level === "warn") console.warn(`[agent] ${message}`);
    else console.log(`[agent] ${message}`);
  });
  agent.onStatus.add((status) => {
    lastAgentStatus = status;
    if (status === "restarting") sendBootError("Agent 子进程意外退出，正在重启…");
    if (status === "crashed") {
      sendBootError("Agent 子进程反复崩溃，已停止自动重启。请退出应用后重试，并查看终端日志。");
    }
  });
}

async function boot(): Promise<void> {
  const loaded = loadConfig();
  const config = loaded.config;
  const warnings = loaded.warnings;
  // 旧版的 KWin 脚本会在合成器层抢占快捷键，新版启动时提示用户卸载。
  const legacy = process.platform === "linux" ? legacyKWinWarning(os.homedir()) : null;
  if (legacy) warnings.push(legacy);

  // 首次启动直接给完整窗口，否则用户只看到一个托盘图标，不知道程序跑起来没有。
  const win = createMainWindow();
  win.once("ready-to-show", () => showWindow("full"));
  win.webContents.once("did-finish-load", () => {
    for (const warning of warnings) sendBootError(warning);
  });

  registerIpc(createHandlers());
  tray = createTray({
    show: (mode) => showWindow(mode),
    toggle: () => toggleWindow(),
    newSession: async () => {
      await agent.newSession();
      sendToRenderer(AGENT_RESET_CHANNEL, null);
      showWindow("full");
    },
    quit: () => app.quit(),
  });
  applyShortcut(config.toggleShortcut);

  try {
    await agent.start(agentOptions(config));
  } catch (err) {
    sendBootError(`Agent 启动失败：${errorMessage(err)}`);
  }

  // 端到端自检：跑完直接退出，退出码即结果。
  const selfTestDir = process.env.DESKTOP_AGENT_SELFTEST;
  if (selfTestDir) {
    const code = await runSelfTest(
      {
        win,
        agent,
        agentStatus: () => lastAgentStatus,
        switchMode,
        applyConfig,
        getConfig,
        toggleMaximize,
        isMaximized,
      },
      selfTestDir,
    );
    markQuitting();
    // Chromium 在退出过程中还会往 userData 里写几个收尾文件，当场删不干净：起一个脱离进程的延时清理。
    scheduleUserDataCleanup(app.getPath("userData"));
    app.exit(code);
  }
}

function createHandlers(): CommandHandlers {
  return {
    agent_state: () => agent.state(),
    agent_send: ({ text, streamingBehavior }) => agent.prompt(text, streamingBehavior),
    agent_abort: () => agent.abort(),
    agent_new_session: () => agent.newSession(),
    agent_switch_session: ({ sessionPath }) => agent.switchSession(sessionPath),
    agent_stats: () => agent.stats(),
    agent_set_model: async ({ provider, modelId }) => {
      await agent.setModel(provider, modelId);
      rememberModel(provider, modelId);
    },
    agent_set_thinking_level: ({ level }) => agent.setThinkingLevel(level),
    agent_extension_ui_response: ({ response }) => agent.respondExtensionUi(response),
    agent_sessions: () => agent.sessions(),
    agent_commands: () => agent.commands(),
    agent_models: () => agent.models(),
    window_hide: () => hideWindow(),
    window_switch_mode: ({ mode }) => switchMode(mode),
    window_mode: () => currentMode(),
    window_toggle_maximize: () => toggleMaximize(),
    window_is_maximized: () => isMaximized(),
    window_resize: ({ width, height }) => resizeWindow({ width, height }),
    config_get: () => getConfig(),
    config_set: ({ config }) => applyConfig(config),
    // 右侧需求栏：只读 Agent Panel，失败降级为可展示的 error（不抛）。
    panel_requirements: ({ sessionId }) =>
      fetchSessionRequirements({ sessionId, configUrl: getConfig().panelUrl }),
    dialog_pick_directory: ({ defaultPath }) => pickDirectory(defaultPath),
  };
}

function applyShortcut(accelerator: string): boolean {
  const plan = planShortcut({
    accelerator,
    packaged: app.isPackaged,
    optIn: isShortcutOptIn(process.env.DESKTOP_AGENT_SHORTCUT),
  });
  if (!plan.register) {
    // 跳过不算失败：不要往界面上报错。开发态每次热重启都会走到这里，保持安静。
    console.log(
      plan.reason === "off"
        ? "[shortcut] 配置里没有全局快捷键，跳过注册"
        : `[shortcut] 开发态跳过全局快捷键 ${accelerator}（DESKTOP_AGENT_SHORTCUT=1 可强制注册）`,
    );
    return true;
  }
  const registered = registerToggleShortcut(plan.accelerator, () => toggleWindow());
  if (registered) {
    console.log(`[shortcut] 全局快捷键已注册：${registered}`);
    return true;
  }
  sendBootError(
    `全局快捷键 ${accelerator} 注册失败：写法不合法或已被其他应用占用。可以改配置文件里的 toggleShortcut，或用托盘菜单唤起。`,
  );
  return false;
}

/** 保存设置，并处理需要立即生效的部分：快捷键、窗口尺寸、Agent 重启。 */
function applyConfig(next: AppConfig): AppConfig {
  const prev = getConfig();
  let saved = saveConfig(next);

  if (saved.toggleShortcut !== prev.toggleShortcut) {
    // 先注册新的（失败时旧的还没被释放，仍在生效），成功后再精确释放旧的那一个。
    if (!applyShortcut(saved.toggleShortcut)) {
      saved = saveConfig({ ...saved, toggleShortcut: prev.toggleShortcut });
      throw new Error(
        `快捷键 ${next.toggleShortcut} 注册失败（写法不合法或已被其他应用占用），已保留原来的 ${prev.toggleShortcut || "（无）"}；其余设置已保存。`,
      );
    }
    if (prev.toggleShortcut) unregisterShortcut(prev.toggleShortcut);
  }

  if (
    saved.fullWidth !== prev.fullWidth ||
    saved.fullHeight !== prev.fullHeight ||
    saved.compactWidth !== prev.compactWidth ||
    saved.compactHeight !== prev.compactHeight
  ) {
    reapplyMode();
  }

  if (saved.cwd !== prev.cwd || saved.persistSession !== prev.persistSession || saved.extensions !== prev.extensions) {
    // 这三项是子进程的启动参数，只能重启。期间发来的请求会等新进程就绪。
    sendToRenderer(AGENT_RESET_CHANNEL, null);
    void agent
      .restart(agentOptions(saved))
      .catch((err: unknown) => sendBootError(`Agent 重启失败：${errorMessage(err)}`));
  }
  return saved;
}

function sendToRenderer<C extends EventChannel>(channel: C, payload: EventPayloads[C]): void {
  mainWindow()?.webContents.send(channel, payload);
}

function sendBootError(message: string): void {
  sendToRenderer(AGENT_BOOT_ERROR_CHANNEL, message);
}

/** 记住这个模型：新建会话时沿用。写配置失败只影响下次，不影响本次切换。 */
function rememberModel(provider: string, modelId: string): void {
  try {
    saveConfig({ ...getConfig(), lastModel: { provider, id: modelId } });
  } catch (err) {
    console.error("记住上次使用的模型失败：", err);
  }
}

function agentOptions(cfg: AppConfig): AgentInitOptions {
  // 自检模式下会话不落盘：测试提问不能在 pi 的会话目录里留下文件。
  const persistSession = process.env.DESKTOP_AGENT_SELFTEST ? false : cfg.persistSession;
  return { cwd: cfg.cwd, persistSession, extensions: cfg.extensions, lastModel: cfg.lastModel };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
