//! Agent 后端适配层。
//!
//! 这里的 `UnifiedAgentEvent` 与 `src/types/protocol.ts` 的 `AgentEvent` 一一对应。
//! 前端只认这一种事件；换后端（pi → 自研引擎）只需实现 [`AgentAdapter`]。

pub mod pi_adapter;

use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// 归一后的内容块。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Thinking {
        thinking: String,
    },
    ToolCall {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: serde_json::Value,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<u64>,
    pub total_tokens: u64,
    pub cost_total: f64,
}

/// 归一后的会话消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum ChatMessage {
    User {
        text: String,
        images: usize,
        timestamp: i64,
    },
    Assistant {
        blocks: Vec<ContentBlock>,
        timestamp: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
    },
    Tool {
        tool_call_id: String,
        tool_name: String,
        content: String,
        is_error: bool,
        timestamp: i64,
    },
    System {
        text: String,
        timestamp: i64,
    },
    /// 适配器生成的行内提示（压缩摘要、运行中止等），不属于模型对话。
    Notice {
        text: String,
        timestamp: i64,
    },
}

/// 扩展请求的 UI 对话框，需要用户在界面上作答。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExtensionUiRequest {
    Select {
        id: String,
        title: String,
        options: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout: Option<u64>,
    },
    Confirm {
        id: String,
        title: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout: Option<u64>,
    },
    Input {
        id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
    },
    Editor {
        id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        prefill: Option<String>,
    },
    Notify {
        id: String,
        message: String,
        level: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExtensionUiResponse {
    Select { id: String, value: String },
    Confirm { id: String, confirmed: bool },
    Input { id: String, value: String },
    Editor { id: String, value: String },
    Cancelled { id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub context_window: u64,
    pub reasoning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    /// 压缩后暂时为 null，直到下一次 assistant 响应带回真实 usage。
    pub tokens: Option<u64>,
    pub context_window: u64,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub user_messages: u64,
    pub assistant_messages: u64,
    pub tool_calls: u64,
    pub total_messages: u64,
    pub tokens: Usage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<ContextUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub session_name: Option<String>,
    pub cwd: String,
    pub model: Option<ModelInfo>,
    pub thinking_level: String,
    pub is_streaming: bool,
    pub is_compacting: bool,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    /// base64，不含 data: 前缀。
    pub data: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptOutcome {
    Started,
    Queued,
    Handled,
}

/// 归一事件。`sessionId` 由适配器填充，前端据此丢弃过期会话的事件。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UnifiedAgentEvent {
    RunStarted {
        session_id: String,
    },
    RunSettled {
        session_id: String,
        aborted: bool,
    },
    TurnStarted {
        session_id: String,
    },
    TextDelta {
        session_id: String,
        content_index: u32,
        delta: String,
    },
    ThinkingDelta {
        session_id: String,
        content_index: u32,
        delta: String,
    },
    BlockEnd {
        session_id: String,
        content_index: u32,
        block: ContentBlock,
    },
    ToolCallStart {
        session_id: String,
        tool_call_id: String,
        tool_name: String,
    },
    ToolCallEnd {
        session_id: String,
        tool_call_id: String,
        args: serde_json::Value,
    },
    ToolExecStart {
        session_id: String,
        tool_call_id: String,
        tool_name: String,
        args: serde_json::Value,
    },
    ToolExecEnd {
        session_id: String,
        tool_call_id: String,
        is_error: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        content: String,
    },
    Usage {
        session_id: String,
        usage: Usage,
    },
    MessageCommitted {
        session_id: String,
        message: ChatMessage,
    },
    SessionInfo {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_file: Option<String>,
    },
    Compaction {
        session_id: String,
        phase: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Error {
        session_id: String,
        message: String,
    },
    ExtensionUi {
        session_id: String,
        request: ExtensionUiRequest,
    },
}

impl UnifiedAgentEvent {
    /// 适配器在事件落地前统一补 session id。
    pub fn with_session_id(self, sid: &str) -> Self {
        use UnifiedAgentEvent::*;
        let s = sid.to_string();
        match self {
            RunStarted { .. } => RunStarted { session_id: s },
            RunSettled { aborted, .. } => RunSettled { session_id: s, aborted },
            TurnStarted { .. } => TurnStarted { session_id: s },
            TextDelta { content_index, delta, .. } => TextDelta { session_id: s, content_index, delta },
            ThinkingDelta { content_index, delta, .. } => ThinkingDelta { session_id: s, content_index, delta },
            BlockEnd { content_index, block, .. } => BlockEnd { session_id: s, content_index, block },
            ToolCallStart { tool_call_id, tool_name, .. } => ToolCallStart { session_id: s, tool_call_id, tool_name },
            ToolCallEnd { tool_call_id, args, .. } => ToolCallEnd { session_id: s, tool_call_id, args },
            ToolExecStart { tool_call_id, tool_name, args, .. } => {
                ToolExecStart { session_id: s, tool_call_id, tool_name, args }
            }
            ToolExecEnd { tool_call_id, is_error, duration_ms, content, .. } => {
                ToolExecEnd { session_id: s, tool_call_id, is_error, duration_ms, content }
            }
            Usage { usage, .. } => Usage { session_id: s, usage },
            MessageCommitted { message, .. } => MessageCommitted { session_id: s, message },
            SessionInfo { name, session_file, .. } => SessionInfo { session_id: s, name, session_file },
            Compaction { phase, reason, .. } => Compaction { session_id: s, phase, reason },
            Error { message, .. } => Error { session_id: s, message },
            ExtensionUi { request, .. } => ExtensionUi { session_id: s, request },
        }
    }
}

pub type AdapterError = Box<dyn std::error::Error + Send + Sync>;

pub type AdapterResult<T> = Result<T, AdapterError>;

/// Agent 后端抽象。
///
/// 所有方法都是 `&self`：适配器内部自己管可变状态（锁/通道），
/// 这样上层可以用 `Arc<dyn AgentAdapter>` 共享，而不用在外层加锁。
#[async_trait::async_trait]
pub trait AgentAdapter: Send + Sync {
    /// 适配器种类标识，前端据此显示后端名。
    fn kind(&self) -> &'static str;

    /// 发送用户消息。`streaming_behavior` 为空时由适配器决定（默认报错交给上层重试）。
    async fn prompt(
        &self,
        text: String,
        images: Vec<ImageInput>,
        streaming_behavior: Option<StreamingBehavior>,
    ) -> AdapterResult<PromptOutcome>;

    async fn abort(&self) -> AdapterResult<()>;

    async fn new_session(&self) -> AdapterResult<()>;

    async fn switch_session(&self, session_path: String) -> AdapterResult<()>;

    async fn state(&self) -> AdapterResult<SessionState>;

    async fn stats(&self) -> AdapterResult<SessionStats>;

    async fn available_models(&self) -> AdapterResult<Vec<ModelInfo>>;

    async fn set_model(&self, provider: String, model_id: String) -> AdapterResult<()>;

    async fn set_thinking_level(&self, level: String) -> AdapterResult<()>;

    async fn set_session_name(&self, name: String) -> AdapterResult<()>;

    async fn respond_extension_ui(&self, response: ExtensionUiResponse) -> AdapterResult<()>;

    /// 优雅退出子进程。调用后适配器不可再用。
    async fn shutdown(&self) -> AdapterResult<()>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamingBehavior {
    Steer,
    FollowUp,
}

impl StreamingBehavior {
    pub fn as_str(self) -> &'static str {
        match self {
            StreamingBehavior::Steer => "steer",
            StreamingBehavior::FollowUp => "followUp",
        }
    }
}

/// 事件出口。测试里换成 Vec 收集，生产里换成 Tauri emit。
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: UnifiedAgentEvent);
}

impl<F> EventSink for F
where
    F: Fn(UnifiedAgentEvent) + Send + Sync + 'static,
{
    fn emit(&self, event: UnifiedAgentEvent) {
        self(event)
    }
}

pub type SharedSink = Arc<dyn EventSink>;
