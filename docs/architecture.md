# 架构

## 进程模型

三个进程，职责不重叠：

| 进程 | 目录 | 职责 |
|---|---|---|
| 主进程 | `src/main` | 窗口形态、托盘、全局快捷键、配置文件、Agent 子进程的拉起与看护 |
| 渲染进程 | `src/renderer` | 全部界面。沙箱 + 上下文隔离，拿不到 Node |
| Agent 子进程 | `src/agent` | 只做一件事：调 pi SDK，把会话事件翻译成前端事件 |

主进程与渲染进程之间隔着 preload（`src/preload`），它只放行 `src/shared/bridge.ts` 里列出的命令与事件。主进程与 Agent 子进程之间是 `utilityProcess` 的消息通道，协议在 `src/shared/agentIpc.ts`。三端共用的类型（事件、消息、配置）都在 `src/shared/protocol.ts`。

把 pi 放在独立进程里的原因：Agent 的工具（`bash`、`write`）不和窗口代码混在一起；pi 或其依赖出问题不会带走界面，主进程会重启它（最多 3 次，间隔 1.5 秒，超限后在界面上报「反复崩溃」）。

## 启动顺序

```
app.setName / 单实例锁
  → whenReady → loadConfig（含旧版 KWin 脚本检测）
  → 创建窗口（不显示）           → ready-to-show → 以完整形态显示
  → 注册 IPC、托盘、全局快捷键
  → agent.start()：拉起子进程，init 握手，30 秒内未就绪则在界面报错
```

首次启动直接给完整窗口，否则用户只看到一个托盘图标，不知道程序起来没有。

## 一条消息的路径

```
输入框回车
  → store.send：先把用户消息乐观插入消息列表
  → agentClient.send → preload → ipcMain「agent_send」
  → AgentProcess.prompt（等子进程就绪后转发）
  → AgentHost.prompt → pi session.prompt
        ↓ 事件流
  session.subscribe → mapSessionEvent（归一化）→ parentPort
  → 主进程 agent.onEvent → webContents.send「agent://event」
  → agentClient.onAgentEvent → store.applyEvent → React
```

`agent_send` 返回的是**受理结果**而不是最终结果：`started`（开跑了）、`queued`（运行中发来的补充指令，排队）、`handled`（被扩展命令直接处理，没有起一轮运行）。真正结束看 `runSettled` 事件。

`applyEvent` 里有两件事别的地方不要重复做：

- **流式拼接**：delta 按 `contentIndex` 归块，`blockEnd` / `messageCommitted` 的内容是权威值，到达时覆盖。
- **按 `sessionId` 过滤**：切换会话后，旧会话的迟到事件直接丢弃。所以任何「换会话」都必须让渲染进程知情（走它自己的 `newSession` / `switchSession`），否则新会话的事件会被全部丢掉。

## 会话的新建与切换

`AgentHost` 用 pi 的 `AgentSessionRuntime` 管理会话，做法和 pi 自带的 RPC 模式一致：

1. `runtime.newSession()` / `switchSession()` 会换掉底层的 session 对象。
2. 每次替换后调 `rebind()`：取消旧的事件订阅 → 订阅新 session → 重新 `bindExtensions`。
3. 扩展的 UI 请求（确认、选择、输入、通知）经 `ExtensionUIContext` 转发给主进程，渲染进程弹出对话框，用户作答后再 resolve，扩展代码本身无感知。

事件到达渲染进程时都带着新的 `sessionId`；渲染进程在发起新建/切换后重新取一次 `agent_state`，两边就对上了。

## 窗口形态

形态（悬浮窗 `compact` / 对话窗口 `full`）以主进程为真源，因为托盘、快捷键、命令行都会绕过渲染进程直接改它：

- 每次变更后主进程广播 `window://mode-changed`。
- 渲染进程启动时**先订阅、再取当前值**（`window_mode`），中间不会漏掉变更。
- 悬浮窗展开会话侧边栏时，渲染进程经 `window_resize` 临时把窗口加高；宿主每次进入 `compact` 都按配置复位尺寸，所以 store 在进入 `compact` 时要把「侧边栏已展开」复位。

窗口是透明 + 无边框，圆角和内描边由 `.app-shell` 用 CSS 画。标题栏靠 `-webkit-app-region: drag` 拖动。

最大化记的是偏好而不只是状态：窗口的 `maximize` / `unmaximize` 事件把 `fullMaximized` 写进配置并广播给界面；切到悬浮窗时先还原（悬浮窗是个小条），切回对话窗口时按偏好再最大化。实现上有一条容易踩的顺序——**必须先更新形态再动窗口**，否则切形态时那次还原会被当成「用户取消了最大化」，把偏好冲掉。

还有一个合成器带来的坑：取消最大化时，合成器恢复的是它记住的「最大化之前的尺寸」。从悬浮窗切回对话窗口后**立刻**最大化（应用启动、或在悬浮窗里发消息自动切回，都是这个路径），合成器记住的可能还是悬浮窗的尺寸，于是还原后窗口缩成一条。所以这种情况下打一个标记，还原完成后把尺寸纠正成对话窗口的；用户自己点的最大化不纠正（还原就该回到点之前的尺寸）。

## 模型切换

可选模型来自 Agent 子进程的 `models`（pi 的 `modelRuntime.getAvailable()`，只含当前有可用凭据的），界面在标题栏。切换走已有的 `agent_set_model`，调用 pi 的 `session.setModel` 时**不传 `persist`**：不写 pi 的全局默认模型。pi 终端里从 `/model` 面板选定是会写默认的，这里刻意不一样——改全局默认会连带影响终端里的 pi。

「新建会话沿用上个会话使用的模型」是应用自己做的：点选模型时主进程把它写进配置 `lastModel`；Agent 子进程启动时和每次新建会话时（界面、托盘、扩展发起的都算）应用它，该模型已不可用就回落到默认并记一条告警。切换到已有会话不覆盖那个会话自己的模型，但它会成为之后新建会话时沿用的对象。

叠在悬浮窗上的列表（会话侧边栏、命令联想）都需要窗口临时加高：各自在 store 里报所需高度，窗口取较大值，都不需要时恢复配置高度。

## 斜杠命令联想

命令列表来自 Agent 子进程的 `commands`，与 pi 自带 RPC 模式的 `get_commands` 同源：扩展注册的命令、prompt 模板、skill（名字带 `skill:` 前缀）。输入框只在光标还停在开头的命令词里时弹出列表，按需拉取并缓存 30 秒。

联想只做一件事：把命令名补进输入框。回车提交仍走普通的 `prompt()`，由 pi 自己识别 `/` 命令——扩展命令立即执行，skill 和模板展开成提示词。

## 配置变更

`config_set` 保存后分三类处理：

| 改了什么 | 怎么生效 |
|---|---|
| 快捷键 | 立即重新注册；新写法不可用时回退旧值并报错，其余设置照常保存 |
| 窗口尺寸 | 按当前形态重新应用 |
| 工作目录 / 会话持久化 / 扩展开关 | 是子进程的启动参数：通知渲染进程（`agent://reset`）→ 重启子进程 → 渲染进程重新取状态 |

## 退出

所有退出路径走同一条线：`before-quit`（置退出标志）→ 关窗（「关窗只是隐藏」的逻辑此时放行）→ `will-quit`（等 Agent 收尾、落盘）→ `app.exit()`。托盘的「退出」、系统的 `SIGTERM`（注销、关机）都是这条路。

## 自检

`just smoke` 用一个环境变量让应用启动后自己走完整条链路再退出，见 [testing.md](testing.md)。
