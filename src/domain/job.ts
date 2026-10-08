import type { MediaInfo, OutputSettings } from "./media";

export type JobError = {
  code: string;
  message: string;
  details?: string;
};

export type ProcessingKind =
  | { kind: "losslessRemux"; label: "Lossless remux" }
  | { kind: "losslessAudio"; label: "Lossless audio" }
  | { kind: "transcoding"; label: "Transcoding" };

export type JobState =
  | { kind: "queued"; label: "Queued" }
  | { kind: "analyzing"; label: "Analyzing" }
  | { kind: "losslessRemux"; label: "Lossless remux" }
  | { kind: "losslessAudio"; label: "Lossless audio" }
  | { kind: "transcoding"; label: "Transcoding" }
  | { kind: "completed"; label: "Completed"; outputPath: string }
  | { kind: "cancelled"; label: "Cancelled" }
  | { kind: "failed"; label: "Failed"; error: JobError };

export function jobStateLabel(state: JobState): string {
  return state.label;
}

export function processingKindLabel(kind: ProcessingKind): string {
  return kind.label;
}

export type QueueJob = {
  id: string;
  sourcePath: string;
  media: MediaInfo;
  outputSettings: OutputSettings;
  processingKind: ProcessingKind | null;
  state: JobState;
  progress: number;
  outputPath: string | null;
};

export type QueueSnapshot = {
  jobs: QueueJob[];
  paused: boolean;
};

export type JobEvent =
  | { kind: "stateChanged"; jobId: string; state: JobState }
  | { kind: "progress"; jobId: string; progress: number };
