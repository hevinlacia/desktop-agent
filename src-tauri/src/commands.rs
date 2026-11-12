//! 暴露给前端的 Tauri commands。
//!
//! 约定：
//! - 所有错误统一 `Result<T, String>`，前端能直接展示。
//! - 适配器懒启动：第一次 `agent_state` / `agent_send` 时才 spawn 子进程，
//!   避免应用一开就拉一个空 pi 进程。

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::agent::pi_adapter::{PiAdapter, PiSpawnOptions};
use crate::agent::{AgentAdapter, ExtensionUiResponse, ImageInput, PromptOutcome, SharedSink};
use crate::config::AppConfig;
use crate::desktop::window;
use crate::state;
use crate::WindowMode;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// 取得当前适配器，没有则启动一个。
async fn ensure_adapter(app: &AppHandle) -> Result<Arc<dyn AgentAdapter>, String> {
    if let Some(a) = state::adapter() {
        return Ok(a);
    }
    let _guard = state::acquire_spawn_lock().await;
    // 拿锁后重新检查：另一个调用者可能已经启动好了。
    if let Some(a) = state::adapter() {
        return Ok(a);
    }
    spawn_adapter_locked(app).await
}

/// 强制（重新）启动适配器。
async fn spawn_adapter(app: &AppHandle) -> Result<Arc<dyn AgentAdapter>, String> {
    let _guard = state::acquire_spawn_lock().await;
    spawn_adapter_locked(app).await
}

/// 已持锁版本；调用者负责持 `state::acquire_spawn_lock()`。
async fn spawn_adapter_locked(app: &AppHandle) -> Result<Arc<dyn AgentAdapter>, String> {
    // 先关旧进程，避免残留。
    if let Some(old) = state::adapter() {
        state::set_adapter(None);
        let _ = old.shutdown().await;
    }

    let cfg = state::config(app);
    let binary = if cfg.pi_binary.trim().is_empty() {
        "pi".to_string()
    } else {
        cfg.pi_binary.clone()
    };

    // 显式检查 cwd：pi 在目录不存在时会静默走错地方，报错在这里更省心。
    if !std::path::Path::new(&cfg.cwd).is_dir() {
        return Err(format!("配置的 cwd 不存在：{}", cfg.cwd));
    }

    let sink: SharedSink = state::make_sink(app.clone());
    let opts = PiSpawnOptions {
        binary,
        cwd: cfg.cwd.clone(),
        extra_args: cfg.pi_args.clone(),
        persist_session: cfg.persist_session,
    };

    let adapter = PiAdapter::spawn(opts, sink).await.map_err(err)?;
    let out: Arc<dyn AgentAdapter> = adapter;
    state::set_adapter(Some(Arc::clone(&out)));
    Ok(out)
}

#[tauri::command]
pub async fn agent_state(app: AppHandle) -> Result<crate::agent::SessionState, String> {
    let adapter = ensure_adapter(&app).await?;
    adapter.state().await.map_err(err)
}

#[tauri::command]
pub async fn agent_send(
    app: AppHandle,
    text: String,
    images: Option<Vec<ImageInput>>,
    streaming_behavior: Option<String>,
) -> Result<PromptOutcome, String> {
    let adapter = ensure_adapter(&app).await?;
    let behavior = match streaming_behavior.as_deref() {
        Some("steer") => Some(crate::agent::StreamingBehavior::Steer),
        Some("followUp") => Some(crate::agent::StreamingBehavior::FollowUp),
        Some(other) => return Err(format!("未知 streamingBehavior：{other}")),
        None => None,
    };
    adapter
        .prompt(text, images.unwrap_or_default(), behavior)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn agent_abort(app: AppHandle) -> Result<(), String> {
    let adapter = ensure_adapter(&app).await?;
    adapter.abort().await.map_err(err)
}

#[tauri::command]
pub async fn agent_new_session(app: AppHandle) -> Result<(), String> {
    let adapter = ensure_adapter(&app).await?;
    adapter.new_session().await.map_err(err)
}

#[tauri::command]
pub async fn agent_switch_session(app: AppHandle, session_path: String) -> Result<(), String> {
    let adapter = ensure_adapter(&app).await?;
    adapter.switch_session(session_path).await.map_err(err)
}

#[tauri::command]
pub async fn agent_stats(app: AppHandle) -> Result<crate::agent::SessionStats, String> {
    let adapter = ensure_adapter(&app).await?;
    adapter.stats().await.map_err(err)
}

#[tauri::command]
pub async fn agent_models(app: AppHandle) -> Result<Vec<crate::agent::ModelInfo>, String> {
    let adapter = ensure_adapter(&app).await?;
    adapter.available_models().await.map_err(err)
}

#[tauri::command]
pub async fn agent_set_model(
    app: AppHandle,
    provider: String,
    model_id: String,
) -> Result<(), String> {
    let adapter = ensure_adapter(&app).await?;
    adapter.set_model(provider, model_id).await.map_err(err)
}

#[tauri::command]
pub async fn agent_set_thinking_level(app: AppHandle, level: String) -> Result<(), String> {
    let adapter = ensure_adapter(&app).await?;
    adapter.set_thinking_level(level).await.map_err(err)
}

#[tauri::command]
pub async fn agent_set_session_name(app: AppHandle, name: String) -> Result<(), String> {
    let adapter = ensure_adapter(&app).await?;
    adapter.set_session_name(name).await.map_err(err)
}

#[tauri::command]
pub async fn agent_extension_ui_response(
    app: AppHandle,
    response: ExtensionUiResponse,
) -> Result<(), String> {
    let adapter = ensure_adapter(&app).await?;
    adapter.respond_extension_ui(response).await.map_err(err)
}

#[tauri::command]
pub async fn agent_restart(app: AppHandle) -> Result<crate::agent::SessionState, String> {
    let adapter = spawn_adapter(&app).await?;
    adapter.state().await.map_err(err)
}

/// 会话列表：直接扫 pi 的 sessions 目录，避免为 MVP 引入 `get_entries` 的游标同步。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub path: String,
    pub session_id: String,
    pub name: Option<String>,
    pub modified_ms: u64,
    pub size_bytes: u64,
}

