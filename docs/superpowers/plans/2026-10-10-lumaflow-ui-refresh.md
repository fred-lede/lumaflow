# LumaFlow Workspace UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise LumaFlow's workspace UI from a flat single-page tool to a professional dashboard-by-detail: add motion, tighten the radius/elevation language, give the queue full-width placement, remove the card step numbers, and add an idle-invisible topbar conversion counter — without touching any conversion or data-flow logic.

**Architecture:** CSS-only token and rule changes in `src/styles/tokens.css` and `src/styles/glass.css`, plus markup/composition changes in `src/app/AppShell.tsx` and one class rename in `src/features/queue/QueuePanel.tsx`. The global progress counter is a pure helper added to `src/features/queue/queueLabels.ts`, consumed by `AppShell` from the store state that `useQueueEvents` already returns (`queue.state`). No backend, Tauri, or data-flow changes.

**Tech Stack:** React 18, TypeScript, native CSS custom properties, Vitest (jsdom for component tests, node for CSS-text tests), Vite.

**Spec:** `docs/superpowers/specs/2026-10-10-lumaflow-ui-refresh-design.md`

## Global Constraints

- Accessibility media branches MUST remain present and effective: `@media (prefers-contrast: more)`, `@media (prefers-reduced-transparency: reduce)`, `@media (forced-colors: active)`, plus the `.skip-link` and focus-visible rules.
- Baseline test suite is **122 tests / 16 files, all passing**. The count must not decrease. Update assertions to reflect the new structure; never delete a test to make a suite green.
- Do NOT implement any drag-over state; `DropZone.tsx` must not gain drag event handlers.
- Do NOT introduce a UI framework, CSS-in-JS, or animation library.
- Do NOT change `DropZone` file-selection logic, `useFileIntake`, `useQueueEvents`, `useConversionSettings`, Rust, or Tauri commands.
- The global progress node must NOT render when no job is processing (idle topbar appearance is unchanged).
- Exact new token values (copy verbatim): `--radius-sm: 0.5rem`, `--radius-md: 0.75rem`, `--radius-lg: 1rem`, `--radius-pill: 999px`, `--motion-fast: 120ms`, `--motion-base: 180ms`, `--motion-slow: 260ms`, `--ease-standard: cubic-bezier(0.22, 1, 0.36, 1)`, `--shadow-raised: 0 0.5rem 1.5rem rgba(35, 61, 93, 0.08)`, dark `--shadow-raised: 0 0.5rem 1.5rem rgba(0, 0, 0, 0.3)`.

## Review Focus

Uncovered input classes / failure modes the spec implies but no task's own tests exercise; each is pinned by a test in the task named:

1. A user with `prefers-reduced-motion: reduce` must still see a fully usable UI (no stuck mid-transition state) — pinned in Task 2.
2. A user with `prefers-contrast: more` must see NO shadow at all, including the newly added `--shadow-raised` — pinned in Task 1.
3. A queued-but-idle job (`queued` state) must NOT be counted as "converting" — pinned in Task 6.
4. A failed/cancelled/completed-only queue must render no topbar counter (no `"Converting 0/N"` string) — pinned in Task 6.
5. A very long file name in a queue row must not break the new full-width queue layout's horizontal overflow — pinned in Task 4.

---

### Task 1: Design tokens — radius, motion, elevation

**Files:**
- Create: `src/styles/tokens.test.ts`
- Modify: `src/styles/tokens.css:22-24` (radius block), `:29-50` (light `:root`), `:56-79` (dark), `:81-106` (prefers-color-scheme dark), `:108-123` (prefers-contrast)

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties used by Tasks 2-3: `--motion-fast`, `--motion-base`, `--motion-slow`, `--ease-standard`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill`, `--shadow-panel`, `--shadow-raised`.

- [ ] **Step 1: Write the failing test**

```ts
// src/styles/tokens.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "tokens.css"), "utf8");

