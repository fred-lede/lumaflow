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
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

struct PinnedFfprobeRunner {
    program: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustedSpec {
    schema_version: u32,
    generator_version: u32,
    parameters: TrustedParameters,
    ffmpeg: TrustedBinary,
    ffprobe: TrustedBinary,
    generation: TrustedGeneration,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrustedParameters {
    duration_seconds: u32,
    video_size: String,
    video_rate: u32,
    audio_frequency_hz: u32,
    audio_sample_rate_hz: u32,
    threads: u32,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrustedBinary {
    version_policy: String,
    version: String,
    assets: std::collections::HashMap<String, TrustedAsset>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct TrustedAsset {
    sha256: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrustedGeneration {
    shared_flags: Vec<String>,
    output_metadata_flags: Vec<String>,
    video_audio_flags: Vec<String>,
    video_input: Vec<String>,
    audio_input: Vec<String>,
    fixtures: Vec<TrustedFixture>,
}

#[derive(Debug, Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum FixtureKind {
    Video,
    Audio,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrustedFixture {
    name: String,
    container: String,
    kind: FixtureKind,
    video_codec: Option<String>,
    audio_codec: String,
    probe_video_codec: Option<String>,
    probe_audio_codec: String,
    codec_flags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureManifest {
    schema_version: u32,
    generator_version: u32,
    parameters: TrustedParameters,
    ffmpeg: FixtureManifestBinary,
    files: Vec<FixtureManifestFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureManifestBinary {
    version: String,
    version_line: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct FixtureManifestFile {
    name: String,
    bytes: u64,
    sha256: String,
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

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn trusted_platform_key() -> &'static str { "darwin-arm64" }

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn trusted_platform_key() -> &'static str { "darwin-x64" }

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn trusted_platform_key() -> &'static str { "linux-x64" }

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn trusted_platform_key() -> &'static str { "linux-arm64" }

#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "aarch64"),
)))]
fn trusted_platform_key() -> &'static str { "unsupported-platform" }

fn ensure_supported_platform() {
    let platform = trusted_platform_key();
    assert_eq!(
        platform,
        "darwin-arm64",
        "Task 9 real-media verification is supported only on darwin-arm64; refusing unvalidated host {platform}"
    );
}

fn expected_parameters() -> TrustedParameters {
    TrustedParameters {
        duration_seconds: 1,
        video_size: "160x90".to_owned(),
        video_rate: 10,
        audio_frequency_hz: 440,
        audio_sample_rate_hz: 48_000,
        threads: 1,
    }
}

fn video_fixture(
    name: &str,
    container: &str,
    video_codec: &str,
    audio_codec: &str,
    probe_video_codec: &str,
    probe_audio_codec: &str,
    codec_flags: &[&str],
) -> TrustedFixture {
    TrustedFixture {
        name: name.to_owned(),
        container: container.to_owned(),
        kind: FixtureKind::Video,
        video_codec: Some(video_codec.to_owned()),
        audio_codec: audio_codec.to_owned(),
        probe_video_codec: Some(probe_video_codec.to_owned()),
        probe_audio_codec: probe_audio_codec.to_owned(),
        codec_flags: codec_flags.iter().map(|flag| (*flag).to_owned()).collect(),
    }
}

fn audio_fixture(
    name: &str,
    container: &str,
    audio_codec: &str,
    probe_audio_codec: &str,
    codec_flags: &[&str],
) -> TrustedFixture {
    TrustedFixture {
        name: name.to_owned(),
        container: container.to_owned(),
        kind: FixtureKind::Audio,
        video_codec: None,
        audio_codec: audio_codec.to_owned(),
        probe_video_codec: None,
        probe_audio_codec: probe_audio_codec.to_owned(),
        codec_flags: codec_flags.iter().map(|flag| (*flag).to_owned()).collect(),
    }
}

fn expected_generation() -> TrustedGeneration {
    TrustedGeneration {
        shared_flags: ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1", "-fflags", "+bitexact"]
            .iter()
            .map(|flag| (*flag).to_owned())
            .collect(),
        output_metadata_flags: ["-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", "-map_chapters", "-1"]
            .iter()
            .map(|flag| (*flag).to_owned())
            .collect(),
        video_audio_flags: vec!["-b:a".to_owned(), "96k".to_owned()],
        video_input: vec!["-f".to_owned(), "lavfi".to_owned(), "-i".to_owned(), "testsrc2=size=160x90:rate=10:duration=1".to_owned()],
        audio_input: vec!["-f".to_owned(), "lavfi".to_owned(), "-i".to_owned(), "sine=frequency=440:sample_rate=48000:duration=1".to_owned()],
        fixtures: vec![
            video_fixture("sample.mp4", "mp4", "libx264", "aac", "h264", "aac", &["-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]),
            video_fixture("sample.mov", "mov", "libx264", "aac", "h264", "aac", &["-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p"]),
            video_fixture("sample.mkv", "matroska", "libx264", "aac", "h264", "aac", &["-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-cluster_time_limit", "1000"]),
            video_fixture("sample.webm", "webm", "libvpx-vp9", "libopus", "vp9", "opus", &["-b:v", "200k", "-crf", "40", "-deadline", "realtime", "-cpu-used", "8", "-b:a", "64k", "-cluster_time_limit", "1000"]),
            video_fixture("sample.avi", "avi", "mpeg4", "libmp3lame", "mpeg4", "mp3", &["-q:v", "5", "-q:a", "9"]),
            audio_fixture("sample.mp3", "mp3", "libmp3lame", "mp3", &["-q:a", "9"]),
            audio_fixture("sample.m4a", "m4a", "aac", "aac", &["-b:a", "96k", "-f", "ipod"]),
            audio_fixture("sample.wav", "wav", "pcm_s16le", "pcm_s16le", &[]),
            audio_fixture("sample.flac", "flac", "flac", "flac", &["-compression_level", "5"]),
            audio_fixture("sample.ogg", "ogg", "libopus", "opus", &["-b:a", "64k", "-vbr", "on", "-application", "audio", "-serial_offset", "0", "-f", "ogg"]),
        ],
    }
}

fn load_trusted_spec() -> TrustedSpec {
    let path = repository_fixture_directory().join("spec.json");
    let spec: TrustedSpec = serde_json::from_str(
        &fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!("trusted fixture specification is missing at {}: {error}", path.display())
        }),
    )
    .unwrap_or_else(|error| panic!("trusted fixture specification is invalid: {error}"));
    assert_eq!(spec.schema_version, 2, "trusted fixture spec schema must be 2");
    assert_eq!(spec.generator_version, 2, "trusted fixture spec generator must be 2");
    assert_eq!(spec.parameters, expected_parameters(), "trusted generation parameters changed");
    assert_eq!(spec.generation, expected_generation(), "trusted generation vectors changed");
    assert_eq!(spec.ffmpeg.version_policy, "exact", "FFmpeg trust policy must be exact");
    assert_eq!(spec.ffmpeg.version, "8.1.2", "FFmpeg trusted version changed");
    assert_eq!(spec.ffmpeg.assets.len(), 1, "FFmpeg trust policy must contain only the supported asset identity");
    assert_eq!(spec.ffmpeg.assets.get("darwin-arm64").map(|asset| asset.sha256.as_str()), Some("1332dc2de372bade9a8a63da0d6cdfab9de97fcefbae707bcc0b0506e1203327"));
    assert_eq!(spec.ffprobe.version_policy, "exact", "FFprobe trust policy must be exact");
    assert_eq!(spec.ffprobe.version, "8.1.2", "FFprobe trusted version changed");
    assert_eq!(spec.ffprobe.assets.len(), 1, "FFprobe trust policy must contain only the supported asset identity");
    assert_eq!(spec.ffprobe.assets.get("darwin-arm64").map(|asset| asset.sha256.as_str()), Some("4322275c1c2ac6ba15c695b288788bc1204e75211b3d5c030e5812c82a6dff73"));
    spec
}

fn trusted_binary_identity<'a>(binary: &'a TrustedBinary, label: &str) -> (&'a str, &'a str) {
    let platform = trusted_platform_key();
    let asset = binary.assets.get(platform).unwrap_or_else(|| {
        panic!(
            "no committed trusted {label} test binary identity exists for platform {platform}; refusing direct integration"
        )
    });
    assert_eq!(asset.sha256.len(), 64, "trusted {label} digest must be SHA-256");
    assert!(
        asset.sha256.chars().all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()),
        "trusted {label} digest must be lowercase hexadecimal"
    );
    (&binary.version, &asset.sha256)
}

fn sha256_file(path: &Path) -> String {
    let bytes = fs::read(path).unwrap_or_else(|error| panic!("could not read {} for SHA-256: {error}", path.display()));
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

fn required_executable(name: &str, binary: &TrustedBinary, label: &str) -> PathBuf {
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
    let (trusted_version, trusted_sha256) = trusted_binary_identity(binary, label);
    let version_output = Command::new(&path)
        .arg("-version")
        .output()
        .unwrap_or_else(|error| panic!("{name} could not execute -version: {error}"));
    assert!(version_output.status.success(), "{name} -version failed");
    let version_text = String::from_utf8_lossy(&version_output.stdout);
    let first_line = version_text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let reported_version = first_line.split_whitespace().nth(2).unwrap_or("");
    assert_eq!(reported_version, trusted_version, "{name} version is not the committed trusted version");
    assert_eq!(sha256_file(&path), trusted_sha256, "{name} does not match the committed trusted digest");
    path
}

fn require_generated_fixtures(spec: &TrustedSpec, trusted_ffmpeg: &TrustedBinary) -> Vec<PathBuf> {
    let directory = repository_fixture_directory();
    let manifest_path = directory.join("manifest.json");
    assert!(
        manifest_path.is_file(),
        "fixture manifest is missing at {}; run npm run fixtures with the pinned FFmpeg asset",
        manifest_path.display()
    );
    let manifest: FixtureManifest = serde_json::from_str(
        &fs::read_to_string(&manifest_path).expect("fixture manifest should be readable"),
    )
    .expect("fixture manifest should be valid JSON");
    assert_eq!(manifest.schema_version, spec.schema_version);
    assert_eq!(manifest.generator_version, spec.generator_version);
    assert_eq!(manifest.parameters, spec.parameters, "fixture manifest parameters must match the trusted spec");
    let (trusted_version, trusted_sha256) = trusted_binary_identity(trusted_ffmpeg, "FFmpeg");
    assert_eq!(manifest.ffmpeg.version, trusted_version);
    let manifest_version_line = manifest.ffmpeg.version_line.split_whitespace().collect::<Vec<_>>();
    assert_eq!(manifest_version_line.first().copied(), Some("ffmpeg"));
    assert_eq!(manifest_version_line.get(1).copied(), Some("version"));
    assert_eq!(manifest_version_line.get(2).copied(), Some(trusted_version));
    assert_eq!(manifest.ffmpeg.sha256, trusted_sha256);
    assert_eq!(manifest.files.len(), spec.generation.fixtures.len());
    manifest.files.iter().zip(&spec.generation.fixtures).for_each(|(file, expected)| {
        assert_eq!(file.name, expected.name);
        assert!(file.bytes > 0, "fixture must be non-empty: {}", file.name);
        let path = directory.join(&file.name);
        assert!(path.is_file(), "generated fixture is missing: {}", path.display());
        assert_eq!(fs::metadata(&path).expect("fixture metadata should exist").len(), file.bytes);
        assert_eq!(sha256_file(&path), file.sha256, "fixture checksum mismatch: {}", path.display());
    });

    spec.generation.fixtures
        .iter()
        .map(|name| {
            let path = directory.join(&name.name);
            path
        })
    .collect()
}

fn assert_fixture_probe(media: &MediaInfo, expected: &TrustedFixture) {
    assert_eq!(media.container, expected.container, "unexpected container for {}", media.file_name);
    assert!(media.duration_seconds > 0.0);
    match expected.kind {
        FixtureKind::Video => {
            assert_eq!(media.video_streams.len(), 1, "unexpected video stream count for {}", media.file_name);
            assert_eq!(media.audio_streams.len(), 1, "unexpected audio stream count for {}", media.file_name);
            assert_eq!(media.video_streams[0].codec, expected.probe_video_codec.as_deref().expect("video codec contract"));
        }
        FixtureKind::Audio => {
            assert!(media.video_streams.is_empty(), "audio fixture unexpectedly has video: {}", media.file_name);
            assert_eq!(media.audio_streams.len(), 1, "unexpected audio stream count for {}", media.file_name);
        }
    }
    assert_eq!(media.audio_streams[0].codec, expected.probe_audio_codec);
    assert!(media.subtitle_streams.is_empty(), "fixture unexpectedly has subtitles: {}", media.file_name);
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
    ensure_supported_platform();
    let spec = load_trusted_spec();
    let ffmpeg = required_executable("LUMAFLOW_FFMPEG_TEST_BIN", &spec.ffmpeg, "FFmpeg");
    let ffprobe = required_executable("LUMAFLOW_FFPROBE_TEST_BIN", &spec.ffprobe, "FFprobe");
    let fixture_paths = require_generated_fixtures(&spec, &spec.ffmpeg);
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
    for (media, expected_fixture) in probed.iter().zip(&spec.generation.fixtures) {
        assert_fixture_probe(media, expected_fixture);
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
