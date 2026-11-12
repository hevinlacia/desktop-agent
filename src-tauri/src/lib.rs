//! 库入口：把 Tauri 初始化拆成 `run()`，便于将来加集成测试。
//!
//! Wayland 相关修复必须在 `tauri::Builder` 之前做（见 `main.rs`）。

pub mod agent;
pub mod commands;
pub mod config;
pub mod desktop;
pub mod state;

pub use state::WindowMode;

use tauri::Manager;

pub fn run() {
    let cfg = config::AppConfig::load();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二个实例启动：唤起已有窗口。用户再点一次图标一般是想要完整界面。
            desktop::window::show_window(app, WindowMode::Full);
        }))
        .invoke_handler(tauri::generate_handler![
            commands::agent_state,
            commands::agent_send,
            commands::agent_abort,
            commands::agent_new_session,
            commands::agent_switch_session,
            commands::agent_stats,
            commands::agent_models,
            commands::agent_set_model,
            commands::agent_set_thinking_level,
            commands::agent_set_session_name,
            commands::agent_extension_ui_response,
            commands::agent_restart,
            commands::agent_sessions,
            commands::window_show,
            commands::window_hide,
            commands::window_toggle,
            commands::window_switch_mode,
            commands::config_get,
            commands::config_set,
            commands::config_path,
            commands::kwin_install,
            commands::kwin_uninstall,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            state::set_app_handle(handle.clone());
            state::set_config(cfg.clone());

            // 1. D-Bus 服务：给 KWin 脚本和 CLI 唤起提供入口。
            desktop::kwin::spawn_dbus_service();

            // 2. KWin 脚本：注册全局快捷键 + 窗口居中。失败不阻断启动。
            match desktop::kwin::install_kwin_script(&cfg.toggle_shortcut) {
                Ok(true) => log::info!("KWin 脚本已更新，快捷键 {}", cfg.toggle_shortcut),
                Ok(false) => log::debug!("KWin 脚本无需更新"),
                Err(e) => log::warn!("KWin 脚本安装失败（快捷键可能不生效）：{e}"),
            }

            // 3. 托盘。
            if let Err(e) = desktop::tray::init(&handle) {
                log::warn!("托盘初始化失败：{e}");
            }

            // 4. 初始窗口形态：首次启动直接给完整窗口，否则用户只会看到一个托盘图标，
            // 不知道程序到底跑起来没有。之后由快捷键/托盘切回紧凑形态。
            if let Some(window) = app.get_webview_window(desktop::window::MAIN_WINDOW) {
                if let Err(e) = desktop::window::apply_full(&window, &cfg) {
                    log::warn!("初始窗口形态设置失败：{e}");
                }
                let _ = window.show();
                let _ = window.set_focus();
                state::set_window_mode(&handle, WindowMode::Full);
            }

            // 5. 预热 agent（异步，不阻塞启动）。
            commands::warm_up(handle.clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 初始化失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                // 关窗不退出，靠托盘/快捷键再次唤起。
                api.prevent_exit();
            }
            let _ = app;
        });
}
