# Topbar + Workspace Intro Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-row topbar + workspace-intro band with a single left/right topbar carrying an always-present status chip, per the approved spec.

**Architecture:** Structure change only: `AppShell.tsx` JSX restructure (brand becomes `h1#app-title`, subtitle line, chip state machine, icon-only theme button, intro band deleted) plus `glass.css` cleanup (dead selectors removed, one new subtitle rule). No logic, no new components, no new files.

**Tech Stack:** React 19 + TypeScript, Vite/Vitest (`renderToStaticMarkup` static-render tests), vanilla CSS.

**Spec:** `docs/superpowers/specs/2026-10-12-lumaflow-topbar-workspace-rework-design.md`

## Global Constraints

- No new npm dependencies; no UI framework / CSS-in-JS / animation library.
- Icons are Unicode glyphs only.
- Queue status Chinese labels untouched (「失敗」／「已完成」 asserted by `tests/e2e/accessibility.spec.ts`).
- No changes to conversion / intake / queue / preference logic; no Rust/Tauri changes. `queueProgressSummary` and `StatusBadge` themselves are NOT modified.
- All existing `@media` accessibility branches keep working; colors, fonts, tokens untouched (`tokens.css` is not edited).
- Work on branch `ui-topbar-rework` (branched from `main`); merge to `main` only after whole-branch review, same as round 2.
- Test suite baseline: 153 tests / 18 files green before Task 1.

## Review Focus

1. **Paused + empty queue** → chip must show `✓ Ready`, not `Paused` (state-machine order: paused branch requires `jobs.length > 0`). Pinned by Task 1 test.
2. **Icon-only theme button** → visible text is removed but `aria-label="Change theme, currently {label}"` must survive; `StatusBadge.test.tsx:24` already guards the aria-label, Task 1 adds the icon-only assertion.
3. **`main` accessible name** → `aria-labelledby="app-title"` must still resolve to an existing `h1` (now inside the topbar). Pinned by Task 1 test.
4. **Dead CSS** → no rule may keep referencing `.workspace-intro`, `.topbar-progress`, `.eyebrow`, `.workspace-title` after removal. Pinned by Task 2 grep step.
5. **Narrow screens (≤720px)** → topbar must stack and actions wrap without overflow; CSS-only, verified by the visual check step in Task 2 (no unit test possible).

---

### Task 1: New topbar contract — tests first, then AppShell JSX

**Files:**
- Modify: `src/app/App.test.tsx` (lines 99–134, 639–686)
- Modify: `src/app/AppShell.tsx` (lines 216–266)

**Interfaces:**
- Consumes: `StatusBadge` (`src/ui/StatusBadge.tsx`, unmodified; exports `StatusBadgeStatus = "attention" | "neutral" | "ready" | "working"`), `queueProgressSummary` (unmodified), test helpers already in `App.test.tsx`: `testAppShellProps`, `mediaInfo`, `defaultSettingsForTest`, job-fixture pattern at lines 617–629.
- Produces (Task 2 and the CSS rely on these exact hooks):
  - `.workspace-topbar > .topbar-identity > h1#app-title.brand-name` (text `LumaFlow`) `+ p.topbar-subtitle` (text `Batch media conversion, processed locally`)
  - `.workspace-topbar > .topbar-actions > span.status-badge[data-status] + button.theme-toggle` (icon-only, glyph `◐`)
  - Gone from markup: `.workspace-intro`, `.topbar-progress`, `.eyebrow`, `.workspace-title`, text `Local mode`, text `Ready for files`, text `Convert your media`, visible text `Theme:`.

- [ ] **Step 1: Rewrite the six locked assertions in `App.test.tsx`**

In the test `"renders a root landmark with an accessible heading"` (lines 99–134):
- line 106: replace `const introSupportingText = root.querySelector(".workspace-intro .supporting-text");` with `const topbarSubtitle = root.querySelector(".workspace-topbar .topbar-subtitle");`
- line 113: `workspace-title` → `brand-name`
- line 114: `"Convert your media"` → `"LumaFlow"`
- lines 121–123: `introSupportingText?.textContent` → `topbarSubtitle?.textContent`, expected `"Batch media conversion, processed locally"`

