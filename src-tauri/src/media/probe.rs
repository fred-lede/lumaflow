use std::path::Path;

use serde_json::Value;

use crate::domain::media::{
    AudioStreamInfo, MediaInfo, SourceQualityAssessment, SourceQualityStatus, SubtitleStreamInfo,
    VideoStreamInfo,
};

use super::tools::ToolLocator;
use super::MediaError;

#[derive(Debug)]
pub struct CommandOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

pub trait CommandRunner {
    fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, MediaError>;
}

/// A snapshot of the three kernel counters that separate "working" from "parked".
/// `rchar` and `syscr` count bytes and calls of `read()`/`write()`; `utime + stime`
/// counts CPU. Measured (see the ledger, Finding 8): the leader's `/proc/<pid>/io` and
/// `/proc/<pid>/stat` already sum the whole thread group, so a multi-threaded ffmpeg
/// whose main thread sits in `read()` while its filter threads work still shows
/// movement, and walking `/proc/<pid>/task/*` would add cost without adding signal.
#[cfg(target_os = "linux")]
#[derive(Debug)]
pub(crate) struct ActivitySample {
    read_bytes: u64,
    read_calls: u64,
    cpu_ticks: u64,
}

#[cfg(target_os = "linux")]
impl ActivitySample {
    pub(crate) fn progressed_since(&self, previous: &Self) -> bool {
        self.read_bytes != previous.read_bytes
            || self.read_calls != previous.read_calls
            || self.cpu_ticks != previous.cpu_ticks
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn parse_io_field(text: &str, field: &str) -> Option<u64> {
    // `/proc/<pid>/io` has `rchar:` and `wchar:`, `syscr:` and `syscw:` side by side, so
    // the key must match exactly after trimming; a loose `starts_with`
    // or `contains` would return the wrong counter, and a wrong counter is a wrong
    // watchdog decision.
    text.lines().find_map(|line| match line.split_once(':') {
        Some((key, value)) if key.trim() == field => value.trim().parse::<u64>().ok(),
        _ => None,
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn parse_stat_cpu(text: &str) -> Option<u64> {
    // The comm field (field 2) may contain spaces and parentheses, so count from the
    // last ')'. The remainder starts at field 3 (state), making utime index 11 and
    // stime index 12 (1-based fields 14 and 15).
    let (_, remainder) = text.rsplit_once(')')?;
    let fields: Vec<&str> = remainder.split_whitespace().collect();
    let utime = fields.get(11)?.parse::<u64>().ok()?;
    let stime = fields.get(12)?.parse::<u64>().ok()?;
    Some(utime + stime)
}

#[cfg(target_os = "linux")]
pub(crate) fn read_activity_sample(pid: u32) -> Result<ActivitySample, std::io::Error> {
    let io_text = std::fs::read_to_string(format!("/proc/{pid}/io"))?;
    let stat_text = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let (Some(read_bytes), Some(read_calls), Some(cpu_ticks)) = (
        parse_io_field(&io_text, "rchar"),
        parse_io_field(&io_text, "syscr"),
        parse_stat_cpu(&stat_text),
    ) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("could not read the activity counters of pid {pid}"),
        ));
    };
    Ok(ActivitySample {
        read_bytes,
        read_calls,
        cpu_ticks,
    })
}

/// How long a probe child may go without reading a byte or burning CPU before the
/// watchdog stops it. This is a gap between activity samples, not a total-runtime
/// deadline: a probe that really is reading is never stopped, and a throttled probe that
/// legitimately spends 230 s reading 241 MB of a fragmented MP4 (ledger Finding 4) stays
/// alive. 120 s is deliberately generous — a hard-mounted NFS source can take 60-180 s
/// between reads — and matches the FFmpeg watchdog's window in src-tauri/src/jobs/runner.rs.
#[cfg(target_os = "linux")]
pub const PROBE_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[cfg(target_os = "linux")]
const PROBE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

#[derive(Clone)]
pub struct ProcessCommandRunner {
    tools: ToolLocator,
    #[cfg(target_os = "linux")]
    stall_timeout: std::time::Duration,
    #[cfg(target_os = "linux")]
    poll_interval: std::time::Duration,
}

impl ProcessCommandRunner {
    pub fn system() -> Self {
        Self {
            tools: ToolLocator::system(),
            #[cfg(target_os = "linux")]
            stall_timeout: PROBE_STALL_TIMEOUT,
            #[cfg(target_os = "linux")]
            poll_interval: PROBE_POLL_INTERVAL,
        }
    }

    pub fn with_tools(tools: ToolLocator) -> Self {
        Self {
            tools,
            #[cfg(target_os = "linux")]
            stall_timeout: PROBE_STALL_TIMEOUT,
            #[cfg(target_os = "linux")]
            poll_interval: PROBE_POLL_INTERVAL,
        }
    }

    /// Overrides the watchdog window. Production release builds do not compile this
    /// method at all, so the shipped app always uses `PROBE_STALL_TIMEOUT`. Tests use a
    /// short window so the stall paths are exercised without waiting two minutes, and a
    /// window shorter than two polls would stop a healthy probe, so nothing may ask for
    /// one.
    #[cfg(all(target_os = "linux", any(test, debug_assertions)))]
    pub fn with_stall_deadlines(
        mut self,
        stall_timeout: std::time::Duration,
        poll_interval: std::time::Duration,
    ) -> Self {
        debug_assert!(
            stall_timeout > poll_interval * 2,
            "a stall window shorter than two polls would fire between samples of a healthy child"
        );
        self.stall_timeout = stall_timeout;
        self.poll_interval = poll_interval;
        self
    }

    #[cfg(target_os = "linux")]
    fn run_guarded(
        &self,
        program: &str,
        executable: &Path,
        args: &[String],
    ) -> Result<CommandOutput, MediaError> {
        // Stdin must be nulled explicitly: Command::output() does it for you, spawn()
        // inherits the parent's stdin, and a probe that inherits a terminal would block
        // on a read of its own.
        let mut child = std::process::Command::new(executable)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| {
                MediaError::with_details(
                    "probe_command_error",
                    "FFprobe could not be started",
                    error.to_string(),
                )
            })?;

        // Both streams are drained on their own threads, so a child that fills a pipe
        // buffer never blocks on a write — which would look exactly like a stalled read.
        // Assumes the child is a leaf process: a grandchild holding a pipe open would
        // keep the join waiting after the child is gone (same documented assumption as
        // the FFmpeg watchdog in src-tauri/src/jobs/runner.rs).
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let stdout_thread = std::thread::spawn(move || read_stream_to_end(stdout));
        let stderr_thread = std::thread::spawn(move || read_stream_to_end(stderr));

        let pid = child.id();
        // The window timer starts at spawn, not at the first sample: the first sample has
        // no previous one to compare against, so a child that never reads a byte is judged
        // by the elapsed window alone and is stopped when it expires.
        let mut last_activity = std::time::Instant::now();
        let mut previous: Option<ActivitySample> = None;
        // Poll order matters: try_wait first, then sample, then decide, and only then
        // sleep — a probe that finishes in 70 ms must not sleep out the rest of a poll.
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    // Both the success and the stall path join the drain threads, and the
                    // output assembly matches the pre-watchdog `Command::output()` body:
                    // exit code with -1 for a signal, lossy UTF-8 streams.
                    let stdout_bytes = join_drained(stdout_thread)?;
                    let stderr_bytes = join_drained(stderr_thread)?;
                    return Ok(CommandOutput {
                        status: status.code().unwrap_or(-1),
                        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
                        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
                    });
                }
                Ok(None) => {
                    // A sample we could not read is not evidence either way: it neither
                    // refreshes the window nor proves a stall. The watchdog only ever acts
                    // on counters it actually read, so a child is stopped because its last
                    // observed activity aged out of the window, never because a read failed.
                    if let Ok(sample) = read_activity_sample(pid) {
                        if previous
                            .as_ref()
                            .is_some_and(|was| sample.progressed_since(was))
                        {
                            last_activity = std::time::Instant::now();
                        }
                        previous = Some(sample);
                    }
                    if last_activity.elapsed() >= self.stall_timeout {
                        return Err(stalled_probe_error(
                            program,
                            child,
                            stdout_thread,
                            stderr_thread,
                            last_activity.elapsed(),
                        ));
                    }
                    std::thread::sleep(self.poll_interval);
                }
                Err(error) => {
                    // try_wait itself failed, so the child's state is unknown: stop it
                    // before reporting the failure as a command error.
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();
                    return Err(MediaError::with_details(
                        "probe_command_error",
                        "FFprobe could not be started",
                        error.to_string(),
                    ));
                }
            }
        }
    }

    /// macOS and Windows keep today's behaviour: a blocking `output()` with no activity
    /// watchdog. The probe watchdog is Linux-only for now; on the other platforms a
    /// child parked on an unreadable input still blocks its caller — a known platform
    /// gap, documented here rather than fixed by this change.
    #[cfg(not(target_os = "linux"))]
    fn run_unguarded(
        &self,
        _program: &str,
        executable: &Path,
        args: &[String],
    ) -> Result<CommandOutput, MediaError> {
        let output = std::process::Command::new(executable)
            .args(args)
            .output()
            .map_err(|error| {
                MediaError::with_details(
                    "probe_command_error",
                    "FFprobe could not be started",
                    error.to_string(),
                )
            })?;

        Ok(CommandOutput {
            status: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

impl Default for ProcessCommandRunner {
    fn default() -> Self {
        Self::system()
    }
}

impl CommandRunner for ProcessCommandRunner {
    fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, MediaError> {
        let executable = self.tools.resolve(program).map_err(|error| {
            MediaError::with_details(
                "media_tool_unavailable",
                "The bundled media tool is not available",
                error.to_string(),
            )
        })?;
        #[cfg(target_os = "linux")]
        return self.run_guarded(program, &executable, args);
        #[cfg(not(target_os = "linux"))]
        return self.run_unguarded(program, &executable, args);
    }
}

/// Stops a child the watchdog decided is stuck and builds the error the probe reports.
/// Killing the child closes the pipe write ends, so both drain threads reach EOF and
/// join promptly — assuming the child is a leaf process; a grandchild holding a pipe
/// open would keep the joins waiting (same documented assumption as the FFmpeg watchdog
/// in src-tauri/src/jobs/runner.rs). A drain thread that panicked or failed its read is
/// reported as `probe_command_error` instead of a stall: an unreadable stream is a
/// broken command, not evidence the child was parked.
#[cfg(target_os = "linux")]
fn stalled_probe_error(
    program: &str,
    mut child: std::process::Child,
    stdout: std::thread::JoinHandle<std::io::Result<Vec<u8>>>,
    stderr: std::thread::JoinHandle<std::io::Result<Vec<u8>>>,
    idle: std::time::Duration,
) -> MediaError {
    let _ = child.kill();
    let _ = child.wait();
    if let Err(error) = join_drained(stdout) {
        return error;
    }
    let stderr_text = match join_drained(stderr) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) => return error,
    };

    let mut details = format!("program={program} idle_for={}", humanize_window(idle));
    // Same shape as the FFmpeg watchdog's stalled_error: hand the user the stderr the
    // child managed to produce before it parked.
    if !stderr_text.is_empty() {
        details.push('\n');
        details.push_str(&stderr_text);
    }
    MediaError::with_details(
        "probe_stalled",
        format!(
            "{} made no progress reading or decoding for {} and was stopped",
            tool_label(program),
            humanize_window(idle)
        ),
        details,
    )
}

/// Joins one drain thread and unwraps its read. A thread that panicked or a read that
/// failed is reported as `probe_command_error` rather than silently truncated output,
/// matching what `Command::output()` would have surfaced.
#[cfg(target_os = "linux")]
fn join_drained(
    thread: std::thread::JoinHandle<std::io::Result<Vec<u8>>>,
) -> Result<Vec<u8>, MediaError> {
    match thread.join() {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(error)) => Err(MediaError::with_details(
            "probe_command_error",
            "FFprobe could not be started",
            error.to_string(),
        )),
        Err(_) => Err(MediaError::with_details(
            "probe_command_error",
            "FFprobe could not be started",
            "the stream drain thread failed",
        )),
    }
}

