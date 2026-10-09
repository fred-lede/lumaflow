use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamInfo {
    pub codec: String,
    pub stream_index: u32,
    pub width: u32,
    pub height: u32,
    pub frame_rate: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    pub codec: String,
    pub stream_index: u32,
    pub sample_rate_hz: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub file_name: String,
    pub container: String,
    pub duration_seconds: f64,
    pub size_bytes: u64,
    pub source_quality: SourceQualityAssessment,
    pub video_streams: Vec<VideoStreamInfo>,
    pub audio_streams: Vec<AudioStreamInfo>,
    pub subtitle_streams: Vec<SubtitleStreamInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceQualityStatus {
    LossySource,
    LikelyNativeLossless,
    PossiblyTranscodedLossy,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceQualityAssessment {
    pub status: SourceQualityStatus,
    pub summary: String,
    pub evidence: Vec<String>,
}

impl SourceQualityAssessment {
    pub fn unknown() -> Self {
        Self {
            status: SourceQualityStatus::Unknown,
            summary: "Source quality could not be verified".to_owned(),
            evidence: vec![
                "A lossless container does not prove that the original source was lossless".to_owned(),
            ],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaStreamInfo {
    pub codec: String,
    pub stream_index: u32,
}

pub type SubtitleStreamInfo = MediaStreamInfo;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputSettings {
    pub output_directory: String,
    pub format: OutputFormat,
    pub quality: QualityPreset,
    pub lossless_first: bool,
    pub codec: Option<String>,
    pub bitrate_kbps: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<String>,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum OutputFormat {
    #[serde(rename = "mp4")]
    Mp4,
    #[serde(rename = "mov")]
    Mov,
    #[serde(rename = "mkv")]
    Mkv,
    #[serde(rename = "webm")]
    Webm,
    #[serde(rename = "avi")]
    Avi,
    #[serde(rename = "mp3")]
    Mp3,
    #[serde(rename = "m4a")]
    M4a,
    #[serde(rename = "wav")]
    Wav,
    #[serde(rename = "flac")]
    Flac,
    #[serde(rename = "ogg")]
    Ogg,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum QualityPreset {
    #[serde(rename = "original")]
    Original,
    #[serde(rename = "high")]
    High,
    #[serde(rename = "balanced")]
    Balanced,
    #[serde(rename = "small")]
    Small,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{MediaInfo, OutputFormat, OutputSettings, QualityPreset, SourceQualityAssessment, SourceQualityStatus};

    #[test]
    fn serializes_source_quality_assessment_with_explicit_uncertainty() {
        let assessment = SourceQualityAssessment {
            status: SourceQualityStatus::PossiblyTranscodedLossy,
            summary: "Possibly transcoded from a lossy source".to_owned(),
            evidence: vec!["The spectral profile shows a suspicious high-frequency cutoff".to_owned()],
        };

        assert_eq!(
            serde_json::to_value(assessment).expect("source quality should serialize"),
            json!({
                "status": "possiblyTranscodedLossy",
                "summary": "Possibly transcoded from a lossy source",
                "evidence": ["The spectral profile shows a suspicious high-frequency cutoff"]
            })
        );
    }

    #[test]
    fn serializes_closed_output_settings_literals() {
        let settings = OutputSettings {
            output_directory: "/output".to_owned(),
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
        };

        assert_eq!(
            serde_json::to_value(settings).expect("output settings should serialize"),
            json!({
                "outputDirectory": "/output",
                "format": "flac",
                "quality": "original",
                "losslessFirst": true,
                "codec": null,
                "bitrateKbps": null,
                "width": null,
                "height": null,
                "frameRate": null,
                "sampleRateHz": null,
                "channels": null
            })
        );
    }

    #[test]
    fn serializes_every_closed_output_literal() {
        let formats = [
            (OutputFormat::Mp4, "mp4"),
            (OutputFormat::Mov, "mov"),
            (OutputFormat::Mkv, "mkv"),
            (OutputFormat::Webm, "webm"),
            (OutputFormat::Avi, "avi"),
            (OutputFormat::Mp3, "mp3"),
            (OutputFormat::M4a, "m4a"),
            (OutputFormat::Wav, "wav"),
            (OutputFormat::Flac, "flac"),
            (OutputFormat::Ogg, "ogg"),
        ];
        let qualities = [
            (QualityPreset::Original, "original"),
            (QualityPreset::High, "high"),
            (QualityPreset::Balanced, "balanced"),
            (QualityPreset::Small, "small"),
        ];

        for (format, expected) in formats {
            assert_eq!(serde_json::to_value(format).unwrap(), expected);
        }
        for (quality, expected) in qualities {
            assert_eq!(serde_json::to_value(quality).unwrap(), expected);
        }
    }

    #[test]
    fn rejects_unknown_output_literals_and_preserves_multiple_streams() {
        let invalid = json!({
            "outputDirectory": "/output",
            "format": "unknown",
            "quality": "original",
            "losslessFirst": true,
            "codec": null,
            "bitrateKbps": null,
            "width": null,
            "height": null,
            "frameRate": null,
            "sampleRateHz": null,
            "channels": null
        });
        assert!(serde_json::from_value::<OutputSettings>(invalid).is_err());

        let invalid_quality = json!({
            "outputDirectory": "/output",
            "format": "flac",
            "quality": "unknown",
            "losslessFirst": true,
            "codec": null,
            "bitrateKbps": null,
            "width": null,
            "height": null,
            "frameRate": null,
            "sampleRateHz": null,
            "channels": null
        });
        assert!(serde_json::from_value::<OutputSettings>(invalid_quality).is_err());

        let media = MediaInfo {
            path: "/input/movie.mkv".to_owned(),
            file_name: "movie.mkv".to_owned(),
            container: "matroska".to_owned(),
            duration_seconds: 30.0,
            size_bytes: 4_096,
            source_quality: SourceQualityAssessment::unknown(),
            video_streams: vec![],
            audio_streams: vec![],
            subtitle_streams: vec![super::SubtitleStreamInfo {
                codec: "subrip".to_owned(),
                stream_index: 3,
            }],
        };
        assert_eq!(media.subtitle_streams.len(), 1);
    }
}
