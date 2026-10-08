import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppShell } from "../app/AppShell";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("renders a visible status label and a decorative icon", () => {
    const markup = renderToStaticMarkup(<StatusBadge status="offline" label="Offline" />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-status-label="true"');
    expect(markup).toContain("Offline");
    expect(markup).toContain('data-status-icon="true"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("keeps passive statuses out of the tab order and focuses the theme control", () => {
    const badgeMarkup = renderToStaticMarkup(<StatusBadge status="offline" label="Offline" />);
    const shellMarkup = renderToStaticMarkup(<AppShell />);

    expect(badgeMarkup).not.toContain("tabindex");
    expect(shellMarkup).toContain('<button class="theme-toggle" type="button"');
    expect(shellMarkup).toContain('aria-label="Change theme, currently Auto"');
  });

  it("does not rely on color alone to communicate the state", () => {
    const markup = renderToStaticMarkup(<StatusBadge status="ready" label="Ready" />);

    expect(markup).toContain('data-status="ready"');
    expect(markup).toContain('data-status-label="true"');
    expect(markup).toContain("Ready");
    expect(markup).toContain('data-status-icon="true"');
  });
});
