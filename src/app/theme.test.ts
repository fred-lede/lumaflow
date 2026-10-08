import { describe, expect, it } from "vitest";

import {
  applyTheme,
  colorSchemeForTheme,
  nextThemeMode,
  type ThemeMode,
} from "./theme";

function createRoot(): HTMLElement {
  return {
    dataset: {},
    style: { colorScheme: "" },
  } as unknown as HTMLElement;
}

describe("theme mode behavior", () => {
  it("cycles through auto, light, and dark modes", () => {
    const modes: ThemeMode[] = ["auto", "light", "dark"];

    expect(modes.map(nextThemeMode)).toEqual(["light", "dark", "auto"]);
  });

  it("maps auto to both system color schemes and explicit modes to one scheme", () => {
    expect(colorSchemeForTheme("auto")).toBe("light dark");
    expect(colorSchemeForTheme("light")).toBe("light");
    expect(colorSchemeForTheme("dark")).toBe("dark");
  });

  it("applies the selected mode to the document root", () => {
    const root = createRoot();

    applyTheme("dark", root);

    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("keeps auto mode delegated to the system", () => {
    const root = createRoot();

    applyTheme("auto", root);

    expect(root.dataset.theme).toBe("auto");
    expect(root.style.colorScheme).toBe("light dark");
  });
});
