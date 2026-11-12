//! Pi Agent（`pi --mode rpc`）子进程适配器。
//!
//! 职责边界（刻意保持窄）：
//! 1. 子进程生命周期：启动 / 守护 / 优雅退出 / 崩溃检测
//! 2. 严格 JSONL 分帧（只按 LF 切分，`U+2028`/`U+2029` 在 JSON 字符串里合法）
//! 3. 命令 ↔ 响应按 `id` 关联
//! 4. Pi 原生事件 → [`UnifiedAgentEvent`]
//!
//! 不做：业务语义解释、权限决策、UI 状态管理。
//!
//! 协议权威文档（随 pi 版本走，改前先读）：
//! `~/.pi/agent/install/releases/<ver>/node_modules/@earendil-works/pi-coding-agent/docs/`
//!   - rpc.md           协议总览 / 分帧 / 生命周期
//!   - rpc-commands.md  stdin 命令与响应
//!   - json.md          stdout 事件（含 message_update 是 delta-only 的关键约束）
//!   - message-types.md 消息与内容块结构

use super::{
    AdapterError, AdapterResult, AgentAdapter, ChatMessage, ContentBlock, ContextUsage,
    ExtensionUiRequest, ExtensionUiResponse, ImageInput, ModelInfo, PromptOutcome, SessionState,
    SessionStats, SharedSink, StreamingBehavior, UnifiedAgentEvent, Usage,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, RwLock};

/// 单条命令的响应。
#[derive(Debug)]
struct CommandResponse {
    success: bool,
    data: Option<Value>,
    error: Option<String>,
}

/// 适配器运行参数。
#[derive(Debug, Clone)]
pub struct PiSpawnOptions {
    /// pi 可执行文件，默认 "pi"。
    pub binary: String,
    /// Agent 工作目录。
    pub cwd: String,
    /// 附加参数（--model / --tools 等）。
    pub extra_args: Vec<String>,
    /// true 则使用 pi 的持久化会话，false 传 --no-session。
    pub persist_session: bool,
}

/// 流式内容块的临时缓冲，只在拼装 assistant 消息时使用。
#[derive(Default)]
struct StreamBuffer {
    /// contentIndex → 已拼接文本
    text: HashMap<u32, String>,
    thinking: HashMap<u32, String>,
    /// toolCallId → 累计的参数 JSON 片段
    tool_args: HashMap<String, String>,
    /// toolCallId → (contentIndex, toolName)
    tool_meta: HashMap<String, (u32, String)>,
    /// 已完成的块，按 contentIndex 排序后提交
    blocks: Vec<(u32, ContentBlock)>,
    active: bool,
}

impl StreamBuffer {
    fn reset(&mut self) {
        self.text.clear();
        self.thinking.clear();
        self.tool_args.clear();
        self.tool_meta.clear();
        self.blocks.clear();
        self.active = false;
    }

    fn put_block(&mut self, index: u32, block: ContentBlock) {
        match self.blocks.iter_mut().find(|(i, _)| *i == index) {
            Some(slot) => slot.1 = block,
            None => self.blocks.push((index, block)),
        }
    }

    fn into_blocks(mut self) -> Vec<ContentBlock> {
        self.blocks.sort_by_key(|(i, _)| *i);
        self.blocks.into_iter().map(|(_, b)| b).collect()
    }
}

pub struct PiAdapter {
    sink: SharedSink,
    /// 命令写入通道；None 表示已关闭（shutdown 后）。
    stdin_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<String, oneshot::Sender<CommandResponse>>>,
    next_id: AtomicU64,
    session_id: RwLock<String>,
    session_file: RwLock<Option<String>>,
    session_name: RwLock<Option<String>>,
    model: RwLock<Option<ModelInfo>>,
    thinking_level: RwLock<String>,
    is_streaming: AtomicBool,
    is_compacting: AtomicBool,
    alive: AtomicBool,
    cwd: String,
    stream: Mutex<StreamBuffer>,
}

