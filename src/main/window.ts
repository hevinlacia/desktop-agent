/**
 * 窗口形态控制。
 *
 * 形态以主进程为真源：托盘、快捷键、二次启动都会绕过渲染进程直接改形态，
 * 所以每次变更后必须广播 `window://mode-changed`，渲染进程只跟随。
 */
import { app, BrowserWindow, screen, shell } from "electron";
import path from "node:path";
import { getConfig, saveConfig } from "./config";
import { isWebUrl } from "./externalUrl";
import { MIN_WINDOW, resolveSize } from "../shared/config";
import { WINDOW_MAXIMIZED_CHANNEL, WINDOW_MODE_CHANNEL } from "../shared/bridge";
import type { AppConfig, WindowMode } from "../shared/protocol";

let win: BrowserWindow | null = null;
let mode: WindowMode = "compact";
let quitting = false;

export function currentMode(): WindowMode {
  return mode;
}

export function mainWindow(): BrowserWindow | null {
  return win;
}

/** 真正退出前置位，让 close 事件不再被拦成「隐藏」。 */
export function markQuitting(): void {
  quitting = true;
}

export function createMainWindow(): BrowserWindow {
  const cfg = getConfig();
  win = new BrowserWindow({
    width: cfg.compactWidth,
    height: cfg.compactHeight,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    // 透明 + 无边框：四个角是真透明，圆角由渲染进程的 .app-shell 画。
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    resizable: true,
    skipTaskbar: true,
    title: "Desktop Agent",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 自检模式用离屏渲染：窗口被别的窗口盖住时合成器不再发帧回调，
      // 正常模式下 Chromium 会停在旧画面上，capturePage 拿不到最新帧。离屏渲染自己出帧，不依赖窗口在最前。
      offscreen: isSelfTest(),
    },
  });
  win.setMenu(null);

  // 回复里的链接来自模型输出，不可信：一律交给系统浏览器，应用窗口自己不导航、不开新窗口。
  // 窗口带着 preload 暴露的接口，跳到外部页面等于把这些接口交给别人。
  const openInBrowser = (url: string) => {
    if (isWebUrl(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    openInBrowser(url);
  });

  // 关窗只是隐藏，常驻托盘；真正退出走托盘菜单。
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  // 用户也可能用窗口管理器的快捷键最大化 / 还原，所以以窗口的真实状态为准，并记住这个偏好：
  // 切到悬浮窗再回来、下次启动，都恢复成用户最后的选择。
  win.on("maximize", syncMaximized);
  win.on("unmaximize", syncMaximized);

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    // 开发态用 F12 开关 DevTools。注意：开着 DevTools 时窗口不会透明。
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "F12") {
        event.preventDefault();
        win?.webContents.toggleDevTools();
      }
    });
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return win;
}

function applyMode(target: WindowMode): void {
  const w = live();
  if (!w) return;
  const cfg = getConfig();
  const full = target === "full";
  // 先改形态再动窗口：还原最大化会触发 unmaximize 事件，处理它的代码要靠它知道已经不在对话窗口形态，
  // 否则切形态时的那一次还原会把「最大化偏好」冲掉。
  mode = target;
  if (!full && w.isMaximized()) {
    // 悬浮窗是一个小条：最大化状态下 setSize 不生效，先还原。偏好已记住，回完整形态时会再最大化。
    w.unmaximize();
    // 还原是合成器异步完成的（Wayland 上尤其明显），它完成时会把窗口恢复成最大化之前的尺寸，
    // 盖掉下面设的值；而「还原完成」的通知可能早于尺寸落地。所以分几次补设，直到尺寸对上。
    settleCompactSize(w, cfg, 100, 4);
  }
  w.setSize(full ? cfg.fullWidth : cfg.compactWidth, full ? cfg.fullHeight : cfg.compactHeight, true);
  // Wayland 不允许客户端置顶，这一项在 KDE 上不生效。需要的话用窗口规则「保持在最前」。
  w.setAlwaysOnTop(!full, "floating");
  w.setSkipTaskbar(!full);
}

/** 按记住的偏好最大化对话窗口。 */
function restoreMaximize(): void {
  const w = live();
  if (w && getConfig().fullMaximized && !w.isMaximized()) w.maximize();
}

