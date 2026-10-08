# Deterministic media fixtures

The fixture set is generated locally from one explicitly pinned FFmpeg test
binary. Generated media is intentionally not committed to the repository.
Node 22.6.0 or newer is required because the fixture command uses
node --experimental-strip-types.

The committed spec.json is the trust anchor. It defines schema 2, generator
version 2, exact one-second generation parameters, all ten formats and codec
arguments, and exact FFmpeg/FFprobe version policy (8.1.2 in this repository).
It also contains immutable SHA-256 identities for supported release assets.
The current committed asset table supports `darwin-arm64`; other platforms fail
clearly until their exact release binary digests are committed. A caller may
select a binary path, but cannot supply or override its expected digest.

Set the release-pinned binary paths explicitly:

    export LUMAFLOW_FFMPEG_TEST_BIN=/absolute/path/to/ffmpeg
    export LUMAFLOW_FFPROBE_TEST_BIN=/absolute/path/to/ffprobe
    npm run fixtures

The generator refuses to use a system ffmpeg discovered on PATH. It checks
that the configured executable's version and digest match the committed trusted
spec, generates
MP4, MOV, MKV, WebM, AVI, MP3, M4A, WAV, FLAC, and OGG files, and writes
manifest.json with the exact tool version, binary digest, byte sizes, and
SHA-256 checksum for every fixture.

The ordinary npm test command excludes tests/e2e and therefore runs without
FFmpeg environment variables. The explicit npm run test:e2e command requires
the generated manifest and both validated test binaries:

    npm test -- --run
    npm run test:e2e

The E2E command invokes the real Cargo integration target
real_fixture_probe_and_planner_matrix_and_ui_trace. That target runs FFprobe
against every generated media file, exercises the Rust planner's
remux/transcoding/lossless/unsupported branches, runs the real FFmpeg
scheduler, verifies the completed output by probing it again, and emits
serialized queue snapshots/events. The React harness validates that trace at
runtime before rendering the real AppShell, settings, and queue components in
jsdom. The accessibility test consumes the Rust trace's initial snapshot and
serialized events; it does not inject intake, queue, retry, cancellation, or
output-folder adapters. It uses Testing Library user-event keyboard, focus,
Enter, Space, click, and DOM interactions. This is renderer integration
coverage: it does not exercise the Tauri command bridge or native file picker,
which remain in the opt-in desktop runner. No text placeholders or mocked
planner/backend responses are accepted.

This is renderer integration coverage, not a full desktop renderer-to-Tauri
run. Full desktop coverage is opt-in with LUMAFLOW_DESKTOP_E2E=1 and requires
an executable runner supplied through LUMAFLOW_TAURI_E2E_RUNNER.

The desktop runner protocol is strict. The test invokes the executable as
runner e2e and supplies LUMAFLOW_DESKTOP_E2E_PROTOCOL=1 and a fresh
LUMAFLOW_DESKTOP_E2E_NONCE value. The runner must write exactly one non-empty
JSON line to stdout with this shape, using the same nonce:

    {"protocol":"lumaflow.desktop-e2e","protocolVersion":1,"nonce":"<nonce>","result":"pass"}

Additional stdout lines, substring markers, a different nonce, extra JSON
fields, malformed JSON, or a non-zero exit status fail the test. Missing
assets fail clearly rather than being silently skipped.
