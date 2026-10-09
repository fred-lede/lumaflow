import { beforeEach, describe, expect, it, vi } from "vitest";

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import type { EnqueueJobRequest } from "../domain/job";
import {
  LumaFlowError,
  analyzeFiles,
  clearCompleted,
  enqueueJobs,
  openOutputFolder,
  registerFileDropHandler,
  reorderJobs,
  authorizeOutputPreview,
  outputPreviewUrl,
  selectOutputFolder,
} from "./tauri";

const { mockedGetCurrentWebview, mockedGetCurrentWindow } = vi.hoisted(() => ({
  mockedGetCurrentWebview: vi.fn(),
  mockedGetCurrentWindow: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: mockedGetCurrentWebview,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: mockedGetCurrentWindow,
}));

const mockedInvoke = vi.mocked(invoke);
const mockedConvertFileSrc = vi.mocked(convertFileSrc);

describe("typed Tauri wrappers", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedConvertFileSrc.mockReset();
    mockedGetCurrentWebview.mockReset();
    mockedGetCurrentWindow.mockReset();
  });

  it("consumes backend-authorized paths from the native drop event", async () => {
    let dropHandler: ((event: { payload: { type: string; paths?: string[] } }) => void | Promise<void>) | undefined;
    const webviewUnlisten = vi.fn();
    const windowUnlisten = vi.fn();
    const onDragDropEvent = vi.fn(async (handler: typeof dropHandler) => {
      dropHandler = handler;
      return onDragDropEvent.mock.calls.length === 1 ? webviewUnlisten : windowUnlisten;
    });
    mockedGetCurrentWebview.mockReturnValue({ onDragDropEvent });
    mockedGetCurrentWindow.mockReturnValue({ onDragDropEvent });
    mockedInvoke.mockResolvedValue(["/media/clip.mp4"]);
    const handler = vi.fn();

    const cleanup = await registerFileDropHandler(handler);
    await dropHandler?.({ payload: { type: "drop", paths: ["/media/clip.mp4"] } });

    expect(onDragDropEvent).toHaveBeenCalledTimes(2);
    expect(mockedInvoke).toHaveBeenCalledWith("consume_dropped_paths", {
      paths: ["/media/clip.mp4"],
    });
    expect(handler).toHaveBeenCalledWith(["/media/clip.mp4"]);

    cleanup();
    expect(webviewUnlisten).toHaveBeenCalledOnce();
    expect(windowUnlisten).toHaveBeenCalledOnce();
  });

  it("retries once when the native event arrives before Rust queues its paths", async () => {
    let dropHandler: ((event: { payload: { type: string; paths?: string[] } }) => void | Promise<void>) | undefined;
    const onDragDropEvent = vi.fn(async (handler: typeof dropHandler) => {
      dropHandler = handler;
      return vi.fn();
    });
    mockedGetCurrentWebview.mockReturnValue({ onDragDropEvent });
    mockedGetCurrentWindow.mockReturnValue({ onDragDropEvent });
    mockedInvoke
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["/media/queued-after-event.mp4"]);
    const handler = vi.fn();

    await registerFileDropHandler(handler).then(async (cleanup) => {
      await dropHandler?.({ payload: { type: "drop", paths: ["/media/queued-after-event.mp4"] } });
      cleanup();
    });

    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(["/media/queued-after-event.mp4"]);
  });

  it("passes typed file paths to analyze_files", async () => {
    mockedInvoke.mockResolvedValue([]);

    await analyzeFiles(["/input/one.wav"]);

    expect(mockedInvoke).toHaveBeenCalledWith("analyze_files", {
      paths: ["/input/one.wav"],
    });
  });

  it("authorizes an output asset for preview", async () => {
    mockedInvoke.mockResolvedValue("/output/clip.mp4");

    await authorizeOutputPreview("/output/clip.mp4");

    expect(mockedInvoke).toHaveBeenCalledWith("allow_output_preview", {
      path: "/output/clip.mp4",
    });
  });

  it("builds a preview URL through Tauri's asset helper", () => {
    mockedConvertFileSrc.mockReturnValue("asset://localhost/output/clip.mp4");

    expect(outputPreviewUrl("/output/clip.mp4")).toBe("asset://localhost/output/clip.mp4");
    expect(mockedConvertFileSrc).toHaveBeenCalledWith("/output/clip.mp4");
  });

  it("uses backend-owned output folder selection and queue cleanup commands", async () => {
    mockedInvoke.mockResolvedValueOnce("/output").mockResolvedValueOnce({ jobs: [], paused: false });

    await expect(selectOutputFolder()).resolves.toBe("/output");
    await clearCompleted();

    expect(mockedInvoke).toHaveBeenNthCalledWith(1, "select_output_folder");
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "clear_completed");
  });

  it("passes a validated queue order to the typed reorder command", async () => {
    mockedInvoke.mockResolvedValue({ revision: 4, jobs: [], paused: false });

    await reorderJobs(["job-2", "job-1"]);

    expect(mockedInvoke).toHaveBeenCalledWith("reorder_jobs", {
      jobIds: ["job-2", "job-1"],
    });
  });

  it("normalizes backend failures into LumaFlowError", async () => {
    mockedInvoke.mockRejectedValue({
      code: "path_not_found",
      message: "The selected path does not exist",
    });

    await expect(openOutputFolder("/missing")).rejects.toBeInstanceOf(LumaFlowError);
    await expect(openOutputFolder("/missing")).rejects.toMatchObject({
      code: "path_not_found",
      message: "The selected path does not exist",
    });
  });

  it("preserves structured fields from object, Error, and string rejections", () => {
    const objectError = LumaFlowError.from({
      code: "object_failure",
      message: "Object failure",
      details: { retryable: true },
    });
    expect(objectError).toMatchObject({
      code: "object_failure",
      message: "Object failure",
      details: { retryable: true },
    });

    const error = new Error("Error failure") as Error & {
      code: string;
      details: string;
    };
    error.code = "error_failure";
    error.details = "ffmpeg exited with status 1";
    expect(LumaFlowError.from(error)).toMatchObject({
      code: "error_failure",
      message: "Error failure",
      details: "ffmpeg exited with status 1",
    });

    expect(LumaFlowError.from("String failure")).toMatchObject({
      code: "backend_error",
      message: "String failure",
    });
  });

  it("accepts enqueue requests without queue state", async () => {
    mockedInvoke.mockResolvedValue({ jobs: [], paused: false });
    const request: EnqueueJobRequest = {
      sourcePath: "/input/one.wav",
      media: {
        path: "/input/one.wav",
        fileName: "one.wav",
        container: "wav",
        durationSeconds: 1,
        sizeBytes: 128,
        sourceQuality: {
          status: "unknown",
          summary: "Source quality could not be verified",
          evidence: ["A lossless container does not prove that the original source was lossless"],
        },
        videoStreams: [],
        audioStreams: [],
        subtitleStreams: [],
      },
      outputSettings: {
        outputDirectory: "/output",
        format: "flac",
        quality: "original",
        losslessFirst: true,
        codec: null,
        bitrateKbps: null,
        width: null,
        height: null,
        frameRate: null,
        sampleRateHz: null,
        channels: null,
      },
    };

    await enqueueJobs([request]);

    expect(mockedInvoke).toHaveBeenCalledWith("enqueue_jobs", { jobs: [request] });
  });
});
