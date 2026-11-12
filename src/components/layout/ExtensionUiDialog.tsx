import { useState } from "react";
import { useAgentStore } from "@/stores/useAgentStore";
import { cn } from "@/lib/utils";

/**
 * 扩展 UI 对话框（权限确认等）。
 * pi 在 RPC 模式下的 `confirm`/`select`/`input`/`editor` 会阻塞等待响应，
 * 所以这里必须给"取消"出口，否则 agent 会一直挂着。
 */
export function ExtensionUiDialog() {
  const request = useAgentStore((s) => s.extensionUi);
  const respond = useAgentStore((s) => s.respondUi);
  const dismiss = useAgentStore((s) => s.dismissUi);
  const [text, setText] = useState("");

  if (!request || request.kind === "notify") return null;

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/25 backdrop-blur-[1px]">
      <div className="w-[min(420px,88%)] rounded-xl border border-border-subtle bg-surface-raised p-3.5 shadow-2xl">
        <div className="text-[13px] font-medium text-ink">
          {"title" in request ? request.title : "确认"}
        </div>

        {request.kind === "confirm" && (
          <div className="selectable mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-muted">
            {request.message}
          </div>
        )}

        {request.kind === "select" && (          <div className="mt-2 space-y-1">
            {request.options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => void respond(true, opt)}
                className="w-full rounded-md border border-border-subtle px-2.5 py-1.5 text-left text-[12px] transition hover:border-accent/50 hover:bg-accent-soft/60"
              >
                {opt}
              </button>
            ))}
          </div>
        )}

        {(request.kind === "input" || request.kind === "editor") && (
          <textarea
            autoFocus
            value={request.kind === "editor" && !text ? (request.prefill ?? "") : text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`${request.kind === "input" ? (request.placeholder ?? "") : ""}`}
            rows={request.kind === "editor" ? 8 : 2}
            className="selectable mt-2 w-full resize-none rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-accent/60"
          />
        )}

        <div className="mt-3 flex justify-end gap-1.5">
          <button
            type="button"
            onClick={dismiss}
            className="rounded-md border border-border-subtle px-2.5 py-1 text-[11.5px] text-ink-muted transition hover:bg-surface-sunken"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void respond(true, text)}
            className={cn(
              "rounded-md bg-accent px-2.5 py-1 text-[11.5px] text-white transition hover:opacity-90",
            )}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
