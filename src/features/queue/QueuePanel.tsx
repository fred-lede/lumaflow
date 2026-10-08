import { useCallback, useEffect, useRef, useState } from "react";
import type { FC } from "react";

import type { QueueJob } from "../../domain/job";
import { LumaFlowError } from "../../shared/tauri";
import GlassPanel from "../../ui/GlassPanel";
import ErrorDetails, { type TechnicalError } from "../errors/ErrorDetails";
import { canCancelJob, canReorderJob } from "./queueLabels";
import QueueRow from "./QueueRow";
import { useQueueEvents, type QueueController } from "./useQueueEvents";

export type QueuePanelProps = {
  controller?: QueueController;
};

function jobName(job: { media: { fileName: string }; sourcePath: string; id: string }): string {
  return job.media.fileName || job.sourcePath.split(/[\\/]/).at(-1) || job.id;
}

function queuedNeighborIndex(
  jobs: QueueJob[],
  index: number,
  direction: "up" | "down",
): number {
  const step = direction === "up" ? -1 : 1;
  for (let candidate = index + step; candidate >= 0 && candidate < jobs.length; candidate += step) {
    if (canReorderJob(jobs[candidate].state.kind)) {
      return candidate;
    }
  }
  return -1;
}

export const QueuePanel: FC<QueuePanelProps> = ({ controller: providedController }) => {
  const { controller, state } = useQueueEvents({ controller: providedController });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<TechnicalError | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const previousStates = useRef(new Map<string, string>());
  const jobs = state.order
    .map((jobId) => state.jobsById[jobId])
    .filter((job): job is NonNullable<typeof job> => job !== undefined);
  const activeJobs = jobs.filter((job) => canCancelJob(job.state.kind));
  const completedJobs = jobs.filter((job) => job.state.kind === "completed");

  useEffect(() => {
    const messages: string[] = [];
    for (const job of jobs) {
      const previousState = previousStates.current.get(job.id);
      if (previousState && previousState !== job.state.kind) {
        if (job.state.kind === "completed") {
          messages.push(`${jobName(job)} completed.`);
        } else if (job.state.kind === "failed") {
          messages.push(`${jobName(job)} failed. ${job.state.error.message}`);
        }
      }
      previousStates.current.set(job.id, job.state.kind);
    }
    for (const jobId of previousStates.current.keys()) {
      if (!state.jobsById[jobId]) {
        previousStates.current.delete(jobId);
      }
    }
    if (messages.length > 0) {
      setAnnouncement(messages.join(" "));
    }
  }, [jobs, state.jobsById]);

  const runAction = useCallback(async (name: string, action: () => Promise<unknown>) => {
    setBusyAction(name);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      const normalized = LumaFlowError.from(actionError);
      setError({ code: normalized.code, message: normalized.message, details: normalized.details });
    } finally {
      setBusyAction(null);
    }
  }, []);

  const isBusy = busyAction !== null || state.pendingGlobalAction !== null;
  const handleCancel = useCallback(
    (jobId: string) => void runAction(`cancel-${jobId}`, () => controller.cancelJob(jobId)),
    [controller, runAction],
  );
  const handleRetry = useCallback(
    (jobId: string) => void runAction(`retry-${jobId}`, () => controller.retryJob(jobId)),
    [controller, runAction],
  );
  const handleOpenOutputFolder = useCallback(
    (jobId: string, path: string) => void runAction(`open-${jobId}`, () => controller.openOutputFolder(jobId, path)),
    [controller, runAction],
  );
  const handleMove = useCallback(
    (jobId: string, direction: "up" | "down") =>
      void runAction(`reorder-${jobId}`, () => controller.moveJob(jobId, direction)),
    [controller, runAction],
  );

  return (
    <GlassPanel className="queue-panel" labelledBy="queue-title" role="region">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Processing workspace</p>
          <h2 id="queue-title">Batch queue</h2>
        </div>
        <span className="card-step" aria-label={`${jobs.length} queue items`}>
          {jobs.length.toString().padStart(2, "0")}
        </span>
      </div>
      <p className="supporting-text queue-panel__intro">
        Monitor local conversions, recover failures, and adjust the display order with the keyboard.
      </p>

      <div className="queue-toolbar" role="toolbar" aria-label="Queue actions" aria-busy={isBusy}>
        <button
          className="button button--secondary"
          type="button"
          onClick={() => void runAction("pause", controller.pauseAll)}
          disabled={state.paused || activeJobs.length === 0 || isBusy}
        >
          Pause all
        </button>
        <button
          className="button button--secondary"
          type="button"
          onClick={() => void runAction("resume", controller.resumeAll)}
          disabled={!state.paused || isBusy}
        >
          Resume all
        </button>
        <button
          className="button button--secondary"
          type="button"
          onClick={() =>
            void runAction("cancel-active", async () => {
              for (const job of activeJobs) {
                await controller.cancelJob(job.id);
              }
            })
          }
          disabled={activeJobs.length === 0 || isBusy}
        >
          Cancel active
        </button>
        <button
          className="button button--secondary"
          type="button"
          onClick={() => void runAction("clear", controller.clearCompleted)}
          disabled={completedJobs.length === 0 || isBusy}
        >
          Clear completed
        </button>
      </div>

      {state.eventError ? (
        <div className="inline-error queue-panel__error" role="alert">
          <p>{state.eventError.message}</p>
          <ErrorDetails error={state.eventError} />
        </div>
      ) : null}

      {error ? (
        <div className="inline-error queue-panel__error" role="alert">
          <p>{error.message}</p>
          <ErrorDetails error={error} />
        </div>
      ) : null}

      {jobs.length === 0 ? (
        <div className="empty-state queue-empty-state">
          <span className="empty-state__icon" aria-hidden="true">◌</span>
          <span>No conversions in the queue yet.</span>
        </div>
      ) : (
        <ol className="queue-list" aria-label="Conversion jobs">
          {jobs.map((job, index) => (
            <QueueRow
              key={job.id}
              job={job}
              pendingAction={state.pendingActions[job.id]}
              isFirst={index === 0}
              isLast={index === jobs.length - 1}
              canMoveUp={canReorderJob(job.state.kind) && queuedNeighborIndex(jobs, index, "up") >= 0}
              canMoveDown={canReorderJob(job.state.kind) && queuedNeighborIndex(jobs, index, "down") >= 0}
              onCancel={handleCancel}
              onMove={handleMove}
              onOpenOutputFolder={handleOpenOutputFolder}
              onRetry={handleRetry}
            />
          ))}
        </ol>
      )}

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </GlassPanel>
  );
};

export default QueuePanel;
