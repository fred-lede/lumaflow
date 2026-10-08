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
    fn real_style_mov_container_can_remux_to_mov_when_streams_are_compatible() {
        let mut media = mp4_media();
        media.path = "/input/movie.mov".to_owned();
        media.file_name = "movie.mov".to_owned();
        media.container = "mov,mp4,m4a,3gp,3g2,mj2".to_owned();

        let plan = plan_conversion(&media, &settings(OutputFormat::Mov))
            .expect("real-style MOV container should remux");

        assert!(matches!(
            plan.processing_kind,
            ProcessingKind::LosslessRemux { .. }
        ));
    }

    #[test]
    fn real_style_m4a_container_can_remux_to_m4a_when_streams_are_compatible() {
        let mut media = mp4_media();
        media.path = "/input/audio.m4a".to_owned();
        media.file_name = "audio.m4a".to_owned();
        media.container = "mov,mp4,m4a,3gp,3g2,mj2".to_owned();
        media.video_streams.clear();

        let plan = plan_conversion(&media, &settings(OutputFormat::M4a))
            .expect("real-style M4A container should remux");

        assert!(matches!(
            plan.processing_kind,
            ProcessingKind::LosslessRemux { .. }
        ));
    }

    #[test]
    fn ambiguous_composite_container_returns_unknown_error_without_a_plan() {
        let mut media = mp4_media();
        media.path = "/input/media.bin".to_owned();
        media.file_name = "media.bin".to_owned();
        media.container = "mov,mp4,m4a,3gp,3g2,mj2".to_owned();

        let error = plan_conversion(&media, &settings(OutputFormat::Mp4))
            .expect_err("ambiguous composite container should not be guessed");

        assert_eq!(error.code, "unknown_container");
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
                "-i", "/input/voice.wav", "-map", "0:0", "-vn", "-c:a", "flac",
                "-compression_level", "5", "/output/voice.flac"
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
                "-i", "/input/movie.mp4", "-map", "0:1", "-vn", "-c:a", "libmp3lame",
                "-q:a", "0", "/output/movie.mp3"
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

    #[test]
    fn rejects_output_path_collision_with_source_path() {
        let mut media = mp4_media();
        media.path = "/output/movie.mp4".to_owned();

        let error = plan_conversion(&media, &settings(OutputFormat::Mp4))
            .expect_err("planner must not overwrite the source");

        assert_eq!(error.code, "path_collision");
    }

    #[test]
    fn preserves_spaces_and_special_characters_in_paths() {
        let mut media = mp4_media();
        media.path = "/input/My Clip [final] & cut.mp4".to_owned();
        media.file_name = "My Clip [final] & cut.mp4".to_owned();
        let mut output = settings(OutputFormat::Mp3);
        output.output_directory = "/output folder".to_owned();

        let plan = plan_conversion(&media, &output).expect("special-character paths are valid");
        let arguments = args(&plan);

        assert_eq!(plan.output_path, PathBuf::from("/output folder/My Clip [final] & cut.mp3"));
        assert_eq!(arguments[1], "/input/My Clip [final] & cut.mp4");
        assert_eq!(arguments.last(), Some(&"/output folder/My Clip [final] & cut.mp3".to_owned()));
    }

    #[test]
    fn mp4_to_mp3_selects_only_audio_and_never_emits_video_filters() {
        let mut output = settings(OutputFormat::Mp3);
        output.sample_rate_hz = Some(44_100);
        output.channels = Some(1);

        let plan = plan_conversion(&mp4_media(), &output)
            .expect("audio-only MP3 conversion should be supported");
        let arguments = args(&plan);

        assert!(arguments.contains(&"0:1".to_owned()));
        assert!(!arguments.contains(&"0:0".to_owned()));
        assert!(arguments.contains(&"-vn".to_owned()));
        assert!(!arguments.contains(&"-vf".to_owned()));
        assert!(!arguments.contains(&"-c:v".to_owned()));
    }

    #[test]
    fn mp4_to_mp3_rejects_video_settings_instead_of_emitting_audio_only_video_filters() {
        let mut output = settings(OutputFormat::Mp3);
        output.width = Some(1280);

        let error = plan_conversion(&mp4_media(), &output)
            .expect_err("video settings are invalid for an MP3 target");

        assert_eq!(error.code, "unsupported_conversion");
    }

    #[test]
    fn codec_setting_is_scoped_to_the_target_video_stream() {
        let mut output = settings(OutputFormat::Mp4);
        output.codec = Some("libx264".to_owned());

        let plan = plan_conversion(&mp4_media(), &output)
            .expect("supported MP4 video codec should transcode");
        let arguments = args(&plan);

        assert!(arguments.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
        assert!(!arguments.contains(&"-c".to_owned()));
    }

    #[test]
    fn audio_codec_is_rejected_for_video_target_instead_of_being_applied_globally() {
        let mut output = settings(OutputFormat::Mp4);
        output.codec = Some("aac".to_owned());

        let error = plan_conversion(&mp4_media(), &output)
            .expect_err("ambiguous audio codec must not be applied to a video target");

        assert_eq!(error.code, "unsupported_conversion");
    }

    #[test]
    fn rejects_invalid_target_setting_values_before_building_arguments() {
        let invalid_settings = [
            (
                "width",
                OutputSettings {
                    width: Some(0),
                    ..settings(OutputFormat::Mp4)
                },
            ),
            (
                "height",
                OutputSettings {
                    height: Some(16_385),
                    ..settings(OutputFormat::Mp4)
                },
            ),
            (
                "sample rate",
                OutputSettings {
                    sample_rate_hz: Some(0),
                    ..settings(OutputFormat::Mp3)
                },
            ),
            (
                "channels",
                OutputSettings {
                    channels: Some(257),
                    ..settings(OutputFormat::Mp3)
                },
            ),
            (
                "bitrate",
                OutputSettings {
                    bitrate_kbps: Some(1_000_001),
                    ..settings(OutputFormat::Mp3)
                },
            ),
            (
                "frame rate",
                OutputSettings {
                    frame_rate: Some("30/-1".to_owned()),
                    ..settings(OutputFormat::Mp4)
                },
            ),
        ];

        for (field, output) in invalid_settings {
            let error = plan_conversion(&mp4_media(), &output)
                .expect_err("invalid target settings must fail before argument construction");

            assert_eq!(error.code, "invalid_settings", "invalid {field} should be rejected");
        }
    }

    #[test]
    fn supported_video_quality_presets_generate_distinct_explicit_arguments() {
        let mut plans = Vec::new();
        for quality in [
            QualityPreset::Original,
            QualityPreset::High,
            QualityPreset::Balanced,
            QualityPreset::Small,
        ] {
            let mut output = settings(OutputFormat::Mp4);
            output.quality = quality;
            output.width = Some(1280);
            let plan = plan_conversion(&mp4_media(), &output)
                .expect("video quality preset should be supported");
            let arguments = args(&plan);

            assert!(arguments.contains(&"-crf".to_owned()));
            plans.push(arguments);
        }

        assert!(plans.windows(2).all(|pair| pair[0] != pair[1]));
    }

    #[test]
    fn supported_audio_quality_presets_generate_distinct_explicit_arguments() {
        let mut plans = Vec::new();
        for quality in [
            QualityPreset::Original,
            QualityPreset::High,
            QualityPreset::Balanced,
            QualityPreset::Small,
        ] {
            let mut output = settings(OutputFormat::Mp3);
            output.quality = quality;
            let plan = plan_conversion(&mp4_media(), &output)
                .expect("MP3 quality preset should be supported");
            let arguments = args(&plan);

            assert!(
                arguments.contains(&"-q:a".to_owned())
                    || arguments.contains(&"-b:a".to_owned())
            );
            plans.push(arguments);
        }

        assert!(plans.windows(2).all(|pair| pair[0] != pair[1]));
    }

    #[test]
    fn unsupported_flac_quality_preset_returns_structured_settings_error() {
        let mut output = settings(OutputFormat::Flac);
        output.quality = QualityPreset::High;

        let error = plan_conversion(&wav_media(), &output)
            .expect_err("FLAC quality profile only supports the original lossless preset");

        assert_eq!(error.code, "unsupported_settings");
    }

    #[test]
    fn m4a_remux_rejects_video_streams() {
        let mut media = mp4_media();
        media.path = "/input/video.m4a".to_owned();
        media.file_name = "video.m4a".to_owned();
        media.container = "m4a".to_owned();

        let error = plan_conversion(&media, &settings(OutputFormat::M4a))
            .expect_err("M4A must not remux video streams");

        assert_eq!(error.code, "unsupported_conversion");
    }

    #[test]
    fn mkv_remux_rejects_unknown_stream_codecs() {
        let mut media = mp4_media();
        media.container = "matroska".to_owned();
        media.video_streams[0].codec = "unknown-video".to_owned();

        let error = plan_conversion(&media, &settings(OutputFormat::Mkv))
            .expect_err("MKV remux must require known-safe codecs");

        assert_eq!(error.code, "unsupported_conversion");
    }

    #[test]
    fn mkv_remux_rejects_unknown_audio_even_with_known_video() {
        let mut media = mp4_media();
        media.container = "matroska".to_owned();
        media.audio_streams[0].codec = "unknown-audio".to_owned();

        let error = plan_conversion(&media, &settings(OutputFormat::Mkv))
            .expect_err("MKV remux must not drop an unknown audio stream");

        assert_eq!(error.code, "unsupported_conversion");
    }

    #[test]
    fn known_mkv_codecs_can_remux_without_wildcard_compatibility() {
        let mut media = mp4_media();
        media.container = "matroska".to_owned();

        let plan = plan_conversion(&media, &settings(OutputFormat::Mkv))
            .expect("known-safe MKV codecs should remux");

        assert!(matches!(
            plan.processing_kind,
            ProcessingKind::LosslessRemux { .. }
        ));
    }

    #[test]
    fn valid_webm_codecs_can_remux_without_becoming_wildcard_compatible() {
        let mut media = mp4_media();
        media.container = "webm".to_owned();
        media.video_streams[0].codec = "vp9".to_owned();
        media.audio_streams[0].codec = "opus".to_owned();

        let plan = plan_conversion(&media, &settings(OutputFormat::Webm))
            .expect("known-safe WebM codecs should remux");

        assert!(matches!(
            plan.processing_kind,
            ProcessingKind::LosslessRemux { .. }
        ));
    }

}
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use crate::domain::job::ProcessingKind;
use crate::domain::media::{MediaInfo, OutputFormat, OutputSettings, QualityPreset};

use super::ffmpeg_args::{input_and_output_args, ArgumentMode};
use super::{resolve_container_name, MediaError};

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
    reject_path_collision(&media.path, &output_path)?;
    validate_target_settings(media, settings)?;
    let source_container = resolve_container_name(&media.container, &media.path)?;
    let output_format = &settings.format;
    let mode = match output_format {
        format if source_container == format.container_name()
            && streams_fit_container(media, format)
            && !has_stream_setting_changes(settings)
            && settings.lossless_first => ProcessingMode::LosslessRemux(ArgumentMode::AllStreams),
        OutputFormat::Mp3 => {
            require_audio(media)?;
            ProcessingMode::Transcoding(ArgumentMode::FirstAudio)
        }
        OutputFormat::Flac
            if is_pcm_source(media, &source_container)
                && !has_stream_setting_changes(settings)
                && settings.lossless_first =>
        {
            require_audio(media)?;
            ProcessingMode::LosslessAudio(ArgumentMode::FirstAudio)
        }
        OutputFormat::Flac
            if is_pcm_source(media, &source_container)
                && !has_stream_setting_changes(settings) =>
        {
            require_audio(media)?;
            ProcessingMode::Transcoding(ArgumentMode::FirstAudio)
        }
        format if source_container == format.container_name()
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

fn reject_path_collision(source_path: &str, output_path: &Path) -> Result<(), MediaError> {
    let source_path = Path::new(source_path);
    let paths_match = match (
        std::fs::canonicalize(source_path),
        std::fs::canonicalize(output_path),
    ) {
        (Ok(source), Ok(output)) => source == output,
        _ => lexically_normalize(source_path) == lexically_normalize(output_path),
    };

    if paths_match {
        Err(MediaError::new(
            "path_collision",
            "The output path must not overwrite the source path",
        ))
    } else {
        Ok(())
    }
}

fn lexically_normalize(path: &Path) -> PathBuf {
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

fn validate_target_settings(
    media: &MediaInfo,
    settings: &OutputSettings,
) -> Result<(), MediaError> {
    validate_numeric_settings(settings)?;
    validate_quality_settings(settings)?;

    let has_video_settings = settings.width.is_some()
        || settings.height.is_some()
        || settings.frame_rate.is_some();

    if has_video_settings && settings.format.is_audio_only() {
        return Err(MediaError::new(
            "unsupported_conversion",
            "Video settings cannot be applied to an audio-only output",
        ));
    }

    if has_video_settings && media.video_streams.is_empty() && !settings.format.is_audio_only() {
        return Err(MediaError::new(
            "unsupported_conversion",
            "Video settings require a source video stream",
        ));
    }

    if let Some(codec) = &settings.codec {
        if !is_supported_target_codec(&settings.format, codec) {
            return Err(MediaError::new(
                "unsupported_conversion",
                format!(
                    "Codec '{codec}' is not a proven codec mapping for {}",
                    settings.format.display_name()
                ),
            ));
        }
    }

    Ok(())
}

fn validate_numeric_settings(settings: &OutputSettings) -> Result<(), MediaError> {
    const MAX_DIMENSION: u32 = 16_384;
    const MAX_SAMPLE_RATE_HZ: u32 = 768_000;
    const MAX_CHANNELS: u16 = 256;
    const MAX_BITRATE_KBPS: u32 = 1_000_000;
    const MAX_FRAME_RATE: f64 = 1_000.0;

    if let Some(width) = settings.width {
        if !(1..=MAX_DIMENSION).contains(&width) {
            return Err(invalid_setting("width must be between 1 and 16384"));
        }
    }
    if let Some(height) = settings.height {
        if !(1..=MAX_DIMENSION).contains(&height) {
            return Err(invalid_setting("height must be between 1 and 16384"));
        }
    }
    if let Some(sample_rate) = settings.sample_rate_hz {
        if !(1..=MAX_SAMPLE_RATE_HZ).contains(&sample_rate) {
            return Err(invalid_setting("sample rate must be between 1 and 768000 Hz"));
        }
    }
    if let Some(channels) = settings.channels {
        if !(1..=MAX_CHANNELS).contains(&channels) {
            return Err(invalid_setting("channels must be between 1 and 256"));
        }
    }
    if let Some(bitrate) = settings.bitrate_kbps {
        if !(1..=MAX_BITRATE_KBPS).contains(&bitrate) {
            return Err(invalid_setting("bitrate must be between 1 and 1000000 kbps"));
        }
    }
    if let Some(frame_rate) = &settings.frame_rate {
        let rate = if let Some((numerator, denominator)) = frame_rate.split_once('/') {
            if denominator.contains('/') {
                None
            } else {
                match (numerator.parse::<f64>().ok(), denominator.parse::<f64>().ok()) {
                    (Some(numerator), Some(denominator))
                        if numerator > 0.0 && denominator > 0.0 => Some(numerator / denominator),
                    _ => None,
                }
            }
        } else {
            frame_rate.parse::<f64>().ok()
        };

        if !matches!(
            rate,
            Some(rate) if rate.is_finite() && rate > 0.0 && rate <= MAX_FRAME_RATE
        ) {
            return Err(invalid_setting(
                "frame rate must be a positive ratio or number up to 1000",
            ));
        }
    }

    Ok(())
}

fn validate_quality_settings(settings: &OutputSettings) -> Result<(), MediaError> {
    let supported = match settings.format {
        OutputFormat::Mp4
        | OutputFormat::Mov
        | OutputFormat::Mkv
        | OutputFormat::Mp3
        | OutputFormat::M4a => true,
        OutputFormat::Flac | OutputFormat::Wav => settings.quality == QualityPreset::Original,
        OutputFormat::Webm | OutputFormat::Avi | OutputFormat::Ogg => {
            settings.quality == QualityPreset::Original
        }
    };

    if supported {
        Ok(())
    } else {
        Err(MediaError::new(
            "unsupported_settings",
            format!(
                "Quality preset is not supported for {}",
                settings.format.display_name()
            ),
        ))
    }
}

fn invalid_setting(message: impl Into<String>) -> MediaError {
    MediaError::new("invalid_settings", message)
}

fn is_supported_target_codec(format: &OutputFormat, codec: &str) -> bool {
    match format {
        OutputFormat::Mp4 | OutputFormat::Mov | OutputFormat::Mkv => {
            matches!(codec, "h264" | "libx264" | "hevc" | "libx265")
        }
        OutputFormat::Mp3 => matches!(codec, "mp3" | "libmp3lame"),
        OutputFormat::M4a => codec == "aac",
        OutputFormat::Wav => codec.starts_with("pcm_"),
        OutputFormat::Flac => codec == "flac",
        OutputFormat::Webm | OutputFormat::Avi | OutputFormat::Ogg => false,
    }
}

fn streams_fit_container(media: &MediaInfo, format: &OutputFormat) -> bool {
    match format {
        OutputFormat::Mp4 | OutputFormat::Mov => {
            !media.video_streams.is_empty()
                && media.video_streams.iter().all(|stream| stream.codec == "h264")
                && !media.audio_streams.is_empty()
                && media
                    .audio_streams
                    .iter()
                    .all(|stream| stream.codec == "aac" || stream.codec == "mp3")
                && media.subtitle_streams.is_empty()
        }
        OutputFormat::M4a => {
            media.video_streams.is_empty()
                && !media.audio_streams.is_empty()
                && media
                    .audio_streams
                    .iter()
                    .all(|stream| stream.codec == "aac" || stream.codec == "mp3")
                && media.subtitle_streams.is_empty()
        }
        OutputFormat::Mkv => {
            (!media.video_streams.is_empty()
                || !media.audio_streams.is_empty()
                || !media.subtitle_streams.is_empty())
                && media
                    .video_streams
                    .iter()
                    .all(|stream| is_mkv_video_codec(&stream.codec))
                && media
                    .audio_streams
                    .iter()
                    .all(|stream| is_mkv_audio_codec(&stream.codec))
                && media
                    .subtitle_streams
                    .iter()
                    .all(|stream| is_known_subtitle_codec(&stream.codec))
        }
        OutputFormat::Webm => {
            (!media.video_streams.is_empty() || !media.audio_streams.is_empty())
                && media.subtitle_streams.is_empty()
                && media
                    .video_streams
                    .iter()
                    .all(|stream| is_webm_video_codec(&stream.codec))
                && media
                    .audio_streams
                    .iter()
                    .all(|stream| is_webm_audio_codec(&stream.codec))
        }
        OutputFormat::Wav => {
            media.video_streams.is_empty()
                && media.subtitle_streams.is_empty()
                && !media.audio_streams.is_empty()
                && media
                    .audio_streams
                    .iter()
                    .all(|stream| stream.codec.starts_with("pcm_"))
        }
        OutputFormat::Flac => {
            media.video_streams.is_empty()
                && media.subtitle_streams.is_empty()
                && !media.audio_streams.is_empty()
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

fn is_mkv_video_codec(codec: &str) -> bool {
    matches!(codec, "h264" | "hevc" | "vp8" | "vp9" | "av1")
}

fn is_mkv_audio_codec(codec: &str) -> bool {
    matches!(
        codec,
        "aac" | "mp3" | "opus" | "vorbis" | "flac" | "ac3" | "eac3"
    )
}

fn is_webm_video_codec(codec: &str) -> bool {
    matches!(codec, "vp8" | "vp9" | "av1")
}

fn is_webm_audio_codec(codec: &str) -> bool {
    matches!(codec, "opus" | "vorbis")
}

fn is_known_subtitle_codec(codec: &str) -> bool {
    matches!(
        codec,
        "subrip" | "srt" | "ass" | "ssa" | "webvtt" | "hdmv_pgs_subtitle" | "dvd_subtitle"
    )
}

fn is_pcm_source(media: &MediaInfo, source_container: &str) -> bool {
    source_container == "wav"
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
