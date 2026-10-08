// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import AppShell from "../../src/app/AppShell";
import { SerializedJobEventSource, runRealMediaTrace } from "./harness";

const repoRoot = resolve(import.meta.dirname, "../..");
const tokenCss = readFileSync(resolve(repoRoot, "src/styles/tokens.css"), "utf8");
const glassCss = readFileSync(resolve(repoRoot, "src/styles/glass.css"), "utf8");

describe("AppShell accessibility and UI boundary", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the real AppShell from the Rust trace and drives renderer keyboard/focus boundaries", async () => {
    const trace = runRealMediaTrace();
    const eventSource = new SerializedJobEventSource();

    const user = userEvent.setup();
    render(
      createElement(AppShell, {
        initialQueueSnapshot: trace.snapshots.queued,
        queueEventAdapter: eventSource,
      }),
    );

    await user.tab();
    expect(document.activeElement?.getAttribute("href")).toBe("#main-content");
    await user.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Change theme, currently Auto");
    await user.keyboard("[Enter]");
    await user.keyboard("[Space]");
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/Change theme, currently/);
    await user.click(screen.getByRole("link", { name: "Skip to main content" }));
    expect(document.activeElement).toBe(screen.getByRole("main"));
    const queue = await screen.findByRole("list", { name: "Conversion jobs" });
    expect(within(queue).getByText("sample.mp4")).not.toBeNull();
    expect(within(queue).getByText("sample.mov")).not.toBeNull();

    await act(async () => {
      eventSource.replay(trace.beforeRetryEvents);
    });
    const retryRow = queue.querySelector('[data-job-id="retry-job"]') as HTMLElement;
    await waitFor(() => expect(within(retryRow).getByRole("status").textContent).toContain("失敗"));
    await act(async () => {
      eventSource.replay(trace.afterRetryEvents);
    });
    await waitFor(() => expect(within(retryRow).getByRole("status").textContent).toContain("已完成"));

    expect(screen.getByText(/completed\./i)).not.toBeNull();
  }, 30000);

  it("supports keyboard traversal, live announcements, and focusable controls", async () => {
    const user = userEvent.setup();
    render(
      createElement(AppShell, {
        initialQueueSnapshot: { revision: 0, jobs: [], paused: false },
        queueEventAdapter: new SerializedJobEventSource(),
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
