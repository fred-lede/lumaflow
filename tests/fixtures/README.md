# Deterministic media fixtures

The fixture set is generated locally from one explicitly pinned FFmpeg test
binary. Generated media is intentionally not committed to the repository.

Set `LUMAFLOW_FFMPEG_TEST_BIN` to the release-test FFmpeg executable and run:

```sh
LUMAFLOW_FFMPEG_TEST_BIN=/absolute/path/to/ffmpeg npm run fixtures
```

The generator refuses to use a system `ffmpeg` discovered on `PATH`. It checks
that the configured path is an executable regular file, records the reported
version, generates one-second deterministic MP4, MOV, MKV, WebM, AVI, MP3,
M4A, WAV, FLAC, and OGG files, and writes `manifest.json` with each file's
relative path, byte size, and SHA-256 checksum.

To require a specific pinned build, also set `LUMAFLOW_FFMPEG_TEST_VERSION` to
the exact version string that must occur in `ffmpeg -version` output.

The default `npm run test:e2e` suite requires the generated manifest and fails
with an actionable message when it is absent. This prevents synthetic media or
silently skipped conversion coverage from looking like a passing run.

Desktop-only E2E is not part of the default harness. It is opt-in with
`LUMAFLOW_DESKTOP_E2E=1` and requires a runner supplied through
`LUMAFLOW_TAURI_E2E_RUNNER` plus the release FFmpeg asset. If that opt-in is
requested without those assets, the test fails clearly instead of skipping.
