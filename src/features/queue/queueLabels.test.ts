import { describe, expect, it } from "vitest";

import type { JobState, ProcessingKind } from "../../domain/job";
import {
  canCancelJob,
  canRetryJob,
  canReorderJob,
  processingKindVisibleLabel,
  queueStatusFor,
} from "./queueLabels";

const states: Array<[JobState, string, string, string]> = [
  [{ kind: "queued", label: "Queued" }, "待處理", "○", "neutral"],
  [{ kind: "analyzing", label: "Analyzing" }, "分析中", "…", "working"],
  [{ kind: "losslessRemux", label: "Lossless remux" }, "無損封裝", "↻", "working"],
  [{ kind: "losslessAudio", label: "Lossless audio" }, "無損音訊轉換", "↻", "working"],
  [{ kind: "transcoding", label: "Transcoding" }, "重新編碼", "↻", "working"],
  [{ kind: "completed", label: "Completed", outputPath: "/output/file.mp4" }, "已完成", "✓", "success"],
  [{ kind: "cancelled", label: "Cancelled" }, "已取消", "×", "neutral"],
  [
    {
      kind: "failed",
      label: "Failed",
      error: { code: "encode_failed", message: "The encoder stopped", details: "stderr" },
    },
    "失敗",
    "!",
    "danger",
  ],
];

describe("queue labels", () => {
  it.each(states)("maps the backend %s state to text, icon, and color tone", (state, label, icon, tone) => {
    expect(queueStatusFor(state)).toMatchObject({ label, icon, tone });
  });

  it("makes every processing kind visible in the queue", () => {
    const kinds: Array<[ProcessingKind, string]> = [
      [{ kind: "losslessRemux", label: "Lossless remux" }, "無損封裝"],
      [{ kind: "losslessAudio", label: "Lossless audio" }, "無損音訊轉換"],
      [{ kind: "transcoding", label: "Transcoding" }, "重新編碼"],
    ];

    for (const [kind, label] of kinds) {
      expect(processingKindVisibleLabel(kind)).toBe(label);
    }
    expect(processingKindVisibleLabel(null)).toBe("尚未判定");
  });

  it("only enables cancellation for work the backend can cancel", () => {
    expect(canCancelJob("queued")).toBe(true);
    expect(canCancelJob("analyzing")).toBe(false);
    expect(canCancelJob("losslessRemux")).toBe(true);
    expect(canCancelJob("losslessAudio")).toBe(true);
    expect(canCancelJob("transcoding")).toBe(true);
    expect(canCancelJob("completed")).toBe(false);
    expect(canCancelJob("cancelled")).toBe(false);
    expect(canCancelJob("failed")).toBe(false);
  });

  it("only enables retry for failed jobs", () => {
    expect(canRetryJob("failed")).toBe(true);
    expect(canRetryJob("queued")).toBe(false);
    expect(canRetryJob("completed")).toBe(false);
  });

  it("only enables reorder for queued jobs", () => {
    expect(canReorderJob("queued")).toBe(true);
    expect(canReorderJob("transcoding")).toBe(false);
    expect(canReorderJob("completed")).toBe(false);
  });
});
