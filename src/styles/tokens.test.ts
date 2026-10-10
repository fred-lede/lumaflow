import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "tokens.css"), "utf8");

describe("design tokens", () => {
  it("uses the tightened radius scale", () => {
    expect(css).toContain("--radius-sm: 0.5rem");
    expect(css).toContain("--radius-md: 0.75rem");
    expect(css).toContain("--radius-lg: 1rem");
    expect(css).toContain("--radius-pill: 999px");
  });

  it("defines motion tokens and a decelerate easing curve", () => {
    expect(css).toContain("--motion-fast: 120ms");
    expect(css).toContain("--motion-base: 180ms");
    expect(css).toContain("--motion-slow: 260ms");
    expect(css).toContain("--ease-standard: cubic-bezier(0.22, 1, 0.36, 1)");
  });

  it("defines a raised elevation token", () => {
    expect(css).toContain("--shadow-raised: 0 0.5rem 1.5rem rgba(35, 61, 93, 0.08)");
  });

  it("defines the raised elevation token in both dark theme blocks", () => {
    const matches =
      css.match(/--shadow-raised: 0 0\.5rem 1\.5rem rgba\(0, 0, 0, 0\.3\)/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it("removes every shadow under prefers-contrast: more", () => {
    const contrastBlock = css.slice(css.indexOf("@media (prefers-contrast: more)"));
    expect(contrastBlock).toContain("--shadow-panel: none");
    expect(contrastBlock).toContain("--shadow-raised: none");
  });
});
