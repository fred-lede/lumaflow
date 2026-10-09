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

export type SelectOption = { value: string; label: string };

const codecOptionsByFormat: Partial<Record<OutputFormat, SelectOption[]>> = {
  mp4: [
    { value: "", label: "Backend default" },
    { value: "libx264", label: "H.264 (libx264)" },
    { value: "libx265", label: "H.265 (libx265)" },
  ],
  mov: [
    { value: "", label: "Backend default" },
    { value: "libx264", label: "H.264 (libx264)" },
    { value: "libx265", label: "H.265 (libx265)" },
  ],
  mkv: [
    { value: "", label: "Backend default" },
    { value: "libx264", label: "H.264 (libx264)" },
    { value: "libx265", label: "H.265 (libx265)" },
  ],
  mp3: [
    { value: "", label: "Backend default" },
    { value: "libmp3lame", label: "MP3 (libmp3lame)" },
  ],
  m4a: [
    { value: "", label: "Backend default" },
    { value: "aac", label: "AAC" },
  ],
  wav: [
    { value: "", label: "Backend default" },
    { value: "pcm_s16le", label: "PCM 16-bit" },
    { value: "pcm_s24le", label: "PCM 24-bit" },
    { value: "pcm_s32le", label: "PCM 32-bit" },
  ],
  flac: [
    { value: "", label: "Backend default" },
    { value: "flac", label: "FLAC" },
  ],
};

export function codecOptionsForFormat(format: OutputFormat): SelectOption[] {
  return codecOptionsByFormat[format] ?? [{ value: "", label: "Backend default" }];
}

export const bitrateOptions: SelectOption[] = [
  { value: "", label: "Auto" },
  { value: "96", label: "96 kbps" },
  { value: "128", label: "128 kbps" },
  { value: "160", label: "160 kbps" },
  { value: "192", label: "192 kbps" },
  { value: "256", label: "256 kbps" },
  { value: "320", label: "320 kbps" },
];

export const widthOptions: SelectOption[] = [
  { value: "", label: "Source" },
  { value: "640", label: "640 px" },
  { value: "1280", label: "1280 px" },
  { value: "1920", label: "1920 px" },
  { value: "2560", label: "2560 px" },
  { value: "3840", label: "3840 px" },
  { value: "7680", label: "7680 px" },
];

export const heightOptions: SelectOption[] = [
  { value: "", label: "Source" },
  { value: "360", label: "360 px" },
  { value: "480", label: "480 px" },
  { value: "720", label: "720 px" },
  { value: "1080", label: "1080 px" },
  { value: "1440", label: "1440 px" },
  { value: "2160", label: "2160 px" },
  { value: "4320", label: "4320 px" },
];

export const frameRateOptions: SelectOption[] = [
  { value: "", label: "Source" },
  { value: "24000/1001", label: "23.976 fps" },
  { value: "24/1", label: "24 fps" },
  { value: "25/1", label: "25 fps" },
  { value: "30000/1001", label: "29.97 fps" },
  { value: "30/1", label: "30 fps" },
  { value: "50/1", label: "50 fps" },
  { value: "60000/1001", label: "59.94 fps" },
  { value: "60/1", label: "60 fps" },
];

export const sampleRateOptions: SelectOption[] = [
  { value: "", label: "Source" },
  { value: "32000", label: "32 kHz" },
  { value: "44100", label: "44.1 kHz" },
  { value: "48000", label: "48 kHz" },
  { value: "88200", label: "88.2 kHz" },
  { value: "96000", label: "96 kHz" },
];

export const channelOptions: SelectOption[] = [
  { value: "", label: "Source" },
  { value: "1", label: "Mono (1)" },
  { value: "2", label: "Stereo (2)" },
  { value: "6", label: "5.1 surround (6)" },
  { value: "8", label: "7.1 surround (8)" },
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
    if (patch.codec === undefined) {
      next.codec = null;
    }
    if (patch.bitrate === undefined) {
      next.bitrate = null;
    }
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
