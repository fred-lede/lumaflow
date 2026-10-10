// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearOutputDirectoryPreference,
  preferencesStorageKey,
  readOutputPreferences,
  writeOutputPreferences,
} from "./outputPreferences";

function createStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("output preferences", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage();
  });

  it("round-trips output directory and format through localStorage", () => {
    const value = { outputDirectory: "/Users/test/Movies", format: "mkv" as const };

    writeOutputPreferences(value, storage);

    expect(readOutputPreferences(storage)).toEqual(value);
  });

  it("removes a stored record with an unknown format", () => {
    storage.setItem(
      preferencesStorageKey,
      JSON.stringify({ outputDirectory: "/tmp", format: "aac" }),
    );

    expect(readOutputPreferences(storage)).toBeNull();
    expect(storage.getItem(preferencesStorageKey)).toBeNull();
  });

  it("removes malformed JSON from storage", () => {
    storage.setItem(preferencesStorageKey, "{not-json");

    expect(readOutputPreferences(storage)).toBeNull();
    expect(storage.getItem(preferencesStorageKey)).toBeNull();
  });

  it("clears only the output directory while preserving the format", () => {
    writeOutputPreferences({ outputDirectory: "/Users/test/Music", format: "mp3" }, storage);

    clearOutputDirectoryPreference(storage);

    expect(readOutputPreferences(storage)).toEqual({ outputDirectory: "", format: "mp3" });
  });
});
