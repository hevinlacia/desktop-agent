/**
 * 会话常驻池的调度纯函数（REQ-346）。
 *
 * 池的活体逻辑在 host.ts（依赖 pi SDK），这里只放可单测的决策函数：
 * 驱逐选择、闲置挂起选择、消息往前分页切片。
 */
import { DEFAULT_SESSION_POOL_SIZE } from "@shared/config";

export interface PoolEntryState {
  lastUsedAt: number;
  /** 正在跑任务（流式/压缩）的会话不能驱逐或挂起。 */
  busy: boolean;
}

/**
 * 选一个驱逐目标：非当前、不忙、最近使用最久的优先。
 * 没有可驱逐的（全是当前/忙碌）返回 null——允许池暂时超员，忙会话不能杀。
 */
export function pickEvict(
  entries: ReadonlyMap<string, PoolEntryState>,
  currentKey: string | null,
): string | null {
  let victim: string | null = null;
  let oldest = Number.POSITIVE_INFINITY;
  for (const [key, entry] of entries) {
    if (key === currentKey || entry.busy) continue;
    if (entry.lastUsedAt < oldest) {
      oldest = entry.lastUsedAt;
      victim = key;
    }
  }
  return victim;
}

/**
 * 选出闲置超时的会话（挂起）：非当前、不忙、距上次使用超过 idleMs。
 * 返回按 lastUsedAt 升序（最久未用先挂），调用方逐个 dispose。
 */
export function pickIdle(
  entries: ReadonlyMap<string, PoolEntryState>,
  currentKey: string | null,
  now: number,
  idleMs: number,
): string[] {
  if (idleMs <= 0) return [];
  const idle: Array<{ key: string; lastUsedAt: number }> = [];
  for (const [key, entry] of entries) {
    if (key === currentKey || entry.busy) continue;
    if (now - entry.lastUsedAt >= idleMs) idle.push({ key, lastUsedAt: entry.lastUsedAt });
  }
  return idle.sort((a, b) => a.lastUsedAt - b.lastUsedAt).map((e) => e.key);
}

export interface MessagePage<T> {
  items: T[];
  /** 再往前（更早）还有没有。 */
  hasMore: boolean;
}

export const MAX_SESSION_POOL = 50;

/** 池大小夹到 [1, 50]；非法值回默认 10。 */
export function clampPoolSize(v: number, max = MAX_SESSION_POOL): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_SESSION_POOL_SIZE;
  return Math.min(max, Math.max(1, n));
}

/**
 * 从尾部往前取一页，跳过末尾已加载的 `skipFromEnd` 条（REQ-346）。
 * `messages` 按时间升序（旧→新）；`count` 是每页条数，`skipFromEnd` 是已加载条数游标。
 */
export function pageSlice<T>(messages: readonly T[], skipFromEnd: number, count: number): MessagePage<T> {
  const total = messages.length;
  const size = Math.max(1, Math.floor(count));
  const skip = Math.max(0, Math.floor(skipFromEnd));
  const end = Math.max(0, total - skip);
  const start = Math.max(0, end - size);
  return { items: messages.slice(start, end), hasMore: start > 0 };
}
