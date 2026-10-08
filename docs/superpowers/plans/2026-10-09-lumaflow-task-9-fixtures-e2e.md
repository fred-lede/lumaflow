# LumaFlow Task 9 Fixtures and E2E Implementation Plan

Goal: add deterministic FFmpeg media fixtures and a default-runnable E2E
harness that exercises the real Rust probe/planner/scheduler boundary and the
real React AppShell/intake/queue DOM. Desktop-only checks remain opt-in.

Architecture: the fixture generator requires an explicitly configured pinned
FFmpeg test executable, generates ten short formats with fixed argument
vectors, and writes a versioned SHA-256 manifest. The Cargo integration target
requires the generated files plus explicit FFmpeg and FFprobe executables,
probes every fixture, asserts planner outcomes, runs the real scheduler, and
serializes snapshots/events. Vitest runs that target and feeds its serialized
trace to a Testing Library user-event render of AppShell. No fabricated media
or mocked planner/backend response is used.

## Task 1: Fixture contract and red E2E specs

Files:

- Create: tests/fixtures/README.md
- Create: tests/e2e/conversion-smoke.spec.ts
- Create: tests/e2e/accessibility.spec.ts
- Create: tests/e2e/fixtures/.gitkeep

- [x] Define the ten-format manifest and checksum contract.
- [x] Add a real Cargo integration target for FFprobe, planner outcomes, and scheduler trace.
- [x] Add DOM/user-event tests for intake, batch enqueue, focus, queue actions, and live announcements.
- [x] Add explicit asset checks and a strict opt-in desktop runner protocol.

## Task 2: Pinned FFmpeg fixture generator

Files:

- Create: scripts/generate-fixtures.ts
- Modify: package.json

- [x] Require LUMAFLOW_FFMPEG_TEST_BIN and validate it as an executable regular file.
- [x] Generate deterministic MP4, MOV, MKV, WebM, AVI, MP3, M4A, WAV, FLAC, and OGG outputs.
- [x] Record FFmpeg version, fixed parameters, byte sizes, and SHA-256 checksums.
- [x] Keep generated binaries ignored and fail clearly when the asset is absent.

## Task 3: Deterministic harness

Files:

- Modify: AppShell injection seams
- Modify: tests/e2e harness and specs

- [x] Run the real Rust integration target by default when test assets are configured.
- [x] Render AppShell and exercise actual DOM controls with keyboard, focus, click, and user-event interactions.
- [x] Replay only serialized JobEvents emitted by the real Rust scheduler.
- [x] Gate desktop E2E on LUMAFLOW_DESKTOP_E2E=1, the e2e argument, protocol env, pass marker, and exit success.

## Task 4: Verification and commit

- [x] Run fixture generation with the strongest available explicit FFmpeg asset.
- [x] Run typecheck, production build, full Vitest, deterministic E2E, and Cargo tests.
- [x] Inspect the diff for fake media, fake backend responses, tracked generated binaries, or security-boundary changes.
- [x] Commit the final implementation after verification.
