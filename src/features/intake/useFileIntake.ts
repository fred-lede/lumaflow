import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EnqueueJobRequest } from "../../domain/job";
import type { MediaInfo, OutputSettings } from "../../domain/media";
import {
  analyzeFiles,
  enqueueJobs,
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

const defaultAdapter: FileIntakeAdapter = {
  analyzeFiles,
  enqueueJobs,
  registerFileDropHandler,
  selectFiles,
};

export type EnqueueSourceResult = {
  enqueuedIds: string[];
  failed: Array<Pick<SourceFile, "id" | "path"> & { error: string }>;
};

const emptyAdapterOverrides: Partial<FileIntakeAdapter> = {};

export function normalizeSelectedPaths(paths: string[]): string[] {
  const normalized = paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0);

  return normalized.filter((path, index) => normalized.indexOf(path) === index);
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
  return `source-${stableHash(path)}`;
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

export function useFileIntake(options: UseFileIntakeOptions = {}) {
  const overrides = options.adapter ?? emptyAdapterOverrides;
  const adapter = useMemo(() => ({ ...defaultAdapter, ...overrides }), [overrides]);
  const [sources, setSources] = useState<SourceFile[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addPaths = useCallback(
    async (paths: string[]) => {
      const normalizedPaths = normalizeSelectedPaths(paths);
      if (normalizedPaths.length === 0) {
        return [];
      }
      setError(null);

      const existingPaths = new Set(sources.map((source) => source.path));
      const newPaths = normalizedPaths.filter((path) => !existingPaths.has(path));
      if (newPaths.length === 0) {
        return [];
      }

      setSources((current) => [
        ...current,
        ...newPaths.map((path) => ({
          id: sourceIdForPath(path),
          path,
          media: null,
          status: "analyzing" as const,
          error: null,
        })),
      ]);
      setIsBusy(true);
      const analyzed = await analyzeSourcePaths(newPaths, adapter.analyzeFiles);
      setSources((current) => {
        const analyzedById = new Map(analyzed.map((source) => [source.id, source]));
        return current.map((source) => analyzedById.get(source.id) ?? source);
      });
      setIsBusy(false);
      return analyzed;
    },
    [adapter.analyzeFiles, sources],
  );

  const chooseFiles = useCallback(async () => {
    try {
      return addPaths(await adapter.selectFiles());
    } catch (selectionError) {
      setError(LumaFlowError.from(selectionError).message);
      return [];
    }
  }, [adapter.selectFiles, addPaths]);

  const removeSource = useCallback((id: string) => {
    setSources((current) => removeSourceById(current, id));
  }, []);

  const enqueue = useCallback(
    async (settings: OutputSettings) => {
      setIsBusy(true);
      const result = await enqueueSourceFiles(sources, settings, adapter.enqueueJobs);
      setSources((current) => {
        const failedById = new Map(result.failed.map((failure) => [failure.id, failure.error]));
        return current
          .filter((source) => !result.enqueuedIds.includes(source.id))
          .map((source) => ({
            ...source,
            status: failedById.has(source.id) ? ("error" as const) : source.status,
            error: failedById.get(source.id) ?? source.error,
          }));
      });
      setIsBusy(false);
      return result;
    },
    [adapter.enqueueJobs, sources],
  );

  const addPathsRef = useRef(addPaths);

  useEffect(() => {
    addPathsRef.current = addPaths;
  }, [addPaths]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let active = true;

    void adapter.registerFileDropHandler((paths) => {
      void addPathsRef.current(paths);
    }).then((unlisten) => {
      if (active) {
        cleanup = unlisten;
      } else {
        unlisten();
      }
    }).catch((registrationError: unknown) => {
      if (active) {
        setError(LumaFlowError.from(registrationError).message);
      }
    });

    return () => {
      active = false;
      cleanup?.();
    };
  }, [adapter.registerFileDropHandler]);

  return {
    addPaths,
    chooseFiles,
    enqueue,
    error,
    isBusy,
    removeSource,
    sources,
  };
}

export default useFileIntake;
