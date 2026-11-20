//! Fixed-installation Claude Code bridge: proposals only, no model tools.
//! Safe mode retains organization-managed policies and managed-plugin hooks;
//! it is not an OS sandbox or a guarantee of no host-side commands/disk writes.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager, State};

// Leave room for the frontend's 120k-character source, JSON escaping and scaffold.
const MAX_PROMPT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS: usize = 4;
const DEFAULT_TIME_LIMIT_MS: u64 = 300_000;
const MAX_TIME_LIMIT_MS: u64 = 900_000;
const AUTH_TIME_LIMIT_MS: u64 = 30_000;
const CANCELLED: &str = "The Claude Code request was cancelled.";
const INVALID_OUTPUT: &str =
    "Claude Code returned an invalid structured result. No suggestions were added.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeRequest {
    request_id: String,
    model: Option<String>,
    prompt: Option<String>,
    time_limit_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeOutput {
    summary: String,
    suggestions: Vec<ClaudeSuggestion>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ClaudeSuggestion {
    action: ClaudeAction,
    find: String,
    text: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ClaudeAction {
    ReplaceText,
    AddComment,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClaudeEvent {
    #[serde(rename_all = "camelCase")]
    Checked {
        executable: String,
        signed_in: bool,
    },
    Result {
        output: ClaudeOutput,
    },
    Error {
        message: String,
    },
}

#[derive(Default)]
struct RunningProcess {
    child: Mutex<Option<Child>>,
    cancelled: AtomicBool,
}

impl RunningProcess {
    fn attach(&self, mut child: Child) -> Result<(), String> {
        let mut slot = match self.child.lock() {
            Ok(slot) => slot,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Claude Code process is unavailable.".into());
            }
        };
        if self.cancelled.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLED.into());
        }
        *slot = Some(child);
        Ok(())
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut slot) = self.child.lock() {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
            }
        }
    }

    fn terminate(&self) {
        // Recover poisoned ownership so a panic cannot leave a child running.
        let mut slot = self.child.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn status(&self) -> Result<Option<ExitStatus>, String> {
        self.child
            .lock()
            .map_err(|_| "Claude Code process is unavailable.")?
            .as_mut()
            .ok_or_else(|| "Claude Code process is unavailable.".to_string())?
            .try_wait()
            .map_err(|_| "Could not read the Claude Code process status.".into())
    }
}

impl Drop for RunningProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[derive(Default)]
struct Registry {
    requests: HashMap<String, Arc<RunningProcess>>,
    stopped: bool,
}

#[derive(Clone, Default)]
pub struct ClaudeState(Arc<Mutex<Registry>>);

impl ClaudeState {
    fn reserve(&self, id: &str) -> Result<Registration, String> {
        let mut registry = self
            .0
            .lock()
            .map_err(|_| "Claude Code registry is unavailable.")?;
        if registry.stopped {
            return Err("Claude Code is shutting down.".into());
        }
        if registry.requests.contains_key(id) {
            return Err("A Claude Code request with this id is already running.".into());
        }
        if registry.requests.len() >= MAX_ACTIVE_REQUESTS {
            return Err("Too many Claude Code requests are running. Stop one and retry.".into());
        }
        let process = Arc::new(RunningProcess::default());
        registry.requests.insert(id.to_string(), process.clone());
        Ok(Registration {
            state: self.clone(),
            id: id.to_string(),
            process,
        })
    }

    fn cancel(&self, id: &str) {
        let process = self
            .0
            .lock()
            .ok()
            .and_then(|registry| registry.requests.get(id).cloned());
        if let Some(process) = process {
            process.cancel();
        }
    }

    pub fn stop(&self) {
        let processes = {
            let mut registry = self.0.lock().unwrap_or_else(|error| error.into_inner());
            registry.stopped = true;
            registry.requests.values().cloned().collect::<Vec<_>>()
        };
        for process in processes {
            process.cancel();
            process.terminate();
        }
    }
}

struct Registration {
    state: ClaudeState,
    id: String,
    process: Arc<RunningProcess>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.process.terminate();
        if let Ok(mut registry) = self.state.0.lock() {
            if registry
                .requests
                .get(&self.id)
                .is_some_and(|slot| Arc::ptr_eq(slot, &self.process))
            {
                registry.requests.remove(&self.id);
            }
        }
    }
}

