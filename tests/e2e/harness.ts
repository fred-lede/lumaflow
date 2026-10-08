import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { JobEvent, QueueSnapshot } from "../../src/domain/job";
import type { MediaInfo } from "../../src/domain/media";
import type { QueueEventAdapter } from "../../src/features/queue/useQueueEvents";

const repoRoot = resolve(import.meta.dirname, "../..");
const rustManifestPath = resolve(repoRoot, "src-tauri/Cargo.toml");

export type RealMediaTrace = {
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

function requiredExecutable(name: string): string {
  const value = process.env[name];
  if (!value || !existsSync(value)) {
    throw new Error(`${name} is required for real media E2E; set it to the release-pinned executable`);
  }
  const stats = statSync(value);
  if (!stats.isFile() || (process.platform !== "win32" && (stats.mode & 0o111) === 0)) {
    throw new Error(`${name} must point to an executable regular file: ${value}`);
  }
  return value;
}

export function runRealMediaTrace(): RealMediaTrace {
  const ffmpeg = requiredExecutable("LUMAFLOW_FFMPEG_TEST_BIN");
  const ffprobe = requiredExecutable("LUMAFLOW_FFPROBE_TEST_BIN");
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
    return JSON.parse(readFileSync(tracePath, "utf8")) as RealMediaTrace;
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
