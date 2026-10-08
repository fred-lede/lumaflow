import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadFixtureSpec,
  sha256File,
  validateFixtureManifest,
} from "../fixtures/contract";
import { runRealMediaTrace } from "./harness";

const repoRoot = resolve(import.meta.dirname, "../..");
const fixtureDirectory = resolve(repoRoot, "tests/fixtures");
const manifestPath = resolve(fixtureDirectory, "manifest.json");

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

function loadManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Fixture manifest is missing at ${manifestPath}. Run ` +
        "LUMAFLOW_FFMPEG_TEST_BIN=/absolute/path/to/ffmpeg npm run fixtures",
    );
  }
  return validateFixtureManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    loadFixtureSpec(),
  );
}

function requiredExecutable(name: string): string {
  const value = process.env[name];
  if (!value || !existsSync(value)) {
    throw new Error(`${name} is required for desktop E2E`);
  }
  const stats = statSync(value);
  if (!stats.isFile() || (process.platform !== "win32" && (stats.mode & 0o111) === 0)) {
    throw new Error(`${name} must point to an executable regular file: ${value}`);
  }
  return value;
}

describe("real conversion boundary", () => {
  it("requires generated fixtures and verifies every manifest checksum", () => {
    const manifest = loadManifest();
    expect(manifest.ffmpeg.version).toBeTruthy();
    expect(manifest.files.map((file) => file.name)).toEqual(expectedFixtureNames);

    for (const file of manifest.files) {
      const path = resolve(fixtureDirectory, file.name);
      expect(existsSync(path), `${file.name} is missing`).toBe(true);
      const stats = statSync(path);
      const bytes = readFileSync(path);
      expect(stats.size).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
      expect(sha256File(path)).toBe(file.sha256);
    }
  });

  it("runs real FFprobe, planner, scheduler, and FFmpeg boundaries", () => {
    const trace = runRealMediaTrace();

    expect(trace.sourceMedia.map((media) => media.fileName)).toEqual(["sample.mp4", "sample.mov"]);
    expect(trace.snapshots.cancelled.jobs.find((job) => job.id === "cancel-job")?.state.kind).toBe("cancelled");
    expect(trace.snapshots.failed.jobs.find((job) => job.id === "retry-job")?.state.kind).toBe("failed");
    expect(trace.snapshots.completed.jobs.find((job) => job.id === "retry-job")?.state.kind).toBe("completed");
    expect(trace.beforeRetryEvents.some((event) => event.kind === "progress")).toBe(false);
    expect(trace.afterRetryEvents.some((event) => event.kind === "progress")).toBe(true);
  }, 30000);
});

describe("opt-in desktop E2E protocol (protocol-only; native execution is runner-owned)", () => {
  it.runIf(process.env.LUMAFLOW_DESKTOP_E2E === "1")(
    "requires a protocol-aware runner and exact nonce-bound JSON pass response",
    () => {
      const runner = requiredExecutable("LUMAFLOW_TAURI_E2E_RUNNER");
      const ffmpeg = requiredExecutable("LUMAFLOW_FFMPEG_TEST_BIN");
      const ffprobe = requiredExecutable("LUMAFLOW_FFPROBE_TEST_BIN");
      const nonce = randomUUID();
      const output = execFileSync(runner, ["e2e"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          LUMAFLOW_DESKTOP_E2E: "1",
          LUMAFLOW_DESKTOP_E2E_PROTOCOL: "1",
          LUMAFLOW_DESKTOP_E2E_NONCE: nonce,
          LUMAFLOW_FFMPEG_TEST_BIN: ffmpeg,
          LUMAFLOW_FFPROBE_TEST_BIN: ffprobe,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const lines = output.split(/\r?\n/u);
      if (lines.at(-1) === "") {
        lines.pop();
      }
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toBe("");
      const response = JSON.parse(lines[0] ?? "") as unknown;
      expect(response).toEqual({
        protocol: "lumaflow.desktop-e2e",
        protocolVersion: 1,
        nonce,
        result: "pass",
      });
    },
  );
});