impl PiAdapter {
    /// 启动子进程并完成握手（拉一次 get_state 确认 session id）。
    pub async fn spawn(opts: PiSpawnOptions, sink: SharedSink) -> AdapterResult<Arc<Self>> {
        let mut cmd = Command::new(&opts.binary);
        cmd.arg("--mode")
            .arg("rpc")
            // RPC 模式没有终端，交互式 UI 相关扩展会挂死，显式关掉。
            .arg("--no-extensions");
        if !opts.persist_session {
            cmd.arg("--no-session");
        }
        for a in &opts.extra_args {
            cmd.arg(a);
        }
        cmd.current_dir(&opts.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            format!("无法启动 pi（binary={} cwd={}）：{e}", opts.binary, opts.cwd)
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| -> AdapterError { "pi stdout 不可用".into() })?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| -> AdapterError { "pi stderr 不可用".into() })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| -> AdapterError { "pi stdin 不可用".into() })?;

        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<String>();

        let adapter = Arc::new(Self {
            sink: sink.clone(),
            stdin_tx: Mutex::new(Some(stdin_tx)),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            session_id: RwLock::new(String::new()),
            session_file: RwLock::new(None),
            session_name: RwLock::new(None),
            model: RwLock::new(None),
            thinking_level: RwLock::new("off".into()),
            is_streaming: AtomicBool::new(false),
            is_compacting: AtomicBool::new(false),
            alive: AtomicBool::new(true),
            cwd: opts.cwd.clone(),
            stream: Mutex::new(StreamBuffer::default()),
        });

        spawn_writer(stdin, stdin_rx);
        spawn_stdout_reader(Arc::clone(&adapter), stdout);
        spawn_stderr_reader(stderr);

        // 握手：拿到初始 session 快照，同时把 session id 定下来，
        // 否则后续事件没有 sid 可打标。
        let state = adapter.state().await?;
        if let Some(sid) = state.session_id {
            *adapter.session_id.write().await = sid;
        }
        if let Some(sf) = state.session_file {
            *adapter.session_file.write().await = Some(sf);
        }
        if let Some(name) = state.session_name {
            *adapter.session_name.write().await = Some(name);
        }
        if let Some(m) = state.model {
            *adapter.model.write().await = Some(m);
        }
        *adapter.thinking_level.write().await = state.thinking_level;

        Ok(adapter)
    }

    fn make_id(&self) -> String {
        self.next_id.fetch_add(1, Ordering::Relaxed).to_string()
    }

    async fn sid(&self) -> String {
        self.session_id.read().await.clone()
    }

    fn emit(&self, event: UnifiedAgentEvent) {
        self.sink.emit(event);
    }

    /// 发送一条命令并等待其响应。
    async fn call(&self, command: Value) -> AdapterResult<CommandResponse> {
        if !self.alive.load(Ordering::Relaxed) {
            return Err("pi 子进程已退出".into());
        }
        let id = self.make_id();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        let mut record = command;
        record["id"] = json!(id);

        let line = serde_json::to_string(&record)?;
        {
            let guard = self.stdin_tx.lock().unwrap();
            let sender = guard
                .as_ref()
                .ok_or_else(|| -> AdapterError { "pi stdin 已关闭".into() })?;
            sender
                .send(line)
                .map_err(|_| -> AdapterError { "写入 pi stdin 失败（子进程已退出）".into() })?;
        }

        let resp = tokio::time::timeout(Duration::from_secs(120), rx)
            .await
            .map_err(|_| -> AdapterError { format!("命令 {} 超时无响应", record["type"]).into() })?
            .map_err(|_| -> AdapterError { "响应通道已关闭（子进程退出）".into() })?;

        if resp.success {
            Ok(resp)
        } else {
            Err(resp
                .error
                .unwrap_or_else(|| "pi 返回失败且无错误信息".into())
                .into())
        }
    }

    /// 解析响应中的 `data`，缺失时报错。
    fn data_of<'a>(resp: &'a CommandResponse, what: &str) -> AdapterResult<&'a Value> {
        resp.data
            .as_ref()
            .ok_or_else(|| -> AdapterError { format!("{what} 响应缺少 data").into() })
    }

    // ---- 事件解析 ----------------------------------------------------------

    /// 处理一条 stdout 记录。无法识别的一律忽略（向前兼容 pi 新增事件）。
    async fn on_record(&self, value: Value) {
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "response" => self.on_response(value),
            "message_start" => self.on_message_start(&value).await,
            "message_update" => self.on_message_update(&value).await,
            "message_end" => self.on_message_end(&value).await,
            "tool_execution_start" => {
                self.emit_async(UnifiedAgentEvent::ToolExecStart {
                    session_id: String::new(),
                    tool_call_id: str_of(&value, "toolCallId").unwrap_or_default(),
                    tool_name: str_of(&value, "toolName").unwrap_or_default(),
                    args: value.get("args").cloned().unwrap_or(Value::Null),
                })
                .await;
            }
            "tool_execution_end" => {
                let content = value
                    .get("result")
                    .and_then(|r| r.get("content"))
                    .and_then(Value::as_array)
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter_map(|b| b.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                self.emit_async(UnifiedAgentEvent::ToolExecEnd {
                    session_id: String::new(),
                    tool_call_id: str_of(&value, "toolCallId").unwrap_or_default(),
                    is_error: value.get("isError").and_then(Value::as_bool).unwrap_or(false),
                    duration_ms: value.get("durationMs").and_then(Value::as_u64),
                    content,
                })
                .await;
            }
            "agent_start" => {
                self.is_streaming.store(true, Ordering::Relaxed);
                self.emit_async(UnifiedAgentEvent::RunStarted { session_id: String::new() })
                    .await;
            }
            "turn_start" => {
                self.emit_async(UnifiedAgentEvent::TurnStarted { session_id: String::new() })
                    .await;
            }
            "agent_settled" => {
                self.is_streaming.store(false, Ordering::Relaxed);
                let aborted = value.get("aborted").and_then(Value::as_bool).unwrap_or(false);
                self.emit_async(UnifiedAgentEvent::RunSettled {
                    session_id: String::new(),
                    aborted,
                })
                .await;
            }
            "compaction_start" => {
                self.is_compacting.store(true, Ordering::Relaxed);
                self.emit_async(UnifiedAgentEvent::Compaction {
                    session_id: String::new(),
                    phase: "start".into(),
                    reason: str_of(&value, "reason"),
                })
                .await;
            }
            "compaction_end" => {
                self.is_compacting.store(false, Ordering::Relaxed);
                self.emit_async(UnifiedAgentEvent::Compaction {
                    session_id: String::new(),
                    phase: "end".into(),
                    reason: str_of(&value, "reason"),
                })
                .await;
            }
            "session_info_changed" => {
                let name = str_of(&value, "name");
                *self.session_name.write().await = name.clone();
                let sid = self.sid().await;
                self.emit(UnifiedAgentEvent::SessionInfo {
                    session_id: sid,
                    name,
                    session_file: None,
                });
            }
            "thinking_level_changed" => {
                if let Some(level) = str_of(&value, "level") {
                    *self.thinking_level.write().await = level;
                }
            }
            "extension_ui_request" => self.on_extension_ui(&value).await,
            "extension_error" => {
                let msg = value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("扩展执行出错")
                    .to_string();
                self.emit_async(UnifiedAgentEvent::Error {
                    session_id: String::new(),
                    message: format!("扩展错误：{msg}"),
                })
                .await;
            }
            "auto_retry_start" => {
                let attempt = value.get("attempt").and_then(Value::as_u64).unwrap_or(0);
                let max = value.get("maxAttempts").and_then(Value::as_u64).unwrap_or(0);
                self.emit_async(UnifiedAgentEvent::MessageCommitted {
                    session_id: String::new(),
                    message: ChatMessage::Notice {
                        text: format!("模型调用失败，正在重试（{attempt}/{max}）"),
                        timestamp: now_ms(),
                    },
                })
                .await;
            }
            // agent_end / turn_end / queue_update / entry_appended 等对 MVP 无需转发。
            _ => {}
        }
    }

    fn on_response(&self, value: Value) {
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            // 无 id 的响应是解析失败记录，交给日志。
            if value.get("command").and_then(Value::as_str) == Some("parse") {
                let msg = value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("协议解析失败");
                log::warn!("pi 协议解析失败：{msg}");
            }
            return;
        };
        let Some(tx) = self.pending.lock().unwrap().remove(id) else {
            return;
        };
        let _ = tx.send(CommandResponse {
            success: value.get("success").and_then(Value::as_bool).unwrap_or(false),
            data: value.get("data").cloned(),
            error: value.get("error").and_then(Value::as_str).map(str::to_string),
        });
    }

    async fn on_message_start(&self, value: &Value) {
        let role = value
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if role == "assistant" {
            self.stream.lock().unwrap().reset();
            self.stream.lock().unwrap().active = true;
        }
    }

    async fn on_message_update(&self, value: &Value) {
        let Some(ev) = value.get("assistantMessageEvent") else {
            return;
        };
        let ev_type = ev.get("type").and_then(Value::as_str).unwrap_or("");
        let content_index = ev.get("contentIndex").and_then(Value::as_u64).unwrap_or(0) as u32;

        match ev_type {
            "text_start" | "thinking_start" => {}
            "text_delta" => {
                let delta = ev.get("delta").and_then(Value::as_str).unwrap_or("").to_string();
                if delta.is_empty() {
                    return;
                }
                self.stream
                    .lock()
                    .unwrap()
                    .text
                    .entry(content_index)
                    .or_default()
                    .push_str(&delta);
                self.emit_async(UnifiedAgentEvent::TextDelta {
                    session_id: String::new(),
                    content_index,
                    delta,
                })
                .await;
            }
            "thinking_delta" => {
                let delta = ev.get("delta").and_then(Value::as_str).unwrap_or("").to_string();
                if delta.is_empty() {
                    return;
                }
                self.stream
                    .lock()
                    .unwrap()
                    .thinking
                    .entry(content_index)
                    .or_default()
                    .push_str(&delta);
                self.emit_async(UnifiedAgentEvent::ThinkingDelta {
                    session_id: String::new(),
                    content_index,
                    delta,
                })
                .await;
            }
            "text_end" => {
                let text = ev.get("content").and_then(Value::as_str).unwrap_or("").to_string();
                let block = ContentBlock::Text { text: text.clone() };
                {
                    let mut buf = self.stream.lock().unwrap();
                    buf.text.insert(content_index, text);
                    buf.put_block(content_index, block.clone());
                }
                self.emit_async(UnifiedAgentEvent::BlockEnd {
                    session_id: String::new(),
                    content_index,
                    block,
                })
                .await;
            }
            "thinking_end" => {
                let thinking = ev
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let block = ContentBlock::Thinking {
                    thinking: thinking.clone(),
                };
                {
                    let mut buf = self.stream.lock().unwrap();
                    buf.thinking.insert(content_index, thinking);
                    buf.put_block(content_index, block.clone());
                }
                self.emit_async(UnifiedAgentEvent::BlockEnd {
                    session_id: String::new(),
                    content_index,
                    block,
                })
                .await;
            }
            "toolcall_start" => {
                // 注意：wire 上 id / toolName 被提升到 assistantMessageEvent 顶层，
                // 不在 toolCall 字段里（json.md 的 JsonAssistantMessageEvent 定义）。
                let id = ev.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let name = ev
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    return;
                }
                self.stream
                    .lock()
                    .unwrap()
                    .tool_meta
                    .insert(id.clone(), (content_index, name.clone()));
                self.emit_async(UnifiedAgentEvent::ToolCallStart {
                    session_id: String::new(),
                    tool_call_id: id,
                    tool_name: name,
                })
                .await;
            }
            "toolcall_delta" => {
                let delta = ev.get("delta").and_then(Value::as_str).unwrap_or("");
                // 参数片段按 toolCallId 归集；wire 上 toolcall_delta 不带 id，
                // 只能挂到 contentIndex 最大（最近开始）的那个调用。
                let mut buf = self.stream.lock().unwrap();
                let latest_id = buf
                    .tool_meta
                    .iter()
                    .max_by_key(|(_, (idx, _))| *idx)
                    .map(|(id, _)| id.clone());
                if let Some(id) = latest_id {
                    buf.tool_args.entry(id).or_default().push_str(delta);
                }
            }
            "toolcall_end" => {
                let Some(call) = ev.get("toolCall") else { return };
                let id = call.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let args = call.get("arguments").cloned().unwrap_or(Value::Null);
                let name = call
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    return;
                }
                let block = ContentBlock::ToolCall {
                    tool_call_id: id.clone(),
                    tool_name: name,
                    args: args.clone(),
                };
                {
                    let mut buf = self.stream.lock().unwrap();
                    let idx = buf
                        .tool_meta
                        .get(&id)
                        .map(|(i, _)| *i)
                        .unwrap_or(u32::MAX);
                    buf.put_block(idx, block);
                }
                self.emit_async(UnifiedAgentEvent::ToolCallEnd {
                    session_id: String::new(),
                    tool_call_id: id,
                    args,
                })
                .await;
            }
            "error" => {
                let msg = ev
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("模型流式输出异常")
                    .to_string();
                self.emit_async(UnifiedAgentEvent::Error {
                    session_id: String::new(),
                    message: msg,
                })
                .await;
            }
            _ => {}
        }

        if let Some(usage) = value.get("usage") {
            if let Some(u) = parse_usage(usage) {
                self.emit_async(UnifiedAgentEvent::Usage {
                    session_id: String::new(),
                    usage: u,
                })
                .await;
            }
        }
    }

    async fn on_message_end(&self, value: &Value) {
        let Some(message) = value.get("message") else { return };
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let timestamp = message.get("timestamp").and_then(Value::as_i64).unwrap_or(0);

        match role {
            // 用户消息由前端乐观插入，这里不回传，避免重复。
            "user" => {}
            "assistant" => {
                let blocks = {
                    let mut buf = self.stream.lock().unwrap();
                    // message_end 里的 content 是权威值，用它纠正流式缓冲。
                    let authoritative = message.get("content").and_then(Value::as_array);
                    let blocks = match authoritative {
                        Some(arr) => arr.iter().filter_map(parse_block).collect::<Vec<_>>(),
                        None => std::mem::take(&mut *buf).into_blocks(),
                    };
                    buf.reset();
                    blocks
                };
                let stop_reason = message
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let error_message = message
                    .get("errorMessage")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let usage = message.get("usage").and_then(parse_usage);
                if blocks.is_empty() && stop_reason.as_deref() == Some("pending") {
                    return;
                }
                self.emit_async(UnifiedAgentEvent::MessageCommitted {
                    session_id: String::new(),
                    message: ChatMessage::Assistant {
                        blocks,
                        timestamp,
                        stop_reason,
                        error_message,
                        usage,
                    },
                })
                .await;
            }
            "toolResult" => {
                let content = message
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter_map(|b| b.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                self.emit_async(UnifiedAgentEvent::MessageCommitted {
                    session_id: String::new(),
                    message: ChatMessage::Tool {
                        tool_call_id: str_of(message, "toolCallId").unwrap_or_default(),
                        tool_name: str_of(message, "toolName").unwrap_or_default(),
                        content,
                        is_error: message
                            .get("isError")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        timestamp,
                    },
                })
                .await;
            }
            _ => {}
        }
    }

    async fn on_extension_ui(&self, value: &Value) {
        let id = str_of(value, "id").unwrap_or_default();
        let method = str_of(value, "method").unwrap_or_default();
        let title = str_of(value, "title").unwrap_or_default();
        let request = match method.as_str() {
            "select" => ExtensionUiRequest::Select {
                id,
                title,
                options: value
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
                timeout: value.get("timeout").and_then(Value::as_u64),
            },
            "confirm" => ExtensionUiRequest::Confirm {
                id,
                title,
                message: str_of(value, "message").unwrap_or_default(),
                timeout: value.get("timeout").and_then(Value::as_u64),
            },
            "input" => ExtensionUiRequest::Input {
                id,
                title,
                placeholder: str_of(value, "placeholder"),
            },
            "editor" => ExtensionUiRequest::Editor {
                id,
                title,
                prefill: str_of(value, "prefill"),
            },
            "notify" => ExtensionUiRequest::Notify {
                id,
                message: str_of(value, "message").unwrap_or_default(),
                level: str_of(value, "notifyType").unwrap_or_else(|| "info".into()),
            },
            // setStatus / setTitle 等 fire-and-forget 暂不呈现。
            _ => return,
        };
        self.emit_async(UnifiedAgentEvent::ExtensionUi {
            session_id: String::new(),
            request,
        })
        .await;
    }

    /// 补 sid 后广播。
    async fn emit_async(&self, event: UnifiedAgentEvent) {
        let sid = self.sid().await;
        self.emit(event.with_session_id(&sid));
    }

    fn send_record(&self, record: Value) -> AdapterResult<()> {
        let line = serde_json::to_string(&record)?;
        let guard = self.stdin_tx.lock().unwrap();
        let sender = guard
            .as_ref()
            .ok_or_else(|| -> AdapterError { "pi stdin 已关闭".into() })?;
        sender
            .send(line)
            .map_err(|_| -> AdapterError { "写入 pi stdin 失败".into() })?;
        Ok(())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[async_trait::async_trait]
impl AgentAdapter for PiAdapter {
    fn kind(&self) -> &'static str {
        "pi"
    }

    async fn prompt(
        &self,
        text: String,
        images: Vec<ImageInput>,
        streaming_behavior: Option<StreamingBehavior>,
    ) -> AdapterResult<PromptOutcome> {
        let mut record = json!({ "type": "prompt", "message": text });
        if !images.is_empty() {
            record["images"] = Value::Array(
                images
                    .into_iter()
                    .map(|i| json!({ "type": "image", "data": i.data, "mimeType": i.mime_type }))
                    .collect(),
            );
        }
        if let Some(sb) = streaming_behavior {
            record["streamingBehavior"] = json!(sb.as_str());
        }
        let resp = self.call(record).await?;
        let disposition = resp
            .data
            .as_ref()
            .and_then(|d| d.get("disposition"))
            .and_then(Value::as_str)
            .unwrap_or("started");
        Ok(match disposition {
            "queued" => PromptOutcome::Queued,
            "handled" => PromptOutcome::Handled,
            _ => PromptOutcome::Started,
        })
    }

    async fn abort(&self) -> AdapterResult<()> {
        self.call(json!({ "type": "abort" })).await?;
        Ok(())
    }

    async fn new_session(&self) -> AdapterResult<()> {
        let resp = self.call(json!({ "type": "new_session" })).await?;
        let cancelled = resp
            .data
            .as_ref()
            .and_then(|d| d.get("cancelled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if cancelled {
            return Err("新会话被扩展取消".into());
        }
        // session id 变了，刷新。
        let state = self.state().await?;
        if let Some(sid) = state.session_id {
            *self.session_id.write().await = sid;
        }
        if let Some(sf) = state.session_file {
            *self.session_file.write().await = Some(sf);
        }
        *self.session_name.write().await = None;
        Ok(())
    }

    async fn switch_session(&self, session_path: String) -> AdapterResult<()> {
        let resp = self
            .call(json!({ "type": "switch_session", "sessionPath": session_path }))
            .await?;
        let cancelled = resp
            .data
            .as_ref()
            .and_then(|d| d.get("cancelled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if cancelled {
            return Err("切换会话被扩展取消".into());
        }
        let state = self.state().await?;
        if let Some(sid) = state.session_id {
            *self.session_id.write().await = sid;
        }
        if let Some(sf) = state.session_file {
            *self.session_file.write().await = Some(sf);
        }
        *self.session_name.write().await = state.session_name;
        Ok(())
    }

    async fn state(&self) -> AdapterResult<SessionState> {
        let resp = self.call(json!({ "type": "get_state" })).await?;
        let data = Self::data_of(&resp, "get_state")?;

        let messages = match self.call(json!({ "type": "get_messages" })).await {
            Ok(r) => r
                .data
                .as_ref()
                .and_then(|d| d.get("messages"))
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(parse_message).collect())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };

        Ok(SessionState {
            session_id: data.get("sessionId").and_then(Value::as_str).map(str::to_string),
            session_file: data.get("sessionFile").and_then(Value::as_str).map(str::to_string),
            session_name: data.get("sessionName").and_then(Value::as_str).map(str::to_string),
            cwd: self.cwd.clone(),
            model: data.get("model").and_then(parse_model),
            thinking_level: data
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .unwrap_or("off")
                .to_string(),
            is_streaming: data
                .get("isStreaming")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            is_compacting: data
                .get("isCompacting")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            messages,
        })
    }

    async fn stats(&self) -> AdapterResult<SessionStats> {
        let resp = self.call(json!({ "type": "get_session_stats" })).await?;
        let data = Self::data_of(&resp, "get_session_stats")?;
        Ok(SessionStats {
            user_messages: data.get("userMessages").and_then(Value::as_u64).unwrap_or(0),
            assistant_messages: data
                .get("assistantMessages")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            tool_calls: data.get("toolCalls").and_then(Value::as_u64).unwrap_or(0),
            total_messages: data.get("totalMessages").and_then(Value::as_u64).unwrap_or(0),
            tokens: data.get("tokens").and_then(parse_usage).unwrap_or_default(),
            context_usage: data.get("contextUsage").map(|c| ContextUsage {
                tokens: c.get("tokens").and_then(Value::as_u64),
                context_window: c.get("contextWindow").and_then(Value::as_u64).unwrap_or(0),
                percent: c.get("percent").and_then(Value::as_f64),
            }),
        })
    }

    async fn available_models(&self) -> AdapterResult<Vec<ModelInfo>> {
        let resp = self.call(json!({ "type": "get_available_models" })).await?;
        let data = Self::data_of(&resp, "get_available_models")?;
        Ok(data
            .get("models")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(parse_model).collect())
            .unwrap_or_default())
    }

    async fn set_model(&self, provider: String, model_id: String) -> AdapterResult<()> {
        let resp = self
            .call(json!({ "type": "set_model", "provider": provider, "modelId": model_id }))
            .await?;
        if let Some(m) = resp.data.as_ref().and_then(parse_model) {
            *self.model.write().await = Some(m);
        }
        Ok(())
    }

    async fn set_thinking_level(&self, level: String) -> AdapterResult<()> {
        self.call(json!({ "type": "set_thinking_level", "level": level })).await?;
        *self.thinking_level.write().await = level;
        Ok(())
    }

    async fn set_session_name(&self, name: String) -> AdapterResult<()> {
        self.call(json!({ "type": "set_session_name", "name": name })).await?;
        *self.session_name.write().await = Some(name);
        Ok(())
    }

    async fn respond_extension_ui(&self, response: ExtensionUiResponse) -> AdapterResult<()> {
        let record = match response {
            ExtensionUiResponse::Select { id, value } => {
                json!({ "type": "extension_ui_response", "id": id, "value": value })
            }
            ExtensionUiResponse::Confirm { id, confirmed } => {
                json!({ "type": "extension_ui_response", "id": id, "confirmed": confirmed })
            }
            ExtensionUiResponse::Input { id, value } => {
                json!({ "type": "extension_ui_response", "id": id, "value": value })
            }
            ExtensionUiResponse::Editor { id, value } => {
                json!({ "type": "extension_ui_response", "id": id, "value": value })
            }
            ExtensionUiResponse::Cancelled { id } => {
                json!({ "type": "extension_ui_response", "id": id, "cancelled": true })
            }
        };
        self.send_record(record)
    }

    async fn shutdown(&self) -> AdapterResult<()> {
        self.alive.store(false, Ordering::Relaxed);
        // 关 stdin → pi 有序退出（不要直接 kill，会丢会话落盘）。
        self.stdin_tx.lock().unwrap().take();

        // 先取走 child，避免 std::sync::MutexGuard 跨 await 存活（否则 future 不是 Send）。
        let child = { self.child.lock().unwrap().take() };
        let Some(mut child) = child else {
            return Ok(());
        };

        match tokio::time::timeout(Duration::from_secs(8), child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(format!("等待 pi 退出失败：{e}").into()),
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                Ok(())
            }
        }
    }
}

