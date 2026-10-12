//! DeepSeek — the part that reasons.
//!
//! Four things here are load-bearing, and all four come from the API's own
//! documented behaviour rather than from taste:
//!
//! * **Model names are read, never assumed.** DeepSeek retires them fast —
//!   `deepseek-chat` and `deepseek-reasoner` were withdrawn in July 2026, and
//!   `deepseek-v4-flash` in September. The list comes from `GET /models`.
//! * **Thinking is off by default.** With it on, `temperature` is silently
//!   ignored, `tool_choice: "required"` returns a 400, and the reasoning text
//!   has to be echoed back on every later turn or the next call fails. Off is
//!   both simpler and much faster; it is available per message when a question
//!   deserves it.
//! * **`max_tokens` is always set.** Its default changes with the thinking
//!   setting, so leaving it out means the ceiling moves under you.
//! * **Nothing writes.** Tools that can change something return a proposal for
//!   the user to approve; they never act.

use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::settings;

/// Enough room for a real answer, small enough that a runaway response cannot
/// sit there generating forever.
const MAX_TOKENS: u32 = 4096;

/// How long the model gets to start replying before we give up. DeepSeek keeps
/// the connection alive with blank lines while it queues, so this is generous.
const TIMEOUT: Duration = Duration::from_secs(120);

/// The most of a tool's output that goes back to the model. A 4000-line diff
/// would cost more than the answer is worth.
const MAX_TOOL_RESULT: usize = 12_000;

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/// The conversation, held as raw message objects rather than a simplified
/// shape.
///
/// This matters: a tool exchange is not `{role, content}`. The assistant turn
/// has to carry its `tool_calls` array, each result has to carry the matching
/// `tool_call_id`, and in thinking mode the turn has to carry its
/// `reasoning_content` as well. Flattening any of that away makes the *next*
/// request a 400, so the wire format is kept exactly as it arrived.
static HISTORY: Mutex<Vec<Value>> = Mutex::new(Vec::new());

/// The system prompt. Deliberately short: it describes what the tools are and
/// what they are not, and leaves the rest to the tools' own descriptions.
const SYSTEM: &str = "\
You are Ryfe, a small assistant that lives at the top of the user's screen on Windows.

You can read the user's local git repositories and their GitHub pull requests through tools. \
Use them rather than guessing — if a question is about their code, look before you answer.

Two rules about acting:
- Nothing you do changes anything. Tools whose names start with `propose_` show the user a card \
they have to approve; they do not run. Never say you committed, pushed or sent anything.
- If the user asks for something outside what your tools cover, say so plainly rather than \
inventing a result.

Keep answers short. This is a small panel, not a document. Prefer a sentence or two over a list, \
and only use a list when the answer genuinely is one.";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/// Read-only tools the model may call on its own.
fn read_tools() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "list_repos",
                "description": "List every git repository on this machine, with how many files each has changed. Start here when you do not know which repository the user means.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_status",
                "description": "The current branch, how far ahead or behind the remote it is, and every changed file with its added and removed line counts.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "repo": { "type": "string", "description": "Absolute path to the repository, as returned by list_repos." }
                    },
                    "required": ["repo"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_log",
                "description": "The most recent commits, newest first.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "repo": { "type": "string" },
                        "limit": { "type": "integer", "description": "How many commits, up to 30. Defaults to 15." }
                    },
                    "required": ["repo"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_diff",
                "description": "The exact changes to one file. Use this before describing what changed.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "repo": { "type": "string" },
                        "path": { "type": "string", "description": "Path of the file, relative to the repository root." },
                        "staged": { "type": "boolean", "description": "True for the index, false for the working tree." }
                    },
                    "required": ["repo", "path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "gh_pulse",
                "description": "The user's open pull requests and the pull requests waiting on their review, each with its CI state.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        }
    ])
}

/// Tools that change something. These do not act — they put a card on screen.
fn propose_tools() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "propose_commit",
                "description": "Show the user a card offering to commit their changes, with a message you have drafted from the actual diff. This does NOT commit anything. Read the diff first so the message is accurate.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "repo": { "type": "string" },
                        "message": { "type": "string", "description": "The commit message you are proposing. One short line, no trailing full stop." }
                    },
                    "required": ["repo", "message"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "propose_push",
                "description": "Show the user a card offering to push a repository to its remote. This does NOT push. Use it when they ask to push, or when they have just committed and want it sent.",
                "parameters": {
                    "type": "object",
                    "properties": { "repo": { "type": "string" } },
                    "required": ["repo"]
                }
            }
        }
    ])
}

