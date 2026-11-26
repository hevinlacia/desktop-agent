import { app, Menu, Tray, nativeImage, shell } from "electron";
import path from "node:path";
import { configPath } from "./config";
import type { WindowMode } from "../shared/protocol";

export interface TrayHandlers {
  show(mode: WindowMode): void;
  toggle(): void;
  newSession(): Promise<void>;
  quit(): void;
}

export function createTray(handlers: TrayHandlers): Tray {
  const icon = nativeImage.createFromPath(iconPath()).resize({ width: 22, height: 22 });
  const tray = new Tray(icon);
  tray.setToolTip("Desktop Agent");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "悬浮窗（紧凑）", click: () => handlers.show("compact") },
      { label: "对话窗口", click: () => handlers.show("full") },
      { type: "separator" },
      {
        label: "新建会话",
        click: () => {
          // 失败原因没有别的出口，这里必须兜住，否则是未处理的 Promise 拒绝。
          void handlers.newSession().catch((err: unknown) => console.error("新建会话失败：", err));
        },
      },
      {
        label: "打开配置文件",
        click: () => {
          // shell.openPath 失败时返回错误文案，不抛异常。
          void shell.openPath(configPath()).then((error) => {
            if (error) console.error(`打开配置文件失败（${configPath()}）：${error}`);
          });
        },
      },
      { type: "separator" },
      { label: "退出", click: () => handlers.quit() },
    ]),
  );
  tray.on("click", () => handlers.toggle());
  return tray;
}

/** 图标随应用走：开发态在项目根，打包后在 resources/app 下。 */
function iconPath(): string {
  return path.join(app.getAppPath(), "resources", "icon.png");
}
