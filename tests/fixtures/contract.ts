import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type FixtureParameters = {
  durationSeconds: number;
  videoSize: string;
  videoRate: number;
  audioFrequencyHz: number;
  audioSampleRateHz: number;
  threads: number;
};

export type FixtureBinaryPolicy = {
  versionPolicy: "exact";
  version: string;
  sha256Env: string;
};

export type FixtureDefinition = {
  name: string;
  container: string;
  kind: "video" | "audio";
  videoCodec?: string;
  audioCodec: string;
  codecFlags: string[];
};

export type FixtureSpec = {
  schemaVersion: 2;
  generatorVersion: 2;
  parameters: FixtureParameters;
  ffmpeg: FixtureBinaryPolicy;
  ffprobe: FixtureBinaryPolicy;
  generation: {
    sharedFlags: string[];
    outputMetadataFlags: string[];
    videoAudioFlags: string[];
    videoInput: string[];
    audioInput: string[];
    fixtures: FixtureDefinition[];
  };
};

export type FixtureManifest = {
  schemaVersion: number;
  generatorVersion: number;
  parameters: FixtureParameters;
  ffmpeg: {
    version: string;
    versionLine: string;
    sha256: string;
  };
  files: Array<{ name: string; bytes: number; sha256: string }>;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Fixture " + label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Fixture " + label + " must be a non-empty string");
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("Fixture " + label + " must be a non-negative integer");
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Fixture " + label + " must be an array");
  }
  return value.map((entry, index) => string(entry, label + "[" + index + "]"));
}

function parameters(value: unknown): FixtureParameters {
  const input = record(value, "parameters");
  return {
    durationSeconds: integer(input.durationSeconds, "parameters.durationSeconds"),
    videoSize: string(input.videoSize, "parameters.videoSize"),
    videoRate: integer(input.videoRate, "parameters.videoRate"),
    audioFrequencyHz: integer(input.audioFrequencyHz, "parameters.audioFrequencyHz"),
    audioSampleRateHz: integer(input.audioSampleRateHz, "parameters.audioSampleRateHz"),
    threads: integer(input.threads, "parameters.threads"),
  };
}

function binaryPolicy(value: unknown, label: string): FixtureBinaryPolicy {
  const input = record(value, label);
  if (input.versionPolicy !== "exact") {
    throw new Error("Fixture " + label + ".versionPolicy must be exact");
  }
  return {
    versionPolicy: "exact",
    version: string(input.version, label + ".version"),
    sha256Env: string(input.sha256Env, label + ".sha256Env"),
  };
}

function fixtureDefinition(value: unknown, index: number): FixtureDefinition {
  const label = "generation.fixtures[" + index + "]";
  const input = record(value, label);
  const kind = input.kind;
  if (kind !== "video" && kind !== "audio") {
    throw new Error("Fixture " + label + ".kind must be video or audio");
  }
  const definition: FixtureDefinition = {
    name: string(input.name, label + ".name"),
    container: string(input.container, label + ".container"),
    kind,
    audioCodec: string(input.audioCodec, label + ".audioCodec"),
    codecFlags: stringArray(input.codecFlags, label + ".codecFlags"),
  };
  if (kind === "video") {
    definition.videoCodec = string(input.videoCodec, label + ".videoCodec");
  } else if (input.videoCodec !== undefined) {
    throw new Error("Fixture " + label + " audio entries cannot define videoCodec");
  }
  return definition;
}

export function validateFixtureSpec(value: unknown): FixtureSpec {
  const input = record(value, "spec");
  if (input.schemaVersion !== 2 || input.generatorVersion !== 2) {
    throw new Error("Fixture spec schemaVersion/generatorVersion must both be 2");
  }
  const generation = record(input.generation, "generation");
  const fixtureValues = generation.fixtures;
  if (!Array.isArray(fixtureValues) || fixtureValues.length !== 10) {
    throw new Error("Fixture spec must define exactly 10 media fixtures");
  }
  const fixtures = fixtureValues.map(fixtureDefinition);
  if (new Set(fixtures.map((fixture) => fixture.name)).size !== fixtures.length) {
    throw new Error("Fixture spec names must be unique");
  }
  return {
    schemaVersion: 2,
    generatorVersion: 2,
    parameters: parameters(input.parameters),
    ffmpeg: binaryPolicy(input.ffmpeg, "ffmpeg"),
    ffprobe: binaryPolicy(input.ffprobe, "ffprobe"),
    generation: {
      sharedFlags: stringArray(generation.sharedFlags, "generation.sharedFlags"),
      outputMetadataFlags: stringArray(generation.outputMetadataFlags, "generation.outputMetadataFlags"),
      videoAudioFlags: stringArray(generation.videoAudioFlags, "generation.videoAudioFlags"),
      videoInput: stringArray(generation.videoInput, "generation.videoInput"),
      audioInput: stringArray(generation.audioInput, "generation.audioInput"),
      fixtures,
    },
  };
}