#[tauri::command]
pub async fn agent_sessions(app: AppHandle) -> Result<Vec<SessionSummary>, String> {
    let cfg = state::config(&app);
    let root = sessions_root(&cfg.cwd);
    collect_sessions(&root)
}

fn sessions_root(cwd: &str) -> std::path::PathBuf {
    // pi 按 cwd 编码成目录名：/home/hevin/Developer → --home-hevin-Developer--
    let encoded = format!("--{}--", cwd.trim_start_matches('/').replace('/', "-"));
    dirs::home_dir()
        .unwrap_or_default()
        .join(".pi")
        .join("agent")
        .join("sessions")
        .join(encoded)
}

fn collect_sessions(root: &std::path::Path) -> Result<Vec<SessionSummary>, String> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return Ok(out), // 目录不存在 = 该 cwd 还没有会话
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.split('_').nth(1))
            .unwrap_or("")
            .to_string();
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(SessionSummary {
            path: path.display().to_string(),
            session_id,
            name: read_session_name(&path),
            modified_ms,
            size_bytes: meta.len(),
        });
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.modified_ms));
    Ok(out)
}

/// 从 JSONL 里找最后一条 `session_info` 条目的 name。
fn read_session_name(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut name = None;
    for line in text.lines() {
        if !line.contains("\"session_info\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("session_info") {
            name = value.get("name").and_then(|v| v.as_str()).map(str::to_string);
        }
    }
    name
}

// ---- 窗口 / 配置 ----------------------------------------------------------

#[tauri::command]
pub fn window_show(app: AppHandle, mode: String) -> Result<(), String> {
    let mode = match mode.as_str() {
        "compact" => WindowMode::Compact,
        "full" => WindowMode::Full,
        other => return Err(format!("未知窗口形态：{other}")),
    };
    window::show_window(&app, mode);
    Ok(())
}

#[tauri::command]
pub fn window_hide(app: AppHandle) {
    window::hide_window(&app);
}

#[tauri::command]
pub fn window_toggle(app: AppHandle) {
    window::toggle_window(&app);
}

#[tauri::command]
pub fn window_switch_mode(app: AppHandle, mode: String) -> Result<(), String> {
    let mode = match mode.as_str() {
        "compact" => WindowMode::Compact,
        "full" => WindowMode::Full,
        other => return Err(format!("未知窗口形态：{other}")),
    };
    window::switch_mode(&app, mode);
    Ok(())
}

#[tauri::command]
pub fn config_get(app: AppHandle) -> AppConfig {
    state::config(&app)
}

#[tauri::command]
pub async fn config_set(app: AppHandle, config: AppConfig) -> Result<(), String> {
    config.save().map_err(err)?;
    let needs_restart = {
        let old = state::config(&app);
        old.pi_args != config.pi_args
            || old.pi_binary != config.pi_binary
            || old.cwd != config.cwd
            || old.persist_session != config.persist_session
    };
    let shortcut_changed = state::config(&app).toggle_shortcut != config.toggle_shortcut;
    state::set_config(config.clone());

    if shortcut_changed {
        crate::desktop::kwin::install_kwin_script(&config.toggle_shortcut).map_err(err)?;
    }
    if needs_restart {
        spawn_adapter(&app).await?;
    }
    Ok(())
}

#[tauri::command]
pub fn config_path() -> String {
    AppConfig::path().display().to_string()
}

#[tauri::command]
pub fn kwin_install(app: AppHandle) -> Result<bool, String> {
    let cfg = state::config(&app);
    crate::desktop::kwin::install_kwin_script(&cfg.toggle_shortcut)
}

#[tauri::command]
pub fn kwin_uninstall() -> Result<(), String> {
    crate::desktop::kwin::uninstall_kwin_script()
}

// ---- 内部辅助 -------------------------------------------------------------

/// 托盘"新建会话"复用；与 command 分开是为了能在非 IPC 上下文调用。
pub async fn reset_session_inner(app: &AppHandle) -> Result<(), String> {
    let adapter = ensure_adapter(app).await?;
    adapter.new_session().await.map_err(err)?;
    let _ = app.emit("agent://reset", ());
    Ok(())
}

pub async fn shutdown_agent(app: &AppHandle) {
    if let Some(adapter) = state::adapter() {
        state::set_adapter(None);
        if let Err(e) = adapter.shutdown().await {
            log::warn!("关闭 pi 子进程失败：{e}");
        }
    }
    let _ = app; // 保持签名一致性
}

/// 应用启动后第一次交互就预热适配器，缩短首条消息的等待。
pub fn warm_up(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = ensure_adapter(&app).await {
            log::warn!("预热 agent 失败：{e}");
            let _ = app.emit(
                "agent://boot-error",
                serde_json::json!({ "message": e }),
            );
        }
    });
}

#[allow(dead_code)]
fn app_of<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> AppHandle<R> {
    window.app_handle().clone()
}