fn all_tools() -> Value {
    let mut tools = read_tools().as_array().cloned().unwrap_or_default();
    tools.extend(propose_tools().as_array().cloned().unwrap_or_default());
    json!(tools)
}

fn cap(mut s: String) -> String {
    if s.len() > MAX_TOOL_RESULT {
        let mut cut = MAX_TOOL_RESULT;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n… truncated");
    }
    s
}

async fn run_read_tool(name: &str, args: &Value) -> Result<String, String> {
    let repo = args.get("repo").and_then(|v| v.as_str()).unwrap_or("");

    match name {
        "list_repos" => {
            let roots = settings::current().repo_roots;
            let repos = crate::git::git_repos(roots).await?;
            Ok(cap(
                repos
                    .iter()
                    // Plain folders are listed for the UI to offer setting them
                    // up; they are not repositories and would read as broken.
                    .filter(|r| r.has_git)
                    .map(|r| {
                        format!(
                            "{} — {} ({})",
                            r.name,
                            r.path,
                            match r.dirty {
                                Some(0) => "clean".to_string(),
                                Some(n) => format!("{n} changed"),
                                None => "unreadable".to_string(),
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ))
        }
        "git_status" => {
            if repo.is_empty() {
                return Err("repo is required".into());
            }
            let st = crate::git::git_status(repo.to_string()).await?;
            let mut out = format!(
                "branch {} (ahead {}, behind {})\n",
                st.branch, st.ahead, st.behind
            );
            for f in &st.files {
                out.push_str(&format!(
                    "{} {} +{} -{}{}\n",
                    if f.staged { "staged  " } else { "unstaged" },
                    f.path,
                    f.add,
                    f.del,
                    if f.kind.is_empty() { String::new() } else { format!(" ({})", f.kind) }
                ));
            }
            if st.files.is_empty() {
                out.push_str("nothing to commit\n");
            }
            Ok(cap(out))
        }
        "git_log" => {
            if repo.is_empty() {
                return Err("repo is required".into());
            }
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(15)
                .clamp(1, 30) as usize;
            let argv = vec![
                "log".to_string(),
                "--oneline".to_string(),
                "--no-color".to_string(),
                "-n".to_string(),
                limit.to_string(),
            ];
            Ok(cap(crate::git::run_read(repo, argv).await?))
        }
        "git_diff" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            if repo.is_empty() || path.is_empty() {
                return Err("repo and path are required".into());
            }
            let staged = args
                .get("staged")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            Ok(cap(
                crate::git::git_diff(repo.to_string(), Some(path.to_string()), staged).await?,
            ))
        }
        "gh_pulse" => {
            let pulse = crate::github::gh_pulse(false).await?;
            let mut out = String::new();
            out.push_str("Yours:\n");
            for pr in &pulse.authored {
                out.push_str(&format!(
                    "  {} #{} {} — CI {}\n",
                    pr.repo, pr.number, pr.title, pr.ci
                ));
            }
            out.push_str("Waiting on your review:\n");
            for pr in &pulse.reviewing {
                out.push_str(&format!(
                    "  {} #{} {} (by {})\n",
                    pr.repo, pr.number, pr.title, pr.author
                ));
            }
            Ok(cap(out))
        }
        _ => Err(format!("'{name}' is not a tool Ryfe runs")),
    }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

fn base_url() -> String {
    let raw = settings::current().deepseek_base_url;
    raw.trim().trim_end_matches('/').to_string()
}

fn key() -> Result<String, String> {
    crate::secrets::get("deepseek-api-key")
        .ok_or_else(|| "No DeepSeek key yet. Add one in Settings → DeepSeek.".to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))
}

#[derive(Serialize, Clone, Debug)]
pub struct ModelInfo {
    pub id: String,
    pub context: u64,
    pub max_output: u64,
    /// Whether a picture can be sent to it.
    pub vision: bool,
}

/// Asks the API what it currently offers.
///
/// This exists so that a retired model name shows up as a picker with nothing
/// selected rather than as a 400 in the middle of a conversation.
#[tauri::command]
pub async fn ai_models() -> Result<Vec<ModelInfo>, String> {
    let key = key()?;
    let res = client()?
        .get(format!("{}/models", base_url()))
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await
        .map_err(|e| format!("could not reach DeepSeek: {e}"))?;

    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("DeepSeek rejected the key.".to_string());
    }
    if !res.status().is_success() {
        return Err(format!("DeepSeek returned {}", res.status()));
    }

    let body: Value = res.json().await.map_err(|e| format!("odd reply: {e}"))?;
    let models = body
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id")?.as_str()?.to_string();
                    let vision = m
                        .get("input_modalities")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().any(|x| x.as_str() == Some("image")))
                        .unwrap_or(false);
                    Some(ModelInfo {
                        id,
                        context: m.get("context_window").and_then(|v| v.as_u64()).unwrap_or(0),
                        max_output: m
                            .get("max_output_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        vision,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(models)
}

/// Clears the conversation history.
#[tauri::command]
pub fn ai_reset() {
    if let Ok(mut h) = HISTORY.lock() {
        h.clear();
    }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/// One streamed completion. Returns the assistant text plus any tool calls.
async fn stream_once(
    app: &AppHandle,
    messages: &[Value],
    tools: Option<Value>,
    thinking: bool,
) -> Result<(String, Option<Vec<Value>>, String), String> {
    let key = key()?;

    let mut body = json!({
        "model": settings::current().deepseek_model,
        "messages": messages,
        "stream": true,
        "max_tokens": MAX_TOKENS,
    });

    if thinking {
        // DeepSeek's default is on at "high"; say so explicitly rather than
        // inheriting whatever the default becomes next.
        body["thinking"] = json!({ "type": "enabled" });
        body["reasoning_effort"] = json!("high");
    } else {
        body["thinking"] = json!({ "type": "disabled" });
        // Only meaningful with thinking off — it is silently ignored otherwise.
        body["temperature"] = json!(0.3);
    }

    if let Some(t) = tools {
        body["tools"] = t;
        // Never "required" or a named function: both return 400 in thinking mode,
        // and "auto" is what we want regardless.
        body["tool_choice"] = json!("auto");
    }

    let res = client()?
        .post(format!("{}/chat/completions", base_url()))
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("could not reach DeepSeek: {e}"))?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("DeepSeek rejected the key.".to_string());
    }
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        let model = settings::current().deepseek_model;
        // Naming the model makes a retired-model 400 obvious rather than
        // looking like a malformed request.
        return Err(format!("DeepSeek returned {status} for model '{model}': {text}"));
    }

    let mut text = String::new();
    let mut reasoning = String::new();
    // Tool calls arrive in fragments: the first chunk carries the id and name,
    // later chunks append argument text.
    let mut calls: Vec<(String, String, String)> = Vec::new();
    let mut finish = String::new();
    let mut buf = String::new();
    let mut stream = res.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("connection dropped: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        // SSE is line oriented; a chunk can split a line in half, so keep the
        // remainder buffered.
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);

            // Blank lines and ":" comments are keep-alives while the model
            // queues. They are not a failure.
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                break;
            }

            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            let Some(choice) = v.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first())
            else {
                continue;
            };

            if let Some(f) = choice.get("finish_reason").and_then(|f| f.as_str()) {
                finish = f.to_string();
            }

            let Some(delta) = choice.get("delta") else {
                continue;
            };

            if let Some(piece) = delta.get("content").and_then(|c| c.as_str()) {
                text.push_str(piece);
                let _ = app.emit("ai-delta", piece);
            }
            // Reasoning is only echoed in thinking mode, and goes to the UI
            // collapsed rather than mixed into the answer.
            if let Some(piece) = delta.get("reasoning_content").and_then(|c| c.as_str()) {
                reasoning.push_str(piece);
                let _ = app.emit("ai-reasoning", piece);
            }

            if let Some(tc) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                for call in tc {
                    let idx = call.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                    while calls.len() <= idx {
                        calls.push((String::new(), String::new(), String::new()));
                    }
                    if let Some(id) = call.get("id").and_then(|i| i.as_str()) {
                        calls[idx].0 = id.to_string();
                    }
                    if let Some(f) = call.get("function") {
                        if let Some(n) = f.get("name").and_then(|n| n.as_str()) {
                            calls[idx].1 = n.to_string();
                        }
                        if let Some(a) = f.get("arguments").and_then(|a| a.as_str()) {
                            calls[idx].2.push_str(a);
                        }
                    }
                }
            }
        }
    }

    // DeepSeek adds two finish reasons OpenAI does not have; neither means the
    // answer is complete.
    match finish.as_str() {
        "insufficient_system_resource" => {
            return Err("DeepSeek ran out of capacity for that request. Try again.".to_string())
        }
        "aborted" => return Err("DeepSeek stopped that response partway.".to_string()),
        _ => {}
    }

    let tool_calls = if calls.is_empty() {
        None
    } else {
        Some(
            calls
                .into_iter()
                .map(|(id, name, arguments)| {
                    json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": arguments }
                    })
                })
                .collect(),
        )
    };

    // In thinking mode with tools present, this has to come back on every later
    // turn or the next request is a 400 — so it is carried, not discarded.
    Ok((text, tool_calls, reasoning))
}

