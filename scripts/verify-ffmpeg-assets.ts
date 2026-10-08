import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
export const defaultManifestPath = resolve(import.meta.dirname, "ffmpeg-assets.json");
export const releaseTargets = ["darwin-arm64", "darwin-x64", "windows-x64", "linux-x64"] as const;

export type ReleaseTarget = (typeof releaseTargets)[number];

type AssetPointer = { path: string };

export type ReleaseTargetManifest = {
  provider?: string;
  sourceUrl?: string;
  archive: { file: string; sha256: string };
  ffmpeg: AssetPointer;
  ffprobe: AssetPointer;
};

export type ReleaseAssetManifest = {
  schemaVersion: 1;
  ffmpegVersion: string;
  targets: Record<string, ReleaseTargetManifest>;
};

export type VerifiedAsset = {
  target: ReleaseTarget;
  manifest: ReleaseTargetManifest;
  assetDirectory: string;
  archive: { path: string; sha256: string };
  ffmpeg: { path: string; sha256: string; versionLine: string; version: string };
  ffprobe: { path: string; sha256: string; versionLine: string; version: string };
};

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("Release asset manifest " + label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("Release asset manifest " + label + " must be a non-empty string");
  }
  return value;
}

function sha256Value(value: unknown, label: string): string {
  const digest = stringValue(value, label);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    fail("Release asset manifest " + label + " must be a lowercase SHA-256 digest");
  }
  return digest;
}

function assetPointer(value: unknown, label: string): AssetPointer {
  const input = record(value, label);
  return { path: stringValue(input.path, label + ".path") };
}

export function loadAssetManifest(path = defaultManifestPath): ReleaseAssetManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    fail("Could not read release asset manifest at " + path + ": " + String(error));
  }
  const input = record(value, "root");
  if (input.schemaVersion !== 1) {
    fail("Release asset manifest schemaVersion must be 1");
  }
  const targets = record(input.targets, "targets");
  const parsedTargets: Record<string, ReleaseTargetManifest> = {};
  for (const target of releaseTargets) {
    const targetInput = record(targets[target], "targets." + target);
    const archive = record(targetInput.archive, "targets." + target + ".archive");
    parsedTargets[target] = {
      ...(targetInput.provider === undefined ? {} : { provider: stringValue(targetInput.provider, "targets." + target + ".provider") }),
      ...(targetInput.sourceUrl === undefined ? {} : { sourceUrl: stringValue(targetInput.sourceUrl, "targets." + target + ".sourceUrl") }),
      archive: {
        file: stringValue(archive.file, "targets." + target + ".archive.file"),
        sha256: sha256Value(archive.sha256, "targets." + target + ".archive.sha256"),
      },
      ffmpeg: assetPointer(targetInput.ffmpeg, "targets." + target + ".ffmpeg"),
      ffprobe: assetPointer(targetInput.ffprobe, "targets." + target + ".ffprobe"),
    };
  }
  return {
    schemaVersion: 1,
    ffmpegVersion: stringValue(input.ffmpegVersion, "ffmpegVersion"),
    targets: parsedTargets,
  };
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path)) {
    fail(label + " is absent: " + path);
  }
  if (!statSync(path).isFile()) {
    fail(label + " must be a regular file: " + path);
  }
}

function requireExecutable(path: string, target: ReleaseTarget, label: string): void {
  requireFile(path, label);
  if (target === "windows-x64") {
    if (!path.toLowerCase().endsWith(".exe")) {
      fail(label + " must be a Windows .exe: " + path);
    }
    return;
  }
  if ((statSync(path).mode & 0o111) === 0) {
    fail(label + " is not executable: " + path);
  }
}

function runVersion(path: string, tool: "ffmpeg" | "ffprobe"): { version: string; versionLine: string } {
  let output: string;
  try {
    output = execFileSync(path, ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail("Could not execute " + tool + " -version at " + path + ": " + String(error));
  }
  const versionLine = output.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? "";
  const match = versionLine.match(new RegExp("^" + tool + " version ([^\\s]+)"));
  if (!match?.[1]) {
    fail("Could not parse " + tool + " version from " + path + ": " + (versionLine || "empty output"));
  }
  return { version: match[1], versionLine };
}

export function verifyTargetAssets(
  target: ReleaseTarget,
  options: { assetDirectory?: string; archivePath?: string; manifestPath?: string } = {},
): VerifiedAsset {
  const manifest = loadAssetManifest(options.manifestPath);
  const targetManifest = manifest.targets[target];
  const assetDirectory = resolve(options.assetDirectory ?? resolve(repoRoot, "src-tauri", "binaries", target));
  if (!existsSync(assetDirectory)) {
    fail("Release assets are absent for " + target + ": " + assetDirectory);
  }
  if (!statSync(assetDirectory).isDirectory()) {
    fail("Release asset path for " + target + " is not a directory: " + assetDirectory);
  }

  const archivePath = resolve(options.archivePath ?? resolve(assetDirectory, "..", targetManifest.archive.file));
  requireFile(archivePath, "Release archive for " + target);
  const archiveSha256 = sha256File(archivePath);
  if (archiveSha256 !== targetManifest.archive.sha256) {
    fail(
      "Release archive SHA-256 mismatch for " + target + ": expected " +
        targetManifest.archive.sha256 + ", received " + archiveSha256,
    );
  }

  const ffmpegPath = resolve(assetDirectory, targetManifest.ffmpeg.path);
  const ffprobePath = resolve(assetDirectory, targetManifest.ffprobe.path);
  requireExecutable(ffmpegPath, target, "FFmpeg asset for " + target);
  requireExecutable(ffprobePath, target, "FFprobe asset for " + target);
  const ffmpegVersion = runVersion(ffmpegPath, "ffmpeg");
  const ffprobeVersion = runVersion(ffprobePath, "ffprobe");
  if (ffmpegVersion.version !== manifest.ffmpegVersion || ffprobeVersion.version !== manifest.ffmpegVersion) {
    fail(
      "FFmpeg/FFprobe version mismatch for " + target + ": expected " + manifest.ffmpegVersion +
        ", received " + ffmpegVersion.version + " / " + ffprobeVersion.version,
    );
  }
  return {
    target,
    manifest: targetManifest,
    assetDirectory,
    archive: { path: archivePath, sha256: archiveSha256 },
    ffmpeg: { path: ffmpegPath, sha256: sha256File(ffmpegPath), ...ffmpegVersion },
    ffprobe: { path: ffprobePath, sha256: sha256File(ffprobePath), ...ffprobeVersion },
  };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function main(): void {
  const args = process.argv.slice(2);
  const manifestPath = option(args, "--manifest");
  const targetOption = option(args, "--target") as ReleaseTarget | undefined;
  const targets = args.includes("--all") ? [...releaseTargets] : targetOption ? [targetOption] : [];
  if (targets.length === 0 || targets.some((target) => !releaseTargets.includes(target))) {
    fail("Usage: verify-ffmpeg-assets.ts --target <darwin-arm64|darwin-x64|windows-x64|linux-x64> [--asset-dir DIR] [--archive FILE] [--manifest FILE], or --all");
  }
  for (const target of targets) {
    const assetDirectory = targets.length === 1 ? option(args, "--asset-dir") : undefined;
    const archivePath = targets.length === 1 ? option(args, "--archive") : undefined;
    const verified = verifyTargetAssets(target, { assetDirectory, archivePath, manifestPath });
    console.log(
      "Verified FFmpeg/FFprobe release assets for " + target + " (" + verified.ffmpeg.version + "); archive SHA-256 " + verified.archive.sha256 + ")",
    );
  }
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedScript === resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
