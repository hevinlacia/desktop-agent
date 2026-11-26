import { useState } from "react";
import { useAgentStore } from "@/stores/useAgentStore";
import { cn } from "@/lib/utils";

/**
 * 扩展 UI 对话框（权限确认、/panel-req-list 级联选择等）。
 * pi 在 RPC 模式下的 `confirm`/`select`/`input`/`editor` 会阻塞等待响应，
 * 所以这里必须给"取消"出口，否则 agent 会一直挂着。
 *
 * 布局约束（REQ-338）：
 * - 选项列表必须有滚动上限，标题与页脚固定在滚动区外——悬浮窗只有 132px 高、
 *   对话窗 720px，/panel-req-list 一页 32 个选项约 1200px，没有滚动时翻页项
 *   和取消按钮会被裁出窗口，表现为"选中途中卡死"。
 * - select 只能靠点选项作答：页脚不放"确定"（旧实现会用空文本作答，
 *   扩展侧拿到 "" 后静默退出）。
 */
export function ExtensionUiDialog() {
  const request = useAgentStore((s) => s.extensionUi);
  const respond = useAgentStore((s) => s.respondUi);
  const dismiss = useAgentStore((s) => s.dismissUi);
  // key 跟着请求 id 走：换对话框时重置输入与过滤状态。
  return (
    <DialogCard key={request?.id ?? "none"} request={request} respond={respond} dismiss={dismiss} />
  );
}

function DialogCard({
  request,
  respond,
  dismiss,
}: {
  request: ReturnType<typeof useAgentStore.getState>["extensionUi"];
  respond: ReturnType<typeof useAgentStore.getState>["respondUi"];
  dismiss: ReturnType<typeof useAgentStore.getState>["dismissUi"];
}) {
  const [text, setText] = useState("");
  const [filter, setFilter] = useState("");

  if (!request || request.kind === "notify") return null;

  const options = request.kind === "select" ? request.options : [];
  // 长列表给一个本地过滤框（纯前端过滤，0 依赖）：/panel-req-list 一页 30 条时直接敲 ID 收敛。
  const showFilter = options.length > 8;
  const needle = filter.trim().toLowerCase();
  const visible =
    showFilter && needle ? options.filter((opt) => opt.toLowerCase().includes(needle)) : options;

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/25 backdrop-blur-[1px]">
      <div className="flex w-[min(420px,88%)] flex-col rounded-xl border border-border-subtle bg-surface-raised p-3.5 shadow-2xl">
        <div className="text-[13px] font-medium text-ink">
          {"title" in request ? request.title : "确认"}
        </div>

        {request.kind === "confirm" && (
          <div className="selectable mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-muted">
            {request.message}
          </div>
        )}

        {request.kind === "select" && (
          <>
            {showFilter && (
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="输入关键词过滤（支持 ID 片段）"
                className="mt-2 w-full rounded-md border border-border-subtle bg-surface px-2 py-1 text-[12px] outline-none focus:border-accent/60"
              />
            )}
            <div
              className="mt-2 space-y-1 overflow-y-auto"
              // 视口高 - 卡片其余部分（标题/过滤框/页脚/内边距约 180px），最低 140px 保证可滚动。
              style={{ maxHeight: "max(140px, calc(100vh - 180px))" }}
            >
              {visible.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => void respond(true, opt)}
                  className="w-full shrink-0 rounded-md border border-border-subtle px-2.5 py-1.5 text-left text-[12px] transition hover:border-accent/50 hover:bg-accent-soft/60"
                >
                  {opt}
                </button>
              ))}
              {visible.length === 0 && (
                <div className="px-2.5 py-2 text-[12px] text-ink-muted">没有匹配的选项</div>
              )}
            </div>
          </>
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
          {request.kind !== "select" && (
            <button
              type="button"
              onClick={() => void respond(true, text)}
              className={cn(
                "rounded-md bg-accent px-2.5 py-1 text-[11.5px] text-white transition hover:opacity-90",
              )}
            >
              确定
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
