import { execFileSync } from "node:child_process";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  loadFixtureSpec,
  parseToolVersion,
  sha256File,
  trustedBinaryIdentity,
  validateFixtureManifest,
  type FixtureDefinition,
  type FixtureManifest,
  type FixtureSpec,
} from "../tests/fixtures/contract.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const fixtureDirectory = resolve(repoRoot, "tests/fixtures");
const manifestPath = resolve(fixtureDirectory, "manifest.json");
const ffmpegEnvironmentVariable = "LUMAFLOW_FFMPEG_TEST_BIN";
const ffprobeEnvironmentVariable = "LUMAFLOW_FFPROBE_TEST_BIN";
const versionEnvironmentVariable = "LUMAFLOW_FFMPEG_TEST_VERSION";

type GeneratedFixture = {
  name: string;
  args: (outputPath: string) => string[];
};

function commandFailure(binary: string, args: string[], error: unknown): Error {
  const failure = error as { stderr?: string | Buffer; message?: string };
  const stderr = failure.stderr?.toString().trim() || failure.message || "unknown process error";
  return new Error("FFmpeg command failed: " + binary + " " + args.join(" ") + "\n" + stderr);
}

function run(binary: string, args: string[], label: string): string {
  try {
    return execFileSync(binary, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(label + "\n" + commandFailure(binary, args, error).message);
  }
}

function generatedFixture(definition: FixtureDefinition, spec: FixtureSpec): GeneratedFixture {
  if (definition.kind === "video") {
    return {
      name: definition.name,
      args: (outputPath) => [
        ...spec.generation.sharedFlags,
        ...spec.generation.videoInput,
        ...spec.generation.audioInput,
        "-t",
        String(spec.parameters.durationSeconds),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        definition.videoCodec!,
        ...definition.codecFlags,
        "-c:a",
        definition.audioCodec,
        ...spec.generation.videoAudioFlags,
        ...spec.generation.outputMetadataFlags,
        outputPath,
      ],
    };
  }
  return {
    name: definition.name,
    args: (outputPath) => [
      ...spec.generation.sharedFlags,
      ...spec.generation.audioInput,
      "-t",
      String(spec.parameters.durationSeconds),
      "-vn",
      "-map",
      "0:a:0",
      "-c:a",
      definition.audioCodec,
      ...definition.codecFlags,
      ...spec.generation.outputMetadataFlags,
      outputPath,
    ],
  };
}

function requirePinnedFfmpeg(spec: FixtureSpec): {
  binary: string;
  version: string;
  versionLine: string;
  sha256: string;
} {
  const trustedIdentity = trustedBinaryIdentity(spec.ffmpeg, "FFmpeg");
  const configuredPath = process.env[ffmpegEnvironmentVariable];
  if (!configuredPath) {
    throw new Error(
      ffmpegEnvironmentVariable +
        " is required. Set it to the release-pinned FFmpeg test executable; the generator will not fall back to ffmpeg on PATH.",
    );
  }

  const binary = resolve(configuredPath);
  if (!existsSync(binary)) {
    throw new Error(ffmpegEnvironmentVariable + " does not exist: " + binary);
  }
  const stats = statSync(binary);
  if (!stats.isFile()) {
    throw new Error(ffmpegEnvironmentVariable + " must point to a regular file: " + binary);
  }
  if ((stats.mode & 0o111) === 0) {
    throw new Error(ffmpegEnvironmentVariable + " is not executable: " + binary);
  }

  const versionLine = run(binary, ["-version"], "Could not execute the configured FFmpeg test binary")
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim() ?? "";
  const version = parseToolVersion(versionLine, "ffmpeg");
  if (version !== trustedIdentity.version) {
    throw new Error(
      "Configured FFmpeg version " + version + " does not match committed trusted version " + trustedIdentity.version,
    );
  }
  const requiredVersion = process.env[versionEnvironmentVariable];
  if (requiredVersion && requiredVersion !== version) {
    throw new Error(
      versionEnvironmentVariable + "=" + requiredVersion + " does not match configured FFmpeg version " + version,
    );
  }
  const sha256 = sha256File(binary);
  if (trustedIdentity.sha256 !== sha256) {
    throw new Error(
      "Configured FFmpeg SHA-256 " + sha256 + " does not match the committed trusted digest " + trustedIdentity.sha256,
    );
  }
  return { binary, version, versionLine, sha256 };
}

function requirePinnedFfprobe(spec: FixtureSpec): string {
  const trustedIdentity = trustedBinaryIdentity(spec.ffprobe, "FFprobe");
  const configuredPath = process.env[ffprobeEnvironmentVariable];
  if (!configuredPath) {
    throw new Error(
      ffprobeEnvironmentVariable +
        " is required. Set it to the release-pinned FFprobe test executable; fixture acceptance will not use ffprobe on PATH.",
    );
  }
  const binary = resolve(configuredPath);
  if (!existsSync(binary)) {
    throw new Error(ffprobeEnvironmentVariable + " does not exist: " + binary);
  }
  const stats = statSync(binary);
  if (!stats.isFile() || (stats.mode & 0o111) === 0) {
    throw new Error(ffprobeEnvironmentVariable + " must point to an executable regular file: " + binary);
  }
  const version = parseToolVersion(run(binary, ["-version"], "Could not execute the configured FFprobe test binary"), "ffprobe");
  if (version !== trustedIdentity.version) {
    throw new Error(
      "Configured FFprobe version " + version + " does not match committed trusted version " + trustedIdentity.version,
    );
  }
  const sha256 = sha256File(binary);
  if (sha256 !== trustedIdentity.sha256) {
    throw new Error(
      "Configured FFprobe SHA-256 " + sha256 + " does not match the committed trusted digest " + trustedIdentity.sha256,
    );
  }
  return binary;
}

type ProbeDocument = {
  format?: { format_name?: unknown };
  streams?: Array<{ codec_type?: unknown; codec_name?: unknown }>;
};

function validateGeneratedFixture(ffprobe: string, outputPath: string, definition: FixtureDefinition): void {
  const document = JSON.parse(
    run(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", outputPath],
      "Could not FFprobe generated " + definition.name,
    ),
  ) as ProbeDocument;
  const formatName = typeof document.format?.format_name === "string" ? document.format.format_name : "";
  const expectedFormatToken = definition.container === "mkv" ? "matroska" : definition.container;
  if (!formatName.split(",").includes(expectedFormatToken)) {
    throw new Error(
      "FFprobe container mismatch for " + definition.name + ": expected " + definition.container + ", received " + formatName,
    );
  }
  const streams = document.streams?.map((stream) => ({
    type: typeof stream.codec_type === "string" ? stream.codec_type : "",
    codec: typeof stream.codec_name === "string" ? stream.codec_name : "",
  }));
  const expectedStreams = definition.kind === "video"
    ? [
        { type: "video", codec: definition.probeVideoCodec },
        { type: "audio", codec: definition.probeAudioCodec },
      ]
    : [{ type: "audio", codec: definition.probeAudioCodec }];
  if (JSON.stringify(streams) !== JSON.stringify(expectedStreams)) {
    throw new Error(
      "FFprobe stream mismatch for " + definition.name + ": expected " + JSON.stringify(expectedStreams) + ", received " + JSON.stringify(streams),
    );
  }
}

function generateFixtures(
  binary: string,
  ffprobe: string,
  tool: { version: string; versionLine: string; sha256: string },
  spec: FixtureSpec,
): FixtureManifest {
  if (existsSync(manifestPath)) {
    unlinkSync(manifestPath);
  }

  const files: FixtureManifest["files"] = [];
  for (const definition of spec.generation.fixtures.map((entry) => generatedFixture(entry, spec))) {
    const outputPath = resolve(fixtureDirectory, definition.name);
    run(binary, definition.args(outputPath), "Could not generate " + definition.name);
    const stats = statSync(outputPath);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error("FFmpeg produced an empty or missing fixture: " + outputPath);
    }
    validateGeneratedFixture(ffprobe, outputPath, spec.generation.fixtures.find((entry) => entry.name === definition.name)!);
    files.push({ name: definition.name, bytes: stats.size, sha256: sha256File(outputPath) });
  }

  const manifest: FixtureManifest = {
    schemaVersion: spec.schemaVersion,
    generatorVersion: spec.generatorVersion,
    parameters: spec.parameters,
    ffmpeg: tool,
    files,
  };
  return validateFixtureManifest(manifest, spec);
}

function main(): void {
  const spec = loadFixtureSpec();
  const tool = requirePinnedFfmpeg(spec);
  const ffprobe = requirePinnedFfprobe(spec);
  const manifest = generateFixtures(tool.binary, ffprobe, tool, spec);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log("Generated " + manifest.files.length + " deterministic fixtures with FFmpeg " + tool.version);
  console.log("Manifest: " + manifestPath);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
