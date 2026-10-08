# LumaFlow Task 9 Fixtures and E2E Implementation Plan

Goal: add deterministic FFmpeg media fixtures and a default-runnable E2E
harness that exercises the real Rust probe/planner/scheduler boundary and the
real React AppShell/queue renderer boundary. Desktop-only command-bridge and
native-picker checks remain opt-in.

Architecture: a committed trusted fixture spec defines the exact schema,
generator version, parameters, codec vectors, and FFmpeg/FFprobe version and
digest policy. The generator and tests validate manifests against that spec.
The Cargo integration target requires the generated files plus explicit FFmpeg
and FFprobe executables, probes every fixture and completed output, asserts
planner outcomes, runs the real scheduler with RAII cleanup, and serializes
snapshots/events. Vitest keeps tests/e2e out of ordinary unit runs, then feeds
the runtime-validated serialized trace to a Testing Library user-event render
of AppShell without injecting intake or queue command adapters. No fabricated
media or mocked planner/backend response is used.

## Task 1: Fixture contract and red E2E specs

Files:

- Create: tests/fixtures/README.md
- Create: tests/fixtures/spec.json
- Create: tests/fixtures/contract.ts
- Create: tests/e2e/conversion-smoke.spec.ts
- Create: tests/e2e/accessibility.spec.ts
- Create: tests/e2e/fixtures/.gitkeep

- [x] Define the ten-format manifest and checksum contract.
- [x] Commit and validate the trusted generation/version/digest specification.
- [x] Add a real Cargo integration target for FFprobe, planner outcomes, and scheduler trace.
- [x] Add DOM/user-event renderer checks for focus, keyboard activation, queue state replay, and live announcements.
- [x] Add explicit asset checks and a strict opt-in desktop runner protocol.

## Task 2: Pinned FFmpeg fixture generator

Files:

- Create: scripts/generate-fixtures.ts
- Modify: package.json

- [x] Require LUMAFLOW_FFMPEG_TEST_BIN and validate it as an executable regular file.
- [x] Require exact configured FFmpeg version and SHA-256 digest from the trusted spec.
- [x] Generate deterministic MP4, MOV, MKV, WebM, AVI, MP3, M4A, WAV, FLAC, and OGG outputs.
- [x] Record FFmpeg version, fixed parameters, byte sizes, and SHA-256 checksums.
- [x] Validate completed FFmpeg output with FFprobe and clean integration temp directories with Drop.
- [x] Keep generated binaries ignored and fail clearly when the asset is absent.

## Task 3: Deterministic harness

Files:

- Modify: AppShell injection seams
- Modify: tests/e2e harness and specs

- [x] Run the real Rust integration target by default when test assets are configured.
- [x] Keep ordinary npm test isolated from tests/e2e and asset requirements.
- [x] Render AppShell and exercise actual renderer DOM controls with keyboard, focus, click, and user-event interactions.
- [x] Runtime-validate and replay only serialized JobEvents emitted by the real Rust scheduler.
- [x] Gate desktop E2E on LUMAFLOW_DESKTOP_E2E=1, the e2e argument, nonce, exact JSON response, and exit success.

## Task 4: Verification and commit

- [x] Run fixture generation with the strongest available explicit FFmpeg asset.
- [x] Run typecheck, production build, full Vitest, deterministic E2E, and Cargo tests.
- [x] Inspect the diff for fake media, fake backend responses, tracked generated binaries, or security-boundary changes.
- [x] Commit the final implementation after verification.
