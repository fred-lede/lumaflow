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
            commands::files::select_output_folder,
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

#[cfg(test)]
mod tests {
    use serde_json::Value;

    #[test]
    fn registers_task5_commands_and_keeps_capabilities_least_privilege() {
        let source = include_str!("lib.rs");
        for command in [
            "commands::files::select_files",
            "commands::files::select_output_folder",
            "commands::files::analyze_files",
            "commands::files::open_output_folder",
            "commands::queue::enqueue_jobs",
            "commands::queue::pause_all",
            "commands::queue::resume_all",
            "commands::queue::cancel_job",
            "commands::queue::retry_job",
            "commands::queue::clear_completed",
        ] {
            assert!(source.contains(command), "missing handler registration: {command}");
        }

        let capabilities: Value = serde_json::from_str(include_str!(
            "../capabilities/default.json"
        ))
        .expect("default capabilities should be valid JSON");
        let permissions = capabilities["permissions"]
            .as_array()
            .expect("capabilities should contain permissions");
        assert_eq!(
            permissions,
            &[
                Value::String("core:event:default".to_owned()),
                Value::String("dialog:allow-open".to_owned()),
            ]
        );
        assert!(permissions.iter().all(|permission| {
            permission
                .as_str()
                .is_some_and(|name| !name.starts_with("fs:") && !name.starts_with("shell:"))
        }));
    }
}
