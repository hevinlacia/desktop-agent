# Desktop Agent

个人桌面 AI Agent 客户端。KDE Plasma 6 / Wayland 原生，托盘常驻，快捷键唤起；对话能力通过适配器对接本地 [pi](https://github.com/earendil-works/pi) agent。

**解决什么**：把 `pi` 这类 CLI agent 变成随手可唤起的桌面工具，流式回答、工具调用过程可视化。
**不解决什么**：不做多用户/多租户、不做云端同步、不做团队协作。

## 技术栈

| 层 | 选型 |
|---|---|
| 外壳 | Tauri v2（Rust） |
| 前端 | React 19 + TypeScript + Vite + Tailwind v4 |
| 渲染 | react-markdown + remark-gfm + shiki |
| 状态 | zustand |
| Agent 后端 | 本地 `pi --mode rpc` 子进程（可替换适配器） |
| KDE 集成 | KWin script（快捷键 + 居中）+ D-Bus |

## 快速开始

```bash
# 依赖：
#   Node 20+ / pnpm 10+ / Rust 1.85+
#   pi CLI（能被 PATH 找到，或配置 piBinary 绝对路径）
#   KDE Plasma 6：webkit2gtk-4.1、libayatana-appindicator

just install          # 装前端依赖
just tauri-dev        # 开发模式
# 或
just run              # 编译并跑 debug 版
```

首次启动会：
1. 生成 `~/.config/desktop-agent/config.json`
2. 安装 KWin 脚本到 `~/.local/share/kwin/scripts/desktop-agent/` 并启用
3. 注册 D-Bus 服务 `org.hevin.DesktopAgent`
4. 拉起 `pi --mode rpc` 子进程

## 常用命令

```
just typecheck        # TS 类型检查
just lint             # cargo clippy
just test             # Rust 单测（KWin 脚本生成等）
just test-integration # 集成测试：真拉起 pi 子进程验证事件映射
just build            # 打包 deb / AppImage
just check            # 交付前全量检查
```

## 快捷键

默认 `Meta+Space`。改法有两种：

- 界面：侧边栏 → 设置 → 快捷键（保存后会重装 KWin 脚本）
- 文件：`~/.config/desktop-agent/config.json` 的 `toggleShortcut`（KWin 语法，如 `Meta+Space`、`Ctrl+Alt+A`）

没生效时排查顺序：
1. 系统设置 → 快捷键 → 搜索 "Desktop Agent" 是否列出
2. `gdbus call --session --dest org.hevin.DesktopAgent --object-path /desktopagent --method org.hevin.DesktopAgent.Toggle` 是否能唤起（验证 D-Bus 通路）
3. `kreadconfig6 --file kwinrc --group Plugins --key desktop-agentEnabled` 应为 `true`

也可以不经快捷键直接开：托盘菜单 / `desktop-agent toggle` / 再启动一次程序（单实例会用已有进程展示窗口）。

## 配置

`~/.config/desktop-agent/config.json`（不传环境变量，全走这个文件）：

| 字段 | 说明 |
|---|---|
| `piBinary` | pi 可执行文件，留空走 PATH |
| `cwd` | Agent 工作目录（工具 cwd、会话按此目录分组） |
| `piArgs` | 传给 pi 的附加参数，如 `["--model", "anthropic/claude-sonnet-4"]` |
| `persistSession` | 是否用 pi 的持久化会话（false = 每次全新） |
| `toggleShortcut` | KWin 快捷键语法 |
| `compactWidth/Height` | 悬浮窗尺寸 |
| `fullWidth/Height` | 完整窗口尺寸 |

## 架构

```
src/                     React 前端
├── types/protocol.ts    ← 前后端唯一契约（与 agent/mod.rs 对应）
├── services/agentClient.ts  ← 唯一 IPC 出口
├── stores/useAgentStore.ts  ← 流式拼接、按 sessionId 过滤
└── components/
    ├── chat/            消息渲染、Markdown+shiki、thinking/tool 卡片
    ├── input/           输入框（Enter 发送 / Esc 收起）
    └── layout/          标题栏、侧边栏（会话列表）、错误条、扩展对话框

src-tauri/src/
├── main.rs              入口：Wayland 环境变量、CLI 子命令
├── lib.rs               Tauri 组装
├── commands.rs          前端 IPC 命令
├── config.rs            配置读写
├── state.rs             全局单例 + 事件 sink
├── agent/
│   ├── mod.rs           AgentAdapter trait + UnifiedAgentEvent
│   └── pi_adapter.rs    pi 子进程管理、JSONL 分帧、事件归一
└── desktop/
    ├── window.rs        形态切换（紧凑/完整）
    ├── tray.rs          托盘菜单
    └── kwin.rs          KWin 脚本 + D-Bus 服务
```

数据流：

```
用户输入 → store.send → agentClient → Tauri command
        → AgentAdapter.prompt → pi stdin（JSONL）
pi stdout → PiAdapter 解析 → UnifiedAgentEvent → Tauri emit
        → 前端 listen → store.applyEvent → 渲染
```

换后端只需实现 `AgentAdapter`（`agent/mod.rs`），前端与服务层不动。

## 适配器实现要点

pi 的 RPC 协议有几个必须踩对的点，改 `pi_adapter.rs` 前请先读：

- `message_update` 是 **delta-only**，用 `contentIndex` 拼块，`*_end` 的 `content` 覆盖而非追加
- `toolcall_start` 的 `id`/`toolName` 在 wire 层被提升到事件顶层
- 分帧只按 LF 切（`U+2028` 是合法 JSON 内容）
- 运行结束等 `agent_settled`，不是 `agent_end`

协议权威文档在 pi 安装目录的 `docs/{rpc,rpc-commands,json,message-types}.md`。

## 已知限制

- Wayland 下窗口不能自定位，「居中」由 KWin script 代劳；换其他 compositor（sway/hyprland）需另做集成
- 全局快捷键依赖 KWin script，非 KDE 桌面需自行绑定 `desktop-agent toggle`
- 附件拖拽、slash 命令补全未实现
- 默认给 agent 全工具权限（含 `bash`/`write`，无二次确认）；要收紧用 `piArgs` 传 `--exclude-tools`

## 许可证

MIT
