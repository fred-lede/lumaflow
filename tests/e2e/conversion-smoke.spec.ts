import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import type { EnqueueJobRequest, JobState, QueueJob, QueueSnapshot } from "../../src/domain/job";
import type { MediaInfo, OutputSettings } from "../../src/domain/media";
import QueuePanel from "../../src/features/queue/QueuePanel";
import {
  createQueueController,
  type QueueController,
} from "../../src/features/queue/useQueueEvents";
import {
  createFileIntakeController,
  type FileIntakeController,
} from "../../src/features/intake/useFileIntake";

const repoRoot = resolve(import.meta.dirname, "../..");
const fixtureManifestPath = resolve(repoRoot, "tests/fixtures/manifest.json");
const rustManifestPath = resolve(repoRoot, "src-tauri/Cargo.toml");

type FixtureManifest = {
  parameters: { durationSeconds: number; videoSize: string; videoRate: number; threads: number };
  files: Array<{ name: string; bytes: number; sha256: string }>;
  ffmpeg: { version: string };
};

const expectedFixtureNames = [
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
] as const;

function loadManifest(): FixtureManifest {
  if (!existsSync(fixtureManifestPath)) {
    throw new Error(
      `Fixture manifest is missing at ${fixtureManifestPath}. Run ` +
        "LUMAFLOW_FFMPEG_TEST_BIN=/absolute/path/to/ffmpeg npm run fixtures",
    );
  }
  return JSON.parse(readFileSync(fixtureManifestPath, "utf8")) as FixtureManifest;
}

