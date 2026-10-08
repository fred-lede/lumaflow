export type ThemeMode = "auto" | "light" | "dark";

export const themeModes: readonly ThemeMode[] = ["auto", "light", "dark"];

export const themeModeLabels: Record<ThemeMode, string> = {
  auto: "Auto",
  light: "Light",
  dark: "Dark",
};

export type ThemeColorScheme = "light" | "dark" | "light dark";

export function nextThemeMode(mode: ThemeMode): ThemeMode {
  const currentIndex = themeModes.indexOf(mode);
  const nextIndex = (currentIndex + 1) % themeModes.length;

  return themeModes[nextIndex] ?? "auto";
}

export function colorSchemeForTheme(mode: ThemeMode): ThemeColorScheme {
  return mode === "auto" ? "light dark" : mode;
}

export function applyTheme(
  mode: ThemeMode,
  root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement,
): void {
  if (!root) {
    return;
  }

  root.dataset.theme = mode;
  root.style.colorScheme = colorSchemeForTheme(mode);
}
