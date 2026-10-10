# LumaFlow MKV Feedback and Output Folder Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MKV compatibility errors actionable, remember and validate the last output folder, and use MP3 as the default output format.

**Architecture:** Keep conservative MKV decisions in the Rust planner and improve its structured error text. Add a small versioned frontend preference service for the folder and format, plus a Rust validation command that reuses the existing directory normalization/registration boundary. Hydrate preferences at startup and validate again before enqueueing.

**Tech Stack:** React 19, TypeScript, Vitest/jsdom, Tauri 2, Rust, existing `BackendState` output-directory registry.

---

## File map

- Create `src/features/settings/outputPreferences.ts` and its test: safe versioned storage helpers.
- Modify `src/features/settings/useConversionSettings.ts` and its test: MP3 default.
- Modify `src/shared/tauri.ts` and its test: typed `validateOutputFolder` command.
- Modify `src/app/AppShell.tsx` and its test: startup hydration, persistence, and preflight recovery.
- Modify `src-tauri/src/commands/files.rs` and `src-tauri/src/lib.rs`: validation command and registration tests.
- Modify `src-tauri/src/media/planner.rs`: actionable generic MKV compatibility message and assertions.

## Task 1: Write failing preference and default tests

**Files:** `src/features/settings/outputPreferences.test.ts`, `src/features/settings/useConversionSettings.test.ts`

- [ ] **Step 1: Add storage tests.** Create a jsdom test that clears `localStorage` before each test and covers:

```ts
it("round-trips a valid folder and format", () => {
  writeOutputPreferences({ outputDirectory: "/exports", format: "flac" });
  expect(readOutputPreferences()).toEqual({ outputDirectory: "/exports", format: "flac" });
});

it("removes malformed and unsupported records", () => {
  localStorage.setItem(preferencesStorageKey, "not-json");
  expect(readOutputPreferences()).toBeNull();
  localStorage.setItem(
    preferencesStorageKey,
    JSON.stringify({ outputDirectory: "/exports", format: "mkv2" }),
  );
  expect(readOutputPreferences()).toBeNull();
  expect(localStorage.getItem(preferencesStorageKey)).toBeNull();
});

it("clears only the folder", () => {
  writeOutputPreferences({ outputDirectory: "/missing", format: "mp3" });
  clearOutputDirectoryPreference();
  expect(readOutputPreferences()).toEqual({ outputDirectory: "", format: "mp3" });
});
```

Add a settings test asserting `defaultConversionSettings.format` is `"mp3"`.

- [ ] **Step 2: Run the focused tests.** Run `npm test -- --run src/features/settings/outputPreferences.test.ts src/features/settings/useConversionSettings.test.ts`. Expected: missing preference helpers and the current MP4 default cause failures.

## Task 2: Implement preferences and MP3 default

**Files:** `src/features/settings/outputPreferences.ts`, `src/features/settings/useConversionSettings.ts`

- [ ] **Step 1: Implement the preference module.** Export this API:

```ts
export const preferencesStorageKey = "lumaflow.preferences.v1";
export type OutputPreferences = { outputDirectory: string; format: OutputFormat };
export function readOutputPreferences(storage?: Storage | null): OutputPreferences | null;
export function writeOutputPreferences(value: OutputPreferences, storage?: Storage | null): void;
export function clearOutputDirectoryPreference(storage?: Storage | null): void;
```

Use a runtime `Set` containing the ten existing output values (`mp4`, `mov`, `mkv`, `webm`, `avi`, `mp3`, `m4a`, `wav`, `flac`, `ogg`). Parse unknown JSON as `unknown`, require a string folder and supported string format, remove malformed records, and swallow storage access errors because persistence is optional. `clearOutputDirectoryPreference` must retain the format and replace only `outputDirectory` with `""`.

- [ ] **Step 2: Change `defaultConversionSettings.format` from `"mp4"` to `"mp3"`.** Do not change format-dependent codec or quality normalization.

- [ ] **Step 3: Run the focused tests.** Expected: all new preference tests and existing settings tests pass.

