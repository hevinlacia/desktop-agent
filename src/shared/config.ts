import type { AppConfig, SessionGroup } from "./protocol";

/** 窗口尺寸下限，创建窗口时作为 minWidth / minHeight，也是 resize 的夹取下限。 */
export const MIN_WINDOW = { width: 420, height: 56 } as const;
const MIN_FULL_HEIGHT = 200;

export const DEFAULT_SHORTCUT = "Super+Space";

/** 会话常驻池默认大小与闲置挂起默认分钟数（REQ-346，设置页可改）。 */
export const DEFAULT_SESSION_POOL_SIZE = 10;
export const DEFAULT_SESSION_IDLE_SUSPEND_MINUTES = 10;
export const MAX_SESSION_POOL_SIZE = 50;

export function defaultConfig(homeDir: string): AppConfig {
  return {
    cwd: homeDir,
    persistSession: true,
    extensions: true,
    toggleShortcut: DEFAULT_SHORTCUT,
    compactWidth: 720,
    compactHeight: 132,
    fullWidth: 1080,
    fullHeight: 720,
    fullMaximized: false,
    lastModel: null,
    panelUrl: "",
    groups: [],
    activeGroupId: null,
    openSessions: {},
    sessionPoolSize: DEFAULT_SESSION_POOL_SIZE,
    sessionIdleSuspendMinutes: DEFAULT_SESSION_IDLE_SUSPEND_MINUTES,
  };
}

/**
 * 把读到的任意 JSON 合并成合法配置：未知字段丢弃，非法值回退默认值。
 * 纯函数，方便单测；文件读写与 cwd 是否存在由调用方负责。
 */
export function resolveConfig(raw: unknown, homeDir: string): AppConfig {
  const d = defaultConfig(homeDir);
  if (!isRecord(raw)) return d;
  return {
    cwd: expandHome(text(raw.cwd) ?? d.cwd, homeDir),
    persistSession: bool(raw.persistSession, d.persistSession),
    extensions: bool(raw.extensions, d.extensions),
    toggleShortcut: shortcut(raw.toggleShortcut) ?? d.toggleShortcut,
    compactWidth: num(raw.compactWidth, d.compactWidth, MIN_WINDOW.width),
    compactHeight: num(raw.compactHeight, d.compactHeight, MIN_WINDOW.height),
    fullWidth: num(raw.fullWidth, d.fullWidth, MIN_WINDOW.width),
    fullHeight: num(raw.fullHeight, d.fullHeight, MIN_FULL_HEIGHT),
    fullMaximized: bool(raw.fullMaximized, d.fullMaximized),
    lastModel: modelRef(raw.lastModel),
    panelUrl: text(raw.panelUrl) ?? d.panelUrl,
    groups: groups(raw.groups),
    activeGroupId: text(raw.activeGroupId) ?? null,
    openSessions: openSessions(raw.openSessions),
    // 池大小夹到 [1, 50]；闲置分钟允许 0（= 不挂起），上限 24h 够用了
    sessionPoolSize: num(raw.sessionPoolSize, d.sessionPoolSize, 1, MAX_SESSION_POOL_SIZE),
    sessionIdleSuspendMinutes: num(raw.sessionIdleSuspendMinutes, d.sessionIdleSuspendMinutes, 0, 1440),
  };
}

/** 把开头的 `~` 展开成家目录，其余原样返回。用户在设置里手输 `~/x` 时用得上。 */
function expandHome(dir: string, homeDir: string): string {
  if (dir === "~") return homeDir;
  return dir.startsWith("~/") ? homeDir + dir.slice(1) : dir;
}

/** 模型引用要 provider 和 id 都齐全才有效，否则当作没有。 */
function modelRef(v: unknown): { provider: string; id: string } | null {
  if (!isRecord(v)) return null;
  const provider = text(v.provider);
  const id = text(v.id);
  return provider && id ? { provider, id } : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * 快捷键取「原样 trim 后的字符串」：空字符串也要保留。
 * 清空 = 不注册全局快捷键（自己用系统自定义快捷键调 `desktop-agent toggle`），
 * 所以要能和「没写这个字段」区分开（REQ-342）。
 */
function shortcut(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown, fallback: number, min: number, max = Number.POSITIVE_INFINITY): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

/**
 * 把请求的窗口尺寸夹到合法范围。`null` 或非有限值表示该轴沿用当前值；
 * 返回 `null` 表示无需调整。
 */
export function resolveSize(
  requested: { width: number | null; height: number | null },
  current: { width: number; height: number },
): { width: number; height: number } | null {
  const width = pick(requested.width, current.width, MIN_WINDOW.width);
  const height = pick(requested.height, current.height, MIN_WINDOW.height);
  return width === current.width && height === current.height ? null : { width, height };
}

function pick(want: number | null, cur: number, min: number): number {
  return typeof want === "number" && Number.isFinite(want) ? Math.max(want, min) : cur;
}

/** 分组列表：脏数据（缺 path / 重复 id）逐项丢弃，不让坏配置把侧边栏搞崩。 */
function groups(v: unknown): SessionGroup[] {
  if (!Array.isArray(v)) return [];
  const out: SessionGroup[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (!isRecord(item)) continue;
    const path = text(item.path);
    const id = text(item.id);
    if (!path || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, path, label: text(item.label) ?? path.replace(/[/\\]+$/, "").split(/[/\\]+/).pop() ?? path });
  }
  return out;
}

/** 打开会话清单：只保留「groupId → 字符串数组」这一种形状。 */
function openSessions(v: unknown): Record<string, string[]> {
  if (!isRecord(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!Array.isArray(value)) continue;
    out[key] = value.filter((p): p is string => typeof p === "string" && p.length > 0);
  }
  return out;
}
