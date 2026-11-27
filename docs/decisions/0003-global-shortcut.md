# 0003：全局快捷键只在打包版注册（`toggleShortcut` 可置空关闭）

- 状态：已采纳（2026-11-27）
- 关联：REQ-342

## 背景

Linux Wayland 下 `globalShortcut` 走 XDG desktop portal（`GlobalShortcutsPortal`）。两个实测结论：

1. **Chromium 每次注册都用新的随机 shortcut id**（32 位 hex token），而 KDE 的授权按 `(component, shortcut id)` 记 —— 所以每次进程启动都算一次新请求，都弹一遍「全局快捷键权限请求」。
   证据：`~/.config/kglobalshortcutsrc` 的 `[desktop-agent]` 段累积了 51 个不同 id（每个历史启动一个，前一个被置为 `none`），全部同名 `desktop-agent shortcut: Command+Space`。
2. **开发态这个注册本来也不生效**：没有已安装的 `.desktop` 身份，`register()` 返回 true 不代表能用。而 `just dev` 下主进程一改就重启，等于「改一次代码弹一次权限窗」，纯噪音。

## 决定

1. 开发态（`!app.isPackaged`）**默认不注册**，只在日志里说一句；要调 portal 链路时用 `DESKTOP_AGENT_SHORTCUT=1` 强制打开。
2. `toggleShortcut` 允许置空（`""`）= 不注册全局快捷键。打包版想要零弹窗就置空，再用桌面环境的自定义快捷键指向 `desktop-agent toggle`。
3. 换绑时**精确释放旧写法**（`unregisterShortcut`），不再「先 `unregisterAll()` 再注册」。注册仍优先于释放，失败能原地回退。

## 后果

- 好：调试不再弹窗；打包版有明确的零弹窗出路；`kglobalshortcutsrc` 不再每次启动多一条僵尸条目。
- 差：打包版保持默认 `Super+Space`（不改动既有行为），因此**每次启动仍会弹一次授权窗** —— 这是 Chromium 生成随机 id 导致的，应用侧无法复用上次授权。
- 未验证（需要人在场点弹窗，见 REQ-342 notes）：如果退出时不再主动释放（现在 `will-quit` 里还有 `unregisterAll`），Chromium 下次启动通过 `ListShortcuts` 能否复用同一个 id。若能，打包版就能做到「授权一次之后不再弹」。

## 考虑过的其它做法

- **先用 `unregisterAll()` 再注册**（原实现）：会让旧 id 每次都被置为 `none`，新 id 每次都新申请，正是问题来源。
- **在应用内做一个「自己记住授权」的开关**：KDE 的授权不由应用决定，应用侧只能决定「要不要发起请求」。
- **开发态照常注册、只在 CI 关闭**：挡不住人手动 `just dev`，等于没解决。
