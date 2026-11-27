import { useEffect, useRef, useState } from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings2,
} from "lucide-react";
import { useAgentStore } from "@/stores/useAgentStore";
import { cn, formatTokens } from "@/lib/utils";
import { SessionGroups } from "./SessionGroups";
import type { WindowMode } from "@shared/protocol";

const COLLAPSE_KEY = "desktop-agent:sidebar-collapsed";
const WIDTH_KEY = "desktop-agent:sidebar-width";
const MIN_WIDTH = 180;
const MAX_WIDTH = 360;
/** 悬浮窗展开后的侧边栏宽度：窗口本身只有 720 宽，固定值即可。 */
const COMPACT_WIDTH = 224;

/**
 * 会话侧边栏。
 *
 * 职责边界：只管"选择/新建会话"和轻量状态展示，不持有对话数据（那在 store 里）。
 * 会话列表来自 Rust 侧扫描 pi 的 sessions 目录（`agent_sessions`），
 * 这样不需要客户端镜像 pi 的存储结构。
 *
 * 两种形态：
 * - `full`：完整窗口。可搜索、拖宽、进设置；折叠状态记在 localStorage。
 * - `compact`：悬浮窗。默认收起成一条窄栏，展开时由 store 把窗口加高；
 *   只保留列表，选中会话后切到完整窗口（悬浮窗不显示消息流）。
 */
export function Sidebar({ variant }: { variant: WindowMode }) {
  const compact = variant === "compact";
  const [collapsedFull, setCollapsedFull] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === "1",
  );
  const [width, setWidth] = useState(() => {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(raw) && raw >= MIN_WIDTH && raw <= MAX_WIDTH ? raw : 224;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);

  const compactOpen = useAgentStore((s) => s.compactSidebarOpen);
  const setCompactSidebarOpen = useAgentStore((s) => s.setCompactSidebarOpen);
  const createSession = useAgentStore((s) => s.createSessionInActiveGroup);
  const stats = useAgentStore((s) => s.stats);

  const open = compact ? compactOpen : !collapsedFull;
  const toggle = () => {
    if (compact) void setCompactSidebarOpen(!compactOpen);
    else setCollapsedFull((v) => !v);
  };
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

  if (!open) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border-subtle bg-surface-sunken/50 py-2">
        <SideButton label="展开侧边栏" onClick={toggle}>
          <PanelLeftOpen size={14} />
        </SideButton>
        <SideButton label="新建会话" onClick={() => void createSession()}>
          <Plus size={14} />
        </SideButton>
      </aside>
    );
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-border-subtle bg-surface-sunken/50"
      style={{ width: compact ? COMPACT_WIDTH : width }}
    >
      <div className="flex items-center gap-1 px-2 pb-1 pt-2">
        <span className="flex-1 text-[10.5px] font-medium uppercase tracking-wide text-ink-muted/60">
          会话
        </span>
        {/* 不再放「新建会话」按钮（REQ-344 ⑥）：它与分组头/标题栏的入口完全重复，
            收起态窄栏里的按钮保留——那时它是唯一入口。 */}
        <SideButton label="收起侧边栏" onClick={toggle}>
          <PanelLeftClose size={13} />
        </SideButton>
      </div>

      {/* 分组 + 打开的会话 + 历史会话（REQ-341） */}
      <SessionGroups compact={compact} />

      {!compact && (
        <>
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
        </>
      )}

      {settingsOpen && !compact && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
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

        <Group label="工作分组">
          <div className="selectable break-all text-[10px] leading-snug text-ink-muted">
            {draft?.activeGroupId
              ? draft.groups.find((g) => g.id === draft.activeGroupId)?.path ?? cwd ?? "—"
              : (cwd || "—")}
          </div>
          <div className="mt-1 text-[10px] leading-snug text-ink-muted/60">
            工作目录改由左侧「分组」管理：一个分组就是一个目录，可放多个分组、随时切换。
            会话按分组归组，关闭的进历史会话。
          </div>
        </Group>

        {draft && (
          <>
            <Group label="快捷键（Electron 写法）">
              <input
                value={draft.toggleShortcut}
                onChange={(e) =>
                  setDraft({ ...draft, toggleShortcut: e.target.value })
                }
                placeholder="Super+Space"
                className="w-full rounded border border-border-subtle bg-surface px-1.5 py-1 font-mono text-[11px] outline-none focus:border-accent/50"
              />
              <div className="mt-1 text-[10px] leading-snug text-ink-muted/60">
                改完保存立即生效。Linux Wayland 下只有安装版应用能绑定全局快捷键；清空 = 不注册
                （改用系统自定义快捷键调 desktop-agent toggle，打包版也不会弹权限窗）。
              </div>
            </Group>

            <Group label="Agent">
              <label className="flex items-center gap-1.5 text-[11px]">
                <input
                  type="checkbox"
                  checked={draft.extensions}
                  onChange={(e) =>
                    setDraft({ ...draft, extensions: e.target.checked })
                  }
                  className="size-3 accent-[var(--color-accent)]"
                />
                加载 pi 的扩展与 skills（保存后 Agent 会重启）
              </label>
              <label className="mt-1 flex items-center gap-1.5 text-[11px]">
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
              <label className="mt-2 block text-[11px] text-ink-muted">
                Agent Panel 地址（留空自动探测）
                <input
                  value={draft.panelUrl}
                  onChange={(e) => setDraft({ ...draft, panelUrl: e.target.value })}
                  placeholder="https://edge.tail260d93.ts.net"
                  className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-accent/60"
                />
              </label>
              <label className="mt-2 block text-[11px] text-ink-muted">
                会话常驻池大小（REQ-346）
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={draft.sessionPoolSize}
                  onChange={(e) => setDraft({ ...draft, sessionPoolSize: Number(e.target.value) })}
                  className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-accent/60"
                />
                <span className="mt-1 block text-[10px] leading-snug text-ink-muted/60">
                  最近用过的会话各驻留一个完整运行时，池内切换瞬时（不重建）；代价是内存。保存立即生效。
                </span>
              </label>
              <label className="mt-2 block text-[11px] text-ink-muted">
                闲置挂起（分钟，0 = 不挂起）
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={draft.sessionIdleSuspendMinutes}
                  onChange={(e) => setDraft({ ...draft, sessionIdleSuspendMinutes: Number(e.target.value) })}
                  className="mt-1 w-full rounded-md border border-border-subtle bg-surface px-2 py-1 text-[11px] text-ink outline-none focus:border-accent/60"
                />
                <span className="mt-1 block text-[10px] leading-snug text-ink-muted/60">
                  超过这个时长没使用的常驻会话会释放运行时；再切回去会重新加载一次。
                </span>
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
