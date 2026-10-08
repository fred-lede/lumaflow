use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use tauri::State;

use crate::domain::job::{EnqueueJobRequest, JobState, QueueJob, QueueSnapshot};
use crate::jobs::{FfmpegRunner, JobExecution, Scheduler, SchedulerError};
use crate::media::planner::plan_conversion;

use super::CommandError;

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

pub struct BackendState {
    pub(crate) scheduler: Scheduler,
    pub(crate) selected_paths: Mutex<HashSet<PathBuf>>,
    pub(crate) output_paths: Mutex<HashSet<PathBuf>>,
}

impl BackendState {
    pub fn new() -> Self {
        Self {
            scheduler: Scheduler::with_default_concurrency(Arc::new(FfmpegRunner::system())),
            selected_paths: Mutex::new(HashSet::new()),
            output_paths: Mutex::new(HashSet::new()),
        }
    }

    pub(crate) fn remember_selected_path(&self, path: PathBuf) {
        self.selected_paths
            .lock()
            .expect("selected path lock should succeed")
            .insert(path);
    }

    pub(crate) fn require_selected_path(&self, raw_path: &str) -> Result<PathBuf, CommandError> {
        let path = normalize_selected_path(raw_path)?;
        if self
            .selected_paths
            .lock()
            .expect("selected path lock should succeed")
            .contains(&path)
        {
            Ok(path)
        } else {
            Err(CommandError::new(
                "path_not_selected",
                "The path must be selected through the native file picker first",
            ))
        }
    }

    pub(crate) fn remember_output_path(&self, path: PathBuf) {
        self.output_paths
            .lock()
            .expect("output path lock should succeed")
            .insert(path);
    }

    pub(crate) fn is_registered_output_path(&self, path: &Path) -> bool {
        self.output_paths
            .lock()
            .expect("output path lock should succeed")
            .contains(path)
    }
}

impl Default for BackendState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub fn enqueue_jobs(
    state: State<'_, BackendState>,
    jobs: Vec<EnqueueJobRequest>,
) -> Result<QueueSnapshot, CommandError> {
    let mut executions = Vec::with_capacity(jobs.len());

    for request in jobs {
        let source_path = state.require_selected_path(&request.source_path)?;
        let media_path = state.require_selected_path(&request.media.path)?;
        if media_path != source_path {
            return Err(CommandError::new(
                "source_path_mismatch",
                "The analyzed media path does not match the selected source path",
            ));
        }

        let output_directory =
            normalize_existing_directory(&request.output_settings.output_directory)?;
        let mut media = request.media;
        media.path = source_path.to_string_lossy().into_owned();
        let mut output_settings = request.output_settings;
        output_settings.output_directory = output_directory.to_string_lossy().into_owned();
        let plan = plan_conversion(&media, &output_settings).map_err(CommandError::from)?;
        validate_output_extension(&plan.output_path)?;

        let job_id = format!("job-{}", NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed));
        executions.push(JobExecution {
            job: QueueJob {
                id: job_id,
                source_path: media.path.clone(),
                media,
                output_settings,
                processing_kind: None,
                state: JobState::Queued {
                    label: "Queued".to_owned(),
                },
                progress: 0.0,
                output_path: None,
            },
            plan,
        });
    }

    for execution in executions {
        let output_path = execution.plan.output_path.clone();
        state
            .scheduler
            .enqueue(execution)
            .map_err(command_error_from_scheduler)?;
        state.remember_output_path(output_path);
    }

    Ok(state.scheduler.snapshot())
}

#[tauri::command]
pub fn pause_all(state: State<'_, BackendState>) -> Result<QueueSnapshot, CommandError> {
    state
        .scheduler
        .pause()
        .map_err(command_error_from_scheduler)?;
    Ok(state.scheduler.snapshot())
}

#[tauri::command]
pub fn resume_all(state: State<'_, BackendState>) -> Result<QueueSnapshot, CommandError> {
    state
        .scheduler
        .resume()
        .map_err(command_error_from_scheduler)?;
    Ok(state.scheduler.snapshot())
}

#[tauri::command]
pub fn cancel_job(
    state: State<'_, BackendState>,
    job_id: String,
) -> Result<QueueSnapshot, CommandError> {
    state
        .scheduler
        .cancel(&job_id)
        .map_err(command_error_from_scheduler)?;
    Ok(state.scheduler.snapshot())
}

#[tauri::command]
pub fn retry_job(
    state: State<'_, BackendState>,
    job_id: String,
) -> Result<QueueSnapshot, CommandError> {
    state
        .scheduler
        .retry(&job_id)
        .map_err(command_error_from_scheduler)?;
    Ok(state.scheduler.snapshot())
}

#[tauri::command]
pub fn clear_completed(
    state: State<'_, BackendState>,
) -> Result<QueueSnapshot, CommandError> {
    state.scheduler.clear_completed();
    Ok(state.scheduler.snapshot())
}

pub(crate) fn command_error_from_scheduler(error: SchedulerError) -> CommandError {
    CommandError::new(error.code(), scheduler_message(error))
}

