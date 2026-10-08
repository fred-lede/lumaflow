import { describe, expect, it } from "vitest";

import {
  loadFixtureSpec,
  validateFixtureManifest,
  type FixtureManifest,
} from "./contract";

describe("trusted fixture contract", () => {
  it("accepts the committed generation specification", () => {
    const spec = loadFixtureSpec();

    expect(spec.schemaVersion).toBe(2);
    expect(spec.generatorVersion).toBe(2);
    expect(spec.ffmpeg).toMatchObject({
      versionPolicy: "exact",
      version: "8.1.2",
      assets: {
        "darwin-arm64": {
          sha256: "1332dc2de372bade9a8a63da0d6cdfab9de97fcefbae707bcc0b0506e1203327",
        },
      },
    });
    expect(spec.ffprobe).toMatchObject({
      versionPolicy: "exact",
      version: "8.1.2",
      assets: {
        "darwin-arm64": {
          sha256: "4322275c1c2ac6ba15c695b288788bc1204e75211b3d5c030e5812c82a6dff73",
        },
      },
    });
    expect(spec.generation.fixtures.map((fixture) => fixture.name)).toEqual([
      "sample.mp4",
      "sample.mov",
      "sample.mkv",
      "sample.webm",
      "sample.avi",
      "sample.mp3",
      "sample.m4a",
      "sample.wav",
      "sample.flac",
      "sample.ogg",
    ]);
    expect(spec.generation.fixtures.map((fixture) => ({
      name: fixture.name,
      kind: fixture.kind,
      videoCodec: fixture.videoCodec ?? null,
      audioCodec: fixture.audioCodec,
      probeVideoCodec: fixture.probeVideoCodec ?? null,
      probeAudioCodec: fixture.probeAudioCodec,
      codecFlags: fixture.codecFlags,
    }))).toEqual([
      { name: "sample.mp4", kind: "video", videoCodec: "libx264", audioCodec: "aac", probeVideoCodec: "h264", probeAudioCodec: "aac", codecFlags: ["-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart"] },
      { name: "sample.mov", kind: "video", videoCodec: "libx264", audioCodec: "aac", probeVideoCodec: "h264", probeAudioCodec: "aac", codecFlags: ["-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p"] },
      { name: "sample.mkv", kind: "video", videoCodec: "libx264", audioCodec: "aac", probeVideoCodec: "h264", probeAudioCodec: "aac", codecFlags: ["-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-cluster_time_limit", "1000"] },
      { name: "sample.webm", kind: "video", videoCodec: "libvpx-vp9", audioCodec: "libopus", probeVideoCodec: "vp9", probeAudioCodec: "opus", codecFlags: ["-b:v", "200k", "-crf", "40", "-deadline", "realtime", "-cpu-used", "8", "-b:a", "64k", "-cluster_time_limit", "1000"] },
      { name: "sample.avi", kind: "video", videoCodec: "mpeg4", audioCodec: "libmp3lame", probeVideoCodec: "mpeg4", probeAudioCodec: "mp3", codecFlags: ["-q:v", "5", "-q:a", "9"] },
      { name: "sample.mp3", kind: "audio", videoCodec: null, audioCodec: "libmp3lame", probeVideoCodec: null, probeAudioCodec: "mp3", codecFlags: ["-q:a", "9"] },
      { name: "sample.m4a", kind: "audio", videoCodec: null, audioCodec: "aac", probeVideoCodec: null, probeAudioCodec: "aac", codecFlags: ["-b:a", "96k", "-f", "ipod"] },
      { name: "sample.wav", kind: "audio", videoCodec: null, audioCodec: "pcm_s16le", probeVideoCodec: null, probeAudioCodec: "pcm_s16le", codecFlags: [] },
      { name: "sample.flac", kind: "audio", videoCodec: null, audioCodec: "flac", probeVideoCodec: null, probeAudioCodec: "flac", codecFlags: ["-compression_level", "5"] },
      { name: "sample.ogg", kind: "audio", videoCodec: null, audioCodec: "libopus", probeVideoCodec: null, probeAudioCodec: "opus", codecFlags: ["-b:a", "64k", "-vbr", "on", "-application", "audio", "-serial_offset", "0", "-f", "ogg"] },
    ]);
  });

  it("rejects a manifest that changes the trusted FFmpeg version", () => {
    const spec = loadFixtureSpec();
    const manifest: FixtureManifest = {
      schemaVersion: spec.schemaVersion,
      generatorVersion: spec.generatorVersion,
      parameters: spec.parameters,
      ffmpeg: {
        version: "8.1.2-dev",
        versionLine: "ffmpeg version 8.1.2-dev",
        sha256: "a".repeat(64),
      },
      files: spec.generation.fixtures.map((fixture) => ({
        name: fixture.name,
        bytes: 1,
        sha256: "b".repeat(64),
      })),
    };

    expect(() => validateFixtureManifest(manifest, spec)).toThrow(/exact FFmpeg version/);
  });
});
