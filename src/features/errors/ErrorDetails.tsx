import type { FC } from "react";

export type TechnicalError = {
  code: string;
  message: string;
  details?: unknown;
};

export type ErrorDetailsProps = {
  error: TechnicalError;
};

function formatDetails(details: unknown): string {
  if (typeof details === "string") {
    return details;
  }
  try {
    return JSON.stringify(details, null, 2) ?? String(details);
  } catch {
    return String(details);
  }
}

export const ErrorDetails: FC<ErrorDetailsProps> = ({ error }) => (
  <details className="error-details">
    <summary>Technical details</summary>
    <dl className="error-details__list">
      <div>
        <dt>Error code</dt>
        <dd>{error.code}</dd>
      </div>
      {error.details ? (
        <div>
          <dt>Backend details</dt>
          <dd><pre>{formatDetails(error.details)}</pre></dd>
        </div>
      ) : null}
    </dl>
  </details>
);

export default ErrorDetails;
