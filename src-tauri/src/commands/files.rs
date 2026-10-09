use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::domain::media::MediaInfo;

use super::queue::{normalize_selected_path, BackendState};
use super::CommandError;

#[tauri::command]
pub async fn select_files(
    app: AppHandle,
    state: State<'_, BackendState>,
) -> Result<Vec<String>, CommandError> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app
        .dialog()
        .file()
        .set_title("Select media files")
        .add_filter(
            "Media files",
            &[
                "mp4", "mov", "mkv", "webm", "avi", "mp3", "m4a", "wav", "flac", "ogg",
            ],
        )
        .pick_files(move |selected| {
            let _ = sender.try_send(selected);
        });
    let selected = receiver
        .recv()
        .await
        .ok_or_else(|| CommandError::new("file_picker_failed", "The file picker did not return a result"))?
        .unwrap_or_default();

    let mut paths = Vec::with_capacity(selected.len());
    for selected_path in selected {
        let path = PathBuf::try_from(selected_path).map_err(|error| {
            CommandError::with_details(
                "invalid_selected_path",
                "The native picker returned an invalid path",
                error.to_string(),
            )
        })?;
        let normalized = normalize_selected_path(&path.to_string_lossy())?;
        if !paths.contains(&normalized) {
            state.remember_selected_path(normalized.clone());
            paths.push(normalized);
        }
    }

    Ok(paths
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
pub async fn select_output_folder(
    app: AppHandle,
    state: State<'_, BackendState>,
) -> Result<Option<String>, CommandError> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app
        .dialog()
        .file()
        .set_title("Select output folder")
        .pick_folder(move |selected| {
            let _ = sender.try_send(selected);
        });
    let selected = receiver
        .recv()
        .await
        .ok_or_else(|| CommandError::new("folder_picker_failed", "The folder picker did not return a result"))?;
    let Some(selected_path) = selected else {
        return Ok(None);
    };
    let path = PathBuf::try_from(selected_path).map_err(|error| {
        CommandError::with_details(
            "invalid_output_directory",
            "The native picker returned an invalid output folder",
            error.to_string(),
        )
    })?;
    let normalized = super::queue::normalize_existing_directory(&path.to_string_lossy())?;
    state.remember_output_directory(normalized.clone());
    Ok(Some(normalized.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn analyze_files(
    state: State<'_, BackendState>,
    paths: Vec<String>,
) -> Result<Vec<MediaInfo>, CommandError> {
    paths
        .into_iter()
        .map(|path| state.probe_selected_path(&path))
        .collect()
}

#[tauri::command]
pub fn consume_dropped_paths(
    state: State<'_, BackendState>,
    paths: Vec<String>,
) -> Vec<String> {
    state.consume_trusted_dropped_paths(&paths)
}

#[tauri::command]
pub fn open_output_folder(
    state: State<'_, BackendState>,
    path: String,
) -> Result<(), CommandError> {
    let _command_lock = state
        .command_lock
        .lock()
        .expect("command lock should succeed");
    let folder = registered_output_folder(&state, &path)?;
    open_folder(&folder)
}

fn registered_output_folder(state: &BackendState, path: &str) -> Result<PathBuf, CommandError> {
    let normalized = normalize_path_for_lookup(path)?;
    if !state.is_registered_output_path(&normalized) {
        return Err(CommandError::new(
            "output_path_not_registered",
            "The output path was not created by a validated queue job",
        ));
    }

    let folder = normalized.parent().ok_or_else(|| {
        CommandError::new(
            "invalid_output_path",
            "The output path has no containing folder",
        )
    })?;
    if !state.is_registered_output_directory(folder) {
        return Err(CommandError::new(
            "output_directory_not_registered",
            "The output directory must be selected through the native folder picker first",
        ));
    }
    if !folder.is_dir() {
        return Err(CommandError::new(
            "output_directory_not_found",
            "The output folder does not exist",
        ));
    }
    Ok(folder.to_owned())
}

fn normalize_path_for_lookup(raw_path: &str) -> Result<PathBuf, CommandError> {
    let raw_path = raw_path.trim();
    if raw_path.is_empty() {
        return Err(CommandError::new(
            "invalid_output_path",
            "The output path must not be empty",
        ));
    }
    let path = Path::new(raw_path);
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|error| {
                CommandError::with_details(
                    "path_normalization_failed",
                    "Could not resolve the output path",
                    error.to_string(),
                )
            })?
            .join(path)
    };
    Ok(lexical_normalize(&absolute))
}

#[cfg(test)]
mod picker_tests {
    #[test]
    fn native_pickers_are_async_and_do_not_use_blocking_dialogs() {
        let source = include_str!("files.rs");

        assert!(source.contains("pub async fn select_files"));
        assert!(source.contains("pub async fn select_output_folder"));
        assert!(!source.contains(&["blocking", "_pick_files"].concat()));
        assert!(!source.contains(&["blocking", "_pick_folder"].concat()));
    }
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => normalized.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            std::path::Component::Normal(value) => normalized.push(value),
        }
    }
    normalized
}

fn open_folder(folder: &Path) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(folder);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(folder);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(folder);
        command
    };

    command.spawn().map_err(|error| {
        CommandError::with_details(
            "output_folder_open_failed",
            "Could not open the output folder",
            error.to_string(),
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{registered_output_folder, BackendState};

    #[test]
    fn rejects_renderer_only_output_paths_before_opening_any_folder() {
        let state = BackendState::new();

        let error = registered_output_folder(&state, "/tmp/renderer-only/clip.flac")
            .expect_err("renderer-only output paths must not be opened");

        assert_eq!(error.code, "output_path_not_registered");
    }
}