export function loadFixtureSpec(path = resolve(import.meta.dirname, "spec.json")): FixtureSpec {
  try {
    return validateFixtureSpec(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    throw new Error(
      "Trusted fixture specification is invalid at " +
        path +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export function parseToolVersion(output: string, tool: "ffmpeg" | "ffprobe"): string {
  const line = output.split(/\r?\n/u).find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
  const match = line.match(new RegExp("^" + tool + " version ([^\\s]+)"));
  if (!match?.[1]) {
    throw new Error("Could not parse " + tool + " version from: " + (line || "empty output"));
  }
  return match[1];
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateFixtureManifest(value: unknown, spec: FixtureSpec): FixtureManifest {
  const input = record(value, "manifest");
  if (input.schemaVersion !== spec.schemaVersion) {
    throw new Error("Fixture manifest schemaVersion must be " + spec.schemaVersion);
  }
  if (input.generatorVersion !== spec.generatorVersion) {
    throw new Error("Fixture manifest generatorVersion must be " + spec.generatorVersion);
  }
  const manifestParameters = parameters(input.parameters);
  if (JSON.stringify(manifestParameters) !== JSON.stringify(spec.parameters)) {
    throw new Error("Fixture manifest parameters do not match the trusted specification");
  }
  const ffmpeg = record(input.ffmpeg, "manifest.ffmpeg");
  const version = string(ffmpeg.version, "manifest.ffmpeg.version");
  if (version !== spec.ffmpeg.version) {
    throw new Error(
      "Fixture manifest requires the exact FFmpeg version " +
        spec.ffmpeg.version +
        "; received " +
        version,
    );
  }
  const versionLine = string(ffmpeg.versionLine, "manifest.ffmpeg.versionLine");
  if (parseToolVersion(versionLine, "ffmpeg") !== version) {
    throw new Error("Fixture manifest FFmpeg versionLine does not match its exact version");
  }
  const digest = string(ffmpeg.sha256, "manifest.ffmpeg.sha256");
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("Fixture manifest FFmpeg sha256 must be a lowercase SHA-256 digest");
  }
  const filesValue = input.files;
  if (!Array.isArray(filesValue) || filesValue.length !== spec.generation.fixtures.length) {
    throw new Error("Fixture manifest must contain exactly the trusted fixture list");
  }
  const files = filesValue.map((value, index) => {
    const file = record(value, "manifest.files[" + index + "]");
    const expected = spec.generation.fixtures[index];
    const name = string(file.name, "manifest.files[" + index + "].name");
    if (name !== expected.name) {
      throw new Error(
        "Fixture manifest file " + index + " must be " + expected.name + "; received " + name,
      );
    }
    const fileDigest = string(file.sha256, "manifest.files[" + index + "].sha256");
    if (!/^[a-f0-9]{64}$/u.test(fileDigest)) {
      throw new Error("Fixture manifest " + name + " sha256 must be a lowercase SHA-256 digest");
    }
    const bytes = integer(file.bytes, "manifest.files[" + index + "].bytes");
    if (bytes === 0) {
      throw new Error("Fixture manifest " + name + " must be non-empty");
    }
    return {
      name,
      bytes,
      sha256: fileDigest,
    };
  });
  return {
    schemaVersion: spec.schemaVersion,
    generatorVersion: spec.generatorVersion,
    parameters: manifestParameters,
    ffmpeg: { version, versionLine, sha256: digest },
    files,
  };
}
