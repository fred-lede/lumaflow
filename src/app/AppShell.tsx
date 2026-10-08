import { useCallback, useEffect, useState } from "react";
import type { FC, MouseEvent as ReactMouseEvent } from "react";

import {
  applyTheme,
  nextThemeMode,
  themeModeLabels,
  type ThemeMode,
} from "./theme";
import GlassPanel from "../ui/GlassPanel";
import StatusBadge from "../ui/StatusBadge";

export function handleSkipLinkActivation(
  event: Pick<ReactMouseEvent<HTMLAnchorElement>, "preventDefault" | "currentTarget">,
): void {
  event.preventDefault();
  event.currentTarget.ownerDocument.getElementById("main-content")?.focus();
}

export const AppShell: FC = () => {
  const [themeMode, setThemeMode] = useState<ThemeMode>("auto");

  useEffect(() => {
    applyTheme(themeMode);
  }, [themeMode]);

  const handleThemeChange = useCallback(() => {
    setThemeMode((currentMode) => nextThemeMode(currentMode));
  }, []);

  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#main-content" onClick={handleSkipLinkActivation}>
        Skip to main content
      </a>
      <header className="workspace-topbar">
        <div>
          <p className="eyebrow">Lossless-first media converter</p>
          <p className="brand-name">LumaFlow</p>
        </div>
        <div className="topbar-actions">
          <StatusBadge status="offline" label="Offline mode" />
          <button
            className="theme-toggle"
            type="button"
            onClick={handleThemeChange}
            aria-label={`Change theme, currently ${themeModeLabels[themeMode]}`}
          >
            <span aria-hidden="true">◐</span>
            <span>Theme: {themeModeLabels[themeMode]}</span>
          </button>
        </div>
      </header>

      <main
        id="main-content"
        className="workspace-main"
        aria-labelledby="app-title"
        tabIndex={-1}
      >
        <div className="workspace-intro">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1 id="app-title">LumaFlow</h1>
            <p className="workspace-title">Prepare your next conversion</p>
            <p className="supporting-text">
              Add media, choose an output, and review the queue before processing locally.
            </p>
          </div>
          <StatusBadge status="ready" label="Ready for files" />
        </div>

        <div className="workspace-grid">
          <GlassPanel className="workspace-card" labelledBy="settings-title" role="region">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Configuration</p>
                <h2 id="settings-title">Settings</h2>
              </div>
              <span className="card-step" aria-hidden="true">
                01
              </span>
            </div>
            <p className="supporting-text">
              Output format and quality controls will appear here when files are added.
            </p>
            <div className="empty-state">
              <span className="empty-state__icon" aria-hidden="true">
                ◌
              </span>
              <span>Waiting for source media</span>
            </div>
          </GlassPanel>

          <GlassPanel className="workspace-card" labelledBy="queue-title" role="region">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Batch processing</p>
                <h2 id="queue-title">Queue</h2>
              </div>
              <span className="card-step" aria-hidden="true">
                02
              </span>
            </div>
            <p className="supporting-text">
              Conversion progress, recovery actions, and output details will be shown here.
            </p>
            <div className="empty-state">
              <span className="empty-state__icon" aria-hidden="true">
                ≡
              </span>
              <span>No conversions queued</span>
            </div>
          </GlassPanel>
        </div>

        <div
          className="sr-only"
          id="status-announcements"
          aria-live="polite"
          aria-atomic="true"
        >
          LumaFlow is ready. Files are processed locally in offline mode.
        </div>
      </main>
    </div>
  );
};

export default AppShell;
