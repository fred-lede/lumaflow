# LumaFlow Completed Media Audio Preview

## Goal

Let users quickly audition a completed conversion from the Batch queue with a simple Play/Stop control, without opening an external player or changing the conversion pipeline.

## Approved behavior

- Only completed queue items expose the preview control.
- The control label is `Play preview` when idle and `Stop preview` while that item is playing.
- Only one output can play at a time. Starting another preview stops and resets the current one.
- Audio outputs play in the LumaFlow window.
- Video containers such as MP4 are loaded into an audio element so the user hears the soundtrack without opening a video preview.
- When playback reaches the end, the control returns to `Play preview`.
- If the platform WebView cannot decode the file, the queue shows a recoverable `Preview unavailable` message and keeps `Open output folder` available.
- Cancelled, failed, queued, analyzing, and active jobs do not expose a preview control.

## Technical design

Use one shared HTML `<audio>` element owned by the queue surface rather than one player per row. `QueuePanel` owns the active preview state and passes a small preview API to `QueueRow`.

The preview flow is:

1. The user presses `Play preview` on a completed row.
2. The frontend invokes a native command with the row's output path.
3. The native command normalizes the path, confirms it is a registered output created by a validated queue job, confirms the file exists, and adds only that file to Tauri's runtime asset protocol scope.
4. The frontend converts the authorized path with `convertFileSrc`, assigns it to the shared audio element, and calls `play()`.
5. Stop, end-of-playback, row removal, or a new preview pauses the element, resets its time, clears its source, and updates the row label.

Enable Tauri's asset protocol feature and allow `asset:` / `http://asset.localhost` as media sources in the CSP. Do not add a broad filesystem glob: runtime scope is granted one validated output file at a time.

## Error handling and safety

- A renderer-supplied path is never trusted by itself. The backend accepts it only when it matches an output path already registered by the queue state.
- Missing files, denied asset scope, unsupported codecs, and rejected `HTMLMediaElement.play()` calls become an inline preview error, not a queue failure.
- Stopping or switching previews is idempotent and safe when no player is active.
- The plain Vite browser preview has no Tauri invoke or asset protocol, so preview controls must fail with a clear unavailable state rather than an unhandled exception.

## Acceptance criteria

1. A completed queue row shows an accessible `Play preview` button.
2. Pressing it authorizes only the registered output file and starts in-app audio playback.
3. The same button becomes `Stop preview` while active and resets playback when pressed.
4. Starting a second preview stops the first one.
5. Ended playback restores the idle label.
6. Unsupported or unavailable media displays a recoverable preview error and leaves other queue actions usable.
7. Non-completed rows do not show preview controls.
8. Backend tests reject unregistered paths and accept a registered existing output path.
9. Frontend tests cover idle, play, stop, replacement, ended, and error states using a mocked preview adapter/audio element.
10. Existing queue, conversion, drag-and-drop, and output-folder behavior remains unchanged.

## Reference

Tauri's `convertFileSrc` requires the asset protocol to be enabled and the requested file to be included in its scope. Tauri also exposes a runtime asset scope that can allow a specific file, which is the basis for the least-privilege preview flow.

- https://tauri.app/reference/javascript/api/namespacecore/
- https://docs.rs/tauri/latest/x86_64-apple-ios/tauri/scope/index.html
