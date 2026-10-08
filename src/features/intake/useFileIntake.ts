import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { EnqueueJobRequest } from "../../domain/job";
import type { MediaInfo, OutputSettings } from "../../domain/media";
import {
  analyzeFiles,
  LumaFlowError,
  registerFileDropHandler,
  selectFiles,
} from "../../shared/tauri";

export type SourceFileStatus = "analyzing" | "ready" | "error";

export type SourceFile = {
  id: string;
  path: string;
  media: MediaInfo | null;
  status: SourceFileStatus;
  error: string | null;
};

export type AnalyzeFiles = (paths: string[]) => Promise<MediaInfo[]>;
export type SelectFiles = () => Promise<string[]>;
export type EnqueueJobs = (requests: EnqueueJobRequest[]) => Promise<unknown>;
export type RegisterFileDropHandler = (
  handler: (paths: string[]) => void,
) => Promise<() => void>;

export type FileIntakeAdapter = {
  analyzeFiles: AnalyzeFiles;
  enqueueJobs: EnqueueJobs;
  registerFileDropHandler: RegisterFileDropHandler;
  selectFiles: SelectFiles;
};

const defaultAdapter: Omit<FileIntakeAdapter, "enqueueJobs"> = {
  analyzeFiles,
  registerFileDropHandler,
  selectFiles,
};

const missingQueueCoordinator: EnqueueJobs = async () => {
  throw new LumaFlowError(
    "queue_coordinator_missing",
    "Queue coordinator is required before files can be enqueued",
  );
};

export type EnqueueSourceResult = {
  enqueuedIds: string[];
  failed: Array<Pick<SourceFile, "id" | "path"> & { error: string }>;
};

const emptyAdapterOverrides: Partial<FileIntakeAdapter> = {};

function resolveAdapter(overrides: Partial<FileIntakeAdapter>): FileIntakeAdapter {
  return {
    ...defaultAdapter,
    ...overrides,
    enqueueJobs: overrides.enqueueJobs ?? missingQueueCoordinator,
  };
}

export function normalizeSelectedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths) {
    const trimmed = path.trim();
    const key = canonicalPathKey(trimmed);
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      normalized.push(trimmed);
    }
  }
  return normalized;
}

