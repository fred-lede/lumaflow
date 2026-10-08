# LumaFlow third-party notices

LumaFlow distributes FFmpeg and FFprobe as separate release assets. The exact archive, version, provider, and SHA-256 identity are locked in `scripts/ffmpeg-assets.json`; release jobs must verify those values before packaging.

## FFmpeg / FFprobe

FFmpeg is licensed under GPL-3.0-or-later for the selected builds. FFprobe is distributed as part of the same FFmpeg build and has the same licensing obligations. The corresponding FFmpeg source and license text are available from the provider recorded below.

| Release target | FFmpeg version | Provider | Archive SHA-256 | Source |
| --- | --- | --- | --- | --- |
| darwin-arm64 | 8.1.2 | ffmpeg-bins2 / zackees | 842ba18551e73f1f7f0e92408b210503fc9a13b88182db2014fd553bce990895 | https://github.com/zackees/ffmpeg-bins2/releases/download/v8.1.2/darwin_arm64.zip |
| darwin-x64 | 8.1.2 | ffmpeg-bins2 / zackees | 60839c7196d19512e6b1fc9f9f46897a39438e408f4c95c28ebe178d080c038e | https://github.com/zackees/ffmpeg-bins2/releases/download/v8.1.2/darwin_x64.zip |
| windows-x64 | 8.1.2 | GyanD codexffmpeg full build | b8cdefab5f50590a076c27c2b56b0294a0e6154faded28ba1ba05ebc4f801f57 | https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-full_build.zip |
| linux-x64 | 8.1.2 | ffmpeg-bins2 / zackees | 150f20cfa659754115b74c2aa32f0e1aa150d08a14191156875c8efeb5713b29 | https://github.com/zackees/ffmpeg-bins2/releases/download/v8.1.2/linux_x64.zip |

## License handling

Release builds include the upstream license and notice files extracted from the exact verified archive under the packaged resource directory. The release workflow also records the exact `-version`, build configuration, enabled external libraries, and checksums of the two executables in a target-specific generated notice. A missing, stale, or mismatched notice fails the release gate.

The FFmpeg source code is available at [ffmpeg.org](https://ffmpeg.org/) and the provider/source links above. LumaFlow does not commit the release binaries to source control; they are injected into the release job after archive verification.
