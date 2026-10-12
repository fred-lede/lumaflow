# LumaFlow workspace UI polish — round 2 (contrast, font, eyebrow, badge, numerals, motion)

## Status

Approved design (user selected the full fix bundle 1–8 on 2026-10-12). This file is the design spec; implementation details are in `docs/superpowers/plans/2026-10-12-lumaflow-ui-polish-round2.md`.

## Context

Round 1 (`2026-10-10-lumaflow-ui-refresh-design.md`, merged) added motion tokens, transitions, tightened radii, the full-width queue row, and the topbar progress counter. A second audit round (design-taste-frontend + redesign-existing-projects checklists) found the items below. All findings were verified against current source, not inferred.

Design read: desktop conversion tool for lossless-audio-conscious users, Apple-glass visual language, redesign–preserve. Dials: `DESIGN_VARIANCE: 4 / MOTION_INTENSITY: 4 / VISUAL_DENSITY: 4`.

## Findings and decisions

1. **Dark-mode primary CTA fails WCAG contrast (critical).** `.button--primary` hardcodes `color: #ffffff` on `background: var(--color-accent)`; in dark mode the accent is `#89baff` (~2:1 with white; hover `#c3ddff` ~1.4:1). Decision: add a `--color-on-accent` token — off-white `#f8fafc` in light, `#0b1220` in dark — and use it for primary button text.
2. **Declared font never loads (critical).** `--font-family-sans` lists `Inter`, but no `@font-face`, bundled file, or link exists, and the app is offline-first; rendering silently falls back to `system-ui`. Decision: self-host **Geist Variable** (SIL OFL 1.1, 69 KB woff2, from the `geist` npm package v1.7.2) as a committed asset under `src/styles/fonts/`, loaded via `@font-face` with `font-display: swap`. Document in `THIRD_PARTY_NOTICES.md`; because `scripts/check-third-party-licenses.ts --source-only` byte-compares the notices file against its generator, the generator gains the identical Fonts section.
3. **Eyebrow overuse (high).** 4 eyebrows across 4 sections (`Workspace`, `Source media`, `Configuration`, `Processing workspace`) exceeds the 1-per-3-sections limit and contradicts round 1's "page-level sole label" intent. Decision: keep the intro `Workspace` eyebrow; remove the three card eyebrows. No test asserts these strings.
4. **Numbers jitter (high).** Progress percentages, durations, and sizes render in proportional figures. Decision: `font-variant-numeric: tabular-nums` on `.queue-row__meta-line`, `.queue-row__meta`, `.source-list__meta`, `.topbar-progress`.
5. **"Offline mode" badge is permanent danger-red (high).** A red badge on every launch reads as an error, but local processing is the product's normal mode. Decision: rename the topbar badge to "Local mode" and restyle the `offline` status to a neutral `neutral` status (muted icon chip, no danger tint). The `offline` status name is retired; `StatusBadge.test.tsx` is updated to the new status, coverage unchanged.
6. **No `:active` press feedback (medium).** Only `.button--primary` has it. Decision: `translateY(1px)` on `:active:not(:disabled)` for `.button--secondary`, `.icon-button`, `.theme-toggle`, `.advanced-toggle`.
7. **Queue rows and source items pop in instantly (medium).** Decision: one shared CSS keyframe `row-enter` (opacity 0→1, `translateY(8px)`→0, `var(--motion-slow) var(--ease-standard)`, `both`) applied to `.queue-row` and `.source-list__item`. The existing global `prefers-reduced-motion` block already zeroes animation durations.
8. **`body { min-height: 100vh }` (low).** Decision: `100dvh`, consistent with `.workspace-shell`.

## Non-goals

- No new npm dependencies. The font is a committed asset, not a package. No UI framework, CSS-in-JS, or animation library (native CSS only, per round 1).
- No icon-library adoption. Unicode glyphs (`⇩ ◐ ↻ ↑ ↓ × ✓ …`) stay; only the badge icon changes as part of finding 5.
- Queue status labels stay Chinese (`待處理`, `已完成`, …) — intentional, asserted by `tests/e2e/accessibility.spec.ts`.
- No changes to conversion, intake, queue, or preference logic; no Rust/Tauri changes.
- No new `@media` accessibility branches; all existing branches must keep working.

## Acceptance

- `npm test -- --run`: baseline **150 tests / 18 files** green, plus the new tests below; no coverage weakened.
- `npm run typecheck`, `npm run build`, `npm run check:licenses -- --source-only`: pass.
- Manual: dark-mode primary CTA readable; light/dark parity; `prefers-reduced-motion` collapses reveals; `prefers-contrast: more` and `forced-colors: active` unchanged in behavior; topbar idle appearance shows the neutral "Local mode" chip.
