//! Native gateway for user-configured model endpoints. The webview never sees
//! the network: requests, API keys and response parsing stay on this side, and
//! the webview receives progress events over a channel plus one final result.
//!
//! Two wire formats are supported: OpenAI-compatible chat completions and the
//! Anthropic Messages API. Both are requested as server-sent event streams.

use std::{
    collections::HashMap,
    future::Future,
    pin::pin,
    sync::{Mutex, OnceLock},
    task::Poll,
    time::Duration,
};

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{
    async_runtime::{channel, Sender},
    ipc::Channel,
};
use url::Url;

const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
// A streamed reply wraps every token in its own JSON event, so the wire size is
// several times the assembled message; the assembled message keeps the 4 MB cap.
const MAX_STREAM_BYTES: usize = 32 * 1024 * 1024;
const MAX_STREAMED_TOOL_CALLS: usize = 16;
const MAX_CONTENT_BLOCKS: usize = 64;
const MAX_LISTED_MODELS: usize = 1000;
const MAX_URL_LENGTH: usize = 2048;
const MAX_REQUEST_ID_LENGTH: usize = 64;
const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;
const MODEL_CONNECT_TIMEOUT_SECONDS: u64 = 20;
// Streaming keeps a long generation alive as long as events keep arriving; the
// idle limit catches a provider that stops sending mid-reply.
const MODEL_IDLE_TIMEOUT_SECONDS: u64 = 90;
const MODEL_TOTAL_TIMEOUT_SECONDS: u64 = 600;
const MODEL_LIST_TIMEOUT_SECONDS: u64 = 30;
const ANTHROPIC_VERSION: &str = "2023-06-01";
// Streaming removes the HTTP-timeout reason to keep this low, and on current
// Claude models the limit also covers thinking tokens.
const ANTHROPIC_DEFAULT_MAX_TOKENS: u32 = 64_000;

static MODEL_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static ACTIVE_REQUESTS: OnceLock<Mutex<HashMap<String, Sender<()>>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Endpoint {
    ChatCompletions,
    Messages,
    Models,
}

impl Endpoint {
    fn leaf(self) -> &'static str {
        match self {
            Self::ChatCompletions => "/chat/completions",
            Self::Messages => "/messages",
            Self::Models => "/models",
        }
    }
}

/// Which wire format a configured endpoint speaks.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiFormat {
    Openai,
    Anthropic,
}

/// How an Anthropic-format gateway expects the key. The Claude API uses
/// `x-api-key`; some gateways in front of it expect a bearer token instead.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthScheme {
    #[default]
    ApiKey,
    Bearer,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCompletionRequest {
    #[serde(default)]
    request_id: String,
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<Value>,
    #[serde(default)]
    tools: Option<Vec<Value>>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionBody {
    model: String,
    messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(rename = "max_tokens", skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    stream: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicMessageRequest {
    #[serde(default)]
    request_id: String,
    base_url: String,
    api_key: String,
    #[serde(default)]
    auth_scheme: AuthScheme,
    model: String,
    #[serde(default)]
    system: String,
    messages: Vec<Value>,
    #[serde(default)]
    tools: Vec<Value>,
    max_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListModelsRequest {
    format: ApiFormat,
    base_url: String,
    api_key: String,
    #[serde(default)]
    auth_scheme: AuthScheme,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: String,
    display_name: String,
}

/// Build the endpoint URL from a user-supplied Base URL. An origin or a path
/// ending in `/v1` gets the standard leaf appended; a URL that already names a
/// full endpoint keeps its path, so gateways with unusual layouts still work.
fn model_endpoint(raw_url: &str, endpoint: Endpoint) -> Result<Url, String> {
    if raw_url.len() > MAX_URL_LENGTH {
        return Err("The model Base URL is too long.".to_string());
    }

    let mut url =
        Url::parse(raw_url.trim()).map_err(|_| "The model Base URL is invalid.".to_string())?;
    let host = url
        .host_str()
        .ok_or_else(|| "The model Base URL must include a host.".to_string())?;
    let is_localhost = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1");

    if url.scheme() != "https" && !(url.scheme() == "http" && is_localhost) {
        return Err(
            "The model Base URL must use HTTPS (HTTP is allowed only for localhost).".to_string(),
        );
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The model Base URL must not contain credentials.".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("The model Base URL must not contain a query string or fragment.".to_string());
    }

    let path = url.path().trim_end_matches('/').to_string();
    let explicit = [
        Endpoint::ChatCompletions,
        Endpoint::Messages,
        Endpoint::Models,
    ]
    .into_iter()
    .find_map(|known| path.strip_suffix(known.leaf()));
    let root = match explicit {
        Some(root) => root.to_string(),
        None if path.ends_with("/v1") => path.clone(),
        None => format!("{path}/v1"),
    };
    url.set_path(&format!("{root}{}", endpoint.leaf()));
    Ok(url)
}

/// One HTTP client for the app's lifetime, so consecutive Agent turns reuse the
/// pooled TLS connection instead of handshaking with the gateway every time.
fn model_client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = MODEL_CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(MODEL_CONNECT_TIMEOUT_SECONDS))
        .read_timeout(Duration::from_secs(MODEL_IDLE_TIMEOUT_SECONDS))
        .timeout(Duration::from_secs(MODEL_TOTAL_TIMEOUT_SECONDS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Could not initialize the model gateway: {error}"))?;
    Ok(MODEL_CLIENT.get_or_init(|| client))
}

fn require_credentials(api_key: &str, model: Option<&str>) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("An API key is required to run the Agent.".to_string());
    }
    if model.is_some_and(|model| model.trim().is_empty()) {
        return Err("A model name is required to run the Agent.".to_string());
    }
    Ok(())
}

fn require_encoded_size(request: &impl Serialize) -> Result<(), String> {
    let encoded_size = serde_json::to_vec(request)
        .map_err(|_| "The model request could not be encoded.".to_string())?
        .len();
    if encoded_size > MAX_REQUEST_BYTES {
        return Err("The model request is too large.".to_string());
    }
    Ok(())
}

fn gateway_send_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The model gateway timed out.".to_string()
    } else {
        format!("Could not reach the model gateway: {error}")
    }
}

