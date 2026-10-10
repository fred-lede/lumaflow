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
    expect(css.match(/var\(--radius-pill\)/g)?.length ?? 0).toBe(3);
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
});
