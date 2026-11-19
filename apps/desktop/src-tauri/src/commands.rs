use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use url::Url;

const MAX_DOCUMENT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
// A streamed reply wraps every token in its own JSON event, so the wire size is
// several times the assembled message; the assembled message keeps the 4 MB cap.
const MAX_STREAM_BYTES: usize = 32 * 1024 * 1024;
const MAX_STREAMED_TOOL_CALLS: usize = 16;
const MAX_URL_LENGTH: usize = 2048;
const MODEL_CONNECT_TIMEOUT_SECONDS: u64 = 20;
// Streaming keeps a long generation alive as long as tokens keep arriving; the
// idle limit catches a provider that stops sending mid-reply.
const MODEL_IDLE_TIMEOUT_SECONDS: u64 = 90;
const MODEL_TOTAL_TIMEOUT_SECONDS: u64 = 600;

/// Header carrying the percent-encoded destination path of a raw `write_file`
/// payload. Header values must be ASCII, and Windows paths often are not.
const DOCUMENT_PATH_HEADER: &str = "x-superdoc-path";

static MODEL_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn MoveFileExW(existing_file_name: *const u16, new_file_name: *const u16, flags: u32) -> i32;
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFileMetadata {
    modified_at_ms: u128,
    size: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCompletionRequest {
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
struct ModelRequest {
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

fn validate_path(raw_path: &str) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("A document path is required.".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("Document paths must be absolute.".to_string());
    }

    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("docx"))
        != Some(true)
    {
        return Err("Only .docx files are supported.".to_string());
    }

    Ok(path)
}

fn check_document_size(size: u64) -> Result<(), String> {
    if size > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "The document is too large. The maximum supported size is {} MB.",
            MAX_DOCUMENT_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

fn decode_path_header(value: &str) -> Result<String, String> {
    let invalid = || "The document path header is not valid percent-encoding.".to_string();
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3).ok_or_else(invalid)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return Err(invalid());
            }
            let text = std::str::from_utf8(hex).map_err(|_| invalid())?;
            decoded.push(u8::from_str_radix(text, 16).map_err(|_| invalid())?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "The document path is not valid UTF-8.".to_string())
}

/// Read a document and hand its bytes to the webview as a binary IPC response.
/// Returning `Vec<u8>` would serialize every byte as a JSON number.
#[tauri::command]
pub async fn read_file(path: String) -> Result<Response, String> {
    let path = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not inspect the document: {error}"))?;
        check_document_size(metadata.len())?;
        let data =
            fs::read(&path).map_err(|error| format!("Could not read the document: {error}"))?;
        check_document_size(data.len() as u64)?;
        Ok(Response::new(data))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Write a document sent as a raw `application/octet-stream` IPC body. The
/// destination travels in [`DOCUMENT_PATH_HEADER`].
#[tauri::command]
pub async fn write_file(request: Request<'_>) -> Result<(), String> {
    let encoded_path = request
        .headers()
        .get(DOCUMENT_PATH_HEADER)
        .ok_or_else(|| "A document path is required.".to_string())?
        .to_str()
        .map_err(|_| "The document path header is invalid.".to_string())?;
    let path = validate_path(&decode_path_header(encoded_path)?)?;
    let InvokeBody::Raw(data) = request.body() else {
        return Err("The document must be sent as binary data.".to_string());
    };
    check_document_size(data.len() as u64)?;
    let data = data.clone();
    tauri::async_runtime::spawn_blocking(move || atomic_write(&path, &data))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The document path has no parent directory.".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The document path has an invalid file name.".to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Could not create a temporary file name: {error}"))?
        .as_nanos();
    let temporary_path = parent.join(format!(".{file_name}.{timestamp}.superdoc-tmp"));

    let write_result = (|| -> Result<(), String> {
        let mut temporary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|error| format!("Could not create a temporary document: {error}"))?;
        temporary
            .write_all(data)
            .map_err(|error| format!("Could not write the document: {error}"))?;
        temporary
            .sync_all()
            .map_err(|error| format!("Could not flush the document: {error}"))?;
        drop(temporary);

        replace_file(&temporary_path, path)
            .map_err(|error| format!("Could not replace the document: {error}"))
    })();

    if temporary_path.exists() {
        let _ = fs::remove_file(&temporary_path);
    }
    write_result
}

