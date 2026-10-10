import { describe, expect, it } from "vitest";

import type { JobState, ProcessingKind, QueueJob } from "../../domain/job";
import type { MediaInfo, OutputSettings } from "../../domain/media";
import {
  canCancelJob,
  canRetryJob,
  canReorderJob,
  isProcessingJob,
  processingKindVisibleLabel,
  queueProgressSummary,
  queueStatusFor,
} from "./queueLabels";

const states: Array<[JobState, string, string, string]> = [
  [{ kind: "queued", label: "Queued" }, "待處理", "○", "neutral"],
  [{ kind: "analyzing", label: "Analyzing" }, "分析中", "…", "working"],
  [{ kind: "losslessRemux", label: "Lossless remux" }, "無損封裝", "↻", "working"],
  [{ kind: "losslessAudio", label: "Lossless audio" }, "無損音訊轉換", "↻", "working"],
  [{ kind: "transcoding", label: "Transcoding" }, "重新編碼", "↻", "working"],
  [{ kind: "completed", label: "Completed", outputPath: "/output/file.mp4" }, "已完成", "✓", "success"],
  [{ kind: "cancelled", label: "Cancelled" }, "已取消", "×", "neutral"],
  [
    {
      kind: "failed",
      label: "Failed",
      error: { code: "encode_failed", message: "The encoder stopped", details: "stderr" },
    },
    "失敗",
    "!",
    "danger",
  ],
];

describe("queue labels", () => {
  it.each(states)("maps the backend %s state to text, icon, and color tone", (state, label, icon, tone) => {
    expect(queueStatusFor(state)).toMatchObject({ label, icon, tone });
  });

  it("makes every processing kind visible in the queue", () => {
    const kinds: Array<[ProcessingKind, string]> = [
      [{ kind: "losslessRemux", label: "Lossless remux" }, "無損封裝"],
      [{ kind: "losslessAudio", label: "Lossless audio" }, "無損音訊轉換"],
      [{ kind: "transcoding", label: "Transcoding" }, "重新編碼"],
    ];

    for (const [kind, label] of kinds) {
      expect(processingKindVisibleLabel(kind)).toBe(label);
    }
    expect(processingKindVisibleLabel(null)).toBe("尚未判定");
  });

  it("only enables cancellation for work the backend can cancel", () => {
    expect(canCancelJob("queued")).toBe(true);
    expect(canCancelJob("analyzing")).toBe(false);
    expect(canCancelJob("losslessRemux")).toBe(true);
    expect(canCancelJob("losslessAudio")).toBe(true);
    expect(canCancelJob("transcoding")).toBe(true);
    expect(canCancelJob("completed")).toBe(false);
    expect(canCancelJob("cancelled")).toBe(false);
    expect(canCancelJob("failed")).toBe(false);
  });

  it("only enables retry for failed jobs", () => {
    expect(canRetryJob("failed")).toBe(true);
    expect(canRetryJob("queued")).toBe(false);
    expect(canRetryJob("completed")).toBe(false);
  });

  it("only enables reorder for queued jobs", () => {
    expect(canReorderJob("queued")).toBe(true);
    expect(canReorderJob("transcoding")).toBe(false);
    expect(canReorderJob("completed")).toBe(false);
  });
});

const media: MediaInfo = {
  path: "/media/clip.mp4",
  fileName: "clip.mp4",
  container: "mp4",
  durationSeconds: 1,
  sizeBytes: 1,
  sourceQuality: { status: "unknown", summary: "Unknown source quality", evidence: [] },
  videoStreams: [],
  audioStreams: [],
  subtitleStreams: [],
};

const outputSettings: OutputSettings = {
  outputDirectory: "",
  format: "mp3",
  quality: "original",
  losslessFirst: true,
  codec: null,
  bitrateKbps: null,
  width: null,
  height: null,
  frameRate: null,
  sampleRateHz: null,
  channels: null,
};

function stateFor(kind: JobState["kind"]): JobState {
  switch (kind) {
    case "completed":
      return { kind: "completed", label: "Completed", outputPath: "/out.mp4" };
    case "failed":
      return { kind: "failed", label: "Failed", error: { code: "encode_failed", message: "stopped" } };
    case "queued":
      return { kind: "queued", label: "Queued" };
    case "analyzing":
      return { kind: "analyzing", label: "Analyzing" };
    case "losslessRemux":
      return { kind: "losslessRemux", label: "Lossless remux" };
    case "losslessAudio":
      return { kind: "losslessAudio", label: "Lossless audio" };
    case "transcoding":
      return { kind: "transcoding", label: "Transcoding" };
    case "cancelled":
      return { kind: "cancelled", label: "Cancelled" };
  }
}

function job(kind: JobState["kind"], id: string): QueueJob {
  return {
    id,
    sourcePath: `/media/${id}.mp4`,
    media,
    outputSettings,
    processingKind: null,
    attempt: 1,
    state: stateFor(kind),
    progress: 0,
    outputPath: null,
  };
}

describe("queue progress summary", () => {
  it("counts only actively processing jobs", () => {
    const jobs = [job("transcoding", "1"), job("analyzing", "2"), job("queued", "3")];
    expect(queueProgressSummary(jobs)).toBe("Converting 2/3");
  });

  it("returns null when nothing is processing", () => {
    expect(queueProgressSummary([job("queued", "1"), job("completed", "2")])).toBeNull();
    expect(queueProgressSummary([])).toBeNull();
  });

  it("does not treat terminal or queued states as processing", () => {
    expect(isProcessingJob("completed")).toBe(false);
    expect(isProcessingJob("failed")).toBe(false);
    expect(isProcessingJob("cancelled")).toBe(false);
    expect(isProcessingJob("queued")).toBe(false);
    expect(isProcessingJob("analyzing")).toBe(true);
    expect(isProcessingJob("losslessRemux")).toBe(true);
    expect(isProcessingJob("losslessAudio")).toBe(true);
    expect(isProcessingJob("transcoding")).toBe(true);
  });
});