fn validate_request(request: &ClaudeRequest) -> Result<Option<String>, String> {
    let id = &request.request_id;
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("The Claude Code request id is invalid.".into());
    }
    if let Some(prompt) = &request.prompt {
        if prompt.trim().is_empty() || prompt.len() > MAX_PROMPT_BYTES {
            return Err("The Claude Code prompt is empty or too large.".into());
        }
    }
    let model = request.model.as_deref().unwrap_or("").trim();
    if model.is_empty() {
        return Ok(None);
    }
    if model.len() > 200
        || !model.as_bytes()[0].is_ascii_alphanumeric()
        || !model.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/' | b'@' | b'+')
        })
    {
        return Err("The Claude Code model name is invalid.".into());
    }
    Ok(Some(model.to_string()))
}

fn time_limit(request: &ClaudeRequest) -> Duration {
    let limit = request
        .time_limit_ms
        .unwrap_or(DEFAULT_TIME_LIMIT_MS)
        .clamp(1000, MAX_TIME_LIMIT_MS);
    Duration::from_millis(if request.prompt.is_some() {
        limit
    } else {
        limit.min(AUTH_TIME_LIMIT_MS)
    })
}

fn installation_path(home: &Path) -> Result<PathBuf, String> {
    if !home.is_absolute() {
        return Err("Could not locate the native Claude Code installation.".into());
    }
    Ok(home.join(".local/bin").join(if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    }))
}

fn native_header(header: &[u8]) -> bool {
    if cfg!(windows) {
        return header.starts_with(b"MZ");
    }
    matches!(
        header,
        [0x7f, b'E', b'L', b'F']
            | [0xfe, 0xed, 0xfa, 0xce]
            | [0xfe, 0xed, 0xfa, 0xcf]
            | [0xce, 0xfa, 0xed, 0xfe]
            | [0xcf, 0xfa, 0xed, 0xfe]
            | [0xca, 0xfe, 0xba, 0xbe]
            | [0xbe, 0xba, 0xfe, 0xca]
    )
}

fn find_claude() -> Result<PathBuf, String> {
    // Never consult PATH, CWD, a shell, npm shims or a caller-selected executable.
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or("Could not locate the native Claude Code installation.")?;
    let binary = installation_path(Path::new(&home))?;
    let missing = "Native Claude Code was not found in your home .local/bin directory. Install or update Claude Code with its native installer.";
    let mut file = fs::File::open(&binary).map_err(|_| missing)?;
    let mut header = [0; 4];
    file.read_exact(&mut header).map_err(|_| missing)?;
    if !native_header(&header) {
        return Err(missing.into());
    }
    Ok(binary)
}

fn output_schema() -> String {
    json!({
        "type": "object", "additionalProperties": false, "required": ["summary", "suggestions"],
        "properties": {
            "summary": {"type": "string", "minLength": 1, "maxLength": 16000},
            "suggestions": {"type": "array", "maxItems": 16, "items": {
                "type": "object", "additionalProperties": false, "required": ["action", "find", "text"],
                "properties": {
                    "action": {"type": "string", "enum": ["replace_text", "add_comment"]},
                    "find": {"type": "string", "minLength": 1, "maxLength": 12000},
                    "text": {"type": "string", "maxLength": 16000}
                }
            }}
        }
    }).to_string()
}

