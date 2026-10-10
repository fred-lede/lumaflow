// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import AppShell, { handleSkipLinkActivation } from "./AppShell";
import type { MediaInfo, OutputSettings } from "../domain/media";
import {
  preferencesStorageKey,
  readOutputPreferences,
} from "../features/settings/outputPreferences";

const validateOutputFolderMock = vi.hoisted(() => vi.fn());

vi.mock("../shared/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/tauri")>();
  return { ...actual, validateOutputFolder: validateOutputFolderMock };
});

const testAppShellProps = {
  intakeAdapter: {
    registerFileDropHandler: async () => () => undefined,
  },
  queueEventAdapter: {
    listen: async () => () => undefined,
  },
};

function createStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

let storage: Storage;

function mediaInfo(path: string): MediaInfo {
  return {
    path,
    fileName: path.split("/").pop() ?? path,
    container: "mp4",
    durationSeconds: 1,
    sizeBytes: 1,
    sourceQuality: {
      status: "unknown",
      summary: "Unknown source quality",
      evidence: [],
    },
    videoStreams: [],
    audioStreams: [],
    subtitleStreams: [],
  };
}

const defaultSettingsForTest: OutputSettings = {
  outputDirectory: "",
  format: "mp3",
  quality: "original",
  losslessFirst: true,
  codec: null,
  bitrateKbps: null,
  width: null,
  height: null,
  frameRate: null,
  sampleRateHz: null,
  channels: null,
};

