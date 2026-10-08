import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

import type { EnqueueJobRequest } from "../domain/job";
import {
  LumaFlowError,
  analyzeFiles,
  clearCompleted,
  enqueueJobs,
  openOutputFolder,
  reorderJobs,
  selectOutputFolder,
} from "./tauri";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

describe("typed Tauri wrappers", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("passes typed file paths to analyze_files", async () => {
    mockedInvoke.mockResolvedValue([]);

    await analyzeFiles(["/input/one.wav"]);

    expect(mockedInvoke).toHaveBeenCalledWith("analyze_files", {
      paths: ["/input/one.wav"],
    });
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