// ---- 解析辅助 --------------------------------------------------------------

fn str_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn parse_usage(value: &Value) -> Option<Usage> {
    let cost_total = value
        .get("cost")
        .and_then(|c| c.get("total"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    Some(Usage {
        input: value.get("input").and_then(Value::as_u64).unwrap_or(0),
        output: value.get("output").and_then(Value::as_u64).unwrap_or(0),
        cache_read: value.get("cacheRead").and_then(Value::as_u64).unwrap_or(0),
        cache_write: value.get("cacheWrite").and_then(Value::as_u64).unwrap_or(0),
        reasoning: value.get("reasoning").and_then(Value::as_u64),
        total_tokens: value.get("totalTokens").and_then(Value::as_u64).unwrap_or(0),
        cost_total,
    })
}

fn parse_model(value: &Value) -> Option<ModelInfo> {
    Some(ModelInfo {
        id: value.get("id").and_then(Value::as_str)?.to_string(),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        provider: value
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        context_window: value
            .get("contextWindow")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        reasoning: value.get("reasoning").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn parse_block(value: &Value) -> Option<ContentBlock> {
    match value.get("type").and_then(Value::as_str)? {
        "text" => Some(ContentBlock::Text {
            text: value.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
        }),
        "thinking" => Some(ContentBlock::Thinking {
            thinking: value
                .get("thinking")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        }),
        "toolCall" => Some(ContentBlock::ToolCall {
            tool_call_id: value.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
            tool_name: value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            args: value.get("arguments").cloned().unwrap_or(Value::Null),
        }),
        _ => None,
    }
}

fn parse_message(value: &Value) -> Option<ChatMessage> {
    let role = value.get("role").and_then(Value::as_str)?;
    let timestamp = value.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
    match role {
        "user" => {
            let (text, images) = match value.get("content") {
                Some(Value::String(s)) => (s.clone(), 0),
                Some(Value::Array(arr)) => {
                    let text = arr
                        .iter()
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n");
                    let images = arr
                        .iter()
                        .filter(|b| b.get("type").and_then(Value::as_str) == Some("image"))
                        .count();
                    (text, images)
                }
                _ => (String::new(), 0),
            };
            Some(ChatMessage::User {
                text,
                images,
                timestamp,
            })
        }
        "assistant" => Some(ChatMessage::Assistant {
            blocks: value
                .get("content")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(parse_block).collect())
                .unwrap_or_default(),
            timestamp,
            stop_reason: value.get("stopReason").and_then(Value::as_str).map(str::to_string),
            error_message: value
                .get("errorMessage")
                .and_then(Value::as_str)
                .map(str::to_string),
            usage: value.get("usage").and_then(parse_usage),
        }),
        "toolResult" => Some(ChatMessage::Tool {
            tool_call_id: str_of(value, "toolCallId").unwrap_or_default(),
            tool_name: str_of(value, "toolName").unwrap_or_default(),
            content: value
                .get("content")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default(),
            is_error: value.get("isError").and_then(Value::as_bool).unwrap_or(false),
            timestamp,
        }),
        "system" => Some(ChatMessage::System {
            // system 消息的正文放在 sections 里，拼起来仅用于调试展示。
            text: value
                .get("sections")
                .and_then(Value::as_object)
                .map(|o| {
                    o.values()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n\n")
                })
                .unwrap_or_default(),
            timestamp,
        }),
        "compactionSummary" => Some(ChatMessage::Notice {
            text: format!(
                "上下文已压缩（压缩前 {} tokens）：{}",
                value.get("tokensBefore").and_then(Value::as_u64).unwrap_or(0),
                value
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(200)
                    .collect::<String>()
            ),
            timestamp,
        }),
        _ => None,
    }
}

// ---- 后台任务 --------------------------------------------------------------

fn spawn_writer(mut stdin: tokio::process::ChildStdin, mut rx: mpsc::UnboundedReceiver<String>) {
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdin.write_all(b"\n").await.is_err() {
                break;
            }
            if stdin.flush().await.is_err() {
                break;
            }
        }
        // 关闭 stdin 即请求 pi 有序退出。
        let _ = stdin.shutdown().await;
    });
}

fn spawn_stdout_reader(adapter: Arc<PiAdapter>, stdout: tokio::process::ChildStdout) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::with_capacity(8192);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break, // EOF：子进程退出
                Ok(_) => {
                    while buf.last() == Some(&b'\n') || buf.last() == Some(&b'\r') {
                        buf.pop();
                    }
                    if buf.is_empty() {
                        continue;
                    }
                    match serde_json::from_slice::<Value>(&buf) {
                        Ok(value) => adapter.on_record(value).await,
                        Err(e) => {
                            // stderr 才是诊断来源，这里只记一行长度避免日志爆炸。
                            log::debug!("忽略无法解析的 stdout 记录（{} 字节）：{e}", buf.len());
                        }
                    }
                }
                Err(e) => {
                    log::warn!("读取 pi stdout 失败：{e}");
                    break;
                }
            }
        }

        // 子进程退出：拒绝所有在途命令，并通知前端。
        adapter.alive.store(false, Ordering::Relaxed);
        adapter.is_streaming.store(false, Ordering::Relaxed);
        adapter.pending.lock().unwrap().clear();
        let sid = adapter.sid().await;
        adapter.emit(UnifiedAgentEvent::Error {
            session_id: sid,
            message: "pi 进程已退出".into(),
        });
    });
}

fn spawn_stderr_reader(stderr: tokio::process::ChildStderr) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => log::debug!(target: "pi_stderr", "{}", line.trim_end()),
                Err(_) => break,
            }
        }
    });
}
