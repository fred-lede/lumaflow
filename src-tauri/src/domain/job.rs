use serde::{Deserialize, Serialize};

use super::media::{MediaInfo, OutputSettings};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JobError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum ProcessingKind {
    #[serde(rename = "losslessRemux")]
    LosslessRemux { label: String },
    #[serde(rename = "losslessAudio")]
    LosslessAudio { label: String },
    #[serde(rename = "transcoding")]
    Transcoding { label: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum JobState {
    #[serde(rename = "queued")]
    Queued { label: String },
    #[serde(rename = "analyzing")]
    Analyzing { label: String },
    #[serde(rename = "losslessRemux")]
    LosslessRemux { label: String },
    #[serde(rename = "losslessAudio")]
    LosslessAudio { label: String },
    #[serde(rename = "transcoding")]
    Transcoding { label: String },
    #[serde(rename = "completed")]
    Completed {
        label: String,
        #[serde(rename = "outputPath")]
        output_path: String,
    },
    #[serde(rename = "cancelled")]
    Cancelled { label: String },
    #[serde(rename = "failed")]
    Failed { label: String, error: JobError },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueJob {
    pub id: String,
    pub source_path: String,
    pub media: MediaInfo,
    pub output_settings: OutputSettings,
    pub processing_kind: Option<ProcessingKind>,
    pub state: JobState,
    pub progress: f64,
    pub output_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueueSnapshot {
    pub jobs: Vec<QueueJob>,
    pub paused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind")]
#[serde(rename_all = "camelCase")]
pub enum JobEvent {
    #[serde(rename = "stateChanged")]
    StateChanged {
        #[serde(rename = "jobId")]
        job_id: String,
        state: JobState,
    },
    #[serde(rename = "progress")]
    Progress {
        #[serde(rename = "jobId")]
        job_id: String,
        progress: f64,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{JobError, JobState, ProcessingKind, QueueJob};
    use crate::domain::media::{AudioStreamInfo, MediaInfo, OutputSettings};

    fn media_info() -> MediaInfo {
        MediaInfo {
            path: "/input/file.wav".to_owned(),
            file_name: "file.wav".to_owned(),
            container: "wav".to_owned(),
            duration_seconds: 12.5,
            size_bytes: 1_024,
            video: None,
            audio: Some(AudioStreamInfo {
                codec: "pcm_s16le".to_owned(),
                stream_index: 0,
                sample_rate_hz: 48_000,
                channels: 2,
            }),
            has_subtitles: false,
        }
    }

    fn output_settings() -> OutputSettings {
        OutputSettings {
            output_directory: "/output".to_owned(),
            format: "flac".to_owned(),
            quality: "original".to_owned(),
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

    #[test]
    fn serializes_queue_job_with_typescript_field_names() {
        let job = QueueJob {
            id: "job-1".to_owned(),
            source_path: "/input/file.wav".to_owned(),
            media: media_info(),
            output_settings: output_settings(),
            processing_kind: Some(ProcessingKind::LosslessAudio {
                label: "Lossless audio".to_owned(),
            }),
            state: JobState::Failed {
                label: "Failed".to_owned(),
                error: JobError {
                    code: "encode_failed".to_owned(),
                    message: "The encoder stopped".to_owned(),
                    details: None,
                },
            },
            progress: 0.5,
            output_path: None,
        };

        let value = serde_json::to_value(job).expect("queue job should serialize");

        assert_eq!(
            value,
            json!({
                "id": "job-1",
                "sourcePath": "/input/file.wav",
                "media": {
                    "path": "/input/file.wav",
                    "fileName": "file.wav",
                    "container": "wav",
                    "durationSeconds": 12.5,
                    "sizeBytes": 1024,
                    "video": null,
                    "audio": {
                        "codec": "pcm_s16le",
                        "streamIndex": 0,
                        "sampleRateHz": 48000,
                        "channels": 2
                    },
                    "hasSubtitles": false
                },
                "outputSettings": {
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
                },
                "processingKind": {
                    "kind": "losslessAudio",
                    "label": "Lossless audio"
                },
                "state": {
                    "kind": "failed",
                    "label": "Failed",
                    "error": {
                        "code": "encode_failed",
                        "message": "The encoder stopped"
                    }
                },
                "progress": 0.5,
                "outputPath": null
            })
        );
    }

    #[test]
    fn serializes_completed_state_with_output_path() {
        let state = JobState::Completed {
            label: "Completed".to_owned(),
            output_path: "/output/file.flac".to_owned(),
        };

        assert_eq!(
            serde_json::to_value(state).expect("completed state should serialize"),
            json!({
                "kind": "completed",
                "label": "Completed",
                "outputPath": "/output/file.flac"
            })
        );
    }

    #[test]
    fn serializes_job_event_with_camel_case_job_id() {
        let event = super::JobEvent::Progress {
            job_id: "job-1".to_owned(),
            progress: 0.75,
        };

        assert_eq!(
            serde_json::to_value(event).expect("job event should serialize"),
            json!({
                "kind": "progress",
                "jobId": "job-1",
                "progress": 0.75
            })
        );
    }
}