#[cfg(target_os = "linux")]
fn read_stream_to_end<R: std::io::Read>(mut stream: R) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Renders a watchdog window for an error message: whole seconds as "N seconds",
/// sub-second windows as "N ms".
#[cfg(target_os = "linux")]
fn humanize_window(window: std::time::Duration) -> String {
    if window.as_secs() > 0 {
        format!("{} seconds", window.as_secs())
    } else {
        format!("{} ms", window.subsec_millis())
    }
}

#[cfg(target_os = "linux")]
fn tool_label(program: &str) -> &str {
    match program {
        "ffprobe" => "FFprobe",
        "ffmpeg" => "FFmpeg",
        other => other,
    }
}

pub fn probe_media<R: CommandRunner>(
    runner: &R,
    path: impl AsRef<Path>,
) -> Result<MediaInfo, MediaError> {
    let path = path.as_ref();
    let path_string = path.to_string_lossy().into_owned();
    let args = vec![
        "-v".to_owned(),
        "error".to_owned(),
        "-print_format".to_owned(),
        "json".to_owned(),
        "-show_format".to_owned(),
        "-show_streams".to_owned(),
        path_string.clone(),
    ];
    let output = runner.run("ffprobe", &args)?;

    if output.status != 0 {
        return Err(MediaError::with_details(
            "probe_command_failed",
            "FFprobe could not analyze the media file",
            output.stderr,
        ));
    }

    let document: Value = serde_json::from_str(&output.stdout).map_err(|error| {
        MediaError::with_details(
            "probe_invalid_json",
            "FFprobe returned malformed metadata",
            error.to_string(),
        )
    })?;

    let format = required_object(&document, "format")?;
    let container =
        super::resolve_container_name(&required_string(format, "format_name")?, &path_string)?;
    let duration_seconds = required_f64(format, "duration")?;
    let size_bytes = required_u64(format, "size")?;
    let streams = document
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| missing_field("streams"))?;

    let mut video_streams = Vec::new();
    let mut audio_streams = Vec::new();
    let mut subtitle_streams = Vec::new();

    for stream in streams {
        let stream_type = required_string(stream, "codec_type")?;
        match stream_type.as_str() {
            "video" => video_streams.push(VideoStreamInfo {
                codec: required_string(stream, "codec_name")?,
                stream_index: required_u32(stream, "index")?,
                width: required_nonzero_u32(stream, "width")?,
                height: required_nonzero_u32(stream, "height")?,
                frame_rate: required_frame_rate(stream, "r_frame_rate")?,
            }),
            "audio" => audio_streams.push(AudioStreamInfo {
                codec: required_string(stream, "codec_name")?,
                stream_index: required_u32(stream, "index")?,
                sample_rate_hz: required_sample_rate(stream, "sample_rate")?,
                channels: required_nonzero_u16(stream, "channels")?,
            }),
            "subtitle" => subtitle_streams.push(SubtitleStreamInfo {
                codec: required_string(stream, "codec_name")?,
                stream_index: required_u32(stream, "index")?,
            }),
            _ => {
                return Err(MediaError::with_details(
                    "unsupported_streams",
                    format!("FFprobe returned unsupported {stream_type} stream"),
                    format!("stream_type={stream_type}"),
                ));
            }
        }
    }

    if video_streams.is_empty() && audio_streams.is_empty() {
        return Err(MediaError::new(
            "probe_no_media_streams",
            "FFprobe returned no supported audio or video streams",
        ));
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            MediaError::new("probe_invalid_path", "Media path has no valid file name")
        })?;
    let source_quality = assess_source_quality(runner, &document, &audio_streams, &path_string);

    Ok(MediaInfo {
        path: path_string,
        file_name: file_name.to_owned(),
        container,
        duration_seconds,
        size_bytes,
        source_quality,
        video_streams,
        audio_streams,
        subtitle_streams,
    })
}

