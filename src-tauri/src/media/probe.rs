use std::path::Path;

use serde_json::Value;

use crate::domain::media::{AudioStreamInfo, MediaInfo, SubtitleStreamInfo, VideoStreamInfo};

use super::MediaError;

pub struct CommandOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

pub trait CommandRunner {
    fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, MediaError>;
}

pub struct ProcessCommandRunner;

impl CommandRunner for ProcessCommandRunner {
    fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, MediaError> {
        let output = std::process::Command::new(program)
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

pub fn probe_media<R: CommandRunner>(runner: &R, path: impl AsRef<Path>) -> Result<MediaInfo, MediaError> {
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
    let container = super::resolve_container_name(
        &required_string(format, "format_name")?,
        &path_string,
    )?;
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
        .ok_or_else(|| MediaError::new("probe_invalid_path", "Media path has no valid file name"))?;

    Ok(MediaInfo {
        path: path_string,
        file_name: file_name.to_owned(),
        container,
        duration_seconds,
        size_bytes,
        video_streams,
        audio_streams,
        subtitle_streams,
    })
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
    let value = document
        .get(field)
        .ok_or_else(|| missing_field(field))?;
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
                (Some(numerator), Some(denominator))
                    if numerator > 0.0 && denominator > 0.0 =>
                {
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
    let value = document
        .get(field)
        .ok_or_else(|| missing_field(field))?;
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
    use crate::domain::media::{AudioStreamInfo, MediaInfo, SubtitleStreamInfo, VideoStreamInfo};

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
        assert_eq!(runner.calls.borrow()[0].1.last(), Some(&"/input/movie.mp4".to_owned()));
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
            let json = REAL_STYLE_MP4_JSON.replace(
                "\"mov,mp4,m4a,3gp,3g2,mj2\"",
                &format!("\"{format_name}\""),
            );
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
        let json = REAL_STYLE_MP4_JSON.replace(
            "\"mov,mp4,m4a,3gp,3g2,mj2\"",
            "\"matroska,webm\"",
        );

        let mkv = probe_media(
            &FakeRunner::successful(&json),
            "/input/movie.mkv",
        )
        .expect("MKV metadata should probe");
        let webm = probe_media(
            &FakeRunner::successful(&json),
            "/input/movie.webm",
        )
        .expect("WebM metadata should probe");

        assert_eq!(mkv.container, "matroska");
        assert_eq!(webm.container, "webm");
    }

    #[test]
    fn rejects_unknown_data_attachment_and_stream_types_instead_of_dropping_them() {
        for stream_type in ["data", "attachment", "unknown"] {
            let json = UNKNOWN_STREAM_JSON.replace("\"data\"", &format!("\"{stream_type}\""));
            let error = probe_media(
                &FakeRunner::successful(&json),
                "/input/movie.mp4",
            )
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
            let error = probe_media(
                &FakeRunner::successful(&json),
                "/input/media",
            )
            .expect_err("zero metadata values must be rejected");

            assert_eq!(error.code, "probe_invalid_field");
            assert!(error.message.contains(field));
        }
    }

    #[test]
    fn rejects_zero_and_non_numeric_frame_rates() {
        for frame_rate in ["0/0", "0", "not-a-rate", "-30/-1", "1001/1"] {
            let json = MP4_JSON.replace("\"30000/1001\"", &format!("\"{frame_rate}\""));
            let error = probe_media(
                &FakeRunner::successful(&json),
                "/input/movie.mp4",
            )
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