fn scheduler_message(error: SchedulerError) -> &'static str {
    match error {
        SchedulerError::DuplicateJob => "The job is already in the queue",
        SchedulerError::DestinationConflict => "Another queue job already uses this destination",
        SchedulerError::JobNotFound => "The queue job was not found",
        SchedulerError::InvalidState => "The queue job is not in a valid state for this action",
        SchedulerError::InvalidConcurrency => "The queue concurrency setting is invalid",
        SchedulerError::CancellationRejected => "The running job can no longer be cancelled",
    }
}

pub(crate) fn normalize_selected_path(raw_path: &str) -> Result<PathBuf, CommandError> {
    let raw_path = raw_path.trim();
    if raw_path.is_empty() {
        return Err(CommandError::new(
            "invalid_path",
            "The selected path must not be empty",
        ));
    }

    let absolute = absolute_path(Path::new(raw_path))?;
    let normalized = fs::canonicalize(&absolute).map_err(|error| {
        CommandError::with_details(
            "path_not_found",
            "The selected path does not exist",
            error.to_string(),
        )
    })?;
    let metadata = fs::metadata(&normalized).map_err(|error| {
        CommandError::with_details(
            "path_not_found",
            "The selected path is not accessible",
            error.to_string(),
        )
    })?;
    if !metadata.is_file() {
        return Err(CommandError::new(
            "path_not_file",
            "The selected path must be a file",
        ));
    }
    Ok(normalized)
}

pub(crate) fn normalize_existing_directory(raw_path: &str) -> Result<PathBuf, CommandError> {
    let raw_path = raw_path.trim();
    if raw_path.is_empty() {
        return Err(CommandError::new(
            "invalid_output_directory",
            "The output directory must not be empty",
        ));
    }
    let absolute = absolute_path(Path::new(raw_path))?;
    let normalized = fs::canonicalize(&absolute).map_err(|error| {
        CommandError::with_details(
            "output_directory_not_found",
            "The output directory does not exist",
            error.to_string(),
        )
    })?;
    let metadata = fs::metadata(&normalized).map_err(|error| {
        CommandError::with_details(
            "output_directory_not_found",
            "The output directory is not accessible",
            error.to_string(),
        )
    })?;
    if !metadata.is_dir() {
        return Err(CommandError::new(
            "output_directory_not_directory",
            "The output path must be a directory",
        ));
    }
    Ok(normalized)
}

fn absolute_path(path: &Path) -> Result<PathBuf, CommandError> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|error| {
                CommandError::with_details(
                    "path_normalization_failed",
                    "Could not resolve the selected path",
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
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    normalized
}

pub(crate) fn validate_output_extension(path: &Path) -> Result<(), CommandError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    let supported = matches!(
        extension.as_deref(),
        Some("mp4")
            | Some("mov")
            | Some("mkv")
            | Some("webm")
            | Some("avi")
            | Some("mp3")
            | Some("m4a")
            | Some("wav")
            | Some("flac")
            | Some("ogg")
    );
    if supported {
        Ok(())
    } else {
        Err(CommandError::new(
            "unsupported_output_extension",
            "The output file extension is not supported",
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::jobs::SchedulerError;

    use super::{command_error_from_scheduler, normalize_selected_path, validate_output_extension};

    fn temporary_file() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("lumaflow-command-test-{unique}"));
        fs::create_dir_all(&directory).expect("test directory should be created");
        let file = directory.join("clip.wav");
        fs::write(&file, b"fixture").expect("test file should be written");
        file
    }

    #[test]
    fn normalizes_selected_paths_to_existing_canonical_files() {
        let file = temporary_file();
        let selected = file
            .parent()
            .expect("fixture should have a parent")
            .join("nested")
            .join("..")
            .join(file.file_name().expect("fixture should have a name"));

        let normalized = normalize_selected_path(&selected.to_string_lossy())
            .expect("existing selected path should normalize");

        assert_eq!(
            normalized,
            fs::canonicalize(&file).expect("fixture should canonicalize")
        );
        let _ = fs::remove_dir_all(file.parent().expect("fixture should have a parent"));
    }

    #[test]
    fn rejects_unsupported_output_extensions_with_a_stable_code() {
        let error = validate_output_extension(Path::new("/output/clip.exe"))
            .expect_err("executable output should not be accepted");

        assert_eq!(error.code, "unsupported_output_extension");
    }

    #[test]
    fn maps_scheduler_failures_to_stable_command_error_codes() {
        let cases = [
            (SchedulerError::DuplicateJob, "duplicate_job"),
            (SchedulerError::DestinationConflict, "destination_conflict"),
            (SchedulerError::JobNotFound, "job_not_found"),
            (SchedulerError::InvalidState, "invalid_state"),
            (SchedulerError::InvalidConcurrency, "invalid_concurrency"),
            (SchedulerError::CancellationRejected, "cancellation_rejected"),
        ];

        for (scheduler_error, expected_code) in cases {
            assert_eq!(command_error_from_scheduler(scheduler_error).code, expected_code);
        }
    }
}
