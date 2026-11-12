import { AlertTriangle, X } from "lucide-react";
import { useAgentStore } from "@/stores/useAgentStore";

/** 启动期错误（pi 未安装、cwd 不存在等）常驻提示条。 */
export function BootErrorBar() {
  const error = useAgentStore((s) => s.bootError);
  const setBootError = useAgentStore((s) => s.setBootError);
  const bootstrap = useAgentStore((s) => s.bootstrap);
  if (!error) return null;

  return (
    <div className="flex items-start gap-2 border-b border-danger/30 bg-danger/8 px-3 py-2 text-[11.5px] text-danger">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Agent 未就绪</div>
        <div className="selectable mt-0.5 break-words opacity-85">{error}</div>
        <button
          type="button"
          onClick={() => {
            setBootError(null);
            void bootstrap();
          }}
          className="mt-1 rounded border border-danger/40 px-1.5 py-0.5 text-[10.5px] transition hover:bg-danger/10"
        >
          重试
        </button>
      </div>
      <button
        type="button"
        onClick={() => setBootError(null)}
        className="shrink-0 opacity-60 transition hover:opacity-100"
        aria-label="关闭"
      >
        <X size={12} />
      </button>
    </div>
  );
}
