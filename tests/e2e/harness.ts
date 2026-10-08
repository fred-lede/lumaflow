import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  JobError,
  JobEvent,
  JobState,
  ProcessingKind,
  QueueJob,
  QueueSnapshot,
} from "../../src/domain/job";
import type { MediaInfo } from "../../src/domain/media";
import type { QueueEventAdapter } from "../../src/features/queue/useQueueEvents";
import {
  loadFixtureSpec,
  parseToolVersion,
  sha256File,
  trustedBinaryIdentity,
  validateFixtureManifest,
  type FixtureBinaryPolicy,
} from "../fixtures/contract";

const repoRoot = resolve(import.meta.dirname, "../..");
const rustManifestPath = resolve(repoRoot, "src-tauri/Cargo.toml");
const fixtureDirectory = resolve(repoRoot, "tests/fixtures");
const fixtureManifestPath = resolve(fixtureDirectory, "manifest.json");

export type RealMediaTrace = {
  traceSchemaVersion: 1;
  sourceMedia: MediaInfo[];
  outputDirectory: string;
  snapshots: {
    queued: QueueSnapshot;
    cancelled: QueueSnapshot;
    failed: QueueSnapshot;
    retried: QueueSnapshot;
    completed: QueueSnapshot;
  };
  beforeRetryEvents: JobEvent[];
  afterRetryEvents: JobEvent[];
};

function invalidTrace(path: string, message: string): Error {
  return new Error("Real media trace is invalid at " + path + ": " + message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidTrace(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidTrace(path, "expected a non-empty string");
  }
  return value;
}

function integerValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalidTrace(path, "expected a non-negative integer");
  }
  return value;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidTrace(path, "expected a finite number");
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidTrace(path, "expected a boolean");
  }
  return value;
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalidTrace(path, "expected an array");
  }
  return value;
}

function parseMediaInfo(value: unknown, path: string): MediaInfo {
  const input = record(value, path);
  const streams = (streamValue: unknown, streamPath: string, kind: "video" | "audio" | "subtitle") =>
    arrayValue(streamValue, streamPath).map((entry, index) => {
      const stream = record(entry, streamPath + "[" + index + "]");
      const base = {
        codec: stringValue(stream.codec, streamPath + "[" + index + "].codec"),
        streamIndex: integerValue(stream.streamIndex, streamPath + "[" + index + "].streamIndex"),
      };
      if (kind === "video") {
        return {
          ...base,
          width: integerValue(stream.width, streamPath + "[" + index + "].width"),
          height: integerValue(stream.height, streamPath + "[" + index + "].height"),
          frameRate: stringValue(stream.frameRate, streamPath + "[" + index + "].frameRate"),
        };
      }
      if (kind === "audio") {
        return {
          ...base,
          sampleRateHz: integerValue(stream.sampleRateHz, streamPath + "[" + index + "].sampleRateHz"),
          channels: integerValue(stream.channels, streamPath + "[" + index + "].channels"),
        };
      }
      return base;
    });
  return {
    path: stringValue(input.path, path + ".path"),
    fileName: stringValue(input.fileName, path + ".fileName"),
    container: stringValue(input.container, path + ".container"),
    durationSeconds: numberValue(input.durationSeconds, path + ".durationSeconds"),
    sizeBytes: integerValue(input.sizeBytes, path + ".sizeBytes"),
    videoStreams: streams(input.videoStreams, path + ".videoStreams", "video") as MediaInfo["videoStreams"],
    audioStreams: streams(input.audioStreams, path + ".audioStreams", "audio") as MediaInfo["audioStreams"],
    subtitleStreams: streams(input.subtitleStreams, path + ".subtitleStreams", "subtitle") as MediaInfo["subtitleStreams"],
  };
}

function parseJobState(value: unknown, path: string): JobState {
  const input = record(value, path);
  const kind = stringValue(input.kind, path + ".kind") as JobState["kind"];
  const label = stringValue(input.label, path + ".label");
  if (kind === "completed") {
    const warningValue = input.warning;
    return {
      kind,
      label: label as "Completed",
      outputPath: stringValue(input.outputPath, path + ".outputPath"),
      ...(warningValue === undefined ? {} : { warning: parseJobError(warningValue, path + ".warning") }),
    };
  }
  if (kind === "failed") {
    return {
      kind,
      label: label as "Failed",
      error: parseJobError(input.error, path + ".error"),
    };
  }
  if (!["queued", "analyzing", "losslessRemux", "losslessAudio", "transcoding", "cancelled"].includes(kind)) {
    throw invalidTrace(path + ".kind", "unknown job state " + kind);
  }
  return { kind, label } as JobState;
}

function parseJobError(value: unknown, path: string): JobError {
  const error = record(value, path);
  return {
    code: stringValue(error.code, path + ".code"),
    message: stringValue(error.message, path + ".message"),
    ...(error.details === undefined ? {} : { details: stringValue(error.details, path + ".details") }),
  };
}

