use std::sync::Arc;

use tauri::{Emitter, Manager};

pub mod commands;
pub mod domain;
pub mod jobs;
pub mod media;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(commands::queue::BackendState::new())
        .setup(|app| {
            let handle = app.handle().clone();
            app.state::<commands::queue::BackendState>()
                .scheduler
                .set_event_sink(Arc::new(move |event| {
                    let _ = handle.emit("job-event", event);
                }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::files::select_files,
            commands::files::analyze_files,
            commands::files::open_output_folder,
            commands::queue::enqueue_jobs,
            commands::queue::pause_all,
            commands::queue::resume_all,
            commands::queue::cancel_job,
            commands::queue::retry_job,
            commands::queue::clear_completed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LumaFlow");
}
