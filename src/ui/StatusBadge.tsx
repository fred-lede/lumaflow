import type { FC } from "react";

export type StatusBadgeStatus = "attention" | "offline" | "ready" | "working";

export type StatusBadgeProps = {
  label: string;
  status: StatusBadgeStatus;
};

const statusIcons: Record<StatusBadgeStatus, string> = {
  attention: "!",
  offline: "×",
  ready: "✓",
  working: "↻",
};

export const StatusBadge: FC<StatusBadgeProps> = ({ label, status }) => (
  <span
    className={`status-badge status-badge--${status}`}
    data-status={status}
    role="status"
    tabIndex={0}
  >
    <span className="status-badge__icon" data-status-icon="true" aria-hidden="true">
      {statusIcons[status]}
    </span>
    <span data-status-label="true">{label}</span>
  </span>
);

export default StatusBadge;
