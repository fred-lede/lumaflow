import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders a root landmark with an accessible heading", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('aria-labelledby="app-title"');
    expect(markup).toContain('<h1 id="app-title">LumaFlow</h1>');
  });
});
