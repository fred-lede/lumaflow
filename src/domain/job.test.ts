import { describe, expect, it } from "vitest";

import type { MediaInfo, OutputSettings } from "./media";
import { jobStateLabel } from "./job";
import type { EnqueueJobRequest, JobState } from "./job";

describe("JobState", () => {
  it("gives every queue state a user-facing label and machine-readable kind", () => {
    const states: JobState[] = [
      { kind: "queued", label: "Queued" },
      { kind: "analyzing", label: "Analyzing" },
      { kind: "losslessRemux", label: "Lossless remux" },
      { kind: "losslessAudio", label: "Lossless audio" },
      { kind: "transcoding", label: "Transcoding" },
      {
        kind: "completed",
        label: "Completed",
        outputPath: "/output/file.mp4",
        warning: { code: "cleanup_warning", message: "Cleanup warning", details: "temp file" },
      },
      { kind: "cancelled", label: "Cancelled" },
      {
        kind: "failed",
        label: "Failed",
        error: { code: "probe_failed", message: "Could not analyze the file" },
      },
    ];

    for (const state of states) {
      expect(state.kind).toEqual(expect.any(String));
      expect(state.label).toEqual(expect.any(String));
      expect(state.label.length).toBeGreaterThan(0);
      expect(jobStateLabel(state)).toBe(state.label);
    }
  });

  it("represents every probed stream as a collection", () => {
    const media: MediaInfo = {
      path: "/input/movie.mkv",
      fileName: "movie.mkv",
      container: "matroska",
      durationSeconds: 30,
      sizeBytes: 4_096,
      sourceQuality: {
        status: "unknown",
        summary: "Source quality could not be verified",
        evidence: ["A lossless container does not prove that the original source was lossless"],
      },
      videoStreams: [
        {
          codec: "h264",
          streamIndex: 0,
          width: 1_920,
          height: 1_080,
          frameRate: "24/1",
        },
      ],
      audioStreams: [
        { codec: "aac", streamIndex: 1, sampleRateHz: 48_000, channels: 2 },
        { codec: "aac", streamIndex: 2, sampleRateHz: 48_000, channels: 6 },
      ],
      subtitleStreams: [{ codec: "subrip", streamIndex: 3 }],
    };

    expect(media.videoStreams).toHaveLength(1);
    expect(media.audioStreams).toHaveLength(2);
    expect(media.subtitleStreams).toHaveLength(1);
  });

  it("defines enqueue input without backend-owned queue state", () => {
    const outputSettings: OutputSettings = {
      outputDirectory: "/output",
      format: "flac",
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
    const request: EnqueueJobRequest = {
      sourcePath: "/input/movie.mkv",
      media: {
        path: "/input/movie.mkv",
        fileName: "movie.mkv",
        container: "matroska",
        durationSeconds: 30,
        sizeBytes: 4_096,
        sourceQuality: {
          status: "unknown",
          summary: "Source quality could not be verified",
          evidence: ["A lossless container does not prove that the original source was lossless"],
        },
        videoStreams: [],
        audioStreams: [],
        subtitleStreams: [],
      },
      outputSettings,
    };

    expect(request).not.toHaveProperty("state");
    expect(request).not.toHaveProperty("progress");
    expect(request.outputSettings.format).toBe("flac");
  });
});
