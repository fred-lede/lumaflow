# LumaFlow Advanced Settings Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Output settings card feel balanced in both collapsed and expanded states by placing the full-width Advanced settings card below the format controls and above Quality preset.

**Architecture:** Keep the existing controlled settings model and conversion behavior unchanged. Refactor the settings markup into a primary-settings section, a persistent full-width Advanced settings card, and a full-width Quality preset section; group advanced controls semantically into Video and Audio fieldsets.

**Tech Stack:** React 19, TypeScript, CSS, Vitest.

---

### Task 1: Add focused layout and accessibility assertions

**Files:**
- Modify: `src/features/settings/useConversionSettings.test.ts`
- Create: `src/features/settings/OutputSettings.test.tsx`

- [ ] **Step 1: Add the collapsed/expanded markup assertions**

Render `OutputSettings` with the default settings in both states. Assert that both states contain the persistent `.advanced-settings-panel`, the toggle has an accessible name of `Advanced settings`, and the expanded state exposes `Video` and `Audio` group legends while the collapsed state does not expose their controls.

- [ ] **Step 2: Add advanced control grouping assertions**

Render expanded MP4 settings and assert that `Codec`, `Width`, `Height`, and `Frame rate` are inside the `Video` fieldset, while `Audio bitrate`, `Sample rate (Hz)`, and `Channels` are inside the `Audio` fieldset. Render expanded FLAC settings and assert that only the audio group is present.

- [ ] **Step 3: Run the focused tests and confirm the new assertions fail**

Run: `npm test -- src/features/settings/OutputSettings.test.tsx src/features/settings/useConversionSettings.test.ts`

Expected: the existing settings tests pass, and the new layout assertions fail because the current markup has a detached toggle and no grouped fieldsets.

### Task 2: Refactor the settings markup without changing conversion behavior

**Files:**
- Modify: `src/features/settings/OutputSettings.tsx`
- Modify: `src/features/settings/AdvancedSettings.tsx`

- [ ] **Step 1: Move primary controls into a named primary-settings region**

Wrap output folder and Format/Processing mode controls in `.settings-primary`. Keep their existing labels, controlled values, callbacks, and native controls unchanged.

- [ ] **Step 2: Add a persistent Advanced settings panel**

Render `.advanced-settings-panel` in both states. Give it an accessible heading, a stable toggle label `Advanced settings`, a state summary (`Using source values` when collapsed and `Optional overrides` when expanded), `aria-expanded`, and `aria-controls` only when the controlled panel is mounted.

- [ ] **Step 3: Group advanced controls by media type**

Keep the existing format-dependent option logic and callbacks. Put video-only controls in a `Video` fieldset, and codec/audio bitrate/sample rate/channels in an `Audio` fieldset. Do not add new conversion options or alter the settings model.

- [ ] **Step 4: Keep quality and errors outside the two-column top area**

Render Quality preset after the primary and advanced columns so it can span the settings card. Keep inline errors in the same output settings component and preserve `role="alert"`.

### Task 3: Implement the balanced responsive layout

**Files:**
- Modify: `src/styles/glass.css`

- [ ] **Step 1: Replace the current child-positioning selectors**

Use one settings column at desktop widths so the Advanced card and Quality preset have identical outer widths. Remove selectors that position Advanced settings in a separate right-side grid column.

- [ ] **Step 2: Style the Advanced panel as a stable section**

Give the panel a consistent border, surface, radius, internal spacing, heading hierarchy, and two-column control grid. Keep the existing supporting font sizes and focus styles.

- [ ] **Step 3: Make Quality preset span the card**

Place `.preset-fieldset` and `.inline-error` across the full settings grid. Keep the existing 2x2 preset cards on wide screens and stack them at narrow widths.

- [ ] **Step 4: Define narrow-screen behavior**

Below the desktop breakpoint, stack primary settings, Advanced panel, Quality preset, and inline error in that order without horizontal overflow or clipped controls.

- [ ] **Step 5: Equalize the desktop workspace cards**

At desktop widths, place the source card and settings card in the same grid row so they stretch to the same height. Keep the queue panel in the second row of the left column, and keep the source-first stacked order below the desktop breakpoint.

### Task 4: Verify the implementation

**Files:**
- Verify: `src/features/settings/OutputSettings.tsx`
- Verify: `src/features/settings/AdvancedSettings.tsx`
- Verify: `src/styles/glass.css`
- Verify: `src/features/settings/OutputSettings.test.tsx`

- [ ] **Step 1: Run settings tests**

Run: `npm test -- src/features/settings/OutputSettings.test.tsx src/features/settings/useConversionSettings.test.ts`

Expected: all focused settings tests pass.

- [ ] **Step 2: Run the full unit suite**

Run: `npm test`

Expected: Vitest exits with code 0 and no failed tests.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: TypeScript emits no errors and Vite completes the production build successfully.

- [ ] **Step 4: Inspect the rendered states**

Open the app, inspect collapsed and expanded Advanced settings at desktop and narrow widths, and confirm that the right-side panel, full-width Quality preset, keyboard focus ring, and footer action remain usable.
