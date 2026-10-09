# LumaFlow Completed Media Audio Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, in-app Play/Stop preview for completed queue outputs, including audio from video containers, without changing conversion behavior.

**Architecture:** The backend authorizes only a registered, existing output file in Tauri's runtime asset scope. The queue owns one shared HTML `<audio>` element and passes preview state/actions to completed rows, so only one item can play at a time. The browser-facing Tauri wrapper and a small preview hook/controller remain mockable for tests.

**Tech Stack:** React 19, TypeScript, Vitest/jsdom, Tauri 2 asset protocol, Rust 2021.

---

### Task 1: Add secure native preview authorization

**Files:**
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src-tauri/Cargo.toml` — enable Tauri's `protocol-asset` feature.
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src-tauri/tauri.conf.json` — enable asset protocol with an empty static scope and allow media asset origins in CSP.
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src-tauri/src/commands/files.rs` — add the validated `allow_output_preview` command.
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src-tauri/src/lib.rs` — register the command and include it in command coverage tests.
- Test: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src-tauri/src/commands/files.rs` and `/Volumes/Ai-2TB/ai/my_codex/media_converter/src-tauri/src/lib.rs`.

- [ ] **Step 1: Add a failing command registration and validation test**

Add a source-registration assertion for `commands::files::allow_output_preview` beside the existing file commands. Add a Rust unit test for the validation helper that expects an unregistered path to return `output_path_not_registered` and a registered existing output file to pass.

- [ ] **Step 2: Run the Rust library tests and verify the new test fails**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Expected: FAIL because `allow_output_preview` and its validation helper do not exist.

- [ ] **Step 3: Enable asset protocol and CSP media access**

In `src-tauri/Cargo.toml`, change the Tauri dependency to:

```toml
tauri = { version = "=2.11.5", features = ["protocol-asset"] }
```

In `src-tauri/tauri.conf.json`, add this under `app.security`:

```json
"assetProtocol": {
  "enable": true,
  "scope": []
}
```

Append `media-src 'self' asset: http://asset.localhost;` to the existing CSP.

- [ ] **Step 4: Implement least-privilege output authorization**

In `src-tauri/src/commands/files.rs`, import `tauri::Manager` and add:

```rust
#[tauri::command]
pub fn allow_output_preview(
    app: AppHandle,
    state: State<'_, BackendState>,
    path: String,
) -> Result<String, CommandError> {
    let normalized = registered_output_file(&state, &path)?;
    app.asset_protocol_scope().allow_file(&normalized).map_err(|error| {
        CommandError::with_details(
            "preview_scope_failed",
            "Could not authorize the output for preview",
            error.to_string(),
        )
    })?;
    Ok(normalized.to_string_lossy().into_owned())
}
```

Add `registered_output_file` next to `registered_output_folder`. It must normalize with `normalize_path_for_lookup`, require `state.is_registered_output_path(&normalized)`, require `normalized.is_file()`, and return `output_path_not_registered` or `output_file_not_found` without opening arbitrary paths.

Register `commands::files::allow_output_preview` in `generate_handler!` and the source command-list test.

- [ ] **Step 5: Run Rust verification**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Expected: all Rust library tests pass, including unregistered-path rejection and registered-file authorization.

### Task 2: Add typed frontend preview access and controller

**Files:**
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/shared/tauri.ts` — expose authorization and asset URL wrappers.
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/shared/tauri.test.ts` — test the new invoke arguments and error normalization.
- Create: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/features/queue/useAudioPreview.ts` — own single-player state and adapter boundary.
- Create: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/features/queue/useAudioPreview.test.ts` — cover play/stop/replacement/end/error.

- [ ] **Step 1: Add failing wrapper and controller tests**

Add a shared-wrapper test expecting:

```ts
await authorizeOutputPreview("/output/clip.mp4");
expect(mockedInvoke).toHaveBeenCalledWith("allow_output_preview", { path: "/output/clip.mp4" });
```

Add controller tests with a fake `HTMLAudioElement` covering:

```ts
expect(state.activePath).toBeNull();
await controller.play("/output/one.mp3");
expect(audio.src).toContain("one.mp3");
expect(audio.play).toHaveBeenCalledOnce();
await controller.play("/output/one.mp3");
expect(audio.pause).toHaveBeenCalledOnce();
await controller.play("/output/two.mp4");
expect(audio.pause).toHaveBeenCalledTimes(2);
audio.onended?.(new Event("ended"));
expect(controller.getState().activePath).toBeNull();
```

Also assert an authorization/playback rejection produces a preview error and clears the active path.

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
npm test -- --run src/shared/tauri.test.ts src/features/queue/useAudioPreview.test.ts
```

Expected: FAIL because the wrapper and preview controller do not exist.

- [ ] **Step 3: Add typed Tauri wrappers**

In `src/shared/tauri.ts`, import `convertFileSrc` from `@tauri-apps/api/core` and add:

```ts
export function authorizeOutputPreview(path: string): Promise<string> {
  return invokeLumaFlow<string>("allow_output_preview", { path });
}