fn gateway_read_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The model gateway timed out.".to_string()
    } else {
        "Could not read the model gateway response.".to_string()
    }
}

/// Pull a readable message out of an error body in either provider's format,
/// without echoing the key back if a gateway included it.
fn error_message_from_body(body: &[u8], api_key: &str) -> Option<String> {
    let parsed: Value = serde_json::from_slice(body).ok()?;
    let message = parsed
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .or_else(|| parsed.get("message").and_then(Value::as_str))?;
    let mut message: String = message.chars().take(400).collect();
    let key = api_key.trim();
    if key.len() >= 8 {
        message = message.replace(key, "[redacted]");
    }
    Some(message)
}

/// Reject redirects and non-success statuses, keeping the provider's own
/// explanation (for example an unknown model name) when it sends one.
async fn check_status(
    response: reqwest::Response,
    api_key: &str,
) -> Result<reqwest::Response, String> {
    let status = response.status();
    if status == StatusCode::MOVED_PERMANENTLY
        || status == StatusCode::FOUND
        || status == StatusCode::TEMPORARY_REDIRECT
        || status == StatusCode::PERMANENT_REDIRECT
    {
        return Err("The model gateway returned a redirect, which is not allowed.".to_string());
    }
    if status.is_success() {
        return Ok(response);
    }
    let mut response = response;
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_ERROR_BODY_BYTES {
            break;
        }
    }
    Err(match error_message_from_body(&body, api_key) {
        Some(message) => format!(
            "The model gateway returned HTTP {}: {message}",
            status.as_u16()
        ),
        None => format!("The model gateway returned HTTP {}.", status.as_u16()),
    })
}

fn is_event_stream(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim_start().starts_with("text/event-stream"))
}

async fn read_json_body(response: reqwest::Response) -> Result<Value, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("The model gateway response is too large.".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| gateway_read_error(&error))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("The model gateway response is too large.".to_string());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The model gateway returned invalid JSON.".to_string())
}

/// Splits a server-sent event byte stream into event payloads. Multi-line
/// `data:` fields are joined per the SSE format; a payload that is already a
/// complete JSON value is dispatched at once, because some gateways omit the
/// blank line that should end each event.
#[derive(Default)]
struct SseDecoder {
    pending: Vec<u8>,
    data: String,
    received: usize,
}

impl SseDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.received += chunk.len();
        if self.received > MAX_STREAM_BYTES {
            return Err("The model gateway response is too large.".to_string());
        }
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        let mut consumed = 0;
        while let Some(offset) = self.pending[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let end = consumed + offset + 1;
            let line = std::str::from_utf8(&self.pending[consumed..end])
                .map_err(|_| "The model gateway stream was not valid UTF-8.".to_string())?
                .trim_end_matches(['\r', '\n'])
                .to_string();
            consumed = end;
            self.line(&line, &mut events)?;
        }
        self.pending.drain(..consumed);
        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<String>, String> {
        let mut events = Vec::new();
        let rest = std::mem::take(&mut self.pending);
        if !rest.is_empty() {
            let line = std::str::from_utf8(&rest)
                .map_err(|_| "The model gateway stream was not valid UTF-8.".to_string())?
                .trim_end_matches(['\r', '\n']);
            self.line(line, &mut events)?;
        }
        if !self.data.is_empty() {
            events.push(std::mem::take(&mut self.data));
        }
        Ok(events)
    }

    fn line(&mut self, line: &str, events: &mut Vec<String>) -> Result<(), String> {
        if line.is_empty() {
            if !self.data.is_empty() {
                events.push(std::mem::take(&mut self.data));
            }
            return Ok(());
        }
        // `event:`, `id:`, `retry:` and `:` keep-alive comments carry nothing the
        // payload does not already say.
        let Some(value) = line.strip_prefix("data:") else {
            return Ok(());
        };
        let value = value.strip_prefix(' ').unwrap_or(value);
        if !self.data.is_empty() {
            self.data.push('\n');
        }
        self.data.push_str(value);
        if self.data.len() > MAX_RESPONSE_BYTES {
            return Err("The model gateway response is too large.".to_string());
        }
        if self.data == "[DONE]"
            || serde_json::from_str::<serde::de::IgnoredAny>(&self.data).is_ok()
        {
            events.push(std::mem::take(&mut self.data));
        }
        Ok(())
    }
}

