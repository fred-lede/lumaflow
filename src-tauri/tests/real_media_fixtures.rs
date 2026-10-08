use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use lumaflow_lib::domain::job::{JobEvent, JobState, ProcessingKind, QueueJob, QueueSnapshot};
use lumaflow_lib::domain::media::{MediaInfo, OutputFormat, OutputSettings, QualityPreset};
use lumaflow_lib::jobs::{FfmpegRunner, JobExecution, Scheduler};
use lumaflow_lib::media::planner::plan_conversion;
use lumaflow_lib::media::probe::{CommandOutput, CommandRunner, probe_media};
use lumaflow_lib::media::MediaError;
use serde::Serialize;

const FIXTURE_NAMES: [&str; 10] = [
    "sample.mp4",
    "sample.mov",
    "sample.mkv",
    "sample.webm",
    "sample.avi",
    "sample.mp3",
    "sample.m4a",
    "sample.wav",
    "sample.flac",
    "sample.ogg",
];

struct PinnedFfprobeRunner {
    program: PathBuf,
}

struct TempDirectory {
    path: PathBuf,
}

impl TempDirectory {
    fn new(prefix: &str) -> Self {
        let path = env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("integration output directory should be creatable");
        Self { path }
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

impl CommandRunner for PinnedFfprobeRunner {
    fn run(&self, _program: &str, args: &[String]) -> Result<CommandOutput, MediaError> {
        let output = Command::new(&self.program)
            .args(args)
            .output()
            .map_err(|error| MediaError::with_details(
                "probe_command_error",
                "FFprobe could not be started",
                error.to_string(),
            ))?;

        Ok(CommandOutput {
            status: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

#[derive(Debug, Clone, Copy)]
enum ExpectedOutcome {
    Remux,
    LosslessAudio,
    Transcoding,
    Unsupported,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UiTrace {
    trace_schema_version: u32,
    source_media: Vec<MediaInfo>,
    output_directory: String,
    snapshots: UiSnapshots,
    before_retry_events: Vec<JobEvent>,
    after_retry_events: Vec<JobEvent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UiSnapshots {
    queued: QueueSnapshot,
    cancelled: QueueSnapshot,
    failed: QueueSnapshot,
    retried: QueueSnapshot,
    completed: QueueSnapshot,
}

fn repository_fixture_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures")
}

fn required_executable(name: &str) -> PathBuf {
    let raw = env::var(name).unwrap_or_else(|_| {
        panic!(
            "{name} is required; set it to the release-pinned executable before running real media integration tests"
        )
    });
    let path = PathBuf::from(raw);
    let metadata = fs::metadata(&path).unwrap_or_else(|error| {
        panic!("{name} does not point to a readable file {}: {error}", path.display())
    });
    assert!(metadata.is_file(), "{name} must point to a regular file: {}", path.display());
    #[cfg(unix)]
    assert!(
        std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o111 != 0,
        "{name} must point to an executable file: {}",
        path.display()
    );
    path
}

fn require_generated_fixtures() -> Vec<PathBuf> {
    let directory = repository_fixture_directory();
    let manifest_path = directory.join("manifest.json");
    assert!(
        manifest_path.is_file(),
        "fixture manifest is missing at {}; run npm run fixtures with the pinned FFmpeg asset",
        manifest_path.display()
    );
    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&manifest_path).expect("fixture manifest should be readable"),
    )
    .expect("fixture manifest should be valid JSON");
    let manifest_names = manifest["files"]
        .as_array()
        .expect("fixture manifest should contain files")
        .iter()
        .map(|file| file["name"].as_str().expect("fixture name should be a string"))
        .collect::<Vec<_>>();
    assert_eq!(manifest_names, FIXTURE_NAMES);

    FIXTURE_NAMES
        .iter()
        .map(|name| {
            let path = directory.join(name);
            assert!(path.is_file(), "generated fixture is missing: {}", path.display());
            assert!(
                fs::metadata(&path).expect("fixture metadata should exist").len() > 0,
                "generated fixture is empty: {}",
                path.display()
            );
            path
        })
        .collect()
}

fn settings(output_directory: &Path, format: OutputFormat) -> OutputSettings {
    OutputSettings {
        output_directory: output_directory.to_string_lossy().into_owned(),
        format,
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

fn assert_outcome(media: &MediaInfo, output_directory: &Path, format: OutputFormat, expected: ExpectedOutcome) {
    let plan = plan_conversion(media, &settings(output_directory, format));
    match expected {
        ExpectedOutcome::Remux => assert!(matches!(
            plan.expect("fixture should have a remux plan").processing_kind,
            ProcessingKind::LosslessRemux { .. }
        )),
        ExpectedOutcome::LosslessAudio => assert!(matches!(
            plan.expect("fixture should have a lossless audio plan").processing_kind,
            ProcessingKind::LosslessAudio { .. }
        )),
        ExpectedOutcome::Transcoding => assert!(matches!(
            plan.expect("fixture should have a transcoding plan").processing_kind,
            ProcessingKind::Transcoding { .. }
        )),
        ExpectedOutcome::Unsupported => {
            let error = plan.expect_err("fixture conversion should be rejected");
            assert_eq!(error.code, "unsupported_conversion");
            assert!(!error.message.is_empty());
        }
    }
}

fn queue_job(id: &str, media: &MediaInfo, settings: OutputSettings) -> QueueJob {
    QueueJob {
        id: id.to_owned(),
        attempt: 0,
        source_path: media.path.clone(),
        media: media.clone(),
        output_settings: settings,
        processing_kind: None,
        state: JobState::Queued {
            label: "Queued".to_owned(),
        },
        progress: 0.0,
        output_path: None,
    }
}

#[test]
fn real_fixture_probe_and_planner_matrix_and_ui_trace() {
    let ffmpeg = required_executable("LUMAFLOW_FFMPEG_TEST_BIN");
    let ffprobe = required_executable("LUMAFLOW_FFPROBE_TEST_BIN");
    let fixture_paths = require_generated_fixtures();
    let fixture_directory = repository_fixture_directory();
    let probe_runner = PinnedFfprobeRunner { program: ffprobe };
    let output_root = TempDirectory::new("lumaflow-real-media");

    let mut probed = Vec::new();
    for path in &fixture_paths {
        let media = probe_media(&probe_runner, path).unwrap_or_else(|error| {
            panic!("real FFprobe failed for {}: {error}", path.display())
        });
        probed.push(media);
    }
    let expected_containers = ["mp4", "mov", "matroska", "webm", "avi", "mp3", "m4a", "wav", "flac", "ogg"];
    for (media, expected_container) in probed.iter().zip(expected_containers) {
        assert_eq!(media.container, expected_container, "unexpected container for {}", media.file_name);
        assert!(media.duration_seconds > 0.0);
        assert!(!media.audio_streams.is_empty() || !media.video_streams.is_empty());
    }

    let matrix = [
        (0, OutputFormat::Mp4, ExpectedOutcome::Remux),
        (1, OutputFormat::Mov, ExpectedOutcome::Remux),
        (2, OutputFormat::Mkv, ExpectedOutcome::Remux),
        (3, OutputFormat::Webm, ExpectedOutcome::Remux),
        (4, OutputFormat::Avi, ExpectedOutcome::Unsupported),
        (5, OutputFormat::Mp3, ExpectedOutcome::Remux),
        (6, OutputFormat::M4a, ExpectedOutcome::Remux),
        (7, OutputFormat::Flac, ExpectedOutcome::LosslessAudio),
        (8, OutputFormat::Flac, ExpectedOutcome::Remux),
        (9, OutputFormat::Ogg, ExpectedOutcome::Unsupported),
    ];
    for (index, output_format, expected) in matrix {
        assert_outcome(&probed[index], &output_root.path, output_format, expected);
    }
    assert_outcome(&probed[0], &output_root.path, OutputFormat::Mp3, ExpectedOutcome::Transcoding);
    assert_outcome(&probed[0], &output_root.path, OutputFormat::Webm, ExpectedOutcome::Unsupported);

    let retry_directory = output_root.path.join("retry");
    let cancel_directory = output_root.path.join("cancel");
    fs::create_dir_all(&retry_directory).expect("retry output directory should be creatable");
    fs::create_dir_all(&cancel_directory).expect("cancel output directory should be creatable");
    let retry_settings = settings(&retry_directory, OutputFormat::Mp3);
    let cancel_settings = settings(&cancel_directory, OutputFormat::Mp3);
    let retry_plan = plan_conversion(&probed[1], &retry_settings).expect("retry plan should be valid");
    let cancel_plan = plan_conversion(&probed[0], &cancel_settings).expect("cancel plan should be valid");
    fs::write(&retry_plan.output_path, b"occupied destination").expect("seeded destination should be writable");

    let events = Arc::new(Mutex::new(Vec::<JobEvent>::new()));
    let event_sink = {
        let events = Arc::clone(&events);
        Arc::new(move |event: JobEvent| {
            events.lock().expect("event trace lock should succeed").push(event);
        })
    };
    let scheduler = Scheduler::new(Arc::new(FfmpegRunner::new(ffmpeg.as_os_str().to_owned())), 1);
    scheduler.set_event_sink(event_sink);
    scheduler.pause().expect("scheduler should pause");
    scheduler
        .enqueue_batch(vec![
            JobExecution {
                job: queue_job("cancel-job", &probed[0], cancel_settings),
                plan: cancel_plan,
            },
            JobExecution {
                job: queue_job("retry-job", &probed[1], retry_settings),
                plan: retry_plan.clone(),
            },
        ])
        .expect("real fixture jobs should enqueue");
    let queued_snapshot = scheduler.snapshot();
    scheduler.cancel("cancel-job").expect("queued fixture job should cancel");
    let cancelled_snapshot = scheduler.snapshot();
    scheduler.resume().expect("scheduler should resume");
    assert!(scheduler.wait_for_idle(Duration::from_secs(20)), "real fixture scheduler should become idle");
    let failed_snapshot = scheduler.snapshot();
    assert!(matches!(
        failed_snapshot.jobs.iter().find(|job| job.id == "retry-job").expect("retry job should exist").state,
        JobState::Failed { .. }
    ));
    let before_retry_events = events.lock().expect("event trace lock should succeed").clone();

    fs::remove_file(&retry_plan.output_path).expect("failed destination should be removable");
    scheduler.retry("retry-job").expect("failed fixture job should retry");
    let retried_snapshot = scheduler.snapshot();
    assert!(scheduler.wait_for_idle(Duration::from_secs(20)), "retried fixture job should become idle");
    let completed_snapshot = scheduler.snapshot();
    assert!(matches!(
        completed_snapshot.jobs.iter().find(|job| job.id == "retry-job").expect("retry job should exist").state,
        JobState::Completed { .. }
    ));
    let completed_output = completed_snapshot
        .jobs
        .iter()
        .find(|job| job.id == "retry-job")
        .and_then(|job| job.output_path.as_deref())
        .expect("completed retry job should publish an output path");
    let completed_output_path = PathBuf::from(completed_output);
    let completed_metadata = fs::metadata(&completed_output_path)
        .expect("completed conversion output should exist");
    assert!(
        completed_metadata.is_file() && completed_metadata.len() > 0,
        "completed conversion output should be a non-empty regular file"
    );
    let completed_media = probe_media(&probe_runner, &completed_output_path)
        .expect("completed conversion output should be FFprobe-readable");
    assert_eq!(completed_media.container, "mp3");
    assert!(!completed_media.audio_streams.is_empty());
    assert!(completed_media.video_streams.is_empty());
    let all_events = events.lock().expect("event trace lock should succeed").clone();
    let after_retry_events = all_events[before_retry_events.len()..].to_vec();

    if let Ok(trace_path) = env::var("LUMAFLOW_E2E_EVENT_TRACE") {
        let trace = UiTrace {
            trace_schema_version: 1,
            source_media: vec![probed[0].clone(), probed[1].clone()],
            output_directory: output_root.path.to_string_lossy().into_owned(),
            snapshots: UiSnapshots {
                queued: queued_snapshot,
                cancelled: cancelled_snapshot,
                failed: failed_snapshot,
                retried: retried_snapshot,
                completed: completed_snapshot,
            },
            before_retry_events,
            after_retry_events,
        };
        fs::write(
            &trace_path,
            serde_json::to_vec_pretty(&trace).expect("UI trace should serialize"),
        )
        .expect("UI event trace should be writable");
    }

    assert!(fixture_directory.is_dir());
}
