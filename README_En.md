# LumaFlow

[繁體中文](README.md) | **English**

LumaFlow is a desktop media conversion tool built with Tauri 2, React, TypeScript and Rust.
FFmpeg and FFprobe ship inside every release target, so conversions do not depend on a system
FFmpeg on the user's machine.

Current version: `0.1.0`.

## Quick start

```sh
git clone https://github.com/fred-lede/lumaflow.git
cd lumaflow
npm ci
npm run tauri dev
```

`npm run tauri dev` runs `npm run prepare:ffmpeg` first, which downloads and verifies the
FFmpeg/FFprobe assets pinned in `scripts/ffmpeg-assets.json` for the current platform. The first
run needs network access; later runs work offline. Supported build hosts are `darwin-arm64`,
`darwin-x64`, `windows-x64` and `linux-x64`; any other host (for example linux-aarch64) fails with
`Unsupported build host`.

`npm run dev` starts the frontend preview only. It has no Tauri file picker, native drag-and-drop
granting, or real conversion — use `npm run tauri dev` to test actual transcoding.

## Requirements

- Node.js 22.6.0 or newer, plus npm
- Rust stable toolchain ([rustup](https://rustup.rs/) recommended); Windows builds need the MSVC
  toolchain (`rustup default stable-msvc`)
- Git
- Platform-native dependencies: Xcode Command Line Tools on macOS; Visual Studio Build Tools and
  the WebView2 Runtime on Windows; WebKitGTK, AppIndicator, librsvg, patchelf and friends on Linux.

Full per-platform setup is in [docs/installation-and-deployment.md](docs/installation-and-deployment.md)
(Traditional Chinese).

## Tests

```sh
npm run typecheck
npm test -- --run
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run check:licenses
```

These are the same gates the CI `check` job runs, and that job blocks merges.

The real-media layer (fixtures plus E2E) needs the pinned assets and locally generated fixtures, and
is whitelisted for `darwin-arm64` and `linux-x64`. In CI this layer is advisory: it reports, it does
not block merges.

```sh
npm run prepare:ffmpeg
export LUMAFLOW_FFMPEG_TEST_BIN="$PWD/src-tauri/binaries/<target>/ffmpeg"
export LUMAFLOW_FFPROBE_TEST_BIN="$PWD/src-tauri/binaries/<target>/ffprobe"
npm run fixtures
cargo test --manifest-path src-tauri/Cargo.toml --test real_media_fixtures
npm run test:e2e
```

`<target>` is `darwin-arm64` or `linux-x64`. Both environment variables must be absolute paths,
because cargo runs the integration-test binary with `src-tauri/` as the working directory. See
[tests/fixtures/README.md](tests/fixtures/README.md) and [docs/releasing.md](docs/releasing.md).

## Build an installer

```sh
npm run tauri build
```

Bundles land in `src-tauri/target/release/bundle/` (`.dmg` on macOS, NSIS `.exe` and `.msi` on
Windows, `.AppImage` on Linux). Release flow, asset verification and signing are covered in
[docs/releasing.md](docs/releasing.md) (Traditional Chinese).

## Repository tour

| Path | Contents |
| --- | --- |
| `src/` | React frontend: `app/`, `domain/`, `features/`, `shared/`, `ui/`, `styles/` |
| `src-tauri/` | Rust backend (`commands/`, `domain/`, `jobs/`, `media/` under `src-tauri/src/`), `Cargo.toml`, `tests/` |
| `scripts/` | FFmpeg asset preparation and verification, fixture generation, license checks |
| `tests/` | Frontend unit tests and `tests/e2e/` |
| `docs/` | Installation and deployment, release process, design documents |
| `.github/workflows/ci.yml` | `check` (blocking), `real-media` (advisory), `release`/`publish` (tag-triggered) |

## License and third-party assets

LumaFlow's source code is released under the [MIT License](LICENSE),
`Copyright (c) 2026 Fred Wang`.

Third-party components such as FFmpeg/FFprobe and the bundled font are **not** covered by that MIT
grant. Their obligations are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and shipped
with the package: the selected FFmpeg builds are GPL-3.0-or-later, and the Geist font is SIL Open
Font License 1.1. The FFmpeg/FFprobe executables are not committed to Git; they are downloaded and
verified by `prepare:ffmpeg` or the release job against the pinned SHA-256 values.