/// Read an SSE response, handing each payload to `handle` until it reports the
/// stream is complete.
async fn read_sse(
    mut response: reqwest::Response,
    mut handle: impl FnMut(&str) -> Result<bool, String>,
) -> Result<(), String> {
    let mut decoder = SseDecoder::default();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| gateway_read_error(&error))?
    {
        for data in decoder.push(&chunk)? {
            if handle(&data)? {
                return Ok(());
            }
        }
    }
    for data in decoder.finish()? {
        if handle(&data)? {
            return Ok(());
        }
    }
    Ok(())
}

fn active_requests() -> &'static Mutex<HashMap<String, Sender<()>>> {
    ACTIVE_REQUESTS.get_or_init(Default::default)
}

/// Removes a request's cancel handle however the request ends.
struct ActiveRequest(String);

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        if let Ok(mut requests) = active_requests().lock() {
            requests.remove(&self.0);
        }
    }
}

/// Run `work` until it finishes or `cancel_model_request` names its id. Dropping
/// the work future drops the HTTP response, which closes the connection and
/// stops the provider from generating (and billing) the rest of the reply.
async fn cancellable<T>(
    request_id: &str,
    work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if request_id.is_empty() {
        return work.await;
    }
    if request_id.len() > MAX_REQUEST_ID_LENGTH {
        return Err("The model request id is invalid.".to_string());
    }
    let (sender, mut receiver) = channel::<()>(1);
    active_requests()
        .lock()
        .map_err(|_| "The model request registry is unavailable.".to_string())?
        .insert(request_id.to_string(), sender);
    let _registration = ActiveRequest(request_id.to_string());
    let mut work = pin!(work);
    std::future::poll_fn(|context| {
        if receiver.poll_recv(context).is_ready() {
            return Poll::Ready(Err("The model request was cancelled.".to_string()));
        }
        work.as_mut().poll(context)
    })
    .await
}

