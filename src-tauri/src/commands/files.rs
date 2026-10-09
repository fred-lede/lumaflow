use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager, State};
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

#[tauri::command]
pub fn allow_output_preview(
    app: AppHandle,
    state: State<'_, BackendState>,
    path: String,
) -> Result<String, CommandError> {
    let _command_lock = state
        .command_lock
        .lock()
        .expect("command lock should succeed");
    let normalized = registered_output_file(&state, &path)?;
    app.asset_protocol_scope()
        .allow_file(&normalized)
        .map_err(|error| {
            CommandError::with_details(
                "preview_scope_failed",
                "Could not authorize the output for preview",
                error.to_string(),
            )
        })?;
    Ok(normalized.to_string_lossy().into_owned())
}

fn registered_output_file(state: &BackendState, path: &str) -> Result<PathBuf, CommandError> {
    let normalized = normalize_path_for_lookup(path)?;
    if !state.is_registered_output_path(&normalized) {
        return Err(CommandError::new(
            "output_path_not_registered",
            "The output path was not created by a validated queue job",
        ));
    }
    if !state.is_registered_completed_output_path(&normalized) {
        return Err(CommandError::new(
            "output_not_completed",
            "The output path is not from a currently completed queue job",
        ));
    }

    let canonical = fs::canonicalize(&normalized).map_err(|error| {
        CommandError::with_details(
            "output_file_not_found",
            "The completed output file does not exist",
            error.to_string(),
        )
    })?;
    if canonical != normalized || !state.is_registered_output_path(&canonical) {
        return Err(CommandError::new(
            "output_path_changed",
            "The registered output path now resolves to a different file",
        ));
    }

    let metadata = fs::metadata(&canonical).map_err(|error| {
        CommandError::with_details(
            "output_file_not_found",
            "The completed output file is not accessible",
            error.to_string(),
        )
    })?;
    if !metadata.is_file() {
        return Err(CommandError::new(
            "output_file_not_found",
            "The completed output path is not a regular file",
        ));
    }
    Ok(canonical)
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
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::domain::job::{JobState, ProcessingKind, QueueJob};
    use crate::domain::media::{
        AudioStreamInfo, MediaInfo, OutputFormat, OutputSettings, QualityPreset,
    };
    use crate::jobs::{
        CancellationToken, EventSink, ExecutionOutcome, JobExecution, JobExecutor, Scheduler,
    };
    use crate::media::planner::ConversionPlan;

    use super::{registered_output_file, registered_output_folder, BackendState};

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    fn temporary_output_file() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        let sequence = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "lumaflow-preview-command-test-{}-{sequence}",
            unique
        ));
        fs::create_dir_all(&directory).expect("test directory should be created");
        let file = directory.join("clip.flac");
        fs::write(&file, b"fixture").expect("test file should be written");
        file
    }

    fn output_job(paused: bool) -> (BackendState, std::path::PathBuf) {
        let output_path =
            fs::canonicalize(temporary_output_file()).expect("test output should canonicalize");
        let probe = Arc::new(|_: &Path| {
            Ok::<_, crate::media::MediaError>(MediaInfo {
                path: "/input/source.wav".to_owned(),
                file_name: "source.wav".to_owned(),
                container: "wav".to_owned(),
                duration_seconds: 1.0,
                size_bytes: 1,
                source_quality: crate::domain::media::SourceQualityAssessment::unknown(),
                video_streams: vec![],
                audio_streams: vec![AudioStreamInfo {
                    codec: "pcm_s16le".to_owned(),
                    stream_index: 0,
                    sample_rate_hz: 44_100,
                    channels: 2,
                }],
                subtitle_streams: vec![],
            })
        });
        let state = BackendState::with_test_scheduler(
            Scheduler::new(Arc::new(ImmediateExecutor), 1),
            probe,
        );
        if paused {
            state
                .scheduler
                .pause()
                .expect("test scheduler should pause");
        }

        state.authorize_output_path("test-job", output_path.clone());
        state
            .scheduler
            .enqueue(JobExecution {
                job: QueueJob {
                    id: "test-job".to_owned(),
                    attempt: 0,
                    source_path: "/input/source.wav".to_owned(),
                    media: MediaInfo {
                        path: "/input/source.wav".to_owned(),
                        file_name: "source.wav".to_owned(),
                        container: "wav".to_owned(),
                        duration_seconds: 1.0,
                        size_bytes: 1,
                        source_quality: crate::domain::media::SourceQualityAssessment::unknown(),
                        video_streams: vec![],
                        audio_streams: vec![],
                        subtitle_streams: vec![],
                    },
                    output_settings: OutputSettings {
                        output_directory: output_path
                            .parent()
                            .expect("test output should have a parent")
                            .to_string_lossy()
                            .into_owned(),
                        format: OutputFormat::Flac,
                        quality: QualityPreset::Original,
                        lossless_first: true,
                        codec: None,
                        bitrate_kbps: None,
                        width: None,
                        height: None,
                        frame_rate: None,
                        sample_rate_hz: None,
                        channels: None,
                    },
                    processing_kind: None,
                    state: JobState::Queued {
                        label: "Queued".to_owned(),
                    },
                    progress: 0.0,
                    output_path: None,
                },
                plan: ConversionPlan {
                    processing_kind: ProcessingKind::LosslessAudio {
                        label: "Lossless audio".to_owned(),
                    },
                    output_path: output_path.clone(),
                    ffmpeg_args: vec![],
                },
            })
            .expect("test job should enqueue");
        if !paused {
            assert!(state
                .scheduler
                .wait_for_idle(std::time::Duration::from_secs(1)));
        }
        (state, output_path)
    }

    struct ImmediateExecutor;

    impl JobExecutor for ImmediateExecutor {
        fn execute(
            &self,
            _execution: JobExecution,
            _cancellation: CancellationToken,
            _emit: EventSink,
        ) -> Result<ExecutionOutcome, crate::domain::job::JobError> {
            Ok(ExecutionOutcome::default())
        }
    }

    #[test]
    fn rejects_renderer_only_output_paths_before_opening_any_folder() {
        let state = BackendState::new();

        let error = registered_output_folder(&state, "/tmp/renderer-only/clip.flac")
            .expect_err("renderer-only output paths must not be opened");

        assert_eq!(error.code, "output_path_not_registered");
    }

    #[test]
    fn rejects_unregistered_output_preview_paths() {
        let state = BackendState::new();

        let error = registered_output_file(&state, "/tmp/renderer-only/clip.flac")
            .expect_err("renderer-only output paths must not be authorized");

        assert_eq!(error.code, "output_path_not_registered");
    }

    #[test]
    fn accepts_registered_existing_output_preview_files() {
        let (state, output_path) = output_job(false);

        let normalized = registered_output_file(&state, &output_path.to_string_lossy())
            .expect("registered existing output files should be authorized");

        assert_eq!(normalized, output_path);
        let _ = fs::remove_dir_all(output_path.parent().expect("fixture should have a parent"));
    }

    #[test]
    fn rejects_registered_output_for_queued_job() {
        let (state, output_path) = output_job(true);

        let error = registered_output_file(&state, &output_path.to_string_lossy())
            .expect_err("queued output must not be authorized for preview");

        assert_eq!(error.code, "output_not_completed");
        let _ = fs::remove_dir_all(output_path.parent().expect("fixture should have a parent"));
    }

    #[test]
    fn rejects_reused_output_path_when_a_new_job_is_queued() {
        let (state, output_path) = output_job(false);
        state
            .scheduler
            .pause()
            .expect("test scheduler should pause");
        fs::remove_file(&output_path).expect("old output should be removable");
        state.authorize_output_path("new-job", output_path.clone());
        state
            .scheduler
            .enqueue(JobExecution {
                job: QueueJob {
                    id: "new-job".to_owned(),
                    attempt: 0,
                    source_path: "/input/new-source.wav".to_owned(),
                    media: MediaInfo {
                        path: "/input/new-source.wav".to_owned(),
                        file_name: "new-source.wav".to_owned(),
                        container: "wav".to_owned(),
                        duration_seconds: 1.0,
                        size_bytes: 1,
                        source_quality: crate::domain::media::SourceQualityAssessment::unknown(),
                        video_streams: vec![],
                        audio_streams: vec![],
                        subtitle_streams: vec![],
                    },
                    output_settings: OutputSettings {
                        output_directory: output_path
                            .parent()
                            .expect("test output should have a parent")
                            .to_string_lossy()
                            .into_owned(),
                        format: OutputFormat::Flac,
                        quality: QualityPreset::Original,
                        lossless_first: true,
                        codec: None,
                        bitrate_kbps: None,
                        width: None,
                        height: None,
                        frame_rate: None,
                        sample_rate_hz: None,
                        channels: None,
                    },
                    processing_kind: None,
                    state: JobState::Queued {
                        label: "Queued".to_owned(),
                    },
                    progress: 0.0,
                    output_path: None,
                },
                plan: ConversionPlan {
                    processing_kind: ProcessingKind::LosslessAudio {
                        label: "Lossless audio".to_owned(),
                    },
                    output_path: output_path.clone(),
                    ffmpeg_args: vec![],
                },
            })
            .expect("reused output path should be available after old output removal");
        fs::write(&output_path, b"replacement").expect("replacement output should be written");

        let error = registered_output_file(&state, &output_path.to_string_lossy())
            .expect_err("a queued replacement must not use the old completed authorization");

        assert_eq!(error.code, "output_not_completed");
        let _ = fs::remove_dir_all(output_path.parent().expect("fixture should have a parent"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_completed_output_replaced_by_symlink() {
        let (state, output_path) = output_job(false);
        let replacement = output_path
            .parent()
            .expect("fixture should have a parent")
            .join("replacement.flac");
        fs::write(&replacement, b"replacement").expect("replacement should be written");
        fs::remove_file(&output_path).expect("original output should be removable");
        std::os::unix::fs::symlink(&replacement, &output_path)
            .expect("replacement symlink should be created");

        let error = registered_output_file(&state, &output_path.to_string_lossy())
            .expect_err("replaced output paths must not be authorized for preview");

        assert_eq!(error.code, "output_path_changed");
        let _ = fs::remove_dir_all(output_path.parent().expect("fixture should have a parent"));
    }
}
