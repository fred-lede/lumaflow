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
