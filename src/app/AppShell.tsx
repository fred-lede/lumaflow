import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FC, MouseEvent as ReactMouseEvent } from "react";

import {
  applyTheme,
  nextThemeMode,
  themeModeLabels,
  type ThemeMode,
} from "./theme";
import DropZone from "../features/intake/DropZone";
import SourceFileList from "../features/intake/SourceFileList";
import { useFileIntake, type FileIntakeAdapter } from "../features/intake/useFileIntake";
import QueuePanel from "../features/queue/QueuePanel";
import { queueProgressSummary } from "../features/queue/queueLabels";
import {
  useQueueEvents,
  type QueueCommandAdapter,
  type QueueEventAdapter,
} from "../features/queue/useQueueEvents";
import OutputSettings from "../features/settings/OutputSettings";
import {
  clearOutputDirectoryPreference,
  readOutputPreferences,
  writeOutputPreferences,
} from "../features/settings/outputPreferences";
import {
  defaultConversionSettings,
  useConversionSettings,
} from "../features/settings/useConversionSettings";
import {
  LumaFlowError,
  selectOutputFolder as selectOutputFolderCommand,
  validateOutputFolder,
} from "../shared/tauri";
import GlassPanel from "../ui/GlassPanel";
import StatusBadge from "../ui/StatusBadge";
import type { QueueSnapshot } from "../domain/job";

export function handleSkipLinkActivation(
  event: Pick<ReactMouseEvent<HTMLAnchorElement>, "preventDefault" | "currentTarget">,
): void {
  event.preventDefault();
  event.currentTarget.ownerDocument.getElementById("main-content")?.focus();
}

export type AppShellProps = {
  initialQueueSnapshot?: QueueSnapshot;
  intakeAdapter?: Partial<FileIntakeAdapter>;
  queueCommands?: Partial<QueueCommandAdapter>;
  queueEventAdapter?: QueueEventAdapter;
  preferencesStorage?: Storage | null;
  selectOutputFolder?: () => Promise<string | null>;
};

