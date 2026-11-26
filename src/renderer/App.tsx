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
  onModeChanged,
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
  const applyHostMode = useAgentStore((s) => s.applyHostMode);

  // 启动：拉一次会话状态 + 订阅事件流。
  useEffect(() => {
    void bootstrap();

    const disposers: Array<() => void> = [];
    let cancelled = false;

    // 监听是同步注册的，所以下面的取消函数可以直接收好。
    const track = (unlisten: () => void) => {
      if (cancelled) unlisten();
      else disposers.push(unlisten);
    };

    track(onAgentEvent(applyEvent));
    track(onBootError(setBootError));
    track(onReset(() => void newSession()));
    track(onExternalAsk((text) => void send(text)));
    // 窗口形态以宿主为准。先订阅再取当前值，两者之间不会漏掉变更。
    track(onModeChanged(applyHostMode));
    void windowClient.mode().then(applyHostMode).catch(() => undefined);

    return () => {
      cancelled = true;
      for (const d of disposers) d();
    };
  }, [bootstrap, applyEvent, setBootError, newSession, send, applyHostMode]);

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

      <div className="flex min-h-0 flex-1">
        <Sidebar variant={mode} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 悬浮窗不显示消息流：发送后由 InputBox 切到完整形态 */}
          {compact ? <div className="min-h-0 flex-1" /> : <MessageList />}
          <InputBox compact={compact} />
        </div>
      </div>

      <ExtensionUiDialog />
    </div>
  );
}
