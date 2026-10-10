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
});
