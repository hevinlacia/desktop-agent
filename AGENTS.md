# AGENTS.md - desktop-agent

个人桌面 AI Agent 客户端。Tauri v2 外壳（Rust）+ React 前端，Agent 能力通过可插拔适配器对接本地 `pi --mode rpc` 子进程。

## Scope

- 覆盖 `<repo>/` 全部源码：`src/`（React）、`src-tauri/`（Rust 宿主 + 适配器）、`kwin/`（KDE 集成素材）、`docs/`。
- 技术栈：Tauri v2 + React 19 + TypeScript + Vite + Tailwind v4；Rust 侧 tokio + zbus。
- 上级规范：`~/Developer/tools/AGENTS.md` 与 `~/Developer/tools/.agents/conventions/{project-baseline,rust-tauri-desktop,typescript-react-vite-frontend}.md`。本文件只记本项目特有约束。

## Architecture Entry

- 前端入口：`src/main.tsx` → `src/App.tsx`
- **前后端唯一契约**：`src/types/protocol.ts` ↔ `src-tauri/src/agent/mod.rs`（改一边必须改另一边）
- IPC 唯一出口：`src/services/agentClient.ts`（UI 层禁止直接 `invoke`）
- 状态单一来源：`src/stores/useAgentStore.ts`（流式拼接只在这里做）
- Agent 抽象：`src-tauri/src/agent/mod.rs` 的 `AgentAdapter` trait
- Pi 实现：`src-tauri/src/agent/pi_adapter.rs`（子进程 + JSONL 分帧 + 事件归一）
- 窗口/托盘/KDE 集成：`src-tauri/src/desktop/{window,tray,kwin}.rs`
- 配置：`src-tauri/src/config.rs`，落盘 `~/.config/desktop-agent/config.json`
- 协议权威文档：`~/.pi/agent/install/releases/<ver>/node_modules/@earendil-works/pi-coding-agent/docs/{rpc,rpc-commands,json,message-types}.md`

## Commands

```
just install           # pnpm install
just tauri-dev         # Tauri 开发模式（前端 HMR + Rust 重编）
just typecheck         # tsc --noEmit
just lint              # cargo clippy --all-targets -D warnings
just test              # Rust 单测
just test-integration  # 真拉起 pi 子进程（需本机 pi + 可用模型）
just build             # 打包 deb / AppImage
just check             # 交付前：typecheck + lint + test + build-web
just run               # 编译并运行 debug 版
```

## Rules

### 协议层（最容易踩坑）

1. pi 的 `message_update` 是 **delta-only**：wire 层去掉了 `partial` 快照，必须用 `contentIndex` 自己拼，并用 `*_end` 事件的 `content` **覆盖**（不是追加）。`message_end.message` 是最终权威值。
2. `toolcall_start` 的 `id` / `toolName` 在 wire 上被提升到 `assistantMessageEvent` 顶层，**不在** `toolCall` 字段里。`toolcall_delta` 不带 id，只能挂到最近开始的调用。
3. 分帧**只按 LF 切**。`U+2028`/`U+2029` 在 JSON 字符串里合法，Node 的 `readline` 会错误切分。
4. stdout 只放协议，诊断在 stderr。stdout 读不动会 stall 子进程。
5. 会话/运行生命周期：`agent_end` ≠ 结束，等 `agent_settled`。

### KDE Wayland（实测约束，别按 X11 思路改）

1. **全局快捷键不用 `tauri-plugin-global-shortcut`**。它依赖 `global-hotkey` crate，Linux 只有 X11 后端（Wayland 下 no-op 静默失效）。本项目改用 KWin script `registerShortcut()` + D-Bus 反调，见 `desktop/kwin.rs`。
2. **Wayland 下客户端无法绝对定位窗口**，`set_position()` 被 compositor 忽略。「悬浮窗居中」由 KWin script 的 `frameGeometry` 实现，Rust 侧只做尺寸/置顶/焦点。
3. **不要开 `transparent: true`**。WebKitGTK 透明会失去合成加速，流式渲染掉帧。圆角用 CSS + 无边框窗口。
4. `WEBKIT_DISABLE_DMABUF_RENDERER=1` 在 `main.rs` 里按需设置，必须在 GTK 初始化**之前**。

### 架构纪律

1. 适配器只做「协议归一化」，不解释业务语义。前端只消费 `UnifiedAgentEvent`。
2. 换后端 = 实现一个 `AgentAdapter`，前端零改动。不要把 pi 细节泄漏到 `App.tsx` 或 store。
3. 所有事件必须带 `sessionId`；前端按它丢弃切会话后的迟到事件。
4. 适配器启动必须持 `state::acquire_spawn_lock()`，否则预热与首个 command 会并发 spawn 出两个 pi 进程。

### 安全

- 桌面端默认给 pi 全工具（含 `bash`/`write`，无确认）。要收紧就用配置项 `piArgs` 传 `--exclude-tools` / `--tools`，或 `--tools` 白名单。
- 不提交 `.env`、token、会话 JSONL（含真实对话内容）、`src-tauri/target`、`dist`。

## 已知待办

- M2：文件拖拽附件（pi `prompt` 支持 `images` base64，UI 侧未接）
- M2：slash 命令补全（`get_commands` 已可用）
- M3：Windows 规则/KWin script 精确居中与动画
- `env_logger` 已初始化；排查用 `RUST_LOG=desktop_agent=debug`