export const AppShell: FC<AppShellProps> = ({
  initialQueueSnapshot,
  intakeAdapter: providedIntakeAdapter,
  queueCommands,
  queueEventAdapter,
  preferencesStorage,
  selectOutputFolder = selectOutputFolderCommand,
}) => {
  const [themeMode, setThemeMode] = useState<ThemeMode>("auto");
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [savedPreferences] = useState(() => readOutputPreferences(preferencesStorage));
  const outputDirectoryOverrideVersion = useRef(0);
  const startInFlight = useRef(false);
  const queue = useQueueEvents({
    commands: queueCommands,
    eventAdapter: queueEventAdapter,
    initialSnapshot: initialQueueSnapshot,
  });
  const intakeAdapter = useMemo(
    () => ({
      ...providedIntakeAdapter,
      enqueueJobs: queue.controller.enqueueJobs,
    }),
    [providedIntakeAdapter, queue.controller],
  );
  const intake = useFileIntake({ adapter: intakeAdapter });
  const conversion = useConversionSettings({
    format: savedPreferences?.format ?? defaultConversionSettings.format,
  });

  useEffect(() => {
    let cancelled = false;
    const hydrationVersion = outputDirectoryOverrideVersion.current;

    const hydratePreferences = async (): Promise<void> => {
      if (!savedPreferences?.outputDirectory) {
        if (!cancelled) {
          setPreferencesReady(true);
        }
        return;
      }

      try {
        const normalizedDirectory = await validateOutputFolder(savedPreferences.outputDirectory);
        if (!cancelled && outputDirectoryOverrideVersion.current === hydrationVersion) {
          conversion.setSettings({ outputDirectory: normalizedDirectory });
        }
      } catch {
        if (!cancelled && outputDirectoryOverrideVersion.current === hydrationVersion) {
          clearOutputDirectoryPreference(preferencesStorage);
        }
      } finally {
        if (!cancelled) {
          setPreferencesReady(true);
        }
      }
    };

    void hydratePreferences();
    return () => {
      cancelled = true;
    };
  }, [conversion.setSettings, preferencesStorage, savedPreferences]);

  useEffect(() => {
    if (!preferencesReady) {
      return;
    }

    writeOutputPreferences(
      {
        outputDirectory: conversion.settings.outputDirectory,
        format: conversion.settings.format,
      },
      preferencesStorage,
    );
  }, [conversion.settings.format, conversion.settings.outputDirectory, preferencesReady, preferencesStorage]);

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
        outputDirectoryOverrideVersion.current += 1;
        conversion.setSettings({ outputDirectory: folder });
        setSettingsError(null);
      }
    } catch (error) {
      setSettingsError(LumaFlowError.from(error).message);
    }
  }, [conversion.setSettings, selectOutputFolder]);

  const handleStartConversion = useCallback(async () => {
    if (startInFlight.current) {
      return;
    }

    startInFlight.current = true;
    setStartPending(true);
    try {
      setSettingsError(null);
      const preflightVersion = outputDirectoryOverrideVersion.current;
      const settingsAtPreflight = conversion.outputSettings;
      let normalizedOutputDirectory: string;
      try {
        normalizedOutputDirectory = await validateOutputFolder(settingsAtPreflight.outputDirectory);
      } catch {
        if (outputDirectoryOverrideVersion.current !== preflightVersion) {
          setSettingsError("The output folder changed. Start conversion again.");
          return;
        }
        conversion.setSettings({ outputDirectory: "" });
        clearOutputDirectoryPreference(preferencesStorage);
        setSettingsError("The output folder is no longer available. Choose a new destination folder.");
        return;
      }

      if (outputDirectoryOverrideVersion.current !== preflightVersion) {
        setSettingsError("The output folder changed. Start conversion again.");
        return;
      }

      conversion.setSettings({ outputDirectory: normalizedOutputDirectory });
      const result = await intake.start({
        ...settingsAtPreflight,
        outputDirectory: normalizedOutputDirectory,
      });
      if (outputDirectoryOverrideVersion.current !== preflightVersion) {
        setSettingsError("The output folder changed. Start conversion again.");
        return;
      }
      if (result?.failed.length) {
        const outputDirectoryUnavailable = result.failed.some(
          ({ code }) => code === "output_directory_not_found" || code === "output_directory_not_directory",
        );
        if (outputDirectoryUnavailable) {
          clearOutputDirectoryPreference(preferencesStorage);
          conversion.setSettings({ outputDirectory: "" });
          setSettingsError("The output folder is no longer available. Choose a new destination folder.");
        } else {
          setSettingsError("Some files could not be queued. Review the inline errors below.");
        }
      }
    } finally {
      startInFlight.current = false;
      setStartPending(false);
    }
  }, [conversion.outputSettings, conversion.setSettings, intake.start, preferencesStorage]);

  const queueJobs = queue.state.order
    .map((jobId) => queue.state.jobsById[jobId])
    .filter((job): job is NonNullable<typeof job> => job !== undefined);
  const progressSummary = queueProgressSummary(queueJobs, { paused: queue.state.paused });

  const readySourceCount = intake.sources.filter((source) => source.status === "ready").length;

  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#main-content" onClick={handleSkipLinkActivation}>
        Skip to main content
      </a>
      <header className="workspace-topbar">
        <div>
          <p className="brand-name">LumaFlow</p>
        </div>
        <div className="topbar-actions">
          <StatusBadge status="offline" label="Offline mode" />
          {progressSummary ? (
            <p className="topbar-progress">
              <span aria-hidden="true">↻</span>
              <span>{progressSummary}</span>
            </p>
          ) : null}
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
            <h1 id="app-title" className="workspace-title">
              Convert your media
            </h1>
            <p className="supporting-text">
              Add files, choose an output, and review the queue before processing locally.
            </p>
          </div>
          <StatusBadge status="ready" label="Ready for files" />
        </div>

        <div className="workspace-layout">
          <div className="workspace-source-column">
            <GlassPanel className="workspace-card workspace-source-card" labelledBy="sources-title" role="region">
              <div className="card-heading">
                <div>
                  <p className="eyebrow">Source media</p>
                  <h2 id="sources-title">Files</h2>
                </div>
              </div>
              <p className="supporting-text">
                Choose one or more files to inspect their format and duration before conversion.
              </p>
              <DropZone pendingCount={intake.pendingCount} onSelectFiles={() => void intake.chooseFiles()} />
              <SourceFileList sources={intake.sources} onRemove={intake.removeSource} />
            </GlassPanel>
          </div>

          <div className="workspace-settings-column">
            <GlassPanel
              className="workspace-card workspace-card--settings workspace-settings-card"
              labelledBy="settings-title"
              role="region"
            >
              <div className="card-heading">
                <div>
                  <p className="eyebrow">Configuration</p>
                  <h2 id="settings-title">Output settings</h2>
                </div>
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
                  disabled={
                    !preferencesReady ||
                    startPending ||
                    !intake.canStart ||
                    conversion.settings.outputDirectory.length === 0
                  }
                  onClick={() => void handleStartConversion()}
                >
                  Start conversion
                </button>
              </div>
            </GlassPanel>
          </div>

          <QueuePanel controller={queue.controller} />
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