export function outputPreviewUrl(path: string): string {
  return convertFileSrc(path);
}
```

Keep authorization separate from URL construction so tests can mock both operations.

- [ ] **Step 4: Implement the shared preview controller**

Define an adapter:

```ts
export type AudioPreviewAdapter = {
  authorizeOutputPreview: (path: string) => Promise<string>;
  outputPreviewUrl: (path: string) => string;
};
```

Implement `useAudioPreview(adapter?)` with one `HTMLAudioElement` ref, `activePath`, and `error`. `play(path)` must stop/reset an existing element, authorize the path, assign `src`, call `load()`, await `play()`, then set `activePath`. Calling `play` for the active path must stop and clear it. `stop()` must pause, reset `currentTime`, clear `src`, call `load()`, and clear state. `onEnded` must call the same reset path. Catch authorization or `play()` errors as `Preview unavailable. The format or codec is not supported by this platform.` without throwing to the queue.

Return this concrete controller shape so `QueuePanel` can render the one shared `<audio>` element:

```ts
import type { MutableRefObject } from "react";

export type AudioPreviewController = {
  audioRef: MutableRefObject<HTMLAudioElement | null>;
  activePath: string | null;
  error: string | null;
  play: (path: string) => Promise<void>;
  stop: () => void;
  handleEnded: () => void;
  handleError: () => void;
};
```

- [ ] **Step 5: Run focused tests and verify they pass**

Run:

```bash
npm test -- --run src/shared/tauri.test.ts src/features/queue/useAudioPreview.test.ts
```

Expected: all wrapper and controller tests pass.

### Task 3: Add Play/Stop controls to completed queue rows

**Files:**
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/features/queue/QueuePanel.tsx` — own the preview hook and shared audio element.
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/features/queue/QueueRow.tsx` — render the completed-row preview button and preview error.
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/features/queue/useQueueEvents.test.ts` — extend existing queue rendering tests with completed and non-completed cases.
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/styles/glass.css` — style the visually hidden shared audio element and preview error text.

- [ ] **Step 1: Add failing row assertions**

Extend the existing `QueueRow` rendering tests in `src/features/queue/useQueueEvents.test.ts` so a completed job exposes:

```ts
expect(markup).toContain('aria-label="Play preview"');
expect(markup).toContain("Play preview");
```

and a queued/failed job does not expose `Play preview`. Add a test that the queue passes an active preview state to the row and renders `Stop preview` for the active completed job.

- [ ] **Step 2: Run the focused queue tests and verify they fail**

Run:

```bash
npm test -- --run src/features/queue/useQueueEvents.test.ts
```

Expected: FAIL because QueueRow has no preview props or button.

- [ ] **Step 3: Extend QueueRow's preview API**

Add these props to `QueueRowProps`:

```ts
isPreviewActive?: boolean;
previewError?: string | null;
onPreview: (path: string) => void;
```

For `job.state.kind === "completed" && job.outputPath !== null`, render a button in `.queue-row__actions` whose label and `aria-label` are `Stop preview` when active and `Play preview` otherwise. The button calls `onPreview(job.outputPath)`. Render the recoverable preview error near the row actions when present. Do not alter the existing Cancel, Retry, Open output folder, or reorder buttons.

- [ ] **Step 4: Connect QueuePanel to one shared audio element**

Call `useAudioPreview()` once in `QueuePanel`, pass `isPreviewActive`, `previewError`, and `onPreview` to each `QueueRow`, and render exactly one audio element:

```tsx
<audio
  ref={preview.audioRef}
  className="audio-preview"
  aria-hidden="true"
  preload="metadata"
  onEnded={preview.handleEnded}
  onError={preview.handleError}
 />
```

When the queue snapshot no longer contains the active path, stop and clear the preview. Keep the audio element visually hidden but mounted so browser playback and keyboard actions remain available through the labeled row button.

- [ ] **Step 5: Add focused styles**

Add an `.audio-preview` visually-hidden rule that preserves the element for playback without adding layout height. Use the existing `.inline-error`/queue row error visual language for preview failures; do not reduce body text below the existing readable sizes.

- [ ] **Step 6: Run queue and full frontend tests**

Run:

```bash
npm test -- --run src/features/queue/useQueueEvents.test.ts
npm test -- --run
```

Expected: focused and full frontend tests pass.

### Task 4: Integrate and verify native playback configuration

**Files:**
- Modify: none beyond Tasks 1–3.
- Test: Rust library tests, frontend tests, and production build.

- [ ] **Step 1: Run typecheck and production build**

```bash
npm run typecheck
npm run build
```

Expected: TypeScript and Vite build pass.

- [ ] **Step 2: Run Rust tests and formatting check**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Expected: formatting check and Rust tests pass.

- [ ] **Step 3: Run the desktop smoke test**

Launch with:

```bash
npm run tauri -- dev
```

Using a completed test output, verify: Play preview starts audio; the label changes to Stop preview; Stop resets playback; playing another row stops the first; playback end restores Play preview; unsupported codec shows Preview unavailable; Open output folder still works.

- [ ] **Step 4: Commit the implementation**

```bash
git add src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/src/lib.rs src-tauri/src/commands/files.rs src/shared/tauri.ts src/shared/tauri.test.ts src/features/queue/useAudioPreview.ts src/features/queue/useAudioPreview.test.ts src/features/queue/QueuePanel.tsx src/features/queue/QueueRow.tsx src/features/queue/useQueueEvents.test.ts src/styles/glass.css
git commit -m "feat: add completed media audio preview"
```
