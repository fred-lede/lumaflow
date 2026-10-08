use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::domain::media::MediaInfo;
use crate::media::probe::{probe_media, ProcessCommandRunner};

use super::queue::{normalize_selected_path, BackendState};
use super::CommandError;

#[tauri::command]
pub fn select_files(
    app: AppHandle,
    state: State<'_, BackendState>,
) -> Result<Vec<String>, CommandError> {
    let selected = app
        .dialog()
        .file()
        .set_title("Select media files")
        .add_filter(
            "Media files",
            &[
                "mp4", "mov", "mkv", "webm", "avi", "mp3", "m4a", "wav", "flac", "ogg",
            ],
        )
        .blocking_pick_files()
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
pub fn analyze_files(
    state: State<'_, BackendState>,
    paths: Vec<String>,
) -> Result<Vec<MediaInfo>, CommandError> {
    let runner = ProcessCommandRunner;
    paths
        .into_iter()
        .map(|path| {
            let normalized = normalize_selected_path(&path)?;
            state.remember_selected_path(normalized.clone());
            probe_media(&runner, &normalized).map_err(CommandError::from)
        })
        .collect()
}

#[tauri::command]
pub fn open_output_folder(
    state: State<'_, BackendState>,
    path: String,
) -> Result<(), CommandError> {
    let normalized = normalize_path_for_lookup(&path)?;
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
    if !folder.is_dir() {
        return Err(CommandError::new(
            "output_directory_not_found",
            "The output folder does not exist",
        ));
    }
    open_folder(folder)
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
