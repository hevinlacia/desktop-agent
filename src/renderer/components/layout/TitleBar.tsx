import { MessageSquarePlus, MoreHorizontal, PanelTop, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "@/stores/useAgentStore";
import { windowClient, type SessionSummary, agentClient } from "@/services/agentClient";
import { cn, formatTokens } from "@/lib/utils";
import type { WindowMode } from "@shared/protocol";

/**
 * 自绘标题栏：无边框窗口下负责拖拽与形态切换。
 * `.app-drag`（-webkit-app-region: drag）让 Electron 接管拖拽，无需 JS 处理坐标。
 */
export function TitleBar({ mode }: { mode: WindowMode }) {
  const sessionName = useAgentStore((s) => s.sessionName);
  const stats = useAgentStore((s) => s.stats);
  const model = useAgentStore((s) => s.model);
  const setMode = useAgentStore((s) => s.setMode);
  const newSession = useAgentStore((s) => s.newSession);

  const pct = stats?.contextUsage?.percent ?? null;

  return (
    <div
      className="app-drag flex h-8 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-surface-raised px-2.5"
    >
      <div
        className="app-drag flex min-w-0 flex-1 items-center gap-1.5 text-[11.5px] text-ink-muted"
      >
        <span className="shrink-0 font-medium text-ink/80">Desktop Agent</span>
        {sessionName && (
          <>
            <span className="shrink-0 opacity-40">·</span>
            <span className="truncate">{sessionName}</span>
          </>
        )}
        {!sessionName && model && (
          <>
            <span className="shrink-0 opacity-40">·</span>
            <span className="truncate">{model.name}</span>
          </>
        )}
      </div>

      {pct !== null && (
        <div
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums",
            pct > 80 ? "bg-danger/10 text-danger" : "text-ink-muted/70",
          )}
          title={`上下文 ${formatTokens(stats?.contextUsage?.tokens ?? 0)} / ${formatTokens(stats?.contextUsage?.contextWindow ?? 0)}`}
        >
          {pct.toFixed(0)}%
        </div>
      )}

      <div className="flex shrink-0 items-center gap-0.5">
        <BarButton label="新建会话" onClick={() => void newSession()}>
          <MessageSquarePlus size={12} />
        </BarButton>
        <SessionMenu />
        <BarButton
          label={mode === "compact" ? "展开" : "收起为悬浮窗"}
          onClick={() => void setMode(mode === "compact" ? "full" : "compact")}
        >
          <PanelTop size={12} />
        </BarButton>
        <BarButton label="收起窗口" onClick={() => void windowClient.hide()}>
          <X size={12} />
        </BarButton>
      </div>
    </div>
  );
}

function BarButton({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-6 place-items-center rounded text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
    >
      {children}
    </button>
  );
}

/** 历史会话切换菜单。 */
function SessionMenu() {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const switchSession = useAgentStore((s) => s.switchSession);
  const currentFile = useAgentStore((s) => s.sessionFile);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    agentClient
      .sessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [open]);

  // 点击外部关闭。
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <BarButton label="历史会话" onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal size={12} />
      </BarButton>
      {open && (
        <div className="absolute right-0 top-7 z-30 max-h-72 w-64 overflow-y-auto scroll-thin rounded-lg border border-border-subtle bg-surface-raised py-1 shadow-lg">
          {loading && (
            <div className="px-2.5 py-2 text-[11.5px] text-ink-muted">加载中…</div>
          )}
          {!loading && sessions.length === 0 && (
            <div className="px-2.5 py-2 text-[11.5px] text-ink-muted">该目录暂无历史会话</div>
          )}
          {sessions.map((s) => (
            <button
              key={s.path}
              type="button"
              onClick={() => {
                setOpen(false);
                void switchSession(s.path);
              }}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left transition hover:bg-surface-sunken",
                s.path === currentFile && "bg-accent-soft/50",
              )}
            >
              <span className="w-full truncate text-[11.5px] text-ink">
                {s.name || s.sessionId.slice(0, 8)}
              </span>
              <span className="text-[10px] text-ink-muted/70">
                {new Date(s.modifiedMs).toLocaleString("zh-CN", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
