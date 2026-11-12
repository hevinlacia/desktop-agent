import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { cn, summarizeArgs } from "@/lib/utils";
import type { ToolExecution } from "@/stores/useAgentStore";

interface ToolCallCardProps {
  toolCallId: string;
  toolName: string;
  args: unknown;
  execution?: ToolExecution | undefined;
}

const ICONS: Record<string, typeof Terminal> = {
  bash: Terminal,
  read: FileText,
  write: Pencil,
  edit: Pencil,
  grep: Search,
  find: Search,
  glob: Search,
};

export function ToolCallCard({ toolCallId, toolName, args, execution }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[toolName] ?? Wrench;
  const phase = execution?.phase ?? "pending";
  const summary = summarizeArgs(args);

  return (
    <div
      className={cn(
        "my-1.5 overflow-hidden rounded-lg border text-[12px]",
        phase === "error"
          ? "border-danger/40 bg-danger/5"
          : "border-border-subtle bg-surface-sunken/50",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left"
      >
        <ChevronRight
          size={12}
          className={cn("shrink-0 text-ink-muted transition-transform", open && "rotate-90")}
        />
        <Icon size={12} className="shrink-0 text-ink-muted" />
        <span className="font-medium text-ink">{toolName || "tool"}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
            {summary}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-1.5 text-[10.5px] text-ink-muted">
          {phase === "running" && <Loader2 size={11} className="animate-spin" />}
          {phase === "done" && <Check size={11} className="text-success" />}
          {phase === "error" && <AlertTriangle size={11} className="text-danger" />}
          {execution?.durationMs !== undefined && (
            <span className="tabular-nums">{formatDuration(execution.durationMs)}</span>
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-border-subtle/70">
          <Section label="参数">
            <pre className="selectable overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-ink-muted">
              {prettyJson(args)}
            </pre>
          </Section>
          {execution && (
            <Section label={phase === "error" ? "错误输出" : "输出"}>
              <pre
                className={cn(
                  "selectable max-h-64 overflow-auto scroll-thin whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed",
                  phase === "error" ? "text-danger" : "text-ink-muted",
                )}
              >
                {execution.output || "（无输出）"}
              </pre>
            </Section>
          )}
          <div className="px-2.5 py-1 text-[10px] text-ink-muted/60">id: {toolCallId}</div>
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-2.5 py-1.5">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-muted/70">
        {label}
      </div>
      {children}
    </div>
  );
}

function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
