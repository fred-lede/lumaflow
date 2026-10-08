import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const fixtureDirectory = resolve(repoRoot, "tests/fixtures");
const manifestPath = resolve(fixtureDirectory, "manifest.json");
const ffmpegEnvironmentVariable = "LUMAFLOW_FFMPEG_TEST_BIN";
const versionEnvironmentVariable = "LUMAFLOW_FFMPEG_TEST_VERSION";
const generatorVersion = 1;

type FixtureDefinition = {
  name: string;
  args: (outputPath: string) => string[];
};

type FixtureManifest = {
  schemaVersion: 1;
  generatorVersion: number;
  parameters: {
    durationSeconds: 1;
    videoSize: "160x90";
    videoRate: 10;
    audioFrequencyHz: 440;
    audioSampleRateHz: 48_000;
    threads: 1;
  };
  ffmpeg: { version: string };
  files: Array<{ name: string; bytes: number; sha256: string }>;
};

const deterministicParameters: FixtureManifest["parameters"] = {
  durationSeconds: 1,
  videoSize: "160x90",
  videoRate: 10,
  audioFrequencyHz: 440,
  audioSampleRateHz: 48_000,
  threads: 1,
};

const sharedFlags = [
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-threads",
  "1",
  "-filter_threads",
  "1",
  "-filter_complex_threads",
  "1",
  "-fflags",
  "+bitexact",
];

const outputMetadataFlags = [
  "-fflags",
  "+bitexact",
  "-flags:v",
  "+bitexact",
  "-flags:a",
  "+bitexact",
  "-map_metadata",
  "-1",
  "-map_chapters",
  "-1",
];

const videoInput = ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=1"];
const audioInput = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1"];

function videoFixture(
  name: string,
  videoCodec: string,
  audioCodec: string,
  codecFlags: string[],
): FixtureDefinition {
  return {
    name,
    args: (outputPath) => [
      ...sharedFlags,
      ...videoInput,
      ...audioInput,
      "-t",
      "1",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      videoCodec,
      ...codecFlags,
      "-c:a",
      audioCodec,
      "-b:a",
      "96k",
      ...outputMetadataFlags,
      outputPath,
    ],
  };
}

function audioFixture(name: string, codec: string, codecFlags: string[]): FixtureDefinition {
  return {
    name,
    args: (outputPath) => [
      ...sharedFlags,
      ...audioInput,
      "-t",
      "1",
      "-vn",
      "-map",
      "0:a:0",
      "-c:a",
      codec,
      ...codecFlags,
      ...outputMetadataFlags,
      outputPath,
    ],
  };
}

const fixtureDefinitions: FixtureDefinition[] = [
  videoFixture("sample.mp4", "libx264", "aac", ["-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]),
  videoFixture("sample.mov", "libx264", "aac", ["-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p"]),
  videoFixture("sample.mkv", "libx264", "aac", ["-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-cluster_time_limit", "1000"]),
  videoFixture("sample.webm", "libvpx-vp9", "libopus", ["-b:v", "200k", "-crf", "40", "-deadline", "realtime", "-cpu-used", "8", "-b:a", "64k", "-cluster_time_limit", "1000"]),
  videoFixture("sample.avi", "mpeg4", "libmp3lame", ["-q:v", "5", "-q:a", "9"]),
  audioFixture("sample.mp3", "libmp3lame", ["-q:a", "9"]),
  audioFixture("sample.m4a", "aac", ["-b:a", "96k", "-f", "ipod"]),
  audioFixture("sample.wav", "pcm_s16le", []),
  audioFixture("sample.flac", "flac", ["-compression_level", "5"]),
  audioFixture("sample.ogg", "libopus", ["-b:a", "64k", "-vbr", "on", "-application", "audio", "-serial_offset", "0", "-f", "ogg"]),
];

function commandFailure(binary: string, args: string[], error: unknown): Error {
  const failure = error as { stderr?: string | Buffer; message?: string };
  const stderr = failure.stderr?.toString().trim() || failure.message || "unknown process error";
  return new Error(`FFmpeg command failed: ${binary} ${args.join(" ")}\n${stderr}`);
}

function run(binary: string, args: string[], label: string): string {
  try {
    return execFileSync(binary, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`${label}\n${commandFailure(binary, args, error).message}`);
  }
}

function requirePinnedFfmpeg(): { binary: string; version: string } {
  const configuredPath = process.env[ffmpegEnvironmentVariable];
  if (!configuredPath) {
    throw new Error(
      `${ffmpegEnvironmentVariable} is required. Set it to the release-pinned FFmpeg test executable; ` +
        "the generator will not fall back to ffmpeg on PATH.",
    );
  }

  const binary = resolve(configuredPath);
  if (!existsSync(binary)) {
    throw new Error(`${ffmpegEnvironmentVariable} does not exist: ${binary}`);
  }
  const stats = statSync(binary);
  if (!stats.isFile()) {
    throw new Error(`${ffmpegEnvironmentVariable} must point to a regular file: ${binary}`);
  }
  if ((stats.mode & 0o111) === 0) {
    throw new Error(`${ffmpegEnvironmentVariable} is not executable: ${binary}`);
  }

  const version = run(binary, ["-version"], "Could not execute the configured FFmpeg test binary").split("\n")[0]?.trim() ?? "";
  const requiredVersion = process.env[versionEnvironmentVariable];
  if (requiredVersion && !version.includes(requiredVersion)) {
    throw new Error(
      `${versionEnvironmentVariable}=${requiredVersion} does not match the configured binary. ` +
        `Reported: ${version}`,
    );
  }
  return { binary, version };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function generateFixtures(binary: string, version: string): FixtureManifest {
  if (existsSync(manifestPath)) {
    unlinkSync(manifestPath);
  }

  const files: FixtureManifest["files"] = [];
  for (const definition of fixtureDefinitions) {
    const outputPath = resolve(fixtureDirectory, definition.name);
    const args = definition.args(outputPath);
    run(binary, args, `Could not generate ${definition.name}`);
    const stats = statSync(outputPath);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error(`FFmpeg produced an empty or missing fixture: ${outputPath}`);
    }
    files.push({ name: definition.name, bytes: stats.size, sha256: sha256(outputPath) });
  }

  return {
    schemaVersion: 1,
    generatorVersion,
    parameters: deterministicParameters,
    ffmpeg: { version },
    files,
  };
}

function main(): void {
  const { binary, version } = requirePinnedFfmpeg();
  const manifest = generateFixtures(binary, version);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Generated ${manifest.files.length} deterministic fixtures with ${version}`);
  console.log(`Manifest: ${manifestPath}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