#[tauri::command]
pub fn cancel_model_request(request_id: String) {
    if let Ok(mut requests) = active_requests().lock() {
        if let Some(sender) = requests.remove(&request_id) {
            let _ = sender.try_send(());
        }
    }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completions
// ---------------------------------------------------------------------------

#[derive(Default)]
struct StreamedToolCall {
    id: String,
    kind: String,
    name: String,
    arguments: String,
}

/// Reassembles an OpenAI-compatible `chat.completion.chunk` stream into the
/// non-streamed response shape the Agent loop already understands.
#[derive(Default)]
struct StreamedCompletion {
    content: String,
    tool_calls: Vec<StreamedToolCall>,
    finish_reason: Option<String>,
    usage: Option<Value>,
    saw_choice: bool,
    assembled_bytes: usize,
}

impl StreamedCompletion {
    /// Consume one event payload. `emit` receives progress events for the webview.
    fn feed_event(&mut self, data: &str, emit: &mut dyn FnMut(Value)) -> Result<(), String> {
        let chunk: Value = serde_json::from_str(data)
            .map_err(|_| "The model gateway stream contained invalid JSON.".to_string())?;
        if chunk.get("error").is_some_and(|error| !error.is_null()) {
            let message = chunk["error"]
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The model gateway reported an error while streaming.");
            return Err(message.chars().take(500).collect());
        }
        if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
            self.usage = Some(usage.clone());
        }
        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return Ok(());
        };
        self.saw_choice = true;
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        let Some(delta) = choice.get("delta") else {
            return Ok(());
        };
        if let Some(piece) = delta.get("content").and_then(Value::as_str) {
            if !piece.is_empty() {
                self.grow(piece.len())?;
                self.content.push_str(piece);
                emit(json!({ "type": "delta", "content": piece }));
            }
        }
        if delta
            .get("reasoning_content")
            .and_then(Value::as_str)
            .is_some_and(|piece| !piece.is_empty())
        {
            emit(json!({ "type": "activity" }));
        }
        for call in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = self.tool_call_slot(call)?;
            let slot = &mut self.tool_calls[index];
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                if slot.id.is_empty() {
                    slot.id = id.to_string();
                }
            }
            if let Some(kind) = call.get("type").and_then(Value::as_str) {
                if slot.kind.is_empty() {
                    slot.kind = kind.to_string();
                }
            }
            let function = call.get("function");
            if let Some(name) = function.and_then(|f| f.get("name")).and_then(Value::as_str) {
                if slot.name.is_empty() && !name.is_empty() {
                    slot.name = name.to_string();
                    emit(json!({ "type": "tool", "name": name }));
                }
            }
            if let Some(arguments) = function
                .and_then(|f| f.get("arguments"))
                .and_then(Value::as_str)
            {
                self.grow(arguments.len())?;
                self.tool_calls[index].arguments.push_str(arguments);
                emit(json!({ "type": "activity" }));
            }
        }
        Ok(())
    }

    /// Find the slot a tool-call delta belongs to. Gateways that omit `index`
    /// send each call with its own `id`, so a new id starts a new call.
    fn tool_call_slot(&mut self, call: &Value) -> Result<usize, String> {
        let index = match call.get("index").and_then(Value::as_u64) {
            Some(index) => usize::try_from(index).unwrap_or(usize::MAX),
            None => {
                let id = call.get("id").and_then(Value::as_str).unwrap_or("");
                match self.tool_calls.last() {
                    Some(last) if id.is_empty() || last.id.is_empty() || last.id == id => {
                        self.tool_calls.len() - 1
                    }
                    _ => self.tool_calls.len(),
                }
            }
        };
        if index >= MAX_STREAMED_TOOL_CALLS {
            return Err("The model gateway streamed too many tool calls.".to_string());
        }
        if self.tool_calls.len() <= index {
            self.tool_calls
                .resize_with(index + 1, StreamedToolCall::default);
        }
        Ok(index)
    }

    fn grow(&mut self, bytes: usize) -> Result<(), String> {
        self.assembled_bytes += bytes;
        if self.assembled_bytes > MAX_RESPONSE_BYTES {
            return Err("The model gateway response is too large.".to_string());
        }
        Ok(())
    }

    fn into_response(self) -> Result<Value, String> {
        if !self.saw_choice {
            return Err("The model gateway stream did not contain choices.".to_string());
        }
        let mut message = Map::new();
        message.insert("role".to_string(), json!("assistant"));
        message.insert(
            "content".to_string(),
            if self.content.is_empty() {
                Value::Null
            } else {
                Value::String(self.content)
            },
        );
        let tool_calls: Vec<Value> = self
            .tool_calls
            .into_iter()
            .enumerate()
            .filter(|(_, call)| !call.name.is_empty())
            .map(|(index, call)| {
                json!({
                    "id": if call.id.is_empty() { format!("call_{index}") } else { call.id },
                    "type": if call.kind.is_empty() { "function".to_string() } else { call.kind },
                    "function": { "name": call.name, "arguments": call.arguments },
                })
            })
            .collect();
        if !tool_calls.is_empty() {
            message.insert("tool_calls".to_string(), Value::Array(tool_calls));
        }
        let mut response = json!({
            "choices": [{
                "index": 0,
                "message": Value::Object(message),
                "finish_reason": self.finish_reason,
            }]
        });
        if let Some(usage) = self.usage {
            response["usage"] = usage;
        }
        Ok(response)
    }
}

fn sanitize_completion(response_body: Value) -> Result<Value, String> {
    let choices = response_body
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| "The model gateway response did not contain choices.".to_string())?;
    if choices.is_empty() {
        return Err("The model gateway returned no choices.".to_string());
    }
    if choices[0]
        .get("message")
        .and_then(Value::as_object)
        .is_none()
    {
        return Err("The model gateway response did not contain an assistant message.".to_string());
    }

    // Keep the response shape provider-neutral while dropping accidental top-level
    // fields that could contain provider-specific diagnostics or echoed secrets.
    let mut safe_response = Map::new();
    safe_response.insert("choices".to_string(), Value::Array(choices.clone()));
    if let Some(usage) = response_body.get("usage") {
        safe_response.insert("usage".to_string(), usage.clone());
    }
    Ok(Value::Object(safe_response))
}

async fn run_chat_completion(
    request: ChatCompletionRequest,
    on_event: &Channel<Value>,
) -> Result<Value, String> {
    require_credentials(&request.api_key, Some(&request.model))?;
    require_encoded_size(&request)?;
    let endpoint = model_endpoint(&request.base_url, Endpoint::ChatCompletions)?;
    let body = ChatCompletionBody {
        model: request.model.trim().to_string(),
        messages: request.messages,
        tools: request.tools,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        stream: true,
    };

    let response = model_client()?
        .post(endpoint)
        .bearer_auth(&request.api_key)
        .header(
            reqwest::header::ACCEPT,
            "text/event-stream, application/json",
        )
        .json(&body)
        .send()
        .await
        .map_err(|error| gateway_send_error(&error))?;
    let response = check_status(response, &request.api_key).await?;

    if !is_event_stream(&response) {
        // Gateways that ignore `stream: true` still answer with a single JSON body.
        return sanitize_completion(read_json_body(response).await?);
    }
    let mut completion = StreamedCompletion::default();
    let mut emit = |event: Value| {
        let _ = on_event.send(event);
    };
    read_sse(response, |data| {
        if data == "[DONE]" {
            return Ok(true);
        }
        completion.feed_event(data, &mut emit)?;
        Ok(false)
    })
    .await?;
    sanitize_completion(completion.into_response()?)
}

