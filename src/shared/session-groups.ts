/**
 * 会话分组与会话开关（纯函数）。
 *
 * 模型（REQ-341）：
 * - 分组 = 一个工作目录。会话在磁盘上本来就按 cwd 分目录存放，这里只是把它显式化管理。
 * - 每个分组记一份「打开的会话」清单（session 文件路径），持久化在 config.json，
 *   所以关掉应用再打开，那几条会话仍然在（前提：文件还在）。
 * - 不在「打开」清单里的会话 = 已关闭 → 进「历史会话」，按最后活跃时间倒序、分页展示。
 */
import type { SessionGroup } from "./protocol";

/** 历史会话一页条数（用户口径：一页只展示最近的 30 个）。 */
export const HISTORY_PAGE_SIZE = 30;

export interface GroupState {
  groups: SessionGroup[];
  activeGroupId: string | null;
  /** groupId → 打开的会话路径（最近的在前）。 */
  openSessions: Record<string, string[]>;
}

/** 取目录展示名：取最后一段，去掉空的尾斜杠。根目录返回 "/"。 */
export function labelForPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  if (!trimmed) return path.startsWith("/") ? "/" : path;
  const parts = trimmed.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

/** 造一个分组 id：路径 + 时间戳，够稳且可读（不引第三方 uuid）。 */
export function newGroupId(path: string, now = Date.now()): string {
  const slug = labelForPath(path).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "group"}-${now.toString(36)}`;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/[/\\]+$/, "") === b.replace(/[/\\]+$/, "");
}

/**
 * 迁移 + 兜底：老配置只有 cwd，没有分组 → 用它种一个分组；
 * activeGroupId 丢了或指向不存在的分组 → 指到第一个。
 */
export function ensureGroups(state: GroupState, cwd: string): GroupState {
  const groups = [...state.groups];
  if (groups.length === 0) {
    groups.push({ id: newGroupId(cwd, 0), path: cwd, label: labelForPath(cwd) });
  }
  const active = groups.some((g) => g.id === state.activeGroupId)
    ? (state.activeGroupId as string)
    : groups[0]!.id;
  return { ...state, groups, activeGroupId: active };
}

export function activeGroup(state: GroupState): SessionGroup | undefined {
  return state.groups.find((g) => g.id === state.activeGroupId);
}

/** 新建分组；目录已存在于某个分组时直接复用（返回 existingId）。 */
export function addGroup(
  state: GroupState,
  path: string,
  now = Date.now(),
): { state: GroupState; group: SessionGroup; existing: boolean } {
  const found = state.groups.find((g) => samePath(g.path, path));
  if (found) return { state: { ...state, activeGroupId: found.id }, group: found, existing: true };
  const group: SessionGroup = { id: newGroupId(path, now), path, label: labelForPath(path) };
  return {
    state: { groups: [...state.groups, group], activeGroupId: group.id, openSessions: state.openSessions },
    group,
    existing: false,
  };
}

export function removeGroup(state: GroupState, groupId: string): GroupState {
  const groups = state.groups.filter((g) => g.id !== groupId);
  const openSessions = { ...state.openSessions };
  delete openSessions[groupId];
  const activeGroupId =
    state.activeGroupId === groupId ? (groups[0]?.id ?? null) : state.activeGroupId;
  return { groups, activeGroupId, openSessions };
}

/** 重命名分组：只改 label（id 与 path 不变——id 是 openSessions 的 key，改了会丢清单）。 */
export function renameGroup(state: GroupState, groupId: string, label: string): GroupState {
  const trimmed = label.trim();
  if (!trimmed) return state;
  const hit = state.groups.find((g) => g.id === groupId);
  if (!hit || hit.label === trimmed) return state;
  return {
    ...state,
    groups: state.groups.map((g) => (g.id === groupId ? { ...g, label: trimmed } : g)),
  };
}

export function setActiveGroup(state: GroupState, groupId: string): GroupState {
  if (!state.groups.some((g) => g.id === groupId)) return state;
  return { ...state, activeGroupId: groupId };
}

/** 打开一个会话：放到清单最前（最近活跃在前），重复打开只挪位置。 */
export function openSession(state: GroupState, groupId: string, sessionPath: string): GroupState {
  const current = state.openSessions[groupId] ?? [];
  const next = [sessionPath, ...current.filter((p) => p !== sessionPath)];
  return { ...state, openSessions: { ...state.openSessions, [groupId]: next } };
}

/** 关闭一个会话：从清单移除（文件不删，之后可在历史会话里找回）。 */
export function closeSession(state: GroupState, groupId: string, sessionPath: string): GroupState {
  const current = state.openSessions[groupId] ?? [];
  return {
    ...state,
    openSessions: { ...state.openSessions, [groupId]: current.filter((p) => p !== sessionPath) },
  };
}

/** 把某分组里指向已不存在文件的会话剔掉（应用启动对账用）。 */
export function pruneMissing(
  state: GroupState,
  groupId: string,
  exists: (path: string) => boolean,
): GroupState {
  const current = state.openSessions[groupId] ?? [];
  const next = current.filter(exists);
  if (next.length === current.length) return state;
  return { ...state, openSessions: { ...state.openSessions, [groupId]: next } };
}

/** 历史会话候选：全部会话里排除已打开的。 */
export function historySessions<T extends { path: string; modifiedMs?: number }>(
  all: T[],
  openPaths: string[],
): T[] {
  const opened = new Set(openPaths);
  return all
    .filter((s) => !opened.has(s.path))
    .sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0));
}

/**
 * 会话搜索：匹配 name / sessionId / 文件名片段，大小写不敏感；query 空 = 原样返回（同一数组）。
 * 「打开的会话」与「历史会话」共用（REQ-344 ①）：前者把路径解析成展示名后当 name 传入。
 */
export interface SessionSearchable {
  path: string;
  sessionId?: string;
  /** 展示名；兼容 SessionSummary 的 null（无名字时退文件名匹配）。 */
  name?: string | null;
}

export function filterSessions<T extends SessionSearchable>(list: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) => matchesSession(s, q));
}

function matchesSession(s: SessionSearchable, q: string): boolean {
  const file = s.path.split(/[\\/]/).pop() ?? s.path;
  return (
    (s.name ?? "").toLowerCase().includes(q) ||
    (s.sessionId ?? "").toLowerCase().includes(q) ||
    file.toLowerCase().includes(q)
  );
}

export interface HistoryPage<T> {
  items: T[];
  /** 还能继续加载的剩余条数。 */
  remaining: number;
  /** 已经展示到的位置（下次从这里继续）。 */
  shown: number;
}

/** 历史会话分页：`visible` 是「这一屏展示多少条」，默认一页 30，点一次加一页。 */
export function historyPage<T>(sorted: T[], visible: number, pageSize = HISTORY_PAGE_SIZE): HistoryPage<T> {
  const count = Math.max(pageSize, visible);
  const items = sorted.slice(0, count);
  return { items, remaining: Math.max(0, sorted.length - items.length), shown: items.length };
}
