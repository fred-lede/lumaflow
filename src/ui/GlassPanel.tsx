import type { FC, ReactNode } from "react";

export type GlassPanelProps = {
  children: ReactNode;
  className?: string;
  labelledBy?: string;
  as?: "div" | "section";
  role?: "region";
};

export const GlassPanel: FC<GlassPanelProps> = ({
  as: Panel = "section",
  children,
  className,
  labelledBy,
  role,
}) => {
  const panelClassName = className ? `glass-panel ${className}` : "glass-panel";

  return (
    <Panel className={panelClassName} aria-labelledby={labelledBy} role={role}>
      {children}
    </Panel>
  );
};

export default GlassPanel;
