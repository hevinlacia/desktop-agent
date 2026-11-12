import { useEffect } from "react";
import { MessageList } from "@/components/chat/MessageList";
import { InputBox } from "@/components/input/InputBox";
import { BootErrorBar } from "@/components/layout/BootErrorBar";
import { ExtensionUiDialog } from "@/components/layout/ExtensionUiDialog";
import { TitleBar } from "@/components/layout/TitleBar";
import { Sidebar } from "@/components/layout/Sidebar";
import {
  agentClient,
  onAgentEvent,
  onBootError,
  onExternalAsk,
  onReset,
  windowClient,
} from "@/services/agentClient";
import { useAgentStore } from "@/stores/useAgentStore";

export default function App() {
  const mode = useAgentStore((s) => s.mode);
  const ready = useAgentStore((s) => s.ready);
  const bootstrap = useAgentStore((s) => s.bootstrap);
  const applyEvent = useAgentStore((s) => s.applyEvent);
  const setBootError = useAgentStore((s) => s.setBootError);
  const newSession = useAgentStore((s) => s.newSession);
  const send = useAgentStore((s) => s.send);

  // 启动：拉一次会话状态 + 订阅事件流。
  useEffect(() => {
    void bootstrap();

    const disposers: Array<() => void> = [];
    let cancelled = false;

    const track = (p: Promise<() => void>) => {
      void p.then((fn) => {
        if (cancelled) fn();
        else disposers.push(fn);
      });
    };

    track(onAgentEvent(applyEvent));
    track(onBootError(setBootError));
    track(onReset(() => void newSession()));
    // CLI 唤起：`desktop-agent ask "..."` → 直接发送
    track(onExternalAsk((text) => void send(text)));

    return () => {
      cancelled = true;
      for (const d of disposers) d();
    };
  }, [bootstrap, applyEvent, setBootError, newSession, send]);

  // 全局键盘：Esc 收起窗口（除非焦点在对话框里）。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector("[data-modal-open]")) return;
      if (useAgentStore.getState().extensionUi) return;
      void windowClient.hide();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // 失焦自动隐藏：悬浮窗的通用行为，但完整对话模式下不要（用户会切到浏览器看文档）。
  useEffect(() => {
    if (mode !== "compact") return;
    const onBlur = () => {
      // 延迟一下，避免点到托盘/菜单时误隐藏。
      window.setTimeout(() => {
        if (!document.hasFocus()) void windowClient.hide();
      }, 180);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [mode]);

  // 形态变化时同步一次状态（尺寸变了但数据没变，只需确认连接活着）。
  useEffect(() => {
    if (!ready) return;
    void agentClient.state().catch(() => undefined);
  }, [mode, ready]);

  const compact = mode === "compact";

  return (
    <div className="app-shell relative">
      <TitleBar mode={mode} />
      <BootErrorBar />

      {compact ? (
        <>
          <div className="min-h-0 flex-1" />
          <InputBox compact />
        </>
      ) : (
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <MessageList />
            <InputBox compact={false} />
          </div>
        </div>
      )}

      <ExtensionUiDialog />
    </div>
  );
}