export function canonicalPathKey(path: string): string {
  return path.trim().replaceAll("\\", "/");
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function sourceIdForPath(path: string): string {
  return `source-${stableHash(canonicalPathKey(path))}`;
}

export function removeSourceById(sources: SourceFile[], id: string): SourceFile[] {
  return sources.filter((source) => source.id !== id);
}

export async function analyzeSourcePaths(
  paths: string[],
  analyze: AnalyzeFiles,
): Promise<SourceFile[]> {
  const normalizedPaths = normalizeSelectedPaths(paths);
  if (normalizedPaths.length === 0) {
    return [];
  }

  try {
    const media = await analyze(normalizedPaths);
    return normalizedPaths.map((path, index) => ({
      id: sourceIdForPath(path),
      path,
      media: media[index] ?? null,
      status: media[index] ? "ready" : "error",
      error: media[index] ? null : "The backend did not return media metadata",
    }));
  } catch (error) {
    const message = LumaFlowError.from(error).message;
    return normalizedPaths.map((path) => ({
      id: sourceIdForPath(path),
      path,
      media: null,
      status: "error",
      error: message,
    }));
  }
}

export async function selectAndAnalyzeFiles(
  select: SelectFiles,
  analyze: AnalyzeFiles,
): Promise<SourceFile[]> {
  return analyzeSourcePaths(await select(), analyze);
}

export async function enqueueSourceFiles(
  sources: SourceFile[],
  settings: OutputSettings,
  enqueue: EnqueueJobs,
): Promise<EnqueueSourceResult> {
  const result: EnqueueSourceResult = { enqueuedIds: [], failed: [] };

  for (const source of sources) {
    if (!source.media) {
      result.failed.push({
        id: source.id,
        path: source.path,
        error: source.error ?? "The file has not been analyzed",
      });
      continue;
    }

    const request: EnqueueJobRequest = {
      sourcePath: source.path,
      media: source.media,
      outputSettings: settings,
    };

    try {
      await enqueue([request]);
      result.enqueuedIds.push(source.id);
    } catch (error) {
      result.failed.push({
        id: source.id,
        path: source.path,
        error: LumaFlowError.from(error).message,
      });
    }
  }

  return result;
}

export type UseFileIntakeOptions = {
  adapter?: Partial<FileIntakeAdapter>;
};

export type FileIntakeSnapshot = {
  canStart: boolean;
  enqueuePendingCount: number;
  error: string | null;
  pendingCount: number;
  sources: SourceFile[];
};

export type FileIntakeController = {
  addPaths: (paths: string[]) => Promise<SourceFile[]>;
  chooseFiles: () => Promise<SourceFile[]>;
  getState: () => FileIntakeSnapshot;
  removeSource: (id: string) => void;
  reportError: (error: unknown) => void;
  start: (settings: OutputSettings) => Promise<EnqueueSourceResult | null>;
  subscribe: (listener: () => void) => () => void;
};

export function createFileIntakeController(
  overrides: Partial<FileIntakeAdapter> = emptyAdapterOverrides,
): FileIntakeController {
  const adapter = resolveAdapter(overrides);
  const listeners = new Set<() => void>();
  const inFlightPaths = new Map<string, number>();
  const sourceRevisions = new Map<string, number>();
  let nextOperationId = 0;
  let nextSourceRevision = 0;
  let state: FileIntakeSnapshot = {
    canStart: false,
    enqueuePendingCount: 0,
    error: null,
    pendingCount: 0,
    sources: [],
  };

  const emit = (): void => {
    state = {
      ...state,
      canStart:
        state.pendingCount === 0 &&
        state.enqueuePendingCount === 0 &&
        state.sources.some((source) => source.status === "ready" && source.media !== null),
    };
    for (const listener of listeners) {
      listener();
    }
  };

  const addPaths = async (paths: string[]): Promise<SourceFile[]> => {
    const normalizedPaths = normalizeSelectedPaths(paths);
    const existingKeys = new Set(state.sources.map((source) => canonicalPathKey(source.path)));
    const newPaths = normalizedPaths.filter((path) => {
      const key = canonicalPathKey(path);
      return !existingKeys.has(key) && !inFlightPaths.has(key);
    });
    if (newPaths.length === 0) {
      return [];
    }

    const operationId = ++nextOperationId;
    const newSources = newPaths.map((path) => {
      const id = sourceIdForPath(path);
      sourceRevisions.set(id, ++nextSourceRevision);
      inFlightPaths.set(canonicalPathKey(path), operationId);
      return { id, path, media: null, status: "analyzing" as const, error: null };
    });
    state = {
      ...state,
      error: null,
      pendingCount: state.pendingCount + newPaths.length,
      sources: [...state.sources, ...newSources],
    };
    emit();

    const analyzed = await analyzeSourcePaths(newPaths, adapter.analyzeFiles);
    const applicable = analyzed.filter(
      (source) => inFlightPaths.get(canonicalPathKey(source.path)) === operationId,
    );
    for (const source of applicable) {
      inFlightPaths.delete(canonicalPathKey(source.path));
    }
    if (applicable.length > 0) {
      const analyzedById = new Map(applicable.map((source) => [source.id, source]));
      state = {
        ...state,
        pendingCount: Math.max(0, state.pendingCount - applicable.length),
        sources: state.sources.map((source) => analyzedById.get(source.id) ?? source),
      };
      emit();
    }
    return analyzed;
  };

  const chooseFiles = async (): Promise<SourceFile[]> => {
    try {
      return addPaths(await adapter.selectFiles());
    } catch (selectionError) {
      state = { ...state, error: LumaFlowError.from(selectionError).message };
      emit();
      return [];
    }
  };

  const removeSource = (id: string): void => {
    const source = state.sources.find((candidate) => candidate.id === id);
    if (!source) {
      return;
    }
    const key = canonicalPathKey(source.path);
    const wasPending = inFlightPaths.delete(key);
    sourceRevisions.delete(id);
    state = {
      ...state,
      pendingCount: Math.max(0, state.pendingCount - (wasPending ? 1 : 0)),
      sources: removeSourceById(state.sources, id),
    };
    emit();
  };

  const reportError = (error: unknown): void => {
    state = { ...state, error: LumaFlowError.from(error).message };
    emit();
  };

  const start = async (settings: OutputSettings): Promise<EnqueueSourceResult | null> => {
    if (!state.canStart) {
      return null;
    }

    const candidates = state.sources.filter((source) => source.status === "ready" && source.media !== null);
    const revisions = new Map(candidates.map((source) => [source.id, sourceRevisions.get(source.id)]));
    state = { ...state, enqueuePendingCount: state.enqueuePendingCount + 1 };
    emit();
    try {
      const result = await enqueueSourceFiles(candidates, settings, adapter.enqueueJobs);
      const enqueued = new Set(result.enqueuedIds);
      const failedById = new Map(result.failed.map((failure) => [failure.id, failure.error]));
      state = {
        ...state,
        sources: state.sources
          .filter((source) => !(enqueued.has(source.id) && sourceRevisions.get(source.id) === revisions.get(source.id)))
          .map((source) => {
            if (sourceRevisions.get(source.id) !== revisions.get(source.id)) {
              return source;
            }
            const error = failedById.get(source.id);
            return error ? { ...source, status: "error" as const, error } : source;
          }),
      };
      emit();
      return result;
    } finally {
      state = { ...state, enqueuePendingCount: Math.max(0, state.enqueuePendingCount - 1) };
      emit();
    }
  };

  return {
    addPaths,
    chooseFiles,
    getState: () => state,
    removeSource,
    reportError,
    start,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useFileIntake(options: UseFileIntakeOptions = {}) {
  const overrides = options.adapter ?? emptyAdapterOverrides;
  const adapter = useMemo(() => resolveAdapter(overrides), [overrides]);
  const controller = useMemo(() => createFileIntakeController(adapter), [adapter]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let active = true;
    void adapter.registerFileDropHandler((paths) => {
      void controller.addPaths(paths);
    }).then((unlisten) => {
      if (active) {
        cleanup = unlisten;
      } else {
        unlisten();
      }
    }).catch((registrationError: unknown) => {
      if (active) {
        controller.reportError(registrationError);
      }
    });
    return () => {
      active = false;
      cleanup?.();
    };
  }, [adapter.registerFileDropHandler, controller]);

  return {
    ...snapshot,
    addPaths: controller.addPaths,
    chooseFiles: controller.chooseFiles,
    removeSource: controller.removeSource,
    start: controller.start,
  };
}

export default useFileIntake;
