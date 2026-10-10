import type { OutputFormat } from "../../domain/media";

export const preferencesStorageKey = "lumaflow.preferences.v1";

export type OutputPreferences = {
  outputDirectory: string;
  format: OutputFormat;
};

const supportedOutputFormats = new Set<OutputFormat>([
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

function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) {
    return storage;
  }

  try {
    if (typeof window === "undefined") {
      return null;
    }

    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function isOutputPreferences(value: unknown): value is OutputPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.outputDirectory === "string" &&
    typeof record.format === "string" &&
    supportedOutputFormats.has(record.format as OutputFormat)
  );
}

function removeStoredPreferences(storage: Storage): void {
  try {
    storage.removeItem(preferencesStorageKey);
  } catch {
    return;
  }
}

export function readOutputPreferences(storage?: Storage | null): OutputPreferences | null {
  const targetStorage = resolveStorage(storage);
  if (targetStorage === null) {
    return null;
  }

  let rawValue: string | null;
  try {
    rawValue = targetStorage.getItem(preferencesStorageKey);
  } catch {
    return null;
  }

  if (rawValue === null) {
    return null;
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(rawValue) as unknown;
  } catch {
    removeStoredPreferences(targetStorage);
    return null;
  }

  if (!isOutputPreferences(parsedValue)) {
    removeStoredPreferences(targetStorage);
    return null;
  }

  return parsedValue;
}

export function writeOutputPreferences(value: OutputPreferences, storage?: Storage | null): void {
  const targetStorage = resolveStorage(storage);
  if (targetStorage === null) {
    return;
  }

  if (!isOutputPreferences(value)) {
    removeStoredPreferences(targetStorage);
    return;
  }

  try {
    targetStorage.setItem(preferencesStorageKey, JSON.stringify(value));
  } catch {
    return;
  }
}

export function clearOutputDirectoryPreference(storage?: Storage | null): void {
  const currentPreferences = readOutputPreferences(storage);
  if (currentPreferences === null) {
    return;
  }

  writeOutputPreferences({ ...currentPreferences, outputDirectory: "" }, storage);
}
