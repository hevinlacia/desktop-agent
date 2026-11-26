import { Check, ChevronDown, Cpu, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentClient } from "@/services/agentClient";
import { useAgentStore } from "@/stores/useAgentStore";
import type { ModelInfo } from "@shared/protocol";
import { cn, formatTokens } from "@/lib/utils";

/**
 * 标题栏上的模型切换：点当前的模型名，弹出「有可用凭据的模型」列表，按 provider 分组、可搜索。
 * ↑↓ 选择，回车切换，Esc 关闭。切换不改 pi 的全局默认模型，但会被记住：新建会话沿用上个会话使用的模型。
 */
export function ModelPicker() {
  const model = useAgentStore((s) => s.model);
  const setModel = useAgentStore((s) => s.setModel);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时才取列表：要查各 provider 的凭据，不必在启动时就问。
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setError(null);
    let cancelled = false;
    agentClient
      .models()
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 打开后焦点落到搜索框；点外面关闭。
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 先归组再展开：键盘上下移动的顺序要与列表的视觉顺序一致。
  const groups = useMemo(() => groupByProvider(filterModels(models ?? [], query)), [models, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.models), [groups]);

  // 键盘移动高亮时，让选中行留在可视区内。
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // 没在搜索时，高亮停在当前使用的模型上：一打开就能看到自己在用哪个，回车也不会误切。
  const currentKey = model ? `${model.provider}/${model.id}` : "";
  useEffect(() => {
    if (!open || query.trim() || !currentKey) return;
    const index = flat.findIndex((m) => `${m.provider}/${m.id}` === currentKey);
    setActive(index >= 0 ? index : 0);
  }, [open, flat, query, currentKey]);

  if (!model) return null;
  const isCurrent = (m: ModelInfo) => m.provider === model.provider && m.id === model.id;

  const pick = async (m: ModelInfo) => {
    setOpen(false);
    if (isCurrent(m)) return;
    try {
      await setModel(m.provider, m.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOpen(true);
    }
  };

  return (
    // data-modal-open：全局的「Esc 收起窗口」看到它就让路，Esc 归这里的搜索框。
    <div ref={ref} className="relative shrink-0" data-modal-open={open || undefined}>
      <button
        type="button"
        aria-label="切换模型"
        title="切换模型"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex max-w-[240px] items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition",
          open ? "bg-surface-sunken text-ink" : "text-ink-muted hover:bg-surface-sunken hover:text-ink",
        )}
      >
        <Cpu size={11} className="shrink-0" />
        <span className="truncate">{model.name}</span>
        <ChevronDown size={10} className="shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          className="absolute left-0 top-7 z-30 w-80 overflow-hidden rounded-lg border border-border-subtle bg-surface-raised shadow-lg"
        >
          <div className="flex items-center gap-1.5 border-b border-border-subtle px-2.5">
            <Search size={11} className="shrink-0 text-ink-muted/60" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((i) => (i + (e.key === "ArrowDown" ? 1 : flat.length - 1)) % Math.max(flat.length, 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const chosen = flat[active];
                  if (chosen) void pick(chosen);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
              placeholder="搜索模型…"
              spellCheck={false}
              className="w-full bg-transparent py-1.5 text-[11.5px] outline-none placeholder:text-ink-muted/60"
            />
          </div>

          <div role="listbox" aria-label="可选模型" className="max-h-72 overflow-y-auto scroll-thin py-1">
            {error && <div className="px-2.5 py-2 text-[11px] text-danger">{error}</div>}
            {models === null && !error && (
              <div className="flex items-center gap-1.5 px-2.5 py-2 text-[11.5px] text-ink-muted">
                <Loader2 size={11} className="animate-spin" />
                加载中…
              </div>
            )}
            {models !== null && flat.length === 0 && !error && (
              <div className="px-2.5 py-2 text-[11.5px] text-ink-muted">没有匹配的模型</div>
            )}
            {groups.map((group) => (
              <div key={group.provider}>
                <div className="px-2.5 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-ink-muted/60">
                  {group.provider}
                </div>
                {group.models.map((m) => {
                  const index = flat.indexOf(m);
                  return (
                    <button
                      key={`${m.provider}/${m.id}`}
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      data-role="model-option"
                      data-provider={m.provider}
                      data-model-id={m.id}
                      data-current={isCurrent(m) ? "true" : "false"}
                      onClick={() => void pick(m)}
                      onMouseEnter={() => setActive(index)}
                      className={cn(
                        "flex w-full items-center gap-2 px-2.5 py-[3px] text-left text-[11.5px]",
                        index === active ? "bg-accent-soft" : "hover:bg-surface-sunken",
                      )}
                    >
                      <span className="w-3 shrink-0 text-accent">{isCurrent(m) && <Check size={11} />}</span>
                      <span className="min-w-0 flex-1 truncate text-ink">{m.name}</span>
                      <span className="max-w-[120px] shrink-0 truncate font-mono text-[10px] text-ink-muted/70">
                        {m.id}
                      </span>
                      <span className="shrink-0 text-[10px] text-ink-muted/60">
                        {formatTokens(m.contextWindow)}
                        {m.reasoning ? " · 推理" : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="border-t border-border-subtle px-2.5 py-1 text-[10px] text-ink-muted/70">
            ↑↓ 选择 · 回车切换 · 新会话沿用 · Esc 关闭
          </div>
        </div>
      )}
    </div>
  );
}

/** 按名称 / id / provider 过滤（不分大小写），保持原有顺序。 */
function filterModels(list: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((m) => [m.name, m.id, m.provider].some((s) => s.toLowerCase().includes(q)));
}

/** 按 provider 归组（保持各 provider 首次出现的顺序），组内保持原顺序。 */
function groupByProvider(list: ModelInfo[]): Array<{ provider: string; models: ModelInfo[] }> {
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of list) {
    const bucket = byProvider.get(m.provider);
    if (bucket) bucket.push(m);
    else byProvider.set(m.provider, [m]);
  }
  return [...byProvider].map(([provider, models]) => ({ provider, models }));
}
