use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

const MAX_DOCUMENT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_URL_LENGTH: usize = 2048;
const MODEL_TIMEOUT_SECONDS: u64 = 90;

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

#[tauri::command]
pub fn read_file(path: String) -> Result<Vec<u8>, String> {
    let path = validate_path(&path)?;
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Could not inspect the document: {error}"))?;
    check_document_size(metadata.len())?;
    let data = fs::read(&path).map_err(|error| format!("Could not read the document: {error}"))?;
    check_document_size(data.len() as u64)?;
    Ok(data)
}

#[tauri::command]
pub fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    let path = validate_path(&path)?;
    check_document_size(data.len() as u64)?;
    atomic_write(&path, &data)
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
pub fn file_metadata(path: String) -> Result<DocumentFileMetadata, String> {
    let path = validate_path(&path)?;
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Could not inspect the document: {error}"))?;
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

#[tauri::command]
pub async fn chat_completion(request: ChatCompletionRequest) -> Result<Value, String> {
    let endpoint = validate_model_request(&request)?;
    let payload = ModelRequest {
        model: request.model.trim().to_string(),
        messages: request.messages,
        tools: request.tools,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(MODEL_TIMEOUT_SECONDS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Could not initialize the model gateway: {error}"))?;

    let response = client
        .post(endpoint)
        .bearer_auth(request.api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
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

    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("The model gateway response is too large.".to_string());
    }
    let response_bytes = response
        .bytes()
        .await
        .map_err(|_| "Could not read the model gateway response.".to_string())?;
    if response_bytes.len() > MAX_RESPONSE_BYTES {
        return Err("The model gateway response is too large.".to_string());
    }
    let response_body: Value = serde_json::from_slice(&response_bytes)
        .map_err(|_| "The model gateway returned invalid JSON.".to_string())?;
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
    use super::normalize_model_endpoint;

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
