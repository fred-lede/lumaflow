# LumaFlow MKV compatibility feedback and output-folder persistence

## Status

Approved design for implementation.

## Problem

Two related settings/conversion issues need to be made safer and clearer:

1. Some MKV requests are rejected with the generic message “The requested MKV conversion is not proven compatible”. The rejection is intentionally conservative, but the message does not tell the user what to do next.
2. The output folder is currently held only in the active React state. Restarting LumaFlow loses the last folder, while retaining a folder without checking whether it still exists could cause a conversion to fail later.
3. The initial output format should be MP3 rather than MP4.

## Goals

- Keep the backend’s conservative MKV compatibility checks.
- Give MKV compatibility failures a clear, actionable user-facing explanation.
- Remember the last successfully selected output folder across launches.
- Validate a remembered folder before displaying it as usable.
- Clear a remembered folder automatically when it no longer exists or is not a directory.
- Require the user to choose a new folder before conversion can start after invalidation.
- Use MP3 as the initial output format when no saved format preference exists.
- Preserve a user-selected output format across launches without resetting it to MP3.

## Non-goals

- Do not broaden the set of MKV streams that may be remuxed or transcoded without codec/stream evidence.
- Do not silently fall back to the source folder, home folder, or another default destination.
- Do not persist source media, queue contents, codec overrides, or other conversion settings in this change.
- Do not add a new settings screen or introduce a third-party preferences plugin.

## Design

### 1. MKV compatibility feedback

The planner continues to reject an MKV request when the selected stream combination cannot be proven safe. The existing structured error code remains stable so callers do not need to parse the message.

The message is changed to explain the next action. It should state that the selected MKV stream combination is not proven safe and recommend one of the supported remedies: select compatible codecs in Advanced settings, use Always transcode when the source is eligible, or remove unsupported subtitle/unknown streams. The existing dedicated subtitle error remains specific rather than being replaced by the generic message.

The frontend preserves the backend error message in the queue/error UI. Tests assert the new actionable wording and ensure the conservative rejection still occurs.

### 2. Output-folder persistence

Use a small versioned browser storage record for user preferences:

```text
lumaflow.preferences.v1 = {
  outputDirectory: string,
  outputFormat: OutputFormat
}
```

Only a successfully returned folder from the native picker is written as `outputDirectory`. The format is written when the user changes it. Storage failures are non-fatal; the application continues with in-memory settings.

On application startup:

1. Read the preference record defensively. Invalid JSON or unknown values are ignored and removed.
2. If a saved output folder exists, call a backend validation command.
3. The backend verifies that the path exists, is a directory, and is registered for output use in the current process.
4. If valid, hydrate the settings with the folder.
5. If invalid, remove only the saved output folder, keep the folder field empty, and show the normal folder placeholder. The user must press Browse before conversion can be started.

The folder is validated again immediately before enqueueing. This covers the case where a directory is deleted or unmounted after launch. When that check fails, the frontend clears the active and persisted folder and presents the existing settings error telling the user to choose a destination again.

The backend validation command must not create directories or register arbitrary paths without verifying them. It should use the same output-directory authorization path as the native folder picker so startup hydration does not bypass the existing safety boundary.

### 3. Default output format

- Change the no-preference default from MP4 to MP3.
- A saved valid format preference wins over the default.
- Selecting another format updates the preference immediately.
- Existing format-dependent reset rules still apply when changing formats (for example, video-only settings are cleared for audio formats).

### 4. UI states

- Valid remembered folder: show its path as the current output folder.
- Missing/unusable remembered folder: show `Choose a destination folder`; do not show a stale path.
- No folder selected: keep Start conversion disabled, as it is now.
- Folder becomes invalid before conversion: clear the field and show an actionable inline error such as “The output folder is no longer available. Choose a new destination folder.”
- MKV planner rejection: show the improved planner message without presenting it as an FFmpeg runtime failure.

## Data flow

```text
native Browse
  -> backend verifies and authorizes folder
  -> frontend settings update
  -> persist folder

app startup
  -> read preferences
  -> backend validates remembered folder
  -> hydrate settings or clear stale folder

Start conversion
  -> backend revalidates folder
  -> enqueue jobs
  -> if invalid, clear preference and request Browse
```

## Testing plan

### Frontend

- Default settings use `mp3`.
- A saved MP3/other valid format is restored; malformed or unsupported format values are ignored.
- A chosen output folder is persisted.
- A valid persisted folder is hydrated.
- An invalid persisted folder is cleared and does not enable conversion.
- A folder validation failure during start clears the active and persisted value and displays the recovery message.
- Storage read/write failures do not crash the app.

### Backend

- The folder validation command accepts an existing directory and registers it.
- It rejects a missing path and a file path with structured errors.
- Existing authorization rules continue to reject unregistered output paths.
- MKV unknown-codec/subtitle rejection tests remain conservative and assert the improved actionable message where applicable.

### Regression checks

- Existing frontend tests and Rust tests pass.
- Production frontend build passes.
- A manual smoke test covers: choose folder, restart, delete/rename folder, relaunch, choose a new folder, select MKV, and attempt an unsupported stream combination.

## Risks and mitigations

- Browser storage may be unavailable or cleared: fall back to an empty folder and MP3 default without blocking the app from opening.
- A folder can disappear between validation and writing: revalidate before enqueue and retain the existing backend check.
- Users may interpret “lossless” as “all MKV inputs are safe”: keep the wording explicit that compatibility is stream-specific and do not weaken planner rules.
