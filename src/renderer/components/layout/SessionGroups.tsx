import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  History,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { AppConfig, SessionGroup } from "@shared/protocol";
import {
  activeGroup,
  addGroup,
  closeSession,
  ensureGroups,
  filterSessions,
  historyPage,
  HISTORY_PAGE_SIZE,
  historySessions,
  openSession,
  removeGroup,
  renameGroup,
  setActiveGroup,
  type GroupState,
} from "@shared/session-groups";
import { agentClient, configClient, type SessionSummary } from "@/services/agentClient";
import { useAgentStore } from "@/stores/useAgentStore";
import { cn } from "@/lib/utils";

interface Props {
  /** 悬浮窗里空间小：隐藏历史会话与统计。 */
  compact: boolean;
}

/**
 * 会话分组区（REQ-341）。
 *
 * 模型：
 * - 分组 = 工作目录。切换分组会把 Agent 用该目录重启（pi 的 runtime 绑定 cwd，不能热切）。
 * - 「打开的会话」持久化在 config.openSessions，关掉应用再打开仍在。
 * - 不在打开清单里的会话进「历史会话」，按最后活跃倒序、一次 30 条。
 *
 * 边界：历史会话只列**当前激活分组**的（列表接口按 cwd 扫描），其它分组只显示各自
 * 打开的会话名——切过去就能看到它们的历史。
 */