#[tauri::command]
pub async fn file_metadata(path: String) -> Result<DocumentFileMetadata, String> {
    let path = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not inspect the document: {error}"))?;
        check_document_size(metadata.len())?;
        let modified = metadata
            .modified()
            .map_err(|error| format!("Could not read the document timestamp: {error}"))?
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("The document timestamp is invalid: {error}"))?;

        Ok(DocumentFileMetadata {
            modified_at_ms: modified.as_millis(),
            size: metadata.len(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn normalize_model_endpoint(raw_url: &str) -> Result<Url, String> {
    if raw_url.len() > MAX_URL_LENGTH {
        return Err("The model Base URL is too long.".to_string());
    }

    let mut url =
        Url::parse(raw_url.trim()).map_err(|_| "The model Base URL is invalid.".to_string())?;
    let host = url
        .host_str()
        .ok_or_else(|| "The model Base URL must include a host.".to_string())?;
    let is_localhost = matches!(host, "localhost" | "127.0.0.1" | "::1");

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

    // `url.path()` borrows the URL immutably and every branch below mutates it,
    // so copy the trimmed path out before `set_path` needs the same value.
    let path = url.path().trim_end_matches('/').to_string();
    if path.ends_with("/chat/completions") {
        url.set_path(&path);
    } else if path.ends_with("/v1") {
        url.set_path(&format!("{path}/chat/completions"));
    } else if path.is_empty() {
        url.set_path("/v1/chat/completions");
    } else {
        url.set_path(&format!("{path}/v1/chat/completions"));
    }

    Ok(url)
}

fn validate_model_request(request: &ChatCompletionRequest) -> Result<Url, String> {
    if request.api_key.trim().is_empty() {
        return Err("An API key is required to run the Agent.".to_string());
    }
    if request.model.trim().is_empty() {
        return Err("A model name is required to run the Agent.".to_string());
    }
    let encoded_size = serde_json::to_vec(request)
        .map_err(|_| "The model request could not be encoded.".to_string())?
        .len();
    if encoded_size > MAX_REQUEST_BYTES {
        return Err("The model request is too large.".to_string());
    }
    normalize_model_endpoint(&request.base_url)
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

fn gateway_read_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The model gateway timed out.".to_string()
    } else {
        "Could not read the model gateway response.".to_string()
    }
}

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
    done: bool,
    assembled_bytes: usize,
}

impl StreamedCompletion {
    /// Consume one SSE line. `emit` receives progress events for the webview.
    fn feed_line(&mut self, line: &[u8], emit: &mut dyn FnMut(Value)) -> Result<(), String> {
        let line = std::str::from_utf8(line)
            .map_err(|_| "The model gateway stream was not valid UTF-8.".to_string())?
            .trim_end_matches(['\r', '\n']);
        let Some(data) = line.strip_prefix("data:") else {
            // Blank separators, `event:` names and `:` keep-alive comments.
            return Ok(());
        };
        let data = data.trim_start();
        if data == "[DONE]" {
            self.done = true;
            return Ok(());
        }
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
            let index = call
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|index| usize::try_from(index).ok())
                .unwrap_or(0);
            if index >= MAX_STREAMED_TOOL_CALLS {
                return Err("The model gateway streamed too many tool calls.".to_string());
            }
            if self.tool_calls.len() <= index {
                self.tool_calls
                    .resize_with(index + 1, StreamedToolCall::default);
            }
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

async fn read_streamed_completion(
    mut response: reqwest::Response,
    on_event: &Channel<Value>,
) -> Result<Value, String> {
    let mut completion = StreamedCompletion::default();
    let mut emit = |event: Value| {
        let _ = on_event.send(event);
    };
    let mut pending: Vec<u8> = Vec::new();
    let mut received = 0usize;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| gateway_read_error(&error))?
    {
        received += chunk.len();
        if received > MAX_STREAM_BYTES {
            return Err("The model gateway response is too large.".to_string());
        }
        pending.extend_from_slice(&chunk);
        let mut consumed = 0;
        while let Some(offset) = pending[consumed..].iter().position(|byte| *byte == b'\n') {
            let end = consumed + offset + 1;
            completion.feed_line(&pending[consumed..end], &mut emit)?;
            consumed = end;
        }
        pending.drain(..consumed);
        if completion.done {
            break;
        }
    }
    if !pending.is_empty() {
        completion.feed_line(&pending, &mut emit)?;
    }
    completion.into_response()
}

#[tauri::command]
pub async fn chat_completion(
    request: ChatCompletionRequest,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    let endpoint = validate_model_request(&request)?;
    let payload = ModelRequest {
        model: request.model.trim().to_string(),
        messages: request.messages,
        tools: request.tools,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        stream: true,
    };

    let response = model_client()?
        .post(endpoint)
        .bearer_auth(request.api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(
            reqwest::header::ACCEPT,
            "text/event-stream, application/json",
        )
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "The model gateway timed out.".to_string()
            } else {
                format!("Could not reach the model gateway: {error}")
            }
        })?;

    let status = response.status();
    if status == StatusCode::MOVED_PERMANENTLY
        || status == StatusCode::FOUND
        || status == StatusCode::TEMPORARY_REDIRECT
        || status == StatusCode::PERMANENT_REDIRECT
    {
        return Err("The model gateway returned a redirect, which is not allowed.".to_string());
    }
    if !status.is_success() {
        return Err(format!(
            "The model gateway returned HTTP {}.",
            status.as_u16()
        ));
    }

    let is_event_stream = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim_start().starts_with("text/event-stream"));
    if is_event_stream {
        let streamed = read_streamed_completion(response, &on_event).await?;
        return sanitize_completion(streamed);
    }

    // Gateways that ignore `stream: true` still answer with a single JSON body.
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("The model gateway response is too large.".to_string());
    }
    let response_bytes = response
        .bytes()
        .await
        .map_err(|error| gateway_read_error(&error))?;
    if response_bytes.len() > MAX_RESPONSE_BYTES {
        return Err("The model gateway response is too large.".to_string());
    }
    let response_body: Value = serde_json::from_slice(&response_bytes)
        .map_err(|_| "The model gateway returned invalid JSON.".to_string())?;
    sanitize_completion(response_body)
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

