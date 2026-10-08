# LumaFlow File Intake and Output Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add backend-authorized file intake, editable output settings, and per-source enqueue behavior to the existing glass workspace.

**Architecture:** `useFileIntake` owns stable source records, path normalization, native picker/drop intake, backend analysis, removal, and enqueue error retention. `useConversionSettings` owns a controlled `OutputSettings` model and format-dependent field resets. Presentational intake/settings components render those models inside the existing AppShell without direct filesystem access.

**Tech Stack:** React 19, TypeScript strict mode, Vitest, typed Tauri wrappers, existing CSS token/glass primitives.

---

### Task 1: Define intake behavior with failing tests

**Files:**
- Create: `src/features/intake/useFileIntake.test.ts`
- Create: `src/features/intake/useFileIntake.ts`

- [ ] Write tests for deduplicated normalized paths, multiple selected files, backend analysis metadata, stable source ids, removal before enqueue, and enqueue validation errors retaining failed sources.
- [ ] Run `npm test -- src/features/intake/useFileIntake.test.ts` and confirm the missing hook fails.

### Task 2: Define settings behavior with failing tests

**Files:**
- Create: `src/features/settings/useConversionSettings.test.ts`
- Create: `src/features/settings/useConversionSettings.ts`

- [ ] Write tests for the lossless-first default, all four quality presets, supported output formats, controlled updates, advanced expansion, and incompatible-field reset when switching audio/video formats.
- [ ] Run `npm test -- src/features/settings/useConversionSettings.test.ts` and confirm the missing hook fails.

### Task 3: Implement hooks minimally and turn tests green

**Files:**
- Modify: `src/features/intake/useFileIntake.ts`
- Modify: `src/features/settings/useConversionSettings.ts`

- [ ] Implement typed adapter injection around `selectFiles`, drop registration, `analyzeFiles`, `selectOutputFolder`, and `enqueueJobs`.
- [ ] Keep one stable client id per source path, preserve successful/failed enqueue results separately, and map backend errors to inline messages.
- [ ] Implement `OutputSettings` updates with format-specific incompatible field clearing.
- [ ] Run both focused test files and then the full frontend test suite.

### Task 4: Build intake and settings components

**Files:**
- Create: `src/features/intake/DropZone.tsx`
- Create: `src/features/intake/SourceFileList.tsx`
- Create: `src/features/settings/OutputSettings.tsx`
- Create: `src/features/settings/AdvancedSettings.tsx`

- [ ] Render keyboard-accessible picker/drop actions, source metadata, remove controls, output folder selection, format/preset controls, and collapsed advanced settings using existing glass tokens.
- [ ] Keep advanced controls hidden until expanded and show backend validation errors inline.

### Task 5: Connect the workspace and verify

**Files:**
- Modify: `src/app/AppShell.tsx`

- [ ] Connect the hooks and components, expose the start conversion action, enqueue one request per source using current settings, and clear only successfully enqueued sources.
- [ ] Run `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Self-review the diff for direct filesystem access, accessibility regressions, and unintended Rust changes.
- [ ] Commit all Task 7 changes with `feat: add file intake and output settings`.
