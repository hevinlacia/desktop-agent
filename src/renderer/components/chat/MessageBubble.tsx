import { AlertTriangle, Info, Sparkles, User } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage, ContentBlock } from "@shared/protocol";
import type { ToolExecution } from "@/stores/useAgentStore";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";

interface MessageBubbleProps {
  message: ChatMessage;
  toolExec: Record<string, ToolExecution>;
}

export function MessageBubble({ message, toolExec }: MessageBubbleProps) {
  switch (message.role) {
    case "user":
      return (
        <div className="flex gap-2 px-1 py-2" data-role="user">
          <Avatar className="bg-accent-soft text-accent">
            <User size={12} />
          </Avatar>
          <div className="selectable min-w-0 flex-1 whitespace-pre-wrap break-words pt-0.5 text-[13.5px] leading-relaxed">
            {message.text}
          </div>
        </div>
      );

    case "assistant":
      return (
        <div className="flex gap-2 px-1 py-2" data-role="assistant">
          <Avatar className="bg-accent text-white">
            <Sparkles size={12} />
          </Avatar>
          <div className="min-w-0 flex-1 pt-0.5">
            <Blocks blocks={message.blocks} toolExec={toolExec} />
            {message.errorMessage && (
              <div className="mt-1.5 flex items-start gap-1.5 rounded-md border border-danger/40 bg-danger/5 px-2 py-1.5 text-[11.5px] text-danger">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span className="selectable">{message.errorMessage}</span>
              </div>
            )}
          </div>
        </div>
      );

    case "tool":
      // 工具结果已经由 ToolCallCard 呈现（通过 toolCallId 关联），
      // 这里只在孤儿结果（找不到对应调用）时降级显示。
      return null;

    case "notice":
      return (
        <div
          className={cn(
            "mx-auto my-1.5 flex max-w-[92%] items-start gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px]",
            message.level === "error"
              ? "bg-danger/8 text-danger"
              : "bg-surface-sunken text-ink-muted",
          )}
        >
          {message.level === "error" ? (
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          ) : (
            <Info size={12} className="mt-0.5 shrink-0" />
          )}
          <span className="selectable">{message.text}</span>
        </div>
      );

    case "system":
      return null;
  }
}

interface BlocksProps {
  blocks: ContentBlock[];
  toolExec: Record<string, ToolExecution>;
  streaming?: boolean;
}

/** 内容块渲染：文本走 Markdown，思考/工具各自成卡。 */
export function Blocks({ blocks, toolExec, streaming }: BlocksProps) {
  return (
    <>
      {blocks.map((block, i) => {
        const isLast = i === blocks.length - 1;
        if (block.type === "text") {
          if (!block.text.trim()) return null;
          return (
            <Markdown key={`t-${i}`} streaming={streaming && isLast}>
              {block.text}
            </Markdown>
          );
        }
        if (block.type === "thinking") {
          return (
            <ThinkingBlock
              key={`th-${i}`}
              text={block.thinking}
              {...(streaming && isLast ? { streaming: true } : {})}
            />
          );
        }
        return (
          <ToolCallCard
            key={block.toolCallId || `tc-${i}`}
            toolCallId={block.toolCallId}
            toolName={block.toolName}
            args={block.args}
            execution={toolExec[block.toolCallId]}
          />
        );
      })}
    </>
  );
}

function Avatar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
        className,
      )}
    >
      {children}
    </div>
  );
}
