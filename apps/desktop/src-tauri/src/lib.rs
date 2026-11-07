mod codex;
mod commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(codex::CodexState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::file_metadata,
            commands::chat_completion,
            codex::codex_start,
            codex::codex_send,
            codex::codex_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building SuperDoc Desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<codex::CodexState>().stop();
            }
        });
}
