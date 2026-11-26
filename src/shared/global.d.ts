import type { DesktopAgentBridge } from "./bridge";

/** preload 通过 contextBridge 暴露的唯一全局对象。 */
declare global {
  interface Window {
    desktopAgent: DesktopAgentBridge;
  }
}

export {};