function parseProcessingKind(value: unknown, path: string): ProcessingKind | null {
  if (value === null) {
    return null;
  }
  const input = record(value, path);
  const kind = stringValue(input.kind, path + ".kind");
  if (!["losslessRemux", "losslessAudio", "transcoding"].includes(kind)) {
    throw invalidTrace(path + ".kind", "unknown processing kind " + kind);
  }
  return { kind, label: stringValue(input.label, path + ".label") } as ProcessingKind;
}

function parseQueueJob(value: unknown, path: string): QueueJob {
  const input = record(value, path);
  const outputSettings = record(input.outputSettings, path + ".outputSettings");
  return {
    id: stringValue(input.id, path + ".id"),
    sourcePath: stringValue(input.sourcePath, path + ".sourcePath"),
    media: parseMediaInfo(input.media, path + ".media"),
    outputSettings: {
      outputDirectory: stringValue(outputSettings.outputDirectory, path + ".outputSettings.outputDirectory"),
      format: stringValue(outputSettings.format, path + ".outputSettings.format") as QueueJob["outputSettings"]["format"],
      quality: stringValue(outputSettings.quality, path + ".outputSettings.quality") as QueueJob["outputSettings"]["quality"],
      losslessFirst: booleanValue(outputSettings.losslessFirst, path + ".outputSettings.losslessFirst"),
      codec: outputSettings.codec === null ? null : stringValue(outputSettings.codec, path + ".outputSettings.codec"),
      bitrateKbps: outputSettings.bitrateKbps === null ? null : numberValue(outputSettings.bitrateKbps, path + ".outputSettings.bitrateKbps"),
      width: outputSettings.width === null ? null : numberValue(outputSettings.width, path + ".outputSettings.width"),
      height: outputSettings.height === null ? null : numberValue(outputSettings.height, path + ".outputSettings.height"),
      frameRate: outputSettings.frameRate === null ? null : stringValue(outputSettings.frameRate, path + ".outputSettings.frameRate"),
      sampleRateHz: outputSettings.sampleRateHz === null ? null : numberValue(outputSettings.sampleRateHz, path + ".outputSettings.sampleRateHz"),
      channels: outputSettings.channels === null ? null : numberValue(outputSettings.channels, path + ".outputSettings.channels"),
    },
    processingKind: parseProcessingKind(input.processingKind, path + ".processingKind"),
    attempt: integerValue(input.attempt, path + ".attempt"),
    state: parseJobState(input.state, path + ".state"),
    progress: numberValue(input.progress, path + ".progress"),
    outputPath: input.outputPath === null ? null : stringValue(input.outputPath, path + ".outputPath"),
  };
}

function parseQueueSnapshot(value: unknown, path: string): QueueSnapshot {
  const input = record(value, path);
  return {
    revision: integerValue(input.revision, path + ".revision"),
    jobs: arrayValue(input.jobs, path + ".jobs").map((job, index) => parseQueueJob(job, path + ".jobs[" + index + "]")),
    paused: booleanValue(input.paused, path + ".paused"),
  };
}

function parseJobEvent(value: unknown, path: string): JobEvent {
  const input = record(value, path);
  const kind = stringValue(input.kind, path + ".kind");
  const common = {
    jobId: stringValue(input.jobId, path + ".jobId"),
    revision: integerValue(input.revision, path + ".revision"),
    sequence: integerValue(input.sequence, path + ".sequence"),
    attempt: integerValue(input.attempt, path + ".attempt"),
  };
  if (kind === "progress") {
    const progress = numberValue(input.progress, path + ".progress");
    if (progress < 0 || progress > 1) {
      throw invalidTrace(path + ".progress", "must be between 0 and 1");
    }
    return { kind, ...common, progress };
  }
  if (kind === "stateChanged") {
    return { kind, ...common, state: parseJobState(input.state, path + ".state") };
  }
  throw invalidTrace(path + ".kind", "unknown job event " + kind);
}

function parseRealMediaTrace(value: unknown): RealMediaTrace {
  const input = record(value, "root");
  if (input.traceSchemaVersion !== 1) {
    throw invalidTrace("traceSchemaVersion", "expected version 1");
  }
  const snapshots = record(input.snapshots, "snapshots");
  const sourceMedia = arrayValue(input.sourceMedia, "sourceMedia").map((media, index) =>
    parseMediaInfo(media, "sourceMedia[" + index + "]"),
  );
  if (sourceMedia.length < 2) {
    throw invalidTrace("sourceMedia", "expected at least two probed source files");
  }
  const snapshotNames = ["queued", "cancelled", "failed", "retried", "completed"] as const;
  const parsedSnapshots = Object.fromEntries(
    snapshotNames.map((name) => [name, parseQueueSnapshot(snapshots[name], "snapshots." + name)]),
  ) as RealMediaTrace["snapshots"];
  const parseEvents = (name: "beforeRetryEvents" | "afterRetryEvents") =>
    arrayValue(input[name], name).map((event, index) => parseJobEvent(event, name + "[" + index + "]"));
  return {
    traceSchemaVersion: 1,
    sourceMedia,
    outputDirectory: stringValue(input.outputDirectory, "outputDirectory"),
    snapshots: parsedSnapshots,
    beforeRetryEvents: parseEvents("beforeRetryEvents"),
    afterRetryEvents: parseEvents("afterRetryEvents"),
  };
}