fn assess_source_quality<R: CommandRunner>(
    runner: &R,
    document: &Value,
    audio_streams: &[AudioStreamInfo],
    path: &str,
) -> SourceQualityAssessment {
    if audio_streams.is_empty() {
        return SourceQualityAssessment::unknown();
    }

    if let Some(codec) = audio_streams
        .iter()
        .map(|stream| stream.codec.as_str())
        .find(|codec| is_lossy_codec(codec))
    {
        return SourceQualityAssessment {
            status: SourceQualityStatus::LossySource,
            summary: "Source uses a lossy audio codec".to_owned(),
            evidence: vec![format!("Audio codec: {codec}")],
        };
    }

    let suspicious_tags = suspicious_encoder_tags(document);
    if !suspicious_tags.is_empty() {
        return SourceQualityAssessment {
            status: SourceQualityStatus::PossiblyTranscodedLossy,
            summary: "Possibly transcoded from a lossy source".to_owned(),
            evidence: suspicious_tags,
        };
    }

    let first_audio = &audio_streams[0];
    let Some(rolloff_hz) = spectral_rolloff_hz(runner, path) else {
        return SourceQualityAssessment::unknown();
    };
    let nyquist_hz = f64::from(first_audio.sample_rate_hz) / 2.0;
    if rolloff_hz < nyquist_hz * 0.45 {
        return SourceQualityAssessment {
            status: SourceQualityStatus::PossiblyTranscodedLossy,
            summary: "Possibly transcoded from a lossy source".to_owned(),
            evidence: vec![format!(
                "The sampled spectral rolloff is unusually low at approximately {rolloff_hz:.0} Hz"
            )],
        };
    }
    if rolloff_hz >= nyquist_hz * 0.72 {
        return SourceQualityAssessment {
            status: SourceQualityStatus::LikelyNativeLossless,
            summary: "Likely native lossless source".to_owned(),
            evidence: vec![format!(
                "The sampled spectrum contains broad-band energy up to approximately {rolloff_hz:.0} Hz"
            )],
        };
    }

    SourceQualityAssessment::unknown()
}

fn is_lossy_codec(codec: &str) -> bool {
    matches!(
        codec.to_ascii_lowercase().as_str(),
        "mp3"
            | "aac"
            | "ac3"
            | "eac3"
            | "vorbis"
            | "opus"
            | "wmav2"
            | "amr_nb"
            | "amr_wb"
            | "speex"
            | "dts"
    )
}

fn suspicious_encoder_tags(document: &Value) -> Vec<String> {
    let mut evidence = Vec::new();
    for section in [document.get("format"), document.get("streams")] {
        let Some(section) = section else { continue };
        let values = match section {
            Value::Object(_) => vec![section],
            Value::Array(streams) => streams.iter().collect(),
            _ => Vec::new(),
        };
        for item in values {
            let Some(tags) = item.get("tags").and_then(Value::as_object) else {
                continue;
            };
            for (key, value) in tags {
                let Some(value) = value.as_str() else {
                    continue;
                };
                let normalized = value.to_ascii_lowercase();
                if [
                    "lame",
                    "mp3",
                    "libmp3lame",
                    "aac",
                    "faac",
                    "fdk-aac",
                    "vorbis",
                    "opus",
                ]
                .iter()
                .any(|marker| normalized.contains(marker))
                {
                    evidence.push(format!("Suspicious encoder metadata: {key}={value}"));
                }
            }
        }
    }
    evidence
}

