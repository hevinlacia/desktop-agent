//! 系统托盘。左键切换窗口；菜单提供形态切换、新会话、退出。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::{desktop::window, WindowMode};

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let open_compact = MenuItem::with_id(app, "compact", "悬浮窗（紧凑）", true, None::<&str>)?;
    let open_full = MenuItem::with_id(app, "full", "对话窗口", true, None::<&str>)?;
    let new_session = MenuItem::with_id(app, "new_session", "新建会话", true, None::<&str>)?;
    let open_config = MenuItem::with_id(app, "config", "打开配置文件", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open_compact,
            &open_full,
            &PredefinedMenuItem::separator(app)?,
            &new_session,
            &open_config,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Desktop Agent")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "compact" => window::show_window(app, WindowMode::Compact),
            "full" => window::show_window(app, WindowMode::Full),
            "new_session" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::commands::reset_session_inner(&app).await {
                        log::warn!("新建会话失败：{e}");
                    }
                    window::show_window(&app, WindowMode::Full);
                });
            }
            "config" => {
                let path = crate::config::AppConfig::path();
                // 用系统默认程序打开；失败就只记日志。
                let _ = std::process::Command::new("xdg-open").arg(path).spawn();
            }
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::commands::shutdown_agent(&app).await;
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::toggle_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
