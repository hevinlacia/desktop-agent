//! 全局单进程状态。
//!
//! 刻意不用 `Mutex<Option<Arc<dyn AgentAdapter>>>` 一把梭：适配器的启停是异步的，
//! 用 `RwLock<Option<Arc<...>>>` 让读路径（发消息）不必等启动。

use std::sync::{Arc, OnceLock, RwLock};

use tauri::{AppHandle, Emitter};

use crate::agent::{AgentAdapter, UnifiedAgentEvent};
use crate::config::AppConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowMode {
    Compact,
    Full,
}

struct AppState {
    app: OnceLock<AppHandle>,
    adapter: RwLock<Option<Arc<dyn AgentAdapter>>>,
    /// 串行化适配器启动：预热和前端首个 command 会并发进入，
    /// 不加锁会同时 spawn 两个 pi 子进程。
    spawn_lock: tokio::sync::Mutex<()>,
    config: RwLock<AppConfig>,
    mode: RwLock<WindowMode>,
}

fn state() -> &'static AppState {
    static STATE: OnceLock<AppState> = OnceLock::new();
    STATE.get_or_init(|| AppState {
        app: OnceLock::new(),
        adapter: RwLock::new(None),
        spawn_lock: tokio::sync::Mutex::new(()),
        config: RwLock::new(AppConfig::load()),
        mode: RwLock::new(WindowMode::Compact),
    })
}

pub fn set_app_handle(app: AppHandle) {
    let _ = state().app.set(app);
}

pub fn app_handle() -> Option<AppHandle> {
    state().app.get().cloned()
}

pub fn config(app: &AppHandle) -> AppConfig {
    let _ = app; // 保持签名与调用点一致；配置是全局单例。
    state().config.read().unwrap().clone()
}

pub fn set_config(cfg: AppConfig) {
    *state().config.write().unwrap() = cfg;
}

pub fn adapter() -> Option<Arc<dyn AgentAdapter>> {
    state().adapter.read().unwrap().clone()
}

pub fn set_adapter(adapter: Option<Arc<dyn AgentAdapter>>) {
    *state().adapter.write().unwrap() = adapter;
}

/// 取得适配器启动锁。`ensure_adapter` 与重启路径都必须先拿它。
pub async fn acquire_spawn_lock() -> tokio::sync::MutexGuard<'static, ()> {
    state().spawn_lock.lock().await
}

pub fn window_mode(app: &AppHandle) -> WindowMode {
    let _ = app;
    *state().mode.read().unwrap()
}

pub fn set_window_mode(app: &AppHandle, mode: WindowMode) {
    let _ = app;
    *state().mode.write().unwrap() = mode;
}

pub const EVENT_CHANNEL: &str = "agent://event";

/// 把适配器事件转发给前端。
pub fn make_sink(app: AppHandle) -> crate::agent::SharedSink {
    Arc::new(move |event: UnifiedAgentEvent| {
        if let Err(e) = app.emit(EVENT_CHANNEL, &event) {
            log::warn!("事件广播失败：{e}");
        }
    })
}

/// 前端 IPC 用的 app handle（`Manager::app_handle` 的薄封装，便于在非 Tauri 上下文使用）。
pub fn handle_of<R: tauri::Runtime>(app: &AppHandle<R>) -> AppHandle<R> {
    app.clone()
}
