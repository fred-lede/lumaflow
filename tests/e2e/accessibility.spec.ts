// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import AppShell from "../../src/app/AppShell";
import type { QueueCommandAdapter } from "../../src/features/queue/useQueueEvents";
import { SerializedJobEventSource, runRealMediaTrace } from "./harness";

const repoRoot = resolve(import.meta.dirname, "../..");
const tokenCss = readFileSync(resolve(repoRoot, "src/styles/tokens.css"), "utf8");
const glassCss = readFileSync(resolve(repoRoot, "src/styles/glass.css"), "utf8");

describe("AppShell accessibility and UI boundary", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses real DOM intake, keyboard actions, queue transitions, and output-folder action", async () => {
    const trace = runRealMediaTrace();
    const eventSource = new SerializedJobEventSource();
    const openedFolders: string[] = [];
    const mediaByPath = new Map(trace.sourceMedia.map((media) => [media.path, media]));
    const commands: Partial<QueueCommandAdapter> = {
      enqueueJobs: async () => trace.snapshots.queued,
      cancelJob: async () => trace.snapshots.cancelled,
      retryJob: async () => trace.snapshots.retried,
      openOutputFolder: async (path) => {
        openedFolders.push(path);
      },
    };

    const user = userEvent.setup();
    render(
      createElement(AppShell, {
        queueCommands: commands,
        queueEventAdapter: eventSource,
        intakeAdapter: {
          selectFiles: async () => trace.sourceMedia.map((media) => media.path),
          analyzeFiles: async (paths) => paths.map((path) => mediaByPath.get(path)!),
          registerFileDropHandler: async () => () => undefined,
        },
        selectOutputFolder: async () => trace.outputDirectory,
      }),
    );

    await user.tab();
    expect(document.activeElement?.getAttribute("href")).toBe("#main-content");
    await user.click(screen.getByRole("link", { name: "Skip to main content" }));
    expect(document.activeElement).toBe(screen.getByRole("main"));

    await user.click(screen.getByRole("button", { name: "Choose files" }));
    expect(await screen.findByRole("list", { name: "Selected source files" })).not.toBeNull();
    expect(screen.getByText("sample.mp4")).not.toBeNull();
    expect(screen.getByText("sample.mov")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Browse" }));
    expect(screen.getByDisplayValue(trace.outputDirectory)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Start conversion" }));
    const queue = await screen.findByRole("list", { name: "Conversion jobs" });
    expect(within(queue).getByText("sample.mp4")).not.toBeNull();
    expect(within(queue).getByText("sample.mov")).not.toBeNull();

    const cancelRow = queue.querySelector('[data-job-id="cancel-job"]') as HTMLElement;
    await user.click(within(cancelRow).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(within(cancelRow).getByRole("status").textContent).toContain("已取消"));

    await act(async () => {
      eventSource.replay(trace.beforeRetryEvents);
    });
    const retryRow = queue.querySelector('[data-job-id="retry-job"]') as HTMLElement;
    await waitFor(() => expect(within(retryRow).getByRole("status").textContent).toContain("失敗"));
    await user.click(within(retryRow).getByRole("button", { name: "Retry" }));
    await act(async () => {
      eventSource.replay(trace.afterRetryEvents);
    });
    await waitFor(() => expect(within(retryRow).getByRole("status").textContent).toContain("已完成"));

    await user.click(within(retryRow).getByRole("button", { name: "Open output folder" }));
    expect(openedFolders).toEqual([trace.snapshots.completed.jobs.find((job) => job.id === "retry-job")?.outputPath]);
    expect(screen.getByText(/completed\./i)).not.toBeNull();
  });

  it("supports keyboard traversal, live announcements, and focusable controls", async () => {
    const user = userEvent.setup();
    render(
      createElement(AppShell, {
        queueEventAdapter: new SerializedJobEventSource(),
        intakeAdapter: {
          selectFiles: async () => [],
          analyzeFiles: async () => [],
          registerFileDropHandler: async () => () => undefined,
        },
        selectOutputFolder: async () => null,
      }),
    );

    await user.tab();
    expect(document.activeElement?.getAttribute("href")).toBe("#main-content");
    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Change theme, currently Auto");
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Choose files");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Browse");

    const main = screen.getByRole("main");
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(main.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Browse" }));
  });

  it("retains documented text and rendering fallbacks alongside the live DOM checks", () => {
    expect(tokenCss).toContain("--font-size-body: 0.875rem");
    expect(tokenCss).toContain("--font-size-supporting: 0.75rem");
    expect(glassCss).toContain("button:focus-visible");
    expect(glassCss).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(glassCss).toContain("backdrop-filter: none");
    expect(tokenCss).toContain("@media (prefers-contrast: more)");
    expect(glassCss).toContain("@media (forced-colors: active)");
    expect(glassCss).toContain("border: 1px solid CanvasText");
  });
});
