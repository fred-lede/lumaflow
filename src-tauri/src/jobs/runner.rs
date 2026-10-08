use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::domain::job::{JobError, JobEvent};

use super::progress::{ProgressParser, ProgressUpdate};
use super::scheduler::{CancellationToken, EventSink, JobExecution, JobExecutor};
use super::temp_output::TempOutput;

pub struct FfmpegRunner {
    program: OsString,
}

impl FfmpegRunner {
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
        }
    }

    pub fn system() -> Self {
        Self::new("ffmpeg")
    }

    pub fn run(
        &self,
        execution: JobExecution,
        cancellation: CancellationToken,
        emit: EventSink,
    ) -> Result<(), JobError> {
        if cancellation.is_cancelled() {
            return Err(cancelled_error());
        }
        if paths_match(Path::new(&execution.job.source_path), &execution.plan.output_path) {
            return Err(JobError {
                code: "path_collision".to_owned(),
                message: "The output path must not overwrite the source path".to_owned(),
                details: None,
            });
        }

        let mut temp = TempOutput::create(&execution.plan.output_path).map_err(|error| io_error(
            "temp_output_create_failed",
            "Could not create a temporary output",
            error,
        ))?;
        let mut args = execution.plan.ffmpeg_args.clone();
        let planned_output = args.pop().ok_or_else(|| JobError {
            code: "invalid_ffmpeg_arguments".to_owned(),
            message: "The conversion plan did not contain an output path".to_owned(),
            details: None,
        })?;
        if PathBuf::from(planned_output) != execution.plan.output_path {
            return Err(JobError {
                code: "invalid_ffmpeg_arguments".to_owned(),
                message: "The conversion plan output argument did not match its output path".to_owned(),
                details: None,
            });
        }
        if cancellation.is_cancelled() {
            return Err(cancelled_error());
        }
        temp.release();
        args.extend([
            OsString::from("-progress"),
            OsString::from("pipe:1"),
            OsString::from("-nostats"),
            OsString::from("-y"),
            temp.path().as_os_str().to_owned(),
        ]);

        let mut child = Command::new(&self.program)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| io_error("ffmpeg_spawn_failed", "Could not start FFmpeg", error))?;

        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                stop_child(&mut child);
                return Err(JobError {
                    code: "ffmpeg_output_failed".to_owned(),
                    message: "FFmpeg did not provide a progress stream".to_owned(),
                    details: None,
                });
            }
        };
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                stop_child(&mut child);
                return Err(JobError {
                    code: "ffmpeg_output_failed".to_owned(),
                    message: "FFmpeg did not provide an error stream".to_owned(),
                    details: None,
                });
            }
        };

        let (progress_tx, progress_rx) = mpsc::channel::<String>();
        let progress_thread = thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if progress_tx.send(line).is_err() {
                    break;
                }
            }
        });
        let stderr_thread = thread::spawn(move || read_stderr(stderr));

        let mut parser = ProgressParser::new(execution.job.media.duration_seconds);
        let status = loop {
            if cancellation.is_cancelled() {
                stop_child(&mut child);
                let _ = progress_thread.join();
                let _ = stderr_thread.join();
                return Err(cancelled_error());
            }

            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => match progress_rx.recv_timeout(Duration::from_millis(25)) {
                    Ok(line) => emit_progress(&execution.job.id, &mut parser, &line, &emit),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {}
                },
                Err(error) => {
                    stop_child(&mut child);
                    let _ = progress_thread.join();
                    let _ = stderr_thread.join();
                    return Err(io_error("ffmpeg_wait_failed", "Could not wait for FFmpeg", error));
                }
            }
        };

        let _ = progress_thread.join();
        while let Ok(line) = progress_rx.try_recv() {
            emit_progress(&execution.job.id, &mut parser, &line, &emit);
        }
        let stderr = stderr_thread.join().unwrap_or_else(|_| "FFmpeg stderr reader failed".to_owned());

        if cancellation.is_cancelled() {
            return Err(cancelled_error());
        }
        if !status.success() {
            return Err(JobError {
                code: "ffmpeg_failed".to_owned(),
                message: format!("FFmpeg exited with status {}", status.code().unwrap_or(-1)),
                details: nonempty_details(&stderr),
            });
        }

        temp.commit().map(|_| ()).map_err(|error| {
            io_error(
                "output_commit_failed",
                "Could not commit the converted output",
                error,
            )
        })
    }
}

impl JobExecutor for FfmpegRunner {
    fn execute(
        &self,
        execution: JobExecution,
        cancellation: CancellationToken,
        emit: EventSink,
    ) -> Result<(), JobError> {
        self.run(execution, cancellation, emit)
    }
}

fn emit_progress(
    job_id: &str,
    parser: &mut ProgressParser,
    line: &str,
    emit: &Arc<dyn Fn(JobEvent) + Send + Sync + 'static>,
) {
    let update = parser.feed_line(line);
    let progress = match update {
        Some(ProgressUpdate::Value(progress)) => progress,
        Some(ProgressUpdate::Complete) => 1.0,
        None => return,
    };
    emit(JobEvent::Progress {
        job_id: job_id.to_owned(),
        progress,
    });
}

fn read_stderr(mut stderr: impl Read) -> String {
    let mut output = Vec::new();
    let _ = stderr.read_to_end(&mut output);
    String::from_utf8_lossy(&output).trim().to_owned()
}

fn io_error(code: &str, message: &str, error: impl std::fmt::Display) -> JobError {
    JobError {
        code: code.to_owned(),
        message: message.to_owned(),
        details: Some(error.to_string()),
    }
}

