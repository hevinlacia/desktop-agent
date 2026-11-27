/**
 * 分组会话的轻量扫描（REQ-346 修复轮二）。
 *
 * pi 的 SessionManager.list/listAll 会对每个文件**全量逐行读取并 parse**（O(总字节)），
 * 1929 个文件几百 MB 时单次 12-16s。这里只读每个文件**头部 64KB**（header 的
 * sessionId/cwd/timestamp + 早期 session_info 的 name），活跃时间用 stat mtime 近似
 * （append-only 文件 mtime ≈ 最后活跃），并发扫描。完整原文始终留给 pi 自己按需读。
 */
import { open, readdir, stat } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { SessionSummary } from "@shared/protocol";

/** pi 的会话目录命名（dist/core/session-manager.js getDefaultSessionDirPath）：/ \ : 换成 -，再用 -- 包裹。 */
export function sessionDirPath(agentDir: string, cwd: string): string {
  const safePath = `--${resolvePath(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolvePath(agentDir), "sessions", safePath);
}

export interface SessionHead {
  sessionId: string;
  cwd: string;
  name?: string;
  startedAtMs?: number;
}

/** 解析头部文本：第一个 `type:"session"` 行是 header，随后最近的 `session_info` 行提供名字。 */
export function parseSessionHead(headText: string): SessionHead | null {
  let head: SessionHead | null = null;
  for (const line of headText.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    if (!head) {
      if (entry.type !== "session") return null;
      const sessionId = typeof entry.id === "string" ? entry.id : "";
      const cwd = typeof entry.cwd === "string" ? entry.cwd : "";
      if (!sessionId || !cwd) return null;
      const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
      head = { sessionId, cwd, ...(Number.isNaN(ts) ? {} : { startedAtMs: ts }) };
      continue;
    }
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      head = { ...head, name: entry.name.trim() };
      break;
    }
  }
  return head;
}

const SCAN_HEAD_BYTES = 64 * 1024;
const SCAN_CONCURRENCY = 16;

/** 扫描一组分组目录：只读头部 + mtime，按最后活跃倒序，跨目录按路径去重。 */
export async function scanGroupSessionDirs(agentDir: string, cwds: string[]): Promise<SessionSummary[]> {
  const dirs = [...new Set(cwds.map((c) => sessionDirPath(agentDir, c)))];
  const perDir = await Promise.all(dirs.map((dir) => scanDir(dir)));
  const byPath = new Map<string, SessionSummary>();
  for (const list of perDir) {
    for (const s of list) byPath.set(s.path, s);
  }
  return [...byPath.values()].sort((a, b) => b.modifiedMs - a.modifiedMs);
}

async function scanDir(dir: string): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // 分组还没有会话目录：正常
  }
  const files = names.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
  const results = await mapLimit(files, SCAN_CONCURRENCY, async (path) => {
    try {
      const [stats, head] = await Promise.all([stat(path), readHead(path, SCAN_HEAD_BYTES)]);
      const parsed = head ? parseSessionHead(head) : null;
      if (!parsed) return null;
      const summary: SessionSummary = {
        path,
        sessionId: parsed.sessionId,
        name: parsed.name ?? null,
        modifiedMs: Math.round(stats.mtimeMs),
        sizeBytes: stats.size,
        messageCount: 0, // 轻量扫描不数消息；渲染层不消费这个字段
      };
      return summary;
    } catch {
      return null;
    }
  });
  return results.filter((s): s is SessionSummary => s !== null);
}

async function readHead(path: string, bytes: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