- [ ] **Step 2: Replace the three topbar-integrity tests (lines 639–686)**

Delete the bodies of `"keeps one page-level eyebrow and none inside cards"`, `"shows a neutral local-mode chip instead of a danger offline badge"`, `"shows a conversion counter only while a job is processing"` and write in their place:

```tsx
it("retires the eyebrow system entirely", () => {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(<App />);

  expect(root.querySelectorAll(".eyebrow")).toHaveLength(0);
});

it("shows a ready status chip when idle", () => {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(<App />);

  const topbarBadge = root.querySelector(".workspace-topbar .status-badge");
  expect(topbarBadge?.getAttribute("data-status")).toBe("ready");
  expect(topbarBadge?.textContent).toContain("Ready");
  expect(root.querySelector(".status-badge--offline")).toBeNull();
  expect(root.querySelector(".topbar-progress")).toBeNull();
});

it("swaps the status chip tone with queue activity", () => {
  const busy = document.createElement("div");
  busy.innerHTML = renderToStaticMarkup(
    <AppShell
      {...testAppShellProps}
      initialQueueSnapshot={{
        revision: 1,
        paused: false,
        jobs: [
          {
            id: "j1",
            sourcePath: "/a.mp4",
            media: mediaInfo("/a.mp4"),
            outputSettings: defaultSettingsForTest,
            processingKind: null,
            attempt: 1,
            state: { kind: "transcoding", label: "Transcoding" },
            progress: 0.4,
            outputPath: null,
          },
        ],
      }}
    />,
  );

  const chip = busy.querySelector(".workspace-topbar .status-badge");
  expect(chip?.getAttribute("data-status")).toBe("working");
  expect(chip?.textContent).toContain("Converting 1/1");
  expect(busy.querySelector(".topbar-progress")).toBeNull();
});
```

- [ ] **Step 3: Add the paused-state and icon-only tests**

Append to the same `describe` block (job fixture pattern as in Step 2, but `state: { kind: "queued", label: "Queued" }`):

```tsx
it("shows a paused chip when the queue is paused with jobs", () => {
  // snapshot: { revision: 1, paused: true, jobs: [queued j1] }
  const chip = root.querySelector(".workspace-topbar .status-badge");
  expect(chip?.getAttribute("data-status")).toBe("neutral");
  expect(chip?.textContent).toContain("Paused");
});

it("shows a ready chip when paused with an empty queue", () => {
  // snapshot: { revision: 1, paused: true, jobs: [] }
  const chip = root.querySelector(".workspace-topbar .status-badge");
  expect(chip?.getAttribute("data-status")).toBe("ready");
  expect(chip?.textContent).toContain("Ready");
});

it("keeps the theme button icon-only with its accessible label", () => {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(<App />);

  const themeButton = root.querySelector(".workspace-topbar .theme-toggle");
  expect(themeButton?.textContent).toBe("◐");
  expect(themeButton?.getAttribute("aria-label")).toBe("Change theme, currently Auto");
});
```

- [ ] **Step 4: Run the test file and confirm RED**

Run: `npm test -- --run src/app/App.test.tsx`
Expected: FAIL — the rewritten/replaced tests fail against the old markup (`"Convert your media"` ≠ `"LumaFlow"`, `data-status="neutral"` ≠ `"ready"`, `.topbar-progress` present, `Theme: Auto` text present, `.eyebrow` count 1). Tests that stay valid (brand-name, layout selectors, queue count) keep passing.

- [ ] **Step 5: Restructure the topbar in `AppShell.tsx`**

After `progressSummary` (line 216) add the chip state machine — status literal typed as `StatusBadgeStatus` (import the type: `import { StatusBadge, type StatusBadgeStatus } from "../ui/StatusBadge";`):

```tsx
const topbarStatus: { status: StatusBadgeStatus; label: string } =
  queue.state.paused && queueJobs.length > 0
    ? { status: "neutral", label: "Paused" }
    : progressSummary
      ? { status: "working", label: progressSummary }
      : { status: "ready", label: "Ready" };
```

