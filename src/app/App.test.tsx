import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { handleSkipLinkActivation } from "./AppShell";

describe("App", () => {
  it("renders a root landmark with an accessible heading", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('aria-labelledby="app-title"');
    expect(markup).toContain('<h1 id="app-title">LumaFlow</h1>');
    expect(markup).toContain('<a class="skip-link" href="#main-content">Skip to main content</a>');
    expect(markup).toContain('<main id="main-content" class="workspace-main" aria-labelledby="app-title" tabindex="-1">');
    expect(markup).not.toContain('role="note"');
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
