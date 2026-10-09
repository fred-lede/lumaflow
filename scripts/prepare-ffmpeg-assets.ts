import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  loadAssetManifest,
  releaseTargets,
  verifyTargetAssets,
  type ReleaseTarget,
} from "./verify-ffmpeg-assets.ts";

const repoRoot = resolve(import.meta.dirname, "..");

export function targetForHost(platform: string, arch: string): ReleaseTarget {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  throw new Error(`Unsupported build host: ${platform}/${arch}`);
}

export function hasMachineLocalMacDependency(linkage: string): boolean {
  return /\/(?:opt\/homebrew|usr\/local\/Cellar)\//u.test(linkage);
}

function executableName(target: ReleaseTarget, tool: "ffmpeg" | "ffprobe"): string {
  return target === "windows-x64" ? `${tool}.exe` : tool;
}

function toolVersion(path: string, tool: "ffmpeg" | "ffprobe"): string | undefined {
  try {
    const output = execFileSync(path, ["-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const line = output.split(/\r?\n/u).find((value) => value.trim().length > 0)?.trim() ?? "";
    return line.match(new RegExp(`^${tool} version ([^\\s]+)`))?.[1];
  } catch {
    return undefined;
  }
}

function macLinkage(path: string): string | undefined {
  try {
    return execFileSync("otool", ["-L", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

function hasUsableTools(target: ReleaseTarget, assetDirectory: string, version: string): boolean {
  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    const path = resolve(assetDirectory, executableName(target, tool));
    if (!existsSync(path) || !statSync(path).isFile() || toolVersion(path, tool) !== version) return false;
    if (target.startsWith("darwin")) {
      const linkage = macLinkage(path);
      if (!linkage || hasMachineLocalMacDependency(linkage)) return false;
    }
  }
  return true;
}

async function downloadArchive(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
      return path;
    }
  }
  return undefined;
}

function extractArchive(archive: string, destination: string, target: ReleaseTarget): void {
  if (target === "windows-x64") {
    const escapedArchive = archive.replaceAll("'", "''");
    const escapedDestination = destination.replaceAll("'", "''");
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`,
    ], { stdio: "inherit" });
    return;
  }
  execFileSync("unzip", ["-q", archive, "-d", destination], { stdio: "inherit" });
}

async function prepareTarget(target: ReleaseTarget): Promise<void> {
  const manifest = loadAssetManifest();
  const targetManifest = manifest.targets[target];
  const assetDirectory = resolve(repoRoot, "src-tauri", "binaries", target);
  await mkdir(assetDirectory, { recursive: true });

  if (hasUsableTools(target, assetDirectory, manifest.ffmpegVersion)) {
    console.log(`FFmpeg assets already prepared for ${target}`);
    return;
  }

  if (!targetManifest.sourceUrl) throw new Error(`No FFmpeg archive URL is configured for ${target}`);

  const workDirectory = await mkdtemp(join(tmpdir(), "lumaflow-ffmpeg-"));
  const archive = join(workDirectory, targetManifest.archive.file);
  const extractionDirectory = join(workDirectory, "extracted");
  try {
    console.log(`Downloading FFmpeg assets for ${target}`);
    await downloadArchive(targetManifest.sourceUrl, archive);
    const receivedSha256 = sha256File(archive);
    if (receivedSha256 !== targetManifest.archive.sha256) {
      throw new Error(
        `FFmpeg archive SHA-256 mismatch for ${target}: expected ${targetManifest.archive.sha256}, received ${receivedSha256}`,
      );
    }

    await mkdir(extractionDirectory, { recursive: true });
    extractArchive(archive, extractionDirectory, target);
    for (const tool of ["ffmpeg", "ffprobe"] as const) {
      const name = executableName(target, tool);
      const source = findFile(extractionDirectory, name);
      if (!source) throw new Error(`FFmpeg archive does not contain ${name}`);
      const destination = resolve(assetDirectory, name);
      await copyFile(source, destination);
      if (target !== "windows-x64") await chmod(destination, 0o755);
    }

    const verified = verifyTargetAssets(target, { assetDirectory, archivePath: archive });
    console.log(`Prepared FFmpeg/FFprobe ${verified.ffmpeg.version} assets for ${target}`);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const targetArgumentIndex = process.argv.indexOf("--target");
  const targetArgument = targetArgumentIndex === -1 ? undefined : process.argv[targetArgumentIndex + 1];
  if (targetArgument && !releaseTargets.includes(targetArgument as ReleaseTarget)) {
    throw new Error(`Unsupported release target: ${targetArgument}`);
  }
  const target = targetArgument
    ? (targetArgument as ReleaseTarget)
    : targetForHost(process.platform, process.arch);
  await prepareTarget(target);
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedScript === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
