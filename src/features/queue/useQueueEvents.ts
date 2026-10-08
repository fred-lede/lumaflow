import { useEffect, useMemo, useSyncExternalStore } from "react";

import { getCurrentWebview } from "@tauri-apps/api/webview";

import type { JobEvent, JobState, ProcessingKind, QueueJob, QueueSnapshot } from "../../domain/job";
import {
  cancelJob,
  clearCompleted,
  openOutputFolder,
  pauseAll,
  resumeAll,
  retryJob,
} from "../../shared/tauri";

export const JOB_EVENT = "job-event";

export type QueueClientState = {
  jobsById: Record<string, QueueJob>;
  order: string[];
  paused: boolean;
};

export type QueueEventAdapter = {
  listen: (handler: (event: JobEvent) => void) => Promise<() => void>;
};

export type QueueCommandAdapter = {
  cancelJob: typeof cancelJob;
  clearCompleted: typeof clearCompleted;
  openOutputFolder: typeof openOutputFolder;
  pauseAll: typeof pauseAll;
  resumeAll: typeof resumeAll;
  retryJob: typeof retryJob;
};

export type QueueController = {
  applySnapshot: (snapshot: QueueSnapshot, preserveOrder?: boolean) => void;
  cancelJob: (jobId: string) => Promise<QueueSnapshot>;
  clearCompleted: () => Promise<QueueSnapshot>;
  getState: () => QueueClientState;
  handleEvent: (event: JobEvent) => void;
  moveJob: (jobId: string, direction: "up" | "down") => void;
  openOutputFolder: (path: string) => Promise<void>;
  pauseAll: () => Promise<QueueSnapshot>;
  resumeAll: () => Promise<QueueSnapshot>;
  retryJob: (jobId: string) => Promise<QueueSnapshot>;
  subscribe: (listener: () => void) => () => void;
};

const defaultEventAdapter: QueueEventAdapter = {
  listen: async (handler) => {
    const unlisten = await getCurrentWebview().listen<JobEvent>(JOB_EVENT, (event) => {
      handler(event.payload);
    });
    return unlisten;
  },
};

const defaultCommandAdapter: QueueCommandAdapter = {
  cancelJob,
  clearCompleted,
  openOutputFolder,
  pauseAll,
  resumeAll,
  retryJob,
};

function emptyState(): QueueClientState {
  return { jobsById: {}, order: [], paused: false };
}

function stateFromSnapshot(snapshot: QueueSnapshot): QueueClientState {
  return {
    jobsById: Object.fromEntries(snapshot.jobs.map((job) => [job.id, job])),
    order: snapshot.jobs.map((job) => job.id),
    paused: snapshot.paused,
  };
}

function processingKindForState(state: JobState): ProcessingKind | null {
  switch (state.kind) {
    case "losslessRemux":
      return { kind: "losslessRemux", label: "Lossless remux" };
    case "losslessAudio":
      return { kind: "losslessAudio", label: "Lossless audio" };
    case "transcoding":
      return { kind: "transcoding", label: "Transcoding" };
    default:
      return null;
  }
}

