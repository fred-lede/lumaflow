import { useCallback, useState } from "react";

import type { OutputFormat, OutputSettings, QualityPreset } from "../../domain/media";

export type ConversionMode = "lossless-first" | "transcode";

export type ConversionSettings = {
  outputDirectory: string;
  format: OutputFormat;
  preset: QualityPreset;
  mode: ConversionMode;
  codec: string | null;
  bitrate: number | null;
  width: number | null;
  height: number | null;
  frameRate: string | null;
  sampleRate: number | null;
  channels: number | null;
};

export const supportedOutputFormats: Array<{ value: OutputFormat; label: string }> = [
  { value: "mp4", label: "MP4 video" },
  { value: "mov", label: "QuickTime MOV" },
  { value: "mkv", label: "Matroska MKV" },
  { value: "webm", label: "WebM video" },
  { value: "avi", label: "AVI video" },
  { value: "mp3", label: "MP3 audio" },
  { value: "m4a", label: "M4A audio" },
  { value: "wav", label: "WAV audio" },
  { value: "flac", label: "FLAC audio" },
  { value: "ogg", label: "OGG audio" },
];

export const qualityPresets: Array<{ value: QualityPreset; label: string; description: string }> = [
  { value: "original", label: "Original", description: "Preserve the highest available quality" },
  { value: "high", label: "High", description: "A smaller file with excellent quality" },
  { value: "balanced", label: "Balanced", description: "A practical quality and size trade-off" },
  { value: "small", label: "Small", description: "Prioritize a compact output" },
];

export const defaultConversionSettings: ConversionSettings = {
  outputDirectory: "",
  format: "mp4",
  preset: "original",
  mode: "lossless-first",
  codec: null,
  bitrate: null,
  width: null,
  height: null,
  frameRate: null,
  sampleRate: null,
  channels: null,
};

const audioFormats = new Set<OutputFormat>(["mp3", "m4a", "wav", "flac", "ogg"]);

export function updateConversionSettings(
  current: ConversionSettings,
  patch: Partial<ConversionSettings>,
): ConversionSettings {
  const next = { ...current, ...patch };
  if (patch.format && patch.format !== current.format) {
    if (audioFormats.has(next.format)) {
      next.width = null;
      next.height = null;
      next.frameRate = null;
    } else {
      next.sampleRate = null;
      next.channels = null;
    }
  }
  return next;
}

export function formatToOutputSettings(settings: ConversionSettings): OutputSettings {
  return {
    outputDirectory: settings.outputDirectory,
    format: settings.format,
    quality: settings.preset,
    losslessFirst: settings.mode === "lossless-first",
    codec: settings.codec,
    bitrateKbps: settings.bitrate,
    width: settings.width,
    height: settings.height,
    frameRate: settings.frameRate,
    sampleRateHz: settings.sampleRate,
    channels: settings.channels,
  };
}

export function useConversionSettings(initial: Partial<ConversionSettings> = {}) {
  const [settings, setSettings] = useState<ConversionSettings>(() =>
    updateConversionSettings(defaultConversionSettings, initial),
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const updateSettings = useCallback((patch: Partial<ConversionSettings>) => {
    setSettings((current) => updateConversionSettings(current, patch));
  }, []);

  const toggleAdvanced = useCallback(() => {
    setAdvancedOpen((open) => !open);
  }, []);

  return {
    advancedOpen,
    settings,
    setSettings: updateSettings,
    toggleAdvanced,
    outputSettings: formatToOutputSettings(settings),
  };
}

export default useConversionSettings;
