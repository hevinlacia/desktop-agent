//! PiAdapter 集成测试：真的拉起 `pi --mode rpc` 子进程，验证事件映射。
//!
//! 需要本机已装 pi 且模型可用；没有 pi 时自动 skip（返回 Ok），
//! 这样 CI/其他机器不会因环境缺失而红。
//!
//! 运行：`cargo test --test pi_integration -- --nocapture`
//! 只跑这一个：`cargo test --test pi_integration -- --nocapture --test-threads=1`

use std::sync::{Arc, Mutex};
use std::time::Duration;

use desktop_agent_lib::agent::pi_adapter::{PiAdapter, PiSpawnOptions};
use desktop_agent_lib::agent::{AgentAdapter, SharedSink, UnifiedAgentEvent};

/// 收集事件；测试断言时按需读取。
#[derive(Default)]
struct Collector {
    events: Mutex<Vec<UnifiedAgentEvent>>,
}

impl Collector {
    fn snapshot(&self) -> Vec<UnifiedAgentEvent> {
        self.events.lock().unwrap().clone()
    }
}

fn sink_for(collector: &Arc<Collector>) -> SharedSink {
    let c = Arc::clone(collector);
    Arc::new(move |e: UnifiedAgentEvent| {
        c.events.lock().unwrap().push(e);
    })
}

fn pi_available() -> bool {
    std::process::Command::new("pi")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn debug_of(event: &UnifiedAgentEvent) -> String {
    format!("{event:?}")
}

#[tokio::test(flavor = "multi_thread")]
async fn spawn_prompt_and_stream_events() {
    if !pi_available() {
        eprintln!("跳过：本机没有 pi 可执行文件");
        return;
    }

    let collector = Arc::new(Collector::default());
    let adapter = PiAdapter::spawn(
        PiSpawnOptions {
            binary: "pi".into(),
            cwd: std::env::temp_dir().display().to_string(),
            // 不用扩展/skill，测试要快且确定。
            extra_args: vec!["--no-skills".into(), "--no-mcp".into(), "--no-context-files".into()],
            persist_session: false,
        },
        sink_for(&collector),
    )
    .await
    .expect("spawn 应成功");

    // 1. 握手后就该有 session id。
    let state = adapter.state().await.expect("get_state 应成功");
    assert!(state.session_id.is_some(), "握手后 sessionId 不应为空");
    assert_eq!(adapter.kind(), "pi");

    // 2. 发一条最小 prompt，等 runSettled。
    adapter
        .prompt("Reply with exactly: PONG".into(), vec![], None)
        .await
        .expect("prompt 应被接受");

    let settled = wait_for(&collector, Duration::from_secs(120), |e| {
        matches!(e, UnifiedAgentEvent::RunSettled { .. })
    })
    .await;
    assert!(settled, "120s 内应收到 runSettled，收到的事件：{:#?}", collector.snapshot().iter().map(debug_of).collect::<Vec<_>>());

    let events = collector.snapshot();

    // 3. 事件类型断言：文本增量 + committed assistant 消息。
    assert!(
        events.iter().any(|e| matches!(e, UnifiedAgentEvent::RunStarted { .. })),
        "应有 runStarted"
    );
    assert!(
        events.iter().any(|e| matches!(e, UnifiedAgentEvent::TextDelta { .. })),
        "应有 textDelta"
    );

    let assistant = events.iter().find_map(|e| match e {
        UnifiedAgentEvent::MessageCommitted { message, .. }
            if matches!(message, desktop_agent_lib::agent::ChatMessage::Assistant { .. }) =>
        {
            Some(message.clone())
        }
        _ => None,
    });
    let assistant = assistant.expect("应有 committed assistant 消息");
    let desktop_agent_lib::agent::ChatMessage::Assistant { blocks, .. } = assistant else {
        unreachable!()
    };
    let text: String = blocks
        .iter()
        .filter_map(|b| match b {
            desktop_agent_lib::agent::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        text.to_uppercase().contains("PONG"),
        "回复里应包含 PONG，实际：{text:?}"
    );

    // 4. 所有事件的 sessionId 必须一致且非空。
    let sid = state.session_id.clone().unwrap();
    for e in &events {
        let got = session_of(e);
        assert_eq!(got, sid, "事件的 sessionId 应匹配：{e:?}");
    }

    adapter.shutdown().await.expect("shutdown 应成功");
}

#[tokio::test(flavor = "multi_thread")]
async fn abort_during_run_does_not_hang() {
    if !pi_available() {
        eprintln!("跳过：本机没有 pi");
        return;
    }

    let collector = Arc::new(Collector::default());
    let adapter = PiAdapter::spawn(
        PiSpawnOptions {
            binary: "pi".into(),
            cwd: std::env::temp_dir().display().to_string(),
            extra_args: vec!["--no-skills".into(), "--no-mcp".into()],
            persist_session: false,
        },
        sink_for(&collector),
    )
    .await
    .expect("spawn 应成功");

    adapter
        .prompt("Write a 500 word essay about Rust".into(), vec![], None)
        .await
        .expect("prompt 应被接受");

    // 等到确实开始跑，再中止。
    let started = wait_for(&collector, Duration::from_secs(60), |e| {
        matches!(e, UnifiedAgentEvent::RunStarted { .. })
    })
    .await;
    assert!(started, "应能开始一个运行");

    adapter.abort().await.expect("abort 应成功");

    let settled = wait_for(&collector, Duration::from_secs(60), |e| {
        matches!(e, UnifiedAgentEvent::RunSettled { aborted, .. } if *aborted)
    })
    .await;
    assert!(settled, "中止后应收到 aborted 的 runSettled");

    adapter.shutdown().await.expect("shutdown 应成功");
}

/// 轮询等待某个事件出现（适配器事件是异步推送，没有 oneshot 可等）。
async fn wait_for(
    collector: &Arc<Collector>,
    timeout: Duration,
    pred: impl Fn(&UnifiedAgentEvent) -> bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if collector.snapshot().iter().any(&pred) {
            return true;
        }
        if tokio::time::Instant::now() > deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

fn session_of(e: &UnifiedAgentEvent) -> String {
    use UnifiedAgentEvent::*;
    match e {
        RunStarted { session_id, .. }
        | RunSettled { session_id, .. }
        | TurnStarted { session_id, .. }
        | TextDelta { session_id, .. }
        | ThinkingDelta { session_id, .. }
        | BlockEnd { session_id, .. }
        | ToolCallStart { session_id, .. }
        | ToolCallEnd { session_id, .. }
        | ToolExecStart { session_id, .. }
        | ToolExecEnd { session_id, .. }
        | Usage { session_id, .. }
        | MessageCommitted { session_id, .. }
        | SessionInfo { session_id, .. }
        | Compaction { session_id, .. }
        | Error { session_id, .. }
        | ExtensionUi { session_id, .. } => session_id.clone(),
    }
}
