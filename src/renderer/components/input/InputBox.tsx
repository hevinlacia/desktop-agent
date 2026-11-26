import { useEffect, useRef, useState } from "react";
import { ArrowUp, Expand, Loader2, Square } from "lucide-react";
import { useAgentStore } from "@/stores/useAgentStore";
import { windowClient } from "@/services/agentClient";
import { cn } from "@/lib/utils";

/**
 * 输入框。紧凑形态只有这一行；完整形态固定在底部。
 * 关键交互：
 * - Enter 发送，Shift+Enter 换行
 * - Esc 收起窗口
 * - 运行中 Enter = steer 排队
 */
export function InputBox({ compact }: { compact: boolean }) {
  const [text, setText] = useState("");
  const send = useAgentStore((s) => s.send);
  const abort = useAgentStore((s) => s.abort);
  const running = useAgentStore((s) => s.running);
  const setMode = useAgentStore((s) => s.setMode);
  const mode = useAgentStore((s) => s.mode);
  const taRef = useRef<HTMLTextAreaElement>(null);

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

  return (
    <div
      className={cn(
        "shrink-0 border-border-subtle bg-surface-raised",
        compact ? "border-t-0" : "border-t",
      )}
    >
      <div className="flex items-end gap-1.5 px-3 py-2">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
