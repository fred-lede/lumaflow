import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const css = readFileSync(join(repoRoot, "src/styles/glass.css"), "utf8");

describe("glass styling", () => {
  it("defines motion transitions on the interactive selectors", () => {
    for (const sel of [
      ".button",
      ".theme-toggle",
      ".icon-button",
      ".preset-option",
      ".drop-zone",
      ".source-list__item",
      ".queue-row",
      ".advanced-toggle",
    ]) {
      expect(css, `${sel} should exist`).toContain(`${sel} {`);
    }
    expect(
      css.match(/var\(--motion-base\) var\(--ease-standard\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(1);
    expect(css).toContain("transition:");
  });

  it("disables motion under prefers-reduced-motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("transition-duration: 0.01ms !important");
  });

  it("adopts the pill radius token instead of a hardcoded 999px", () => {
    expect(css).not.toContain("border-radius: 999px");
    expect(css.match(/var\(--radius-pill\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("gives the drop zone a hover affordance", () => {
    expect(css).toContain(".drop-zone:hover");
  });

  it("lifts the primary button on hover without a margin change", () => {
    expect(css).toContain(".button--primary:hover:not(:disabled)");
    expect(css).toContain("translateY(-1px)");
  });

  it("removes the dead h1 rule that .workspace-title overrides", () => {
    expect(css).not.toMatch(/\nh1 \{/);
  });

  it("stops forcing a 20rem card height", () => {
    expect(css).not.toContain("min-height: 20rem");
  });

  it("spans the queue across the full desktop row", () => {
    expect(css).toContain("queue  queue");
    expect(css).not.toContain('"queue ."');
  });

  it("drops the card step class and provides a queue-count value class", () => {
    expect(css).not.toContain(".card-step");
    expect(css).toContain(".queue-count__value");
  });

  it("keeps long queue labels from forcing horizontal overflow", () => {
    const rowBlock = css.slice(css.indexOf(".queue-row {"), css.indexOf(".queue-row__main {"));
    expect(rowBlock).toContain("min-width: 0");
    expect(css).toMatch(/\.queue-row__title strong \{[^}]*text-overflow: ellipsis/);
  });

  it("assigns the queue to the full-width grid area now that it is a layout child", () => {
    expect(css).toContain(".workspace-layout > .queue-panel");
    expect(css).not.toContain(".workspace-source-column > .queue-panel");
    expect(css).not.toContain(".workspace-source-column .queue-panel");
  });

  it("lets workspace cards size to their content instead of stretching", () => {
    const start = css.indexOf("@media (min-width: 52rem)");
    const end = css.indexOf("@media", start + 10);
    const block = css.slice(start, end > -1 ? end : undefined);
    expect(block).toContain("align-items: start");
    expect(block).not.toContain("align-items: stretch");
  });

  it("keeps every box-shadow token-derived so prefers-contrast can suppress it", () => {
    const declarations = [...css.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(declarations.length).toBeGreaterThan(0);
    for (const value of declarations) {
      expect(
        value === "none" || value.startsWith("var(--shadow-"),
        `literal box-shadow cannot be suppressed by prefers-contrast: ${value}`,
      ).toBe(true);
    }
  });
});
