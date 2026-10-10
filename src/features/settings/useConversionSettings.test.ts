import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import AdvancedSettings from "./AdvancedSettings";
import {
  defaultConversionSettings,
  codecOptionsForFormat,
  formatToOutputSettings,
  qualityPresetsForFormat,
  qualityPresets,
  supportedOutputFormats,
  updateConversionSettings,
} from "./useConversionSettings";

describe("useConversionSettings operations", () => {
  it("starts lossless-first with all four quality presets available", () => {
    expect(defaultConversionSettings.mode).toBe("lossless-first");
    expect(defaultConversionSettings.format).toBe("mp3");
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
    const current = updateConversionSettings(defaultConversionSettings, { format: "mp4" });
    const settings = updateConversionSettings(current, {
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

  it("resets codec and bitrate when switching output families", () => {
    const current = updateConversionSettings(
      updateConversionSettings(defaultConversionSettings, { format: "mp4" }),
      {
        codec: "libx264",
        bitrate: 192,
      },
    );
    const settings = updateConversionSettings(current, { format: "mp3" });

    expect(settings.codec).toBeNull();
    expect(settings.bitrate).toBeNull();
  });

  it("limits FLAC to the lossless quality preset and normalizes when selected", () => {
    const current = updateConversionSettings(defaultConversionSettings, { preset: "high" });
    const settings = updateConversionSettings(current, { format: "flac" });

    expect(qualityPresetsForFormat("flac").map((preset) => preset.value)).toEqual(["original"]);
    expect(settings.preset).toBe("original");
  });

  it("provides closed codec menus for supported output formats", () => {
    expect(codecOptionsForFormat("mp4")).toEqual([
      { value: "", label: "Backend default" },
      { value: "libx264", label: "H.264 (libx264)" },
      { value: "libx265", label: "H.265 (libx265)" },
    ]);
    expect(codecOptionsForFormat("mp3")).toEqual([
      { value: "", label: "Backend default" },
      { value: "libmp3lame", label: "MP3 (libmp3lame)" },
    ]);
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
      quality: "original",
      losslessFirst: false,
      codec: "flac",
      bitrateKbps: null,
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
    expect(expanded).toContain("<select");
    expect(expanded).not.toContain('type="number"');
  });
});
