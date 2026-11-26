# AGENTS.md - desktop-agent

个人桌面 AI Agent 客户端。Electron 外壳 + React 渲染进程；Agent 能力由 pi 官方 SDK 提供，跑在独立的 utility 子进程里。

## Scope

- 覆盖 `<repo>/` 全部源码：`src/main`（主进程）、`src/preload`、`src/agent`（Agent 子进程）、`src/renderer`（React）、`src/shared`（三端共用的契约）、`docs/`。
- 技术栈：Electron 45 + React 19 + TypeScript + electron-vite + Tailwind v4；Agent 侧 `@earendil-works/pi-coding-agent` SDK。Bun 做包管理与脚本入口，构建工具跑在 Node 上。
- 上级规范：`~/Developer/tools/.agents/conventions/{project-baseline,typescript-react-vite-frontend,typescript-fullstack}.md`。本文件只记本项目特有的约束。

## Architecture Entry

- 主进程入口 `src/main/index.ts` 只做装配；窗口 `window.ts`、托盘 `tray.ts`、快捷键 `shortcut.ts`、配置 `config.ts`、IPC `ipc.ts`、子进程管理 `agentProcess.ts`、自检 `selftest.ts`
- Agent 子进程入口 `src/agent/index.ts` → `host.ts`（调 pi SDK）；事件归一化在 `mapping.ts`（纯函数）
- **契约单一来源** `src/shared/`：`protocol.ts`（AgentEvent / ChatMessage / AppConfig），`agentIpc.ts`（主进程 ↔ 子进程），`bridge.ts`（渲染进程 ↔ 主进程）
- preload `src/preload/index.ts` 只放行 `bridge.ts` 列出的通道
- 渲染进程入口 `src/renderer/main.tsx` → `App.tsx`；IPC 唯一出口 `services/agentClient.ts`；状态单一来源 `stores/useAgentStore.ts`
- pi SDK 权威文档：全局安装目录下的 `docs/sdk.md`（`~/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/`），类型定义在包内 `dist/core/*.d.ts`

## Commands

```
just install      # bun install，并提前下好 Electron 二进制（走 npmmirror）
just dev          # 开发模式：渲染进程 HMR，主进程改动自动重启
just build        # 构建主进程 / 预加载 / Agent 子进程 / 渲染进程到 out/
just start        # 运行已构建产物（不打包）
just typecheck    # node 侧 + web 侧两个 tsconfig
just test         # vitest 单测
just smoke        # 端到端自检：两种形态布局、两轮真实提问、链接安全，退出码即结果
just package      # 打包到 release/，默认只打 pacman；just package appimage deb 可点名别的目标
just check        # 交付前：typecheck + test + build
```

## Rules

### 契约与分层

1. 改一条命令要同步三处：`bridge.ts` 的 `COMMANDS` + `CommandIO` → 主进程的处理器（`CommandHandlers` 类型强制全覆盖）→ `renderer/services/agentClient.ts`。渲染进程其它文件不得直接用 `window.desktopAgent`。
2. 涉及 pi 的命令再多两处：`agentIpc.ts` 的 `AgentRequest` 与 `agent/host.ts` 的 `handle()`。
3. 所有事件必须带 `sessionId`，store 按它丢弃切会话后的迟到事件。推论：**绕过渲染进程直接调主进程的 `newSession()`/`switchSession()`，之后的事件会被渲染进程当成过期事件丢掉**。测试必须走界面路径（见 `selftest.ts` 的 `clickNewSession` / `typeAndSubmit`）。
4. 事件归一化只在 `mapping.ts` 做，保持纯函数并带单测；store 不认识 pi 的事件。

### pi SDK

1. 会话的新建 / 切换交给 `AgentSessionRuntime`；会话被替换后必须重新 `subscribe` 并 `bindExtensions`（`host.ts` 的 `rebind`）。结构参照 pi 自带的 RPC 模式。
2. 扩展的 UI 上下文必须**逐个显式实现全部方法**。pi 把 UI 上下文交给扩展时会拷贝方法，用 Proxy 兜底「未知属性返回空函数」无效，运行时才报 `ctx.ui.xxx is not a function`。
3. 运行结束看 `agent_settled`（映射为 `runSettled`），不是 `agent_end`；`message_end.message` 是最终权威值；流刚建立时 pi 会先给一条空 assistant 消息，要跳过。
4. SDK 会话默认不带 CLI 的内置扩展（codemode / tool_search / MCP），`host.ts` 里补齐以保持和命令行一致；配置 `extensions: false` 时全部关闭。
5. pi 是纯 ESM，而打包产物是 CJS：`agent/index.ts` 用 `new Function("specifier", "return import(specifier)")` 加载。别改成静态 import，打包器会改写它。
6. 不要传 `noTools`：实测传了以后 `activeTools` 仍会列出面板工具，名不副实。

