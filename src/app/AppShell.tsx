import { useCallback, useEffect, useState } from "react";
import type { FC, MouseEvent as ReactMouseEvent } from "react";

import {
  applyTheme,
  nextThemeMode,
  themeModeLabels,
  type ThemeMode,
} from "./theme";
import DropZone from "../features/intake/DropZone";
import SourceFileList from "../features/intake/SourceFileList";
import { useFileIntake } from "../features/intake/useFileIntake";
import OutputSettings from "../features/settings/OutputSettings";
import { useConversionSettings } from "../features/settings/useConversionSettings";
import { LumaFlowError, selectOutputFolder } from "../shared/tauri";
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
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const intake = useFileIntake();
  const conversion = useConversionSettings();

  useEffect(() => {
    applyTheme(themeMode);
  }, [themeMode]);

  const handleThemeChange = useCallback(() => {
    setThemeMode((currentMode) => nextThemeMode(currentMode));
  }, []);

  const handleSelectOutputFolder = useCallback(async () => {
    try {
      const folder = await selectOutputFolder();
      if (folder) {
        conversion.setSettings({ outputDirectory: folder });
        setSettingsError(null);
      }
    } catch (error) {
      setSettingsError(LumaFlowError.from(error).message);
    }
  }, [conversion.setSettings]);

  const handleStartConversion = useCallback(async () => {
    setSettingsError(null);
    const result = await intake.start(conversion.outputSettings);
    if (result?.failed.length) {
      setSettingsError("Some files could not be queued. Review the inline errors below.");
    }
  }, [conversion.outputSettings, intake.start]);

  const readySourceCount = intake.sources.filter((source) => source.status === "ready").length;

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
          <GlassPanel className="workspace-card" labelledBy="sources-title" role="region">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Source media</p>
                <h2 id="sources-title">Files</h2>
              </div>
              <span className="card-step" aria-hidden="true">
                01
              </span>
            </div>
            <p className="supporting-text">
              Choose one or more files to inspect their format and duration before conversion.
            </p>
            <DropZone pendingCount={intake.pendingCount} onSelectFiles={() => void intake.chooseFiles()} />
            <SourceFileList sources={intake.sources} onRemove={intake.removeSource} />
          </GlassPanel>

          <GlassPanel className="workspace-card" labelledBy="settings-title" role="region">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Configuration</p>
                <h2 id="settings-title">Output settings</h2>
              </div>
              <span className="card-step" aria-hidden="true">
                02
              </span>
            </div>
            <p className="supporting-text">
              Lossless-first is the default. Expand advanced settings only when the source needs a custom stream.
            </p>
            <OutputSettings
              advancedOpen={conversion.advancedOpen}
              error={settingsError ?? intake.error}
              settings={conversion.settings}
              onChange={conversion.setSettings}
              onSelectOutputFolder={() => void handleSelectOutputFolder()}
              onToggleAdvanced={conversion.toggleAdvanced}
            />
            <div className="action-row">
              <span className="supporting-text">
                {intake.pendingCount > 0
                  ? `Analyzing ${intake.pendingCount} source${intake.pendingCount === 1 ? "" : "s"}…`
                  : readySourceCount === 0
                    ? "Add an analyzed source to begin."
                    : `${readySourceCount} source${readySourceCount === 1 ? "" : "s"} ready`}
              </span>
              <button
                className="button button--primary"
                type="button"
                disabled={!intake.canStart || conversion.settings.outputDirectory.length === 0}
                onClick={() => void handleStartConversion()}
              >
                Start conversion
              </button>
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
