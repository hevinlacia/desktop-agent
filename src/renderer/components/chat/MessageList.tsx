import { useEffect, useRef } from "react";
import { useAgentStore, liveToBlocks } from "@/stores/useAgentStore";
import { Blocks } from "./MessageBubble";
import { MessageBubble } from "./MessageBubble";
import { Loader2, Sparkles } from "lucide-react";

/**
 * 对话流。
 * 性能要点：流式期间只有最后一段是"活的"，已 committed 的消息不 re-render
 * （MessageBubble 未 memo，但数组元素引用不变时 React 仍会渲染——所以对话流
 * 只在 running/live 变化时整体重跑，MVP 规模下可接受；后续按需加虚拟列表）。
 */
export function MessageList() {
  const messages = useAgentStore((s) => s.messages);
  const olderMessages = useAgentStore((s) => s.olderMessages);
  const hasOlder = useAgentStore((s) => s.hasOlder);
  const loadingOlder = useAgentStore((s) => s.loadingOlder);
  const loadEarlier = useAgentStore((s) => s.loadEarlier);
  const live = useAgentStore((s) => s.live);
  const running = useAgentStore((s) => s.running);
  const commandRunning = useAgentStore((s) => s.commandRunning);
  const compacting = useAgentStore((s) => s.compacting);
  const sessionBusy = useAgentStore((s) => s.sessionBusy);
  const toolExec = useAgentStore((s) => s.toolExec);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 自动跟随到底部；只在内容增长时滚，避免用户上翻被打断。
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, live]);

  const liveBlocks = liveToBlocks(live);
  const hasLive = liveBlocks.length > 0;
  // 首屏只有最近一页（REQ-346）：更早的按页往前拼，渲染与流式互不干扰。
  const all = [...olderMessages, ...messages];

  return (
    <div className="flex-1 overflow-y-auto scroll-thin px-3 py-2">
      {messages.length === 0 && !hasLive && olderMessages.length === 0 && <EmptyState />}

      {hasOlder && (
        <button
          type="button"
          onClick={() => void loadEarlier()}
          className="mx-auto mb-1 block rounded border border-border-subtle px-2 py-0.5 text-[10.5px] text-ink-muted transition hover:bg-surface-raised hover:text-ink"
        >
          {loadingOlder ? "加载中…" : "加载更早的消息"}
        </button>
      )}

      {all.map((m, i) => (
        <MessageBubble key={`${m.timestamp}-${i}`} message={m} toolExec={toolExec} />
      ))}

      {hasLive && (
        <div className="flex gap-2 px-1 py-2">
          <div className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent text-white">
            <Sparkles size={12} />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <Blocks blocks={liveBlocks} toolExec={toolExec} streaming={running} />
          </div>
        </div>
      )}

      {/* 重启/恢复窗口期没有事件流：必须显式提示，否则像卡死（REQ-344 ④）。优先于「等待模型响应」。 */}
      {sessionBusy && (
        <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-ink-muted">
          <Loader2 size={12} className="animate-spin" />
          {sessionBusy === "restart" ? "正在重启 Agent…" : "正在恢复会话…"}
        </div>
      )}

      {running && !hasLive && !sessionBusy && (
        <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-ink-muted">
          <Loader2 size={12} className="animate-spin" />
          等待模型响应…
        </div>
      )}

      {/* 扩展斜杠命令不跑模型，不能显示「等待模型响应」（会误以为卡死）。 */}
      {commandRunning && !running && (
        <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-ink-muted">
          <Loader2 size={12} className="animate-spin" />
          执行命令中…
        </div>
      )}

      {compacting && (
        <div className="mx-auto my-2 w-fit rounded-full bg-surface-sunken px-3 py-1 text-[11px] text-ink-muted">
          正在压缩上下文…
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
      <div className="text-[13px] font-medium text-ink-muted">有什么要做的？</div>
      <div className="text-[11.5px] leading-relaxed text-ink-muted/70">
        直接输入问题，或用 / 触发命令
        <br />
        Meta+Space 唤起 · Esc 收起
      </div>
    </div>
  );
}
