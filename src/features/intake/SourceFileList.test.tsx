import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SourceFileList, fileNameForPath } from "./SourceFileList";

describe("SourceFileList filename display", () => {
  it("extracts filenames from both POSIX and Windows paths", () => {
    expect(fileNameForPath("/Users/fred/media/clip.mp4")).toBe("clip.mp4");
    expect(fileNameForPath("C:\\Users\\fred\\media\\clip.mp4")).toBe("clip.mp4");
  });

  it("does not render the full Windows source path", () => {
    const path = "C:\\Users\\fred\\media\\clip.mp4";
    const markup = renderToStaticMarkup(
      createElement(SourceFileList, {
        sources: [
          {
            id: "source-1",
            path,
            media: null,
            status: "analyzing",
            error: null,
          },
        ],
        onRemove: () => undefined,
      }),
    );

    expect(markup).toContain("clip.mp4");
    expect(markup).not.toContain(path);
  });

  it("shows source quality as an advisory assessment", () => {
    const markup = renderToStaticMarkup(
      createElement(SourceFileList, {
        sources: [
          {
            id: "source-1",
            path: "/Users/fred/media/voice.flac",
            media: {
              path: "/Users/fred/media/voice.flac",
              fileName: "voice.flac",
              container: "flac",
              durationSeconds: 12,
              sizeBytes: 1024,
              sourceQuality: {
                status: "possiblyTranscodedLossy",
                summary: "Possibly transcoded from a lossy source",
                evidence: ["The sampled spectral rolloff is unusually low"],
              },
              videoStreams: [],
              audioStreams: [],
              subtitleStreams: [],
            },
            status: "ready",
            error: null,
          },
        ],
        onRemove: () => undefined,
      }),
    );

    expect(markup).toContain("Possibly transcoded");
    expect(markup).toContain("Possibly transcoded from a lossy source");
    expect(markup).toContain("The sampled spectral rolloff is unusually low");
  });
});