#[tauri::command]
pub async fn chat_completion(
    request: ChatCompletionRequest,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    let request_id = request.request_id.clone();
    cancellable(&request_id, run_chat_completion(request, &on_event)).await
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}

fn append_string(block: &mut Value, field: &str, piece: &str) {
    if let Some(Value::String(existing)) = block.get_mut(field) {
        existing.push_str(piece);
        return;
    }
    block[field] = Value::String(piece.to_string());
}

/// Reassembles a Messages API event stream into the final `content` array.
/// Blocks keep every field the API sent, and `thinking` blocks keep their
/// `signature`: the next request must send them back unchanged.
#[derive(Default)]
struct StreamedMessage {
    blocks: Vec<Option<Value>>,
    tool_inputs: HashMap<usize, String>,
    stop_reason: Option<Value>,
    stop_details: Option<Value>,
    model: Option<String>,
    usage: Map<String, Value>,
    done: bool,
    assembled_bytes: usize,
}

impl StreamedMessage {
    fn grow(&mut self, bytes: usize) -> Result<(), String> {
        self.assembled_bytes += bytes;
        if self.assembled_bytes > MAX_RESPONSE_BYTES {
            return Err("The model gateway response is too large.".to_string());
        }
        Ok(())
    }

    fn merge_usage(&mut self, usage: Option<&Value>) {
        if let Some(usage) = usage.and_then(Value::as_object) {
            for (key, value) in usage {
                self.usage.insert(key.clone(), value.clone());
            }
        }
    }

    fn block_index(event: &Value) -> Result<usize, String> {
        let index = event
            .get("index")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .ok_or_else(|| "The model stream sent a content block without an index.".to_string())?;
        if index >= MAX_CONTENT_BLOCKS {
            return Err("The model stream sent too many content blocks.".to_string());
        }
        Ok(index)
    }

    /// Consume one event payload. `emit` receives progress events for the webview.
    fn feed_event(&mut self, data: &str, emit: &mut dyn FnMut(Value)) -> Result<(), String> {
        let event: Value = serde_json::from_str(data)
            .map_err(|_| "The model gateway stream contained invalid JSON.".to_string())?;
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "message_start" => {
                let message = event.get("message");
                if let Some(model) = message
                    .and_then(|message| message.get("model"))
                    .and_then(Value::as_str)
                {
                    self.model = Some(model.to_string());
                }
                self.merge_usage(message.and_then(|message| message.get("usage")));
            }
            "content_block_start" => {
                let index = Self::block_index(&event)?;
                let block = event
                    .get("content_block")
                    .filter(|block| block.is_object())
                    .cloned()
                    .ok_or_else(|| "The model stream sent an invalid content block.".to_string())?;
                self.grow(data.len())?;
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    if let Some(name) = block.get("name").and_then(Value::as_str) {
                        emit(json!({ "type": "tool", "name": name }));
                    }
                    self.tool_inputs.insert(index, String::new());
                }
                if self.blocks.len() <= index {
                    self.blocks.resize(index + 1, None);
                }
                self.blocks[index] = Some(block);
            }
            "content_block_delta" => {
                let index = Self::block_index(&event)?;
                let delta = event
                    .get("delta")
                    .ok_or_else(|| "The model stream sent an empty delta.".to_string())?;
                let kind = str_field(delta, "type");
                let (field, piece) = match kind {
                    "text_delta" => ("text", str_field(delta, "text")),
                    "thinking_delta" => ("thinking", str_field(delta, "thinking")),
                    "signature_delta" => ("signature", str_field(delta, "signature")),
                    "input_json_delta" => ("", str_field(delta, "partial_json")),
                    "citations_delta" => {
                        let citation = delta.get("citation").cloned().unwrap_or(Value::Null);
                        self.grow(data.len())?;
                        let block = self.blocks.get_mut(index).and_then(Option::as_mut);
                        if let Some(block) = block {
                            match block.get_mut("citations") {
                                Some(Value::Array(citations)) => citations.push(citation),
                                _ => block["citations"] = Value::Array(vec![citation]),
                            }
                        }
                        return Ok(());
                    }
                    // Future delta types: ignored, as the versioning policy asks.
                    _ => return Ok(()),
                };
                self.grow(piece.len())?;
                if kind == "input_json_delta" {
                    self.tool_inputs.entry(index).or_default().push_str(piece);
                    emit(json!({ "type": "activity" }));
                    return Ok(());
                }
                let block = self
                    .blocks
                    .get_mut(index)
                    .and_then(Option::as_mut)
                    .ok_or_else(|| {
                        "The model stream sent a delta for an unknown block.".to_string()
                    })?;
                append_string(block, field, piece);
                match kind {
                    "text_delta" if !piece.is_empty() => {
                        emit(json!({ "type": "delta", "content": piece }));
                    }
                    "thinking_delta" => emit(json!({ "type": "activity" })),
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = Self::block_index(&event)?;
                if let Some(raw) = self.tool_inputs.remove(&index) {
                    let input = if raw.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str::<Value>(&raw).map_err(|_| {
                            "The model produced tool input that is not valid JSON.".to_string()
                        })?
                    };
                    if let Some(block) = self.blocks.get_mut(index).and_then(Option::as_mut) {
                        block["input"] = input;
                    }
                }
            }
            "message_delta" => {
                if let Some(delta) = event.get("delta") {
                    if let Some(reason) = delta.get("stop_reason").filter(|value| !value.is_null())
                    {
                        self.stop_reason = Some(reason.clone());
                    }
                    if let Some(details) =
                        delta.get("stop_details").filter(|value| !value.is_null())
                    {
                        self.stop_details = Some(details.clone());
                    }
                }
                self.merge_usage(event.get("usage"));
            }
            "message_stop" => self.done = true,
            "error" => {
                let message = event
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("The model gateway reported an error while streaming.");
                return Err(message.chars().take(500).collect());
            }
            // `ping` and event types added after this was written.
            _ => {}
        }
        Ok(())
    }

    fn into_response(self) -> Result<Value, String> {
        if !self.tool_inputs.is_empty() {
            return Err("The model stream ended before a tool call was complete.".to_string());
        }
        if !self.done && self.stop_reason.is_none() {
            return Err("The model stream ended before the reply was complete.".to_string());
        }
        let content: Vec<Value> = self.blocks.into_iter().flatten().collect();
        Ok(json!({
            "content": content,
            "stop_reason": self.stop_reason,
            "stop_details": self.stop_details,
            "model": self.model,
            "usage": Value::Object(self.usage),
        }))
    }
}

