import type { FC } from "react";

import type { JobError } from "../../domain/job";

export type ErrorDetailsProps = {
  error: JobError;
};

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
          <dd><pre>{error.details}</pre></dd>
        </div>
      ) : null}
    </dl>
  </details>
);

export default ErrorDetails;
