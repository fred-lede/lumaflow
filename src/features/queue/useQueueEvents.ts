import { useEffect, useMemo, useSyncExternalStore } from "react";

import { getCurrentWebview } from "@tauri-apps/api/webview";

import type { JobEvent, QueueJob, QueueSnapshot } from "../../domain/job";
import {
  cancelJob,
  clearCompleted,
  LumaFlowError,
  openOutputFolder,
  pauseAll,
  reorderJobs,
  resumeAll,
  retryJob,
} from "../../shared/tauri";

export const JOB_EVENT = "job-event";

export type QueueJobAction = "cancel" | "retry" | "openOutputFolder" | "reorder";

export type QueueError = {
  code: string;
  message: string;
  details?: unknown;
};

export type QueueClientState = {
  eventError: QueueError | null;
  jobsById: Record<string, QueueJob>;
  lastEventSequence: number;
  order: string[];
  paused: boolean;
  pendingActions: Record<string, QueueJobAction>;
  pendingGlobalAction: string | null;
  revision: number;
};

export type QueueEventAdapter = {
  listen: (handler: (event: JobEvent) => void) => Promise<() => void>;
};

export type QueueCommandAdapter = {
  cancelJob: typeof cancelJob;
  clearCompleted: typeof clearCompleted;
  openOutputFolder: typeof openOutputFolder;
  pauseAll: typeof pauseAll;
  reorderJobs: typeof reorderJobs;
  resumeAll: typeof resumeAll;
  retryJob: typeof retryJob;
};

export type QueueController = {
  applySnapshot: (snapshot: QueueSnapshot) => void;
  cancelJob: (jobId: string) => Promise<QueueSnapshot>;
  clearCompleted: () => Promise<QueueSnapshot>;
  getState: () => QueueClientState;
  handleEvent: (event: JobEvent) => void;
  moveJob: (jobId: string, direction: "up" | "down") => Promise<QueueSnapshot>;
  openOutputFolder: (jobId: string, path: string) => Promise<void>;
  pauseAll: () => Promise<QueueSnapshot>;
  reportEventError: (error: unknown) => void;
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
  reorderJobs,
  resumeAll,
  retryJob,
};

function emptyState(): QueueClientState {
  return {
    eventError: null,
    jobsById: {},
    lastEventSequence: 0,
    order: [],
    paused: false,
    pendingActions: {},
    pendingGlobalAction: null,
    revision: 0,
  };
}

function stateFromSnapshot(snapshot: QueueSnapshot): QueueClientState {
  return {
    ...emptyState(),
    jobsById: Object.fromEntries(snapshot.jobs.map((job) => [job.id, job])),
    order: snapshot.jobs.map((job) => job.id),
    paused: snapshot.paused,
    revision: snapshot.revision,
  };
}

function toQueueError(error: unknown): QueueError {
  const normalized = LumaFlowError.from(error);
  return { code: normalized.code, message: normalized.message, details: normalized.details };
}

function isTerminal(job: QueueJob): boolean {
  return ["completed", "cancelled", "failed"].includes(job.state.kind);
}

