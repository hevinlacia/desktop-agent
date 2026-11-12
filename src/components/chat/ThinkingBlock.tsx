import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ThinkingBlockProps {
  text: string;
  /** 流式中默认展开，结束后自动折叠。 */
  streaming?: boolean;
}

export function ThinkingBlock({ text, streaming }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false);
  // 流式时自动展开让用户看到推理过程；一旦结束就收回，省空间。
  const expanded = streaming ? true : open;

  return (
    <div className="my-1.5 rounded-lg border border-border-subtle/70 bg-surface-sunken/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11.5px] text-ink-muted transition hover:text-ink"
      >
        <ChevronRight
          size={12}
          className={cn("shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <Brain size={12} className="shrink-0 opacity-70" />
        <span className="font-medium">思考过程</span>
        <span className="ml-auto truncate pl-2 text-[10.5px] opacity-60">
          {streaming ? "推理中…" : `${text.length} 字`}
        </span>
      </button>
      {expanded && (
        <div className="selectable max-h-72 overflow-y-auto scroll-thin border-t border-border-subtle/60 px-2.5 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-muted">
          {text}
        </div>
      )}
    </div>
  );
}
