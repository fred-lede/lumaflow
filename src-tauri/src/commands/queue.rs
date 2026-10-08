use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use tauri::State;

use crate::domain::job::{EnqueueJobRequest, JobState, QueueJob, QueueSnapshot};
use crate::domain::media::MediaInfo;
use crate::jobs::{FfmpegRunner, JobExecution, Scheduler, SchedulerError};
use crate::media::planner::plan_conversion;
use crate::media::probe::{probe_media, ProcessCommandRunner};
use crate::media::MediaError;

use super::CommandError;

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

type ProbeService = Arc<dyn Fn(&Path) -> Result<MediaInfo, MediaError> + Send + Sync + 'static>;

pub struct BackendState {
    pub(crate) scheduler: Scheduler,
    pub(crate) selected_paths: Mutex<HashSet<PathBuf>>,
    pub(crate) selected_output_directories: Mutex<HashSet<PathBuf>>,
    pub(crate) authorized_output_paths: Mutex<HashMap<String, PathBuf>>,
    pub(crate) command_lock: Mutex<()>,
    probe: ProbeService,
}

impl BackendState {
    pub fn new() -> Self {
        Self::with_probe(Arc::new(|path| probe_media(&ProcessCommandRunner, path)))
    }

    pub(crate) fn with_probe(probe: ProbeService) -> Self {
        Self {
            scheduler: Scheduler::with_default_concurrency(Arc::new(FfmpegRunner::system())),
            selected_paths: Mutex::new(HashSet::new()),
            selected_output_directories: Mutex::new(HashSet::new()),
            authorized_output_paths: Mutex::new(HashMap::new()),
            command_lock: Mutex::new(()),
            probe,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_scheduler(scheduler: Scheduler, probe: ProbeService) -> Self {
        Self {
            scheduler,
            selected_paths: Mutex::new(HashSet::new()),
            selected_output_directories: Mutex::new(HashSet::new()),
            authorized_output_paths: Mutex::new(HashMap::new()),
            command_lock: Mutex::new(()),
            probe,
        }
    }

    pub(crate) fn remember_selected_path(&self, path: PathBuf) {
        self.selected_paths
            .lock()
            .expect("selected path lock should succeed")
            .insert(path);
    }

    pub(crate) fn register_trusted_dropped_paths(&self, paths: &[PathBuf]) -> Vec<String> {
        paths
            .iter()
            .filter_map(|path| normalize_selected_path(&path.to_string_lossy()).ok())
            .map(|path| {
                self.remember_selected_path(path.clone());
                path.to_string_lossy().into_owned()
            })
            .collect()
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

    pub(crate) fn probe_selected_path(&self, raw_path: &str) -> Result<MediaInfo, CommandError> {
        let path = self.require_selected_path(raw_path)?;
        (self.probe)(&path).map_err(CommandError::from)
    }

    pub(crate) fn remember_output_directory(&self, path: PathBuf) {
        self.selected_output_directories
            .lock()
            .expect("output directory lock should succeed")
            .insert(path);
    }

    pub(crate) fn require_registered_output_directory(
        &self,
        raw_path: &str,
    ) -> Result<PathBuf, CommandError> {
        let path = normalize_existing_directory(raw_path)?;
        if self
            .selected_output_directories
            .lock()
            .expect("output directory lock should succeed")
            .contains(&path)
        {
            Ok(path)
        } else {
            Err(CommandError::new(
                "output_directory_not_registered",
                "The output directory must be selected through the native folder picker first",
            ))
        }
    }

    pub(crate) fn authorize_output_path(&self, job_id: &str, path: PathBuf) {
        self.authorized_output_paths
            .lock()
            .expect("output path lock should succeed")
            .insert(job_id.to_owned(), path);
    }

    pub(crate) fn prune_output_authorizations(&self, job_ids: &[String]) {
        let mut paths = self
            .authorized_output_paths
            .lock()
            .expect("output path lock should succeed");
        for job_id in job_ids {
            paths.remove(job_id);
        }
    }

    pub(crate) fn is_registered_output_path(&self, path: &Path) -> bool {
        self.authorized_output_paths
            .lock()
            .expect("output path lock should succeed")
            .values()
            .any(|authorized| authorized == path)
    }

    pub(crate) fn is_registered_output_directory(&self, path: &Path) -> bool {
        self.selected_output_directories
            .lock()
            .expect("output directory lock should succeed")
            .contains(path)
    }

    #[cfg(test)]
    pub(crate) fn is_registered_output_job(&self, job_id: &str) -> bool {
        self.authorized_output_paths
            .lock()
            .expect("output path lock should succeed")
            .contains_key(job_id)
    }

    #[cfg(test)]
    pub(crate) fn authorized_output_paths_is_empty(&self) -> bool {
        self.authorized_output_paths
            .lock()
            .expect("output path lock should succeed")
            .is_empty()
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
    enqueue_jobs_inner(&state, jobs)
}

pub(crate) fn enqueue_jobs_inner(
    state: &BackendState,
    jobs: Vec<EnqueueJobRequest>,
) -> Result<QueueSnapshot, CommandError> {
    let _command_lock = state
        .command_lock
        .lock()
        .expect("command lock should succeed");
    let executions = preflight_jobs(state, jobs)?;
    let authorizations = executions
        .iter()
        .map(|execution| (execution.job.id.clone(), execution.plan.output_path.clone()))
        .collect::<Vec<_>>();
    for (job_id, output_path) in &authorizations {
        state.authorize_output_path(job_id, output_path.clone());
    }

    if let Err(error) = state.scheduler.enqueue_batch(executions) {
        state.prune_output_authorizations(
            &authorizations
                .into_iter()
                .map(|(job_id, _)| job_id)
                .collect::<Vec<_>>(),
        );
        return Err(command_error_from_scheduler(error));
    }

    Ok(state.scheduler.snapshot())
}

fn preflight_jobs(
    state: &BackendState,
    jobs: Vec<EnqueueJobRequest>,
) -> Result<Vec<JobExecution>, CommandError> {
    let mut executions = Vec::with_capacity(jobs.len());

    for request in jobs {
        let source_path = state.require_selected_path(&request.source_path)?;
        let output_directory =
            state.require_registered_output_directory(&request.output_settings.output_directory)?;
        let mut media = (state.probe)(&source_path).map_err(CommandError::from)?;
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

    Ok(executions)
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
    clear_completed_inner(&state)
}

pub(crate) fn clear_completed_inner(
    state: &BackendState,
) -> Result<QueueSnapshot, CommandError> {
    let _command_lock = state
        .command_lock
        .lock()
        .expect("command lock should succeed");
    let removed_job_ids = state.scheduler.clear_completed();
    state.prune_output_authorizations(&removed_job_ids);
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
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::domain::job::EnqueueJobRequest;
    use crate::domain::media::{AudioStreamInfo, MediaInfo, OutputFormat, OutputSettings, QualityPreset};
    use crate::jobs::{
        CancellationToken, EventSink, ExecutionOutcome, JobExecutor, JobExecution, Scheduler,
        SchedulerError,
    };

    use super::{
        clear_completed_inner, command_error_from_scheduler, enqueue_jobs_inner,
        normalize_selected_path, validate_output_extension, BackendState,
    };

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    fn temporary_file() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        let sequence = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "lumaflow-command-test-{}-{sequence}",
            unique
        ));
        fs::create_dir_all(&directory).expect("test directory should be created");
        let file = directory.join("clip.wav");
        fs::write(&file, b"fixture").expect("test file should be written");
        file
    }

    fn media_info(path: &Path, file_name: &str) -> MediaInfo {
        MediaInfo {
            path: path.to_string_lossy().into_owned(),
            file_name: file_name.to_owned(),
            container: "wav".to_owned(),
            duration_seconds: 1.0,
            size_bytes: 6,
            video_streams: vec![],
            audio_streams: vec![AudioStreamInfo {
                codec: "pcm_s16le".to_owned(),
                stream_index: 0,
                sample_rate_hz: 44_100,
                channels: 2,
            }],
            subtitle_streams: vec![],
        }
    }

    fn output_settings(directory: &Path) -> OutputSettings {
        OutputSettings {
            output_directory: directory.to_string_lossy().into_owned(),
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
        }
    }

    fn request(source: &Path, directory: &Path, media: MediaInfo) -> EnqueueJobRequest {
        EnqueueJobRequest {
            source_path: source.to_string_lossy().into_owned(),
            media,
            output_settings: output_settings(directory),
        }
    }

    fn authorized_state(source: &Path, output_directory: &Path, probed: MediaInfo) -> BackendState {
        let state = BackendState::with_probe(Arc::new(move |_| Ok(probed.clone())));
        state.remember_selected_path(fs::canonicalize(source).expect("source should canonicalize"));
        state.remember_output_directory(
            fs::canonicalize(output_directory).expect("output directory should canonicalize"),
        );
        state
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

    #[test]
    fn rejects_renderer_only_source_paths_at_the_enqueue_boundary() {
        let source = temporary_file();
        let output_directory = source.parent().expect("source should have a parent");
        let state = BackendState::new();

        let error = enqueue_jobs_inner(
            &state,
            vec![request(&source, output_directory, media_info(&source, "clip.wav"))],
        )
        .expect_err("renderer-only paths must not be accepted");

        assert_eq!(error.code, "path_not_selected");
        assert!(state.scheduler.snapshot().jobs.is_empty());
        let _ = fs::remove_dir_all(source.parent().expect("source should have a parent"));
    }

    #[test]
    fn rejects_renderer_only_source_paths_at_the_analyze_boundary() {
        let source = temporary_file();
        let state = BackendState::new();

        let error = state
            .probe_selected_path(&source.to_string_lossy())
            .expect_err("renderer-only paths must not be analyzed");

        assert_eq!(error.code, "path_not_selected");
        let _ = fs::remove_dir_all(source.parent().expect("source should have a parent"));
    }

    #[test]
    fn trusted_dropped_paths_are_registered_before_analysis() {
        let source = temporary_file();
        let probed = media_info(&source, "clip.wav");
        let state = BackendState::with_probe(Arc::new(move |_| Ok(probed.clone())));

        let registered = state.register_trusted_dropped_paths(std::slice::from_ref(&source));

        assert_eq!(
            registered,
            vec![fs::canonicalize(&source).expect("source should canonicalize")]
        );
        let analyzed = state
            .probe_selected_path(&source.to_string_lossy())
            .expect("trusted dropped source should be analyzable");
        assert_eq!(analyzed.file_name, "clip.wav");
        let _ = fs::remove_dir_all(source.parent().expect("source should have a parent"));
    }

    #[test]
    fn rejects_output_directories_without_backend_picker_authorization() {
        let source = temporary_file();
        let output_directory = source.parent().expect("source should have a parent");
        let probed = media_info(&source, "clip.wav");
        let state = BackendState::with_probe(Arc::new(move |_| Ok(probed.clone())));
        state.remember_selected_path(fs::canonicalize(&source).expect("source should canonicalize"));

        let error = enqueue_jobs_inner(
            &state,
            vec![request(&source, output_directory, media_info(&source, "clip.wav"))],
        )
        .expect_err("unregistered output directories must be rejected");

        assert_eq!(error.code, "output_directory_not_registered");
        assert!(state.scheduler.snapshot().jobs.is_empty());
        let _ = fs::remove_dir_all(source.parent().expect("source should have a parent"));
    }

    #[test]
    fn enqueue_uses_backend_probe_results_instead_of_forged_renderer_metadata() {
        let source = temporary_file();
        let output_directory = source.parent().expect("source should have a parent");
        let probed = media_info(&source, "clip.wav");
        let state = authorized_state(&source, output_directory, probed.clone());
        let mut forged = media_info(&source, "forged.mp4");
        forged.container = "mp4".to_owned();
        forged.audio_streams.clear();

        let snapshot = enqueue_jobs_inner(&state, vec![request(&source, output_directory, forged)])
            .expect("backend-probed media should enqueue");

        assert_eq!(snapshot.jobs[0].media.container, probed.container);
        assert_eq!(snapshot.jobs[0].media.file_name, "clip.wav");
        assert_eq!(
            snapshot.jobs[0].media.path,
            fs::canonicalize(&source)
                .expect("source should canonicalize")
                .to_string_lossy()
        );
        let _ = fs::remove_dir_all(source.parent().expect("source should have a parent"));
    }

    #[test]
    fn batch_preflight_failure_inserts_no_jobs_or_authorizations() {
        let source = temporary_file();
        let output_directory = source.parent().expect("source should have a parent");
        let second_source = output_directory.join("second.wav");
        fs::write(&second_source, b"second").expect("second source should be writable");
        let probed = media_info(&source, "clip.wav");
        let state = authorized_state(&source, output_directory, probed.clone());
        let valid = request(&source, output_directory, probed);
        let invalid = request(&second_source, output_directory, media_info(&second_source, "second.wav"));

        let error = enqueue_jobs_inner(&state, vec![valid, invalid])
            .expect_err("one invalid request should abort the batch");

        assert_eq!(error.code, "path_not_selected");
        assert!(state.scheduler.snapshot().jobs.is_empty());
        assert!(state.authorized_output_paths_is_empty());
        let _ = fs::remove_dir_all(source.parent().expect("source should have a parent"));
    }

    #[test]
    fn batch_destination_conflict_rolls_back_authorization_and_jobs() {
        let source = temporary_file();
        let output_directory = source.parent().expect("source should have a parent");
        let probed = media_info(&source, "clip.wav");
        let state = authorized_state(&source, output_directory, probed.clone());
        let valid = request(&source, output_directory, probed);

        let error = enqueue_jobs_inner(&state, vec![valid.clone(), valid])
            .expect_err("duplicate destinations must abort the whole batch");

        assert_eq!(error.code, "destination_conflict");
        assert!(state.scheduler.snapshot().jobs.is_empty());
        assert!(state.authorized_output_paths_is_empty());
        let _ = fs::remove_dir_all(source.parent().expect("source should have a parent"));
    }

    #[test]
    fn destination_is_authorized_before_a_fast_job_can_finish() {
        let source = temporary_file();
        let output_directory = source.parent().expect("source should have a parent");
        let probed = media_info(&source, "clip.wav");
        let state = BackendState::with_test_scheduler(
            Scheduler::new(Arc::new(ImmediateExecutor), 1),
            Arc::new(move |_| Ok(probed.clone())),
        );
        state.remember_selected_path(fs::canonicalize(&source).expect("source should canonicalize"));
        state.remember_output_directory(
            fs::canonicalize(output_directory).expect("output directory should canonicalize"),
        );

        let snapshot = enqueue_jobs_inner(
            &state,
            vec![request(&source, output_directory, media_info(&source, "forged.wav"))],
        )
        .expect("authorized destination should enqueue");
        let job = &snapshot.jobs[0];
        assert!(
            state
                .scheduler
                .wait_for_idle(std::time::Duration::from_secs(1))
        );
        let output_path = fs::canonicalize(output_directory)
            .expect("output directory should canonicalize")
            .join("clip.flac");

        assert!(state.is_registered_output_path(&output_path));
        assert!(state.is_registered_output_job(&job.id));
        let _ = fs::remove_dir_all(source.parent().expect("source should have a parent"));
    }

    #[test]
    fn clear_completed_prunes_job_output_authorization() {
        let source = temporary_file();
        let output_directory = source.parent().expect("source should have a parent");
        let probed = media_info(&source, "clip.wav");
        let state = BackendState::with_test_scheduler(
            Scheduler::new(Arc::new(ImmediateExecutor), 1),
            Arc::new(move |_| Ok(probed.clone())),
        );
        state.remember_selected_path(fs::canonicalize(&source).expect("source should canonicalize"));
        state.remember_output_directory(
            fs::canonicalize(output_directory).expect("output directory should canonicalize"),
        );

        let snapshot = enqueue_jobs_inner(
            &state,
            vec![request(&source, output_directory, media_info(&source, "forged.wav"))],
        )
        .expect("job should enqueue");
        let job_id = snapshot.jobs[0].id.clone();
        state
            .scheduler
            .wait_for_idle(std::time::Duration::from_secs(1));
        state.authorize_output_path(&job_id, output_directory.join("clip.flac"));

        let snapshot = clear_completed_inner(&state).expect("completed jobs should clear");

        assert!(snapshot.jobs.is_empty());
        assert!(!state.is_registered_output_job(&job_id));
        let _ = fs::remove_dir_all(source.parent().expect("source should have a parent"));
    }
}
