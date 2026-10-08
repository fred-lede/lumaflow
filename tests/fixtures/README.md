# Deterministic media fixtures

The fixture set is generated locally from one explicitly pinned FFmpeg test
binary. Generated media is intentionally not committed to the repository.

Set LUMAFLOW_FFMPEG_TEST_BIN to the release-test FFmpeg executable and run:

    LUMAFLOW_FFMPEG_TEST_BIN=/absolute/path/to/ffmpeg npm run fixtures

The generator refuses to use a system ffmpeg discovered on PATH. It checks
that the configured path is an executable regular file, records the reported
version, generates one-second deterministic MP4, MOV, MKV, WebM, AVI, MP3,
M4A, WAV, FLAC, and OGG files, and writes manifest.json with each file's
relative path, byte size, and SHA-256 checksum.

To require a specific pinned build, also set LUMAFLOW_FFMPEG_TEST_VERSION to
the exact version string that must occur in ffmpeg -version output.

The default npm run test:e2e suite requires the generated manifest and both
explicit FFmpeg and FFprobe test executables:

    LUMAFLOW_FFMPEG_TEST_BIN=/absolute/path/to/ffmpeg \
    LUMAFLOW_FFPROBE_TEST_BIN=/absolute/path/to/ffprobe \
    npm run test:e2e

It invokes the real Cargo integration target
real_fixture_probe_and_planner_matrix_and_ui_trace. That target runs FFprobe
against every generated media file, exercises the Rust planner's
remux/transcoding/lossless/unsupported branches, runs the real FFmpeg
scheduler, and emits serialized queue snapshots/events consumed by the React
user-event harness. No text placeholders or mocked planner/backend responses
are accepted.

The UI harness renders the real AppShell, intake, settings, and queue
components in jsdom and uses keyboard, focus, click, and DOM interaction
through Testing Library. npm run test:e2e remains deterministic but fails
with an actionable asset error when fixtures or pinned binaries are absent; it
never silently skips conversion coverage.

Desktop-only E2E is not part of the default harness. It is opt-in with
LUMAFLOW_DESKTOP_E2E=1 and requires an executable runner supplied through
LUMAFLOW_TAURI_E2E_RUNNER, plus both release FFmpeg and FFprobe assets. The
runner protocol is strict: the test invokes the executable as runner e2e with
LUMAFLOW_DESKTOP_E2E_PROTOCOL=1 and
LUMAFLOW_DESKTOP_E2E_PASS_MARKER=LUMAFLOW_DESKTOP_E2E_PASS; it must exit
successfully and write that exact marker to stdout. A missing asset, arbitrary
executable, wrong argument, missing marker, or non-zero exit fails the test
instead of being treated as a skip.