function requiredExecutable(name: string, policy: FixtureBinaryPolicy, tool: "ffmpeg" | "ffprobe"): string {
  const value = process.env[name];
  if (!value || !existsSync(value)) {
    throw new Error(name + " is required for real media E2E; set it to the release-pinned executable");
  }
  const stats = statSync(value);
  if (!stats.isFile() || (process.platform !== "win32" && (stats.mode & 0o111) === 0)) {
    throw new Error(name + " must point to an executable regular file: " + value);
  }
  let versionOutput: string;
  try {
    versionOutput = execFileSync(value, ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(name + " could not execute -version: " + String(error));
  }
  const version = parseToolVersion(versionOutput, tool);
  const trustedIdentity = trustedBinaryIdentity(policy, tool === "ffmpeg" ? "FFmpeg" : "FFprobe");
  if (version !== trustedIdentity.version) {
    throw new Error(name + " reports version " + version + "; committed trusted identity requires " + trustedIdentity.version);
  }
  const actualDigest = sha256File(value);
  if (actualDigest !== trustedIdentity.sha256) {
    throw new Error(
      name + " SHA-256 " + actualDigest + " does not match the committed trusted digest " + trustedIdentity.sha256,
    );
  }
  return value;
}

export function runRealMediaTrace(): RealMediaTrace {
  const spec = loadFixtureSpec();
  const ffmpeg = requiredExecutable("LUMAFLOW_FFMPEG_TEST_BIN", spec.ffmpeg, "ffmpeg");
  const ffprobe = requiredExecutable("LUMAFLOW_FFPROBE_TEST_BIN", spec.ffprobe, "ffprobe");
  if (!existsSync(fixtureManifestPath)) {
    throw new Error(
      "Fixture manifest is missing at " + fixtureManifestPath + "; run npm run fixtures with the trusted asset configuration",
    );
  }
  const manifest = validateFixtureManifest(
    JSON.parse(readFileSync(fixtureManifestPath, "utf8")) as unknown,
    spec,
  );
  if (manifest.ffmpeg.sha256 !== sha256File(ffmpeg)) {
    throw new Error("Fixture manifest FFmpeg digest does not match the configured FFmpeg executable");
  }
  for (const file of manifest.files) {
    const path = resolve(fixtureDirectory, file.name);
    if (!existsSync(path) || statSync(path).size !== file.bytes || sha256File(path) !== file.sha256) {
      throw new Error("Generated fixture checksum or size mismatch: " + path);
    }
  }
  const traceDirectory = mkdtempSync(join(tmpdir(), "lumaflow-real-media-trace-"));
  const tracePath = join(traceDirectory, "trace.json");

  try {
    execFileSync(
      "cargo",
      [
        "test",
        "--manifest-path",
        rustManifestPath,
        "--test",
        "real_media_fixtures",
        "real_fixture_probe_and_planner_matrix_and_ui_trace",
        "--",
        "--exact",
        "--nocapture",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          LUMAFLOW_FFMPEG_TEST_BIN: ffmpeg,
          LUMAFLOW_FFPROBE_TEST_BIN: ffprobe,
          LUMAFLOW_E2E_EVENT_TRACE: tracePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (!existsSync(tracePath)) {
      throw new Error(`Real media integration passed without writing its trace: ${tracePath}`);
    }
    return parseRealMediaTrace(JSON.parse(readFileSync(tracePath, "utf8")) as unknown);
  } catch (error) {
    const failure = error as { stderr?: string | Buffer; message?: string };
    throw new Error(
      `Real media Cargo integration failed. Check generated fixtures and pinned FFmpeg/FFprobe assets.\n${
        failure.stderr?.toString().trim() || failure.message || String(error)
      }`,
    );
  } finally {
    rmSync(traceDirectory, { recursive: true, force: true });
  }
}

export class SerializedJobEventSource implements QueueEventAdapter {
  private readonly listeners = new Set<(event: JobEvent) => void>();

  listen(handler: (event: JobEvent) => void): Promise<() => void> {
    this.listeners.add(handler);
    return Promise.resolve(() => this.listeners.delete(handler));
  }

  replay(events: JobEvent[]): void {
    for (const event of events) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }
}
