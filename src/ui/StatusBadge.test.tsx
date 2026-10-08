import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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

  it("provides a keyboard focus target for the shared visible focus ring", () => {
    const markup = renderToStaticMarkup(<StatusBadge status="offline" label="Offline" />);

    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('class="status-badge status-badge--offline"');
  });

  it("does not rely on color alone to communicate the state", () => {
    const markup = renderToStaticMarkup(<StatusBadge status="ready" label="Ready" />);

    expect(markup).toContain('data-status="ready"');
    expect(markup).toContain('data-status-label="true"');
    expect(markup).toContain("Ready");
    expect(markup).toContain('data-status-icon="true"');
  });
});
