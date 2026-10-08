import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const nodeArgs = ["--experimental-strip-types"];

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeExecutable(path: string, output: string): void {
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "${output}"\n`);
  chmodSync(path, 0o755);
}

function testManifest(archiveSha256: string): object {
  const target = {
    archive: { file: "darwin-arm64.zip", sha256: archiveSha256 },
    ffmpeg: { path: "ffmpeg" },
    ffprobe: { path: "ffprobe" },
  };
  return {
    schemaVersion: 1,
    ffmpegVersion: "8.1.2",
    targets: Object.fromEntries(
      ["darwin-arm64", "darwin-x64", "windows-x64", "linux-x64"].map((name) => [name, target]),
    ),
  };
}

function run(script: string, args: string[]): { status: number; output: string } {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [...nodeArgs, resolve(repoRoot, script), ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

describe("verify-ffmpeg-assets", () => {
  it("fails clearly when a target asset directory is absent", () => {
    const result = run("scripts/verify-ffmpeg-assets.ts", ["--target", "darwin-arm64"]);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/release assets are absent/i);
    expect(result.output).toMatch(/darwin-arm64/);
  });

  it("accepts executable tools only when archive, versions, and permissions match the lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumaflow-release-check-"));
    const assetDirectory = join(directory, "darwin-arm64");
    mkdirSync(assetDirectory);
    const archive = join(directory, "darwin-arm64.zip");
    writeFileSync(archive, "trusted archive");
    const ffmpeg = join(assetDirectory, "ffmpeg");
    const ffprobe = join(assetDirectory, "ffprobe");
    writeExecutable(ffmpeg, "ffmpeg version 8.1.2 test build");
    writeExecutable(ffprobe, "ffprobe version 8.1.2 test build");

    const manifest = join(directory, "assets.json");
    writeFileSync(manifest, JSON.stringify(testManifest(digest("trusted archive"))));

    const result = run("scripts/verify-ffmpeg-assets.ts", [
      "--target",
      "darwin-arm64",
      "--asset-dir",
      assetDirectory,
      "--archive",
      archive,
      "--manifest",
      manifest,
    ]);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/verified/i);
  });

  it("rejects an archive whose immutable checksum differs", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumaflow-release-check-"));
    const assetDirectory = join(directory, "darwin-arm64");
    mkdirSync(assetDirectory);
    const archive = join(directory, "darwin-arm64.zip");
    writeFileSync(archive, "tampered archive");
    writeExecutable(join(assetDirectory, "ffmpeg"), "ffmpeg version 8.1.2 test build");
    writeExecutable(join(assetDirectory, "ffprobe"), "ffprobe version 8.1.2 test build");
    const manifest = join(directory, "assets.json");
    writeFileSync(manifest, JSON.stringify(testManifest(digest("trusted archive"))));

    const result = run("scripts/verify-ffmpeg-assets.ts", [
      "--target",
      "darwin-arm64",
      "--asset-dir",
      assetDirectory,
      "--archive",
      archive,
      "--manifest",
      manifest,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/SHA-256 mismatch/i);
  });
});

describe("check-third-party-licenses", () => {
  it("rejects a target notice that does not match the verified asset metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumaflow-license-check-"));
    const assetDirectory = join(directory, "darwin-arm64");
    mkdirSync(join(assetDirectory, "licenses"), { recursive: true });
    writeExecutable(join(assetDirectory, "ffmpeg"), "ffmpeg version 8.1.2 test build");
    writeExecutable(join(assetDirectory, "ffprobe"), "ffprobe version 8.1.2 test build");
    writeFileSync(join(assetDirectory, "ffmpeg-buildconf.txt"), "configuration: --enable-gpl --enable-libx264\n");
    writeFileSync(join(assetDirectory, "licenses", "COPYING"), "FFmpeg license text\n");
    writeFileSync(join(assetDirectory, "THIRD_PARTY_NOTICES.md"), "stale notice\n");
    const archive = join(directory, "darwin-arm64.zip");
    writeFileSync(archive, "trusted archive");
    const manifest = join(directory, "assets.json");
    writeFileSync(manifest, JSON.stringify(testManifest(digest("trusted archive"))));

    const result = run("scripts/check-third-party-licenses.ts", [
      "--target",
      "darwin-arm64",
      "--asset-dir",
      assetDirectory,
      "--manifest",
      manifest,
      "--archive",
      archive,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/notice does not match/i);
  });
});
