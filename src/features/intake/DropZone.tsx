import type { FC } from "react";

export type DropZoneProps = {
  pendingCount?: number;
  onSelectFiles: () => void;
};

export const DropZone: FC<DropZoneProps> = ({ pendingCount = 0, onSelectFiles }) => {
  const isBusy = pendingCount > 0;
  return (
    <div className="drop-zone" aria-busy={isBusy}>
      <div className="drop-zone__icon" aria-hidden="true">
        ⇩
      </div>
      <div className="drop-zone__copy">
        <strong>Drop media here</strong>
        <span>Files stay local and are analyzed before enqueueing.</span>
      </div>
      <button className="button button--secondary" type="button" onClick={onSelectFiles} disabled={isBusy}>
        {isBusy ? `Analyzing ${pendingCount} file${pendingCount === 1 ? "" : "s"}…` : "Choose files"}
      </button>
    </div>
  );
};

export default DropZone;
