# Desktop Agent

个人桌面 AI Agent 客户端。KDE Plasma 6 / Wayland 原生，托盘常驻，快捷键唤起；对话能力由 [pi](https://github.com/earendil-works/pi) 官方 SDK 提供，跑在独立子进程里。

**解决什么**：把 `pi` 这类 CLI agent 变成随手可唤起的桌面工具，流式回答、工具调用过程可视化。
**不解决什么**：不做多用户/多租户、不做云端同步、不做团队协作。

## 技术栈

| 层 | 选型 |
|---|---|
| 外壳 | Electron 45（主进程 TypeScript） |
| 前端 | React 19 + TypeScript + Vite + Tailwind v4 |
| 渲染 | react-markdown + remark-gfm + shiki |
| 状态 | zustand |
| Agent | pi 官方 SDK（`@earendil-works/pi-coding-agent`），跑在 utility 子进程 |
| 构建 | electron-vite、electron-builder（默认只打 pacman 包，可选 AppImage / deb） |
| 工具链 | Bun 负责装依赖和启动脚本；构建工具与 Electron 本身跑在 Node 上 |

不再依赖 Rust 工具链、系统里的 `pi` 命令、KWin 脚本和 D-Bus 服务。模型与凭据沿用 pi 自己的配置（`~/.pi/agent/`）。

## 快速开始

依赖：Node 22+、Bun 1.2+、just（mise 会按 `.mise.toml` 自动提供）；本机 pi 已配好可用模型。

```bash
just install   # 装依赖，并把 Electron 二进制下好（走 npmmirror）
just dev       # 开发模式：渲染进程热更新，主进程改动自动重启
```

用 `just install` 而不是直接 `bun install`：Electron 45 起不再有 postinstall，二进制要到首次运行才下载，不带 `ELECTRON_MIRROR` 会去连 GitHub。

首次启动会生成 `~/.config/desktop-agent/config.json`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `just dev` | 开发模式 |
| `just build` / `just start` | 构建到 `out/` / 运行构建产物 |
| `just typecheck` | TS 类型检查（node 侧 + web 侧） |
| `just test` | 单元测试 |
| `just smoke` | 端到端自检，退出码即结果，详见 [docs/testing.md](docs/testing.md) |
| `just check` | 交付前检查：typecheck + test + build |
| `just package` | 打包到 `release/`，默认只打 pacman；要点名别的目标见下文 |

## 打包与安装

```bash
just package
# release/desktop-agent-0.2.0-x64.pkg.tar.xz
sudo pacman -U release/desktop-agent-0.2.0-x64.pkg.tar.xz
```

目前只在 Arch 系上使用，所以默认只打 pacman 包。其它目标按需点名（能力保留，但只在 pacman 上验证过）：

```bash
just package appimage deb     # desktop-agent-0.2.0-x86_64.AppImage、desktop-agent-0.2.0-amd64.deb
just package pacman appimage  # 可以混着点
```

| 目标 | 安装 | 说明 |
|---|---|---|
| pacman | `sudo pacman -U …` | 自带桌面身份，全局快捷键可用 |
| deb | `sudo apt install ./….deb` | 同上 |
| AppImage | 直接运行 | 便携，但**不带桌面身份，全局快捷键用不了**。Arch 上直接运行需要 `fuse2`，或加参数 `--appimage-extract-and-run` |

打包前提：

- 首次打包会下载 electron-builder 的工具包，默认走 npmmirror（环境变量 `ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR` 可覆盖）。
- 打 deb / pacman 时用的是 electron-builder 自带的 fpm，它依赖 `libcrypt.so.1`，Arch 上需要 `libxcrypt-compat`。
- deb / pacman 的维护者信息取自本机 git 身份。

## 快捷键

默认 `Meta+Space`：悬浮窗可见且有焦点时收起，否则唤起悬浮窗（Wayland 下出现的位置由合成器决定）。发送后会自动切到完整窗口看回答，`Esc` 收起。

改法有两种：

- 界面：侧边栏 → 设置 → 快捷键
- 文件：`~/.config/desktop-agent/config.json` 的 `toggleShortcut`（Electron 写法，如 `Super+Space`、`Ctrl+Alt+A`；旧版的 `Meta+X` 会自动映射）

**首次使用需要你授权一次**：Wayland 下全局快捷键由桌面 portal 代管，KDE 会弹出「全局快捷键权限请求」，确认后才生效。

没生效时按顺序排查：

1. 应用顶部有没有错误条（注册失败、旧版 KWin 脚本残留都会在这里提示）
2. 从终端启动，看日志里有没有 `[shortcut] 全局快捷键已注册：…`
3. 是不是以 AppImage 方式运行的（没有桌面身份）
4. 有没有被别的程序占用：`grep -n 'Meta+Space' ~/.config/kglobalshortcutsrc`
5. 开发模式（`just dev`）下不要指望快捷键能用，用下面的替代方式

命令行（再启动一次程序即可，参数会转交给已经在跑的实例）：

```bash
desktop-agent                      # 把窗口带到前台
desktop-agent toggle               # 有焦点就收起，没显示就唤起
desktop-agent ask "<问题>"          # 外部程序代用户提问，等同在输入框里发了一句
```

其它唤起方式：托盘菜单。

## 从旧版（Tauri）迁移

旧版靠一个 KWin 脚本实现全局快捷键，它会在合成器层抢走 `Meta+Space`，让新版的快捷键失效。卸载步骤（新版启动时若检测到残留也会提示）：

```bash
kwriteconfig6 --file kwinrc --group Plugins --key desktop-agentEnabled --delete
trash-put ~/.local/share/kwin/scripts/desktop-agent            # 或 rm -r
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript desktop-agent   # 当前会话立即生效
qdbus6 org.kde.KWin /KWin reconfigure
```

如果 `~/.config/kglobalshortcutsrc` 里还残留 `desktop-agent` 开头的快捷键行，也一并删掉。

配置文件无需手动迁移：路径和有效字段都不变，读取时会忽略已废弃的 `piBinary` / `piArgs`。会话存在 pi 的目录里，与旧版共用。

## 配置

`~/.config/desktop-agent/config.json`：

| 字段 | 说明 |
|---|---|
| `cwd` | Agent 工作目录（工具的 cwd、会话按此目录归组） |
| `persistSession` | 会话是否保存到 pi 的会话目录；`false` = 内存会话，关闭即丢 |
| `extensions` | 是否加载 pi 的扩展（等同 CLI 的 `--no-extensions` 取反） |
| `toggleShortcut` | 全局快捷键，Electron 写法 |
| `compactWidth` / `compactHeight` | 悬浮窗尺寸，默认 720×132 |
| `fullWidth` / `fullHeight` | 完整窗口尺寸，默认 1080×720 |

工作目录、`persistSession`、`extensions` 是 Agent 子进程的启动参数，改动后子进程会重启。

## 架构

```
┌─ 主进程 src/main ──────────────┐      ┌─ Agent 子进程 src/agent ───────┐
│ 窗口形态 / 托盘 / 快捷键 / 配置 │ IPC  │ AgentHost（pi SDK）            │
│ AgentProcess：请求配对、崩溃重启│ ←──→ │   ├ SessionRuntime 新建/切换   │
└──────────┬──────────────────────┘      │   ├ rebind：重新订阅 + 绑定扩展│
        preload（只放行契约通道）          │   └ mapping：事件归一化        │
┌─ 渲染进程 src/renderer ───────┐      └────────────────────────────────┘
│ agentClient（唯一 IPC 出口）  │
│ useAgentStore（流式拼接、按 sessionId 过滤）→ React │
└───────────────────────────────┘
```

契约都在 `src/shared/`：`protocol.ts`（事件与消息）、`bridge.ts`（渲染进程 ↔ 主进程）、`agentIpc.ts`（主进程 ↔ 子进程）。

窗口形态（悬浮窗 / 对话窗口）以主进程为真源，每次变更都广播 `window://mode-changed`。悬浮窗左侧也有同一个会话侧边栏：默认收起成窄栏，展开时窗口自动加高以显示列表；在列表里选中会话会切到完整窗口。

细节见 [docs/architecture.md](docs/architecture.md)。为什么从 Tauri 换到 Electron 见 [docs/decisions/0001-electron.md](docs/decisions/0001-electron.md)，为什么用 Bun 见 [docs/decisions/0002-bun.md](docs/decisions/0002-bun.md)。

## 已知限制

- Wayland 下悬浮窗无法置顶、无法自定位。需要置顶时在「系统设置 → 窗口规则」里给窗口类 `desktop-agent` 加「保持在最前」
- 全局快捷键需要带桌面身份的安装方式，且首次要本人授权；只在 KDE Plasma 6 上验证过
- 默认给 Agent 全工具权限（含 `bash` / `write`，无二次确认）。工具集跟随 pi 的设置（`~/.pi/agent/settings.json`）
- 扩展的自定义界面组件（`ctx.ui.custom`）不支持；pi CLI 启动时的项目信任确认、HTTP 代理设置属于 CLI 的启动逻辑，这里没有接入
- 附件拖拽、slash 命令补全未实现
- macOS / Windows 的打包配置写了但没验证

## 许可证

MIT
