import { useEffect, useRef } from "react";
import type { SlashCommand } from "@shared/protocol";
import { cn } from "@/lib/utils";

interface CommandSuggestionsProps {
  items: SlashCommand[];
  active: number;
  onPick: (command: SlashCommand) => void;
  /** 挂到列表容器上：InputBox 用它量高度，好让悬浮窗腾出位置。 */
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * 斜杠命令联想列表，叠在输入框上方。键盘操作在 InputBox 里处理，这里只负责显示和鼠标点选。
 */
export function CommandSuggestions({ items, active, onPick, containerRef }: CommandSuggestionsProps) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // 键盘移动高亮时，让选中行留在可视区内。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label="斜杠命令"
      className="absolute inset-x-2 bottom-full z-40 mb-1 overflow-hidden rounded-lg border border-border-subtle bg-surface-raised shadow-lg"
    >
      <div className="max-h-[188px] overflow-y-auto scroll-thin py-1">
        {items.map((cmd, i) => (
          <button
            key={`${cmd.source}:${cmd.name}`}
            ref={i === active ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={i === active}
            data-role="command-suggestion"
            // 用 mousedown 并阻止默认行为：点选不会把焦点从输入框抢走。
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(cmd);
            }}
            className={cn(
              "flex w-full items-baseline gap-2.5 px-2.5 py-[3px] text-left text-[12px]",
              i === active ? "bg-accent-soft" : "hover:bg-surface-sunken",
            )}
          >
            <span className="shrink-0 font-mono text-ink">
              /{cmd.name}
              {cmd.argumentHint && <span className="text-ink-muted"> {cmd.argumentHint}</span>}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">{cmd.description}</span>
          </button>
        ))}
      </div>
      <div className="border-t border-border-subtle px-2.5 py-1 text-[10px] text-ink-muted/70">
        ↑↓ 选择 · Tab 或回车补全 · Esc 关闭
      </div>
    </div>
  );
}
