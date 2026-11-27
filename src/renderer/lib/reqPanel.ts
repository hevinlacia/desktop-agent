/**
 * 右侧需求栏的调度与链接纯函数（REQ-345）。
 *
 * 从 RequirementPanel 抽出来带单测：轮询时机、stale 判定、需求页 URL 构造。
 */

/** 轮询间隔：会话切换外，页面可见时每 30s 刷一次。 */
export const REQ_PANEL_POLL_MS = 30_000;
export interface PollGate {
  /** 页面可见才轮询（悬浮窗常驻后台，隐藏时空转无意义）。 */
  visible: boolean;
  /** 折叠成窄轨时不刷（展开时会先拉一次）。 */
  collapsed: boolean;
  intervalMs?: number;
}

/** 是否该发起一次刷新：可见、未折叠、且距上次成功刷新已到一个周期（从未成功过则立即刷）。 */
export function pollDue(now: number, lastFetchedAt: number | null, gate: PollGate): boolean {
  if (!gate.visible || gate.collapsed) return false;
  if (lastFetchedAt === null) return true;
  return now - lastFetchedAt >= (gate.intervalMs ?? REQ_PANEL_POLL_MS);
}

/**
 * 需求卡对应的 Agent Panel 页面 URL（`/requirement?id=<id>`）。
 * hubUrl 为空或拼不出 http(s) 地址时返回 null（卡片退化为不可点，不复制进 href）。
 */
export function requirementPageUrl(hubUrl: string, id: string): string | null {
  if (!hubUrl || !id) return null;
  try {
    const url = new URL(`/requirement?id=${encodeURIComponent(id)}`, hubUrl);
    const { protocol } = url;
    if (protocol !== "http:" && protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