function placeholderJob(jobId: string, state: JobState): QueueJob {
  return {
    id: jobId,
    sourcePath: jobId,
    media: {
      path: jobId,
      fileName: jobId,
      container: "unknown",
      durationSeconds: 0,
      sizeBytes: 0,
      videoStreams: [],
      audioStreams: [],
      subtitleStreams: [],
    },
    outputSettings: {
      outputDirectory: "",
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
    processingKind: processingKindForState(state),
    state,
    progress: state.kind === "completed" ? 1 : 0,
    outputPath: state.kind === "completed" ? state.outputPath : null,
  };
}

export function createQueueStore(initialSnapshot?: QueueSnapshot) {
  const listeners = new Set<() => void>();
  let state = initialSnapshot ? stateFromSnapshot(initialSnapshot) : emptyState();

  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const applySnapshot = (snapshot: QueueSnapshot, preserveOrder = false): void => {
    const jobsById = Object.fromEntries(snapshot.jobs.map((job) => [job.id, job]));
    const incomingOrder = snapshot.jobs.map((job) => job.id);
    const order = preserveOrder
      ? [
          ...state.order.filter((jobId) => jobId in jobsById),
          ...incomingOrder.filter((jobId) => !state.order.includes(jobId)),
        ]
      : incomingOrder;
    state = { jobsById, order, paused: snapshot.paused };
    emit();
  };

  const handleEvent = (event: JobEvent): void => {
    if (event.kind === "progress") {
      const job = state.jobsById[event.jobId];
      if (!job || job.state.kind === "completed" || event.progress < job.progress) {
        return;
      }
      const progress = Math.max(0, Math.min(1, event.progress));
      if (progress === job.progress) {
        return;
      }
      state = {
        ...state,
        jobsById: { ...state.jobsById, [event.jobId]: { ...job, progress } },
      };
      emit();
      return;
    }

    const previousJob = state.jobsById[event.jobId];
    const previousProgress = previousJob?.progress ?? 0;
    const nextJob = {
      ...(previousJob ?? placeholderJob(event.jobId, event.state)),
      state: event.state,
      progress:
        event.state.kind === "queued"
          ? 0
          : event.state.kind === "completed"
            ? 1
            : previousProgress,
      outputPath: event.state.kind === "completed" ? event.state.outputPath : previousJob?.outputPath ?? null,
    };
    state = {
      ...state,
      jobsById: { ...state.jobsById, [event.jobId]: nextJob },
      order: previousJob ? state.order : [...state.order, event.jobId],
    };
    emit();
  };

  const moveJob = (jobId: string, direction: "up" | "down"): void => {
    const index = state.order.indexOf(jobId);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= state.order.length) {
      return;
    }
    const order = [...state.order];
    [order[index], order[targetIndex]] = [order[targetIndex], order[index]];
    state = { ...state, order };
    emit();
  };

  return {
    applySnapshot,
    getState: () => state,
    handleEvent,
    moveJob,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export async function subscribeToQueueEvents(
  adapter: QueueEventAdapter,
  onEvent: (event: JobEvent) => void,
): Promise<() => void> {
  return adapter.listen(onEvent);
}

export function createQueueController(options: {
  commands?: Partial<QueueCommandAdapter>;
  initialSnapshot?: QueueSnapshot;
} = {}): QueueController {
  const store = createQueueStore(options.initialSnapshot);
  const commands = { ...defaultCommandAdapter, ...options.commands };
  const runSnapshotCommand = async (command: () => Promise<QueueSnapshot>): Promise<QueueSnapshot> => {
    const snapshot = await command();
    store.applySnapshot(snapshot, true);
    return snapshot;
  };

  return {
    applySnapshot: store.applySnapshot,
    cancelJob: (jobId) => runSnapshotCommand(() => commands.cancelJob(jobId)),
    clearCompleted: () => runSnapshotCommand(() => commands.clearCompleted()),
    getState: store.getState,
    handleEvent: store.handleEvent,
    moveJob: store.moveJob,
    openOutputFolder: commands.openOutputFolder,
    pauseAll: () => runSnapshotCommand(() => commands.pauseAll()),
    resumeAll: () => runSnapshotCommand(() => commands.resumeAll()),
    retryJob: (jobId) => runSnapshotCommand(() => commands.retryJob(jobId)),
    subscribe: store.subscribe,
  };
}

export type UseQueueEventsOptions = {
  controller?: QueueController;
  eventAdapter?: QueueEventAdapter;
  enabled?: boolean;
  initialSnapshot?: QueueSnapshot;
  commands?: Partial<QueueCommandAdapter>;
};

export function useQueueEvents(options: UseQueueEventsOptions = {}) {
  const ownController = useMemo(
    () => createQueueController({ commands: options.commands, initialSnapshot: options.initialSnapshot }),
    [options.commands, options.initialSnapshot],
  );
  const controller = options.controller ?? ownController;
  const enabled = options.enabled ?? true;
  const eventAdapter = options.eventAdapter ?? defaultEventAdapter;
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  useEffect(() => {
    if (!enabled || options.controller) {
      return undefined;
    }
    let active = true;
    let cleanup: (() => void) | undefined;
    void subscribeToQueueEvents(eventAdapter, controller.handleEvent).then((unlisten) => {
      if (active) {
        cleanup = unlisten;
      } else {
        unlisten();
      }
    });
    return () => {
      active = false;
      cleanup?.();
    };
  }, [controller, enabled, eventAdapter, options.controller]);

  return { controller, state };
}

export default useQueueEvents;
