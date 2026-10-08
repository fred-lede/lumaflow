import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import AdvancedSettings from "./AdvancedSettings";
import {
  defaultConversionSettings,
  formatToOutputSettings,
  qualityPresets,
  supportedOutputFormats,
  updateConversionSettings,
} from "./useConversionSettings";

describe("useConversionSettings operations", () => {
  it("starts lossless-first with all four quality presets available", () => {
    expect(defaultConversionSettings.mode).toBe("lossless-first");
    expect(defaultConversionSettings.preset).toBe("original");
    expect(qualityPresets.map((preset) => preset.value)).toEqual([
      "original",
      "high",
      "balanced",
      "small",
    ]);
  });

  it("offers every backend-supported output format", () => {
    expect(supportedOutputFormats.map((format) => format.value)).toEqual([
      "mp4",
      "mov",
      "mkv",
      "webm",
      "avi",
      "mp3",
      "m4a",
      "wav",
      "flac",
      "ogg",
    ]);
  });

  it("resets incompatible video fields when switching to an audio output", () => {
    const settings = updateConversionSettings(defaultConversionSettings, {
      width: 1_920,
      height: 1_080,
      frameRate: "24/1",
      sampleRate: 48_000,
      channels: 2,
      format: "mp3",
    });

    expect(settings.format).toBe("mp3");
    expect(settings.width).toBeNull();
    expect(settings.height).toBeNull();
    expect(settings.frameRate).toBeNull();
    expect(settings.sampleRate).toBe(48_000);
    expect(settings.channels).toBe(2);
  });

  it("maps the controlled model to the backend contract", () => {
    const settings = updateConversionSettings(defaultConversionSettings, {
      format: "flac",
      mode: "transcode",
      preset: "high",
      codec: "flac",
      bitrate: 192,
      sampleRate: 96_000,
      channels: 2,
    });

    expect(formatToOutputSettings(settings)).toMatchObject({
      format: "flac",
      quality: "high",
      losslessFirst: false,
      codec: "flac",
      bitrateKbps: 192,
      sampleRateHz: 96_000,
      channels: 2,
    });
  });

  it("keeps advanced controls collapsed until the section is expanded", () => {
    const collapsed = renderToStaticMarkup(
      createElement(AdvancedSettings, {
        expanded: false,
        settings: defaultConversionSettings,
        onChange: () => undefined,
      }),
    );
    const expanded = renderToStaticMarkup(
      createElement(AdvancedSettings, {
        expanded: true,
        settings: defaultConversionSettings,
        onChange: () => undefined,
      }),
    );

    expect(collapsed).not.toContain("Codec");
    expect(expanded).toContain("Codec");
    expect(expanded).toContain("Sample rate (Hz)");
  });
});
