import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { JobEvent, QueueJob, QueueSnapshot } from "../../domain/job";
import { QueueRow } from "./QueueRow";
import { QueuePanel } from "./QueuePanel";
import {
  createQueueController,
  createQueueStore,
  startQueueEventSubscription,
  subscribeToQueueEvents,
  type QueueCommandAdapter,
} from "./useQueueEvents";

function job(
  id: string,
  state: QueueJob["state"] = { kind: "queued", label: "Queued" },
  attempt = 0,
): QueueJob {
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
    attempt,
    state,
    progress: 0,
    outputPath: null,
  };
}

function snapshot(jobs: QueueJob[], revision = 1, paused = false): QueueSnapshot {
  return { revision, jobs, paused };
}

describe("queue event store", () => {
  it("normalizes snapshots by job id and ignores stale progress", () => {
    const store = createQueueStore(snapshot([job("one"), job("two")]))

    store.handleEvent({ kind: "progress", jobId: "one", progress: 0.75, revision: 2, sequence: 2, attempt: 0 });
    store.handleEvent({ kind: "progress", jobId: "one", progress: 0.25, revision: 1, sequence: 3, attempt: 0 });

    expect(store.getState().jobsById.one.progress).toBe(0.75);
    expect(Object.keys(store.getState().jobsById)).toEqual(["one", "two"]);
  });

  it("resets progress for a retry state transition and accepts fresh progress", () => {
    const store = createQueueStore(snapshot([job("one", {
      kind: "failed",
      label: "Failed",
      error: { code: "encode_failed", message: "Stopped" },
    })]));
    store.handleEvent({ kind: "progress", jobId: "one", progress: 0.8, revision: 2, sequence: 2, attempt: 0 });
    store.handleEvent({ kind: "stateChanged", jobId: "one", state: { kind: "queued", label: "Queued" }, revision: 3, sequence: 3, attempt: 1 });
    store.handleEvent({ kind: "progress", jobId: "one", progress: 0.1, revision: 4, sequence: 4, attempt: 1 });

    expect(store.getState().jobsById.one).toMatchObject({ attempt: 1, progress: 0.1, state: { kind: "queued" } });
  });

  it("ignores late events after clear and never recreates a missing job", () => {
    const store = createQueueStore(snapshot([job("one")], 10));

    store.applySnapshot(snapshot([], 11));
    store.handleEvent({ kind: "stateChanged", jobId: "one", state: { kind: "failed", label: "Failed", error: { code: "late", message: "late" } }, revision: 10, sequence: 100, attempt: 0 });
    store.handleEvent({ kind: "progress", jobId: "one", progress: 0.9, revision: 12, sequence: 101, attempt: 0 });

    expect(store.getState().jobsById.one).toBeUndefined();
    expect(store.getState().order).toEqual([]);
  });

  it("uses backend order snapshots and rejects old revisions", () => {
    const store = createQueueStore(snapshot([job("one"), job("two"), job("three")]));

    store.applySnapshot(snapshot([job("three"), job("one"), job("two")], 2));
    store.applySnapshot(snapshot([job("one"), job("two"), job("three")], 1));

    expect(store.getState().order).toEqual(["three", "one", "two"]);
    expect(Object.keys(store.getState().jobsById)).toEqual(["three", "one", "two"]);
  });

  it("ignores out-of-order events by sequence and revision", () => {
    const store = createQueueStore(snapshot([job("one")], 1));

    store.handleEvent({ kind: "progress", jobId: "one", progress: 0.8, revision: 3, sequence: 3, attempt: 0 });
    store.handleEvent({ kind: "stateChanged", jobId: "one", state: { kind: "queued", label: "Queued" }, revision: 2, sequence: 2, attempt: 0 });

    expect(store.getState().jobsById.one).toMatchObject({ progress: 0.8, state: { kind: "queued" } });
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

    listener?.({ kind: "progress", jobId: "one", progress: 0.4, revision: 2, sequence: 2, attempt: 0 });
    cleanup();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

describe("queue actions and accessible rendering", () => {
  it("wires global and row actions to typed command adapters", async () => {
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([job("one")], 2, true)),
      resumeAll: vi.fn(async () => snapshot([job("one")], 3, false)),
      cancelJob: vi.fn(async () => snapshot([job("one", { kind: "cancelled", label: "Cancelled" })])),
      retryJob: vi.fn(async () => snapshot([job("one")])) ,
      clearCompleted: vi.fn(async () => snapshot([])),
      openOutputFolder: vi.fn(async () => undefined),
      reorderJobs: vi.fn(async (jobIds: string[]) => snapshot(jobIds.map((id) => job(id)), 2)),
    };
    const controller = createQueueController({
      initialSnapshot: snapshot([job("one", {
        kind: "failed",
        label: "Failed",
        error: { code: "encode_failed", message: "Stopped" },
      })], 1),
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

  it("locks overlapping job actions and ignores the stale command response", async () => {
    const deferred: Array<{ resolve: (value: QueueSnapshot) => void }> = [];
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([])),
      resumeAll: vi.fn(async () => snapshot([])),
      cancelJob: vi.fn(() => new Promise<QueueSnapshot>((resolve) => deferred.push({ resolve }))),
      retryJob: vi.fn(async () => snapshot([])),
      clearCompleted: vi.fn(async () => snapshot([])),
      openOutputFolder: vi.fn(async () => undefined),
      reorderJobs: vi.fn(async (jobIds: string[]) => snapshot(jobIds.map((id) => job(id)), 2)),
    };
    const controller = createQueueController({ initialSnapshot: snapshot([job("one")], 1), commands });

    const first = controller.cancelJob("one");
    const second = controller.cancelJob("one");
    expect(controller.getState().pendingActions.one).toBe("cancel");

    deferred[1].resolve(snapshot([job("one", { kind: "cancelled", label: "Cancelled" })], 3));
    deferred[0].resolve(snapshot([job("one")], 2));
    await Promise.all([first, second]);

    expect(controller.getState().jobsById.one.state.kind).toBe("cancelled");
    expect(controller.getState().revision).toBe(3);
    expect(controller.getState().pendingActions.one).toBeUndefined();
  });

  it("clears an action lock after an actual command failure and preserves its error", async () => {
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([])),
      resumeAll: vi.fn(async () => snapshot([])),
      cancelJob: vi.fn(async () => snapshot([])),
      retryJob: vi.fn(async () => snapshot([])),
      clearCompleted: vi.fn(async () => snapshot([])),
      openOutputFolder: vi.fn(async () => {
        throw { code: "open_denied", message: "Open denied", details: "permission" };
      }),
      reorderJobs: vi.fn(async (jobIds: string[]) => snapshot(jobIds.map((id) => job(id)), 2)),
    };
    const controller = createQueueController({ initialSnapshot: snapshot([job("one")]), commands });

    await expect(controller.openOutputFolder("one", "/output")).rejects.toMatchObject({ code: "open_denied" });
    expect(controller.getState().pendingActions.one).toBeUndefined();
  });

  it("locks open-output actions until the typed command settles", async () => {
    let resolveOpen: (() => void) | undefined;
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([])),
      resumeAll: vi.fn(async () => snapshot([])),
      cancelJob: vi.fn(async () => snapshot([])),
      retryJob: vi.fn(async () => snapshot([])),
      clearCompleted: vi.fn(async () => snapshot([])),
      openOutputFolder: vi.fn(() => new Promise<void>((resolve) => {
        resolveOpen = resolve;
      })),
      reorderJobs: vi.fn(async (jobIds: string[]) => snapshot(jobIds.map((id) => job(id)), 2)),
    };
    const controller = createQueueController({
      initialSnapshot: snapshot([job("one", { kind: "completed", label: "Completed", outputPath: "/output/one.mp4" })]),
      commands,
    });

    const pending = controller.openOutputFolder("one", "/output");
    expect(controller.getState().pendingActions.one).toBe("openOutputFolder");
    resolveOpen?.();
    await pending;
    expect(controller.getState().pendingActions.one).toBeUndefined();
  });

  it("persists a successful backend reorder and restores order after failure", async () => {
    const reorderJobs = vi.fn()
      .mockResolvedValueOnce(snapshot([job("two"), job("one")], 2))
      .mockRejectedValueOnce({ code: "invalid_order", message: "Invalid order", details: "queued ids" });
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([])),
      resumeAll: vi.fn(async () => snapshot([])),
      cancelJob: vi.fn(async () => snapshot([])),
      retryJob: vi.fn(async () => snapshot([])),
      clearCompleted: vi.fn(async () => snapshot([])),
      openOutputFolder: vi.fn(async () => undefined),
      reorderJobs,
    };
    const controller = createQueueController({ initialSnapshot: snapshot([job("one"), job("two")]), commands });

    await controller.moveJob("two", "up");
    expect(controller.getState().order).toEqual(["two", "one"]);
    await expect(controller.moveJob("two", "down")).rejects.toMatchObject({ code: "invalid_order" });
    expect(controller.getState().order).toEqual(["two", "one"]);
    expect(controller.getState().pendingActions.one).toBeUndefined();
    expect(controller.getState().pendingActions.two).toBeUndefined();
    expect(reorderJobs).toHaveBeenNthCalledWith(1, ["two", "one"]);
  });

  it("captures event listener registration failures without an unhandled rejection", async () => {
    const controller = createQueueController();
    const cleanup = await startQueueEventSubscription(controller, {
      listen: async () => {
        throw { code: "listener_denied", message: "Listener denied", details: "webview" };
      },
    });

    cleanup();
    expect(controller.getState().eventError).toMatchObject({
      code: "listener_denied",
      message: "Listener denied",
      details: "webview",
    });
  });

  it("renders all status semantics, progress, disabled invalid actions, and technical details", () => {
    const failed = job("failed", {
      kind: "failed",
      label: "Failed",
      error: { code: "encode_failed", message: "The encoder stopped", details: "stderr output" },
    }, 0);
    const markup = renderToStaticMarkup(
      createElement(QueueRow, {
        job: failed,
        isFirst: true,
        isLast: true,
        onCancel: () => undefined,
        onMove: () => undefined,
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

  it("renders completion warnings with technical details", () => {
    const completed = job("warning", {
      kind: "completed",
      label: "Completed",
      outputPath: "/output/warning.mp4",
      warning: { code: "cleanup_warning", message: "Cleanup warning", details: "temp file" },
    });
    const markup = renderToStaticMarkup(createElement(QueueRow, {
      job: completed,
      isFirst: true,
      isLast: true,
      onCancel: () => undefined,
      onMove: () => undefined,
      onOpenOutputFolder: () => undefined,
      onRetry: () => undefined,
    }));

    expect(markup).toContain("Cleanup warning");
    expect(markup).toContain("cleanup_warning");
    expect(markup).toContain("temp file");
  });

  it("disables every row action while one row action is pending", () => {
    const markup = renderToStaticMarkup(createElement(QueueRow, {
      job: job("pending", { kind: "completed", label: "Completed", outputPath: "/output/pending.mp4" }),
      pendingAction: "openOutputFolder",
      isFirst: true,
      isLast: true,
      onCancel: () => undefined,
      onMove: () => undefined,
      onOpenOutputFolder: () => undefined,
      onRetry: () => undefined,
    }));

    expect(markup.match(/disabled=""/g)).toHaveLength(5);
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
