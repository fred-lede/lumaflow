// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { handleSkipLinkActivation } from "./AppShell";

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
    expect(sourceColumn?.querySelectorAll(".queue-panel")).toHaveLength(1);
    expect(settingsColumn?.querySelector(".workspace-card--settings")).not.toBeNull();

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
});
