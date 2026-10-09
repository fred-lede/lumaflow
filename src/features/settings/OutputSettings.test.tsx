// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import OutputSettings from "./OutputSettings";
import {
  defaultConversionSettings,
  updateConversionSettings,
} from "./useConversionSettings";

function renderSettings(advancedOpen: boolean, format = defaultConversionSettings.format): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(
    createElement(OutputSettings, {
      advancedOpen,
      settings: updateConversionSettings(defaultConversionSettings, { format }),
      onChange: () => undefined,
      onSelectOutputFolder: () => undefined,
      onToggleAdvanced: () => undefined,
    }),
  );
  return root;
}

describe("OutputSettings layout", () => {
  it("keeps the advanced panel present with a stable accessible toggle", () => {
    const collapsed = renderSettings(false);
    const expanded = renderSettings(true);
    const collapsedToggle = collapsed.querySelector(".advanced-toggle");
    const expandedToggle = expanded.querySelector(".advanced-toggle");

    expect(collapsed.querySelector(".advanced-settings-panel")).not.toBeNull();
    expect(expanded.querySelector(".advanced-settings-panel")).not.toBeNull();
    expect(collapsedToggle?.textContent).toContain("Advanced settings");
    expect(expandedToggle?.textContent).toContain("Advanced settings");
    expect(collapsedToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(expandedToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(collapsed.querySelector(".advanced-settings-panel")?.textContent).toContain(
      "Using source values",
    );
    expect(expanded.querySelector(".advanced-settings-panel")?.textContent).toContain(
      "Optional overrides",
    );
  });

  it("places the full-width advanced card before the quality presets", () => {
    const root = renderSettings(true);
    const outputSettings = root.querySelector(".output-settings");
    const children = outputSettings ? Array.from(outputSettings.children) : [];
    const primaryIndex = children.findIndex((child) => child.classList.contains("settings-primary"));
    const advancedIndex = children.findIndex((child) => child.classList.contains("advanced-settings-panel"));
    const presetIndex = children.findIndex((child) => child.classList.contains("preset-fieldset"));

    expect(primaryIndex).toBeGreaterThanOrEqual(0);
    expect(advancedIndex).toBeGreaterThan(primaryIndex);
    expect(presetIndex).toBeGreaterThan(advancedIndex);
  });

  it("groups video and audio overrides for video outputs", () => {
    const root = renderSettings(true, "mp4");
    const videoGroup = root.querySelector("fieldset[data-settings-group='video']");
    const audioGroup = root.querySelector("fieldset[data-settings-group='audio']");

    expect(videoGroup?.querySelector("legend")?.textContent).toBe("Video");
    expect(audioGroup?.querySelector("legend")?.textContent).toBe("Audio");
    expect(videoGroup?.textContent).toContain("Codec");
    expect(videoGroup?.textContent).toContain("Width");
    expect(videoGroup?.textContent).toContain("Height");
    expect(videoGroup?.textContent).toContain("Frame rate");
    expect(audioGroup?.textContent).toContain("Audio bitrate");
    expect(audioGroup?.textContent).toContain("Sample rate (Hz)");
    expect(audioGroup?.textContent).toContain("Channels");
  });

  it("shows only audio overrides for audio outputs", () => {
    const root = renderSettings(true, "flac");

    expect(root.querySelector("fieldset[data-settings-group='video']")).toBeNull();
    expect(root.querySelector("fieldset[data-settings-group='audio']")).not.toBeNull();
    expect(root.querySelector("fieldset[data-settings-group='audio']")?.textContent).toContain("Codec");
    expect(root.querySelector("fieldset[data-settings-group='audio']")?.textContent).toContain(
      "Sample rate (Hz)",
    );
  });
});
