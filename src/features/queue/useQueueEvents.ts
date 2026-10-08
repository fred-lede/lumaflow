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
  pendingMutation: string | null;
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
    pendingMutation: null,
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

  const setPendingMutation = (mutation: string | null): void => {
    state = { ...state, pendingMutation: mutation };
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
    setPendingMutation,
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
  let activeMutationId: number | null = null;
  let queuedMutationCount = 0;
  let mutationTail: Promise<void> = Promise.resolve();

  type MutationOptions<T> = {
    label: string;
    jobIds?: string[];
    jobAction?: QueueJobAction;
    globalAction?: string;
    execute: () => Promise<T>;
    apply?: (result: T, operationId: number) => void;
  };

  const markMutation = <T>(mutation: MutationOptions<T>, operationId: number): void => {
    activeMutationId = operationId;
    store.setPendingMutation(mutation.label);
    if (mutation.jobIds && mutation.jobAction) {
      store.setPendingAction(mutation.jobIds, mutation.jobAction);
    }
    if (mutation.globalAction) {
      store.setPendingGlobalAction(mutation.globalAction);
    }
  };

  const clearMutation = <T>(mutation: MutationOptions<T>, operationId: number): void => {
    if (activeMutationId !== operationId) {
      return;
    }
    activeMutationId = null;
    if (mutation.jobIds && mutation.jobAction) {
      store.setPendingAction(mutation.jobIds, undefined);
    }
    if (mutation.globalAction) {
      store.setPendingGlobalAction(null);
    }
    if (queuedMutationCount === 0) {
      store.setPendingMutation(null);
    }
  };

  const enqueueMutation = <T>(mutation: MutationOptions<T>): Promise<T> => {
    const operationId = ++nextOperationId;
    queuedMutationCount += 1;
    if (queuedMutationCount === 1) {
      markMutation(mutation, operationId);
    }

    const run = async (): Promise<T> => {
      if (activeMutationId !== operationId) {
        markMutation(mutation, operationId);
      }
      try {
        const result = await mutation.execute();
        if (mutation.apply && activeMutationId === operationId) {
          mutation.apply(result, operationId);
        }
        return result;
      } finally {
        queuedMutationCount -= 1;
        clearMutation(mutation, operationId);
      }
    };

    const result = mutationTail.then(run, run);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const runSnapshotMutation = (
    label: string,
    jobIds: string[],
    jobAction: QueueJobAction,
    command: () => Promise<QueueSnapshot>,
    globalAction?: string,
  ): Promise<QueueSnapshot> => enqueueMutation({
    label,
    jobIds,
    jobAction,
    globalAction,
    execute: command,
    apply: (snapshot) => store.applySnapshot(snapshot),
  });

  const runGlobalSnapshotMutation = (
    label: string,
    command: () => Promise<QueueSnapshot>,
  ): Promise<QueueSnapshot> => enqueueMutation({
    label,
    globalAction: label,
    execute: command,
    apply: (snapshot) => store.applySnapshot(snapshot),
  });

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
    return runSnapshotMutation("reorder", [jobId, targetJobId], "reorder", () => commands.reorderJobs(nextOrder));
  };

  return {
    applySnapshot: store.applySnapshot,
    cancelJob: (jobId) => runSnapshotMutation("cancel", [jobId], "cancel", () => commands.cancelJob(jobId)),
    clearCompleted: () => runGlobalSnapshotMutation("clear", () => commands.clearCompleted()),
    getState: store.getState,
    handleEvent: store.handleEvent,
    moveJob,
    openOutputFolder: (jobId, path) => {
      return enqueueMutation({
        label: "openOutputFolder",
        jobIds: [jobId],
        jobAction: "openOutputFolder",
        execute: () => commands.openOutputFolder(path),
      });
    },
    pauseAll: () => runGlobalSnapshotMutation("pause", () => commands.pauseAll()),
    reportEventError: store.setEventError,
    resumeAll: () => runGlobalSnapshotMutation("resume", () => commands.resumeAll()),
    retryJob: (jobId) => runSnapshotMutation("retry", [jobId], "retry", () => commands.retryJob(jobId)),
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
