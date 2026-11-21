mod claude;
mod codex;
mod commands;
mod gateway;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

struct StartupState {
    smoke_test: bool,
    ready: AtomicBool,
}

#[tauri::command]
fn startup_ready(window: tauri::WebviewWindow, state: tauri::State<'_, StartupState>) {
    if window.label() == "main" && !state.ready.swap(true, Ordering::Relaxed) && state.smoke_test {
        println!("SUPERDOC_DESKTOP_READY");
    }
}

fn report_startup_failure(app: &tauri::App, error: &str) {
    // Startup only: never include document text, provider requests, credentials or environment.
    let detail: String = error.chars().take(4096).collect();
    eprintln!("SuperDoc Desktop startup failed: {detail}");
    let log_path = app.path().app_log_dir().ok().and_then(|directory| {
        std::fs::create_dir_all(&directory).ok()?;
        let path = directory.join("startup-error.log");
        std::fs::write(
            &path,
            format!("SuperDoc Desktop {}\n{detail}\n", env!("CARGO_PKG_VERSION")),
        )
        .ok()?;
        Some(path)
    });
    if !app.state::<StartupState>().smoke_test {
        let log_hint = log_path
            .map(|path| format!("\n\n诊断日志 / Diagnostic log:\n{}", path.display()))
            .unwrap_or_default();
        app.dialog()
            .message(format!("无法创建编辑器窗口，请保留以下错误信息。\nThe editor window could not be created.\n\n{detail}{log_hint}"))
            .title("SuperDoc Desktop — 启动失败 / Startup failed")
            .kind(MessageDialogKind::Error)
            .blocking_show();
    }
}

#[cfg(windows)]
fn create_webview_environment(
    app: &tauri::App,
) -> Result<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment, String> {
    use webview2_com::{
        CreateCoreWebView2EnvironmentCompletedHandler,
        Microsoft::Web::WebView2::Win32::{
            CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2EnvironmentOptions,
        },
    };
    use windows::{
        core::{HSTRING, PCWSTR},
        Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED},
    };

    // This precedes Tao's first native window, so initialize its main-thread apartment explicitly.
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|error| format!("WebView2 COM initialization: {error}"))?;
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    let directory = HSTRING::from(directory.as_path());
    let (sender, receiver) = std::sync::mpsc::channel();
    // Use Microsoft's standard options, preserving browser protections and system language.
    // Wry receives this environment instead of creating one with its own browser arguments.
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            &directory,
            None::<&ICoreWebView2EnvironmentOptions>,
            &CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
                move |result, environment| {
                    let result = result
                        .map_err(|error| format!("WebView2 environment initialization: {error}"))
                        .and_then(|_| {
                            environment.ok_or_else(|| {
                                "WebView2 returned no browser environment.".to_string()
                            })
                        });
                    let _ = sender.send(result);
                    Ok(())
                },
            )),
        )
    }
    .map_err(|error| format!("WebView2 environment creation: {error}"))?;
    webview2_com::wait_with_pump(receiver)
        .map_err(|error| format!("WebView2 environment completion: {error}"))?
}

fn create_main_window(app: &tauri::App) -> Result<(), String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or_else(|| "The main window configuration is missing.".to_string())?;
    let builder =
        tauri::WebviewWindowBuilder::from_config(app, config).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let builder = builder.with_environment(create_webview_environment(app)?);
    builder
        .build()
        .map_err(|error| format!("Editor window initialization: {error}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(StartupState {
            smoke_test: std::env::args_os().any(|arg| arg == "--startup-smoke-test"),
            ready: AtomicBool::new(false),
        })
        .manage(codex::CodexState::default())
        .manage(claude::ClaudeState::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Do not let Tauri's automatic window creation turn a recoverable error into a silent panic.
            if let Err(error) = create_main_window(app) {
                report_startup_failure(app, &error);
                app.exit(1);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_ready,
            commands::read_file,
            commands::write_file,
            commands::file_metadata,
            gateway::chat_completion,
            gateway::anthropic_message,
            gateway::list_models,
            gateway::cancel_model_request,
            codex::codex_start,
            codex::codex_send,
            codex::codex_stop,
            claude::claude_start,
            claude::claude_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building SuperDoc Desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<codex::CodexState>().stop();
                app.state::<claude::ClaudeState>().stop();
            }
        });
}
