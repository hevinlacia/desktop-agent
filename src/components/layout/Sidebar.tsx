import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings2,
} from "lucide-react";
import { agentClient, type SessionSummary } from "@/services/agentClient";
import { useAgentStore } from "@/stores/useAgentStore";
import { cn, formatTokens } from "@/lib/utils";

const COLLAPSE_KEY = "desktop-agent:sidebar-collapsed";
const WIDTH_KEY = "desktop-agent:sidebar-width";
const MIN_WIDTH = 180;
const MAX_WIDTH = 360;

/**
 * 会话侧边栏。
 *
 * 职责边界：只管"选择/新建会话"和轻量状态展示，不持有对话数据（那在 store 里）。
 * 会话列表来自 Rust 侧扫描 pi 的 sessions 目录（`agent_sessions`），
 * 这样不需要客户端镜像 pi 的存储结构。
 */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === "1",
  );
  const [width, setWidth] = useState(() => {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(raw) && raw >= MIN_WIDTH && raw <= MAX_WIDTH ? raw : 224;
  });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const currentFile = useAgentStore((s) => s.sessionFile);
  const sessionName = useAgentStore((s) => s.sessionName);
  const switchSession = useAgentStore((s) => s.switchSession);
  const newSession = useAgentStore((s) => s.newSession);
  const stats = useAgentStore((s) => s.stats);

  // 会话列表按需刷新：首次挂载 + 运行结束（新会话可能已落盘）。
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setSessions(await agentClient.sessions());
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (collapsed) return;
    void reload();
  }, [collapsed, reload, sessionName, stats?.totalMessages]);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);

  // 拖拽改变宽度
  const dragging = useRef(false);
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const move = (ev: MouseEvent) => {
      if (!dragging.current) return;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX)));
    };
    const up = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  const filtered = query
    ? sessions.filter(
        (s) =>
          (s.name ?? "").toLowerCase().includes(query.toLowerCase()) ||
          s.sessionId.includes(query),
      )
    : sessions;

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border-subtle bg-surface-sunken/50 py-2">
        <SideButton label="展开侧边栏" onClick={() => setCollapsed(false)}>
          <PanelLeftOpen size={14} />
        </SideButton>
        <SideButton label="新建会话" onClick={() => void newSession()}>
          <Plus size={14} />
        </SideButton>
      </aside>
    );
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-border-subtle bg-surface-sunken/50"
      style={{ width }}
    >
      <div className="flex items-center gap-1 px-2 pb-1 pt-2">
        <span className="flex-1 text-[10.5px] font-medium uppercase tracking-wide text-ink-muted/60">
          会话
        </span>
        <SideButton label="新建会话" onClick={() => void newSession()}>
          <Plus size={13} />
        </SideButton>
        <SideButton label="收起侧边栏" onClick={() => setCollapsed(true)}>
          <PanelLeftClose size={13} />
        </SideButton>
      </div>

      <div className="relative px-2">
        <Search
          size={11}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-muted/50"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索会话"
          className="w-full rounded-md border border-border-subtle bg-surface py-1 pl-6 pr-2 text-[11.5px] outline-none transition placeholder:text-ink-muted/50 focus:border-accent/50"
        />
      </div>

      <div className="mt-1.5 min-h-0 flex-1 overflow-y-auto scroll-thin px-1.5 pb-1">
        {loading && sessions.length === 0 && (
          <div className="px-2 py-2 text-[11px] text-ink-muted/60">加载中…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="px-2 py-3 text-center text-[11px] leading-relaxed text-ink-muted/60">
            {query ? "没有匹配的会话" : "此目录暂无历史会话"}
          </div>
        )}
        {filtered.map((s) => {
          const active = s.path === currentFile;
          return (
            <button
              key={s.path}
              type="button"
              onClick={() => void switchSession(s.path)}
              className={cn(
                "group mb-0.5 flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition",
                active ? "bg-accent-soft" : "hover:bg-surface-raised",
              )}
            >
              <span className="flex w-full items-center gap-1">
                <MessageSquare
                  size={10}
                  className={cn("shrink-0", active ? "text-accent" : "text-ink-muted/50")}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[11.5px]",
                    active ? "font-medium text-accent" : "text-ink",
                  )}
                >
                  {s.name || s.sessionId.slice(0, 8) || "未命名"}
                </span>
              </span>
              <span className="pl-3.5 text-[10px] text-ink-muted/60">
                {formatWhen(s.modifiedMs)} · {formatSize(s.sizeBytes)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-border-subtle px-2 py-1.5">
        {stats && (
          <div className="mb-1 flex items-center justify-between text-[10px] text-ink-muted/70">
            <span>{stats.totalMessages} 条消息</span>
            <span className="tabular-nums">
              {(stats.contextUsage?.percent ?? 0).toFixed(0)}% ctx
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-ink-muted transition hover:bg-surface-raised hover:text-ink"
        >
          <Settings2 size={11} />
          设置
        </button>
      </div>

      {/* 宽度拖拽把手 */}
      <div
        onMouseDown={onDragStart}
        className="absolute -right-0.5 top-0 h-full w-1 cursor-col-resize transition hover:bg-accent/40"
        title="拖动调整宽度"
      />

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </aside>
  );
}

function SideButton({
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
      className="grid size-6 shrink-0 place-items-center rounded text-ink-muted transition hover:bg-surface-raised hover:text-ink"
    >
      {children}
    </button>
  );
}

function formatWhen(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

// ---- 设置面板 --------------------------------------------------------------

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const config = useAgentStore((s) => s.config);
  const saveConfig = useAgentStore((s) => s.saveConfig);
  const reloadConfig = useAgentStore((s) => s.reloadConfig);
  const model = useAgentStore((s) => s.model);
  const thinkingLevel = useAgentStore((s) => s.thinkingLevel);
  const setThinkingLevel = useAgentStore((s) => s.setThinkingLevel);
  const lastUsage = useAgentStore((s) => s.lastUsage);
  const cwd = useAgentStore((s) => s.cwd);

  const [draft, setDraft] = useState(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void reloadConfig();
  }, [reloadConfig]);

  useEffect(() => {
    setDraft(config);
  }, [config]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await saveConfig(draft);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const levels = ["off", "low", "medium", "high"];

  return (
    <div
      data-modal-open
      className="absolute inset-0 z-50 flex flex-col bg-surface-raised/98 backdrop-blur-sm"
    >
      <div className="flex items-center justify-between border-b border-border-subtle px-2.5 py-1.5">
        <span className="text-[11.5px] font-medium">设置</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1.5 text-[11px] text-ink-muted transition hover:bg-surface-sunken"
        >
          关闭
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto scroll-thin px-2.5 py-2 text-[11px]">
        <Group label="当前模型">
          <div className="truncate text-ink">{model?.name ?? "未选择"}</div>
          {model && (
            <div className="text-[10px] text-ink-muted/70">
              {model.provider} · {formatTokens(model.contextWindow)} ctx
              {model.reasoning ? " · 支持推理" : ""}
            </div>
          )}
        </Group>

        <Group label="思考强度">
          <div className="flex gap-1">
            {levels.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => void setThinkingLevel(l)}
                className={cn(
                  "flex-1 rounded py-0.5 text-[10px] uppercase transition",
                  thinkingLevel === l
                    ? "bg-accent text-white"
                    : "bg-surface-sunken text-ink-muted hover:text-ink",
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </Group>

        <Group label="工作目录">
          <div className="selectable break-all text-[10px] leading-snug text-ink-muted">
            {cwd || "—"}
          </div>
        </Group>

        {draft && (
          <>
            <Group label="快捷键（KWin 语法）">
              <input
                value={draft.toggleShortcut}
                onChange={(e) =>
                  setDraft({ ...draft, toggleShortcut: e.target.value })
                }
                placeholder="Meta+Space"
                className="w-full rounded border border-border-subtle bg-surface px-1.5 py-1 font-mono text-[11px] outline-none focus:border-accent/50"
              />
              <div className="mt-1 text-[10px] leading-snug text-ink-muted/60">
                改完保存会重装 KWin 脚本；已生效的键位在系统设置 → 快捷键里可见。
              </div>
            </Group>

            <Group label="附加参数（每行一个）">
              <textarea
                value={draft.piArgs.join("\n")}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    piArgs: e.target.value.split("\n").filter((s) => s.trim()),
                  })
                }
                rows={3}
                placeholder={"--model\nanthropic/claude-sonnet-4"}
                className="w-full resize-none rounded border border-border-subtle bg-surface px-1.5 py-1 font-mono text-[10.5px] outline-none focus:border-accent/50"
              />
            </Group>

            <Group label="会话持久化">
              <label className="flex items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={draft.persistSession}
                  onChange={(e) =>
                    setDraft({ ...draft, persistSession: e.target.checked })
                  }
                  className="size-3 accent-[var(--color-accent)]"
                />
                保存到 pi 的会话目录（关闭则每次全新会话）
              </label>
            </Group>
          </>
        )}

        {lastUsage && (
          <Group label="上一轮用量">
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-ink-muted">
              <span>输入 {formatTokens(lastUsage.input)}</span>
              <span>输出 {formatTokens(lastUsage.output)}</span>
              <span>缓存读 {formatTokens(lastUsage.cacheRead)}</span>
              <span>合计 {formatTokens(lastUsage.totalTokens)}</span>
            </div>
          </Group>
        )}

        {error && (
          <div className="rounded border border-danger/40 bg-danger/5 px-1.5 py-1 text-[10.5px] text-danger">
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border-subtle px-2.5 py-1.5">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border-subtle px-2 py-0.5 text-[11px] text-ink-muted transition hover:bg-surface-sunken"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !draft}
          className="rounded bg-accent px-2 py-0.5 text-[11px] text-white transition hover:opacity-90 disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-muted/60">
        {label}
      </div>
      {children}
    </div>
  );
}
