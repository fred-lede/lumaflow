# LumaFlow UI polish round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the eight round-2 audit findings (dark-mode CTA contrast, self-hosted font, eyebrow restraint, tabular numerals, neutral local-mode badge, press feedback, row entry reveals, `100dvh`) without touching conversion/queue logic.

**Architecture:** All changes stay in the existing native-CSS token system (`tokens.css` + `glass.css`) and the existing React components. Markup changes (eyebrows, badge) are TDD'd through `App.test.tsx` / `StatusBadge.test.tsx`; pure-CSS changes are verified by build + the manual checklist. The font is a committed asset, not a dependency.

**Tech Stack:** React 19, Vite 8, vanilla CSS custom properties, vitest + testing-library, `scripts/check-third-party-licenses.ts` notice gate.

**Spec:** `docs/superpowers/specs/2026-10-12-lumaflow-ui-polish-round2-design.md`

## Global Constraints

- No new npm dependencies; no UI framework, CSS-in-JS, or animation library (native CSS only).
- No icon-library adoption; Unicode glyphs stay except the badge icon change in Task 4.
- Queue status labels stay Chinese (`待處理`, `已完成`, …) — asserted by `tests/e2e/accessibility.spec.ts`.
- No changes to intake/queue/settings data flow, `useFileIntake`, `useQueueEvents`, `useConversionSettings`, or Rust/Tauri code.
- All existing `@media` accessibility branches (`prefers-contrast: more`, `prefers-reduced-transparency: reduce`, `prefers-reduced-motion: reduce`, `forced-colors: active`, `.skip-link`, focus-visible, `.sr-only`) must keep working.
- Unit suite baseline **150 tests / 18 files** green; `npm run typecheck`, `npm run build`, `npm run check:licenses -- --source-only` must pass after every task.

## Review Focus

- **Dark-mode CTA readability:** white-on-`#89baff` (~2:1) must become readable in both modes — pinned by Task 2's token values and its manual both-modes check step.
- **Reduced-motion collapse:** the new `row-enter` reveal must be static under `prefers-reduced-motion: reduce` — covered by the existing global guard; Task 5 adds a manual toggle check.
- **High-contrast / forced-colors parity:** the new neutral badge chip must not introduce shadows or transparency under `prefers-contrast: more` / `forced-colors: active` — Task 4's manual check step (existing branches already list `.status-badge`).
- **Progress re-renders must not retrigger reveals:** `row-enter` runs on mount only because rows are keyed React nodes — Task 5 manual check with an active conversion.
- **Font availability offline:** `font-display: swap` + committed woff2 means no network dependency and no invisible text — Task 1 build check.

---

### Task 1: Self-host Geist Variable font + license governance

