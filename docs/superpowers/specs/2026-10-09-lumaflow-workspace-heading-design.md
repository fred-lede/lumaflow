# LumaFlow Workspace Heading Refinement

## Goal

Make the workspace introduction more direct and better aligned with the media-conversion flow, while reducing unnecessary vertical pressure on the two-column workspace layout.

## Approved design

- Replace the main heading `Prepare your next conversion` with `Set up your conversion`.
- Keep the existing supporting sentence because it clearly explains the three actions: add files, choose an output, and review the queue.
- Keep the interface language in English to match the existing product surface.
- Adjust the heading scale from `clamp(1.75rem, 4vw, 2.75rem)` to `clamp(1.75rem, 3.5vw, 2.4rem)`.
- Preserve the existing heading hierarchy and responsive layout; do not change card structure or interaction behavior.

## Rationale

`Set up your conversion` describes the current empty workspace state more directly than the future-oriented `Prepare your next conversion`. The smaller desktop maximum keeps the heading prominent while leaving more room for the source and output cards, especially when advanced settings are open.

## Acceptance criteria

1. The rendered heading text is exactly `Set up your conversion`.
2. The supporting sentence remains unchanged.
3. The heading remains at least `1.75rem` on narrow screens and no larger than `2.4rem` on wide screens.
4. Existing layout and frontend tests continue to pass.
5. No changes are made to drag-and-drop, conversion logic, or advanced-setting controls.
