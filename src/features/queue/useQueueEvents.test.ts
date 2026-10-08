import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { JobEvent, QueueJob, QueueSnapshot } from "../../domain/job";
import { QueueRow } from "./QueueRow";
import { QueuePanel } from "./QueuePanel";
import {
  createQueueController,
  createQueueStore,
  subscribeToQueueEvents,
  type QueueCommandAdapter,
} from "./useQueueEvents";

function job(id: string, state: QueueJob["state"] = { kind: "queued", label: "Queued" }): QueueJob {
  return {
    id,
    sourcePath: `/input/${id}.mov`,
    media: {
      path: `/input/${id}.mov`,
      fileName: `${id}.mov`,
      container: "mov",
      durationSeconds: 12,
      sizeBytes: 1024,
      videoStreams: [],
      audioStreams: [],
      subtitleStreams: [],
    },
    outputSettings: {
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
    },
    processingKind: { kind: "transcoding", label: "Transcoding" },
    state,
    progress: 0,
    outputPath: null,
  };
}

function snapshot(jobs: QueueJob[], paused = false): QueueSnapshot {
  return { jobs, paused };
}

describe("queue event store", () => {
  it("normalizes snapshots by job id and ignores stale progress", () => {
    const store = createQueueStore(snapshot([job("one"), job("two")]))

    store.handleEvent({ kind: "progress", jobId: "one", progress: 0.75 });
    store.handleEvent({ kind: "progress", jobId: "one", progress: 0.25 });

    expect(store.getState().jobsById.one.progress).toBe(0.75);
    expect(Object.keys(store.getState().jobsById)).toEqual(["one", "two"]);
  });

  it("resets progress for a retry state transition and accepts fresh progress", () => {
    const store = createQueueStore(snapshot([job("one", {
      kind: "failed",
      label: "Failed",
      error: { code: "encode_failed", message: "Stopped" },
    })]));
    store.handleEvent({ kind: "progress", jobId: "one", progress: 0.8 });
    store.handleEvent({ kind: "stateChanged", jobId: "one", state: { kind: "queued", label: "Queued" } });
    store.handleEvent({ kind: "progress", jobId: "one", progress: 0.1 });

    expect(store.getState().jobsById.one).toMatchObject({ progress: 0.1, state: { kind: "queued" } });
  });

  it("supports local keyboard-friendly reordering without changing job ids", () => {
    const store = createQueueStore(snapshot([job("one"), job("two"), job("three")]));

    store.moveJob("three", "up");
    store.moveJob("one", "down");

    expect(store.getState().order).toEqual(["three", "one", "two"]);
    expect(Object.keys(store.getState().jobsById)).toEqual(["one", "two", "three"]);
  });

  it("subscribes to the typed job-event channel and cleans up", async () => {
    let listener: ((event: JobEvent) => void) | undefined;
    const unlisten = vi.fn();
    const cleanup = await subscribeToQueueEvents({
      listen: async (handler) => {
        listener = handler;
        return unlisten;
      },
    }, () => undefined);

    listener?.({ kind: "progress", jobId: "one", progress: 0.4 });
    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

describe("queue actions and accessible rendering", () => {
  it("wires global and row actions to typed command adapters", async () => {
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([job("one")], true)),
      resumeAll: vi.fn(async () => snapshot([job("one")], false)),
      cancelJob: vi.fn(async () => snapshot([job("one", { kind: "cancelled", label: "Cancelled" })])),
      retryJob: vi.fn(async () => snapshot([job("one")])) ,
      clearCompleted: vi.fn(async () => snapshot([])),
      openOutputFolder: vi.fn(async () => undefined),
    };
    const controller = createQueueController({
      initialSnapshot: snapshot([job("one", {
        kind: "failed",
        label: "Failed",
        error: { code: "encode_failed", message: "Stopped" },
      })]),
      commands,
    });

    await controller.pauseAll();
    await controller.resumeAll();
    await controller.cancelJob("one");
    await controller.retryJob("one");
    await controller.clearCompleted();

    expect(commands.pauseAll).toHaveBeenCalledOnce();
    expect(commands.resumeAll).toHaveBeenCalledOnce();
    expect(commands.cancelJob).toHaveBeenCalledWith("one");
    expect(commands.retryJob).toHaveBeenCalledWith("one");
    expect(commands.clearCompleted).toHaveBeenCalledOnce();
  });

  it("renders all status semantics, progress, disabled invalid actions, and technical details", () => {
    const failed = job("failed", {
      kind: "failed",
      label: "Failed",
      error: { code: "encode_failed", message: "The encoder stopped", details: "stderr output" },
    });
    const markup = renderToStaticMarkup(
      createElement(QueueRow, {
        job: failed,
        isFirst: true,
        isLast: true,
        onCancel: () => undefined,
        onMoveDown: () => undefined,
        onMoveUp: () => undefined,
        onOpenOutputFolder: () => undefined,
        onRetry: () => undefined,
      }),
    );

    expect(markup).toContain("失敗");
    expect(markup).toContain("重新編碼");
    expect(markup).toContain('data-status-tone="danger"');
    expect(markup).toContain('value="0"');
    expect(markup).toContain("Technical details");
    expect(markup).toContain("stderr output");
    expect(markup).toContain("Retry");
    expect(markup).toContain('disabled=""');
  });

  it("renders global pause, resume, and clear-completed controls with live announcements", () => {
    const controller = createQueueController({ initialSnapshot: snapshot([]) });
    const markup = renderToStaticMarkup(createElement(QueuePanel, { controller }));

    expect(markup).toContain("Batch queue");
    expect(markup).toContain("Pause all");
    expect(markup).toContain("Clear completed");
    expect(markup).toContain("Cancel active");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("No conversions in the queue yet.");
  });
});