fn spectral_rolloff_hz<R: CommandRunner>(runner: &R, path: &str) -> Option<f64> {
    let args = vec![
        "-v".to_owned(),
        "info".to_owned(),
        "-nostats".to_owned(),
        "-i".to_owned(),
        path.to_owned(),
        "-t".to_owned(),
        "20".to_owned(),
        "-map".to_owned(),
        "0:a:0".to_owned(),
        "-vn".to_owned(),
        "-af".to_owned(),
        "aspectralstats=win_size=4096:measure=rolloff,ametadata=mode=print:file=-".to_owned(),
        "-f".to_owned(),
        "null".to_owned(),
        "-".to_owned(),
    ];
    let output = runner.run("ffmpeg", &args).ok()?;
    if output.status != 0 {
        return None;
    }
    let combined = format!("{}\n{}", output.stdout, output.stderr);
    let mut values = combined
        .lines()
        .filter_map(|line| line.split_once("lavfi.aspectralstats.1.rolloff="))
        .filter_map(|(_, value)| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .collect::<Vec<_>>();
    if values.len() < 4 {
        return None;
    }
    values.sort_by(|left, right| left.total_cmp(right));
    Some(values[values.len() / 2])
}

fn required_object<'a>(document: &'a Value, field: &str) -> Result<&'a Value, MediaError> {
    document
        .get(field)
        .filter(|value| value.is_object())
        .ok_or_else(|| missing_field(field))
}

fn required_string(document: &Value, field: &str) -> Result<String, MediaError> {
    document
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| missing_field(field))
}

fn required_f64(document: &Value, field: &str) -> Result<f64, MediaError> {
    let value = document.get(field).ok_or_else(|| missing_field(field))?;
    let parsed = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(string) => string.parse().ok(),
        _ => None,
    };
    parsed
        .filter(|number| number.is_finite() && *number >= 0.0)
        .ok_or_else(|| invalid_field(field))
}

fn required_u64(document: &Value, field: &str) -> Result<u64, MediaError> {
    parse_integer(document, field)
}

fn required_u32(document: &Value, field: &str) -> Result<u32, MediaError> {
    parse_integer(document, field)
}

fn required_u16(document: &Value, field: &str) -> Result<u16, MediaError> {
    parse_integer(document, field)
}

fn required_nonzero_u32(document: &Value, field: &str) -> Result<u32, MediaError> {
    let value = required_u32(document, field)?;
    if value == 0 {
        Err(invalid_field(field))
    } else {
        Ok(value)
    }
}

fn required_nonzero_u16(document: &Value, field: &str) -> Result<u16, MediaError> {
    let value = required_u16(document, field)?;
    if value == 0 || value > 256 {
        Err(invalid_field(field))
    } else {
        Ok(value)
    }
}

fn required_sample_rate(document: &Value, field: &str) -> Result<u32, MediaError> {
    let value = required_u32(document, field)?;
    if value == 0 || value > 768_000 {
        Err(invalid_field(field))
    } else {
        Ok(value)
    }
}

fn required_frame_rate(document: &Value, field: &str) -> Result<String, MediaError> {
    let value = required_string(document, field)?;
    let rate = if let Some((numerator, denominator)) = value.split_once('/') {
        if denominator.contains('/') {
            None
        } else {
            let numerator = numerator.parse::<f64>().ok();
            let denominator = denominator.parse::<f64>().ok();
            match (numerator, denominator) {
                (Some(numerator), Some(denominator)) if numerator > 0.0 && denominator > 0.0 => {
                    Some(numerator / denominator)
                }
                _ => None,
            }
        }
    } else {
        value.parse::<f64>().ok()
    };

    match rate {
        Some(rate) if rate.is_finite() && rate > 0.0 && rate <= 1_000.0 => Ok(value),
        _ => Err(invalid_field("frame rate")),
    }
}

fn parse_integer<T>(document: &Value, field: &str) -> Result<T, MediaError>
where
    T: std::str::FromStr,
{
    let value = document.get(field).ok_or_else(|| missing_field(field))?;
    let parsed = match value {
        Value::Number(number) => number.to_string().parse().ok(),
        Value::String(string) => string.parse().ok(),
        _ => None,
    };
    parsed.ok_or_else(|| invalid_field(field))
}

fn missing_field(field: &str) -> MediaError {
    MediaError::new(
        "probe_missing_field",
        format!("FFprobe metadata is missing required field '{field}'"),
    )
}