describe("design tokens", () => {
  it("uses the tightened radius scale", () => {
    expect(css).toContain("--radius-sm: 0.5rem");
    expect(css).toContain("--radius-md: 0.75rem");
    expect(css).toContain("--radius-lg: 1rem");
    expect(css).toContain("--radius-pill: 999px");
  });

  it("defines motion tokens and a decelerate easing curve", () => {
    expect(css).toContain("--motion-fast: 120ms");
    expect(css).toContain("--motion-base: 180ms");
    expect(css).toContain("--motion-slow: 260ms");
    expect(css).toContain("--ease-standard: cubic-bezier(0.22, 1, 0.36, 1)");
  });

  it("defines a raised elevation token", () => {
    expect(css).toContain("--shadow-raised: 0 0.5rem 1.5rem rgba(35, 61, 93, 0.08)");
  });

  it("removes every shadow under prefers-contrast: more", () => {
    const contrastBlock = css.slice(css.indexOf("@media (prefers-contrast: more)"));
    expect(contrastBlock).toContain("--shadow-panel: none");
    expect(contrastBlock).toContain("--shadow-raised: none");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/styles/tokens.test.ts`
Expected: FAIL — `--radius-pill`, `--motion-*`, `--ease-standard`, `--shadow-raised` do not exist yet; radius values are still `0.75rem/1rem/1.5rem`.

- [ ] **Step 3: Implement the token changes in `src/styles/tokens.css`**

Replace the radius block (lines 22-24) and add motion/elevation tokens in the light `:root`:

```css
  --radius-sm: 0.5rem;
  --radius-md: 0.75rem;
  --radius-lg: 1rem;
  --radius-pill: 999px;
  --border-width: 1px;
  --focus-ring-width: 3px;
  --focus-ring-offset: 3px;
  --glass-blur: 22px;
  --motion-fast: 120ms;
  --motion-base: 180ms;
  --motion-slow: 260ms;
  --ease-standard: cubic-bezier(0.22, 1, 0.36, 1);
```

Add `--shadow-raised: 0 0.5rem 1.5rem rgba(35, 61, 93, 0.08);` in the light `:root` immediately after the existing `--shadow-panel` line. Add `--shadow-raised: 0 0.5rem 1.5rem rgba(0, 0, 0, 0.3);` after `--shadow-panel` in BOTH dark blocks (`:root[data-theme="dark"]` and the `@media (prefers-color-scheme: dark)` block). Add `--shadow-raised: none;` after the existing `--shadow-panel: none;` inside `@media (prefers-contrast: more)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/styles/tokens.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/styles/tokens.css src/styles/tokens.test.ts
git commit -m "style: add motion, tightened radius, and raised elevation tokens"
```

---

### Task 2: Motion, interaction states, and radius-pill adoption

**Files:**
- Create: `src/styles/glass.test.ts`
- Modify: `src/styles/glass.css` — add transitions to 8 selectors; replace `999px` at lines 119, 779, 889; add `:hover`/`:active` states; insert a reduced-motion block before the `prefers-reduced-transparency` block (line 980)

**Interfaces:**
- Consumes: tokens from Task 1.
- Produces: nothing consumed by later tasks (pure styling).

- [ ] **Step 1: Write the failing test**

```ts
// src/styles/glass.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "glass.css"), "utf8");

describe("glass styling", () => {
  it("defines motion transitions on the interactive selectors", () => {
    for (const sel of [
      ".button",
      ".theme-toggle",
      ".icon-button",
      ".preset-option",
      ".drop-zone",
      ".source-list__item",
      ".queue-row",
      ".advanced-toggle",
    ]) {
      expect(css, `${sel} should animate`).toContain(`${sel} {`);
    }
    expect(css.match(/var\(--motion-base\) var\(--ease-standard\)/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(css).toContain("transition:");
  });

  it("disables motion under prefers-reduced-motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("transition-duration: 0.01ms !important");
  });

  it("adopts the pill radius token instead of a hardcoded 999px", () => {
    expect(css).not.toContain("border-radius: 999px");
    expect(css.match(/var\(--radius-pill\)/g)?.length ?? 0).toBe(3);
  });

  it("gives the drop zone a hover affordance", () => {
    expect(css).toContain(".drop-zone:hover");
  });

  it("lifts the primary button on hover without a margin change", () => {
    expect(css).toContain(".button--primary:hover:not(:disabled)");
    expect(css).toContain("translateY(-1px)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/styles/glass.test.ts`
Expected: FAIL — no `transition:`, three `border-radius: 999px` still present, no `.drop-zone:hover`, no reduced-motion block, no `translateY(-1px)`.

- [ ] **Step 3: Implement in `src/styles/glass.css`**

Add to each of these existing rules a single `transition` line covering only the properties that change there — `background-color`, `border-color`, `color`, `box-shadow`, `transform` — using `var(--motion-base) var(--ease-standard)`:
`.button` (line ~327), `.theme-toggle` (~112), `.icon-button` (~446), `.preset-option` (~535), `.drop-zone` (~275), `.source-list__item` (~363), `.queue-row` (~716), `.advanced-toggle` (~564).

Replace `border-radius: 999px;` with `border-radius: var(--radius-pill);` at lines 119 (`.theme-toggle`), 779 (`.queue-status`), 889 (`.status-badge`). Do NOT touch line 42 (`left: -9999px`).

Add a drop-zone hover rule after the `.drop-zone` block:

```css
.drop-zone:hover {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}
```

Extend the primary button rules:

```css
.button--primary:hover:not(:disabled) {
  background: var(--color-accent-strong);
  transform: translateY(-1px);
  box-shadow: var(--shadow-raised);
}

.button--primary:active:not(:disabled) {
  transform: translateY(0);
}
```

Insert this block immediately before `@media (prefers-reduced-transparency: reduce)` (line 980):

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/styles/glass.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/styles/glass.css src/styles/glass.test.ts
git commit -m "style: add transitions, hover affordances, and reduced-motion guard"
```

---

### Task 3: Layout CSS — queue full width, card height, dead-code and step-number cleanup

**Files:**
- Modify: `src/styles/glass.css` — delete the `h1` block at lines 145-150; change `min-height: 20rem` at line 221; change `grid-template-areas` at lines 187-191; delete `.card-step` at lines 237-242 and add `.queue-count__value` near the `.queue-count` block (line 687)
- Modify: `src/styles/glass.test.ts` (extend the file from Task 2)

**Interfaces:**
- Consumes: tokens from Task 1.
- Produces: the CSS class `.queue-count__value` that Task 5 applies in `QueuePanel.tsx`.

- [ ] **Step 1: Extend the test with failing assertions**

Append to `src/styles/glass.test.ts`:

```ts
  it("removes the dead h1 rule that .workspace-title overrides", () => {
    expect(css).not.toMatch(/\nh1 \{/);
  });

  it("stops forcing a 20rem card height", () => {
    expect(css).not.toContain("min-height: 20rem");
  });

  it("spans the queue across the full desktop row", () => {
    expect(css).toMatch(/"queue"|"queue  queue"/);
    expect(css).toContain("queue  queue");
  });

  it("drops the card step class and provides a queue-count value class", () => {
    expect(css).not.toContain(".card-step");
    expect(css).toContain(".queue-count__value");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/styles/glass.test.ts`
Expected: FAIL — `h1 {` block present, `min-height: 20rem` present, `grid-area: queue` is on its own line not spanning, `.card-step` rule present, `.queue-count__value` absent.

- [ ] **Step 3: Implement in `src/styles/glass.css`**

- Delete the whole `h1 { margin-top; font-size: 2rem; line-height; letter-spacing }` block (lines 145-150), keeping the `h1` reset group at line 85.
- Change `.workspace-card { ... min-height: 20rem; ... }` (line 221) to `min-height: 0;`.
- In the `@media (min-width: 52rem)` block, change the grid areas to:
  ```css
  grid-template-areas:
    "source settings"
    "queue  queue";
  ```
- Delete the `.card-step { ... }` rule (lines 237-242).
- After the `.queue-count dd { margin: 0; }` rule (line 691), add:
  ```css
  .queue-count__value {
    color: var(--color-text-subtle);
    font-size: var(--font-size-supporting);
    font-variant-numeric: tabular-nums;
    font-weight: var(--font-weight-bold);
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/styles/glass.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/styles/glass.css src/styles/glass.test.ts
git commit -m "style: full-width queue row, content-driven card height, drop step numbers"
```

---

### Task 4: Compose the queue as a full-width layout child

**Files:**
- Modify: `src/app/AppShell.tsx:257-329` (the `workspace-layout` block)
- Modify: `src/app/App.test.tsx:93-131` (structure assertions)

**Interfaces:**
- Consumes: `.queue-count__value` CSS from Task 3 is irrelevant here; this task only moves markup.
- Produces: `.queue-panel` as a direct child of `.workspace-layout`, ordered after `.workspace-settings-column`. Task 6 relies on this DOM order being stable when it adds the topbar node.

- [ ] **Step 1: Update the failing assertions in `src/app/App.test.tsx`**

Replace line 116:

```ts
    expect(sourceColumn?.querySelectorAll(".queue-panel")).toHaveLength(0);
```

Replace the block at lines 124-130 with:

```ts
    const layoutChildren = Array.from(layout.children);
    expect(layoutChildren.indexOf(sourceColumn)).toBeLessThan(layoutChildren.indexOf(settingsColumn));
    expect(layoutChildren.indexOf(settingsColumn)).toBeLessThan(layoutChildren.indexOf(queuePanel));
    expect(queuePanel.parentElement).toBe(layout);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/app/App.test.tsx`
Expected: FAIL — `.queue-panel` is still a child of `.workspace-source-column`, so `querySelectorAll(".queue-panel")` returns 1 and `queuePanel.parentElement` is the source column.

- [ ] **Step 3: Move the `QueuePanel` in `src/app/AppShell.tsx`**

Move `<QueuePanel controller={queue.controller} />` out of `.workspace-source-column` and place it as the last child of `.workspace-layout`, after the `.workspace-settings-column` div. The source column then contains only the source `GlassPanel`. Resulting order inside `.workspace-layout`: source column, settings column, `QueuePanel`. Do not change any props, the DropZone, SourceFileList, OutputSettings, or the action row.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/app/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify no horizontal overflow with a long name**

Add to `src/app/App.test.tsx` a case that renders a source with a 300-character `fileName` and asserts the static markup contains the full-width queue without the source column wrapper:

```ts
  it("keeps a long file name out of the full-width queue structure", () => {
    const longName = `${"x".repeat(300)}.mp4`;
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(<App initialQueueSnapshot={{
      revision: 1,
      paused: false,
      jobs: [{ id: "j1", sourcePath: `/src/${longName}`, media: mediaInfo(`/src/${longName}`),
        outputSettings: defaultSettingsForTest, processingKind: null, attempt: 1,
        state: { kind: "queued", label: "Queued" }, progress: 0, outputPath: null }],
    }} />);

    expect(root.querySelector(".queue-panel")).not.toBeNull();
    expect(root.querySelector(".queue-panel")?.closest(".workspace-source-column")).toBeNull();
  });
```

`mediaInfo(path)` already exists in this test file. Add this fixture near the top of `src/app/App.test.tsx` (shared with Task 6) so `OutputSettings` is structurally complete:

```ts
const defaultSettingsForTest: OutputSettings = {
  outputDirectory: "",
  format: "mp3",
  quality: "original",
  losslessFirst: true,
  codec: null,
  bitrateKbps: null,
  width: null,
  height: null,
  frameRate: null,
  sampleRateHz: null,
  channels: null,
};
```

Import `OutputSettings` from `../domain/media`.

Run: `npm test -- --run src/app/App.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/AppShell.tsx src/app/App.test.tsx
git commit -m "ui: place the queue as a full-width workspace row"
```

---

### Task 5: Remove card step numbers and collapse the topbar eyebrow

**Files:**
- Modify: `src/app/AppShell.tsx:221` (topbar eyebrow), `:263-268` and `:288-293` (card step spans)
- Modify: `src/features/queue/QueuePanel.tsx:160` (count class)
- Modify: `src/app/App.test.tsx` (new assertions)

**Interfaces:**
- Consumes: `.queue-count__value` CSS from Task 3.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Add to `src/app/App.test.tsx`:

```ts
  it("renders no card step numbers and keeps the queue count semantically separate", () => {
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(<App />);

    expect(root.querySelector(".card-step")).toBeNull();
    expect(root.querySelector(".brand-name")?.textContent).toBe("LumaFlow");
    expect(root.querySelectorAll(".workspace-topbar .eyebrow")).toHaveLength(0);
    expect(root.querySelector(".queue-count__value")).not.toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/app/App.test.tsx`
Expected: FAIL — two `.card-step` nodes exist, the topbar has one `.eyebrow`, and `.queue-count__value` is absent.

- [ ] **Step 3: Implement**

- In `src/app/AppShell.tsx`, delete the `<p className="eyebrow">Lossless-first media converter</p>` (line 221) so the brand block contains only `.brand-name`.
- Delete both `<span className="card-step" aria-hidden="true">01</span>` and `...>02</span>` blocks (lines 263-268 and 288-293), keeping the surrounding `.card-heading` divs valid.
- In `src/features/queue/QueuePanel.tsx` line 160, change `className="card-step"` to `className="queue-count__value"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/app/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/AppShell.tsx src/features/queue/QueuePanel.tsx src/app/App.test.tsx
git commit -m "ui: remove card step numbers and duplicate topbar eyebrow"
```

---

### Task 6: Global conversion counter in the topbar

**Files:**
- Modify: `src/features/queue/queueLabels.ts` (add `isProcessingJob` and `queueProgressSummary`)
- Modify: `src/features/queue/queueLabels.test.ts` (new cases)
- Modify: `src/app/AppShell.tsx` (render the counter from `queue.state`)
- Modify: `src/app/App.test.tsx` (render assertions)

**Interfaces:**
- Consumes: `queue.state` from `useQueueEvents` (already returned; type `QueueClientState` with `order: string[]` and `jobsById: Record<string, QueueJob>`).
- Produces:
  - `isProcessingJob(kind: JobState["kind"]): boolean` — true for `analyzing`, `losslessRemux`, `losslessAudio`, `transcoding`; false for `queued`, `completed`, `cancelled`, `failed`.
  - `queueProgressSummary(jobs: QueueJob[]): string | null` — returns `"Converting <processing>/<total>"` when at least one job is processing, otherwise `null`.

- [ ] **Step 1: Write the failing unit test**

Add to `src/features/queue/queueLabels.test.ts`:

```ts
describe("queueProgressSummary", () => {
  const job = (kind: JobState["kind"], id: string): QueueJob =>
    ({ id, sourcePath: `/a/${id}`, media: {} as never, outputSettings: {} as never,
       processingKind: null, attempt: 1, state: { kind, label: "" } as JobState,
       progress: 0, outputPath: null });

  it("counts only actively processing jobs", () => {
    const jobs = [job("transcoding", "1"), job("analyzing", "2"), job("queued", "3")];
    expect(queueProgressSummary(jobs)).toBe("Converting 2/3");
  });

  it("returns null when nothing is processing", () => {
    expect(queueProgressSummary([job("queued", "1"), job("completed", "2")])).toBeNull();
    expect(queueProgressSummary([])).toBeNull();
  });

  it("does not treat terminal states as processing", () => {
    expect(isProcessingJob("completed")).toBe(false);
    expect(isProcessingJob("failed")).toBe(false);
    expect(isProcessingJob("cancelled")).toBe(false);
    expect(isProcessingJob("losslessRemux")).toBe(true);
  });
});
```

Add `QueueJob` to the existing `../../domain/job` type import and `isProcessingJob`, `queueProgressSummary` to the `./queueLabels` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/features/queue/queueLabels.test.ts`
Expected: FAIL — `queueProgressSummary` and `isProcessingJob` are not exported.

- [ ] **Step 3: Implement in `src/features/queue/queueLabels.ts`**

Add `QueueJob` to the domain import, then:

```ts
export function isProcessingJob(kind: JobState["kind"]): boolean {
  return ["analyzing", "losslessRemux", "losslessAudio", "transcoding"].includes(kind);
}

export function queueProgressSummary(jobs: QueueJob[]): string | null {
  const processing = jobs.filter((job) => isProcessingJob(job.state.kind)).length;
  if (processing === 0) {
    return null;
  }
  return `Converting ${processing}/${jobs.length}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/features/queue/queueLabels.test.ts`
Expected: PASS.

- [ ] **Step 5: Render the counter in `src/app/AppShell.tsx`**

In `AppShell`, derive the job list from the store state already returned by `useQueueEvents`:

```tsx
const queueJobs = queue.state.order
  .map((jobId) => queue.state.jobsById[jobId])
  .filter((job): job is NonNullable<typeof job> => job !== undefined);
const progressSummary = queueProgressSummary(queueJobs);
```

Import `queueProgressSummary` from `../features/queue/queueLabels`. In `.topbar-actions`, render the node only when non-null, before the theme toggle and after the `Offline mode` badge:

```tsx
{progressSummary ? (
  <p className="topbar-progress">
    <span aria-hidden="true">↻</span>
    <span>{progressSummary}</span>
  </p>
) : null}
```

The node must NOT use `role="note"`. Add a `.topbar-progress` rule to `src/styles/glass.css` mirroring `.status-badge`'s pill styling but without a status icon dot, plus the token-driven transition from Task 2.

- [ ] **Step 6: Write the render assertion**

Add to `src/app/App.test.tsx`:

```ts
  it("shows a conversion counter only while a job is processing", () => {
    const idle = document.createElement("div");
    idle.innerHTML = renderToStaticMarkup(<App />);
    expect(idle.querySelector(".topbar-progress")).toBeNull();

    const busy = document.createElement("div");
    busy.innerHTML = renderToStaticMarkup(<App initialQueueSnapshot={{
      revision: 1, paused: false,
      jobs: [{ id: "j1", sourcePath: "/a.mp4", media: mediaInfo("/a.mp4"),
        outputSettings: defaultSettingsForTest, processingKind: null, attempt: 1,
        state: { kind: "transcoding", label: "Transcoding" }, progress: 0.4, outputPath: null }],
    }} />);
    expect(busy.querySelector(".topbar-progress")?.textContent).toContain("Converting 1/1");
  });
```

Run: `npm test -- --run src/app/App.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/queue/queueLabels.ts src/features/queue/queueLabels.test.ts src/app/AppShell.tsx src/app/App.test.tsx src/styles/glass.css
git commit -m "feat: show a global conversion counter in the topbar"
```

---

### Task 7: Full verification and accessibility branch check

**Files:**
- Modify: none.
- Test: the whole suite plus manual CSS inspection.

- [ ] **Step 1: Run the full unit suite**

Run: `npm test -- --run`
Expected: PASS, and total tests ≥ 122 (baseline) plus the new CSS/unit/render cases. No test removed.

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0; Vite build completes with no TS errors.

- [ ] **Step 3: Confirm the accessibility branches still exist**

Run: `grep -n "prefers-contrast\|prefers-reduced-motion\|prefers-reduced-transparency\|forced-colors" src/styles/glass.css src/styles/tokens.css`
Expected: all four media features present; `prefers-contrast` block contains both `--shadow-panel: none` and `--shadow-raised: none`.

- [ ] **Step 4: Manual visual acceptance**

Start the app (`npm run tauri dev`) and verify:
- Desktop ≥52rem: queue spans the full width below the source/settings row; the source card shows no dead space with one file; hovering a button/row animates; the primary button lifts on hover; the topbar is unchanged when idle.
- Narrow ≤720px: single column, controls do not clip.
- Toggle OS `Reduce motion` and `Increase contrast`: transitions stop and all shadows disappear.
- Check light and dark themes once each.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: verify UI refresh against full suite and a11y branches"
```
