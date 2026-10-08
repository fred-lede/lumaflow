import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { App } from "../../src/app/App";

const repoRoot = resolve(import.meta.dirname, "../..");
const tokenCss = readFileSync(resolve(repoRoot, "src/styles/tokens.css"), "utf8");
const glassCss = readFileSync(resolve(repoRoot, "src/styles/glass.css"), "utf8");

describe("accessibility boundary", () => {
  const markup = renderToStaticMarkup(createElement(App));

  it("provides a keyboard entry point, semantic controls, and visible focus styling", () => {
    expect(markup.indexOf('class="skip-link"')).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf('class="skip-link"')).toBeLessThan(markup.indexOf('id="main-content"'));
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain("<select");
    expect(markup).toContain("<input");
    expect(glassCss).toContain("button:focus-visible");
    expect(glassCss).toContain("outline: var(--focus-ring-width) solid var(--color-focus)");
  });

  it("keeps body and supporting text at the documented minimum sizes", () => {
    expect(tokenCss).toContain("--font-size-body: 0.875rem");
    expect(tokenCss).toContain("--font-size-supporting: 0.75rem");
    expect(glassCss).toContain("font-size: var(--font-size-body)");
    expect(glassCss).toContain("font-size: var(--font-size-supporting)");
  });

  it("exposes live announcements for the shell and queue", () => {
    expect(markup).toContain('id="status-announcements"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('data-announcement-sequence="0"');
    expect(markup).toContain('aria-atomic="true"');
  });

  it("provides reduced-transparency and high-contrast rendering fallbacks", () => {
    expect(glassCss).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(glassCss).toContain("backdrop-filter: none");
    expect(tokenCss).toContain("@media (prefers-contrast: more)");
    expect(glassCss).toContain("@media (forced-colors: active)");
    expect(glassCss).toContain("border: 1px solid CanvasText");
  });
});
