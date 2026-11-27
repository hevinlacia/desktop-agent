import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import type { PanelRequirement, PanelRequirementBundle } from "@shared/protocol";
import { agentClient } from "@/services/agentClient";
import { useAgentStore } from "@/stores/useAgentStore";
import { cn } from "@/lib/utils";
import { pollDue, requirementPageUrl, REQ_PANEL_POLL_MS } from "@/lib/reqPanel";

const COLLAPSE_KEY = "desktop-agent:req-panel-collapsed";

/** 状态色：与面板的主要分组对齐（进行中 / 待确认 / 已收口），不追求逐状态精确。 */
const STATUS_STYLE: Record<string, string> = {
  待核实: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  修复中: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  待审查: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  已合并: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  需求澄清: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  开发中: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  自测中: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  测试中: "border-indigo-500/40 bg-indigo-500/10 text-indigo-300",
  人工核查: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300",
  发布就绪: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  已完成: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  已发布: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  挂起: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400",
  已关闭: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400",
};

/** 状态未知时也要有颜色，别渲染成半个空壳。 */
function statusClass(status: string): string {
  return STATUS_STYLE[status] ?? "border-border-subtle bg-surface-sunken text-ink-muted";
}

function formatUpdated(ts: number | undefined): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/**
 * 右侧需求信息栏（REQ-345）。
 *
 * - 只在完整形态出现：悬浮窗只有 132px 高，塞不进侧栏。
 * - 数据来自主进程代理的 Agent Panel（按当前会话的 sessionId 反查绑定需求）。
 * - 刷新时机：会话切换、展开需求栏、页面从隐藏恢复、页面可见时每 30s（REQ_PANEL_POLL_MS）。
 * - 失败容错：拿不到数据时保留上一次的成功结果并标「已过期」（stale），空着比误导强，误导比报错强。
 * - 折叠状态记在 localStorage，默认展开；折叠后是一条窄轨，点箭头展开。
 */
