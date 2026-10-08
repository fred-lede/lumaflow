import { describe, expect, it } from "vitest";

import { jobStateLabel } from "./job";
import type { JobState } from "./job";

describe("JobState", () => {
  it("gives every queue state a user-facing label and machine-readable kind", () => {
    const states: JobState[] = [
      { kind: "queued", label: "Queued" },
      { kind: "analyzing", label: "Analyzing" },
      { kind: "losslessRemux", label: "Lossless remux" },
      { kind: "losslessAudio", label: "Lossless audio" },
      { kind: "transcoding", label: "Transcoding" },
      { kind: "completed", label: "Completed", outputPath: "/output/file.mp4" },
      { kind: "cancelled", label: "Cancelled" },
      {
        kind: "failed",
        label: "Failed",
        error: { code: "probe_failed", message: "Could not analyze the file" },
      },
    ];

    for (const state of states) {
      expect(state.kind).toEqual(expect.any(String));
      expect(state.label).toEqual(expect.any(String));
      expect(state.label.length).toBeGreaterThan(0);
      expect(jobStateLabel(state)).toBe(state.label);
    }
  });
});
