# LumaFlow MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working LumaFlow desktop MVP for local, lossless-first batch conversion on macOS, Windows, and Linux.

**Architecture:** A Tauri 2 desktop shell hosts a React/TypeScript single-page workspace. Rust owns media probing, conversion planning, FFmpeg process execution, queue scheduling, cancellation, temporary files, and typed events; the UI communicates only through typed Tauri commands/events.

**Tech Stack:** Tauri 2, React, TypeScript, Vite, Rust, FFmpeg/FFprobe, Vitest, Rust unit tests, Playwright-based desktop smoke tests, GitHub Actions.

---

## Repository structure

The repository is currently empty. The implementation will use these boundaries:

- `src/app/`: application shell, theme, global layout, and error boundary.
- `src/features/intake/`: drag-and-drop, file selection, and source metadata display.
- `src/features/settings/`: output format, quality presets, lossless mode, and advanced options.
- `src/features/queue/`: queue rows, progress, actions, and status labels.
- `src/shared/`: typed frontend IPC helpers and shared formatting utilities.
- `src-tauri/src/domain/`: Rust domain types shared by commands and tests.
- `src-tauri/src/media/`: FFprobe parsing, conversion planning, and FFmpeg command construction.
- `src-tauri/src/jobs/`: queue scheduler, process runner, cancellation, progress events, and atomic output handling.
- `src-tauri/src/commands/`: Tauri command handlers and event serialization.
- `scripts/`: deterministic development and release checks for FFmpeg assets.
- `tests/fixtures/`: generated, small media fixtures and their checksums.