export function createQueueStore(initialSnapshot?: QueueSnapshot) {
  const listeners = new Set<() => void>();
  const jobRevisions = new Map<string, number>();
  const tombstones = new Map<string, number>();
  let state = initialSnapshot ? stateFromSnapshot(initialSnapshot) : emptyState();

  if (initialSnapshot) {
    for (const job of initialSnapshot.jobs) {
      jobRevisions.set(job.id, initialSnapshot.revision);
    }
  }

  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const applySnapshot = (snapshot: QueueSnapshot): boolean => {
    if (snapshot.revision < state.revision) {
      return false;
    }

    const nextJobsById = Object.fromEntries(snapshot.jobs.map((job) => [job.id, job]));
    for (const jobId of state.order) {
      if (!(jobId in nextJobsById)) {
        tombstones.set(jobId, snapshot.revision);
      }
    }
    for (const job of snapshot.jobs) {
      const tombstoneRevision = tombstones.get(job.id);
      if (tombstoneRevision !== undefined && snapshot.revision <= tombstoneRevision) {
        delete nextJobsById[job.id];
        continue;
      }
      tombstones.delete(job.id);
      jobRevisions.set(job.id, snapshot.revision);
    }

    state = {
      ...state,
      jobsById: nextJobsById,
      order: snapshot.jobs.map((job) => job.id).filter((jobId) => jobId in nextJobsById),
      paused: snapshot.paused,
      revision: snapshot.revision,
    };
    emit();
    return true;
  };

  const handleEvent = (event: JobEvent): void => {
    if (event.sequence <= state.lastEventSequence) {
      return;
    }
    state = { ...state, lastEventSequence: event.sequence };

    const job = state.jobsById[event.jobId];
    if (!job || event.revision < state.revision) {
      return;
    }
    const jobRevision = jobRevisions.get(event.jobId) ?? 0;
    if (event.revision < jobRevision || event.attempt < job.attempt) {
      return;
    }

    if (event.kind === "progress") {
      if (event.attempt !== job.attempt || isTerminal(job) || event.progress < job.progress) {
        return;
      }
      const progress = Math.max(0, Math.min(1, event.progress));
      jobRevisions.set(event.jobId, event.revision);
      state = {
        ...state,
        jobsById: { ...state.jobsById, [event.jobId]: { ...job, progress } },
        revision: Math.max(state.revision, event.revision),
      };
      emit();
      return;
    }

    if (isTerminal(job) && event.attempt === job.attempt) {
      return;
    }
    jobRevisions.set(event.jobId, event.revision);
    state = {
      ...state,
      jobsById: {
        ...state.jobsById,
        [event.jobId]: {
          ...job,
          attempt: event.attempt,
          outputPath: event.state.kind === "completed" ? event.state.outputPath : job.outputPath,
          progress: event.state.kind === "queued" ? 0 : event.state.kind === "completed" ? 1 : job.progress,
          state: event.state,
        },
      },
      revision: Math.max(state.revision, event.revision),
    };
    emit();
  };

  const setPendingAction = (jobIds: string[], action: QueueJobAction | undefined): void => {
    const pendingActions = { ...state.pendingActions };
    for (const jobId of jobIds) {
      if (action) {
        pendingActions[jobId] = action;
      } else {
        delete pendingActions[jobId];
      }
    }
    state = { ...state, pendingActions };
    emit();
  };

  const setPendingGlobalAction = (action: string | null): void => {
    state = { ...state, pendingGlobalAction: action };
    emit();
  };

  const setEventError = (error: unknown): void => {
    state = { ...state, eventError: toQueueError(error) };
    emit();
  };

  return {
    applySnapshot,
    getState: () => state,
    handleEvent,
    setEventError,
    setPendingAction,
    setPendingGlobalAction,
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

export async function startQueueEventSubscription(
  controller: Pick<QueueController, "reportEventError">,
  adapter: QueueEventAdapter,
  onEvent: (event: JobEvent) => void = () => undefined,
): Promise<() => void> {
  try {
    return await subscribeToQueueEvents(adapter, onEvent);
  } catch (error) {
    controller.reportEventError(error);
    return () => undefined;
  }
}

export function createQueueController(options: {
  commands?: Partial<QueueCommandAdapter>;
  initialSnapshot?: QueueSnapshot;
} = {}): QueueController {
  const store = createQueueStore(options.initialSnapshot);
  const commands = { ...defaultCommandAdapter, ...options.commands };
  let nextOperationId = 0;
  let latestGlobalOperation = 0;
  const latestJobOperations = new Map<string, number>();

  const beginJobOperation = (jobIds: string[], action: QueueJobAction): number => {
    const operationId = ++nextOperationId;
    for (const jobId of jobIds) {
      latestJobOperations.set(jobId, operationId);
    }
    store.setPendingAction(jobIds, action);
    return operationId;
  };

  const isCurrentJobOperation = (jobIds: string[], operationId: number): boolean =>
    jobIds.every((jobId) => latestJobOperations.get(jobId) === operationId);

  const finishJobOperation = (jobIds: string[], operationId: number): void => {
    if (!isCurrentJobOperation(jobIds, operationId)) {
      return;
    }
    for (const jobId of jobIds) {
      latestJobOperations.delete(jobId);
    }
    store.setPendingAction(jobIds, undefined);
  };

  const runJobSnapshotCommand = (
    jobIds: string[],
    action: QueueJobAction,
    command: () => Promise<QueueSnapshot>,
  ): Promise<QueueSnapshot> => {
    const operationId = beginJobOperation(jobIds, action);
    return command().then((snapshot) => {
      if (isCurrentJobOperation(jobIds, operationId)) {
        store.applySnapshot(snapshot);
      }
      return snapshot;
    }).finally(() => finishJobOperation(jobIds, operationId));
  };

  const runGlobalSnapshotCommand = (
    action: string,
    command: () => Promise<QueueSnapshot>,
  ): Promise<QueueSnapshot> => {
    const operationId = ++nextOperationId;
    latestGlobalOperation = operationId;
    store.setPendingGlobalAction(action);
    return command().then((snapshot) => {
      if (latestGlobalOperation === operationId) {
        store.applySnapshot(snapshot);
      }
      return snapshot;
    }).finally(() => {
      if (latestGlobalOperation === operationId) {
        store.setPendingGlobalAction(null);
      }
    });
  };

  const moveJob = (jobId: string, direction: "up" | "down"): Promise<QueueSnapshot> => {
    const current = store.getState();
    const index = current.order.indexOf(jobId);
    let targetIndex = -1;
    const step = direction === "up" ? -1 : 1;
    for (let candidate = index + step; candidate >= 0 && candidate < current.order.length; candidate += step) {
      if (current.jobsById[current.order[candidate]]?.state.kind === "queued") {
        targetIndex = candidate;
        break;
      }
    }
    const targetJobId = current.order[targetIndex];
    if (
      index < 0 ||
      targetIndex < 0 ||
      targetIndex >= current.order.length ||
      current.jobsById[jobId]?.state.kind !== "queued" ||
      current.jobsById[targetJobId]?.state.kind !== "queued"
    ) {
      return Promise.resolve({
        revision: current.revision,
        jobs: current.order
          .map((currentJobId) => current.jobsById[currentJobId])
          .filter((currentJob): currentJob is QueueJob => currentJob !== undefined),
        paused: current.paused,
      });
    }
    const nextOrder = [...current.order];
    [nextOrder[index], nextOrder[targetIndex]] = [nextOrder[targetIndex], nextOrder[index]];
    return runJobSnapshotCommand([jobId, targetJobId], "reorder", () => commands.reorderJobs(nextOrder));
  };

  return {
    applySnapshot: store.applySnapshot,
    cancelJob: (jobId) => runJobSnapshotCommand([jobId], "cancel", () => commands.cancelJob(jobId)),
    clearCompleted: () => runGlobalSnapshotCommand("clear", () => commands.clearCompleted()),
    getState: store.getState,
    handleEvent: store.handleEvent,
    moveJob,
    openOutputFolder: (jobId, path) => {
      const operationId = beginJobOperation([jobId], "openOutputFolder");
      return commands.openOutputFolder(path).finally(() => finishJobOperation([jobId], operationId));
    },
    pauseAll: () => runGlobalSnapshotCommand("pause", () => commands.pauseAll()),
    reportEventError: store.setEventError,
    resumeAll: () => runGlobalSnapshotCommand("resume", () => commands.resumeAll()),
    retryJob: (jobId) => runJobSnapshotCommand([jobId], "retry", () => commands.retryJob(jobId)),
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
    void startQueueEventSubscription(controller, eventAdapter, controller.handleEvent).then((unlisten) => {
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