function settings(outputDirectory: string, format: OutputSettings["format"] = "mp3"): OutputSettings {
  return {
    outputDirectory,
    format,
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
}

function media(path: string, fileName: string): MediaInfo {
  return {
    path,
    fileName,
    container: fileName.endsWith(".wav") ? "wav" : "mov,mp4,m4a,3gp,3g2,mj2",
    durationSeconds: 1,
    sizeBytes: 128,
    videoStreams: fileName.endsWith(".wav")
      ? []
      : [{ codec: "h264", streamIndex: 0, width: 160, height: 90, frameRate: "10/1" }],
    audioStreams: [{ codec: fileName.endsWith(".wav") ? "pcm_s16le" : "aac", streamIndex: fileName.endsWith(".wav") ? 0 : 1, sampleRateHz: 48_000, channels: 2 }],
    subtitleStreams: [],
  };
}

function job(
  id: string,
  sourcePath: string,
  outputDirectory: string,
  state: JobState = { kind: "queued", label: "Queued" },
  attempt = 1,
): QueueJob {
  const fileName = sourcePath.split(/[\\/]/).at(-1) ?? `${id}.mp4`;
  return {
    id,
    sourcePath,
    media: media(sourcePath, fileName),
    outputSettings: settings(outputDirectory),
    processingKind: { kind: "transcoding", label: "Transcoding" },
    attempt,
    state,
    progress: state.kind === "completed" ? 1 : 0,
    outputPath: state.kind === "completed" ? state.outputPath : null,
  };
}

function snapshot(jobs: QueueJob[], revision: number): QueueSnapshot {
  return { revision, jobs, paused: false };
}

function plannerTestOutput(): string {
  return execFileSync(
    "cargo",
    ["test", "--manifest-path", rustManifestPath, "media::planner::tests::", "--", "--format", "pretty"],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

describe("conversion boundary", () => {
  it("requires all generated fixture files and verifies their manifest checksums", () => {
    const manifest = loadManifest();
    expect(manifest.ffmpeg.version).toBeTruthy();
    expect(manifest.parameters).toMatchObject({ durationSeconds: 1, videoSize: "160x90", videoRate: 10, threads: 1 });
    expect(manifest.files.map((file) => file.name)).toEqual(expectedFixtureNames);

    for (const file of manifest.files) {
      const filePath = resolve(repoRoot, "tests/fixtures", file.name);
      expect(existsSync(filePath), `${file.name} is missing`).toBe(true);
      const bytes = readFileSync(filePath);
      expect(bytes.byteLength).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
  });

  it("runs the real Rust planner branches for remux, transcode, and lossless audio", () => {
    const output = plannerTestOutput();

    expect(output).toContain("plans_mp4_to_mp4_as_lossless_remux_with_all_stream_maps");
    expect(output).toContain("plans_mp4_to_mp3_as_transcoding_and_maps_audio_only");
    expect(output).toContain("plans_wav_pcm_to_flac_as_lossless_audio");
    expect(output).toContain("unsupported_container_returns_structured_error_instead_of_lossless_label");
  });
});

describe("queue and intake boundary", () => {
  it("intakes a seeded batch and drives progress, cancellation, retry, completion, and output-folder action", async () => {
    const root = mkdtempSync(join(tmpdir(), "lumaflow-e2e-"));
    const inputDirectory = join(root, "input");
    const outputDirectory = join(root, "output");
    const sourcePaths = [join(inputDirectory, "first.mp4"), join(inputDirectory, "second.mp4")];
    const outputPath = join(outputDirectory, "first.mp3");
    let backendSnapshot = snapshot([], 0);
    let nextJobId = 0;
    const enqueueCalls: EnqueueJobRequest[][] = [];
    const openedFolders: string[] = [];
    let queue!: QueueController;

    const nextBackendRevision = (): number => Math.max(backendSnapshot.revision, queue.getState().revision) + 1;

    try {
      for (const directory of [inputDirectory, outputDirectory]) {
        mkdirSync(directory, { recursive: true });
      }
      for (const sourcePath of sourcePaths) {
        writeFileSync(sourcePath, "seeded test input");
      }

      queue = createQueueController({
        commands: {
          enqueueJobs: async (requests) => {
            enqueueCalls.push(requests);
            const added = requests.map((request) => {
              nextJobId += 1;
              return job(`job-${nextJobId}`, request.sourcePath, request.outputSettings.outputDirectory);
            });
            backendSnapshot = snapshot([...backendSnapshot.jobs, ...added], nextBackendRevision());
            return backendSnapshot;
          },
          cancelJob: async (jobId) => {
            backendSnapshot = snapshot(
              backendSnapshot.jobs.map((candidate) =>
                candidate.id === jobId ? { ...candidate, state: { kind: "cancelled", label: "Cancelled" } } : candidate,
              ),
              nextBackendRevision(),
            );
            return backendSnapshot;
          },
          retryJob: async (jobId) => {
            backendSnapshot = snapshot(
              backendSnapshot.jobs.map((candidate) =>
                candidate.id === jobId
                  ? { ...candidate, attempt: candidate.attempt + 1, progress: 0, state: { kind: "queued", label: "Queued" } }
                  : candidate,
              ),
              nextBackendRevision(),
            );
            return backendSnapshot;
          },
          openOutputFolder: async (path) => {
            openedFolders.push(path);
          },
        },
      });

      const intake: FileIntakeController = createFileIntakeController({
        selectFiles: async () => sourcePaths,
        analyzeFiles: async (paths) => paths.map((path) => media(path, path.split(/[\\/]/).at(-1) ?? "input.mp4")),
        enqueueJobs: (requests) => queue.enqueueJobs(requests),
        registerFileDropHandler: async () => () => undefined,
      });

      await intake.chooseFiles();
      expect(intake.getState().sources).toHaveLength(2);
      expect(intake.getState().canStart).toBe(true);

      const enqueueResult = await intake.start(settings(outputDirectory));
      expect(enqueueResult?.enqueuedIds).toHaveLength(2);
      expect(enqueueCalls).toHaveLength(2);
      expect(queue.getState().order).toEqual(["job-1", "job-2"]);

      const queuedMarkup = renderToStaticMarkup(createElement(QueuePanel, { controller: queue }));
      expect(queuedMarkup).toContain("first.mp4");
      expect(queuedMarkup).toContain("second.mp4");
      expect(queuedMarkup).toContain('aria-label="Conversion jobs"');

      queue.handleEvent({
        kind: "stateChanged",
        jobId: "job-1",
        state: { kind: "transcoding", label: "Transcoding" },
        revision: 4,
        sequence: 1,
        attempt: 1,
      });
      queue.handleEvent({ kind: "progress", jobId: "job-1", progress: 0.5, revision: 5, sequence: 2, attempt: 1 });
      expect(queue.getState().jobsById["job-1"]?.progress).toBe(0.5);

      await queue.cancelJob("job-2");
      expect(queue.getState().jobsById["job-2"]?.state.kind).toBe("cancelled");

      queue.handleEvent({
        kind: "stateChanged",
        jobId: "job-1",
        state: {
          kind: "failed",
          label: "Failed",
          error: { code: "ffmpeg_failed", message: "The seeded conversion failed", details: "test" },
        },
        revision: 7,
        sequence: 3,
        attempt: 1,
      });
      await queue.retryJob("job-1");
      expect(queue.getState().jobsById["job-1"]?.attempt).toBe(2);

      queue.handleEvent({
        kind: "stateChanged",
        jobId: "job-1",
        state: { kind: "completed", label: "Completed", outputPath },
        revision: 9,
        sequence: 4,
        attempt: 2,
      });
      await queue.openOutputFolder("job-1", outputPath);
      expect(queue.getState().jobsById["job-1"]?.state.kind).toBe("completed");
      expect(openedFolders).toEqual([outputPath]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

if (process.env.LUMAFLOW_DESKTOP_E2E === "1") {
  it("runs the explicitly requested desktop E2E runner with the pinned asset", () => {
    const runner = process.env.LUMAFLOW_TAURI_E2E_RUNNER;
    const ffmpeg = process.env.LUMAFLOW_FFMPEG_TEST_BIN;
    const isExecutableFile = (path: string | undefined): path is string => {
      if (!path || !existsSync(path)) {
        return false;
      }
      const stats = statSync(path);
      return stats.isFile() && (stats.mode & 0o111) !== 0;
    };
    if (!isExecutableFile(runner)) {
      throw new Error("LUMAFLOW_DESKTOP_E2E=1 requires an executable LUMAFLOW_TAURI_E2E_RUNNER path");
    }
    if (!isExecutableFile(ffmpeg)) {
      throw new Error("LUMAFLOW_DESKTOP_E2E=1 requires the release FFmpeg asset via LUMAFLOW_FFMPEG_TEST_BIN");
    }
    execFileSync(runner, [], {
      cwd: repoRoot,
      env: { ...process.env, LUMAFLOW_FFMPEG_TEST_BIN: ffmpeg },
      stdio: "inherit",
    });
  });
}
