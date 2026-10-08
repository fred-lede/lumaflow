# LumaFlow release verification

Release binaries are never committed to this repository. The release workflow
downloads the exact archive recorded in `scripts/ffmpeg-assets.json`, verifies
its SHA-256 digest, extracts one FFmpeg and one FFprobe executable for the
target, and checks both tools with `-version` before Tauri packaging.

Supported release targets:

- `darwin-arm64`: macOS Apple Silicon DMG
- `darwin-x64`: macOS Intel DMG
- `windows-x64`: Windows NSIS installer
- `linux-x64`: Linux AppImage

The release lock pins FFmpeg/FFprobe 8.1.2 and one immutable source archive
identity for each target. Update the lock, source notice, and this document
together when changing the provider or version.

## Local checks

Install dependencies and run the source-level gates:

```sh
npm ci
npm run typecheck
npm run test -- --run
cargo test --manifest-path src-tauri/Cargo.toml --lib
node --experimental-strip-types scripts/check-third-party-licenses.ts --source-only
```

To validate a release asset directory, place the extracted tools at
`src-tauri/binaries/<target>/ffmpeg` and `ffprobe` (with `.exe` on Windows),
keep the downloaded archive at `src-tauri/binaries/<target>/`, and add the upstream
license/notice files under the target's `licenses/` directory. Capture the
exact build configuration before checking the notice:

```sh
target=darwin-arm64
asset_dir="src-tauri/binaries/$target"
archive="src-tauri/binaries/$target/darwin_arm64.zip"
"$asset_dir/ffmpeg" -buildconf > "$asset_dir/ffmpeg-buildconf.txt"

node --experimental-strip-types scripts/verify-ffmpeg-assets.ts \
  --target "$target" --asset-dir "$asset_dir" --archive "$archive"
node --experimental-strip-types scripts/check-third-party-licenses.ts \
  --target "$target" --asset-dir "$asset_dir" --archive "$archive" --write
node --experimental-strip-types scripts/check-third-party-licenses.ts \
  --target "$target" --asset-dir "$asset_dir" --archive "$archive"
```

The check fails if the asset directory, archive, executable permission,
`-version` output, archive checksum, build metadata, license files, or target
notice is missing or does not match the lock.

## Packaging

Build the target bundle only after the asset and notice checks pass:

```sh
npm exec -- tauri build --bundles dmg       # macOS
npm exec -- tauri build --bundles nsis      # Windows
npm exec -- tauri build --bundles appimage  # Linux
```

The Tauri configuration packages `src-tauri/binaries/**/*` and the root
notice as resources. The target-specific generated notice remains alongside
the two bundled tools so an installed build can be audited without source
checkout access.

## Signing and notarization

On macOS, sign the app and DMG using the configured Developer ID identities,
then verify the result before publishing:

```sh
codesign --verify --deep --strict --verbose=2 "LumaFlow.app"
spctl --assess --type execute --verbose=4 "LumaFlow.app"
xcrun stapler validate "LumaFlow.dmg"
```

`spctl` and `stapler validate` must be run on the final signed/notarized
artifacts, not on an intermediate build directory. Windows signing is checked
with:

```powershell
Get-AuthenticodeSignature .\LumaFlow_*.exe
```

The signature status must be `Valid` and identify the expected publisher.

## Artifact checksums and install smoke tests

The release matrix writes one checksum file per target. Recompute and compare
the checksums after downloading artifacts:

```sh
shasum -a 256 -c checksums-darwin-arm64.sha256
sha256sum -c checksums-linux-x64.sha256
```

On Windows, compare `Get-FileHash -Algorithm SHA256` with the published
`checksums-windows-x64.sha256` entry. Install each artifact on a clean target
machine, launch LumaFlow, import a small media file, run a conversion, and
confirm the output is written without requiring a system FFmpeg installation.
For Linux, also verify the AppImage is executable and reports its embedded
runtime version:

```sh
chmod +x LumaFlow_*.AppImage
./LumaFlow_*.AppImage --appimage-version
```

Do not publish a target when its asset or license gate is skipped. A missing
release asset is an intentional hard failure, not permission to fall back to
`ffmpeg` or `ffprobe` from `PATH`.

The real-media Rust integration test is intentionally asset-gated. Run it only
after generating the trusted fixtures with the matching macOS ARM test assets:

```sh
LUMAFLOW_FFMPEG_TEST_BIN=/absolute/path/to/ffmpeg \
LUMAFLOW_FFPROBE_TEST_BIN=/absolute/path/to/ffprobe \
cargo test --manifest-path src-tauri/Cargo.toml --test real_media_fixtures
```
