# LumaFlow release verification

For development setup, local installation, platform prerequisites, and end-user
installation, see [installation-and-deployment.md](installation-and-deployment.md).

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
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
msrv="$(sed -nE 's/^[[:space:]]*rust-version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' src-tauri/Cargo.toml | head -n1)"
cargo +"$msrv" check --manifest-path src-tauri/Cargo.toml --locked --all-targets
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
after generating the trusted fixtures with the matching macOS ARM / Linux x64
test assets. Non-whitelisted platforms are explicitly refused with an error
message rather than silently accepted.

```sh
LUMAFLOW_FFMPEG_TEST_BIN=/absolute/path/to/ffmpeg \
LUMAFLOW_FFPROBE_TEST_BIN=/absolute/path/to/ffprobe \
cargo test --manifest-path src-tauri/Cargo.toml --test real_media_fixtures
```

## real-media advisory policy

The `real-media` job in the CI workflow is advisory. A failure turns the job red,
writes a workflow warning, and appends to the step summary, but the workflow
stays green and the merge is not blocked.

While the job is advisory, never mark `Real-media boundary (advisory)` as a
required check. Branch protection evaluates the job's check conclusion
directly, so a red advisory job would block merges even though the workflow
result itself is green.

Promotion rule: after ten consecutive green runs on `main`, remove
`continue-on-error: true` from the job and mark it required. Until then, a red
real-media run is handled with fix-or-file discipline: fix the underlying
failure, or open an issue that records why it stays red. If the red light comes
from an assertion that is too narrow rather than a real defect, widening the
assertion requires a written rationale in the commit message.

## Rust formatting and clippy gates

`cargo fmt --manifest-path src-tauri/Cargo.toml --all --check` and
`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
run inside the blocking `check` job. They are deterministic — the same tree
always produces the same result — so they gate merges directly instead of
starting out advisory the way the real-media layer did.

A formatting failure is resolved by running `cargo fmt --all` and committing the
reformat separately from any semantic change. A new clippy warning is fixed in
the code; suppressing one in place requires a written rationale in the commit
message.

## Rust MSRV gate

`src-tauri/Cargo.toml` declares `rust-version`. The `msrv` job reads that value out of the
manifest, installs exactly that toolchain with rustup, and compiles every target with it:

```sh
cargo +1.88.0 check --manifest-path src-tauri/Cargo.toml --locked --all-targets
```

Reading the version from the manifest is what keeps the declaration and the gate from drifting
apart. `--all-targets` is load-bearing: plain `cargo check` skips `#[cfg(test)]` code entirely,
so test targets would otherwise never be compiled on the MSRV toolchain. `--locked` makes the
gate reproducible — it builds the committed dependency graph rather than whatever a fresh
resolve would pick today — so a failure that names the lock file means a `Cargo.lock` commit is
missing, not that the MSRV moved.

The gate is deterministic, so it is blocking by design the way fmt and clippy are. Mark
`Rust MSRV gate` (the job's display name) as a required check, unlike
`Real-media boundary (advisory)` and `Rust test soak (advisory)`, which must never be required
while advisory. `main` has no branch protection configured today, so every gate in this
workflow — `check` included — is currently enforced by review plus green CI rather than by
GitHub; the required-check list is what turns "blocking" from a policy into a rule.

The declared number is a measurement of the committed `Cargo.lock`, not a preference: it is the
highest `rust-version` declared by any package in the graph (1.88.0 today). The graph is
separately bounded below by its edition 2024 packages, which need Cargo 1.85 or newer; that
bound is subsumed by 1.88.0 today, and becomes the binding floor if the 1.88 packages are ever
pinned back.

Two limits to know about. The gate builds the Linux target only, so a package that sits in the
lock graph but never compiles on Linux can raise the measured floor without the gate ever
exercising it, and a Windows-only MSRV violation is invisible to it. And the gate proves the
declared floor *compiles*; it does not run the suite on that toolchain, because a blocking job
stays blocking only while it is deterministic. Runtime drift between the MSRV and current stable
is caught by the `check` and soak jobs on stable, not here.

When this job goes red, the fix is chosen by which side moved:

- Our own code used a std API newer than the declared MSRV. Fix the code so it builds on the
  declared version; this is the case the gate exists for.
- A dependency bump raised the real floor. Cargo names the offending packages
  (`darling@0.23.0 requires rustc 1.88.0`). Raise `rust-version` to the measured floor, or pin
  the dependency that moved, and record the measurement in the commit message.
- Never lower the declared number to make the job pass, and do not convert this job to advisory:
  a floor that nothing builds against is exactly the drift this gate was added to catch.

The job also prints the measured floor next to the declared one. A `::warning::` saying the
declaration sits above the measured floor means the manifest restricts contributors for free:
lower it, or record why the headroom is wanted.

To re-measure the floor, then confirm it by building:

```sh
cargo metadata --locked --format-version 1 --manifest-path src-tauri/Cargo.toml |
  jq -r '.packages[].rust_version // empty' | sort -V | tail -1
cargo +1.88.0 check --manifest-path src-tauri/Cargo.toml --locked --all-targets
```

## Rust test soak advisory policy

The `rust-test-soak` job runs the Rust lib suite 400 times: it builds the test
binary once and then runs it 100 times at each of `--test-threads` 1, 16, 64 and
128, under a 10-minute wall-clock budget inside the step. It is advisory: a
failure turns the job red, writes a workflow warning, and appends the run,
failure and truncation counts to the step summary, but the workflow stays green
and the merge is not blocked.

While the job is advisory, never mark `Rust test soak (advisory)` as a required
check, for the same reason as the real-media job: branch protection evaluates
the job's own conclusion.

This job has no promotion rule. Its purpose is to catch a timing race that a
single run at the default thread count does not reproduce, so a red soak run is
investigated as a signal rather than treated as a gate. A soak failure is
handled with fix-or-file discipline: fix the underlying race, or open an issue
that records why the soak stays red.
