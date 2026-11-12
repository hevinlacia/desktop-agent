//! KDE / KWin 集成。
//!
//! 三件事：
//! 1. 暴露一个 session bus 服务（`org.hevin.DesktopAgent`），供 KWin 脚本反调。
//! 2. 安装/启用 KWin 脚本，脚本负责 `registerShortcut()` 全局快捷键 + 把窗口居中。
//! 3. 提供 CLI 互操作入口：`desktop-agent toggle` 用 D-Bus 唤起常驻进程。
//!
//! 为什么不用 `tauri-plugin-global-shortcut`：Linux 上它依赖 global-hotkey crate，
//! 该 crate 只有 X11 后端（Wayland 是 no-op 静默失效），且 X11 下会抢其他应用的同组合键。
//! KWin 脚本注册的快捷键由 KWin 统一管理，可被用户在系统设置里改，且 Wayland 原生工作。

use std::path::PathBuf;
use std::process::Command;

use tauri::Emitter;

pub const DBUS_NAME: &str = "org.hevin.DesktopAgent";
pub const DBUS_PATH: &str = "/desktopagent";
pub const KWIN_PLUGIN_ID: &str = "desktop-agent";

/// KWin 脚本源码。嵌入式生成，避免运行时依赖仓库文件路径。
///
/// `callDBus` 是 KWin scripting 的全局函数，签名：
///   callDBus(service, path, iface, method, args..., callback)
fn kwin_script_source(shortcut: &str) -> String {
    // JS 字符串转义：快捷键可能含引号，虽然实践中不会，但别留坑。
    let escaped = shortcut.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        r#"// 由 desktop-agent 生成，请勿手改（改 config.json 里的 toggleShortcut 后重启应用）。
const AGENT_SERVICE = "{DBUS_NAME}";
const AGENT_PATH = "{DBUS_PATH}";
const AGENT_IFACE = "{DBUS_NAME}";

function toggleAgent() {{
    callDBus(AGENT_SERVICE, AGENT_PATH, AGENT_IFACE, "Toggle");
}}

// 居中：Wayland 下客户端无法自定位，只能由 compositor 代劳。
function centerAgentWindow() {{
    const wins = workspace.windowList ? workspace.windowList() : workspace.clientList();
    for (const w of wins) {{
        if (!w || w.resourceClass !== "desktop-agent") continue;
        const area = workspace.clientArea(KWin.Workarea, w);
        const geo = w.frameGeometry;
        w.frameGeometry = {{
            x: Math.round(area.x + (area.width - geo.width) / 2),
            y: Math.round(area.y + (area.height - geo.height) / 3),
            width: geo.width,
            height: geo.height
        }};
    }}
}}

registerShortcut(
    "desktop-agent-toggle",
    "Desktop Agent: 唤起/隐藏",
    "{escaped}",
    toggleAgent
);

workspace.windowAdded.connect(function (w) {{
    if (w && w.resourceClass === "desktop-agent") {{
        centerAgentWindow();
    }}
}});
"#
    )
}

/// 安装/更新 KWin 脚本到 `~/.local/share/kwin/scripts/desktop-agent/`。
/// 已存在且内容一致时跳过写入（避免无意义触发 KWin 重载）。
pub fn install_kwin_script(shortcut: &str) -> Result<bool, String> {
    let base = data_dir()
        .ok_or("无法确定 XDG_DATA_HOME")?
        .join("kwin")
        .join("scripts")
        .join(KWIN_PLUGIN_ID);
    let code_dir = base.join("contents").join("code");
    std::fs::create_dir_all(&code_dir).map_err(|e| format!("创建 KWin 脚本目录失败：{e}"))?;

    let metadata = serde_json::json!({
        "KPackageStructure": "KWin/Script",
        "KPlugin": {
            "Id": KWIN_PLUGIN_ID,
            "Name": "Desktop Agent",
            "Description": "Desktop Agent 全局快捷键与窗口居中",
            "Icon": "utilities-terminal",
            "License": "MIT",
            "Version": "1.0",
            "EnabledByDefault": true
        },
        "X-Plasma-API": "javascript",
        "X-Plasma-MainScript": "code/main.js"
    });

    let main_js = kwin_script_source(shortcut);
    let mut changed = false;

    changed |= write_if_changed(&base.join("metadata.json"), &serde_json::to_string_pretty(&metadata).unwrap())?;
    changed |= write_if_changed(&code_dir.join("main.js"), &main_js)?;

    // 在 kwinrc 里启用（[Plugins] desktop-agentEnabled=true）。
    if changed || !is_kwin_plugin_enabled() {
        enable_kwin_plugin()?;
    }

    Ok(changed)
}

fn write_if_changed(path: &PathBuf, content: &str) -> Result<bool, String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return Ok(false);
        }
    }
    std::fs::write(path, content).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(true)
}

