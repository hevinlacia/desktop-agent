/**
 * Agent Panel 访问层（主进程）。
 *
 * 为什么放主进程：渲染进程是 sandbox，且 panel 地址有内网/tailnet/自定义三种可能，
 * 让主进程统一解析与缓存，渲染层只拿结构化结果。
 *
 * 只做「读」：右侧信息栏展示当前会话绑定的需求，不写任何东西。
 */
import type { PanelRequirement, PanelRequirementBundle } from "../shared/protocol";

/** 单次请求超时：右侧栏是辅助信息，绝不能拖慢界面。 */
const REQUEST_TIMEOUT_MS = 4000;

/** 候选地址（按顺序探活，成功后缓存）。env 优先，其次内网 hub，最后 tailnet 入口。 */
export function candidateHubUrls(configUrl: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = configUrl.trim() || env.AGENT_PANEL_URL?.trim() || "";
  const list = [
    explicit,
    "http://192.168.6.133:8788",
    "https://edge.tail260d93.ts.net",
  ].filter((url): url is string => Boolean(url));
  // 去重并统一去掉尾斜杠。
  return [...new Set(list.map((url) => url.replace(/\/+$/, "")))];
}

type FetchJson = (url: string, timeoutMs: number) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
};

/** by-session 响应里我们真正用到的字段。 */
interface BySessionPayload {
  ok?: boolean;
  primaryReqId?: string;
  reqId?: string;
  reqIds?: string[];
}

/** 单条需求详情里我们真正用到的字段。 */
interface RequirementPayload {
  requirement?: {
    id?: string;
    title?: string;
    status?: string;
    project?: string;
    category?: string;
    updatedAt?: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 把 by-session + 逐条详情整理成右侧栏需要的摘要列表（纯函数，便于单测）。
 * 顺序：主需求在前，其余按 updatedAt 降序。
 */
export function summarize(
  primaryId: string | undefined,
  payloads: unknown[],
): PanelRequirement[] {
  const seen = new Set<string>();
  const out: PanelRequirement[] = [];
  for (const raw of payloads) {
    if (!isRecord(raw)) continue;
    const req = (raw as RequirementPayload).requirement;
    if (!isRecord(req)) continue;
    const id = asString(req.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: asString(req.title) ?? "",
      status: asString(req.status) ?? "未知",
      ...(asString(req.project) ? { project: asString(req.project)! } : {}),
      ...(asString(req.category) ? { category: asString(req.category)! } : {}),
      ...(typeof req.updatedAt === "number" ? { updatedAt: req.updatedAt } : {}),
    });
  }
  out.sort((a, b) => {
    if (a.id === primaryId) return -1;
    if (b.id === primaryId) return 1;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
  return out;
}

/** 从 by-session 响应里取出需要拉详情的需求 id（主需求在前）。 */
export function sessionRequirementIds(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const p = payload as BySessionPayload;
  const ids = [
    asString(p.primaryReqId) ?? asString(p.reqId),
    ...(Array.isArray(p.reqIds) ? p.reqIds.filter((id): id is string => typeof id === "string") : []),
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

/**
 * 拉一次「当前会话绑定的需求」。失败时返回 ok:false + 可展示的错误文案，
 * 不抛异常（右侧栏是辅助信息，不该冒泡成崩溃）。
 */
export async function fetchSessionRequirements(opts: {
  sessionId: string | null;
  configUrl: string;
  fetchJson?: FetchJson;
  timeoutMs?: number;
}): Promise<PanelRequirementBundle> {
  const { sessionId, configUrl } = opts;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const candidates = candidateHubUrls(configUrl);
  const lastUrl = candidates[candidates.length - 1] ?? "";

  if (!sessionId) {
    return { ok: false, hubUrl: candidates[0] ?? "", requirements: [], error: "还没有会话" };
  }

  let lastError = "Agent Panel 不可达";
  for (const hubUrl of candidates) {
    try {
      const payload = await fetchJson(
        `${hubUrl}/api/requirement/by-session?sessionId=${encodeURIComponent(sessionId)}`,
        timeoutMs,
      );
      const ids = sessionRequirementIds(payload);
      if (ids.length === 0) {
        return { ok: true, hubUrl, requirements: [] };
      }
      const primaryId = isRecord(payload)
        ? (asString((payload as BySessionPayload).primaryReqId) ?? asString((payload as BySessionPayload).reqId))
        : undefined;
      // 逐条取详情：数量通常 1–3 条，串行足够且对 hub 更友好。
      const details: unknown[] = [];
      for (const id of ids.slice(0, 8)) {
        details.push(
          await fetchJson(`${hubUrl}/api/requirement?id=${encodeURIComponent(id)}`, timeoutMs),
        );
      }
      return { ok: true, hubUrl, requirements: summarize(primaryId, details) };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // 换下一个候选地址继续试。
    }
  }
  return { ok: false, hubUrl: lastUrl, requirements: [], error: `Agent Panel 不可达（${lastError}）` };
}
