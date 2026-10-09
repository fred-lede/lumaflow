# LumaFlow Workspace Layout Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the desktop workspace into a source-queue pane and an output-settings pane, using the supplied converter screenshot as a structural reference while preserving LumaFlow's glass theme and behavior.

**Architecture:** Keep the existing intake, settings, and queue components. Change only their composition in `AppShell.tsx`: the source card and `QueuePanel` become the left column, while output settings and the conversion action remain in the right column. Update the existing layout CSS and render assertions; no conversion or drag-and-drop logic changes are needed.

**Tech Stack:** React, TypeScript, CSS custom properties, Vitest, Vite.

---

### Task 1: Add layout and content regression coverage

**Files:**
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/app/App.test.tsx` — update the accessible heading assertion and assert the new pane structure.

- [ ] **Step 1: Replace the old heading assertion**

In the existing root-landmark test, replace the LumaFlow content-heading assertion with:

```ts
expect(markup).toContain('<h1 id="app-title" class="workspace-title">Convert your media</h1>');
expect(markup).not.toContain('Prepare your next conversion');
```

- [ ] **Step 2: Add structural assertions**

Add assertions for the new composition:

```ts
expect(markup).toContain('class="workspace-layout"');
expect(markup).toContain('class="workspace-source-column"');
expect(markup).toContain('class="workspace-settings-column"');
expect(markup.indexOf('sources-title')).toBeLessThan(markup.indexOf('settings-title'));
expect(markup.indexOf('queue-title')).toBeLessThan(markup.indexOf('settings-title'));
```

- [ ] **Step 3: Run the focused test and verify it fails**

Run:

```bash
npm test -- --run src/app/App.test.tsx
```

Expected: FAIL because the current app still renders the old heading and vertical composition.

### Task 2: Compose the persistent two-pane workspace

**Files:**
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/app/AppShell.tsx` — make the main heading semantic, move the queue beside the source list, and preserve settings actions.

- [ ] **Step 1: Replace the intro markup**

Replace the current intro content with:

```tsx
<div className="workspace-intro">
  <div>
    <p className="eyebrow">Workspace</p>
    <h1 id="app-title" className="workspace-title">Convert your media</h1>
    <p className="supporting-text">
      Add files, choose an output, and review the queue before processing locally.
    </p>
  </div>
  <StatusBadge status="ready" label="Ready for files" />
</div>
```

- [ ] **Step 2: Wrap the existing panels into the new column structure**

Use this order directly inside `main`:

```tsx
<div className="workspace-layout">
  <div className="workspace-source-column">
    <GlassPanel className="workspace-card" labelledBy="sources-title" role="region">
      {/* existing source card content remains unchanged */}
    </GlassPanel>
    <QueuePanel controller={queue.controller} />
  </div>

  <GlassPanel className="workspace-card workspace-card--settings workspace-settings-column" labelledBy="settings-title" role="region">
    {/* existing settings card content and action row remain unchanged */}
  </GlassPanel>
</div>
```

Remove the old standalone `<QueuePanel controller={queue.controller} />` after the workspace grid. Do not alter DropZone, SourceFileList, OutputSettings, queue controller props, or the conversion callback.

- [ ] **Step 3: Run the focused test and verify it passes**

Run:

```bash
npm test -- --run src/app/App.test.tsx
```

Expected: PASS.

### Task 3: Style the desktop and responsive layout

**Files:**
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/styles/tokens.css` — set the compact but readable title scale.
- Modify: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/styles/glass.css` — replace the old grid rules with the two-pane workspace rules and mobile stacking.

- [ ] **Step 1: Set the heading scale**

Set the token to:

```css
--font-size-heading: clamp(1.75rem, 3vw, 2.4rem);
```

This keeps the title readable at narrow widths and avoids using the previous 2.75rem maximum.

- [ ] **Step 2: Define the desktop workspace geometry**

Update the layout rules to use:

```css
.workspace-main {
  width: min(100% - 2rem, 90rem);
  margin: 0 auto;
  min-height: calc(100dvh - 4.75rem);
  padding: clamp(var(--space-5), 4vh, var(--space-10)) 0;
}

.workspace-intro {
  align-items: flex-end;
  margin-bottom: var(--space-5);
}

.workspace-layout {
  display: grid;
  grid-template-columns: minmax(18rem, 0.85fr) minmax(30rem, 1.15fr);
  gap: var(--space-5);
  align-items: start;
}

.workspace-source-column {
  display: grid;
  gap: var(--space-5);
  min-width: 0;
}

.workspace-card--settings {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.workspace-card--settings .action-row {
  margin-top: auto;
}

.workspace-source-column .queue-panel {
  margin-top: 0;
}
```

- [ ] **Step 3: Preserve advanced settings width and remove obsolete grid selectors**

Keep the advanced settings in the right settings panel, but raise its minimum width from `15rem` to `18rem`:

```css
.workspace-card--settings .output-settings {
  grid-template-columns: minmax(0, 1fr) minmax(18rem, 0.8fr);
}
```

Replace selectors that target `.workspace-grid` with `.workspace-layout`. Do not change the existing advanced field controls or their labels.

- [ ] **Step 4: Add responsive stacking**

At the existing `@media (max-width: 720px)` breakpoint, use:

```css
.workspace-layout {
  grid-template-columns: 1fr;
}

.workspace-source-column {
  order: 1;
}

.workspace-settings-column {
  order: 2;
}
```

Keep the current narrow-screen control stacking rules for `.drop-zone`, `.action-row`, `.field-grid`, and `.preset-grid`.

### Task 4: Verify behavior and visual acceptance

**Files:**
- Modify: none.
- Test: `/Volumes/Ai-2TB/ai/my_codex/media_converter/src/app/App.test.tsx`

- [ ] **Step 1: Run the full frontend tests**

Run:

```bash
npm test -- --run
```

Expected: all tests pass.

- [ ] **Step 2: Build the frontend**

Run:

```bash
npm run build
```

Expected: the production build completes without TypeScript or CSS errors.

- [ ] **Step 3: Inspect the local preview at desktop width**

Verify that the fresh screen shows `Convert your media`, the source pane and queue remain on the left, output settings remain on the right, advanced settings stay in the right pane, and the primary action is at the bottom of the settings panel.

- [ ] **Step 4: Inspect the local preview at narrow width**

Verify that the source pane appears before the settings pane, text and selects do not clip, and the existing drop zone and action buttons remain usable.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/app/AppShell.tsx src/app/App.test.tsx src/styles/glass.css src/styles/tokens.css
git commit -m "ui: organize converter into two-pane workspace"
```