fn invalid_field(field: &str) -> MediaError {
    MediaError::new(
        "probe_invalid_field",
        format!("FFprobe metadata field '{field}' has an invalid value"),
    )
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::domain::media::{
        AudioStreamInfo, MediaInfo, SourceQualityStatus, SubtitleStreamInfo, VideoStreamInfo,
    };

    const MP4_JSON: &str = r#"
    {
      "format": {"format_name":"mp4","duration":"12.500000","size":"4096"},
      "streams": [
        {"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"30000/1001"},
        {"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2}
      ]
    }
    "#;

    const REAL_STYLE_MP4_JSON: &str = r#"
    {
      "format": {"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"12.500000","size":"4096"},
      "streams": [
        {"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"30000/1001"},
        {"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2}
      ]
    }
    "#;

    const UNKNOWN_STREAM_JSON: &str = r#"
    {
      "format": {"format_name":"mp4","duration":"12.500000","size":"4096"},
      "streams": [
        {"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"30000/1001"},
        {"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2},
        {"index":2,"codec_type":"data","codec_name":"bin_data"}
      ]
    }
    "#;

    const WAV_JSON: &str = r#"
    {
      "format": {"format_name":"wav","duration":3.25,"size":8192},
      "streams": [
        {"index":0,"codec_type":"audio","codec_name":"pcm_s16le","sample_rate":44100,"channels":2}
      ]
    }
    "#;

    const FLAC_JSON: &str = r#"
    {
      "format": {"format_name":"flac","duration":"5.0","size":"16384"},
      "streams": [
        {"index":0,"codec_type":"audio","codec_name":"flac","sample_rate":"96000","channels":1}
      ]
    }
    "#;

    const LOSSLESS_WITH_SUSPICIOUS_TAG_JSON: &str = r#"
    {
      "format": {
        "format_name":"flac",
        "duration":"5.0",
        "size":"16384",
        "tags":{"encoder":"LAME MP3 encoder"}
      },
      "streams": [
        {"index":0,"codec_type":"audio","codec_name":"flac","sample_rate":"44100","channels":2}
      ]
    }
    "#;

    const MULTI_AUDIO_MP4_JSON: &str = r#"
    {
      "format": {"format_name":"mp4","duration":"20.0","size":"65536"},
      "streams": [
        {"index":0,"codec_type":"video","codec_name":"h264","width":1280,"height":720,"r_frame_rate":"24/1"},
        {"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2},
        {"index":2,"codec_type":"audio","codec_name":"aac","sample_rate":"44100","channels":2},
        {"index":3,"codec_type":"subtitle","codec_name":"mov_text"}
      ]
    }
    "#;

    #[derive(Debug)]
    struct FakeRunner {
        stdout: String,
        status: i32,
        stderr: String,
        calls: RefCell<Vec<(String, Vec<String>)>>,
    }

    impl FakeRunner {
        fn successful(stdout: &str) -> Self {
            Self {
                stdout: stdout.to_owned(),
                status: 0,
                stderr: String::new(),
                calls: RefCell::new(Vec::new()),
            }
        }

        fn successful_with_stderr(stdout: &str, stderr: &str) -> Self {
            Self {
                stdout: stdout.to_owned(),
                status: 0,
                stderr: stderr.to_owned(),
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl CommandRunner for FakeRunner {
        fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, MediaError> {
            self.calls
                .borrow_mut()
                .push((program.to_owned(), args.to_vec()));
            Ok(CommandOutput {
                status: self.status,
                stdout: self.stdout.clone(),
                stderr: self.stderr.clone(),
            })
        }
    }

    #[test]
    fn probes_mp4_video_and_audio_fields_without_running_ffprobe() {
        let runner = FakeRunner::successful(MP4_JSON);

        let actual = probe_media(&runner, "/input/movie.mp4").expect("MP4 should probe");

        assert_eq!(
            actual,
            MediaInfo {
                path: "/input/movie.mp4".to_owned(),
                file_name: "movie.mp4".to_owned(),
                container: "mp4".to_owned(),
                duration_seconds: 12.5,
                size_bytes: 4096,
                source_quality: crate::domain::media::SourceQualityAssessment {
                    status: SourceQualityStatus::LossySource,
                    summary: "Source uses a lossy audio codec".to_owned(),
                    evidence: vec!["Audio codec: aac".to_owned()],
                },
                video_streams: vec![VideoStreamInfo {
                    codec: "h264".to_owned(),
                    stream_index: 0,
                    width: 1920,
                    height: 1080,
                    frame_rate: "30000/1001".to_owned(),
                }],
                audio_streams: vec![AudioStreamInfo {
                    codec: "aac".to_owned(),
                    stream_index: 1,
                    sample_rate_hz: 48_000,
                    channels: 2,
                }],
                subtitle_streams: vec![],
            }
        );
        assert_eq!(runner.calls.borrow().len(), 1);
        assert_eq!(runner.calls.borrow()[0].0, "ffprobe");
        assert_eq!(
            runner.calls.borrow()[0].1.last(),
            Some(&"/input/movie.mp4".to_owned())
        );
    }

    #[test]
    fn normalizes_real_style_mp4_format_name_to_mp4_container() {
        let actual = probe_media(
            &FakeRunner::successful(REAL_STYLE_MP4_JSON),
            "/input/movie.mp4",
        )
        .expect("real-style MP4 metadata should probe");

        assert_eq!(actual.container, "mp4");
    }

    #[test]
    fn disambiguates_real_style_mov_format_name_using_mov_extension() {
        let actual = probe_media(
            &FakeRunner::successful(REAL_STYLE_MP4_JSON),
            "/input/movie.mov",
        )
        .expect("real-style MOV metadata should probe");

        assert_eq!(actual.container, "mov");
    }

    #[test]
    fn disambiguates_real_style_m4a_format_name_using_m4a_extension() {
        let actual = probe_media(
            &FakeRunner::successful(REAL_STYLE_MP4_JSON),
            "/input/audio.m4a",
        )
        .expect("real-style M4A metadata should probe");

        assert_eq!(actual.container, "m4a");
    }

    #[test]
    fn preserves_explicit_mp4_mov_and_m4a_container_names() {
        for (format_name, extension) in [("mp4", "mp4"), ("mov", "mov"), ("m4a", "m4a")] {
            let json = REAL_STYLE_MP4_JSON
                .replace("\"mov,mp4,m4a,3gp,3g2,mj2\"", &format!("\"{format_name}\""));
            let actual = probe_media(
                &FakeRunner::successful(&json),
                format!("/input/media.{extension}"),
            )
            .expect("explicit container metadata should probe");

            assert_eq!(actual.container, format_name);
        }
    }

    #[test]
    fn disambiguates_matroska_webm_composite_using_mkv_and_webm_extensions() {
        let json = REAL_STYLE_MP4_JSON.replace("\"mov,mp4,m4a,3gp,3g2,mj2\"", "\"matroska,webm\"");

        let mkv = probe_media(&FakeRunner::successful(&json), "/input/movie.mkv")
            .expect("MKV metadata should probe");
        let webm = probe_media(&FakeRunner::successful(&json), "/input/movie.webm")
            .expect("WebM metadata should probe");

        assert_eq!(mkv.container, "matroska");
        assert_eq!(webm.container, "webm");
    }

    #[test]
    fn rejects_unknown_data_attachment_and_stream_types_instead_of_dropping_them() {
        for stream_type in ["data", "attachment", "unknown"] {
            let json = UNKNOWN_STREAM_JSON.replace("\"data\"", &format!("\"{stream_type}\""));
            let error = probe_media(&FakeRunner::successful(&json), "/input/movie.mp4")
                .expect_err("unsupported stream types must not be dropped");

            assert_eq!(error.code, "unsupported_streams");
            assert!(error.message.contains(stream_type));
        }
    }

    #[test]
    fn rejects_zero_dimensions_channels_and_sample_rates() {
        let invalid_dimensions = MP4_JSON.replace("\"width\":1920", "\"width\":0");
        let invalid_channels = WAV_JSON.replace("\"channels\":2", "\"channels\":0");
        let invalid_sample_rate = WAV_JSON.replace("\"sample_rate\":44100", "\"sample_rate\":0");

        for (json, field) in [
            (invalid_dimensions, "width"),
            (invalid_channels, "channels"),
            (invalid_sample_rate, "sample_rate"),
        ] {
            let error = probe_media(&FakeRunner::successful(&json), "/input/media")
                .expect_err("zero metadata values must be rejected");

            assert_eq!(error.code, "probe_invalid_field");
            assert!(error.message.contains(field));
        }
    }

    #[test]
    fn rejects_zero_and_non_numeric_frame_rates() {
        for frame_rate in ["0/0", "0", "not-a-rate", "-30/-1", "1001/1"] {
            let json = MP4_JSON.replace("\"30000/1001\"", &format!("\"{frame_rate}\""));
            let error = probe_media(&FakeRunner::successful(&json), "/input/movie.mp4")
                .expect_err("invalid frame rates must be rejected");

            assert_eq!(error.code, "probe_invalid_field");
            assert!(error.message.contains("frame rate"));
        }
    }

    #[test]
    fn rejects_ambiguous_composite_format_without_known_extension() {
        let error = probe_media(
            &FakeRunner::successful(REAL_STYLE_MP4_JSON),
            "/input/media.bin",
        )
        .expect_err("ambiguous composite format should not be guessed");

        assert_eq!(error.code, "unknown_container");
    }

    #[test]
    fn rejects_composite_container_with_extra_names_instead_of_matching_fragments() {
        let json = REAL_STYLE_MP4_JSON.replace(
            "\"mov,mp4,m4a,3gp,3g2,mj2\"",
            "\"mov,mp4,m4a,3gp,3g2,mj2,custom\"",
        );
        let error = probe_media(&FakeRunner::successful(&json), "/input/movie.mp4")
            .expect_err("arbitrary composite names must not be accepted by fragment matching");

        assert_eq!(error.code, "unknown_container");
    }

    #[test]
    fn probes_wav_pcm_and_flac_audio() {
        let wav = probe_media(&FakeRunner::successful(WAV_JSON), "/input/voice.wav")
            .expect("WAV should probe");
        let flac = probe_media(&FakeRunner::successful(FLAC_JSON), "/input/voice.flac")
            .expect("FLAC should probe");

        assert_eq!(wav.container, "wav");
        assert_eq!(wav.audio_streams[0].codec, "pcm_s16le");
        assert_eq!(wav.audio_streams[0].sample_rate_hz, 44_100);
        assert_eq!(flac.container, "flac");
        assert_eq!(flac.audio_streams[0].codec, "flac");
        assert_eq!(wav.source_quality.status, SourceQualityStatus::Unknown);
        assert_eq!(flac.source_quality.status, SourceQualityStatus::Unknown);
    }

    #[test]
    fn reports_suspicious_lossy_encoder_metadata_for_a_lossless_container() {
        let actual = probe_media(
            &FakeRunner::successful(LOSSLESS_WITH_SUSPICIOUS_TAG_JSON),
            "/input/voice.flac",
        )
        .expect("FLAC with encoder metadata should probe");

        assert_eq!(
            actual.source_quality.status,
            SourceQualityStatus::PossiblyTranscodedLossy
        );
        assert!(actual
            .source_quality
            .evidence
            .iter()
            .any(|evidence| evidence.contains("LAME")));
    }

    #[test]
    fn reports_likely_native_lossless_when_spectral_rolloff_is_wide() {
        let spectral_output = (0..6)
            .map(|frame| format!("frame:{frame}\n lavfi.aspectralstats.1.rolloff=40000"))
            .collect::<Vec<_>>()
            .join("\n");
        let actual = probe_media(
            &FakeRunner::successful_with_stderr(FLAC_JSON, &spectral_output),
            "/input/voice.flac",
        )
        .expect("FLAC with spectral evidence should probe");

        assert_eq!(
            actual.source_quality.status,
            SourceQualityStatus::LikelyNativeLossless
        );
    }

    #[test]
    fn probes_multiple_audio_tracks_and_subtitle_presence() {
        let actual = probe_media(
            &FakeRunner::successful(MULTI_AUDIO_MP4_JSON),
            "/input/multi.mp4",
        )
        .expect("multi-track MP4 should probe");

        assert_eq!(actual.audio_streams.len(), 2);
        assert_eq!(actual.audio_streams[0].stream_index, 1);
        assert_eq!(actual.audio_streams[1].stream_index, 2);
        assert_eq!(
            actual.subtitle_streams,
            vec![SubtitleStreamInfo {
                codec: "mov_text".to_owned(),
                stream_index: 3,
            }]
        );
    }

    #[test]
    fn malformed_json_returns_structured_error() {
        let error = probe_media(&FakeRunner::successful("{not-json"), "/input/broken.mp4")
            .expect_err("malformed JSON should fail");

        assert_eq!(error.code, "probe_invalid_json");
        assert!(error.details.is_some());
    }

    #[test]
    fn missing_required_format_field_returns_structured_error() {
        let error = probe_media(
            &FakeRunner::successful(
                r#"{"format":{"format_name":"mp4","duration":"1","size":"2"},"streams":[{"index":0,"codec_type":"audio","codec_name":"aac","channels":2}]}"#,
            ),
            "/input/missing.mp4",
        )
        .expect_err("missing sample rate should fail");

        assert_eq!(error.code, "probe_missing_field");
        assert!(error.message.contains("sample_rate"));
    }

    #[test]
    fn failed_ffprobe_returns_structured_error() {
        let runner = FakeRunner {
            stdout: String::new(),
            status: 1,
            stderr: "No such file".to_owned(),
            calls: RefCell::new(Vec::new()),
        };

        let error = probe_media(&runner, "/input/missing.mp4").expect_err("ffprobe failure");

        assert_eq!(error.code, "probe_command_failed");
        assert_eq!(error.details.as_deref(), Some("No such file"));
    }
}

#[cfg(all(test, unix))]
mod process_runner_tests {
    use std::fs;
    // Each of these three is consumed only by the linux-gated parked-read test below, so
    // ungated they are unused imports on macOS and `clippy --all-targets -- -D warnings`
    // goes red there (same Ruling 8 shape as the gated constants further down).
    #[cfg(target_os = "linux")]
    use std::fs::OpenOptions;
    #[cfg(target_os = "linux")]
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    #[cfg(target_os = "linux")]
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use super::{CommandRunner, ProcessCommandRunner};
    use crate::media::tools::{target_directory, ToolLocator};

    // A script written and then immediately exec'd can hit ETXTBSY: the loader still
    // holds the file open while the kernel refuses to map it as a program. The guard
    // line lets each fixture be primed with one harmless exec first. Same race and the
    // same remedy as the fixture helper in src-tauri/src/jobs/runner.rs's tests.
    const PRIME_ARGUMENT: &str = "--prime";
    const ETXTBSY: i32 = 26;

    fn fixture_directory(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("lumaflow-probe-{name}-{}", std::process::id()));
        // A panicking test leaves its fixture directory behind, and a later run that
        // reuses the same PID would inherit those files, so each test starts empty.
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("probe test directory should be creatable");
        directory
    }

    fn prime_before_exec(path: &Path) {
        for _ in 0..10 {
            match Command::new(path).arg(PRIME_ARGUMENT).status() {
                Ok(_) => return,
                Err(error) if error.raw_os_error() == Some(ETXTBSY) => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("fixture should be executable: {error}"),
            }
        }
        panic!("fixture stayed unexecutable: {}", path.display());
    }

    /// Writes a POSIX-sh fixture tool exactly where `ToolLocator` looks for it.
    fn fake_tool(directory: &Path, tool: &str, body: &str) -> PathBuf {
        let bin_directory = directory.join("binaries").join(target_directory());
        fs::create_dir_all(&bin_directory).expect("fixture binary directory should be creatable");
        let path = bin_directory.join(tool);
        fs::write(
            &path,
            format!(
                "#!/bin/sh\nif [ \"$1\" = {PRIME_ARGUMENT} ] && [ \"$#\" -eq 1 ]; then exit 0; fi\n{body}\n"
            ),
        )
        .expect("fixture tool should be writable");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .expect("fixture tool should be chmod-able");
        prime_before_exec(&path);
        path
    }

    fn runner_for(directory: &Path) -> ProcessCommandRunner {
        let tools = ToolLocator::bundled();
        tools.set_resource_dir(directory);
        ProcessCommandRunner::with_tools(tools)
    }

    #[test]
    fn captures_stdout_stderr_and_status_from_a_completed_child() {
        let directory = fixture_directory("output-capture");
        fake_tool(
            &directory,
            "ffprobe",
            "printf 'probe-json\\n'; printf 'probe-error\\n' >&2; exit 3",
        );
        let output = runner_for(&directory)
            .run("ffprobe", &["-v".to_owned(), "error".to_owned()])
            .expect("a completed child should produce a command output");

        assert_eq!(output.status, 3, "the child's exit code must survive");
        assert_eq!(output.stdout, "probe-json\n");
        assert_eq!(output.stderr, "probe-error\n");
        fs::remove_dir_all(&directory).expect("probe fixture should be removable");
    }

    // The injected window and poll interval live here because this is the task that first
    // consumes them: a constant nothing uses yet is a dead-code warning under
    // `clippy --all-targets -- -D warnings`. Both are linux-gated because their only
    // consumers are the linux-gated helper and test below — ungated they would be dead
    // constants on macOS and trip the same gate there.
    #[cfg(target_os = "linux")]
    const STALL_WINDOW: Duration = Duration::from_millis(300);
    #[cfg(target_os = "linux")]
    const POLL_INTERVAL: Duration = Duration::from_millis(50);

    #[cfg(target_os = "linux")]
    fn runner_with_windows(
        directory: &Path,
        stall_timeout: Duration,
        poll_interval: Duration,
    ) -> ProcessCommandRunner {
        runner_for(directory).with_stall_deadlines(stall_timeout, poll_interval)
    }

    #[test]
    fn captures_empty_streams_from_a_child_that_writes_nothing() {
        // The other half of the guard Task 1 started, added here because this is the task
        // that replaces `Command::output()` with `spawn()` plus two drain threads: a real
        // `ffprobe -v error` on a clean file writes nothing at all, so the rewrite must
        // return empty vectors — not a truncated read, not a hang on a pipe nobody wrote.
        let directory = fixture_directory("probe-quiet");
        fake_tool(&directory, "ffprobe", "exit 0");
        let output = runner_for(&directory)
            .run("ffprobe", &["-v".to_owned(), "error".to_owned()])
            .expect("a quiet child is still a completed probe");

        assert_eq!(output.status, 0, "a clean exit must survive");
        assert!(output.stdout.is_empty(), "stdout: {:?}", output.stdout);
        assert!(output.stderr.is_empty(), "stderr: {:?}", output.stderr);
        fs::remove_dir_all(&directory).expect("probe fixture should be removable");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stops_a_probe_child_that_stops_reading() {
        // `exec` replaces the shell with an idle process: the watched child stays alive,
        // reads nothing and burns nothing, which is the shape of ffprobe blocked in
        // open() on a FIFO nobody writes to. The sleep is bounded so the pre-watchdog
        // red run fails in 20 s rather than forever.
        let directory = fixture_directory("probe-stall");
        fake_tool(&directory, "ffprobe", "exec sleep 20");
        let started = std::time::Instant::now();
        let error = runner_with_windows(&directory, STALL_WINDOW, POLL_INTERVAL)
            .run("ffprobe", &["-v".to_owned(), "error".to_owned()])
            .expect_err("a probe child that reads nothing should be stopped");

        assert_eq!(
            error.code, "probe_stalled",
            "error details: {:?}",
            error.details
        );
        assert!(error.message.contains("stopped"), "error message: {error}");
        assert!(
            error
                .details
                .as_deref()
                .unwrap_or_default()
                .contains("program=ffprobe"),
            "error details: {:?}",
            error.details
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the watchdog should act inside its window, took {:?}",
            started.elapsed()
        );
        fs::remove_dir_all(&directory).expect("probe fixture should be removable");
    }

    // Gated like the constants above: its only caller is the linux-gated test below, so
    // ungated it would be dead code on macOS and trip `clippy --all-targets -- -D warnings`.
    #[cfg(target_os = "linux")]
    fn make_fifo(directory: &Path, name: &str) -> PathBuf {
        let path = directory.join(name);
        let status = Command::new("mkfifo")
            .arg(&path)
            .status()
            .expect("mkfifo should be runnable");
        assert!(status.success(), "mkfifo should succeed");
        path
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stops_a_probe_child_parked_midway_through_a_read() {
        // The real hang shape: a FIFO fed once, with the write end held open so the
        // reader never sees EOF. The child reads 64 KiB and then parks inside read().
        // The writer is this test process, so there is no orphan holding the FIFO.
        let directory = fixture_directory("probe-parked-read");
        let fifo = make_fifo(&directory, "silent.fifo");
        fake_tool(
            &directory,
            "ffprobe",
            &format!("exec cat '{}'", fifo.display()),
        );

        let (keep_open_tx, keep_open_rx) = mpsc::channel::<()>();
        let writer_fifo = fifo.clone();
        let writer = thread::spawn(move || {
            // O_RDWR, not O_WRONLY: opening a FIFO's write end blocks until a reader
            // exists, so if the watchdog killed the child before it opened the FIFO the
            // writer would sit in open() forever and hang the test. O_RDWR returns at
            // once and still holds a write end open, so the child reads 64 KiB and then
            // parks instead of seeing EOF — the hang shape is unchanged.
            let mut handle = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&writer_fifo)
                .expect("the FIFO write end should open");
            let _ = handle.write_all(&[7_u8; 64 * 1024]);
            // Hold the write end until the runner finishes, otherwise the child sees EOF.
            let _ = keep_open_rx.recv();
        });

        let started = std::time::Instant::now();
        let error = runner_with_windows(&directory, STALL_WINDOW, POLL_INTERVAL)
            .run("ffprobe", &["-v".to_owned(), "error".to_owned()])
            .expect_err("a child parked inside read() should be stopped");
        let _ = keep_open_tx.send(());
        writer.join().expect("the FIFO writer should finish");

        assert_eq!(
            error.code, "probe_stalled",
            "error details: {:?}",
            error.details
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the watchdog should act inside its window, took {:?}",
            started.elapsed()
        );
        fs::remove_dir_all(&directory).expect("probe fixture should be removable");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn keeps_a_probe_child_that_keeps_reading_bytes() {
        // Slow but genuinely progressing: 4 KiB every 40 ms for 400 ms, which is longer
        // than the 300 ms stall window. Every poll sees the counters move, so the child
        // must run to its natural exit and its whole stdout must arrive.
        let directory = fixture_directory("probe-reading");
        let fifo = make_fifo(&directory, "steady.fifo");
        fake_tool(
            &directory,
            "ffprobe",
            &format!("exec cat '{}'", fifo.display()),
        );

        let writer_fifo = fifo.clone();
        let writer = thread::spawn(move || {
            // O_RDWR, not O_WRONLY: opening a FIFO's write end blocks until a reader
            // exists, so if the watchdog killed the child first the writer would sit in
            // open() forever and `writer.join()` would hang this test. O_RDWR returns at
            // once and the writes still land in the pipe; dropping the handle at the end
            // of the closure is what closes the write end so cat reaches EOF and exits 0.
            let mut handle = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&writer_fifo)
                .expect("the FIFO write end should open");
            for _ in 0..10 {
                if handle.write_all(&[9_u8; 4 * 1024]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(40));
            }
            // Closing the write end is what lets cat reach EOF and exit 0.
        });

        let output = runner_with_windows(&directory, STALL_WINDOW, POLL_INTERVAL)
            .run("ffprobe", &["-v".to_owned(), "error".to_owned()])
            .expect("a child that keeps reading must not be stopped");
        writer.join().expect("the FIFO writer should finish");

        assert_eq!(output.status, 0, "stderr: {}", output.stderr);
        assert_eq!(
            output.stdout.len(),
            10 * 4 * 1024,
            "every byte must be captured"
        );
        fs::remove_dir_all(&directory).expect("probe fixture should be removable");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn keeps_a_probe_child_that_burns_cpu_without_reading() {
        // The decode/filters phase of a probe: everything is already read and the child
        // only computes. A pure-builtin shell loop burns CPU in the watched pid itself
        // (dash runs about 1.25 M iterations per second, so 500 000 is ~0.4 s here and
        // only slower, never shorter, on a shared runner). `exec` keeps the same pid, so
        // the counters being sampled are the counters doing the work.
        let directory = fixture_directory("probe-computing");
        fake_tool(
            &directory,
            "ffprobe",
            "exec sh -c 'i=0; while [ $i -lt 500000 ]; do i=$((i+1)); done'",
        );

        // A tighter window than the other tests use: the fixture's runtime is a property of
        // the machine's core, and a 300 ms window would silently stop exercising the kill
        // decision on a core fast enough to finish the loop inside it. 150 ms over a 25 ms
        // poll keeps the "window > 2 × poll" rule the production constructor asserts.
        let output = runner_with_windows(
            &directory,
            Duration::from_millis(150),
            Duration::from_millis(25),
        )
        .run("ffprobe", &["-v".to_owned(), "error".to_owned()])
        .expect("a child that is computing must not be stopped");

        assert_eq!(output.status, 0, "stderr: {}", output.stderr);
        fs::remove_dir_all(&directory).expect("probe fixture should be removable");
    }
}

#[cfg(all(test, target_os = "linux"))]
mod activity_tests {
    use super::{parse_io_field, parse_stat_cpu, read_activity_sample, ActivitySample};

    // The exact field set of a real /proc/<pid>/io (verified against a live one).
    const IO_TEXT: &str = "rchar: 1048576\nwchar: 4096\nsyscr: 8\nsyscw: 999\n\
        read_bytes: 0\nwrite_bytes: 0\ncancelled_write_bytes: 0\n";

    // utime is field 14 and stime field 15, but the comm field (2) may contain spaces
    // and parentheses, so the parse must count from the last ')'. In this line utime=123
    // and stime=45.
    const STAT_TEXT: &str = "1234 (ffprobe (odd) name) S 1 1234 1234 0 -1 4207616 100 0 \
        0 0 123 45 0 0 20 0 1 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \
        0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 \n";

    #[test]
    fn parses_io_counters_without_matching_a_similarly_named_field() {
        assert_eq!(parse_io_field(IO_TEXT, "rchar"), Some(1_048_576));
        assert_eq!(parse_io_field(IO_TEXT, "syscr"), Some(8));
        assert_eq!(parse_io_field(IO_TEXT, "wchar"), Some(4096));
        assert_eq!(parse_io_field(IO_TEXT, "syscw"), Some(999));
        // A prefix of a real key must not match it. `wchar` is the near-miss for `rchar`
        // and `syscw` for `syscr`, so a parse that matches loosely returns the wrong
        // counter — and a wrong counter is a wrong watchdog decision.
        assert_eq!(parse_io_field(IO_TEXT, "rcha"), None);
        assert_eq!(parse_io_field(IO_TEXT, "sysc"), None);
        assert_eq!(parse_io_field(IO_TEXT, "absent"), None);
    }

    #[test]
    fn parses_cpu_ticks_from_a_stat_line_whose_command_contains_parentheses() {
        assert_eq!(parse_stat_cpu(STAT_TEXT), Some(168));
        assert_eq!(parse_stat_cpu("1234 (x) S"), None);
    }

    #[test]
    fn a_sample_progresses_when_any_counter_moves_but_not_when_all_are_frozen() {
        let previous = ActivitySample {
            read_bytes: 1_000,
            read_calls: 4,
            cpu_ticks: 10,
        };
        let frozen = ActivitySample {
            read_bytes: 1_000,
            read_calls: 4,
            cpu_ticks: 10,
        };
        let reading = ActivitySample {
            read_bytes: 1_001,
            read_calls: 4,
            cpu_ticks: 10,
        };
        let counting = ActivitySample {
            read_bytes: 1_000,
            read_calls: 5,
            cpu_ticks: 10,
        };
        // A child whose input is already fully read and whose filters are decoding burns
        // CPU without reading a byte. That is activity, not a stall.
        let computing = ActivitySample {
            read_bytes: 1_000,
            read_calls: 4,
            cpu_ticks: 11,
        };

        assert!(!frozen.progressed_since(&previous));
        assert!(reading.progressed_since(&previous));
        assert!(counting.progressed_since(&previous));
        assert!(computing.progressed_since(&previous));
    }

    #[test]
    fn a_child_that_is_gone_reports_an_error_instead_of_a_sample() {
        // u32::MAX is not a valid pid on any Linux box (pid_max tops out near 4 million),
        // so this is a guaranteed ENOENT. The watchdog must treat an unreadable child as
        // "do not act", never as "stalled".
        let error = read_activity_sample(u32::MAX)
            .expect_err("a pid that does not exist should not produce a sample");
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }
}
