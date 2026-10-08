#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::job::ProcessingKind;
    use crate::domain::media::{
        AudioStreamInfo, MediaInfo, OutputFormat, OutputSettings, QualityPreset, VideoStreamInfo,
    };

    fn settings(format: OutputFormat) -> OutputSettings {
        OutputSettings {
            output_directory: "/output".to_owned(),
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

    fn mp4_media() -> MediaInfo {
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
    }

    fn multi_audio_mp4() -> MediaInfo {
        let mut media = mp4_media();
        media.audio_streams.push(AudioStreamInfo {
            codec: "aac".to_owned(),
            stream_index: 2,
            sample_rate_hz: 44_100,
            channels: 2,
        });
        media
    }

    fn wav_media() -> MediaInfo {
        MediaInfo {
            path: "/input/voice.wav".to_owned(),
            file_name: "voice.wav".to_owned(),
            container: "wav".to_owned(),
            duration_seconds: 3.25,
            size_bytes: 8192,
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

    fn mp3_media() -> MediaInfo {
        MediaInfo {
            path: "/input/voice.mp3".to_owned(),
            file_name: "voice.mp3".to_owned(),
            container: "mp3".to_owned(),
            duration_seconds: 3.25,
            size_bytes: 8192,
            video_streams: vec![],
            audio_streams: vec![AudioStreamInfo {
                codec: "mp3".to_owned(),
                stream_index: 0,
                sample_rate_hz: 44_100,
                channels: 2,
            }],
            subtitle_streams: vec![],
        }
    }

    fn args(plan: &ConversionPlan) -> Vec<String> {
        plan.ffmpeg_args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn plans_mp4_to_mp4_as_lossless_remux_with_all_stream_maps() {
        let plan = plan_conversion(&mp4_media(), &settings(OutputFormat::Mp4))
            .expect("compatible MP4 should remux");

        assert!(matches!(
            plan.processing_kind,
            ProcessingKind::LosslessRemux { .. }
        ));
        assert_eq!(plan.output_path, std::path::PathBuf::from("/output/movie.mp4"));
        assert_eq!(
            args(&plan),
            vec![
                "-i", "/input/movie.mp4", "-map", "0:0", "-map", "0:1", "-c", "copy",
                "/output/movie.mp4"
            ]
        );
    }

    #[test]
    fn real_style_mp4_container_can_remux_to_mp4_when_streams_are_compatible() {
        let mut media = mp4_media();
        media.container = "mov,mp4,m4a,3gp,3g2,mj2".to_owned();

        let plan = plan_conversion(&media, &settings(OutputFormat::Mp4))
            .expect("real-style MP4 container should remux");

        assert!(matches!(
            plan.processing_kind,
            ProcessingKind::LosslessRemux { .. }
        ));
    }

    #[test]
    fn remux_maps_multiple_audio_tracks_and_subtitles_explicitly() {
        let plan = plan_conversion(&multi_audio_mp4(), &settings(OutputFormat::Mp4))
            .expect("compatible multi-track MP4 should remux");

        assert_eq!(
            args(&plan),
            vec![
                "-i", "/input/movie.mp4", "-map", "0:0", "-map", "0:1", "-map", "0:2", "-c",
                "copy", "/output/movie.mp4"
            ]
        );
    }

    #[test]
    fn plans_wav_pcm_to_flac_as_lossless_audio() {
        let plan = plan_conversion(&wav_media(), &settings(OutputFormat::Flac))
            .expect("PCM WAV should convert losslessly to FLAC");

        assert!(matches!(
            plan.processing_kind,
            ProcessingKind::LosslessAudio { .. }
        ));
        assert_eq!(
            args(&plan),
            vec![
                "-i", "/input/voice.wav", "-map", "0:0", "-c:a", "flac", "/output/voice.flac"
            ]
        );
    }

    #[test]
    fn plans_mp4_to_mp3_as_transcoding_and_maps_audio_only() {
        let plan = plan_conversion(&mp4_media(), &settings(OutputFormat::Mp3))
            .expect("MP4 to MP3 should transcode");

        assert!(matches!(
            plan.processing_kind,
            ProcessingKind::Transcoding { .. }
        ));
        assert_eq!(
            args(&plan),
            vec![
                "-i", "/input/movie.mp4", "-map", "0:1", "-c:a", "libmp3lame", "/output/movie.mp3"
            ]
        );
    }

    #[test]
    fn stream_setting_change_forces_transcoding() {
        let mut output = settings(OutputFormat::Mp4);
        output.width = Some(1280);

        let plan = plan_conversion(&mp4_media(), &output).expect("resize should transcode");

        assert!(matches!(
            plan.processing_kind,
            ProcessingKind::Transcoding { .. }
        ));
        assert!(args(&plan).contains(&"-vf".to_owned()));
        assert!(args(&plan).contains(&"scale=1280:-1".to_owned()));
    }

    #[test]
    fn same_container_mp3_with_compatible_audio_is_lossless_remux() {
        let plan = plan_conversion(&mp3_media(), &settings(OutputFormat::Mp3))
            .expect("compatible MP3 should remux");

        assert!(matches!(
            plan.processing_kind,
            ProcessingKind::LosslessRemux { .. }
        ));
        assert_eq!(
            args(&plan),
            vec!["-i", "/input/voice.mp3", "-map", "0:0", "-c", "copy", "/output/voice.mp3"]
        );
    }

    #[test]
    fn disabling_lossless_first_forces_transcoding_for_compatible_container() {
        let mut output = settings(OutputFormat::Mp4);
        output.lossless_first = false;

        let plan = plan_conversion(&mp4_media(), &output)
            .expect("explicit transcoding preference should remain supported");

        assert!(matches!(
            plan.processing_kind,
            ProcessingKind::Transcoding { .. }
        ));
        assert!(args(&plan).contains(&"libx264".to_owned()));
    }

    #[test]
    fn mp4_with_subtitles_is_not_labeled_as_lossless_remux() {
        let mut media = mp4_media();
        media.subtitle_streams.push(crate::domain::media::SubtitleStreamInfo {
            codec: "mov_text".to_owned(),
            stream_index: 2,
        });

        let error = plan_conversion(&media, &settings(OutputFormat::Mp4))
            .expect_err("the conservative MP4 matrix rejects subtitles");

        assert_eq!(error.code, "unsupported_conversion");
    }

    #[test]
    fn unsupported_container_returns_structured_error_instead_of_lossless_label() {
        let error = plan_conversion(&mp4_media(), &settings(OutputFormat::Webm))
            .expect_err("MP4 to WebM is not proven compatible");

        assert_eq!(error.code, "unsupported_conversion");
        assert!(error.message.contains("WebM"));
    }

    #[test]
    fn webm_with_video_settings_is_unsupported_without_an_invalid_codec_plan() {
        let mut output = settings(OutputFormat::Webm);
        output.width = Some(1280);

        let error = plan_conversion(&mp4_media(), &output)
            .expect_err("WebM codec mapping is not proven by the conservative planner");

        assert_eq!(error.code, "unsupported_conversion");
    }

    #[test]
    fn avi_with_video_settings_is_unsupported_without_an_invalid_codec_plan() {
        let mut output = settings(OutputFormat::Avi);
        output.frame_rate = Some("25/1".to_owned());

        let error = plan_conversion(&mp4_media(), &output)
            .expect_err("AVI codec mapping is not proven by the conservative planner");

        assert_eq!(error.code, "unsupported_conversion");
    }

    #[test]
    fn incompatible_source_streams_return_structured_error() {
        let mut media = mp4_media();
        media.video_streams[0].codec = "hevc".to_owned();

        let error = plan_conversion(&media, &settings(OutputFormat::Mp4))
            .expect_err("HEVC MP4 is not proven compatible by the MVP matrix");

        assert_eq!(error.code, "unsupported_conversion");
    }

    #[test]
    fn input_and_output_paths_are_distinct_arguments() {
        let plan = plan_conversion(&mp4_media(), &settings(OutputFormat::Mp3)).unwrap();
        let arguments = args(&plan);

        assert_eq!(arguments[0], "-i");
        assert_eq!(arguments[1], "/input/movie.mp4");
        assert_eq!(arguments.last(), Some(&"/output/movie.mp3".to_owned()));
        assert!(plan
            .ffmpeg_args
            .iter()
            .all(|argument| !argument.to_string_lossy().contains(" ")));
    }

}
use std::ffi::OsString;
use std::path::PathBuf;

use crate::domain::job::ProcessingKind;
use crate::domain::media::{MediaInfo, OutputFormat, OutputSettings};

use super::ffmpeg_args::{input_and_output_args, ArgumentMode};
use super::MediaError;

#[derive(Debug, Clone, PartialEq)]
pub struct ConversionPlan {
    pub processing_kind: ProcessingKind,
    pub output_path: PathBuf,
    pub ffmpeg_args: Vec<OsString>,
}

pub fn plan_conversion(
    media: &MediaInfo,
    settings: &OutputSettings,
) -> Result<ConversionPlan, MediaError> {
    let output_path = output_path(media, settings)?;
    let output_format = &settings.format;
    let mode = match output_format {
        format if normalized_container(&media.container) == format.container_name()
            && streams_fit_container(media, format)
            && !has_stream_setting_changes(settings)
            && settings.lossless_first => ProcessingMode::LosslessRemux(ArgumentMode::AllStreams),
        OutputFormat::Mp3 => {
            require_audio(media)?;
            ProcessingMode::Transcoding(ArgumentMode::FirstAudio)
        }
        OutputFormat::Flac
            if is_pcm_source(media)
                && !has_stream_setting_changes(settings)
                && settings.lossless_first =>
        {
            require_audio(media)?;
            ProcessingMode::LosslessAudio(ArgumentMode::FirstAudio)
        }
        OutputFormat::Flac if is_pcm_source(media) && !has_stream_setting_changes(settings) => {
            require_audio(media)?;
            ProcessingMode::Transcoding(ArgumentMode::FirstAudio)
        }
        format if normalized_container(&media.container) == format.container_name()
            && streams_fit_container(media, format)
            && !has_stream_setting_changes(settings) => ProcessingMode::Transcoding(if format.is_audio_only() {
                ArgumentMode::FirstAudio
            } else {
                ArgumentMode::TranscodeAll
            }),
        format
            if is_known_output(format)
                && has_stream_setting_changes(settings)
                && can_transcode_to(media, format) =>
        {
            require_media_stream(media)?;
            ProcessingMode::Transcoding(if format.is_audio_only() {
                ArgumentMode::FirstAudio
            } else {
                ArgumentMode::TranscodeAll
            })
        }
        _ => {
            return Err(MediaError::new(
                "unsupported_conversion",
                format!(
                    "The requested {} conversion is not proven compatible",
                    output_format.display_name()
                ),
            ));
        }
    };

    let processing_kind = mode.processing_kind();
    let ffmpeg_args = input_and_output_args(
        &media.path,
        &output_path.to_string_lossy(),
        &media.video_streams,
        &media.audio_streams,
        &media.subtitle_streams,
        settings,
        mode.argument_mode(),
    );

    Ok(ConversionPlan {
        processing_kind,
        output_path,
        ffmpeg_args,
    })
}

#[derive(Debug, Clone, Copy)]
enum ProcessingMode {
    LosslessRemux(ArgumentMode),
    LosslessAudio(ArgumentMode),
    Transcoding(ArgumentMode),
}

impl ProcessingMode {
    fn processing_kind(self) -> ProcessingKind {
        match self {
            Self::LosslessRemux(_) => ProcessingKind::LosslessRemux {
                label: "Lossless remux".to_owned(),
            },
            Self::LosslessAudio(_) => ProcessingKind::LosslessAudio {
                label: "Lossless audio".to_owned(),
            },
            Self::Transcoding(_) => ProcessingKind::Transcoding {
                label: "Transcoding".to_owned(),
            },
        }
    }

    fn argument_mode(self) -> ArgumentMode {
        match self {
            Self::LosslessRemux(mode) | Self::LosslessAudio(mode) | Self::Transcoding(mode) => mode,
        }
    }
}

fn output_path(media: &MediaInfo, settings: &OutputSettings) -> Result<PathBuf, MediaError> {
    let file_name = PathBuf::from(&media.file_name);
    let stem = file_name
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| MediaError::new("invalid_output_path", "Media file name has no valid stem"))?;
    Ok(PathBuf::from(&settings.output_directory)
        .join(format!("{stem}.{}", settings.format.extension())))
}

fn normalized_container(container: &str) -> &str {
    if container
        .split(',')
        .map(str::trim)
        .any(|name| name.eq_ignore_ascii_case("mp4"))
    {
        "mp4"
    } else {
        container.split(',').next().unwrap_or(container).trim()
    }
}

fn streams_fit_container(media: &MediaInfo, format: &OutputFormat) -> bool {
    match format {
        OutputFormat::Mp4 | OutputFormat::Mov | OutputFormat::M4a => {
            media.video_streams.iter().all(|stream| stream.codec == "h264")
                && media
                    .audio_streams
                    .iter()
                    .all(|stream| stream.codec == "aac" || stream.codec == "mp3")
                && media.subtitle_streams.is_empty()
        }
        OutputFormat::Mkv => true,
        OutputFormat::Wav => {
            media.video_streams.is_empty()
                && media.subtitle_streams.is_empty()
                && media
                    .audio_streams
                    .iter()
                    .all(|stream| stream.codec.starts_with("pcm_"))
        }
        OutputFormat::Flac => {
            media.video_streams.is_empty()
                && media.subtitle_streams.is_empty()
                && media.audio_streams.iter().all(|stream| stream.codec == "flac")
        }
        OutputFormat::Mp3 => {
            media.video_streams.is_empty()
                && media.subtitle_streams.is_empty()
                && !media.audio_streams.is_empty()
                && media.audio_streams.iter().all(|stream| stream.codec == "mp3")
        }
        _ => false,
    }
}

fn is_pcm_source(media: &MediaInfo) -> bool {
    normalized_container(&media.container) == "wav"
        && media.video_streams.is_empty()
        && media.subtitle_streams.is_empty()
        && !media.audio_streams.is_empty()
        && media
            .audio_streams
            .iter()
            .all(|stream| stream.codec.starts_with("pcm_"))
}

fn has_stream_setting_changes(settings: &OutputSettings) -> bool {
    settings.codec.is_some()
        || settings.bitrate_kbps.is_some()
        || settings.width.is_some()
        || settings.height.is_some()
        || settings.frame_rate.is_some()
        || settings.sample_rate_hz.is_some()
        || settings.channels.is_some()
        || settings.quality != crate::domain::media::QualityPreset::Original
}

fn require_audio(media: &MediaInfo) -> Result<(), MediaError> {
    if media.audio_streams.is_empty() {
        Err(MediaError::new(
            "unsupported_conversion",
            "The source has no audio stream for the requested output",
        ))
    } else {
        Ok(())
    }
}

fn require_media_stream(media: &MediaInfo) -> Result<(), MediaError> {
    if media.video_streams.is_empty() && media.audio_streams.is_empty() {
        Err(MediaError::new(
            "unsupported_conversion",
            "The source has no audio or video streams",
        ))
    } else {
        Ok(())
    }
}

fn is_known_output(format: &OutputFormat) -> bool {
    matches!(
        format,
        OutputFormat::Mp4
            | OutputFormat::Mov
            | OutputFormat::Mkv
            | OutputFormat::Webm
            | OutputFormat::Avi
            | OutputFormat::Mp3
            | OutputFormat::M4a
            | OutputFormat::Wav
            | OutputFormat::Flac
            | OutputFormat::Ogg
    )
}

fn can_transcode_to(media: &MediaInfo, format: &OutputFormat) -> bool {
    let has_video = !media.video_streams.is_empty();
    let has_audio = !media.audio_streams.is_empty();
    let has_subtitles = !media.subtitle_streams.is_empty();

    match format {
        OutputFormat::Mp4 | OutputFormat::Mov | OutputFormat::Mkv => {
            !has_subtitles && (has_video || has_audio)
        }
        OutputFormat::M4a | OutputFormat::Wav | OutputFormat::Flac => {
            !has_video && !has_subtitles && has_audio
        }
        OutputFormat::Mp3 => !has_subtitles && has_audio,
        OutputFormat::Webm | OutputFormat::Avi | OutputFormat::Ogg => false,
    }
}

trait OutputFormatExt {
    fn container_name(&self) -> &str;
    fn extension(&self) -> &str;
    fn display_name(&self) -> &str;
    fn is_audio_only(&self) -> bool;
}

impl OutputFormatExt for OutputFormat {
    fn container_name(&self) -> &str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
            Self::Mkv => "matroska",
            Self::Webm => "webm",
            Self::Avi => "avi",
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
            Self::Wav => "wav",
            Self::Flac => "flac",
            Self::Ogg => "ogg",
        }
    }

    fn extension(&self) -> &str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
            Self::Mkv => "mkv",
            Self::Webm => "webm",
            Self::Avi => "avi",
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
            Self::Wav => "wav",
            Self::Flac => "flac",
            Self::Ogg => "ogg",
        }
    }

    fn display_name(&self) -> &str {
        match self {
            Self::Mp4 => "MP4",
            Self::Mov => "MOV",
            Self::Mkv => "MKV",
            Self::Webm => "WebM",
            Self::Avi => "AVI",
            Self::Mp3 => "MP3",
            Self::M4a => "M4A",
            Self::Wav => "WAV",
            Self::Flac => "FLAC",
            Self::Ogg => "OGG",
        }
    }

    fn is_audio_only(&self) -> bool {
        matches!(self, Self::Mp3 | Self::M4a | Self::Wav | Self::Flac | Self::Ogg)
    }
}
