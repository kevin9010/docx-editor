use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{ipc::Channel, Manager, State};

const MAX_FRAME_BYTES: u64 = 4 * 1024 * 1024;
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

struct CodexProcess {
    id: String,
    child: Child,
    stdin: ChildStdin,
    workspace: PathBuf,
}

impl Drop for CodexProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone, Default)]
pub struct CodexState(Arc<Mutex<Option<CodexProcess>>>);

impl CodexState {
    pub fn stop(&self) {
        if let Ok(mut process) = self.0.lock() {
            process.take();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConnection {
    session_id: String,
    executable: String,
}

fn native_from_candidate(candidate: &Path) -> Option<PathBuf> {
    if !candidate.is_file() {
        return None;
    }
    let extension = candidate
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if extension.eq_ignore_ascii_case("exe") || extension.is_empty() {
        return Some(candidate.to_path_buf());
    }
    // Resolve npm's Windows shim to its bundled native binary. Never pass a
    // user-supplied path through cmd.exe or PowerShell command interpolation.
    let root = candidate.parent()?.join("node_modules/@openai/codex");
    for platform in ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"] {
        let package = if platform.starts_with("x86_64") {
            "codex-win32-x64"
        } else {
            "codex-win32-arm64"
        };
        for vendor in [
            root.join("vendor"),
            root.join(format!("node_modules/@openai/{package}/vendor")),
        ] {
            for directory in ["bin", "codex"] {
                let binary = vendor.join(platform).join(directory).join("codex.exe");
                if binary.is_file() {
                    return Some(binary);
                }
            }
        }
    }
    None
}

fn find_codex(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(raw) = explicit.filter(|value| !value.trim().is_empty()) {
        let path = PathBuf::from(raw.trim());
        if !path.is_absolute() {
            return Err("Choose an absolute path to the installed Codex executable.".into());
        }
        return native_from_candidate(&path)
            .ok_or_else(|| "No Codex executable was found at that path.".into());
    }
    let mut directories: Vec<PathBuf> = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect())
        .unwrap_or_default();
    if let Some(profile) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
        directories.push(PathBuf::from(&profile).join(".local/bin"));
        directories.push(PathBuf::from(profile).join(".cargo/bin"));
    }
    if let Some(app_data) = env::var_os("APPDATA") {
        directories.push(PathBuf::from(app_data).join("npm"));
    }
    for directory in directories {
        let names: &[&str] = if cfg!(windows) {
            &["codex.exe", "codex.cmd"]
        } else {
            &["codex"]
        };
        for name in names {
            if let Some(binary) = native_from_candidate(&directory.join(name)) {
                return Ok(binary);
            }
        }
    }
    Err(
        "Codex CLI was not found. Choose its installed executable in settings, or select Base URL."
            .into(),
    )
}

fn write_message(process: &mut CodexProcess, message: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_FRAME_BYTES {
        return Err("The Codex message is too large.".into());
    }
    bytes.push(b'\n');
    process
        .stdin
        .write_all(&bytes)
        .and_then(|()| process.stdin.flush())
        .map_err(|error| format!("Could not send to Codex: {error}"))
}

fn constrain_request(mut message: Value, workspace: &Path) -> Result<Value, String> {
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    match method.as_str() {
        "initialize" | "initialized" | "account/read" | "model/list" | "turn/interrupt"
        | "thread/unsubscribe" => {}
        "thread/start" => {
            let input = message.get("params").cloned().unwrap_or_else(|| json!({}));
            message["params"] = json!({
                "model": input.get("model"),
                "baseInstructions": input.get("baseInstructions"),
                "dynamicTools": input.get("dynamicTools"),
                "cwd": workspace,
                "ephemeral": true,
                "environments": [],
                "sandbox": "read-only",
                "approvalPolicy": "never",
                "config": {
                    "mcp_servers": {}, "web_search": "disabled",
                    "skills": {"include_instructions": false}, "features": {"apps": false}
                }
            });
        }
        "turn/start" => {
            let input = message.get("params").cloned().unwrap_or_else(|| json!({}));
            message["params"] = json!({"threadId": input.get("threadId"), "input": input.get("input"), "environments": []});
        }
        "" if message.get("id").is_some()
            && (message.get("result").is_some() || message.get("error").is_some()) => {}
        _ => return Err("This Codex method is not supported by the document assistant.".into()),
    }
    Ok(message)
}

