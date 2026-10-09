import { memo } from "react";
import type { FC } from "react";

import type { QueueJob } from "../../domain/job";
import ErrorDetails from "../errors/ErrorDetails";
import {
  canCancelJob,
  canOpenOutput,
  canRetryJob,
  canReorderJob,
  processingKindVisibleLabel,
  queueStatusFor,
} from "./queueLabels";
import type { QueueJobAction } from "./useQueueEvents";

export type QueueRowProps = {
  isFirst: boolean;
  isLast: boolean;
  canMoveDown?: boolean;
  canMoveUp?: boolean;
  job: QueueJob;
  isPreviewActive?: boolean;
  mutationPending?: boolean;
  pendingAction?: QueueJobAction;
  onCancel: (jobId: string) => void;
  onMove: (jobId: string, direction: "up" | "down") => void;
  onOpenOutputFolder: (jobId: string, path: string) => void;
  onPreview: (path: string) => void;
  onRetry: (jobId: string) => void;
  previewError?: string | null;
};

function fileNameForJob(job: QueueJob): string {
  return job.media.fileName || job.sourcePath.split(/[\\/]/).at(-1) || job.id;
}

function outputFormatForJob(job: QueueJob): string {
  return job.outputSettings.format.toUpperCase();
}

function progressPercent(job: QueueJob): number {
  return Math.round(Math.max(0, Math.min(1, job.progress)) * 100);
}

export const QueueRow: FC<QueueRowProps> = memo(({
  isFirst,
  isLast,
  canMoveDown = !isLast,
  canMoveUp = !isFirst,
  job,
  isPreviewActive = false,
  mutationPending = false,
  pendingAction,
  onCancel,
  onMove,
  onOpenOutputFolder,
  onPreview,
  onRetry,
  previewError = null,
}) => {
  const status = queueStatusFor(job.state);
  const percentage = progressPercent(job);
  const canOpen = canOpenOutput(job.state.kind) && job.outputPath !== null;
  const previewPath = job.outputPath;
  const previewLabel = `${isPreviewActive ? "Stop" : "Play"} preview for ${fileNameForJob(job)}`;
  const actionLocked = mutationPending || pendingAction !== undefined;
  const canMoveUpForJob = canReorderJob(job.state.kind) && canMoveUp;
  const canMoveDownForJob = canReorderJob(job.state.kind) && canMoveDown;

  return (
    <li className="queue-row" data-job-id={job.id}>
      <div className="queue-row__main">
        <div className="queue-row__heading">
          <div className="queue-row__title">
            <strong title={job.sourcePath}>{fileNameForJob(job)}</strong>
            <span className="queue-row__meta">→ {outputFormatForJob(job)}</span>
          </div>
          <span
            className={`queue-status queue-status--${status.tone}`}
            data-status-tone={status.tone}
            role="status"
          >
            <span className="queue-status__icon" aria-hidden="true">{status.icon}</span>
            <span>{status.label}</span>
          </span>
        </div>

        <div className="queue-row__meta-line">
          <span data-processing-kind="true">{processingKindVisibleLabel(job.processingKind)}</span>
          <span aria-label={`${percentage}% complete`}>{percentage}%</span>
        </div>
        <progress
          className="queue-progress"
          max="100"
          value={percentage}
          aria-label={`${fileNameForJob(job)} progress`}
        />

        {job.state.kind === "failed" ? (
          <div className="queue-row__error">
            <p>{job.state.error.message}</p>
            <ErrorDetails error={job.state.error} />
          </div>
        ) : null}
        {job.state.kind === "completed" && job.state.warning ? (
          <div className="queue-row__warning">
            <p>{job.state.warning.message}</p>
            <ErrorDetails error={job.state.warning} />
          </div>
        ) : null}

        <div className="queue-row__actions" role="group" aria-label={`${fileNameForJob(job)} actions`}>
          {previewError ? <p className="inline-error" role="alert">{previewError}</p> : null}
          {job.state.kind === "completed" && previewPath !== null ? (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => onPreview(previewPath)}
              disabled={actionLocked}
              aria-label={previewLabel}
            >
              {isPreviewActive ? "Stop preview" : "Play preview"}
            </button>
          ) : null}
          <button
            className="button button--secondary"
            type="button"
            onClick={() => onCancel(job.id)}
            disabled={actionLocked || !canCancelJob(job.state.kind)}
          >
            Cancel
          </button>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => onRetry(job.id)}
            disabled={actionLocked || !canRetryJob(job.state.kind)}
          >
            Retry
          </button>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => job.outputPath && onOpenOutputFolder(job.id, job.outputPath)}
            disabled={actionLocked || !canOpen}
          >
            Open output folder
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => onMove(job.id, "up")}
            disabled={actionLocked || !canMoveUpForJob}
            aria-label={`Move ${fileNameForJob(job)} up`}
          >
            ↑
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => onMove(job.id, "down")}
            disabled={actionLocked || !canMoveDownForJob}
            aria-label={`Move ${fileNameForJob(job)} down`}
          >
            ↓
          </button>
        </div>
      </div>
    </li>
  );
});

export default QueueRow;