#[derive(Serialize, Clone, Debug)]
pub struct Reply {
    pub text: String,
    /// Names of the tools that ran, in order, for the status line.
    pub used: Vec<String>,
}

/// Sends a message and runs the tool loop until the model stops asking.
#[tauri::command]
pub async fn ai_send(app: AppHandle, text: String, think: bool) -> Result<Reply, String> {
    let mut history = HISTORY.lock().map(|h| h.clone()).unwrap_or_default();
    history.push(json!({ "role": "user", "content": text }));

    let tools = all_tools();
    let mut used: Vec<String> = Vec::new();
    let mut final_text = String::new();

    // Bounded: a model that keeps calling tools must not loop forever.
    for _round in 0..6 {
        let mut messages = vec![json!({ "role": "system", "content": SYSTEM })];
        messages.extend(history.iter().cloned());

        let (text, calls, reasoning) =
            stream_once(&app, &messages, Some(tools.clone()), think).await?;

        let Some(calls) = calls else {
            final_text = text;
            break;
        };

        // The assistant turn goes back exactly as it came, tool calls and all.
        let mut assistant = json!({ "role": "assistant", "content": text });
        assistant["tool_calls"] = Value::Array(calls.clone());
        if think && !reasoning.is_empty() {
            // With tools present, DeepSeek wants the reasoning echoed on every
            // later turn or the next call is rejected.
            assistant["reasoning_content"] = json!(reasoning);
        }
        history.push(assistant);

        for call in &calls {
            let name = call["function"]["name"].as_str().unwrap_or("").to_string();
            let raw = call["function"]["arguments"].as_str().unwrap_or("{}");
            // Models do produce malformed JSON; a bad call is a result to
            // report, not a crash.
            let args: Value = serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
            let id = call["id"].as_str().unwrap_or("").to_string();

            used.push(name.clone());

            let result = if name.starts_with("propose_") {
                // Nothing is executed. The front end shows a card, and the model
                // is told plainly that no action has happened.
                let _ = app.emit("ai-proposal", json!({ "tool": name, "args": args }));
                "A card offering this was shown to the user. Nothing has happened yet — \
                 they have to approve it themselves. Do not say it was done."
                    .to_string()
            } else {
                match run_read_tool(&name, &args).await {
                    Ok(out) => out,
                    Err(e) => format!("That tool failed: {e}"),
                }
            };

            // The result must name the call it answers, or the request is
            // malformed on the next round.
            history.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": result,
            }));
        }

        final_text = text;
    }

    if final_text.trim().is_empty() {
        final_text =
            "I did not get anywhere with that. Try rephrasing, or ask something narrower."
                .to_string();
    }

    history.push(json!({ "role": "assistant", "content": final_text }));
    if let Ok(mut h) = HISTORY.lock() {
        *h = history;
    }

    Ok(Reply {
        text: final_text,
        used,
    })
}
