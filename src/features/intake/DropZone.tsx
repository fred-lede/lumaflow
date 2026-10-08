import type { FC } from "react";

export type DropZoneProps = {
  isBusy?: boolean;
  onSelectFiles: () => void;
};

export const DropZone: FC<DropZoneProps> = ({ isBusy = false, onSelectFiles }) => {
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
        {isBusy ? "Analyzing…" : "Choose files"}
      </button>
    </div>
  );
};

export default DropZone;