- [ ] **Step 4: Commit.** Run:

```bash
git add src/features/settings/outputPreferences.ts src/features/settings/outputPreferences.test.ts src/features/settings/useConversionSettings.ts src/features/settings/useConversionSettings.test.ts
git commit -m "feat: default new conversions to MP3"
```

## Task 3: Add backend folder validation and typed wrapper

**Files:** `src-tauri/src/commands/files.rs`, `src-tauri/src/lib.rs`, `src/shared/tauri.ts`, `src/shared/tauri.test.ts`

- [ ] **Step 1: Write Rust tests first.** Add tests for a helper named `validate_and_register_output_directory`:

```rust
#[test]
fn validates_and_registers_existing_output_directory() {
    let directory = std::env::temp_dir().join(format!("lumaflow-output-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("temporary output directory");
    let state = BackendState::default();
    let result = validate_and_register_output_directory(&state, &directory.to_string_lossy())
        .expect("existing directory should validate");
    assert_eq!(PathBuf::from(result), directory);
    assert!(state.is_registered_output_directory(&directory));
    std::fs::remove_dir(&directory).expect("temporary directory cleanup");
}

#[test]
fn rejects_missing_output_directory() {
    let state = BackendState::default();
    let missing = std::env::temp_dir().join("lumaflow-folder-that-does-not-exist");
    let error = validate_and_register_output_directory(&state, &missing.to_string_lossy())
        .expect_err("missing directory should fail");
    assert_eq!(error.code, "output_directory_not_found");
}
```

Use a unique temporary missing path if the test environment might already contain the literal path. Run `cargo test --manifest-path src-tauri/Cargo.toml commands::files` and verify failure because the helper is absent.

- [ ] **Step 2: Implement the helper and command.** Normalize with the existing `normalize_existing_directory`, call `state.remember_output_directory`, and return the normalized string. Add:

```rust
#[tauri::command]
pub fn validate_output_folder(
    state: State<'_, BackendState>,
    path: String,
) -> Result<String, CommandError> {
    validate_and_register_output_directory(&state, &path)
}
```

Register `commands::files::validate_output_folder` in the `generate_handler!` list and in the existing command-registration test.

- [ ] **Step 3: Add the TypeScript wrapper and test.** Add:

```ts
export function validateOutputFolder(path: string): Promise<string> {
  return invokeLumaFlow<string>("validate_output_folder", { path });
}
```

Assert `validateOutputFolder("/exports")` invokes the command with `{ path: "/exports" }`.

- [ ] **Step 4: Run tests and commit.** Run `cargo test --manifest-path src-tauri/Cargo.toml commands::files` and `npm test -- --run src/shared/tauri.test.ts`; expected PASS. Then run:

```bash
git add src-tauri/src/commands/files.rs src-tauri/src/lib.rs src/shared/tauri.ts src/shared/tauri.test.ts
git commit -m "feat: validate remembered output folders"
```

## Task 4: Integrate startup hydration and stale-folder recovery

**Files:** `src/app/AppShell.tsx`, `src/app/App.test.tsx`

- [ ] **Step 1: Add failing integration tests.** Use `@testing-library/react`, seed `localStorage` with `{ outputDirectory: "/removed", format: "mp3" }`, mock `validateOutputFolder` to reject with `output_directory_not_found`, render `AppShell`, wait for effects, and assert:

```ts
expect(screen.getByPlaceholderText("Choose a destination folder")).toHaveValue("");
expect(JSON.parse(localStorage.getItem(preferencesStorageKey) ?? "null")).toEqual({
  outputDirectory: "",
  format: "mp3",
});
expect(screen.getByRole("button", { name: "Start conversion" })).toBeDisabled();
```

Add a valid-path test that resolves `/exports`, then asserts the input value is `/exports` and the Format select remains `mp3`. Run `npm test -- --run src/app/App.test.tsx`; expected failure because `AppShell` currently ignores storage.

