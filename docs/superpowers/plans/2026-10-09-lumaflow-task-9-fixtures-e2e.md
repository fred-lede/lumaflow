# LumaFlow Task 9 Fixtures and E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add deterministic FFmpeg media fixtures and a default-runnable Vitest E2E harness that exercises the real media-planning, intake, queue, and accessibility boundaries without fabricating desktop coverage.

**Architecture:** The fixture generator requires an explicitly configured pinned FFmpeg test executable, validates it before doing any work, generates ten short formats with fixed argument vectors, and writes a versioned SHA-256 manifest. `npm run test:e2e` runs Vitest specs that invoke existing Rust planner tests and existing TypeScript controllers/components/CSS; platform desktop checks remain opt-in and fail clearly when requested assets or a runner are unavailable.

**Tech Stack:** Node 26 built-in TypeScript stripping, TypeScript, Vitest, React server rendering, Rust/Cargo tests, FFmpeg, SHA-256.

---

### Task 1: Define the fixture contract and failing deterministic E2E specs

**Files:**
- Create: `tests/fixtures/README.md`
- Create: `tests/e2e/conversion-smoke.spec.ts`
- Create: `tests/e2e/accessibility.spec.ts`
- Create: `tests/e2e/fixtures/.gitkeep`

- [x] Write conversion assertions for the ten-format manifest contract, Rust planner filters for MP4→MP4 remux, MP4→MP3 transcode, WAV→FLAC lossless audio, and structured unsupported errors.
- [x] Write controller/UI boundary assertions for seeded temporary-directory intake, batch enqueue, progress, cancellation, retry, completion, and output-folder calls using the existing real controllers and React components.
- [x] Write accessibility assertions for keyboard-orderable controls, focus CSS, text-size tokens, live regions, reduced-transparency fallback, and high-contrast variables.
- [x] Run `npm run test:e2e` and confirm it fails because the script and test contracts do not yet exist, rather than silently passing.

### Task 2: Implement the pinned FFmpeg fixture generator

**Files:**
- Create: `scripts/generate-fixtures.ts`
- Modify: `package.json`

- [x] Define `LUMAFLOW_FFMPEG_TEST_BIN` as the only accepted binary source, require an executable regular file, run `-version`, and optionally validate `LUMAFLOW_FFMPEG_TEST_VERSION` against the reported version.
- [x] Generate fixed one-second MP4, MOV, MKV, WebM, AVI, MP3, M4A, WAV, FLAC, and OGG outputs through argument arrays with no shell command strings.
- [x] Fail before generation on missing/non-executable/version-mismatched assets and report the exact remediation command.
- [x] Hash generated files with SHA-256 and write `tests/fixtures/manifest.json` containing generator version, binary path-independent version metadata, parameters, relative file names, byte sizes, and checksums.
- [x] Add `fixtures` and `test:e2e` scripts; keep generated media out of the source tree’s tracked test specs.
- [x] Run `npm run fixtures` once without the asset and confirm the expected actionable failure.

### Task 3: Turn the deterministic harness green

**Files:**
- Modify: `tests/e2e/conversion-smoke.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`

- [x] Read and validate the manifest when present; require the fixture command or explicit fixture directory for media-backed checks rather than substituting fake files.
- [x] Use `createFileIntakeController` and `createQueueController` with seeded temporary paths and real state transitions; assert every requested UI behavior and structured error shape.
- [x] Render `App` to static markup and inspect the real CSS source for the accessibility guarantees that cannot be proven by static markup alone.
- [x] Add an opt-in `LUMAFLOW_DESKTOP_E2E=1` gate that checks for the Tauri runner/release assets and emits a clear failure when requested but unavailable; default tests must not silently skip.
- [x] Run `npm run test:e2e` and the focused Vitest specs until they pass.

### Task 4: Verify, self-review, and commit

**Files:**
- All Task 9 files and the implementation plan.

- [x] Run `npm run typecheck`, `npm run test -- --run`, `npm run test:e2e`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `npm run fixtures` with the strongest available asset configuration.
- [x] Inspect `git diff --check`, the final diff, and status for accidental fixture binaries, fake assertions, security-boundary changes, or unrelated edits.
- [x] Commit with `test: add media fixtures and deterministic e2e coverage`.