### 窗口与桌面集成

1. 窗口形态以主进程为真源：改形态一律走 `window.ts` 的 `showWindow` / `switchMode`（会广播 `window://mode-changed`），不要在别处直接 `setSize`。渲染进程启动时**先订阅该事件、再取 `window_mode`**；`store.mode` 的初始值只是占位。
2. 悬浮窗展开会话侧边栏时，窗口高度由渲染进程经 `window_resize` 临时加高。宿主每次进入 compact 形态都会按配置复位尺寸，所以切到 compact 时 store 必须复位 `compactSidebarOpen`。
3. 透明圆角：`transparent: true` + `frame: false`，圆角与内描边由 `.app-shell` 画。**开着 DevTools 时窗口不透明**，验圆角先关 DevTools。
4. Wayland 下客户端不能置顶、不能自定位（`placeCompact` 在 Wayland 直接返回）。置顶靠 KDE 窗口规则。
5. 全局快捷键走桌面 portal，应用需要有桌面身份：`package.json` 的 `desktopName` 必须等于安装后的 `.desktop` 文件名（由 electron-builder 的 `executableName` 决定）。开发态 `register()` 也会返回 true，但不代表能用。首次使用时 KDE 会弹「全局快捷键权限请求」，需要用户本人授权。
6. 旧版（Tauri）的 KWin 脚本会在合成器层抢走 `Meta+Space`，portal 快捷键就永远收不到。`legacy.ts` 会在启动时检测并提示，卸载步骤在 README「从旧版迁移」。
7. 窗口被别的窗口盖住时 KWin 不再发帧回调，Chromium 会停在旧画面上。要看真实画面，窗口必须在前（或用离屏渲染）。

### 退出

所有退出路径都经 `before-quit`（置退出标志，让「关窗只是隐藏」放行）→ `will-quit`（等 Agent 收尾）→ `app.exit()`。除自检外不要在别处直接 `app.exit()`，否则会话来不及落盘。

### 链接

渲染进程里的链接一律由 `window.ts` 交给系统浏览器，窗口自己不导航、不开新窗口。只放行 http(s)（`externalUrl.ts`）——链接来自模型输出，不可信。

### 构建与打包

1. `asar: false` 是有意为之：pi SDK 及其依赖大量使用 `fs`、动态 `import()`、WASM，按目录原样分发最稳。
2. Electron 二进制和 electron-builder 工具包走 npmmirror（justfile，环境变量可覆盖）。镜像地址**末尾必须有 `/`**，否则拼出来的路径会 404。
3. Bun 的项目配置在 `bunfig.toml`。Bun 默认不执行依赖的安装脚本，白名单是 `trustedPackages`（只需要 esbuild）。
4. Electron 45 起**没有 postinstall**，二进制在首次运行时才下载，所以 `just install` 会显式调一次 `node_modules/electron/install.js` 提前下好。
5. Bun 不会把 `.npmrc` 的自定义键传给脚本（实测 `npm_config_*` 为空），只认 registry / 鉴权那几个键。npm 时代靠 `npm_config_electron_mirror` 的做法在这里无效，下载源只能靠环境变量 `ELECTRON_MIRROR`。
6. 脚本里的构建工具靠 `#!/usr/bin/env node` 跑在系统 Node 上。`bun run` 不要加 `--bun`，否则工具会被放到 Bun 运行时上（未验证）。
7. 默认只打 pacman 包（作者只在 Arch 系上使用），其它目标保留在 `electron-builder.yml` 里、按需点名。electron-builder 认 `bun.lock`，用它的 Bun 收集器收集生产依赖；动过依赖或打包配置后，对产物跑一次自检（见 docs/testing.md）。
8. just 的 shebang 配方拿不到位置参数，只能用 `{{插值}}` 把调用方给的参数写进脚本。
9. 打 deb / pacman 时维护者信息取自本机 git 身份，不要把邮箱写进仓库。用的是 electron-builder 自带的 fpm，它依赖 `libcrypt.so.1`——Arch 上要装 `libxcrypt-compat`。

### 安全

- 渲染进程保持 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`，生产构建注入 CSP（`electron.vite.config.mts`）。
- 桌面端默认给 pi 全工具（含 `bash` / `write`，无二次确认），工具集跟随 pi 的设置（`~/.pi/agent/settings.json`），本项目不另设收紧开关。
- 不提交：`.env`、token、会话 JSONL（含真实对话内容）、`out/`、`release/`、`tmp/`。

## 已知限制

- 详见 README「已知限制」。未实现：文件拖拽附件、slash 命令补全。
- 只在 KDE Plasma 6 (Wayland) 上实测过；macOS / Windows 的打包配置写了但没验证。