/// Keep only the fields the Agent loop reads from a non-streamed message.
fn sanitize_message(body: Value) -> Result<Value, String> {
    let content = body
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "The model gateway response did not contain message content.".to_string())?;
    Ok(json!({
        "content": content,
        "stop_reason": body.get("stop_reason").cloned().unwrap_or(Value::Null),
        "stop_details": body.get("stop_details").cloned().unwrap_or(Value::Null),
        "model": body.get("model").cloned().unwrap_or(Value::Null),
        "usage": body.get("usage").cloned().unwrap_or(Value::Null),
    }))
}

fn with_anthropic_auth(
    builder: reqwest::RequestBuilder,
    api_key: &str,
    scheme: AuthScheme,
) -> reqwest::RequestBuilder {
    let builder = builder.header("anthropic-version", ANTHROPIC_VERSION);
    match scheme {
        AuthScheme::ApiKey => builder.header("x-api-key", api_key),
        AuthScheme::Bearer => builder.bearer_auth(api_key),
    }
}

async fn run_anthropic_message(
    request: AnthropicMessageRequest,
    on_event: &Channel<Value>,
) -> Result<Value, String> {
    require_credentials(&request.api_key, Some(&request.model))?;
    require_encoded_size(&request)?;
    let endpoint = model_endpoint(&request.base_url, Endpoint::Messages)?;
    let mut body = json!({
        "model": request.model.trim(),
        "max_tokens": request.max_tokens.unwrap_or(ANTHROPIC_DEFAULT_MAX_TOKENS),
        "messages": request.messages,
        "stream": true,
    });
    if !request.system.is_empty() {
        body["system"] = Value::String(request.system);
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(request.tools);
    }

    let builder = model_client()?
        .post(endpoint)
        .header(
            reqwest::header::ACCEPT,
            "text/event-stream, application/json",
        )
        .json(&body);
    let response = with_anthropic_auth(builder, &request.api_key, request.auth_scheme)
        .send()
        .await
        .map_err(|error| gateway_send_error(&error))?;
    let response = check_status(response, &request.api_key).await?;

    if !is_event_stream(&response) {
        return sanitize_message(read_json_body(response).await?);
    }
    let mut message = StreamedMessage::default();
    let mut emit = |event: Value| {
        let _ = on_event.send(event);
    };
    read_sse(response, |data| {
        message.feed_event(data, &mut emit)?;
        Ok(message.done)
    })
    .await?;
    message.into_response()
}

#[tauri::command]
pub async fn anthropic_message(
    request: AnthropicMessageRequest,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    let request_id = request.request_id.clone();
    cancellable(&request_id, run_anthropic_message(request, &on_event)).await
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

fn parse_model_list(body: &Value) -> Result<Vec<ModelInfo>, String> {
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "The model gateway did not return a model list.".to_string())?;
    Ok(data
        .iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?.to_string();
            let display_name = item
                .get("display_name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .unwrap_or(&id)
                .to_string();
            Some(ModelInfo { id, display_name })
        })
        .take(MAX_LISTED_MODELS)
        .collect())
}