fn is_kwin_plugin_enabled() -> bool {
    Command::new("kreadconfig6")
        .args(["--file", "kwinrc", "--group", "Plugins", "--key", &format!("{KWIN_PLUGIN_ID}Enabled")])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

fn enable_kwin_plugin() -> Result<(), String> {
    let out = Command::new("kwriteconfig6")
        .args([
            "--file",
            "kwinrc",
            "--group",
            "Plugins",
            "--key",
            &format!("{KWIN_PLUGIN_ID}Enabled"),
            "true",
        ])
        .output()
        .map_err(|e| format!("kwriteconfig6 不可用：{e}"))?;
    if !out.status.success() {
        return Err(format!(
            "kwriteconfig6 失败：{}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    // 通知 KWin 重载配置。Wayland 下用 dbus 让 KWin 重读；失败不影响已写入的配置。
    let _ = Command::new("dbus-send")
        .args([
            "--session",
            "--type=method_call",
            "--dest=org.kde.KWin",
            "/KWin",
            "org.kde.KWin.reconfigure",
        ])
        .output();

    Ok(())
}

/// 卸载 KWin 脚本（不改 kwinrc 的 enabled 标记，避免破坏用户其他设置）。
pub fn uninstall_kwin_script() -> Result<(), String> {
    let base = data_dir()
        .ok_or("无法确定 XDG_DATA_HOME")?
        .join("kwin")
        .join("scripts")
        .join(KWIN_PLUGIN_ID);
    if base.exists() {
        // 全局红线：删目录走 trash-put。
        let status = Command::new("trash-put").arg(&base).status();
        match status {
            Ok(s) if s.success() => {}
            _ => {
                return Err(format!(
                    "trash-put 不可用或失败，请手动删除 {}",
                    base.display()
                ))
            }
        }
    }
    Ok(())
}

fn data_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("XDG_DATA_HOME") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    dirs::home_dir().map(|h| h.join(".local").join("share"))
}

/// D-Bus 服务实现：KWin 脚本（和其他任何客户端）通过它唤起窗口。
pub struct AgentService;

#[zbus::interface(name = "org.hevin.DesktopAgent")]
impl AgentService {
    /// 唤起/隐藏主窗口。返回当前形态（"compact" / "full"）。
    fn toggle(&self) -> String {
        if let Some(app) = crate::state::app_handle() {
            crate::desktop::window::toggle_window(&app);
            return mode_str(crate::state::window_mode(&app));
        }
        "unknown".into()
    }

    /// 显示为完整对话窗口。
    fn show_full(&self) {
        if let Some(app) = crate::state::app_handle() {
            crate::desktop::window::show_window(&app, crate::WindowMode::Full);
        }
    }

    /// 显示为紧凑悬浮窗。
    fn show_compact(&self) {
        if let Some(app) = crate::state::app_handle() {
            crate::desktop::window::show_window(&app, crate::WindowMode::Compact);
        }
    }

    /// 直接发起一次提问（供 `desktop-agent ask "..."` 用）。
    fn ask(&self, text: String) {
        if let Some(app) = crate::state::app_handle() {
            crate::desktop::window::show_window(&app, crate::WindowMode::Full);
            let _ = app.emit("external://ask", text);
        }
    }

    fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

fn mode_str(mode: crate::WindowMode) -> String {
    match mode {
        crate::WindowMode::Compact => "compact".into(),
        crate::WindowMode::Full => "full".into(),
    }
}

/// 在 Tauri 的 async runtime 上注册 D-Bus 服务。
pub fn spawn_dbus_service() {
    tauri::async_runtime::spawn(async move {
        match zbus::connection::Builder::session()
            .name(DBUS_NAME)
            .serve_at(DBUS_PATH, AgentService)
            .build()
            .await
        {
            Ok(_conn) => {
                // 连接必须保活：忘了它，服务会立刻消失。
                log::info!("D-Bus 服务已就绪：{DBUS_NAME}");
                std::future::pending::<()>().await;
            }
            Err(e) => log::warn!("D-Bus 注册失败（快捷键与 CLI 唤起将不可用）：{e}"),
        }
    });
}

/// CLI 侧：向已在运行的实例发送 toggle。
pub fn cli_toggle() -> Result<(), String> {
    let out = Command::new("dbus-send")
        .args([
            "--session",
            "--type=method_call",
            "--dest=org.hevin.DesktopAgent",
            "/desktopagent",
            "org.hevin.DesktopAgent.Toggle",
        ])
        .output()
        .map_err(|e| format!("dbus-send 执行失败：{e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_contains_service_and_shortcut() {
        let js = kwin_script_source("Meta+Space");
        assert!(js.contains("org.hevin.DesktopAgent"));
        assert!(js.contains("registerShortcut"));
        assert!(js.contains("Meta+Space"));
    }

    #[test]
    fn script_escapes_quotes() {
        let js = kwin_script_source(r#"Meta+""#);
        assert!(js.contains(r#"Meta+\""#));
    }
}