- [ ] **Step 2: Read preferences once and initialize format.** In `AppShell`, import the preference helpers and `validateOutputFolder`. Read preferences with `useMemo` before calling `useConversionSettings`, and pass the saved format or `defaultConversionSettings.format` as the initial format. Add `preferencesReady`, initialized true only when there is no saved folder.

- [ ] **Step 3: Validate the saved folder on mount.** Add an effect with a cancellation flag. If a saved folder exists, call `validateOutputFolder`; on success set the normalized output directory, on failure call `clearOutputDirectoryPreference`, leave the active field empty, and always mark `preferencesReady` true unless unmounted. Do not display a stale folder while validation is pending.

- [ ] **Step 4: Persist changes after hydration.** Add an effect that runs only when `preferencesReady` is true and calls:

```ts
writeOutputPreferences({
  outputDirectory: conversion.settings.outputDirectory,
  format: conversion.settings.format,
});
```

This persists only the selected folder and format; native Browse has already validated the folder.

- [ ] **Step 5: Revalidate before start.** At the start of `handleStartConversion`, call `validateOutputFolder(conversion.settings.outputDirectory)`. On failure, clear the persisted folder and active setting, set `The output folder is no longer available. Choose a new destination folder.`, and return. On success, update the active setting to the normalized result before `intake.start`. Add `!preferencesReady` to the Start button disabled condition. Keep backend enqueue validation as the final race-condition guard.

- [ ] **Step 6: Run integration tests and commit.** Run `npm test -- --run src/app/App.test.tsx src/features/settings/outputPreferences.test.ts`; expected PASS. Then:

```bash
git add src/app/AppShell.tsx src/app/App.test.tsx
git commit -m "feat: persist and validate output preferences"
```

## Task 5: Improve generic MKV compatibility feedback

**Files:** `src-tauri/src/media/planner.rs`

- [ ] **Step 1: Extend existing planner tests.** In the unknown-codec and incompatible-stream rejection tests, assert the error message contains `not proven safe`, `compatible codecs`, and `Always transcode`. In the subtitle-specific test, assert the existing dedicated subtitle message remains unchanged.

- [ ] **Step 2: Run `cargo test --manifest-path src-tauri/Cargo.toml media::planner` and verify the new wording assertions fail.**

- [ ] **Step 3: Change only the generic fallback message to:**

```rust
format!(
    "The requested {} conversion is not proven safe for the selected streams. Choose compatible codecs in Advanced settings or use Always transcode when supported.",
    output_format.display_name(),
)
```

Do not weaken any stream matrix or replace the dedicated subtitle error.

- [ ] **Step 4: Run planner tests and commit.** Expected PASS, with unsafe MKV combinations still rejected. Then run:

```bash
git add src-tauri/src/media/planner.rs
git commit -m "fix: explain unsupported MKV stream combinations"
```

## Task 6: Full verification

- [ ] **Step 1:** Run `npm test -- --run`; expected all frontend tests pass.
- [ ] **Step 2:** Run `cargo test --manifest-path src-tauri/Cargo.toml`; expected all Rust tests pass.
- [ ] **Step 3:** Run `npm run build`; expected TypeScript and Vite build pass.
- [ ] **Step 4:** Manual smoke test: fresh state shows MP3; choose folder, restart, confirm restoration; remove folder, restart, confirm blank field and disabled Start; choose a new folder; exercise an unsupported MKV combination and confirm the actionable error.
- [ ] **Step 5:** Review `git status --short` and `git diff HEAD~5..HEAD --stat`; expected a clean working tree after the task commits and only the approved design/plan plus implementation/test files changed.

## Self-review

- Spec coverage: MKV messaging is Task 5; folder persistence, invalidation, startup validation, and preflight validation are Tasks 2–4; MP3 default and format retention are Tasks 1–4; testing and smoke checks are Task 6.
- No placeholder steps remain; every code change names a file, test, command, or exact API.
- Type consistency: `OutputPreferences.format` uses the existing `OutputFormat`; the Tauri wrapper returns the normalized `string`; `AppShell` passes the same `ConversionSettings` shape already consumed by `useConversionSettings`.
