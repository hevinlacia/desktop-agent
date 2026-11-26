# 0001：外壳从 Tauri 换到 Electron

- 状态：已采纳（2026-11-26）
- 取代：Tauri v2 + Rust 宿主 + `pi --mode rpc` 子进程 + KWin 脚本 / D-Bus 集成
- 后续：[0002](0002-bun.md) 把包管理器从 pnpm 换成了 Bun

## 背景

原版用 Tauri v2，在 KDE Plasma 6 / Wayland 上有三个绕不过去的问题：

1. **做不出真圆角**。无边框窗口的四个角要真透明，靠的是透明窗口 + compositor。WebKitGTK 2.54.3 上透明窗口不可靠：隔离实测 8 次只有 1 次完整保持，其余要么一开始就是空的，要么先完整后逐步丢失（最后只剩每秒重绘的光标）。与 `WEBKIT_DISABLE_DMABUF_RENDERER`、`WEBKIT_DISABLE_COMPOSITING_MODE`、X11 后端的取值都无关。KWin 自己也只裁切窗口底角（约 5px），顶角是直角。
2. **系统集成全靠 KDE 专属手段**。Wayland 下 `global-hotkey` crate 只有 X11 后端，窗口不能自定位、不能置顶。原版为此写了一个 KWin 脚本（注册快捷键、居中）加一个 D-Bus 服务来回调，换别的桌面就得重做。
3. **接入 pi 要自己维护约 1000 行协议适配器**。`pi --mode rpc` 的 JSONL 分帧、delta 拼接、事件归一化都在项目里，pi 一升级就要跟着对。

## 决定

外壳换成 Electron，pi 改用官方 TypeScript SDK 跑在独立子进程（`utilityProcess`）里。前端原地复用，唯一的宿主边界是 `services/agentClient.ts`。

## 事先做的验证

动手迁移前用 Electron 45.5.0（Chrome 156 / Node 24）在同一个环境（Plasma 6.8.3 / Wayland）做了一轮验证，全部通过：

| 要验证的 | 结果 |
|---|---|
| Wayland 原生支持 | 不加任何参数，默认走 `ozone/wayland` |
| 透明窗口 + 真圆角 | 四角 alpha 为 0，圆角 14px；真实桌面合成截图里四角和阴影干净 |
| 透明窗口运行时改尺寸 | 720×132 ↔ 1080×720 来回切 4 次再加 9 秒静置，画面像素漂移 0.00% |
| 全局快捷键 | KDE Wayland 下 `globalShortcut.register("Super+Space")` 成功（走桌面 portal） |
| pi SDK 在 utilityProcess 里 | 包能加载（157 个导出），`createAgentSession` 317ms 就绪，真实提问 1.7 秒返回、25 个事件 |

## 考虑过的其它做法

- **留在 Tauri，继续修圆角**。已经试过透明窗口的各种组合和 X11 后端，没有一条路能稳定。就算修好，第 2、3 点还在。
- **GPUI**。不解决系统集成（托盘、全局快捷键、单实例），API 0.2.2 一年没更新且绑定 Zed，Markdown / 代码高亮全要自建。否决。
- **Electron + 移植原来的 RPC 适配器**。可行，但既然有官方 SDK，就没有理由继续自己维护协议层。
- **pi SDK 跑在主进程里**。工具（`bash`、`write`）会和窗口代码同进程，pi 崩溃会带走界面。否决。

## 后果

好的：

- 不再需要 Rust 工具链，也不依赖系统里的 `pi` 命令、KWin 脚本、D-Bus 服务。
- 真圆角；窗口能在两种形态之间带动画缩放。
- 前端约 2400 行原样保留，只换了 `agentClient.ts`。
- 直接用 pi SDK：新建 / 切换会话、扩展绑定都交给 pi 自己的 `AgentSessionRuntime`。
- 扩展默认开启（原版是以 `--no-extensions` 运行的），可在设置里关。

代价与约束：

- 体积和内存：pacman 包约 111MB（AppImage / deb 尺寸相近），装完约 430MB；后台常驻一个 Chromium。
- Wayland 下的全局快捷键走桌面 portal：应用必须有桌面身份（安装后带 `.desktop` 文件），首次使用需要用户在系统弹窗里授权一次。AppImage 本身不带身份（除非另外集成 `.desktop`），所以全局快捷键以 deb / pacman 安装为准。
- 构建期依赖镜像：Electron 二进制和 electron-builder 工具包默认从 GitHub 下载，国内需要 npmmirror。
- 打包不用 asar（pi SDK 依赖 `fs`、动态 `import()`、WASM，按目录分发最稳），文件数多（约 2.1 万个）。
- 旧版装在本机的 KWin 脚本会抢占 `Meta+Space`，必须卸载，步骤见 README「从旧版迁移」。

## 带来的新约束

- 契约从「前后端两方」变成「渲染进程 / 主进程 / 子进程三方」，统一放在 `src/shared/`。
- 渲染进程按 `sessionId` 丢弃迟到事件，而绕过它换会话会让后续事件全被丢掉，所以测试必须走界面路径。
- 自检用离屏渲染，因为窗口被盖住时合成器不再发帧回调，`capturePage` 只能拿到旧帧。
