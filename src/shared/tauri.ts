import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";

import type { MediaInfo } from "../domain/media";
import type { EnqueueJobRequest, JobEvent, QueueSnapshot } from "../domain/job";

export class LumaFlowError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "LumaFlowError";
    Object.setPrototypeOf(this, LumaFlowError.prototype);
  }

  static from(error: unknown): LumaFlowError {
    if (error instanceof LumaFlowError) {
      return error;
    }

    if (error instanceof Error) {
      const structuredError = error as Error & {
        code?: unknown;
        details?: unknown;
      };
      const code =
        typeof structuredError.code === "string" ? structuredError.code : "backend_error";

      return new LumaFlowError(code, error.message, structuredError.details);
    }

    if (typeof error === "string") {
      return new LumaFlowError("backend_error", error);
    }

    if (typeof error === "object" && error !== null) {
      const record = error as Record<string, unknown>;
      const code = typeof record.code === "string" ? record.code : "backend_error";
      const message =
        typeof record.message === "string" ? record.message : "The backend request failed";

      return new LumaFlowError(code, message, record.details);
    }

    return new LumaFlowError("backend_error", "The backend request failed", error);
  }
}

async function invokeLumaFlow<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return args === undefined ? await invoke<T>(command) : await invoke<T>(command, args);
  } catch (error) {
    throw LumaFlowError.from(error);
  }
}

export function selectFiles(): Promise<string[]> {
  return invokeLumaFlow<string[]>("select_files");
}

export function consumeDroppedPaths(): Promise<string[]> {
  return invokeLumaFlow<string[]>("consume_dropped_paths");
}

export function registerFileDropHandler(handler: (paths: string[]) => void): Promise<UnlistenFn> {
  try {
    return getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") {
        return;
      }

      const paths = await consumeDroppedPaths();
      if (paths.length > 0) {
        handler(paths);
      }
    });
  } catch (error) {
    return Promise.reject(LumaFlowError.from(error));
  }
}

export function selectOutputFolder(): Promise<string | null> {
  return invokeLumaFlow<string | null>("select_output_folder");
}

export function analyzeFiles(paths: string[]): Promise<MediaInfo[]> {
  return invokeLumaFlow<MediaInfo[]>("analyze_files", { paths });
}

export function enqueueJobs(requests: EnqueueJobRequest[]): Promise<QueueSnapshot> {
  return invokeLumaFlow<QueueSnapshot>("enqueue_jobs", { jobs: requests });
}

export function pauseAll(): Promise<QueueSnapshot> {
  return invokeLumaFlow<QueueSnapshot>("pause_all");
}

export function resumeAll(): Promise<QueueSnapshot> {
  return invokeLumaFlow<QueueSnapshot>("resume_all");
}

export function cancelJob(jobId: string): Promise<QueueSnapshot> {
  return invokeLumaFlow<QueueSnapshot>("cancel_job", { jobId });
}

export function retryJob(jobId: string): Promise<QueueSnapshot> {
  return invokeLumaFlow<QueueSnapshot>("retry_job", { jobId });
}

export function reorderJobs(jobIds: string[]): Promise<QueueSnapshot> {
  return invokeLumaFlow<QueueSnapshot>("reorder_jobs", { jobIds });
}

export function clearCompleted(): Promise<QueueSnapshot> {
  return invokeLumaFlow<QueueSnapshot>("clear_completed");
}

export function openOutputFolder(path: string): Promise<void> {
  return invokeLumaFlow<void>("open_output_folder", { path });
}

export type { JobEvent };