fn nonempty_details(stderr: &str) -> Option<String> {
    (!stderr.is_empty()).then(|| stderr.to_owned())
}

fn cancelled_error() -> JobError {
    JobError {
        code: "cancelled".to_owned(),
        message: "The conversion was cancelled".to_owned(),
        details: None,
    }
}

fn stop_child(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn paths_match(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => lexical_path(left) == lexical_path(right),
    }
}

fn lexical_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir | Component::Normal(_) => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use crate::domain::job::{JobEvent, JobState, ProcessingKind, QueueJob};
    use crate::domain::media::{MediaInfo, OutputFormat, OutputSettings, QualityPreset};
    use crate::media::planner::ConversionPlan;

    use super::{CancellationToken, FfmpegRunner, JobExecution};

    fn fixture_directory(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "lumaflow-runner-{name}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("runner test directory should be creatable");
        directory
    }

    fn fake_program(directory: &PathBuf, body: &str) -> PathBuf {
        let path = directory.join("fake-ffmpeg.sh");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("fake program should be writable");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .expect("fake program should be executable");
        path
    }

    fn execution(directory: &PathBuf) -> JobExecution {
        let source = directory.join("source.wav");
        let output = directory.join("result.flac");
        fs::write(&source, b"source").expect("source should be writable");
        JobExecution {
            job: QueueJob {
                id: "runner-job".to_owned(),
                source_path: source.to_string_lossy().into_owned(),
                media: MediaInfo {
                    path: source.to_string_lossy().into_owned(),
                    file_name: "source.wav".to_owned(),
                    container: "wav".to_owned(),
                    duration_seconds: 2.0,
                    size_bytes: 6,
                    video_streams: vec![],
                    audio_streams: vec![],
                    subtitle_streams: vec![],
                },
                output_settings: OutputSettings {
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
                },
                processing_kind: Some(ProcessingKind::LosslessAudio {
                    label: "Lossless audio".to_owned(),
                }),
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
                output_path: output,
                ffmpeg_args: vec![
                    "-i".into(),
                    source.to_string_lossy().into_owned().into(),
                    directory.join("result.flac").to_string_lossy().into_owned().into(),
                ],
            },
        }
    }

    #[test]
    fn executes_with_separate_arguments_and_emits_progress() {
        let directory = fixture_directory("success");
        let program = fake_program(
            &directory,
            "out=\"\"; for arg in \"$@\"; do out=\"$arg\"; done; printf 'out_time_us=500000\\nprogress=continue\\nprogress=end\\n'; printf 'converted' > \"$out\"",
        );
        let execution = execution(&directory);
        let output = execution.plan.output_path.clone();
        let events = Arc::new(Mutex::new(Vec::new()));
        let event_sink = {
            let events = Arc::clone(&events);
            Arc::new(move |event| {
                events
                    .lock()
                    .expect("event lock should succeed")
                    .push(event)
            })
        };

        FfmpegRunner::new(program)
            .run(execution, CancellationToken::new(), event_sink)
            .expect("fake FFmpeg should succeed");

        assert_eq!(fs::read(output).expect("final output should exist"), b"converted");
        assert!(events.lock().expect("event lock should succeed").iter().any(
            |event| matches!(event, JobEvent::Progress { progress, .. } if (*progress - 0.25).abs() < f64::EPSILON)
        ));
        fs::remove_dir_all(directory).expect("runner fixture should be removable");
    }

    #[test]
    fn maps_nonzero_exit_and_cleans_temporary_output() {
        let directory = fixture_directory("failure");
        let program = fake_program(
            &directory,
            "out=\"\"; for arg in \"$@\"; do out=\"$arg\"; done; printf 'partial' > \"$out\"; printf 'codec exploded\\n' >&2; exit 7",
        );
        let execution = execution(&directory);
        let output = execution.plan.output_path.clone();
        let error = FfmpegRunner::new(program)
            .run(execution, CancellationToken::new(), Arc::new(|_| {}))
            .expect_err("fake FFmpeg should fail");

        assert_eq!(error.code, "ffmpeg_failed");
        assert!(error
            .details
            .expect("stderr should be preserved")
            .contains("codec exploded"));
        assert!(!output.exists());
        assert_eq!(
            fs::read_dir(&directory)
                .expect("fixture should be readable")
                .count(),
            2
        );
        fs::remove_dir_all(directory).expect("runner fixture should be removable");
    }

    #[test]
    fn cancellation_kills_process_and_removes_partial_output() {
        let directory = fixture_directory("cancel");
        let program = fake_program(
            &directory,
            "out=\"\"; for arg in \"$@\"; do out=\"$arg\"; done; printf 'partial' > \"$out\"; printf 'out_time_us=500000\\nprogress=continue\\n'; while :; do :; done",
        );
        let execution = execution(&directory);
        let output = execution.plan.output_path.clone();
        let token = CancellationToken::new();
        let worker_token = token.clone();
        let worker = std::thread::spawn(move || {
            FfmpegRunner::new(program).run(execution, worker_token, Arc::new(|_| {}))
        });

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while fs::read_dir(&directory)
            .expect("fixture should be readable")
            .count()
            < 3
        {
            assert!(std::time::Instant::now() < deadline, "runner should create temp output");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        token.cancel();
        let error = worker.join().expect("runner thread should join").expect_err("run should cancel");

        assert_eq!(error.code, "cancelled");
        assert!(!output.exists());
        assert_eq!(fs::read_dir(&directory).expect("fixture should be readable").count(), 2);
        fs::remove_dir_all(directory).expect("runner fixture should be removable");
    }
}
