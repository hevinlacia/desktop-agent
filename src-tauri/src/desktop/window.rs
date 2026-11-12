//! 窗口形态控制。
//!
//! Wayland 下客户端**无法**绝对定位窗口（`set_position` 被 compositor 忽略），
//! 所以"Raycast 式居中悬浮"不在这里实现，而是交给 KWin 脚本（见 `kwin/` 与 `desktop/kwin.rs`）。
//! 这里只负责尺寸、置顶、焦点、显示/隐藏这些 compositor 允许的操作。

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow};

use crate::config::AppConfig;

pub const MAIN_WINDOW: &str = "main";

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

/// 切到紧凑形态（悬浮命令框）。
pub fn apply_compact(window: &WebviewWindow, cfg: &AppConfig) -> tauri::Result<()> {
    window.set_size(tauri::LogicalSize::new(cfg.compact_width, cfg.compact_height))?;
    window.set_always_on_top(true)?;
    window.set_skip_taskbar(true)?;
    Ok(())
}

/// 切到完整形态（常规对话窗口）。
pub fn apply_full(window: &WebviewWindow, cfg: &AppConfig) -> tauri::Result<()> {
    window.set_size(tauri::LogicalSize::new(cfg.full_width, cfg.full_height))?;
    window.set_always_on_top(false)?;
    window.set_skip_taskbar(false)?;
    Ok(())
}

/// 居中到当前屏幕。仅 X11 与部分 compositor 生效；Wayland 下由 KWin 脚本兜底。
fn center_on_active_screen(window: &WebviewWindow) {
    if std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland") {
        // 明确跳过：Wayland 下调用 set_position 无效且会打 warning。
        return;
    }
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else { return };
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let x = m_pos.x + ((m_size.width as i32 - size.width as i32) / 2).max(0);
    let y = m_pos.y + ((m_size.height as i32 - size.height as i32) / 3).max(0);
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// 显示窗口并聚焦。紧凑形态额外置顶 + 居中（若平台允许）。
pub fn show_window(app: &AppHandle, mode: crate::WindowMode) {
    let Some(window) = main_window(app) else { return };
    let cfg = crate::state::config(app);

    let result = match mode {
        crate::WindowMode::Compact => apply_compact(&window, &cfg),
        crate::WindowMode::Full => apply_full(&window, &cfg),
    };
    if let Err(e) = result {
        log::warn!("应用窗口形态失败：{e}");
    }

    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    if matches!(mode, crate::WindowMode::Compact) {
        center_on_active_screen(&window);
    }
    crate::state::set_window_mode(app, mode);
}

pub fn hide_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.hide();
    }
}

/// 快捷键/托盘触发的开关：可见就藏，隐藏就按当前形态显示并聚焦。
pub fn toggle_window(app: &AppHandle) {
    let Some(window) = main_window(app) else { return };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);

    if visible && focused {
        hide_window(app);
        return;
    }
    if !visible {
        // 未显示时按紧凑悬浮进入，符合"随手唤起"的使用习惯；
        // 用户按 Esc 或点关闭只是隐藏，下次唤起仍从紧凑开始。
        show_window(app, crate::WindowMode::Compact);
        return;
    }
    let _ = window.set_focus();
}

/// 切形态并保持可见。
pub fn switch_mode(app: &AppHandle, mode: crate::WindowMode) {
    let Some(window) = main_window(app) else { return };
    let cfg = crate::state::config(app);
    let result = match mode {
        crate::WindowMode::Compact => apply_compact(&window, &cfg),
        crate::WindowMode::Full => apply_full(&window, &cfg),
    };
    if let Err(e) = result {
        log::warn!("切换窗口形态失败：{e}");
    }
    crate::state::set_window_mode(app, mode);
}