export function RequirementPanel() {
  const sessionId = useAgentStore((s) => s.sessionId);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  const [bundle, setBundle] = useState<PanelRequirementBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  /** 上次成功刷新的时间；ref 给轮询判定用，避免 interval 随每次刷新重建。 */
  const bundleRef = useRef<PanelRequirementBundle | null>(null);
  const lastFetchedRef = useRef<number | null>(null);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  /**
   * 拉一次需求。失败（ok:false 或网络异常）分两种：
   * - 从没成功过：展示错误卡（没数据可保留）；
   * - 有旧数据：保留旧数据 + 标 stale，不清空（会话切换前的信息仍比空白有用）。
   */
  const reload = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      try {
        const next = await agentClient.panelRequirements(sessionId);
        if (next.ok || !bundleRef.current?.ok) {
          bundleRef.current = next;
          setBundle(next);
          setLastError(next.ok ? null : (next.error ?? "读取失败"));
          setStale(!next.ok);
          lastFetchedRef.current = Date.now();
        } else {
          setLastError(next.error ?? "读取失败");
          setStale(true);
        }
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
        if (bundleRef.current?.ok) setStale(true);
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [sessionId],
  );

  // 刷新时机（REQ-345）：sessionId 变 / 展开栏时立即刷；页面可见时每 30s 轮询；
  // 从隐藏恢复时立即刷一次；隐藏或折叠期间 interval 空转（pollDue 拦下，不发请求）。
  useEffect(() => {
    if (!collapsed) void reload({ silent: true });
    const timer = window.setInterval(() => {
      const due = pollDue(Date.now(), lastFetchedRef.current, {
        visible: document.visibilityState === "visible",
        collapsed,
      });
      if (due) void reload({ silent: true });
    }, REQ_PANEL_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !collapsed) void reload({ silent: true });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reload, collapsed]);

  if (collapsed) {
    return (
      <div className="flex w-7 shrink-0 flex-col items-center border-l border-border-subtle bg-surface-sunken/40 py-2">
        <button
          type="button"
          title="展开需求栏"
          onClick={() => setCollapsed(false)}
          className="rounded p-1 text-ink-muted transition hover:bg-surface-raised hover:text-ink"
        >
          <ChevronLeft size={13} />
        </button>
        {stale && <span className="mt-1 size-1.5 rounded-full bg-amber-400/80" title="数据已过期，展开后自动刷新" />}
        <span className="mt-2 select-none text-[10px] leading-tight text-ink-muted/60 [writing-mode:vertical-rl]">
          需求
        </span>
      </div>
    );
  }

  const requirements = bundle?.requirements ?? [];

  return (
    <div className="flex w-60 shrink-0 flex-col border-l border-border-subtle bg-surface-sunken/40">
      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <span className="text-[11px] font-medium text-ink-muted">需求</span>
        {stale && (
          <span
            title={lastError ?? "刷新失败，显示的是上次成功的数据"}
            className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[9.5px] leading-none text-amber-300"
          >
            已过期
          </span>
        )}
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            title="刷新"
            onClick={() => void reload()}
            className="rounded p-1 text-ink-muted transition hover:bg-surface-raised hover:text-ink"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          </button>
          <button
            type="button"
            title="收起需求栏"
            onClick={() => setCollapsed(true)}
            className="rounded p-1 text-ink-muted transition hover:bg-surface-raised hover:text-ink"
          >
            <ChevronRight size={12} />
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-2 pb-2">
        {bundle && !bundle.ok && (
          <div className="rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-[11px] leading-relaxed text-ink-muted">
            {bundle.error ?? "读取失败"}
            {bundle.hubUrl && (
              <div className="mt-1 truncate text-[10px] text-ink-muted/60">{bundle.hubUrl}</div>
            )}
          </div>
        )}

        {bundle?.ok && requirements.length === 0 && (
          <div className="px-1 py-2 text-[11px] leading-relaxed text-ink-muted/60">
            当前会话没有绑定需求
          </div>
        )}

        {requirements.map((req) => (
          <RequirementCard key={req.id} req={req} hubUrl={bundle?.hubUrl ?? ""} />
        ))}
      </div>

      {bundle?.ok && bundle.hubUrl && (
        <div className="truncate border-t border-border-subtle px-2 py-1 text-[10px] text-ink-muted/50">
          {bundle.hubUrl.replace(/^https?:\/\//, "")}
        </div>
      )}
    </div>
  );
}

/**
 * 需求卡：整卡可点，系统浏览器打开面板需求页（`/requirement?id=`）。
 * 链接经 target=_blank 走 window.ts 的 setWindowOpenHandler（isWebUrl 只放行 http(s)），
 * 渲染进程不自己开窗口。hubUrl 缺失/非法时退化为纯展示卡。
 */
function RequirementCard({ req, hubUrl }: { req: PanelRequirement; hubUrl?: string }) {
  const url = requirementPageUrl(hubUrl ?? "", req.id);

  const body = (
    <>
      <div className="flex items-center justify-between gap-1">
        <span
          role={url ? "none" : "button"}
          title={`点击复制编号 ${req.id}`}
          onClick={
            url
              ? (e) => {
                  // 整卡是链接：复制编号要拦住默认跳转
                  e.preventDefault();
                  e.stopPropagation();
                  void navigator.clipboard?.writeText(req.id).catch(() => undefined);
                }
              : () => void navigator.clipboard?.writeText(req.id).catch(() => undefined)
          }
          className="truncate text-[11.5px] font-medium text-accent hover:underline"
        >
          {req.id}
        </span>
        <span
          className={cn(
            "shrink-0 rounded border px-1 py-0.5 text-[10px] leading-none",
            statusClass(req.status),
          )}
        >
          {req.status}
        </span>
      </div>
      <div className="mt-1 line-clamp-3 text-[11px] leading-snug text-ink" title={req.title}>
        {req.title || "(无标题)"}
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-ink-muted/60">
        <span className="truncate">{req.project ?? ""}</span>
        <span className="shrink-0">{formatUpdated(req.updatedAt)}</span>
      </div>
    </>
  );

  if (!url) {
    return <div className="mb-1 rounded-md border border-border-subtle bg-surface px-2 py-1.5">{body}</div>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`在面板打开 ${req.id}`}
      className="mb-1 block rounded-md border border-border-subtle bg-surface px-2 py-1.5 transition hover:border-accent/40 hover:bg-surface-raised"
    >
      {body}
    </a>
  );
}

/** 供外部（如未来托盘菜单）复用的状态色判断。 */
export { statusClass, formatUpdated };
export type { PanelRequirement };
