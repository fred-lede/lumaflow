export type MediaStreamInfo = {
  codec: string;
  streamIndex: number;
};

export type VideoStreamInfo = MediaStreamInfo & {
  width: number;
  height: number;
  frameRate: string;
};

export type AudioStreamInfo = MediaStreamInfo & {
  sampleRateHz: number;
  channels: number;
};

export type MediaInfo = {
  path: string;
  fileName: string;
  container: string;
  durationSeconds: number;
  sizeBytes: number;
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
  hasSubtitles: boolean;
};

export type OutputFormat =
  | "mp4"
  | "mov"
  | "mkv"
  | "webm"
  | "avi"
  | "mp3"
  | "m4a"
  | "wav"
  | "flac"
  | "ogg";

export type QualityPreset = "original" | "high" | "balanced" | "small";

export type OutputSettings = {
  outputDirectory: string;
  format: OutputFormat;
  quality: QualityPreset;
  losslessFirst: boolean;
  codec: string | null;
  bitrateKbps: number | null;
  width: number | null;
  height: number | null;
  frameRate: string | null;
  sampleRateHz: number | null;
  channels: number | null;
};
