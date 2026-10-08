import type { FC } from "react";

import type { SourceFile } from "./useFileIntake";

export type SourceFileListProps = {
  sources: SourceFile[];
  onRemove: (id: string) => void;
};

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) {
    return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  }
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function fileNameForPath(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/");
  return segments.at(-1) || "Unnamed file";
}

export const SourceFileList: FC<SourceFileListProps> = ({ sources, onRemove }) => {
  if (sources.length === 0) {
    return (
      <div className="empty-state source-empty-state">
        <span className="empty-state__icon" aria-hidden="true">
          ◌
        </span>
        <span>No source media selected yet.</span>
      </div>
    );
  }

  return (
    <ul className="source-list" aria-label="Selected source files">
      {sources.map((source) => (
        <li className="source-list__item" key={source.id}>
          <div className="source-list__details">
            <strong>{source.media?.fileName ?? fileNameForPath(source.path)}</strong>
            {source.status === "analyzing" ? (
              <span className="source-list__meta">Analyzing media…</span>
            ) : source.status === "error" ? (
              <span className="source-list__error" role="alert">
                {source.error}
              </span>
            ) : (
              <span className="source-list__meta">
                {source.media?.container.toUpperCase()} · {formatDuration(source.media?.durationSeconds ?? 0)} · {formatBytes(source.media?.sizeBytes ?? 0)}
              </span>
            )}
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => onRemove(source.id)}
            aria-label={`Remove ${source.media?.fileName ?? fileNameForPath(source.path)}`}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
};

export default SourceFileList;