#[cfg(test)]
mod tests {
    use super::{decode_path_header, normalize_model_endpoint, StreamedCompletion};
    use serde_json::{json, Value};

    fn assemble(lines: &[&str]) -> (Result<Value, String>, Vec<Value>) {
        let mut completion = StreamedCompletion::default();
        let mut events = Vec::new();
        let mut emit = |event: Value| events.push(event);
        for line in lines {
            if let Err(error) = completion.feed_line(line.as_bytes(), &mut emit) {
                return (Err(error), events);
            }
        }
        (completion.into_response(), events)
    }

    #[test]
    fn decodes_non_ascii_document_paths() {
        assert_eq!(
            decode_path_header("C%3A%5C%E6%96%87%E6%A1%A3%5Cdraft%20v2.docx").unwrap(),
            "C:\\文档\\draft v2.docx"
        );
        assert!(decode_path_header("C%3").is_err());
        assert!(decode_path_header("C%+1").is_err());
        assert!(decode_path_header("%FF").is_err());
    }

    #[test]
    fn assembles_streamed_text_and_tool_calls() {
        let (response, events) = assemble(&[
            ": keep-alive\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hel\"}}]}\r\n",
            "\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo\"}}]}\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"superdoc_inspect\",\"arguments\":\"{\\\"includeText\\\"\"}}]}}]}\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":true}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n",
            "data: {\"choices\":[],\"usage\":{\"total_tokens\":12}}\n",
            "data: [DONE]\n",
        ]);
        let response = response.unwrap();
        let message = &response["choices"][0]["message"];
        assert_eq!(message["content"], "Hello");
        assert_eq!(message["tool_calls"][0]["id"], "call_a");
        assert_eq!(
            message["tool_calls"][0]["function"]["name"],
            "superdoc_inspect"
        );
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
    fn surfaces_streamed_provider_errors() {
        let (response, _) = assemble(&["data: {\"error\":{\"message\":\"model overloaded\"}}\n"]);
        assert_eq!(response.unwrap_err(), "model overloaded");
        let (empty, _) = assemble(&["data: [DONE]\n"]);
        assert!(empty.is_err());
    }

    #[test]
    fn rejects_unbounded_tool_call_indexes() {
        let (response, _) = assemble(&[
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":4096,\"function\":{\"name\":\"x\"}}]}}]}\n",
        ]);
        assert!(response.is_err());
    }

    #[test]
    fn normalizes_an_origin() {
        assert_eq!(
            normalize_model_endpoint("https://example.test")
                .expect("valid endpoint")
                .as_str(),
            "https://example.test/v1/chat/completions"
        );
    }

    #[test]
    fn allows_local_http_only() {
        assert!(normalize_model_endpoint("http://localhost:3000/v1").is_ok());
        assert!(normalize_model_endpoint("http://example.test/v1").is_err());
    }

    #[test]
    fn rejects_query_strings() {
        assert!(normalize_model_endpoint("https://example.test/v1?key=secret").is_err());
    }
}
