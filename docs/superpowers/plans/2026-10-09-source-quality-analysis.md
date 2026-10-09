# Source Quality Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add offline source-quality assessment for media analysis without confusing a lossless container with a verified native-lossless source.

**Architecture:** Extend the backend media probe with a structured `sourceQuality` assessment. Metadata evidence is deterministic; a bounded FFmpeg spectral-rolloff sample provides a heuristic signal for lossily transcoded audio. The frontend renders the assessment as an advisory badge and explanation in the source list; conversion remains allowed in every case.

**Tech Stack:** Rust/Tauri, FFprobe, FFmpeg, React/TypeScript, Vitest, Rust unit tests.

---

### Task 1: Define the source-quality contract

**Files:**
- Modify: `src-tauri/src/domain/media.rs`
- Modify: `src/domain/media.ts`
- Test: `src-tauri/src/domain/media.rs`
- Test: `src/domain/job.test.ts`

- [x] **Step 1: Write failing serialization/type tests** for the four statuses: `lossySource`, `likelyNativeLossless`, `possiblyTranscodedLossy`, and `unknown`.
- [x] **Step 2: Run `cargo test -p lumaflow domain::media` and `npm test -- src/domain/job.test.ts`** and confirm the new contract is missing.
- [x] **Step 3: Add `SourceQualityAssessment` and attach it to `MediaInfo` as `sourceQuality`**, using camelCase serde names and a short user-facing summary plus evidence list.
- [x] **Step 4: Run the focused tests and confirm they pass.**

### Task 2: Add backend metadata and spectral heuristics

**Files:**
- Modify: `src-tauri/src/media/probe.rs`
- Modify: `src-tauri/src/domain/media.rs`
- Test: `src-tauri/src/media/probe.rs`
- Test: `src-tauri/src/domain/media.rs`

- [x] **Step 1: Add failing probe tests** proving a known lossy codec is reported as `lossySource`, suspicious encoder metadata is reported as `possiblyTranscodedLossy`, and clean lossless metadata without spectral evidence remains `unknown`.
- [x] **Step 2: Run `cargo test -p lumaflow media::probe`** and confirm the tests fail for the missing assessment.
- [x] **Step 3: Extend the FFprobe request to read format/stream tags and add a bounded FFmpeg `aspectralstats` sample** for the first audio stream, parsing rolloff values without uploading or persisting source media.
- [x] **Step 4: Implement conservative thresholds and evidence strings**; only classify as suspicious when metadata or repeated low spectral rolloff provides evidence, otherwise return `unknown`.
- [x] **Step 5: Run the focused Rust tests and then `cargo test`.**

### Task 3: Display the assessment in the source list

**Files:**
- Modify: `src/features/intake/SourceFileList.tsx`
- Modify: `src/styles/glass.css`
- Test: `src/features/intake/SourceFileList.test.tsx`

- [x] **Step 1: Write a failing rendering test** asserting the source list shows the assessment summary and does not block the remove action.
- [x] **Step 2: Run `npm test -- src/features/intake/SourceFileList.test.tsx`** and verify it fails.
- [x] **Step 3: Render a compact advisory quality badge and an accessible explanation** beneath the existing container/duration/size metadata.
- [x] **Step 4: Add status-specific styles that remain readable in light and dark themes.**
- [x] **Step 5: Run the focused UI tests.**

### Task 4: Full verification

**Files:**
- Modify: any files needed to update existing media fixtures with the required `sourceQuality` field.

- [x] **Step 1: Run `npm test` and `npm run build`.**
- [ ] **Step 2: Run `cargo test --manifest-path src-tauri/Cargo.toml`.** (The existing real-media integration test requires `LUMAFLOW_FFMPEG_TEST_BIN`.)
- [ ] **Step 3: Run the repository release checks that do not require packaged binaries.**
- [x] **Step 4: Review the diff for false certainty, privacy regressions, and accidental conversion blocking.**
- [ ] **Step 5: Commit the verified change with `git commit -am "feat: assess source audio quality"`.**