/// List the models an endpoint offers. This doubles as a connection and
/// credential check that costs no tokens.
#[tauri::command]
pub async fn list_models(request: ListModelsRequest) -> Result<Vec<ModelInfo>, String> {
    require_credentials(&request.api_key, None)?;
    let mut endpoint = model_endpoint(&request.base_url, Endpoint::Models)?;
    let builder = match request.format {
        ApiFormat::Openai => model_client()?.get(endpoint).bearer_auth(&request.api_key),
        ApiFormat::Anthropic => {
            endpoint.set_query(Some("limit=1000"));
            with_anthropic_auth(
                model_client()?.get(endpoint),
                &request.api_key,
                request.auth_scheme,
            )
        }
    };
    let response = builder
        .timeout(Duration::from_secs(MODEL_LIST_TIMEOUT_SECONDS))
        .send()
        .await
        .map_err(|error| gateway_send_error(&error))?;
    let response = check_status(response, &request.api_key).await?;
    parse_model_list(&read_json_body(response).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(chunks: &[&str]) -> Vec<String> {
        let mut decoder = SseDecoder::default();
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(decoder.push(chunk.as_bytes()).unwrap());
        }
        events.extend(decoder.finish().unwrap());
        events
    }

    fn openai(events: &[&str]) -> (Result<Value, String>, Vec<Value>) {
        let mut completion = StreamedCompletion::default();
        let mut emitted = Vec::new();
        let mut emit = |event: Value| emitted.push(event);
        for event in events {
            if let Err(error) = completion.feed_event(event, &mut emit) {
                return (Err(error), emitted);
            }
        }
        (completion.into_response(), emitted)
    }

    fn anthropic(events: &[&str]) -> (Result<Value, String>, Vec<Value>) {
        let mut message = StreamedMessage::default();
        let mut emitted = Vec::new();
        let mut emit = |event: Value| emitted.push(event);
        for event in events {
            if let Err(error) = message.feed_event(event, &mut emit) {
                return (Err(error), emitted);
            }
        }
        (message.into_response(), emitted)
    }

    #[test]
    fn builds_endpoints_from_base_urls() {
        let url = |base: &str, endpoint| model_endpoint(base, endpoint).unwrap().to_string();
        assert_eq!(
            url("https://example.test", Endpoint::ChatCompletions),
            "https://example.test/v1/chat/completions"
        );
        assert_eq!(
            url("https://example.test/v1/", Endpoint::Messages),
            "https://example.test/v1/messages"
        );
        assert_eq!(
            url("https://gateway.test/anthropic", Endpoint::Messages),
            "https://gateway.test/anthropic/v1/messages"
        );
        assert_eq!(
            url("https://gateway.test/proxy/messages", Endpoint::Messages),
            "https://gateway.test/proxy/messages"
        );
        assert_eq!(
            url("https://gateway.test/v1/chat/completions", Endpoint::Models),
            "https://gateway.test/v1/models"
        );
        assert!(model_endpoint("http://localhost:3000/v1", Endpoint::Messages).is_ok());
        assert!(model_endpoint("http://example.test/v1", Endpoint::Messages).is_err());
        assert!(model_endpoint("https://example.test/v1?key=secret", Endpoint::Messages).is_err());
    }

    #[test]
    fn decodes_sse_framing_variants() {
        assert_eq!(
            decode(&[
                "data: {\"a\":1}\r\n\r\n: keep-alive\n",
                "event: x\ndata: [DONE]\n\n"
            ]),
            vec!["{\"a\":1}", "[DONE]"]
        );
        // A JSON payload split across two data lines is one event.
        assert_eq!(
            decode(&["data: {\"a\":\ndata: 1}\n\n"]),
            vec!["{\"a\":\n1}"]
        );
        // No blank separators, and the last line has no newline.
        assert_eq!(
            decode(&["data: {\"a\":1}\ndata: {\"b\"", ":2}"]),
            vec!["{\"a\":1}", "{\"b\":2}"]
        );
    }

    #[test]
    fn assembles_streamed_openai_text_and_tool_calls() {
        let (response, events) = openai(&[
            "{\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hel\"}}]}",
            "{\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo\"}}]}",
            "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"superdoc_inspect\",\"arguments\":\"{\\\"includeText\\\"\"}}]}}]}",
            "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":true}\"}}]},\"finish_reason\":\"tool_calls\"}]}",
            "{\"choices\":[],\"usage\":{\"total_tokens\":12}}",
        ]);
        let response = response.unwrap();
        let message = &response["choices"][0]["message"];
        assert_eq!(message["content"], "Hello");
        assert_eq!(message["tool_calls"][0]["id"], "call_a");
        assert_eq!(
            message["tool_calls"][0]["function"]["arguments"],
            "{\"includeText\":true}"
        );
        assert_eq!(response["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(response["usage"]["total_tokens"], 12);
        assert!(events.contains(&json!({"type": "delta", "content": "Hel"})));
        assert!(events.contains(&json!({"type": "tool", "name": "superdoc_inspect"})));
    }

    #[test]
    fn separates_openai_tool_calls_that_omit_their_index() {
        let (response, _) = openai(&[
            "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"id\":\"a\",\"function\":{\"name\":\"one\",\"arguments\":\"{}\"}}]}}]}",
            "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"id\":\"b\",\"function\":{\"name\":\"two\",\"arguments\":\"{\\\"x\\\"\"}}]}}]}",
            "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"function\":{\"arguments\":\":1}\"}}]}}]}",
        ]);
        let calls = response.unwrap()["choices"][0]["message"]["tool_calls"].clone();
        assert_eq!(calls[0]["function"]["name"], "one");
        assert_eq!(calls[1]["function"]["name"], "two");
        assert_eq!(calls[1]["function"]["arguments"], "{\"x\":1}");
    }

    #[test]
    fn rejects_streamed_errors_and_unbounded_indexes() {
        let (error, _) = openai(&["{\"error\":{\"message\":\"model overloaded\"}}"]);
        assert_eq!(error.unwrap_err(), "model overloaded");
        let (empty, _) = openai(&[]);
        assert!(empty.is_err());
        let (overflow, _) = openai(&[
            "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":4096,\"function\":{\"name\":\"x\"}}]}}]}",
        ]);
        assert!(overflow.is_err());
    }

    #[test]
    fn assembles_anthropic_thinking_text_and_tool_use() {
        let (response, events) = anthropic(&[
            "{\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"magpie-1.anthropic.claude-opus-5-5\",\"usage\":{\"input_tokens\":30}}}",
            "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}",
            "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"\"}}",
            "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"EqQB\"}}",
            "{\"type\":\"content_block_stop\",\"index\":0}",
            "{\"type\":\"ping\"}",
            "{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
            "{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Checking.\"}}",
            "{\"type\":\"content_block_stop\",\"index\":1}",
            "{\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"superdoc_inspect\",\"input\":{}}}",
            "{\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\"}}",
            "{\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"includeText\\\":\"}}",
            "{\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\" true}\"}}",
            "{\"type\":\"content_block_stop\",\"index\":2}",
            "{\"type\":\"future_event_type\",\"x\":1}",
            "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":89}}",
            "{\"type\":\"message_stop\"}",
        ]);
        let response = response.unwrap();
        let content = response["content"].as_array().unwrap();
        assert_eq!(
            content[0],
            json!({"type": "thinking", "thinking": "", "signature": "EqQB"})
        );
        assert_eq!(content[1], json!({"type": "text", "text": "Checking."}));
        assert_eq!(
            content[2],
            json!({"type": "tool_use", "id": "toolu_1", "name": "superdoc_inspect", "input": {"includeText": true}})
        );
        assert_eq!(response["stop_reason"], "tool_use");
        assert_eq!(response["model"], "magpie-1.anthropic.claude-opus-5-5");
        assert_eq!(response["usage"]["input_tokens"], 30);
        assert_eq!(response["usage"]["output_tokens"], 89);
        assert!(events.contains(&json!({"type": "delta", "content": "Checking."})));
        assert!(events.contains(&json!({"type": "tool", "name": "superdoc_inspect"})));
    }

    #[test]
    fn keeps_whole_anthropic_blocks_and_reports_failures() {
        let (response, _) = anthropic(&[
            "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"redacted_thinking\",\"data\":\"opaque\"}}",
            "{\"type\":\"content_block_stop\",\"index\":0}",
            "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\",\"stop_details\":{\"type\":\"refusal\",\"category\":null}}}",
            "{\"type\":\"message_stop\"}",
        ]);
        let response = response.unwrap();
        assert_eq!(
            response["content"][0],
            json!({"type": "redacted_thinking", "data": "opaque"})
        );
        assert_eq!(response["stop_details"]["type"], "refusal");

        let (overloaded, _) = anthropic(&[
            "{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}",
        ]);
        assert_eq!(overloaded.unwrap_err(), "Overloaded");

        let (truncated, _) = anthropic(&[
            "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"n\",\"input\":{}}}",
            "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"a\\\"\"}}",
        ]);
        assert!(truncated.is_err());

        let (bad_index, _) = anthropic(&[
            "{\"type\":\"content_block_start\",\"index\":999,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
        ]);
        assert!(bad_index.is_err());
    }

    #[test]
    fn reads_model_lists_and_provider_error_messages() {
        let models = parse_model_list(&json!({"data": [
            {"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5"},
            {"id": "magpie-1.anthropic.claude-opus-5-5"},
            {"object": "model"}
        ]}))
        .unwrap();
        assert_eq!(
            models,
            vec![
                ModelInfo {
                    id: "claude-opus-5-5".into(),
                    display_name: "Claude Opus 5.5".into()
                },
                ModelInfo {
                    id: "magpie-1.anthropic.claude-opus-5-5".into(),
                    display_name: "magpie-1.anthropic.claude-opus-5-5".into()
                },
            ]
        );
        let body = br#"{"type":"error","error":{"type":"not_found_error","message":"model: magpie-x not found for key sk-secret-123"}}"#;
        assert_eq!(
            error_message_from_body(body, "sk-secret-123").unwrap(),
            "model: magpie-x not found for key [redacted]"
        );
        assert_eq!(
            error_message_from_body(br#"{"error":{"message":"bad"}}"#, "").unwrap(),
            "bad"
        );
        assert!(error_message_from_body(b"<html>", "").is_none());
    }
}