## Task 1: Bootstrap the Tauri workspace

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/app/App.tsx`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the frontend package scripts.** Define `dev`, `build`, `typecheck`, `test`, `test:ui`, and `tauri` scripts. Pin React, Vite, TypeScript, Vitest, and Tauri versions in the manifest and lockfile.
- [ ] **Step 2: Add the minimal Tauri shell.** `src/main.tsx` renders `<App />`; `src/app/App.tsx` renders a temporary accessible heading and a root landmark. `src-tauri/src/lib.rs` registers no media commands yet and returns a successful Tauri builder.
- [ ] **Step 3: Configure desktop permissions.** `default.json` permits only the dialog, filesystem paths selected by the user, and event APIs needed by the app. Do not enable arbitrary shell execution from the frontend.
- [ ] **Step 4: Run the bootstrap checks.** Run `npm install`, `npm run typecheck`, `npm run test -- --run`, and `cargo test --manifest-path src-tauri/Cargo.toml`. Expected: all commands pass with the temporary shell.
- [ ] **Step 5: Commit.** `git add package.json package-lock.json tsconfig.json vite.config.ts index.html src src-tauri .github && git commit -m "chore: bootstrap Tauri workspace"`.

## Task 2: Define the shared domain model and typed IPC contract

**Files:**
- Create: `src/domain/media.ts`
- Create: `src/domain/job.ts`
- Create: `src/shared/tauri.ts`
- Create: `src-tauri/src/domain/media.rs`
- Create: `src-tauri/src/domain/job.rs`
- Create: `src-tauri/src/domain/mod.rs`
- Create: `src-tauri/src/commands/mod.rs`
- Test: `src/domain/job.test.ts`
- Test: `src-tauri/src/domain/job.rs`

- [ ] **Step 1: Write the failing TypeScript model tests.** Cover `Queued`, `Analyzing`, `LosslessRemux`, `LosslessAudio`, `Transcoding`, `Completed`, `Cancelled`, and `Failed` states, and assert that every state has a user-facing label and a machine-readable kind.
- [ ] **Step 2: Define the matching types.** Use discriminated unions rather than free-form strings. The frontend contract must include `MediaInfo`, `OutputSettings`, `ProcessingKind`, `QueueJob`, `QueueSnapshot`, and `JobEvent`.
- [ ] **Step 3: Write Rust serialization tests.** Serialize representative Rust values to JSON and assert the field names match the TypeScript contract exactly.
- [ ] **Step 4: Add typed IPC wrappers.** `src/shared/tauri.ts` exposes `selectFiles()`, `analyzeFiles()`, `enqueueJobs()`, `pauseAll()`, `resumeAll()`, `cancelJob()`, `retryJob()`, and `openOutputFolder()`; each wrapper has a typed return value and converts backend errors into `LumaFlowError`.
- [ ] **Step 5: Run tests and commit.** Run `npm run test -- --run src/domain/job.test.ts` and `cargo test --manifest-path src-tauri/Cargo.toml domain`. Expected: PASS. Commit with `feat: define media and queue contracts`.

## Task 3: Implement media probing and lossless-first planning

**Files:**
- Create: `src-tauri/src/media/mod.rs`
- Create: `src-tauri/src/media/probe.rs`
- Create: `src-tauri/src/media/planner.rs`
- Create: `src-tauri/src/media/ffmpeg_args.rs`
- Test: `src-tauri/src/media/probe.rs`
- Test: `src-tauri/src/media/planner.rs`

- [ ] **Step 1: Add probe fixtures and failing tests.** Test MP4 with H.264/AAC, WAV PCM, FLAC, MP4 with multiple audio tracks, and malformed FFprobe JSON. Tests must use a fake command runner so unit tests do not depend on a machine-installed FFprobe.
- [ ] **Step 2: Parse only the required FFprobe fields.** Map container, duration, size, video codec, dimensions, frame rate, audio codec, sample rate, channels, stream index, and subtitle presence into `MediaInfo`. Malformed or missing required fields return a structured error.
- [ ] **Step 3: Implement the planner rules.** Return `LosslessRemux` only when the requested container can carry the existing streams and no stream-level setting changes. Return `LosslessAudio` for supported lossless audio conversion such as PCM/WAV to FLAC. Return `Transcoding` for MP4 to MP3 and all incompatible codec/settings changes.
- [ ] **Step 4: Build deterministic FFmpeg arguments.** Keep input paths and output paths as separate process arguments; never construct a shell command string. The planner must include `-map` choices for selected streams and an explicit output path.
- [ ] **Step 5: Run the media unit tests.** Run `cargo test --manifest-path src-tauri/Cargo.toml media`. Expected: PASS for all planner branches, including unsupported combinations and malformed metadata.
- [ ] **Step 6: Commit.** `git add src-tauri/src/media && git commit -m "feat: add lossless-first media planning"`.

## Task 4: Implement the queue scheduler and safe FFmpeg runner

**Files:**
- Create: `src-tauri/src/jobs/mod.rs`
- Create: `src-tauri/src/jobs/scheduler.rs`
- Create: `src-tauri/src/jobs/runner.rs`
- Create: `src-tauri/src/jobs/progress.rs`
- Create: `src-tauri/src/jobs/temp_output.rs`
- Test: `src-tauri/src/jobs/scheduler.rs`
- Test: `src-tauri/src/jobs/temp_output.rs`

- [ ] **Step 1: Write failing scheduler tests.** Cover FIFO ordering, configurable concurrency, pause/resume, single-job cancellation, retry from `Failed`, and prevention of duplicate execution.
- [ ] **Step 2: Implement a bounded scheduler.** Keep queue state behind a mutex, expose commands through methods, and use a cancellation token per running process. Default concurrency is one; settings may raise it only after the core path works.
- [ ] **Step 3: Implement process execution.** Spawn FFmpeg with an argument vector, parse progress output, emit `JobEvent` updates, and map exit codes and stderr into structured errors. The runner must never block the UI thread.
- [ ] **Step 4: Implement atomic output handling.** Create a unique temporary output in the selected destination, fsync/close it after FFmpeg succeeds, rename it to the final path, and remove it on cancellation or failure. Never overwrite the source file.
- [ ] **Step 5: Run Rust job tests and commit.** Run `cargo test --manifest-path src-tauri/Cargo.toml jobs`. Expected: PASS, including cleanup assertions. Commit with `feat: add cancellable conversion queue`.

## Task 5: Wire Tauri commands and backend events

**Files:**
- Create: `src-tauri/src/commands/files.rs`
- Create: `src-tauri/src/commands/queue.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/commands/queue.rs`

- [ ] **Step 1: Add command tests.** Verify selected paths are normalized, unsupported output extensions are rejected, and queue commands return stable error codes.
- [ ] **Step 2: Implement file commands.** `select_files` opens the native picker; `analyze_files` calls the probe service; `open_output_folder` invokes the platform-safe folder opener only for a path previously selected by the user.
- [ ] **Step 3: Implement queue commands.** Register enqueue, pause, resume, cancel, retry, and clear-completed commands. Emit one serialized `job-event` per state/progress change.
- [ ] **Step 4: Run backend tests and commit.** Run `cargo test --manifest-path src-tauri/Cargo.toml commands`. Expected: PASS. Commit with `feat: expose typed conversion commands`.

## Task 6: Build the readable glass workspace shell

**Files:**
- Create: `src/app/AppShell.tsx`
- Create: `src/app/theme.ts`
- Create: `src/ui/GlassPanel.tsx`
- Create: `src/ui/StatusBadge.tsx`
- Create: `src/styles/tokens.css`
- Create: `src/styles/glass.css`
- Modify: `src/app/App.tsx`
- Test: `src/ui/StatusBadge.test.tsx`

- [ ] **Step 1: Write component tests.** Assert status badges render both text and an icon, keyboard focus is visible, and the UI does not rely on color alone.
- [ ] **Step 2: Define visual tokens.** Add system light/dark/auto theme variables, readable type sizes of 14px body and 12px minimum supporting text, spacing, borders, focus rings, reduced-transparency fallback, and high-contrast overrides.
- [ ] **Step 3: Implement the shell.** Add top bar, offline badge, main workspace landmark, settings region, queue region, and status announcements. Keep glass styling in CSS so reduced-transparency and high-contrast modes can disable blur safely.
- [ ] **Step 4: Run frontend checks.** Run `npm run typecheck` and `npm run test -- --run src/ui`. Expected: PASS. Commit with `feat: add accessible glass workspace shell`.

## Task 7: Implement file intake and output settings

**Files:**
- Create: `src/features/intake/DropZone.tsx`
- Create: `src/features/intake/SourceFileList.tsx`
- Create: `src/features/intake/useFileIntake.ts`
- Create: `src/features/settings/OutputSettings.tsx`
- Create: `src/features/settings/AdvancedSettings.tsx`
- Create: `src/features/settings/useConversionSettings.ts`
- Test: `src/features/intake/useFileIntake.test.ts`
- Test: `src/features/settings/useConversionSettings.test.ts`

- [ ] **Step 1: Write failing feature tests.** Cover multiple dropped files, file picker selection, removal before enqueue, supported format choices, four quality presets, lossless-first default, and advanced settings expansion.
- [ ] **Step 2: Implement intake.** Normalize selected paths, request backend analysis, show filename/format/duration metadata, and preserve a stable client id per source file.
- [ ] **Step 3: Implement settings.** Use a controlled settings model with format, preset, mode, codec, bitrate, resolution, frame rate, sample rate, and channels. Hide advanced controls until expanded and reset incompatible fields when the output type changes.
- [ ] **Step 4: Add the start action.** Enqueue a job for each source file using the current settings, then clear only successfully enqueued items. Show backend validation errors inline.
- [ ] **Step 5: Run tests and commit.** Run `npm run test -- --run src/features/intake src/features/settings`. Expected: PASS. Commit with `feat: add file intake and output settings`.

## Task 8: Implement queue UI, progress, and recovery actions

**Files:**
- Create: `src/features/queue/QueuePanel.tsx`
- Create: `src/features/queue/QueueRow.tsx`
- Create: `src/features/queue/useQueueEvents.ts`
- Create: `src/features/queue/queueLabels.ts`
- Create: `src/features/errors/ErrorDetails.tsx`
- Modify: `src/app/AppShell.tsx`
- Test: `src/features/queue/queueLabels.test.ts`
- Test: `src/features/queue/useQueueEvents.test.ts`

- [ ] **Step 1: Write failing queue UI tests.** Cover every backend state, text/icon/color status rendering, progress updates, pause/resume, cancel, retry, reorder, clear-completed, and expandable technical details.
- [ ] **Step 2: Subscribe to backend events.** Maintain a normalized client queue keyed by job id; ignore stale progress events; show `ProcessingKind` as visible text such as “無損封裝” or “重新編碼”.
- [ ] **Step 3: Implement queue actions.** Wire row and global actions to typed IPC wrappers and disable actions that are invalid for the current state.
- [ ] **Step 4: Add accessible announcements.** Announce completion and failure through an `aria-live` region without interrupting normal progress updates.
- [ ] **Step 5: Run tests and commit.** Run `npm run test -- --run src/features/queue`. Expected: PASS. Commit with `feat: add batch queue workspace`.

## Task 9: Add deterministic media fixtures and end-to-end verification

**Files:**
- Create: `tests/fixtures/README.md`
- Create: `scripts/generate-fixtures.ts`
- Create: `tests/e2e/conversion-smoke.spec.ts`
- Create: `tests/e2e/accessibility.spec.ts`
- Create: `tests/e2e/fixtures/.gitkeep`
- Modify: `package.json`

- [ ] **Step 1: Define fixture generation.** The script invokes the pinned FFmpeg test binary with fixed parameters to generate short MP4, MOV, MKV, WebM, AVI, MP3, M4A, WAV, FLAC, and OGG files; it writes a manifest with SHA-256 checksums.
- [ ] **Step 2: Add conversion smoke tests.** Verify MP4 to MP4 selects remux when compatible, MP4 to MP3 selects transcoding, WAV to FLAC selects lossless audio conversion, and unsupported combinations show a structured error.
- [ ] **Step 3: Add UI smoke tests.** Verify drag/drop or picker intake, batch enqueue, progress, cancellation, retry, completion, and output-folder action on a seeded temporary directory.
- [ ] **Step 4: Add accessibility checks.** Verify keyboard traversal, visible focus, minimum text sizes, live announcements, reduced transparency, and high-contrast rendering.
- [ ] **Step 5: Run the verification suite.** Run `npm run fixtures`, `npm run test:e2e`, `npm run typecheck`, and `cargo test --manifest-path src-tauri/Cargo.toml`. Expected: all PASS on a machine with the release FFmpeg test assets.
- [ ] **Step 6: Commit.** `git add tests scripts package.json && git commit -m "test: add media fixtures and desktop smoke tests"`.

## Task 10: Package, license, and release checks

**Files:**
- Create: `scripts/verify-ffmpeg-assets.ts`
- Create: `scripts/check-third-party-licenses.ts`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `.github/workflows/ci.yml`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `docs/releasing.md`

- [ ] **Step 1: Verify bundled assets.** Require one FFmpeg and one FFprobe executable per release target, verify executable permissions, run `-version`, and fail the release job when an asset is absent or its recorded checksum differs.
- [ ] **Step 2: Record licensing.** Generate `THIRD_PARTY_NOTICES.md` from the exact FFmpeg build metadata and bundled libraries; the release check fails when the notice does not match the assets.
- [ ] **Step 3: Configure packaging.** Produce macOS Apple Silicon/Intel artifacts, Windows 64-bit artifacts, and Linux AppImage artifacts. Do not include bundled binaries in ordinary source commits; release assets are injected by the release workflow after license verification.
- [ ] **Step 4: Add CI gates.** CI runs frontend type checks, Vitest, Rust tests, fixture checks, and license verification on pull requests. Release jobs additionally build each target and publish checksums.
- [ ] **Step 5: Document release verification.** `docs/releasing.md` lists the exact commands for local smoke testing, signature/notarization checks, artifact checksums, and manual install verification.
- [ ] **Step 6: Commit.** `git add scripts src-tauri .github THIRD_PARTY_NOTICES.md docs/releasing.md && git commit -m "build: add cross-platform release checks"`.

## Final verification

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run test -- --run`.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml`.
- [ ] Run `npm run fixtures`.
- [ ] Run `npm run test:e2e` on macOS, Windows, and Linux.
- [ ] Run the release asset and license checks for every target.
- [ ] Confirm the MVP acceptance criteria in the design specification before claiming completion.