#[tauri::command]
pub async fn codex_start(
    app: tauri::AppHandle,
    state: State<'_, CodexState>,
    executable: Option<String>,
    on_event: Channel<Value>,
) -> Result<CodexConnection, String> {
    let state = state.inner().clone();
    let workspace = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("codex-workspace");
    tauri::async_runtime::spawn_blocking(move || {
        let binary = find_codex(executable.as_deref())?;
        fs::create_dir_all(&workspace).map_err(|error| format!("Could not create the assistant workspace: {error}"))?;
        let mut guard = state.0.lock().map_err(|_| "Codex process lock failed.")?;
        guard.take();
        let mut command = Command::new(&binary);
        command.args(["app-server", "--listen", "stdio://", "-c", "mcp_servers={}"])
            .current_dir(&workspace).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|error| format!("Could not start Codex: {error}"))?;
        let stdin = child.stdin.take().ok_or("Codex stdin is unavailable.")?;
        let stdout = child.stdout.take().ok_or("Codex stdout is unavailable.")?;
        let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed).to_string();
        *guard = Some(CodexProcess {id: id.clone(), child, stdin, workspace});
        drop(guard);
        let reader_state = state.clone();
        let reader_id = id.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                match (&mut reader).take(MAX_FRAME_BYTES + 1).read_until(b'\n', &mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if bytes.len() as u64 > MAX_FRAME_BYTES => break,
                    Ok(_) => {}
                }
                let Ok(message) = serde_json::from_slice::<Value>(&bytes) else { break };
                if on_event.send(message).is_err() { break; }
            }
            if let Ok(mut process) = reader_state.0.lock() {
                if process.as_ref().is_some_and(|process| process.id == reader_id) {
                    process.take();
                }
            }
            let _ = on_event.send(json!({"method":"bridge/closed", "params":{"message":"The Codex connection closed. Reconnect to continue."}}));
        });
        Ok(CodexConnection {session_id:id, executable:binary.to_string_lossy().into_owned()})
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn codex_send(
    state: State<'_, CodexState>,
    session_id: String,
    message: Value,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.0.lock().map_err(|_| "Codex process lock failed.")?;
        let process = guard
            .as_mut()
            .filter(|process| process.id == session_id)
            .ok_or("The Codex session is no longer connected.")?;
        let message = constrain_request(message, &process.workspace)?;
        write_message(process, &message)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn codex_stop(state: State<'_, CodexState>, session_id: String) -> Result<(), String> {
    let mut process = state.0.lock().map_err(|_| "Codex process lock failed.")?;
    if process
        .as_ref()
        .is_some_and(|process| process.id == session_id)
    {
        process.take();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_document_methods() {
        assert!(constrain_request(
            json!({"id":1,"method":"command/exec","params":{"command":["cmd"]}}),
            Path::new("C:/assistant")
        )
        .is_err());
    }

    #[test]
    fn constrains_thread_and_turn_permissions() {
        let request = constrain_request(json!({"id":1,"method":"thread/start","params":{"sandbox":"danger-full-access","cwd":"C:/private","model":"local-choice"}}), Path::new("C:/assistant")).unwrap();
        assert_eq!(request["params"]["sandbox"], "read-only");
        assert_eq!(request["params"]["environments"], json!([]));
        assert_eq!(request["params"]["model"], "local-choice");
        let turn = constrain_request(json!({"method":"turn/start","params":{"threadId":"thread-1","input":[],"sandboxPolicy":{"type":"dangerFullAccess"}}}), Path::new("C:/assistant")).unwrap();
        assert!(turn["params"].get("sandboxPolicy").is_none());
    }

    #[test]
    fn rejects_relative_executable_paths() {
        assert!(find_codex(Some("relative/codex.exe")).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn resolves_npm_shims_to_native_binary_even_with_spaces() {
        let temporary = env::temp_dir();
        let root = temporary.join(format!(
            "superdoc codex test {} {}",
            std::process::id(),
            NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let shim = root.join("codex.cmd");
        fs::write(&shim, "this shim must never be executed").unwrap();
        let binary = root.join("node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
        fs::create_dir_all(binary.parent().unwrap()).unwrap();
        fs::write(&binary, []).unwrap();
        assert_eq!(native_from_candidate(&shim), Some(binary.clone()));
        assert_eq!(find_codex(shim.to_str()).unwrap(), binary);
        assert_eq!(root.parent(), Some(temporary.as_path()));
        fs::remove_dir_all(root).unwrap();
    }
}