export function SessionGroups({ compact }: Props) {
  const config = useAgentStore((s) => s.config);
  const saveConfig = useAgentStore((s) => s.saveConfig);
  const currentFile = useAgentStore((s) => s.sessionFile);
  const switchSession = useAgentStore((s) => s.switchSession);
  const newSession = useAgentStore((s) => s.newSession);
  /** 全局会话（历史会话不绑定 cwd，所以用跨目录列表）。当前 cwd 列表已并入全局，不再单独拉（REQ-344 ⑥）。 */
  const [allSessions, setAllSessions] = useState<SessionSummary[]>([]);
  /** 会话搜索词（REQ-344 ①）：过滤「打开的会话」与「历史会话」，匹配展示名 / sessionId / 文件名。 */
  const [query, setQuery] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  // visible = 这一屏展示多少条历史会话（一页 30，点一次加一页）。
  const [visible, setVisible] = useState(HISTORY_PAGE_SIZE);
  const [busy, setBusy] = useState(false);
  /** 新建分组的输入行是否展开（路径值由 ref 直接读，避免受控输入的状态竞态）。 */
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const newGroupRef = useRef<HTMLInputElement>(null);

  /** config 里的分组状态；老配置没有分组时用 cwd 兜底。 */
  const state: GroupState | null = useMemo(() => {
    if (!config) return null;
    return ensureGroups(
      {
        groups: config.groups,
        activeGroupId: config.activeGroupId,
        openSessions: config.openSessions,
      },
      config.cwd,
    );
  }, [config]);

  const group = state ? activeGroup(state) : undefined;
  const openPaths = state && group ? (state.openSessions[group.id] ?? []) : [];

  const reloadSessions = useCallback(async () => {
    setAllSessions(await agentClient.sessionsAll().catch(() => [] as SessionSummary[]));
  }, []);

  // 切分组 / 新会话落盘后列表要跟着变。
  useEffect(() => {
    void reloadSessions();
  }, [reloadSessions, group?.id, currentFile]);

  /**
   * 把分组状态写回配置（不动 cwd 时不触发 Agent 重启）。
   *
   * 基线必须取主进程的最新配置，不能用组件闭包里的 store 副本：Agent 重启、
   * 外部改配置之后副本会落后，直接写回会把别人的改动覆盖掉（实测刚新建的分组
   * 会被旧值写回去，表现为「新建分组没反应」）。
   */
  const persist = useCallback(
    async (next: GroupState, opts?: { switchCwd?: boolean }) => {
      setBusy(true);
      try {
        const base = await configClient.get();
        const target = opts?.switchCwd ? next.groups.find((g) => g.id === next.activeGroupId) : undefined;
        const merged: AppConfig = {
          ...base,
          groups: next.groups,
          activeGroupId: next.activeGroupId,
          openSessions: next.openSessions,
          ...(target ? { cwd: target.path } : {}),
        };
        await saveConfig(merged);
      } finally {
        setBusy(false);
      }
    },
    [saveConfig],
  );

  // 不做「按磁盘列表自动清理」：新建会话的文件落盘晚于列表刷新，自动对账会把刚建的
  // 那条当成"文件不存在"删掉（实测表现为「会话刚出现就消失」），而且每次对账都会写配置。
  // 文件真的被删了也不致命：点开会提示错误，用户自己关掉即可。

  // 名字解析用全局列表：刚新建/刚切组时当前 cwd 的列表可能还没刷新（REQ-341 实测），
  // 全局表覆盖所有目录，不存在这个问题。
  const info = useMemo(() => {
    const byPath = new Map<string, SessionSummary>();
    for (const s of allSessions) byPath.set(s.path, s);
    return { byPath };
  }, [allSessions]);

  const labelOf = (path: string): string => {
    const hit = info.byPath.get(path);
    if (hit?.name) return hit.name;
    if (hit?.sessionId) return hit.sessionId.slice(0, 8);
    // 兜底：从文件名里取 id 段（形如 2026-11-27T02-34-10-457Z_<id>.jsonl）。
    const file = path.split("/").pop() ?? path;
    const id = file.replace(/\.jsonl$/, "").split("_").pop() ?? file;
    return id.slice(0, 8);
  };

  const openInApp = useCallback(
    async (path: string) => {
      if (state && group) {
        const next = openSession(state, group.id, path);
        if (next !== state) await persist(next);
      }
      await switchSession(path);
    },
    [state, group, persist, switchSession],
  );

  const closeInApp = useCallback(
    async (path: string) => {
      if (!state || !group) return;
      const next = closeSession(state, group.id, path);
      await persist(next);
      // 关掉的是当前会话：切到还开着的第一个，没有就新开一个。
      if (path === currentFile) {
        const remaining = next.openSessions[group.id] ?? [];
        if (remaining[0]) await switchSession(remaining[0]);
        else await newSession();
      }
    },
    [state, group, persist, currentFile, switchSession, newSession],
  );

  const createSession = useCallback(async () => {
    // 列表刷新交给 currentFile 变化的 useEffect（REQ-344 ⑥：手动 reload 是冗余的）。
    await useAgentStore.getState().createSessionInActiveGroup();
  }, []);

  const commitRename = useCallback(
    async (groupId: string, label: string) => {
      if (!state) return;
      const next = renameGroup(state, groupId, label);
      if (next !== state) await persist(next);
    },
    [state, persist],
  );

  const deleteGroup = useCallback(
    async (groupId: string) => {
      if (!state) return;
      const target = state.groups.find((g) => g.id === groupId);
      if (!target || state.groups.length <= 1) return;
      const next = removeGroup(state, groupId);
      await persist(next);
      // 删的是激活分组：removeGroup 已把激活指到剩余第一个；那边有打开的会话就切过去
      // （pi 跟随会话自己的 cwd，不重启），没有就提示用户「新建会话会以该目录启动」。
      if (state.activeGroupId === groupId && next.activeGroupId) {
        const first = next.openSessions[next.activeGroupId]?.[0];
        if (first) {
          await switchSession(first);
        } else {
          const label = next.groups.find((g) => g.id === next.activeGroupId)?.label ?? "";
          useAgentStore
            .getState()
            .pushNotice(`已删除分组「${target.label}」，切到「${label}」：点「新建会话」会以该目录启动（Agent 重启一次）`);
        }
      }
    },
    [state, persist, switchSession],
  );

  if (!state) return null;

  // 历史会话是全局的（跨所有工作目录），排除任何分组里还开着的那些。
  const openedEverywhere = state.groups.flatMap((g) => state.openSessions[g.id] ?? []);
  const historyAll = historySessions(allSessions, openedEverywhere);

  // 搜索（REQ-344 ①）：打开列表用展示名匹配；历史列表先过滤再分页，
  // 搜索态不分页（一次给全，头部显命中数、隐藏「加载更多」）。
  const searching = query.trim().length > 0;
  const openItems = openPaths.map((path) => ({
    path,
    name: labelOf(path),
    rawName: info.byPath.get(path)?.name,
    sessionId: info.byPath.get(path)?.sessionId,
  }));
  const filteredOpen = filterSessions(openItems, query);
  const filteredHistory = filterSessions(historyAll, query);
  const page = historyPage(searching ? filteredHistory : historyAll, searching ? filteredHistory.length : visible);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 搜索（REQ-344 ①）：Esc 只清词不收窗（stopPropagation 隔开全局快捷键）。 */}
      <div className="shrink-0 px-1.5 pb-1">
        <div className="flex items-center gap-1 rounded-md border border-border-subtle bg-surface px-1.5 py-0.5">
          <Search size={11} className="shrink-0 text-ink-muted/50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            placeholder="搜索会话…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-muted/40"
          />
          {searching && (
            <button
              type="button"
              title="清空搜索"
              onClick={() => setQuery("")}
              className="shrink-0 rounded p-0.5 text-ink-muted/60 transition hover:bg-surface-raised hover:text-ink"
            >
              <X size={10} />
            </button>
          )}
        </div>
      </div>

      {/* 分组切换 */}
      <div className="shrink-0 px-1.5 pb-1">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-muted/60">分组</span>
          <button
            type="button"
            title="新建分组（工作目录）"
            disabled={busy}
            onClick={() => setNewGroupOpen((v) => !v)}
            className="rounded p-0.5 text-ink-muted transition hover:bg-surface-raised hover:text-ink disabled:opacity-40"
          >
            <FolderPlus size={12} />
          </button>
        </div>
        {newGroupOpen && (
          <div className="mb-1 flex gap-1 px-1">
            <input
              ref={newGroupRef}
              autoFocus
              defaultValue=""
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void submitNewGroup(state, newGroupRef.current?.value ?? "", persist, () => setNewGroupOpen(false));
                }
                if (e.key === "Escape") setNewGroupOpen(false);
              }}
              placeholder="粘贴或输入工作目录"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-border-subtle bg-surface px-1.5 py-0.5 font-mono text-[10.5px] outline-none focus:border-accent/50"
            />
            <button
              type="button"
              title="用这个路径新建分组"
              onClick={() =>
                void submitNewGroup(state, newGroupRef.current?.value ?? "", persist, () => setNewGroupOpen(false))
              }
              className="shrink-0 rounded border border-border-subtle bg-surface px-1.5 text-[10.5px] text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
            >
              确定
            </button>
            <button
              type="button"
              title="从系统目录选择"
              onClick={() => void addGroupByPicker(state, persist, config).then(() => setNewGroupOpen(false))}
              className="shrink-0 rounded border border-border-subtle bg-surface px-1.5 text-[10.5px] text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
            >
              浏览…
            </button>
          </div>
        )}
        <div className={cn("space-y-0.5", state.groups.length > 4 && "max-h-32 overflow-y-auto scroll-thin")}>
          {state.groups.map((g) => (
            <GroupRow
              key={g.id}
              group={g}
              active={g.id === state.activeGroupId}
              count={(state.openSessions[g.id] ?? []).length}
              canDelete={state.groups.length > 1}
              onPick={() =>
                void switchGroup(state, g, persist, state.openSessions[g.id] ?? [], switchSession, (msg) =>
                  useAgentStore.getState().pushNotice(msg),
                )
              }
              onRename={(label) => void commitRename(g.id, label)}
              onDelete={() => void deleteGroup(g.id)}
            />
          ))}
        </div>
      </div>

      {/* 打开着的会话 */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-border-subtle pt-1">
        <div className="mb-0.5 flex items-center justify-between px-2">
          <span className="truncate text-[10px] uppercase tracking-wide text-ink-muted/60">
            {group?.label ?? "会话"}
          </span>
          <button
            type="button"
            title="新建会话"
            onClick={() => void createSession()}
            className="rounded p-0.5 text-ink-muted transition hover:bg-surface-raised hover:text-ink"
          >
            <Plus size={12} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-1.5">
          {filteredOpen.length === 0 && (
            <div className="px-2 py-2 text-[11px] leading-relaxed text-ink-muted/60">
              {searching ? "没有匹配的会话" : "还没有打开的会话"}
            </div>
          )}
          {filteredOpen.map(({ path, name, rawName }) => (
            <SessionRow
              key={path}
              label={name}
              active={path === currentFile}
              subtitle={rawName ? name : undefined}
              onOpen={() => void openInApp(path)}
              onClose={() => void closeInApp(path)}
            />
          ))}
        </div>
      </div>

      {/* 历史会话 */}
      {!compact && (
        <div className="shrink-0 border-t border-border-subtle px-1.5 py-1">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-[11px] text-ink-muted transition hover:bg-surface-raised hover:text-ink"
          >
            {historyOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <History size={11} />
            <span className="flex-1 text-left">历史会话</span>
            <span className="text-[10px] tabular-nums text-ink-muted/60" data-history-count>
              {searching ? filteredHistory.length : historyAll.length}
            </span>
          </button>
          {(historyOpen || searching) && (
            <div className="mt-1 max-h-56 overflow-y-auto scroll-thin">
              {page.items.length === 0 && (
                <div className="px-2 py-1.5 text-[11px] text-ink-muted/60">
                  {searching ? "没有匹配的会话" : "没有已关闭的会话"}
                </div>
              )}
              {page.items.map((s) => (
                <SessionRow
                  key={s.path}
                  label={s.name || s.sessionId.slice(0, 8)}
                  subtitle={s.modifiedMs ? new Date(s.modifiedMs).toLocaleDateString() : undefined}
                  onOpen={() => void switchSession(s.path)}
                />
              ))}
              {page.remaining > 0 && (
                <button
                  type="button"
                  onClick={() => setVisible((v) => v + HISTORY_PAGE_SIZE)}
                  className="mt-1 w-full rounded px-2 py-1 text-[11px] text-accent transition hover:bg-surface-raised"
                >
                  加载更多（还剩 {page.remaining} 条）
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 切分组：**不改 cwd、不重启**。
 *
 * pi 的 `switchSession(path)` 会用会话自己的 cwd 重建运行时服务（见
 * agent-session-runtime.js），所以只要切到该分组里的一条会话，工作目录自然就跟着过去。
 * 空分组没有办法「无中生有」地换目录，此时才需要以该目录重启一次。
 */
async function switchGroup(
  state: GroupState,
  group: SessionGroup,
  persist: (next: GroupState, opts?: { switchCwd?: boolean }) => Promise<void>,
  openPaths: string[],
  switchSession: (path: string) => Promise<void>,
  notify: (message: string) => void,
): Promise<void> {
  if (group.id === state.activeGroupId) return;
  await persist(setActiveGroup(state, group.id));
  const first = openPaths[0];
  if (first) {
    await switchSession(first);
    return;
  }
  notify(`已切到分组「${group.label}」：它还没有打开的会话，点「新建会话」时会以该目录启动（Agent 重启一次）`);
}

/** 手输路径新建分组：校验非空即登记并切过去（切组会让 Agent 用该目录重启）。 */
async function submitNewGroup(
  state: GroupState,
  path: string,
  persist: (next: GroupState, opts?: { switchCwd?: boolean }) => Promise<void>,
  done: () => void,
): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) return;
  const { state: next } = addGroup(state, trimmed);
  done();
  await persist(next);
}

/** 新建分组：调宿主目录选择框；选中后登记分组并切过去。 */
async function addGroupByPicker(
  state: GroupState,
  persist: (next: GroupState, opts?: { switchCwd?: boolean }) => Promise<void>,
  config: AppConfig | null,
): Promise<void> {
  const picked = await configClient.pickDirectory(config?.cwd ?? "");
  if (!picked) return;
  const { state: next } = addGroup(state, picked);
  await persist(next);
}

function GroupRow({
  group,
  active,
  count,
  canDelete,
  onPick,
  onRename,
  onDelete,
}: {
  group: SessionGroup;
  active: boolean;
  count: number;
  /** 分组是会话的容器，至少保留一个：删最后一个要禁止（REQ-344 ③）。 */
  canDelete: boolean;
  onPick: () => void;
  onRename: (label: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);

  const commitRename = () => {
    const value = renameRef.current?.value ?? "";
    setRenaming(false);
    onRename(value); // 空白/同名时 renameGroup 返回同一状态，父层据此跳过持久化
  };

  if (renaming) {
    return (
      <div className="flex items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5">
        <input
          ref={renameRef}
          autoFocus
          defaultValue={group.label}
          title={`${group.label}（原目录：${group.path}）`}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              e.stopPropagation();
              setRenaming(false);
            }
          }}
          onBlur={commitRename}
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-accent outline-none"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition",
        active ? "bg-accent-soft text-accent" : "text-ink hover:bg-surface-raised",
      )}
    >
      <button type="button" onClick={onPick} title={group.path} className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", active ? "bg-accent" : "bg-ink-muted/30")} />
        <span className="min-w-0 flex-1 truncate text-[11.5px]">{group.label}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-ink-muted/60 group-hover:hidden">{count}</span>
      </button>
      {/* hover 时计数换成操作（REQ-344 ③）：重命名 inline，删除两步确认，不占额外宽度 */}
      <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        {confirming ? (
          <>
            <span className="text-[9.5px] text-red-400">删除？</span>
            <button
              type="button"
              title={`删除分组「${group.label}」，其中打开的会话会收进历史会话`}
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
              className="rounded p-0.5 text-red-400 transition hover:bg-surface-sunken"
            >
              <Check size={11} />
            </button>
            <button
              type="button"
              title="取消"
              onClick={() => setConfirming(false)}
              className="rounded p-0.5 text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
            >
              <X size={11} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              title="重命名分组"
              onClick={() => setRenaming(true)}
              className="rounded p-0.5 text-ink-muted transition hover:bg-surface-sunken hover:text-ink"
            >
              <Pencil size={11} />
            </button>
            <button
              type="button"
              title={canDelete ? "删除分组" : "至少保留一个分组"}
              disabled={!canDelete}
              onClick={() => setConfirming(true)}
              className="rounded p-0.5 text-ink-muted transition hover:bg-surface-sunken hover:text-red-400 disabled:opacity-30 disabled:hover:text-ink-muted"
            >
              <Trash2 size={11} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  label,
  subtitle,
  active,
  onOpen,
  onClose,
}: {
  label: string;
  subtitle?: string;
  active?: boolean;
  onOpen: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      data-session-row
      className={cn(
        "group mb-0.5 flex items-center gap-1 rounded-md px-2 py-1 transition",
        active ? "bg-accent-soft" : "hover:bg-surface-raised",
      )}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <MessageSquare size={10} className={cn("shrink-0", active ? "text-accent" : "text-ink-muted/50")} />
        <span className={cn("min-w-0 flex-1 truncate text-[11.5px]", active ? "font-medium text-accent" : "text-ink")}>
          {label}
        </span>
        {subtitle && <span className="shrink-0 text-[9.5px] text-ink-muted/50">{subtitle}</span>}
      </button>
      {onClose && (
        <button
          type="button"
          title="关闭会话（收进历史会话）"
          onClick={onClose}
          className="shrink-0 rounded p-0.5 text-ink-muted/40 opacity-0 transition hover:bg-surface-sunken hover:text-ink group-hover:opacity-100"
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}
