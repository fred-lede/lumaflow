import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

import { LumaFlowError, analyzeFiles, openOutputFolder } from "./tauri";

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
});