Replace the `<header className="workspace-topbar">…</header>` block (lines 225–247) with the two-column structure named in Interfaces: identity column (`div.topbar-identity` with `h1#app-title.brand-name` + `p.topbar-subtitle`) and actions column (`div.topbar-actions` with `<StatusBadge status={topbarStatus.status} label={topbarStatus.label} />` + the theme button keeping its existing `onClick`/`aria-label` but containing only `<span aria-hidden="true">◐</span>`). Delete the entire `workspace-intro` div (lines 255–266). `main` keeps `aria-labelledby="app-title"`, `tabIndex={-1}`, and the skip link untouched.

- [ ] **Step 6: Run the test file and confirm GREEN**

Run: `npm test -- --run src/app/App.test.tsx`
Expected: PASS (all tests in the file, including `StatusBadge.test.tsx` guards if run together: `npm test -- --run src/app src/ui`).

- [ ] **Step 7: Commit**

```bash
git add src/app/App.test.tsx src/app/AppShell.tsx
git commit -m "ui: rework topbar into identity/status-chip layout, drop intro band"
```

---

### Task 2: CSS cleanup and new rules

**Files:**
- Modify: `src/styles/glass.css` (lines 74–76, 83–89, 97–104, 137–154, 164–182, 1034–1043)

**Interfaces:**
- Consumes: Task 1's markup hooks `.topbar-identity`, `.topbar-subtitle`, `.brand-name` (now on the `h1`), `.theme-toggle` (icon-only).
- Produces: final stylesheet with no references to removed markup; nothing later tasks consume.

- [ ] **Step 1: Remove dead rules**

- line 75: drop `.workspace-intro,` from the shared flex rule (keep `.topbar-actions` and `.card-heading`).
- line 84: drop `.eyebrow,` from the margin-zeroing rule.
- lines 97–104: delete the `.eyebrow` block.
- lines 137–154: delete the `.topbar-progress` block.
- lines 164–182: delete `.workspace-intro`, `.workspace-title`, and `.workspace-intro .supporting-text` blocks.
- lines 1035–1036: drop `.workspace-intro,` from the `@media (max-width: 720px)` selector list (keep `.workspace-topbar` and the rest of the block).

- [ ] **Step 2: Add the subtitle rule and square the theme button**

After the `.brand-name` block add:

```css
.topbar-subtitle {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--font-size-supporting);
}
```

In `.theme-toggle` (lines 112–130): remove `gap: var(--space-2);` and change `padding: var(--space-2) var(--space-3);` to `padding: var(--space-2);` (keeps `min-height: 2.75rem`, so the icon button stays ≥44px hit area).

- [ ] **Step 3: Verify no dead selectors remain**

Run: `grep -n "workspace-intro\|topbar-progress\|\.eyebrow\|workspace-title" src/styles/glass.css`
Expected: no matches.

- [ ] **Step 4: Full suite + build green**

Run: `npm run typecheck && npm test -- --run && npm run build`
Expected: typecheck clean; 156 tests pass (153 baseline + 3 new; 3 replaced in place); build succeeds.

- [ ] **Step 5: Narrow-screen visual check (Review Focus #5)**

Run `npm run dev`, open at ≤720px width (or DevTools responsive mode): topbar identity stacks above actions, chip and theme button wrap without horizontal overflow, no leftover gap where the intro band used to be.

- [ ] **Step 6: Commit**

```bash
git add src/styles/glass.css
git commit -m "ui: remove intro/topbar-progress/eyebrow styles, add topbar subtitle"
```

---

### Task 3: Whole-branch gate

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything above.
- Produces: a review-ready branch.

- [ ] **Step 1: Full gates**

Run: `npm run typecheck && npm run build && npm test -- --run && npm run check:licenses -- --source-only`
Expected: all green; license gate unchanged (no dependency changes in this plan).

- [ ] **Step 2: Confirm e2e specs are untouched and still consistent**

Run: `npm test -- --run tests/e2e` if the runner covers it; otherwise confirm via `git diff main --stat` that no file under `tests/e2e/` changed.
Expected: zero e2e file changes; Chinese queue labels intact.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin ui-topbar-rework
```

Expected: branch pushed; `main` untouched until whole-branch review passes.
