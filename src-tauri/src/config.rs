//! 应用配置：`~/.config/desktop-agent/config.json`。
//!
//! 单一来源，全部字段都有默认值；文件不存在时自动生成，方便用户手改。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// pi 可执行文件；留空走 PATH。
    pub pi_binary: String,
    /// Agent 工作目录（工具的 cwd）。
    pub cwd: String,
    /// 附加给 pi 的参数，例如 ["--model", "anthropic/claude-sonnet-4"]。
    pub pi_args: Vec<String>,
    /// 是否沿用 pi 持久化会话。
    pub persist_session: bool,
    /// KWin 快捷键语法，例如 "Meta+Space"。
    pub toggle_shortcut: String,
    /// 悬浮窗尺寸。
    pub compact_width: f64,
    pub compact_height: f64,
    /// 全量窗口尺寸。
    pub full_width: f64,
    pub full_height: f64,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            pi_binary: String::new(),
            cwd: dirs::home_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "/".into()),
            pi_args: Vec::new(),
            persist_session: true,
            toggle_shortcut: "Meta+Space".into(),
            compact_width: 720.0,
            compact_height: 132.0,
            full_width: 1080.0,
            full_height: 720.0,
        }
    }
}

impl AppConfig {
    pub fn path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("desktop-agent")
            .join("config.json")
    }

    /// 读取配置；不存在则写入默认值。解析失败时回退默认值并保留原文件。
    pub fn load() -> Self {
        let path = Self::path();
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Self>(&text) {
                Ok(cfg) => cfg,
                Err(e) => {
                    log::warn!("配置解析失败（{}）：{e}，使用默认值", path.display());
                    Self::default()
                }
            },
            Err(_) => {
                let cfg = Self::default();
                if let Err(e) = cfg.save() {
                    log::warn!("写入默认配置失败：{e}");
                }
                cfg
            }
        }
    }

    pub fn save(&self) -> Result<(), std::io::Error> {
        let path = Self::path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, serde_json::to_string_pretty(self)?)
    }
}
