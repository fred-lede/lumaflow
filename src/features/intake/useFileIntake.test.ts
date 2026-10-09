import { describe, expect, it, vi } from "vitest";

import type { EnqueueJobRequest } from "../../domain/job";
import type { MediaInfo, OutputSettings } from "../../domain/media";
import {
  analyzeSourcePaths,
  createFileIntakeController,
  enqueueSourceFiles,
  normalizeSelectedPaths,
  removeSourceById,
  selectAndAnalyzeFiles,
  sourceIdForPath,
} from "./useFileIntake";

function mediaFor(path: string): MediaInfo {
  return {
    path,
    fileName: path.split("/").at(-1) ?? path,
    container: path.endsWith(".mp3") ? "mp3" : "mov",
    durationSeconds: 12.5,
    sizeBytes: 1_024,
    sourceQuality: {
      status: "unknown",
      summary: "Source quality could not be verified",
      evidence: ["A lossless container does not prove that the original source was lossless"],
    },
    videoStreams: [],
    audioStreams: [{ codec: "aac", streamIndex: 0, sampleRateHz: 48_000, channels: 2 }],
    subtitleStreams: [],
  };
}

const outputSettings: OutputSettings = {
  outputDirectory: "/output",
  format: "mp4",
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

describe("useFileIntake operations", () => {
  it("normalizes multiple selected and dropped paths without duplicate sources", () => {
    expect(normalizeSelectedPaths([" /media/one.mov ", "/media/two.mp3", "/media/one.mov"])).toEqual([
      "/media/one.mov",
      "/media/two.mp3",
    ]);
  });

  it("analyzes every normalized source and preserves a stable client id", async () => {
    const analyze = vi.fn(async (paths: string[]) => paths.map(mediaFor));

    const first = await analyzeSourcePaths(["/media/one.mov", "/media/two.mp3"], analyze);
    const second = await analyzeSourcePaths([" /media/one.mov "], analyze);

    expect(analyze).toHaveBeenCalledWith(["/media/one.mov", "/media/two.mp3"]);
    expect(first).toMatchObject([
      { path: "/media/one.mov", media: { fileName: "one.mov" }, status: "ready" },
      { path: "/media/two.mp3", media: { container: "mp3" }, status: "ready" },
    ]);
    expect(first[0].id).toBe(second[0].id);
  });

  it("uses the typed picker result before requesting backend analysis", async () => {
    const selectFiles = vi.fn(async () => ["/picked/a.wav", "/picked/b.flac"]);
    const analyze = vi.fn(async (paths: string[]) => paths.map(mediaFor));

    const sources = await selectAndAnalyzeFiles(selectFiles, analyze);

    expect(selectFiles).toHaveBeenCalledOnce();
    expect(analyze).toHaveBeenCalledWith(["/picked/a.wav", "/picked/b.flac"]);
    expect(sources).toHaveLength(2);
  });

  it("removes a source before enqueue without changing other stable ids", async () => {
    const sources = await analyzeSourcePaths(["/media/one.mov", "/media/two.mp3"], async (paths) =>
      paths.map(mediaFor),
    );

    expect(removeSourceById(sources, sources[0].id)).toEqual([sources[1]]);
  });

  it("enqueues each source independently and retains only failed validation results", async () => {
    const sources = await analyzeSourcePaths(["/media/ok.mov", "/media/rejected.mov"], async (paths) =>
      paths.map(mediaFor),
    );
    const enqueue = vi.fn<(requests: EnqueueJobRequest[]) => Promise<unknown>>()
      .mockResolvedValueOnce({ jobs: [], paused: false })
      .mockRejectedValueOnce({ code: "unsupported_settings", message: "The output is not supported" });

    const result = await enqueueSourceFiles(sources, outputSettings, enqueue);

    expect(enqueue).toHaveBeenNthCalledWith(1, [expect.objectContaining({ sourcePath: "/media/ok.mov" })]);
    expect(enqueue).toHaveBeenNthCalledWith(2, [expect.objectContaining({ sourcePath: "/media/rejected.mov" })]);
    expect(result.enqueuedIds).toEqual([sources[0].id]);
    expect(result.failed).toEqual([
      expect.objectContaining({ id: sources[1].id, error: "The output is not supported" }),
    ]);
  });

  it("keeps rapid drops deduplicated and pending until out-of-order analysis settles", async () => {
    const deferred: Array<{
      paths: string[];
      resolve: (media: MediaInfo[]) => void;
      reject: (error: Error) => void;
    }> = [];
    const analyze = vi.fn(
      (paths: string[]) =>
        new Promise<MediaInfo[]>((resolve, reject) => {
          deferred.push({ paths, resolve, reject });
        }),
    );
    const enqueue = vi.fn(async () => ({ jobs: [], paused: false }));
    const controller = createFileIntakeController({ analyzeFiles: analyze, enqueueJobs: enqueue });

    const firstDrop = controller.addPaths(["/media/one.mov"]);
    const secondDrop = controller.addPaths(["/media/two.mp3"]);
    controller.addPaths(["/media/two.mp3"]);

    expect(controller.getState()).toMatchObject({ pendingCount: 2, canStart: false });
    expect(controller.getState().sources).toHaveLength(2);

    deferred[1].resolve([mediaFor("/media/two.mp3")]);
    await secondDrop;
    expect(controller.getState()).toMatchObject({ pendingCount: 1, canStart: false });
    expect(controller.getState().sources).toContainEqual(
      expect.objectContaining({ path: "/media/two.mp3", status: "ready" }),
    );

    const blockedStart = await controller.start(outputSettings);
    expect(blockedStart).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();

    controller.removeSource(sourceIdForPath("/media/one.mov"));
    expect(controller.getState()).toMatchObject({ pendingCount: 0, canStart: true });

    await controller.start(outputSettings);
    expect(enqueue).toHaveBeenCalledWith([
      expect.objectContaining({ sourcePath: "/media/two.mp3" }),
    ]);

    deferred[0].resolve([mediaFor("/media/one.mov")]);
    await firstDrop;
    expect(controller.getState().sources).not.toContainEqual(
      expect.objectContaining({ path: "/media/one.mov" }),
    );
    expect(controller.getState().pendingCount).toBe(0);
  });

  it("does not let an older analysis overwrite a newer error for the same re-added path", async () => {
    const deferred: Array<{
      resolve: (media: MediaInfo[]) => void;
      reject: (error: Error) => void;
    }> = [];
    const analyze = vi.fn(
      () =>
        new Promise<MediaInfo[]>((resolve, reject) => {
          deferred.push({ resolve, reject });
        }),
    );
    const controller = createFileIntakeController({ analyzeFiles: analyze });

    const older = controller.addPaths(["/media/retry.mov"]);
    controller.removeSource(sourceIdForPath("/media/retry.mov"));
    const newer = controller.addPaths(["/media/retry.mov"]);

    deferred[1].reject(new Error("new analysis failed"));
    await newer;
    expect(controller.getState().sources).toContainEqual(
      expect.objectContaining({ path: "/media/retry.mov", status: "error", error: "new analysis failed" }),
    );

    deferred[0].resolve([mediaFor("/media/retry.mov")]);
    await older;
    expect(controller.getState().sources).toContainEqual(
      expect.objectContaining({ path: "/media/retry.mov", status: "error", error: "new analysis failed" }),
    );
  });
});