**Files:**
- Create: `src/styles/fonts/Geist-Variable.woff2` (copy of the Geist 1.7.2 npm package's `dist/fonts/geist-sans/Geist-Variable.woff2`, 69,652 bytes)
- Create: `src/styles/fonts/LICENSE.txt` (copy of the same package's `LICENSE.txt`, SIL OFL 1.1)
- Modify: `src/styles/tokens.css` (prepend `@font-face`, replace `--font-family-sans` value)
- Modify: `THIRD_PARTY_NOTICES.md` (insert Fonts section between the FFmpeg table and `## License handling`)
- Modify: `scripts/check-third-party-licenses.ts` (add the identical lines to `stableSourceNotice` so the byte-compare stays green)

**Interfaces:**
- Consumes: nothing.
- Produces: the `Geist` font family usable by `--font-family-sans: Geist, system-ui, -apple-system, "Segoe UI", sans-serif;`.

- [ ] **Step 1: Copy the font and license assets**

```bash
mkdir -p src/styles/fonts
cp <staging>/Geist-Variable.woff2 src/styles/fonts/
cp <staging>/LICENSE.txt src/styles/fonts/
```

(`<staging>` = the extracted `geist@1.7.2` npm tarball; executor may re-download `https://registry.npmjs.org/geist/-/geist-1.7.2.tgz` and extract those two files.)

- [ ] **Step 2: Add `@font-face` and swap the stack in `tokens.css`**

At the very top of `tokens.css`, before `:root`:

```css
@font-face {
  font-family: "Geist";
  src: url("./fonts/Geist-Variable.woff2") format("woff2");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
```

Replace the `--font-family-sans` value with `Geist, system-ui, -apple-system, "Segoe UI", sans-serif` (drop `Inter`; keep the rest of the token untouched).

- [ ] **Step 3: Add the Fonts section to both the notices file and its generator**

Insert this section into `THIRD_PARTY_NOTICES.md` between the FFmpeg table and `## License handling`, and add the identical strings to `stableSourceNotice` in `scripts/check-third-party-licenses.ts` (same position, same order):

```markdown
## Fonts

LumaFlow bundles the Geist variable sans font (Copyright (c) 2023 Vercel, in collaboration with basement.studio), licensed under the SIL Open Font License, Version 1.1. The font file and its license text are committed under `src/styles/fonts/`.

- `src/styles/fonts/Geist-Variable.woff2` — Geist Variable, SIL OFL 1.1
- `src/styles/fonts/LICENSE.txt` — SIL Open Font License, Version 1.1
```

- [ ] **Step 4: Verify gate, build, and suite**

Run: `npm run check:licenses -- --source-only && npm run typecheck && npm run build && npm test -- --run`
Expected: license check prints "Verified source third-party notice…", build succeeds, 150 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/styles/fonts THIRD_PARTY_NOTICES.md scripts/check-third-party-licenses.ts src/styles/tokens.css
git commit -m "style: self-host Geist variable font with OFL notice"
```

---

### Task 2: `--color-on-accent` token and primary button text

**Files:**
- Modify: `src/styles/tokens.css` (three blocks: `:root`, `:root[data-theme="dark"]`, the `prefers-color-scheme: dark` branch)
- Modify: `src/styles/glass.css:364-368` (`.button--primary`)

**Interfaces:**
- Consumes: nothing.
- Produces: `--color-on-accent` token (`#f8fafc` light, `#0b1220` dark) used by `.button--primary`.

- [ ] **Step 1: Add the token**

In `:root` add `--color-on-accent: #f8fafc;` next to `--color-accent`. In **both** dark blocks (`:root[data-theme="dark"]` and `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`) add `--color-on-accent: #0b1220;`. Do not touch the `prefers-contrast: more` block (the primary button keeps its accent background there, so the off-white text stays correct).

- [ ] **Step 2: Use it in `.button--primary`**

In `glass.css`, change `.button--primary`'s `color: #ffffff;` to `color: var(--color-on-accent);`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build && npm test -- --run`
Expected: all green. Manual: in dark mode the "Start conversion" CTA renders dark text on light blue (≥4.5:1); in light mode off-white text on `#155dcc`.

- [ ] **Step 4: Commit**

```bash
git add src/styles/tokens.css src/styles/glass.css
git commit -m "fix(ui): correct dark-mode primary button contrast"
```

---

### Task 3: Remove card eyebrows (TDD)

**Files:**
- Modify: `src/app/App.test.tsx` (new test in the layout describe block, near the test at line 599)
- Modify: `src/app/AppShell.tsx:273` (delete `<p className="eyebrow">Source media</p>`), `src/app/AppShell.tsx:293` (delete `<p className="eyebrow">Configuration</p>`)
- Modify: `src/features/queue/QueuePanel.tsx:155` (delete `<p className="eyebrow">Processing workspace</p>`)

**Interfaces:**
- Consumes: nothing.
- Produces: exactly one `.eyebrow` in the rendered app (the intro's `Workspace`).

- [ ] **Step 1: Write the failing test**

Add to `src/app/App.test.tsx`:

```ts
it("keeps one page-level eyebrow and none inside cards", () => {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(<App />);

  expect(root.querySelectorAll(".eyebrow")).toHaveLength(1);
  expect(root.querySelector(".workspace-intro .eyebrow")?.textContent).toBe("Workspace");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/app/App.test.tsx`
Expected: FAIL — 4 eyebrows found.

- [ ] **Step 3: Delete the three card eyebrow elements**

Remove the `<p className="eyebrow">…</p>` nodes listed in Files. Do not remove the `.eyebrow` CSS rule (still used by the intro).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run`
Expected: 151 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/App.test.tsx src/app/AppShell.tsx src/features/queue/QueuePanel.tsx
git commit -m "ui: keep a single page-level eyebrow"
```

---

### Task 4: Neutral "Local mode" badge (TDD)

**Files:**
- Modify: `src/ui/StatusBadge.tsx` (status union, icon map)
- Modify: `src/ui/StatusBadge.test.tsx` (swap `offline` usages to `neutral`)
- Modify: `src/app/App.test.tsx` (new test)
- Modify: `src/app/AppShell.tsx:230` (badge usage) and `src/app/AppShell.tsx:342` (sr-only copy)
- Modify: `src/styles/glass.css` (replace `.status-badge--offline` rule with `.status-badge--neutral`)

**Interfaces:**
- Consumes: nothing.
- Produces: `StatusBadgeStatus` = `"attention" | "neutral" | "ready" | "working"` (the `"offline"` member is retired); CSS class `.status-badge--neutral` with a muted chip icon.

- [ ] **Step 1: Update the failing tests**

In `src/ui/StatusBadge.test.tsx`, replace both `status="offline"` usages with `status="neutral"` (labels may stay "Offline" — the test asserts label text passthrough, not the status name). Add to `src/app/App.test.tsx`:

```ts
it("shows a neutral local-mode chip instead of a danger offline badge", () => {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(<App />);

  const topbarBadge = root.querySelector(".workspace-topbar .status-badge");
  expect(topbarBadge?.getAttribute("data-status")).toBe("neutral");
  expect(topbarBadge?.textContent).toContain("Local mode");
  expect(root.querySelector(".status-badge--offline")).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/ui/StatusBadge.test.tsx src/app/App.test.tsx`
Expected: FAIL — `"neutral"` not assignable / topbar badge still `offline`.

- [ ] **Step 3: Implement**

`StatusBadge.tsx`: union becomes `"attention" | "neutral" | "ready" | "working"`; icon map entry `neutral: "•"`. `AppShell.tsx`: topbar usage becomes `<StatusBadge status="neutral" label="Local mode" />`; sr-only block copy becomes `LumaFlow is ready. Files are processed locally.` `glass.css`: replace the `.status-badge--offline` rule body with the neutral treatment mirroring `.queue-status--neutral`: `background: var(--color-surface-solid); color: var(--color-text-muted);` on `.status-badge__icon`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run`
Expected: 152 tests pass.

- [ ] **Step 5: Manual accessibility check**

With `prefers-contrast: more` and `forced-colors: active` emulated: the neutral chip keeps its border, gains no shadow or transparency (existing `.status-badge` branches already cover it).

- [ ] **Step 6: Commit**

```bash
git add src/ui/StatusBadge.tsx src/ui/StatusBadge.test.tsx src/app/App.test.tsx src/app/AppShell.tsx src/styles/glass.css
git commit -m "ui: replace danger offline badge with neutral local mode chip"
```

---

### Task 5: Tabular numerals, press feedback, row reveals, `100dvh`

**Files:**
- Modify: `src/styles/glass.css` (body rule; `.topbar-progress`; `.queue-row__meta, .queue-row__meta-line`; new `.source-list__meta` rule; new `:active` group; new `@keyframes row-enter` + application rules)

**Interfaces:**
- Consumes: `--motion-slow`, `--ease-standard` (round 1 tokens).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Numerals and viewport height**

`body { min-height: 100vh }` → `min-height: 100dvh`. Add `font-variant-numeric: tabular-nums;` to `.topbar-progress`, to the existing `.queue-row__meta, .queue-row__meta-line` rule, and to a new standalone rule `.source-list__meta { font-variant-numeric: tabular-nums; }` (do not edit the shared muted-text rule at `glass.css:325-332`).

- [ ] **Step 2: Press feedback**

Add one grouped rule:

```css
.button--secondary:active:not(:disabled),
.icon-button:active:not(:disabled),
.theme-toggle:active:not(:disabled),
.advanced-toggle:active:not(:disabled) {
  transform: translateY(1px);
}
```

- [ ] **Step 3: Row entry reveal**

Add after the `.queue-row__actions .button` rule:

```css
@keyframes row-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.queue-row,
.source-list__item {
  animation: row-enter var(--motion-slow) var(--ease-standard) both;
}
```

No new reduced-motion handling is needed: the existing global `prefers-reduced-motion` block zeroes `animation-duration`, and `both` fill leaves the final visible state.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run build && npm test -- --run`
Expected: all green. Manual: during a live conversion, progress ticks update the row in place without replaying the entry animation; with `prefers-reduced-motion: reduce` enabled, rows appear instantly.

- [ ] **Step 5: Commit**

```bash
git add src/styles/glass.css
git commit -m "style: tabular numerals, press feedback, row entry reveals, dvh body"
```
