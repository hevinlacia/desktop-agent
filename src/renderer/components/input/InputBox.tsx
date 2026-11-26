import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Expand, Loader2, Square } from "lucide-react";
import { useAgentStore } from "@/stores/useAgentStore";
import { agentClient, windowClient } from "@/services/agentClient";
import type { SlashCommand } from "@shared/protocol";
import { CommandSuggestions } from "./CommandSuggestions";
import { cn } from "@/lib/utils";

/** 命令列表的缓存有效期：扩展和 skill 可能在运行中变化，但不必每次按键都问。 */
const COMMANDS_TTL_MS = 30_000;

interface CommandCache {
  list: SlashCommand[];
  fetchedAt: number;
}

/**
 * 输入框。紧凑形态只有这一行；完整形态固定在底部。
 * 关键交互：
 * - Enter 发送，Shift+Enter 换行
 * - Esc 收起窗口
 * - 运行中 Enter = steer 排队
 * - 输入 `/` 开头的命令词时弹出联想：↑↓ 选择，Tab / 回车补全，Esc 关闭
 */
export function InputBox({ compact }: { compact: boolean }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [commands, setCommands] = useState<CommandCache | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const send = useAgentStore((s) => s.send);
  const abort = useAgentStore((s) => s.abort);
  const running = useAgentStore((s) => s.running);
  const setMode = useAgentStore((s) => s.setMode);
  const mode = useAgentStore((s) => s.mode);
  const setCommandPopupHeight = useAgentStore((s) => s.setCompactCommandPopupHeight);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  /** 正在输入的命令词（不含斜杠）；没在输命令时为 null。 */
  const query = commandQuery(text, caret);
  const matches = useMemo(
    () => (query === null ? [] : filterCommands(commands?.list ?? [], query)),
    [query, commands],
  );
  const open = query !== null && matches.length > 0 && !dismissed;

  // 光标位置：联想只在光标还停在命令词里时才出现。
  useEffect(() => {
    const sync = () => {
      const el = taRef.current;
      if (el && document.activeElement === el) setCaret(el.selectionStart ?? 0);
    };
    document.addEventListener("selectionchange", sync);
    return () => document.removeEventListener("selectionchange", sync);
  }, []);

  // 需要联想时才取命令列表，并按缓存有效期刷新。
  useEffect(() => {
    if (query === null) return;
    if (commands && Date.now() - commands.fetchedAt < COMMANDS_TTL_MS) return;
    let cancelled = false;
    agentClient
      .commands()
      .then((list) => {
        if (!cancelled) setCommands({ list, fetchedAt: Date.now() });
      })
      .catch(() => {
        if (!cancelled) setCommands({ list: [], fetchedAt: Date.now() });
      });
    return () => {
      cancelled = true;
    };
  }, [query, commands]);

  // 离开命令词后解除「已关闭」状态，并让高亮回到第一项。
  useEffect(() => {
    if (query === null) setDismissed(false);
    setActive(0);
  }, [query]);

  // 悬浮窗里给联想列表腾位置：窗口临时加高；列表收起或切到完整形态时恢复。
  useLayoutEffect(() => {
    if (!compact || !open) {
      void setCommandPopupHeight(0);
      return;
    }
    void setCommandPopupHeight((popupRef.current?.offsetHeight ?? 0) + 6);
  }, [compact, open, setCommandPopupHeight]);

  useEffect(() => () => void setCommandPopupHeight(0), [setCommandPopupHeight]);

  // 自动增高，上限 6 行（紧凑形态上限 3 行）。
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxRows = compact ? 3 : 6;
    const lineHeight = 20;
    el.style.height = `${Math.min(el.scrollHeight, maxRows * lineHeight + 10)}px`;
  }, [text, compact]);

  // 窗口重新可见时聚焦输入框（悬浮窗的核心体验）。
  useEffect(() => {
    const focus = () => taRef.current?.focus();
    focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    await send(value);
    // 发送后切到完整形态，否则紧凑窗看不到回答。
    if (mode === "compact") void setMode("full");
  };

  /** 把输入框替换成「/命令名 」，光标留在后面等用户补参数。回车提交仍由 pi 识别命令。 */
  const acceptCommand = (cmd: SlashCommand) => {
    const next = `/${cmd.name} `;
    setText(next);
    setCaret(next.length);
    setDismissed(true);
    taRef.current?.focus();
  };

  return (
    <div
      className={cn(
        "relative shrink-0 border-border-subtle bg-surface-raised",
        compact ? "border-t-0" : "border-t",
      )}
    >
      {open && (
        <CommandSuggestions items={matches} active={active} onPick={acceptCommand} containerRef={popupRef} />
      )}
      <div className="flex items-end gap-1.5 px-3 py-2">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={(e) => {
            // 输入法组字期间的按键是给候选词的，不碰。
            if (e.nativeEvent.isComposing) return;
            if (open) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === "Tab" || e.key === "Enter") {
                // 此刻还没输入空格，回车的含义是「选中这条命令」而不是发送。
                e.preventDefault();
                const chosen = matches[active];
                if (chosen) acceptCommand(chosen);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissed(true);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.currentTarget.blur();
              void windowClient.hide();
            }
          }}
          rows={1}
          placeholder={running ? "运行中…回车可插入补充指令" : "问点什么，或 / 触发命令"}
          className="selectable max-h-40 min-h-[26px] flex-1 resize-none bg-transparent text-[13.5px] leading-relaxed outline-none placeholder:text-ink-muted/60"
          spellCheck={false}
        />

        {running ? (
          <IconButton label="中止" onClick={() => void abort()} danger>
            <Square size={11} className="fill-current" />
          </IconButton>
        ) : (
          <IconButton label="发送" onClick={() => void submit()} disabled={!text.trim()}>
            <ArrowUp size={13} />
          </IconButton>
        )}

        {compact && (
          <IconButton label="展开为对话窗口" onClick={() => void setMode("full")}>
            <Expand size={12} />
          </IconButton>
        )}
      </div>
      {running && (
        <div className="flex items-center gap-1.5 px-3 pb-1.5 text-[10.5px] text-ink-muted">
          <Loader2 size={10} className="animate-spin" />
          运行中
        </div>
      )}
    </div>
  );
}

/** 正在输入的命令词（不含斜杠）：以 `/` 开头、光标之前还没出现空白。否则返回 null。 */
function commandQuery(text: string, caret: number): string | null {
  if (!text.startsWith("/")) return null;
  const typed = text.slice(0, caret);
  return /\s/.test(typed) ? null : typed.slice(1);
}

/** 按前缀过滤（不分大小写）；只输了 `/` 时给出全部。 */
function filterCommands(list: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return q ? list.filter((cmd) => cmd.name.toLowerCase().startsWith(q)) : list;
}

function IconButton({
  children,
  onClick,
  disabled,
  danger,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md transition",
        danger
          ? "bg-danger/10 text-danger hover:bg-danger/20"
          : "bg-accent-soft text-accent hover:bg-accent/20",
        disabled && "cursor-not-allowed opacity-35 hover:bg-accent-soft",
      )}
    >
      {children}
    </button>
  );
}
