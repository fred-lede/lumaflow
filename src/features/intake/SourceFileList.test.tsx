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
});
