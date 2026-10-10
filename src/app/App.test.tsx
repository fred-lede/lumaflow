// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import AppShell, { handleSkipLinkActivation } from "./AppShell";
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
    expect(sourceColumn?.querySelectorAll(".queue-panel")).toHaveLength(1);
    expect(settingsColumn?.querySelector(".workspace-card--settings.workspace-settings-card")).not.toBeNull();

    const layout = layouts[0];
    if (!layout || !sourceColumn || !queuePanel || !settingsColumn) {
      throw new Error("Expected the workspace layout columns and queue panel to be rendered.");
    }

    const layoutChildren = Array.from(layout.children);
    expect(layoutChildren.indexOf(sourceColumn)).toBeLessThan(layoutChildren.indexOf(settingsColumn));
    const workspaceOrder = Array.from(
      layout.querySelectorAll(".workspace-source-column, .queue-panel, .workspace-settings-column"),
    );
    expect(workspaceOrder.indexOf(queuePanel)).toBeLessThan(workspaceOrder.indexOf(settingsColumn));
    expect(queuePanel.parentElement).toBe(sourceColumn);
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
});