/**
 * 从最大化切到悬浮窗后核对尺寸，不对就补设。间隔逐次加倍（100、200、400、800ms），
 * 合成器慢一点也兜得住，总共也只有几次。
 * 形态已经不是悬浮窗、或窗口又最大化了，就停手，别把用户后来的操作盖掉。
 */
function settleCompactSize(w: BrowserWindow, cfg: AppConfig, delayMs: number, attempts: number): void {
  setTimeout(() => {
    if (w.isDestroyed() || mode !== "compact" || w.isMaximized()) return;
    const [width, height] = w.getSize();
    if (width !== cfg.compactWidth || height !== cfg.compactHeight) {
      w.setSize(cfg.compactWidth, cfg.compactHeight, false);
    }
    if (attempts > 1) settleCompactSize(w, cfg, delayMs * 2, attempts - 1);
  }, delayMs);
}

/** 把窗口的真实最大化状态记进配置（只在对话窗口形态下算数）并通知渲染进程。 */
function syncMaximized(): void {
  const w = live();
  if (!w) return;
  const maximized = w.isMaximized();
  // 悬浮窗永远不最大化，不算数：不然切形态时那一次还原会把偏好冲掉。
  if (mode === "full" && getConfig().fullMaximized !== maximized) {
    try {
      saveConfig({ ...getConfig(), fullMaximized: maximized });
    } catch (err) {
      // 写不进去只影响下次启动的样子，不值得打断用户。
      console.error("保存窗口最大化偏好失败：", err);
    }
  }
  w.webContents.send(WINDOW_MAXIMIZED_CHANNEL, maximized);
}

export function isMaximized(): boolean {
  const w = live();
  return !!w && w.isMaximized();
}

/** 最大化 / 还原对话窗口。 */
export function toggleMaximize(): void {
  const w = live();
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
}

/** 显示并聚焦到指定形态。 */
export function showWindow(target: WindowMode): void {
  if (!win) return;
  applyMode(target);
  if (target === "compact") placeCompact();
  win.show();
  win.focus();
  if (target === "full") restoreMaximize();
  broadcastMode();
}

export function hideWindow(): void {
  win?.hide();
}

/** 快捷键 / 托盘的开关：可见且有焦点就藏；没可见就按悬浮窗唤起；否则只抢焦点。 */
export function toggleWindow(): void {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) {
    win.hide();
    return;
  }
  if (!win.isVisible()) {
    showWindow("compact");
    return;
  }
  win.focus();
}

/** 切形态并保持可见。 */
export function switchMode(target: WindowMode): void {
  const w = live();
  if (!w) return;
  applyMode(target);
  if (target === "full") restoreMaximize();
  broadcastMode();
}

/** 配置里的尺寸改了：按当前形态重新应用。 */
export function reapplyMode(): void {
  const w = live();
  if (w) applyMode(mode);
}

/** 临时调整尺寸（如悬浮窗展开会话列表时加高）。省略的轴保持不变。 */
export function resizeWindow(request: { width: number | null; height: number | null }): void {
  const w = live();
  if (!w) return;
  const next = resolveSize({ width: request.width, height: request.height }, sizeOf(w));
  if (next) w.setSize(next.width, next.height, true);
}

function broadcastMode(): void {
  live()?.webContents.send(WINDOW_MODE_CHANNEL, mode);
}

/** 返回可用的窗口引用。用返回值而不是布尔函数，类型收窄才生效。 */
function live(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

function sizeOf(w: BrowserWindow): { width: number; height: number } {
  const [width, height] = w.getSize();
  return { width: width ?? 0, height: height ?? 0 };
}

/** 悬浮窗放在鼠标所在屏幕的工作区、上三分之一处（Raycast 式）。 */
function placeCompact(): void {
  // Wayland 下客户端不能自定位，由 compositor 放置。
  if (isWayland()) return;
  const w = live();
  if (!w) return;
  const { width, height } = sizeOf(w);
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  w.setPosition(
    Math.round(area.x + (area.width - width) / 2),
    Math.round(area.y + (area.height - height) / 3),
  );
}

function isWayland(): boolean {
  return (
    process.env.XDG_SESSION_TYPE === "wayland" || app.commandLine.getSwitchValue("ozone-platform") === "wayland"
  );
}

function isSelfTest(): boolean {
  return Boolean(process.env.DESKTOP_AGENT_SELFTEST);
}
