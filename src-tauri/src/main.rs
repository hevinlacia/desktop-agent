//! 入口。
//!
//! 顺序很重要：Wayland 环境变量修复必须在 Gtk/WebKit 初始化之前完成，
//! 否则要等应用起来再改就已经晚了。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;

fn main() {
    init_wayland_env();

    // 日志默认只报 warn 及以上；排查时用 RUST_LOG=desktop_agent=debug。
    // 必须在任何 log:: 调用前初始化，否则启动期的 KWin/托盘告警会全部丢失。
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("desktop_agent=info,warn"),
    )
    .format_timestamp_millis()
    .init();

    // CLI 互操作：供 KDE 自定义快捷键 / 脚本直接调用。
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("toggle") | Some("show") => {
            if let Err(e) = desktop_agent_lib::desktop::kwin::cli_toggle() {
                eprintln!("desktop-agent: 未找到运行中的实例（{e}）");
                std::process::exit(1);
            }
            return;
        }
        Some("version") | Some("--version") | Some("-V") => {
            println!("desktop-agent {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        _ => {}
    }

    desktop_agent_lib::run();
}

/// KDE Plasma 6 纯 Wayland 会话下的已知问题修复。
///
/// 1. `WEBKIT_DISABLE_DMABUF_RENDERER=1`
///    WebKitGTK 的 DMA-BUF 渲染在部分 AMD/Mesa 组合下会整窗白屏或崩溃。
///    设置后回退到共享内存合成，性能略降但稳定。
/// 2. `WEBKIT_DISABLE_COMPOSITING_MODE=1`
///    在无 GPU 加速或软件渲染时避免 WebKit 进程崩溃（仅当用户显式要求时生效）。
///
/// 用户已显式设置的值一律不覆盖——让他们能自主探测性能。
fn init_wayland_env() {
    let is_wayland = env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland")
        || env::var("WAYLAND_DISPLAY").is_ok();

    if is_wayland && env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: 单线程启动阶段，尚未创建任何线程。
        unsafe { env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }

    // WebKitGTK 在非 UTF-8 locale 下渲染 CJK 会出方块。
    if env::var("LANG")
        .map(|l| !l.to_lowercase().contains("utf-8") && !l.to_lowercase().contains("utf8"))
        .unwrap_or(true)
    {
        unsafe { env::set_var("LANG", "zh_CN.UTF-8") };
    }
}
