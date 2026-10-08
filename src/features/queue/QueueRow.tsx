import type { FC } from "react";

import type { QueueJob } from "../../domain/job";
import ErrorDetails from "../errors/ErrorDetails";
import {
  canCancelJob,
  canOpenOutput,
  canRetryJob,
  processingKindVisibleLabel,
  queueStatusFor,
} from "./queueLabels";

export type QueueRowProps = {
  isFirst: boolean;
  isLast: boolean;
  job: QueueJob;
  onCancel: (jobId: string) => void;
  onMoveDown: (jobId: string) => void;
  onMoveUp: (jobId: string) => void;
  onOpenOutputFolder: (path: string) => void;
  onRetry: (jobId: string) => void;
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

export const QueueRow: FC<QueueRowProps> = ({
  isFirst,
  isLast,
  job,
  onCancel,
  onMoveDown,
  onMoveUp,
  onOpenOutputFolder,
  onRetry,
}) => {
  const status = queueStatusFor(job.state);
  const percentage = progressPercent(job);
  const canOpen = canOpenOutput(job.state.kind) && job.outputPath !== null;

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

        <div className="queue-row__actions">
          <button
            className="button button--secondary"
            type="button"
            onClick={() => onCancel(job.id)}
            disabled={!canCancelJob(job.state.kind)}
          >
            Cancel
          </button>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => onRetry(job.id)}
            disabled={!canRetryJob(job.state.kind)}
          >
            Retry
          </button>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => job.outputPath && onOpenOutputFolder(job.outputPath)}
            disabled={!canOpen}
          >
            Open output folder
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => onMoveUp(job.id)}
            disabled={isFirst}
            aria-label={`Move ${fileNameForJob(job)} up`}
          >
            ↑
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => onMoveDown(job.id)}
            disabled={isLast}
            aria-label={`Move ${fileNameForJob(job)} down`}
          >
            ↓
          </button>
        </div>
      </div>
    </li>
  );
};

export default QueueRow;
