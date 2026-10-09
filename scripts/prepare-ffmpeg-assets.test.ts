import { describe, expect, it } from "vitest";

import {
  hasMachineLocalMacDependency,
  targetForHost,
} from "./prepare-ffmpeg-assets";

describe("FFmpeg asset preparation", () => {
  it("maps Apple Silicon macOS to the darwin-arm64 release target", () => {
    expect(targetForHost("darwin", "arm64")).toBe("darwin-arm64");
  });

  it("detects Homebrew-linked macOS tools", () => {
    expect(
      hasMachineLocalMacDependency(
        "/opt/homebrew/Cellar/ffmpeg/8.1.2/lib/libavcodec.62.dylib",
      ),
    ).toBe(true);
    expect(
      hasMachineLocalMacDependency(
        "/System/Library/Frameworks/CoreMedia.framework/Versions/A/CoreMedia",
      ),
    ).toBe(false);
  });
});