fn cli_args(generation: bool, model: Option<&str>) -> Vec<String> {
    if !generation {
        return ["--safe-mode", "auth", "status", "--json"]
            .map(str::to_string)
            .to_vec();
    }
    let mut args = [
        "--safe-mode",
        "--print",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        "{\"mcpServers\":{}}",
        "--no-chrome",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--permission-mode",
        "dontAsk",
        "--json-schema",
    ]
    .map(str::to_string)
    .to_vec();
    args.push(output_schema());
    if let Some(model) = model {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    args
}

fn cli_command(binary: &Path, cwd: &Path, generation: bool, model: Option<&str>) -> Command {
    let mut command = Command::new(binary);
    command
        .args(cli_args(generation, model))
        // Parent-host identity is not a permission or policy setting. This is an
        // independent, explicitly requested CLI child, not a nested Code agent.
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn read_bounded(reader: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_OUTPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read the Claude Code response.")?;
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err("The Claude Code response is too large.".into());
    }
    Ok(bytes)
}

fn parse_output(bytes: &[u8], success: bool) -> Result<ClaudeOutput, String> {
    if !success {
        return Err("Claude Code failed. Check its sign-in, update the CLI, and verify the selected model is available.".into());
    }
    let wrapper: Value = serde_json::from_slice(bytes).map_err(|_| INVALID_OUTPUT)?;
    if wrapper.get("type").and_then(Value::as_str) != Some("result")
        || wrapper.get("subtype").and_then(Value::as_str) != Some("success")
        || wrapper.get("is_error").and_then(Value::as_bool) != Some(false)
    {
        return Err(INVALID_OUTPUT.into());
    }
    // Never fall back to free-text result, tool transcripts, or arbitrary JSON.
    let output: ClaudeOutput = serde_json::from_value(
        wrapper
            .get("structured_output")
            .cloned()
            .ok_or(INVALID_OUTPUT)?,
    )
    .map_err(|_| INVALID_OUTPUT)?;
    let length = |text: &str| text.encode_utf16().count();
    if output.summary.trim().is_empty()
        || length(&output.summary) > 16000
        || output.suggestions.len() > 16
        || output.suggestions.iter().any(|item| {
            item.find.is_empty()
                || length(&item.find) > 12000
                || length(&item.text) > 16000
                || (item.action == ClaudeAction::AddComment && item.text.trim().is_empty())
        })
    {
        return Err(INVALID_OUTPUT.into());
    }
    Ok(output)
}

fn parse_auth(bytes: &[u8], success: bool) -> Result<bool, String> {
    let status: Value = serde_json::from_slice(bytes).map_err(|_| {
        "Claude Code returned an unreadable sign-in status. Update Claude Code and retry."
    })?;
    let signed_in = status.get("loggedIn").and_then(Value::as_bool).ok_or(
        "Claude Code returned an unreadable sign-in status. Update Claude Code and retry.",
    )?;
    // `auth status --json` exits nonzero for logged-out users; that is a check result.
    if signed_in && !success {
        return Err("Claude Code could not check its sign-in status.".into());
    }
    Ok(signed_in)
}

fn require_running(
    process: &RunningProcess,
    started: Instant,
    limit: Duration,
) -> Result<(), String> {
    if process.cancelled.load(Ordering::Acquire) {
        return Err(CANCELLED.into());
    }
    if started.elapsed() >= limit {
        return Err("Claude Code timed out. Select a shorter passage and retry.".into());
    }
    Ok(())
}

fn collect_process(
    process: &RunningProcess,
    mut stdin: ChildStdin,
    stdout: ChildStdout,
    prompt: Option<String>,
    started: Instant,
    limit: Duration,
) -> Result<(Vec<u8>, ExitStatus), String> {
    let (output_tx, output_rx) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("claude-output".into())
        .spawn(move || {
            let _ = output_tx.send(read_bounded(stdout));
        })
        .map_err(|_| "Could not start the Claude Code response reader.")?;
    let (input_tx, input_rx) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("claude-input".into())
        .spawn(move || {
            let result = match prompt {
                Some(prompt) => stdin
                    .write_all(prompt.as_bytes())
                    .and_then(|()| stdin.flush()),
                None => Ok(()),
            };
            drop(stdin); // EOF is required for --print; the prompt is never an argv value.
            let _ = input_tx.send(result.is_ok());
        })
        .map_err(|_| "Could not start the Claude Code prompt writer.")?;
    let mut output = None;
    loop {
        require_running(process, started, limit)?;
        if matches!(input_rx.try_recv(), Ok(false)) {
            return Err(
                "Claude Code could not accept the prompt. Update the CLI and check its sign-in."
                    .into(),
            );
        }
        if output.is_none() {
            match output_rx.try_recv() {
                Ok(bytes) => output = Some(bytes?),
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("Could not read the Claude Code response.".into())
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if let Some(status) = process.status()? {
            if let Some(output) = output.take() {
                return Ok((output, status));
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn start_request(
    app: &tauri::AppHandle,
    state: &ClaudeState,
    request: ClaudeRequest,
    on_event: Channel<ClaudeEvent>,
) -> Result<(), String> {
    let model = validate_request(&request)?;
    let limit = time_limit(&request);
    let binary = find_claude()?;
    let registration = state.reserve(&request.request_id)?;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Could not locate the assistant workspace.")?
        .join("claude-workspace");
    fs::create_dir_all(&root).map_err(|_| "Could not create the assistant workspace.")?;
    let directory = root.join(&request.request_id);
    // Do not reuse an existing directory, which may contain another run's files.
    fs::create_dir(&directory)
        .map_err(|_| "Could not create an isolated Claude Code workspace.")?;
    let workspace = Workspace(directory);
    if registration.process.cancelled.load(Ordering::Acquire) {
        return Err(CANCELLED.into());
    }
    let generation = request.prompt.is_some();
    let started = Instant::now();
    let mut child = cli_command(&binary, &workspace.0, generation, model.as_deref())
        .spawn()
        .map_err(|_| {
            "Could not start native Claude Code. Install or update it with its native installer."
        })?;
    let handles = (child.stdin.take(), child.stdout.take());
    let (Some(stdin), Some(stdout)) = handles else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Claude Code process pipes are unavailable.".into());
    };
    registration.process.attach(child)?;
    std::thread::Builder::new()
        .name("claude-request".into())
        .spawn(move || {
            let result = collect_process(
                &registration.process,
                stdin,
                stdout,
                request.prompt,
                started,
                limit,
            )
            .and_then(|(bytes, status)| {
                if generation {
                    parse_output(&bytes, status.success())
                        .map(|output| ClaudeEvent::Result { output })
                } else {
                    parse_auth(&bytes, status.success()).map(|signed_in| ClaudeEvent::Checked {
                        executable: binary.to_string_lossy().into_owned(),
                        signed_in,
                    })
                }
            });
            let result = if registration.process.cancelled.load(Ordering::Acquire) {
                Err(CANCELLED.into())
            } else {
                result
            };
            // Reap before delivering a terminal event (including timeouts and parser failures).
            drop(registration);
            drop(workspace);
            let event = result.unwrap_or_else(|message| ClaudeEvent::Error { message });
            let _ = on_event.send(event);
        })
        .map_err(|_| "Could not start the Claude Code request worker.")?;
    // This synchronous acknowledgement means the request is registered and its
    // child attached. The frontend repeats cancellation after this acknowledgement.
    Ok(())
}

#[tauri::command]
pub fn claude_start(
    app: tauri::AppHandle,
    state: State<'_, ClaudeState>,
    request: ClaudeRequest,
    on_event: Channel<ClaudeEvent>,
) -> Result<(), String> {
    match start_request(&app, state.inner(), request, on_event.clone()) {
        Ok(()) => Ok(()),
        Err(message) => {
            // The terminal event is authoritative: rejecting invoke as well can
            // race its delivery and replace this readable error with a generic one.
            // Never forward raw stderr, auth JSON, environment or OS errors.
            on_event
                .send(ClaudeEvent::Error { message })
                .map_err(|_| "Could not deliver the Claude Code startup status.".to_string())
        }
    }
}

#[tauri::command]
pub fn claude_cancel(state: State<'_, ClaudeState>, request_id: String) {
    state.cancel(&request_id);
}

struct Workspace(PathBuf);
impl Drop for Workspace {
    fn drop(&mut self) {
        // Never recursively remove files a managed policy hook may have created.
        let _ = fs::remove_dir(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn request() -> ClaudeRequest {
        ClaudeRequest {
            request_id: "test-1".into(),
            model: None,
            prompt: Some("Synthetic document text".into()),
            time_limit_ms: None,
        }
    }

    fn wrapper() -> Value {
        json!({"type":"result", "subtype":"success", "is_error":false,
            "structured_output":{"summary":"Proposed changes", "suggestions":[{"action":"replace_text","find":"before","text":"after"}]}})
    }

    fn parsed(value: Value) -> Result<ClaudeOutput, String> {
        parse_output(&serde_json::to_vec(&value).unwrap(), true)
    }

    #[test]
    fn rejects_caller_executables_and_arguments() {
        for field in ["executable", "args", "cwd", "apiKey"] {
            let mut input = json!({"requestId":"test"});
            input[field] = json!("untrusted");
            assert!(serde_json::from_value::<ClaudeRequest>(input).is_err());
        }
    }

    #[test]
    fn validates_ids_and_prevents_model_flag_injection() {
        for id in ["", "../other", "two words", "x/y", "\n"] {
            let mut input = request();
            input.request_id = id.into();
            assert!(validate_request(&input).is_err());
        }
        for model in [
            "--dangerously-skip-permissions",
            "opus --tools Bash",
            "\"opus\"",
            "opus\n--debug",
        ] {
            let mut input = request();
            input.model = Some(model.into());
            assert!(validate_request(&input).is_err());
        }
        let mut input = request();
        input.model = Some("magpie-1.anthropic.claude-opus-5-5".into());
        assert_eq!(validate_request(&input).unwrap(), input.model);
        input.model = Some(" ".into());
        assert_eq!(validate_request(&input).unwrap(), None);
    }

    #[test]
    fn bounds_prompts_without_rejecting_120k_multibyte_source() {
        let mut input = request();
        input.prompt = Some("文".repeat(120_000));
        assert!(validate_request(&input).is_ok());
        input.prompt = Some("a".repeat(MAX_PROMPT_BYTES));
        assert!(validate_request(&input).is_ok());
        input.prompt.as_mut().unwrap().push('a');
        assert!(validate_request(&input).is_err());
        input.prompt = Some(" \n ".into());
        assert!(validate_request(&input).is_err());
    }

    #[test]
    fn uses_only_absolute_standard_native_installation() {
        let home = env::temp_dir();
        assert_eq!(
            installation_path(&home).unwrap(),
            home.join(".local/bin").join(if cfg!(windows) {
                "claude.exe"
            } else {
                "claude"
            })
        );
        assert!(installation_path(Path::new("relative-home")).is_err());
        assert!(!native_header(b"#!/b"));
        assert!(!native_header(b"@ech"));
        assert!(native_header(if cfg!(windows) {
            b"MZ00"
        } else {
            b"\x7fELF"
        }));
    }

    #[test]
    fn fixes_generation_safety_flags_and_keeps_prompt_out_of_argv() {
        let input = request();
        let binary = installation_path(&env::temp_dir()).unwrap();
        let command = cli_command(&binary, &env::temp_dir(), true, Some("opus"));
        assert_eq!(command.get_program(), binary.as_os_str());
        assert_eq!(command.get_current_dir(), Some(env::temp_dir().as_path()));
        for name in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] {
            assert!(command
                .get_envs()
                .any(|(key, value)| key == std::ffi::OsStr::new(name) && value.is_none()));
        }
        let args: Vec<_> = command
            .get_args()
            .map(|value| value.to_str().unwrap())
            .collect();
        for flag in [
            "--safe-mode",
            "--print",
            "--strict-mcp-config",
            "--no-chrome",
            "--disable-slash-commands",
            "--no-session-persistence",
        ] {
            assert!(args.contains(&flag));
        }
        for (flag, value) in [
            ("--tools", ""),
            ("--mcp-config", "{\"mcpServers\":{}}"),
            ("--permission-mode", "dontAsk"),
            ("--output-format", "json"),
            ("--model", "opus"),
        ] {
            assert!(args.windows(2).any(|pair| pair == [flag, value]));
        }
        assert!(!args.iter().any(|arg| [
            "--bare",
            "--dangerously-skip-permissions",
            input.prompt.as_deref().unwrap()
        ]
        .contains(arg)));
        let schema: Value = serde_json::from_str(
            args[args.iter().position(|arg| *arg == "--json-schema").unwrap() + 1],
        )
        .unwrap();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["properties"]["suggestions"]["maxItems"], 16);
    }

    #[test]
    fn checks_auth_without_generation() {
        assert_eq!(
            cli_args(false, Some("opus")),
            ["--safe-mode", "auth", "status", "--json"]
        );
        assert!(!cli_args(true, None).contains(&"--model".to_string()));
        assert!(!parse_auth(
            br#"{"loggedIn":false,"email":"must-not-be-forwarded"}"#,
            false
        )
        .unwrap());
        assert!(parse_auth(br#"{"loggedIn":true}"#, true).unwrap());
        assert!(parse_auth(br#"{"loggedIn":true}"#, false).is_err());
        assert!(parse_auth(br#"{"loggedIn":"false"}"#, false).is_err());
        assert!(parse_auth(b"raw secret error", false)
            .unwrap_err()
            .contains("unreadable"));
        let event = serde_json::to_value(ClaudeEvent::Checked {
            executable: "fixed-native".into(),
            signed_in: false,
        })
        .unwrap();
        assert_eq!(
            event,
            json!({"type":"checked", "executable":"fixed-native", "signedIn":false})
        );
    }

    #[test]
    fn rejects_unstructured_failed_and_malformed_cli_results() {
        assert!(parsed(wrapper()).is_ok());
        for (field, value) in [
            ("type", json!("assistant")),
            ("subtype", json!("error_max_turns")),
            ("is_error", json!(true)),
            ("is_error", Value::Null),
        ] {
            let mut output = wrapper();
            output[field] = value;
            assert!(parsed(output).is_err());
        }
        let mut output = wrapper();
        output.as_object_mut().unwrap().remove("structured_output");
        output["result"] = json!("{\"summary\":\"not accepted\",\"suggestions\":[]}");
        assert!(parsed(output).is_err());
        assert!(parse_output(b"not JSON with secret", true).is_err());
        assert!(!parse_output(b"secret stderr", false)
            .unwrap_err()
            .contains("secret"));
    }

    #[test]
    fn validates_suggestion_schema_and_utf16_limits() {
        let mut output = wrapper();
        output["structured_output"]["suggestions"][0]["text"] = json!("");
        assert!(parsed(output.clone()).is_ok()); // deletion is a valid replacement
        output["structured_output"]["suggestions"][0]["action"] = json!("add_comment");
        assert!(parsed(output.clone()).is_err());
        output["structured_output"]["suggestions"][0]["action"] = json!("run_command");
        assert!(parsed(output).is_err());
        let mut output = wrapper();
        output["structured_output"]["summary"] = json!("a".repeat(16001));
        assert!(parsed(output).is_err());
        let mut output = wrapper();
        output["structured_output"]["suggestions"][0]["find"] = json!("𝄞".repeat(6001));
        assert!(parsed(output).is_err());
        let mut output = wrapper();
        output["structured_output"]["suggestions"] =
            json!(vec![
                output["structured_output"]["suggestions"][0].clone();
                17
            ]);
        assert!(parsed(output).is_err());
        let mut output = wrapper();
        output["structured_output"]["unexpected"] = json!("secret");
        assert!(parsed(output).is_err());
    }

    #[test]
    fn bounds_output_before_parsing() {
        assert_eq!(
            read_bounded(Cursor::new(vec![b'a'; MAX_OUTPUT_BYTES]))
                .unwrap()
                .len(),
            MAX_OUTPUT_BYTES
        );
        assert!(read_bounded(Cursor::new(vec![b'a'; MAX_OUTPUT_BYTES + 1])).is_err());
        assert!(parse_output(&[0xff], true).is_err());
    }

    #[test]
    fn clamps_native_deadlines_including_auth() {
        let mut input = request();
        assert_eq!(
            time_limit(&input),
            Duration::from_millis(DEFAULT_TIME_LIMIT_MS)
        );
        input.time_limit_ms = Some(u64::MAX);
        assert_eq!(time_limit(&input), Duration::from_millis(MAX_TIME_LIMIT_MS));
        input.prompt = None;
        assert_eq!(
            time_limit(&input),
            Duration::from_millis(AUTH_TIME_LIMIT_MS)
        );
        input.time_limit_ms = Some(0);
        assert_eq!(time_limit(&input), Duration::from_millis(1000));
        assert!(
            require_running(&RunningProcess::default(), Instant::now(), Duration::ZERO)
                .unwrap_err()
                .contains("timed out")
        );
    }

    #[test]
    fn cancellation_is_scoped_and_survives_startup() {
        let state = ClaudeState::default();
        let first = state.reserve("first").unwrap();
        let second = state.reserve("second").unwrap();
        state.cancel("missing");
        state.cancel("first");
        assert_eq!(
            require_running(&first.process, Instant::now(), Duration::from_secs(1)).unwrap_err(),
            CANCELLED
        );
        assert!(require_running(&second.process, Instant::now(), Duration::from_secs(1)).is_ok());
        // Cancellation of a reserved slot is remembered before any child attaches.
        assert!(first.process.cancelled.load(Ordering::Acquire));
        assert!(state.reserve("first").is_err());
        drop(first);
        assert!(state.reserve("first").is_ok());
    }

    #[test]
    fn bounds_concurrency_and_prevents_restart_after_exit() {
        let state = ClaudeState::default();
        let registrations: Vec<_> = (0..MAX_ACTIVE_REQUESTS)
            .map(|i| state.reserve(&i.to_string()).unwrap())
            .collect();
        assert!(state.reserve("overflow").is_err());
        state.stop();
        assert!(registrations
            .iter()
            .all(|registration| registration.process.cancelled.load(Ordering::Acquire)));
        assert!(state.reserve("after-exit").is_err());
        drop(registrations);
        assert!(state.0.lock().unwrap().requests.is_empty());
    }
}
