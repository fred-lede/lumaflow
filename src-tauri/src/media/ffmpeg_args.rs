use std::ffi::OsString;

use crate::domain::media::{
    AudioStreamInfo, OutputFormat, OutputSettings, QualityPreset, SubtitleStreamInfo,
    VideoStreamInfo,
};

pub fn input_and_output_args(
    input_path: &str,
    output_path: &str,
    video_streams: &[VideoStreamInfo],
    audio_streams: &[AudioStreamInfo],
    subtitle_streams: &[SubtitleStreamInfo],
    settings: &OutputSettings,
    mode: ArgumentMode,
) -> Vec<OsString> {
    let mut args = vec![OsString::from("-i"), OsString::from(input_path)];
    let mut maps = match mode {
        ArgumentMode::AllStreams => video_streams
            .iter()
            .map(|stream| stream.stream_index)
            .chain(audio_streams.iter().map(|stream| stream.stream_index))
            .chain(subtitle_streams.iter().map(|stream| stream.stream_index))
            .collect::<Vec<_>>(),
        ArgumentMode::FirstAudio => audio_streams
            .first()
            .map(|stream| vec![stream.stream_index])
            .unwrap_or_default(),
        ArgumentMode::TranscodeAll => video_streams
            .iter()
            .map(|stream| stream.stream_index)
            .chain(audio_streams.iter().map(|stream| stream.stream_index))
            .collect::<Vec<_>>(),
    };
    maps.sort_unstable();

    for stream_index in maps {
        args.extend([OsString::from("-map"), OsString::from(format!("0:{stream_index}"))]);
    }

    match mode {
        ArgumentMode::AllStreams => args.extend([OsString::from("-c"), OsString::from("copy")]),
        ArgumentMode::TranscodeAll => {
            let video_codec = settings.codec.as_deref().unwrap_or("libx264");
            args.extend([
                OsString::from("-c:v"),
                OsString::from(video_codec),
                OsString::from("-c:a"),
                OsString::from("aac"),
            ]);
            add_transcoding_options(&mut args, settings);
            add_video_quality_options(&mut args, settings);
        }
        ArgumentMode::FirstAudio => {
            args.push(OsString::from("-vn"));
            let default_codec = match settings.format {
                crate::domain::media::OutputFormat::Flac => "flac",
                crate::domain::media::OutputFormat::Mp3 => "libmp3lame",
                crate::domain::media::OutputFormat::M4a => "aac",
                crate::domain::media::OutputFormat::Wav => "pcm_s16le",
                crate::domain::media::OutputFormat::Ogg => "libopus",
                _ => "copy",
            };
            args.extend([
                OsString::from("-c:a"),
                OsString::from(settings.codec.as_deref().unwrap_or(default_codec)),
            ]);
            add_audio_transcoding_options(&mut args, settings);
            add_audio_quality_options(&mut args, settings);
        }
    }

    args.push(OsString::from(output_path));
    args
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArgumentMode {
    AllStreams,
    FirstAudio,
    TranscodeAll,
}

fn add_transcoding_options(args: &mut Vec<OsString>, settings: &OutputSettings) {
    if let (Some(width), Some(height)) = (settings.width, settings.height) {
        args.extend([
            OsString::from("-vf"),
            OsString::from(format!("scale={width}:{height}")),
        ]);
    } else if let Some(width) = settings.width {
        args.extend([
            OsString::from("-vf"),
            OsString::from(format!("scale={width}:-1")),
        ]);
    } else if let Some(height) = settings.height {
        args.extend([
            OsString::from("-vf"),
            OsString::from(format!("scale=-1:{height}")),
        ]);
    }
    if let Some(frame_rate) = &settings.frame_rate {
        args.extend([OsString::from("-r"), OsString::from(frame_rate)]);
    }
    add_audio_transcoding_options(args, settings);
}

fn add_audio_transcoding_options(args: &mut Vec<OsString>, settings: &OutputSettings) {
    if let Some(sample_rate) = settings.sample_rate_hz {
        args.extend([
            OsString::from("-ar"),
            OsString::from(sample_rate.to_string()),
        ]);
    }
    if let Some(channels) = settings.channels {
        args.extend([OsString::from("-ac"), OsString::from(channels.to_string())]);
    }
    if let Some(bitrate_kbps) = settings.bitrate_kbps {
        args.extend([
            OsString::from("-b:a"),
            OsString::from(format!("{bitrate_kbps}k")),
        ]);
    }
}

fn add_video_quality_options(args: &mut Vec<OsString>, settings: &OutputSettings) {
    let crf = match settings.quality {
        QualityPreset::Original => "18",
        QualityPreset::High => "20",
        QualityPreset::Balanced => "23",
        QualityPreset::Small => "28",
    };
    args.extend([OsString::from("-crf"), OsString::from(crf)]);
}

fn add_audio_quality_options(args: &mut Vec<OsString>, settings: &OutputSettings) {
    if settings.bitrate_kbps.is_some() {
        return;
    }

    match (&settings.format, &settings.quality) {
        (&OutputFormat::Mp3, &QualityPreset::Original) => {
            args.extend([OsString::from("-q:a"), OsString::from("0")]);
        }
        (&OutputFormat::Mp3, &QualityPreset::High) => {
            args.extend([OsString::from("-b:a"), OsString::from("320k")]);
        }
        (&OutputFormat::Mp3, &QualityPreset::Balanced) => {
            args.extend([OsString::from("-b:a"), OsString::from("192k")]);
        }
        (&OutputFormat::Mp3, &QualityPreset::Small) => {
            args.extend([OsString::from("-b:a"), OsString::from("128k")]);
        }
        (&OutputFormat::M4a, &QualityPreset::Original) => {
            args.extend([OsString::from("-b:a"), OsString::from("256k")]);
        }
        (&OutputFormat::M4a, &QualityPreset::High) => {
            args.extend([OsString::from("-b:a"), OsString::from("192k")]);
        }
        (&OutputFormat::M4a, &QualityPreset::Balanced) => {
            args.extend([OsString::from("-b:a"), OsString::from("128k")]);
        }
        (&OutputFormat::M4a, &QualityPreset::Small) => {
            args.extend([OsString::from("-b:a"), OsString::from("96k")]);
        }
        (&OutputFormat::Flac, &QualityPreset::Original) => {
            args.extend([OsString::from("-compression_level"), OsString::from("5")]);
        }
        _ => {}
    }
}
