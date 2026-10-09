// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JobEvent, QueueJob, QueueSnapshot } from "../../domain/job";

const mockAudioPreview = vi.hoisted(() => ({
  activePath: null as string | null,
  audioRef: { current: null as HTMLAudioElement | null },
  error: null as string | null,
  handleEnded: vi.fn(),
  handleError: vi.fn(),
  prepare: vi.fn(async () => undefined),
  play: vi.fn(async () => undefined),
  stop: vi.fn(),
}));

vi.mock("./useAudioPreview", () => ({ default: () => mockAudioPreview }));

import { QueueRow } from "./QueueRow";
import { QueuePanel, nextQueueAnnouncement, queueTransitionAnnouncement } from "./QueuePanel";
import {
  createQueueController,
  createQueueStore,
  startQueueEventSubscription,
  subscribeToQueueEvents,
  type QueueCommandAdapter,
} from "./useQueueEvents";

afterEach(() => {
  cleanup();
  mockAudioPreview.activePath = null;
  mockAudioPreview.error = null;
  mockAudioPreview.play.mockClear();
  mockAudioPreview.prepare.mockClear();
  mockAudioPreview.stop.mockClear();
});

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
  it("serializes enqueue behind pause, cancel, and reorder mutations", async () => {
    let resolveEnqueue: ((value: QueueSnapshot) => void) | undefined;
    let resolvePause: ((value: QueueSnapshot) => void) | undefined;
    let resolveCancel: ((value: QueueSnapshot) => void) | undefined;
    let resolveReorder: ((value: QueueSnapshot) => void) | undefined;
    const commands = {
      enqueueJobs: vi.fn(() => new Promise<QueueSnapshot>((resolve) => { resolveEnqueue = resolve; })),
      pauseAll: vi.fn(() => new Promise<QueueSnapshot>((resolve) => { resolvePause = resolve; })),
      cancelJob: vi.fn(() => new Promise<QueueSnapshot>((resolve) => { resolveCancel = resolve; })),
      reorderJobs: vi.fn(() => new Promise<QueueSnapshot>((resolve) => { resolveReorder = resolve; })),
    };
    const controller = createQueueController({ initialSnapshot: snapshot([job("one"), job("two")]), commands });

    const enqueue = controller.enqueueJobs([]);
    const pause = controller.pauseAll();
    const cancel = controller.cancelJob("one");
    const reorder = controller.moveJob("two", "up");

    expect(controller.getState().pendingMutation).toBe("enqueue");
    expect(commands.pauseAll).not.toHaveBeenCalled();
    expect(commands.cancelJob).not.toHaveBeenCalled();
    expect(commands.reorderJobs).not.toHaveBeenCalled();
    await Promise.resolve();

    resolveEnqueue?.(snapshot([job("one"), job("two")], 2));
    await enqueue;
    await Promise.resolve();
    expect(commands.pauseAll).toHaveBeenCalledOnce();
    resolvePause?.(snapshot([job("one"), job("two")], 3, true));
    await pause;
    await Promise.resolve();
    expect(commands.cancelJob).toHaveBeenCalledWith("one");
    resolveCancel?.(snapshot([job("one", { kind: "cancelled", label: "Cancelled" }), job("two")], 4, true));
    await cancel;
    await Promise.resolve();
    expect(commands.reorderJobs).toHaveBeenCalledWith(["two", "one"]);
    resolveReorder?.(snapshot([job("two"), job("one", { kind: "cancelled", label: "Cancelled" })], 5, true));
    await reorder;

    expect(controller.getState().order).toEqual(["two", "one"]);
    expect(controller.getState().pendingMutation).toBeNull();
  });

  it("wires global and row actions to typed command adapters", async () => {
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([job("one")], 2, true)),
      resumeAll: vi.fn(async () => snapshot([job("one")], 3, false)),
      cancelJob: vi.fn(async () => snapshot([job("one", { kind: "cancelled", label: "Cancelled" })])),
      retryJob: vi.fn(async () => snapshot([job("one")])) ,
      clearCompleted: vi.fn(async () => snapshot([])),
      enqueueJobs: vi.fn(async () => snapshot([])),
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

  it("serializes cross-job mutations behind one global lock", async () => {
    let resolveCancel: ((value: QueueSnapshot) => void) | undefined;
    let resolveRetry: ((value: QueueSnapshot) => void) | undefined;
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([])),
      resumeAll: vi.fn(async () => snapshot([])),
      cancelJob: vi.fn(() => new Promise<QueueSnapshot>((resolve) => { resolveCancel = resolve; })),
      retryJob: vi.fn(() => new Promise<QueueSnapshot>((resolve) => { resolveRetry = resolve; })),
      clearCompleted: vi.fn(async () => snapshot([])),
      enqueueJobs: vi.fn(async () => snapshot([])),
      openOutputFolder: vi.fn(async () => undefined),
      reorderJobs: vi.fn(async (jobIds: string[]) => snapshot(jobIds.map((id) => job(id)), 2)),
    };
    const controller = createQueueController({
      initialSnapshot: snapshot([job("one"), job("two", {
        kind: "failed",
        label: "Failed",
        error: { code: "failed", message: "failed" },
      })], 1),
      commands,
    });

    const first = controller.cancelJob("one");
    const second = controller.retryJob("two");
    expect(controller.getState().pendingActions.one).toBe("cancel");
    expect(controller.getState().pendingMutation).toBe("cancel");
    expect(commands.retryJob).not.toHaveBeenCalled();
    await Promise.resolve();

    resolveCancel?.(snapshot([job("one", { kind: "cancelled", label: "Cancelled" }), job("two")], 2));
    await first;
    await Promise.resolve();
    expect(commands.retryJob).toHaveBeenCalledWith("two");
    expect(controller.getState().pendingMutation).toBe("retry");

    resolveRetry?.(snapshot([job("one", { kind: "cancelled", label: "Cancelled" }), job("two")], 3));
    await Promise.all([first, second]);

    expect(controller.getState().jobsById.one.state.kind).toBe("cancelled");
    expect(controller.getState().revision).toBe(3);
    expect(controller.getState().pendingActions).toEqual({});
    expect(controller.getState().pendingMutation).toBeNull();
  });

  it("serializes global and row mutations without overlap", async () => {
    let resolvePause: ((value: QueueSnapshot) => void) | undefined;
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(() => new Promise<QueueSnapshot>((resolve) => { resolvePause = resolve; })),
      resumeAll: vi.fn(async () => snapshot([])),
      cancelJob: vi.fn(async () => snapshot([])),
      retryJob: vi.fn(async () => snapshot([])),
      clearCompleted: vi.fn(async () => snapshot([])),
      enqueueJobs: vi.fn(async () => snapshot([])),
      openOutputFolder: vi.fn(async () => undefined),
      reorderJobs: vi.fn(async (jobIds: string[]) => snapshot(jobIds.map((id) => job(id)), 2)),
    };
    const controller = createQueueController({ initialSnapshot: snapshot([job("one")]), commands });

    const pause = controller.pauseAll();
    const cancel = controller.cancelJob("one");
    expect(commands.cancelJob).not.toHaveBeenCalled();
    expect(controller.getState().pendingGlobalAction).toBe("pause");
    expect(controller.getState().pendingMutation).toBe("pause");
    await Promise.resolve();

    resolvePause?.(snapshot([job("one")], 2, true));
    await pause;
    await cancel;

    expect(commands.cancelJob).toHaveBeenCalledWith("one");
    expect(controller.getState().pendingMutation).toBeNull();
  });

  it("serializes reorder behind an action on either reordered job and cleans both locks", async () => {
    let resolveReorder: ((value: QueueSnapshot) => void) | undefined;
    let resolveCancel: ((value: QueueSnapshot) => void) | undefined;
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([])),
      resumeAll: vi.fn(async () => snapshot([])),
      cancelJob: vi.fn(() => new Promise<QueueSnapshot>((resolve) => { resolveCancel = resolve; })),
      retryJob: vi.fn(async () => snapshot([])),
      clearCompleted: vi.fn(async () => snapshot([])),
      enqueueJobs: vi.fn(async () => snapshot([])),
      openOutputFolder: vi.fn(async () => undefined),
      reorderJobs: vi.fn(() => new Promise<QueueSnapshot>((resolve) => { resolveReorder = resolve; })),
    };
    const controller = createQueueController({ initialSnapshot: snapshot([job("one"), job("two")]), commands });

    const reorder = controller.moveJob("two", "up");
    const cancel = controller.cancelJob("two");
    expect(commands.cancelJob).not.toHaveBeenCalled();
    expect(controller.getState().pendingActions).toEqual({ one: "reorder", two: "reorder" });
    await Promise.resolve();

    resolveReorder?.(snapshot([job("two"), job("one")], 2));
    await reorder;
    await Promise.resolve();
    expect(commands.cancelJob).toHaveBeenCalledWith("two");
    expect(controller.getState().pendingActions).toEqual({ two: "cancel" });

    resolveCancel?.(snapshot([job("two", { kind: "cancelled", label: "Cancelled" }), job("one")], 3));
    await cancel;
    expect(controller.getState().pendingActions).toEqual({});
    expect(controller.getState().pendingMutation).toBeNull();
  });

  it("releases both reorder locks after failure before the queued action starts", async () => {
    let rejectReorder: ((reason?: unknown) => void) | undefined;
    let resolveCancel: ((value: QueueSnapshot) => void) | undefined;
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([])),
      resumeAll: vi.fn(async () => snapshot([])),
      cancelJob: vi.fn(() => new Promise<QueueSnapshot>((resolve) => { resolveCancel = resolve; })),
      retryJob: vi.fn(async () => snapshot([])),
      clearCompleted: vi.fn(async () => snapshot([])),
      enqueueJobs: vi.fn(async () => snapshot([])),
      openOutputFolder: vi.fn(async () => undefined),
      reorderJobs: vi.fn(() => new Promise<QueueSnapshot>((_, reject) => { rejectReorder = reject; })),
    };
    const controller = createQueueController({ initialSnapshot: snapshot([job("one"), job("two")]), commands });

    const reorder = controller.moveJob("two", "up");
    const cancel = controller.cancelJob("two");
    await Promise.resolve();
    rejectReorder?.({ code: "invalid_order", message: "Invalid order" });

    await expect(reorder).rejects.toMatchObject({ code: "invalid_order" });
    expect(controller.getState().pendingActions).toEqual({ two: "cancel" });
    expect(commands.cancelJob).toHaveBeenCalledWith("two");

    resolveCancel?.(snapshot([job("two", { kind: "cancelled", label: "Cancelled" }), job("one")], 2));
    await cancel;
    expect(controller.getState().pendingMutation).toBeNull();
    expect(controller.getState().pendingActions).toEqual({});
  });

  it("clears an action lock after an actual command failure and preserves its error", async () => {
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([])),
      resumeAll: vi.fn(async () => snapshot([])),
      cancelJob: vi.fn(async () => snapshot([])),
      retryJob: vi.fn(async () => snapshot([])),
      clearCompleted: vi.fn(async () => snapshot([])),
      enqueueJobs: vi.fn(async () => snapshot([])),
      openOutputFolder: vi.fn(async () => {
        throw { code: "open_denied", message: "Open denied", details: "permission" };
      }),
      reorderJobs: vi.fn(async (jobIds: string[]) => snapshot(jobIds.map((id) => job(id)), 2)),
    };
    const controller = createQueueController({ initialSnapshot: snapshot([job("one")]), commands });

    await expect(controller.openOutputFolder("one", "/output")).rejects.toMatchObject({ code: "open_denied" });
    expect(controller.getState().pendingActions.one).toBeUndefined();
    expect(controller.getState().pendingMutation).toBeNull();

    await controller.cancelJob("one");
    expect(commands.cancelJob).toHaveBeenCalledWith("one");
  });

  it("releases the global lock when a command returns a stale snapshot", async () => {
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([])),
      resumeAll: vi.fn(async () => snapshot([])),
      cancelJob: vi.fn(async () => snapshot([job("one")], 1)),
      retryJob: vi.fn(async () => snapshot([])),
      clearCompleted: vi.fn(async () => snapshot([])),
      enqueueJobs: vi.fn(async () => snapshot([])),
      openOutputFolder: vi.fn(async () => undefined),
      reorderJobs: vi.fn(async (jobIds: string[]) => snapshot(jobIds.map((id) => job(id)), 2)),
    };
    const controller = createQueueController({ initialSnapshot: snapshot([job("one")], 5), commands });

    await controller.cancelJob("one");

    expect(controller.getState().jobsById.one.state.kind).toBe("queued");
    expect(controller.getState().pendingMutation).toBeNull();
    expect(controller.getState().pendingActions).toEqual({});
  });

  it("locks open-output actions until the typed command settles", async () => {
    let resolveOpen: (() => void) | undefined;
    const commands: QueueCommandAdapter = {
      pauseAll: vi.fn(async () => snapshot([])),
      resumeAll: vi.fn(async () => snapshot([])),
      cancelJob: vi.fn(async () => snapshot([])),
      retryJob: vi.fn(async () => snapshot([])),
      clearCompleted: vi.fn(async () => snapshot([])),
      enqueueJobs: vi.fn(async () => snapshot([])),
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
    await Promise.resolve();
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
      enqueueJobs: vi.fn(async () => snapshot([])),
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
        onPreview: () => undefined,
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

  it("renders Play preview only for completed jobs with an output path", () => {
    const completed = { ...job("completed", { kind: "completed", label: "Completed", outputPath: "/output/completed.mp4" }), outputPath: "/output/completed.mp4" };
    const completedMarkup = renderToStaticMarkup(createElement(QueueRow, {
      job: completed,
      isFirst: true,
      isLast: true,
      onCancel: () => undefined,
      onMove: () => undefined,
      onOpenOutputFolder: () => undefined,
      onPreview: () => undefined,
      onRetry: () => undefined,
    }));
    const completedWithoutOutputMarkup = renderToStaticMarkup(createElement(QueueRow, {
      job: job("completed-without-output", { kind: "completed", label: "Completed", outputPath: "/output/missing.mp4" }),
      isFirst: true,
      isLast: true,
      onCancel: () => undefined,
      onMove: () => undefined,
      onOpenOutputFolder: () => undefined,
      onPreview: () => undefined,
      onRetry: () => undefined,
    }));
    const queuedMarkup = renderToStaticMarkup(createElement(QueueRow, {
      job: job("queued"),
      isFirst: true,
      isLast: true,
      onCancel: () => undefined,
      onMove: () => undefined,
      onOpenOutputFolder: () => undefined,
      onPreview: () => undefined,
      onRetry: () => undefined,
    }));
    const failedMarkup = renderToStaticMarkup(createElement(QueueRow, {
      job: job("failed", {
        kind: "failed",
        label: "Failed",
        error: { code: "encode_failed", message: "Stopped" },
      }),
      isFirst: true,
      isLast: true,
      onCancel: () => undefined,
      onMove: () => undefined,
      onOpenOutputFolder: () => undefined,
      onPreview: () => undefined,
      onRetry: () => undefined,
    }));

    expect(completedMarkup).toContain('aria-label="Play preview for completed.mov"');
    expect(completedMarkup).toContain('aria-describedby="queue-row-completed-preview-file"');
    expect(completedMarkup).toContain('id="queue-row-completed-preview-file"');
    expect(completedMarkup).toContain(">Play preview</button>");
    expect(completedWithoutOutputMarkup).not.toContain("Play preview");
    expect(completedWithoutOutputMarkup).not.toContain("Stop preview");
    expect(queuedMarkup).not.toContain("Play preview");
    expect(failedMarkup).not.toContain("Play preview");
  });

  it("renders Stop preview for the active completed row", () => {
    const completed = { ...job("active", { kind: "completed", label: "Completed", outputPath: "/output/active.mp4" }), outputPath: "/output/active.mp4" };
    const markup = renderToStaticMarkup(createElement(QueueRow, {
      job: completed,
      isFirst: true,
      isLast: true,
      isPreviewActive: true,
      onCancel: () => undefined,
      onMove: () => undefined,
      onOpenOutputFolder: () => undefined,
      onPreview: () => undefined,
      onRetry: () => undefined,
    }));

    expect(markup).toContain('aria-label="Stop preview for active.mov"');
    expect(markup).toContain('aria-describedby="queue-row-active-preview-file"');
    expect(markup).toContain(">Stop preview</button>");
    expect(markup).not.toContain("Play preview");
  });

  it("passes the active preview state to the matching completed row", () => {
    mockAudioPreview.activePath = "/output/active.mp4";
    const controller = createQueueController({
      initialSnapshot: snapshot([{
        ...job("active", { kind: "completed", label: "Completed", outputPath: "/output/active.mp4" }),
        outputPath: "/output/active.mp4",
      }]),
    });

    const markup = renderToStaticMarkup(createElement(QueuePanel, { controller }));

    expect(markup).toContain('aria-label="Stop preview for active.mov"');
    expect(markup).toContain('aria-describedby="queue-row-active-preview-file"');
    expect(markup).toContain(">Stop preview</button>");
    mockAudioPreview.activePath = null;
  });

  it("gives completed preview controls unique accessible names by filename", () => {
    const first = {
      ...job("first", { kind: "completed", label: "Completed", outputPath: "/output/first.mp4" }),
      outputPath: "/output/first.mp4",
    };
    const second = {
      ...job("second", { kind: "completed", label: "Completed", outputPath: "/output/second.mp4" }),
      outputPath: "/output/second.mp4",
    };
    const controller = createQueueController({ initialSnapshot: snapshot([first, second]) });

    const markup = renderToStaticMarkup(createElement(QueuePanel, { controller }));

    expect(markup).toContain('aria-label="Play preview for first.mov"');
    expect(markup).toContain('aria-label="Play preview for second.mov"');
  });

  it("prepares completed output files for user-initiated preview", async () => {
    const completed = {
      ...job("ready", { kind: "completed", label: "Completed", outputPath: "/output/ready.mp3" }),
      outputPath: "/output/ready.mp3",
    };
    const controller = createQueueController({ initialSnapshot: snapshot([completed]) });

    render(createElement(QueuePanel, { controller }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockAudioPreview.prepare).toHaveBeenCalledWith("/output/ready.mp3");
  });

  it("stops and clears a pending preview when its queue row is removed", async () => {
    const completed = {
      ...job("pending", { kind: "completed", label: "Completed", outputPath: "/output/pending.mp4" }),
      outputPath: "/output/pending.mp4",
    };
    const controller = createQueueController({
      initialSnapshot: snapshot([completed]),
      commands: { clearCompleted: vi.fn(async () => snapshot([], 2)) },
    });

    render(createElement(QueuePanel, { controller }));
    await act(async () => {
      screen.getByRole("button", { name: "Play preview for pending.mov" }).click();
    });
    await act(async () => {
      await controller.clearCompleted();
    });

    expect(mockAudioPreview.stop).toHaveBeenCalledOnce();
  });

  it("stops and clears an errored preview when its queue row is removed", async () => {
    const completed = {
      ...job("errored", { kind: "completed", label: "Completed", outputPath: "/output/errored.mp4" }),
      outputPath: "/output/errored.mp4",
    };
    const previewError = "Preview unavailable. The format or codec is not supported by this platform.";
    const controller = createQueueController({ initialSnapshot: snapshot([completed]) });

    render(createElement(QueuePanel, { controller }));
    await act(async () => {
      screen.getByRole("button", { name: "Play preview for errored.mov" }).click();
    });
    mockAudioPreview.error = previewError;
    act(() => controller.applySnapshot(snapshot([completed], 2)));
    expect(screen.getByText(previewError)).not.toBeNull();

    act(() => controller.applySnapshot(snapshot([], 3)));
    expect(mockAudioPreview.stop).toHaveBeenCalledOnce();
    act(() => controller.applySnapshot(snapshot([completed], 4)));

    expect(screen.queryByText(previewError)).toBeNull();
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
      onPreview: () => undefined,
      onRetry: () => undefined,
    }));

    expect(markup).toContain("Cleanup warning");
    expect(markup).toContain("cleanup_warning");
    expect(markup).toContain("temp file");
  });

  it("disables every row action while one row action is pending", () => {
    const markup = renderToStaticMarkup(createElement(QueueRow, {
      job: { ...job("pending", { kind: "completed", label: "Completed", outputPath: "/output/pending.mp4" }), outputPath: "/output/pending.mp4" },
      pendingAction: "openOutputFolder",
      mutationPending: true,
      isFirst: true,
      isLast: true,
      onCancel: () => undefined,
      onMove: () => undefined,
      onOpenOutputFolder: () => undefined,
      onPreview: () => undefined,
      onRetry: () => undefined,
    }));

    expect(markup.match(/disabled=""/g)).toHaveLength(6);
  });

  it("announces completion warnings in the live region message", () => {
    const completed = job("warning", {
      kind: "completed",
      label: "Completed",
      outputPath: "/output/warning.mp4",
      warning: { code: "cleanup_warning", message: "Cleanup warning" },
    });

    expect(queueTransitionAnnouncement(completed, "transcoding")).toContain("Cleanup warning");
  });

  it("increments the live announcement nonce for repeated identical warnings", () => {
    const first = nextQueueAnnouncement({ text: "", sequence: 0 }, "Cleanup warning");
    const second = nextQueueAnnouncement(first, "Cleanup warning");

    expect(first).toEqual({ text: "Cleanup warning", sequence: 1 });
    expect(second).toEqual({ text: "Cleanup warning", sequence: 2 });
  });

  it("renders global pause, resume, and clear-completed controls with live announcements", () => {
    const controller = createQueueController({ initialSnapshot: snapshot([]) });
    const markup = renderToStaticMarkup(createElement(QueuePanel, { controller }));

    expect(markup).toContain("Batch queue");
    expect(markup).toContain("Pause all");
    expect(markup).toContain("Clear completed");
    expect(markup).toContain("Cancel active");
    expect(markup).toContain("Queue items");
    expect(markup).not.toContain('aria-label="0 queue items"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("No conversions in the queue yet.");
    expect(markup.match(/<audio /g)).toHaveLength(1);
    expect(markup).toContain('class="audio-preview"');
  });
});