beforeEach(() => {
  storage = createStorage();
  validateOutputFolderMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("App", () => {
  it("renders a root landmark with an accessible heading", () => {
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(<App />);

    const heading = root.querySelector("h1#app-title");
    const main = root.querySelector("main#main-content");
    const skipLink = root.querySelector("a.skip-link");
    const introSupportingText = root.querySelector(".workspace-intro .supporting-text");
    const layouts = root.querySelectorAll(".workspace-layout");
    const sourceColumn = root.querySelector(".workspace-source-column");
    const queuePanel = root.querySelector(".queue-panel");
    const settingsColumn = root.querySelector(".workspace-settings-column");

    expect(heading?.getAttribute("id")).toBe("app-title");
    expect(heading?.classList.contains("workspace-title")).toBe(true);
    expect(heading?.textContent).toBe("Convert your media");
    expect(main?.classList.contains("workspace-main")).toBe(true);
    expect(main?.getAttribute("aria-labelledby")).toBe("app-title");
    expect(main?.getAttribute("tabindex")).toBe("-1");
    expect(skipLink?.classList.contains("skip-link")).toBe(true);
    expect(skipLink?.getAttribute("href")).toBe("#main-content");
    expect(skipLink?.textContent).toBe("Skip to main content");
    expect(introSupportingText?.textContent).toBe(
      "Add files, choose an output, and review the queue before processing locally.",
    );
    expect(root.querySelector('[role="note"]')).toBeNull();
    expect(layouts).toHaveLength(1);
    expect(sourceColumn?.classList.contains("workspace-source-column")).toBe(true);
    expect(settingsColumn?.classList.contains("workspace-settings-column")).toBe(true);
    expect(sourceColumn?.querySelector(".workspace-card:not(.workspace-card--settings)")).not.toBeNull();
    expect(sourceColumn?.querySelector(".workspace-source-card")).not.toBeNull();
    expect(sourceColumn?.querySelectorAll(".queue-panel")).toHaveLength(0);
    expect(settingsColumn?.querySelector(".workspace-card--settings.workspace-settings-card")).not.toBeNull();

    const layout = layouts[0];
    if (!layout || !sourceColumn || !queuePanel || !settingsColumn) {
      throw new Error("Expected the workspace layout columns and queue panel to be rendered.");
    }

    const layoutChildren = Array.from(layout.children);
    expect(layoutChildren.indexOf(sourceColumn)).toBeLessThan(layoutChildren.indexOf(settingsColumn));
    expect(layoutChildren.indexOf(settingsColumn)).toBeLessThan(layoutChildren.indexOf(queuePanel));
    expect(queuePanel.parentElement).toBe(layout);
  });

  it("focuses the main landmark when the skip link is activated", () => {
    let defaultPrevented = false;
    let focused = false;
    const event = {
      preventDefault: () => {
        defaultPrevented = true;
      },
      currentTarget: {
        ownerDocument: {
          getElementById: (id: string) =>
            id === "main-content" ? { focus: () => (focused = true) } : null,
        },
      },
    } as unknown as Parameters<typeof handleSkipLinkActivation>[0];

    handleSkipLinkActivation(event);

    expect(defaultPrevented).toBe(true);
    expect(focused).toBe(true);
  });

  it("clears an unavailable saved folder while retaining the saved format", async () => {
    storage.setItem(
      preferencesStorageKey,
      JSON.stringify({ outputDirectory: "/removed", format: "mp3" }),
    );
    validateOutputFolderMock.mockRejectedValue({
      code: "output_directory_not_found",
      message: "The output folder does not exist",
    });

    render(<AppShell {...testAppShellProps} preferencesStorage={storage} />);

    await waitFor(() => expect(validateOutputFolderMock).toHaveBeenCalledWith("/removed"));
    await waitFor(() => {
      expect((screen.getByPlaceholderText("Choose a destination folder") as HTMLInputElement).value).toBe("");
      expect((screen.getByLabelText("Format") as HTMLSelectElement).value).toBe("mp3");
      expect((screen.getByRole("button", { name: "Start conversion" }) as HTMLButtonElement).disabled).toBe(true);
    });

    expect(readOutputPreferences(storage)).toEqual({ outputDirectory: "", format: "mp3" });
  });

  it("hydrates a valid saved folder without changing its saved format", async () => {
    storage.setItem(
      preferencesStorageKey,
      JSON.stringify({ outputDirectory: "/saved", format: "mp3" }),
    );
    validateOutputFolderMock.mockResolvedValue("/exports");

    render(<AppShell {...testAppShellProps} preferencesStorage={storage} />);

    await waitFor(() => {
      expect((screen.getByPlaceholderText("Choose a destination folder") as HTMLInputElement).value).toBe("/exports");
      expect((screen.getByLabelText("Format") as HTMLSelectElement).value).toBe("mp3");
    });
    expect(validateOutputFolderMock).toHaveBeenCalledWith("/saved");
  });

  it("keeps a newly browsed folder when saved-folder validation resolves later", async () => {
    let resolveValidation: ((path: string) => void) | undefined;
    const pendingValidation = new Promise<string>((resolve) => {
      resolveValidation = resolve;
    });
    storage.setItem(
      preferencesStorageKey,
      JSON.stringify({ outputDirectory: "/old", format: "mp3" }),
    );
    validateOutputFolderMock.mockReturnValue(pendingValidation);

    render(
      <AppShell
        {...testAppShellProps}
        preferencesStorage={storage}
        selectOutputFolder={async () => "/new"}
      />,
    );

    await waitFor(() => expect(validateOutputFolderMock).toHaveBeenCalledWith("/old"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    });
    expect((screen.getByPlaceholderText("Choose a destination folder") as HTMLInputElement).value).toBe("/new");

    await act(async () => {
      resolveValidation?.("/normalized-old");
      await pendingValidation;
    });

    await waitFor(() => {
      expect((screen.getByPlaceholderText("Choose a destination folder") as HTMLInputElement).value).toBe("/new");
    });
    expect(readOutputPreferences(storage)).toEqual({ outputDirectory: "/new", format: "mp3" });
  });

  it("does not enqueue with a stale preflight path after Browse changes the folder", async () => {
    let resolvePreflight: ((path: string) => void) | undefined;
    const pendingPreflight = new Promise<string>((resolve) => {
      resolvePreflight = resolve;
    });
    const selectOutputFolder = vi.fn()
      .mockResolvedValueOnce("/old")
      .mockResolvedValueOnce("/new");
    const enqueueJobs = vi.fn(async () => ({ revision: 1, jobs: [], paused: false }));
    validateOutputFolderMock.mockReturnValue(pendingPreflight);

    render(
      <AppShell
        {...testAppShellProps}
        intakeAdapter={{
          ...testAppShellProps.intakeAdapter,
          selectFiles: async () => ["/source.mp4"],
          analyzeFiles: async (paths) => [mediaInfo(paths[0] ?? "/source.mp4")],
        }}
        preferencesStorage={storage}
        queueCommands={{ enqueueJobs }}
        selectOutputFolder={selectOutputFolder}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Start conversion" }) as HTMLButtonElement).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start conversion" }));
    });
    await waitFor(() => expect(validateOutputFolderMock).toHaveBeenCalledWith("/old"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    });
    expect((screen.getByPlaceholderText("Choose a destination folder") as HTMLInputElement).value).toBe("/new");

    await act(async () => {
      resolvePreflight?.("/normalized-old");
      await pendingPreflight;
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("The output folder changed. Start conversion again.");
    });
    expect(enqueueJobs).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText("Choose a destination folder") as HTMLInputElement).value).toBe("/new");
    expect(readOutputPreferences(storage)).toEqual({ outputDirectory: "/new", format: "mp3" });
  });

  it("clears the active and persisted folder when the Start preflight rejects", async () => {
    storage.setItem(
      preferencesStorageKey,
      JSON.stringify({ outputDirectory: "", format: "mp3" }),
    );
    const enqueueJobs = vi.fn(async () => ({ revision: 1, jobs: [], paused: false }));
    validateOutputFolderMock.mockRejectedValue({
      code: "output_directory_not_found",
      message: "The output folder does not exist",
    });

    render(
      <AppShell
        {...testAppShellProps}
        intakeAdapter={{
          ...testAppShellProps.intakeAdapter,
          selectFiles: async () => ["/source.mp4"],
          analyzeFiles: async (paths) => [mediaInfo(paths[0] ?? "/source.mp4")],
        }}
        preferencesStorage={storage}
        queueCommands={{ enqueueJobs }}
        selectOutputFolder={async () => "/old"}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse" }));
      fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Start conversion" }) as HTMLButtonElement).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start conversion" }));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "The output folder is no longer available. Choose a new destination folder.",
      );
    });
    expect((screen.getByPlaceholderText("Choose a destination folder") as HTMLInputElement).value).toBe("");
    expect(readOutputPreferences(storage)).toEqual({ outputDirectory: "", format: "mp3" });
    expect(enqueueJobs).not.toHaveBeenCalled();
  });

  it("clears the folder when enqueue rejects after a successful output preflight", async () => {
    const enqueueJobs = vi.fn().mockRejectedValue({
      code: "output_directory_not_found",
      message: "The output directory does not exist",
    });
    validateOutputFolderMock.mockResolvedValue("/normalized");

    render(
      <AppShell
        {...testAppShellProps}
        intakeAdapter={{
          ...testAppShellProps.intakeAdapter,
          selectFiles: async () => ["/source.mp4"],
          analyzeFiles: async (paths) => [mediaInfo(paths[0] ?? "/source.mp4")],
        }}
        preferencesStorage={storage}
        queueCommands={{ enqueueJobs }}
        selectOutputFolder={async () => "/selected"}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse" }));
      fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Start conversion" }) as HTMLButtonElement).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start conversion" }));
    });

    await waitFor(() => {
      expect(screen.getByText("The output folder is no longer available. Choose a new destination folder.")).toBeTruthy();
    });
    expect(screen.queryByText("Some files could not be queued. Review the inline errors below.")).toBeNull();
    expect((screen.getByPlaceholderText("Choose a destination folder") as HTMLInputElement).value).toBe("");
    expect(readOutputPreferences(storage)).toEqual({ outputDirectory: "", format: "mp3" });
    expect(screen.getByText("The output directory does not exist")).toBeTruthy();
    expect(enqueueJobs).toHaveBeenCalledOnce();
  });

  it("keeps a newly browsed folder when an older enqueue result rejects", async () => {
    let rejectEnqueue: ((error: unknown) => void) | undefined;
    const pendingEnqueue = new Promise<never>((_, reject) => {
      rejectEnqueue = reject;
    });
    const enqueueJobs = vi.fn(() => pendingEnqueue);
    const selectOutputFolder = vi.fn()
      .mockResolvedValueOnce("/old")
      .mockResolvedValueOnce("/new");
    validateOutputFolderMock.mockResolvedValue("/normalized");

    render(
      <AppShell
        {...testAppShellProps}
        intakeAdapter={{
          ...testAppShellProps.intakeAdapter,
          selectFiles: async () => ["/source.mp4"],
          analyzeFiles: async (paths) => [mediaInfo(paths[0] ?? "/source.mp4")],
        }}
        preferencesStorage={storage}
        queueCommands={{ enqueueJobs }}
        selectOutputFolder={selectOutputFolder}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse" }));
      fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Start conversion" }) as HTMLButtonElement).disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start conversion" }));
    });
    await waitFor(() => expect(enqueueJobs).toHaveBeenCalledOnce());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    });
    await waitFor(() => {
      expect((screen.getByPlaceholderText("Choose a destination folder") as HTMLInputElement).value).toBe("/new");
      expect(readOutputPreferences(storage)).toEqual({ outputDirectory: "/new", format: "mp3" });
    });

    await act(async () => {
      rejectEnqueue?.({
        code: "output_directory_not_found",
        message: "The output directory does not exist",
      });
      await pendingEnqueue.catch(() => undefined);
    });

    await waitFor(() => {
      expect(screen.getByText("The output folder changed. Start conversion again.")).toBeTruthy();
    });
    expect((screen.getByPlaceholderText("Choose a destination folder") as HTMLInputElement).value).toBe("/new");
    expect(readOutputPreferences(storage)).toEqual({ outputDirectory: "/new", format: "mp3" });
  });

  it("enqueues with the normalized folder while preserving all output settings", async () => {
    const enqueueJobs = vi.fn(async () => ({ revision: 1, jobs: [], paused: false }));
    validateOutputFolderMock.mockResolvedValue("/normalized");

    render(
      <AppShell
        {...testAppShellProps}
        intakeAdapter={{
          ...testAppShellProps.intakeAdapter,
          selectFiles: async () => ["/source.mp4"],
          analyzeFiles: async (paths) => [mediaInfo(paths[0] ?? "/source.mp4")],
        }}
        preferencesStorage={storage}
        queueCommands={{ enqueueJobs }}
        selectOutputFolder={async () => "/selected"}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse" }));
      fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    });
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "mp4" } });
    fireEvent.change(screen.getByLabelText("Processing mode"), { target: { value: "transcode" } });
    fireEvent.click(screen.getByRole("radio", { name: /High/ }));
    fireEvent.click(screen.getByRole("button", { name: /Advanced settings/ }));
    fireEvent.change(screen.getByLabelText("Codec"), { target: { value: "libx264" } });
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "1920" } });
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "1080" } });
    fireEvent.change(screen.getByLabelText("Frame rate"), { target: { value: "30/1" } });
    fireEvent.change(screen.getByLabelText("Audio bitrate"), { target: { value: "320" } });
    fireEvent.change(screen.getByLabelText("Sample rate (Hz)"), { target: { value: "48000" } });
    fireEvent.change(screen.getByLabelText("Channels"), { target: { value: "2" } });

    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Start conversion" }) as HTMLButtonElement).disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start conversion" }));
    });

    await waitFor(() => expect(enqueueJobs).toHaveBeenCalledOnce());
    expect(enqueueJobs).toHaveBeenCalledWith([
      expect.objectContaining({
        outputSettings: {
          outputDirectory: "/normalized",
          format: "mp4",
          quality: "high",
          losslessFirst: false,
          codec: "libx264",
          bitrateKbps: 320,
          width: 1920,
          height: 1080,
          frameRate: "30/1",
          sampleRateHz: 48000,
          channels: 2,
        },
      }),
    ]);
  });

  it("disables Start and deduplicates preflight while validation is pending", async () => {
    let resolvePreflight: ((path: string) => void) | undefined;
    const pendingPreflight = new Promise<string>((resolve) => {
      resolvePreflight = resolve;
    });
    const enqueueJobs = vi.fn(async () => ({ revision: 1, jobs: [], paused: false }));
    const validateOutputFolder = validateOutputFolderMock.mockReturnValue(pendingPreflight);

    render(
      <AppShell
        {...testAppShellProps}
        intakeAdapter={{
          ...testAppShellProps.intakeAdapter,
          selectFiles: async () => ["/source.mp4"],
          analyzeFiles: async (paths) => [mediaInfo(paths[0] ?? "/source.mp4")],
        }}
        preferencesStorage={storage}
        queueCommands={{ enqueueJobs }}
        selectOutputFolder={async () => "/selected"}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse" }));
      fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Start conversion" }) as HTMLButtonElement).disabled).toBe(false);
    });

    const startButton = screen.getByRole("button", { name: "Start conversion" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(startButton);
    });
    await waitFor(() => expect(validateOutputFolder).toHaveBeenCalledTimes(1));
    expect(startButton.disabled).toBe(true);

    fireEvent.click(startButton);
    expect(validateOutputFolder).toHaveBeenCalledTimes(1);
    expect(enqueueJobs).not.toHaveBeenCalled();

    await act(async () => {
      resolvePreflight?.("/normalized");
      await pendingPreflight;
    });
    await waitFor(() => expect(enqueueJobs).toHaveBeenCalledOnce());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Start conversion" }) as HTMLButtonElement).disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start conversion" }));
    });
    await waitFor(() => expect(validateOutputFolder).toHaveBeenCalledTimes(2));
  });

  it("keeps the queue out of the source column for a long file name", () => {
    const longName = `${"x".repeat(300)}.mp4`;
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(
      <AppShell
        {...testAppShellProps}
        initialQueueSnapshot={{
          revision: 1,
          paused: false,
          jobs: [
            {
              id: "j1",
              sourcePath: `/src/${longName}`,
              media: mediaInfo(`/src/${longName}`),
              outputSettings: defaultSettingsForTest,
              processingKind: null,
              attempt: 1,
              state: { kind: "queued", label: "Queued" },
              progress: 0,
              outputPath: null,
            },
          ],
        }}
      />,
    );

    const queuePanel = root.querySelector(".queue-panel");
    expect(queuePanel).not.toBeNull();
    expect(queuePanel?.closest(".workspace-source-column")).toBeNull();
  });
});
