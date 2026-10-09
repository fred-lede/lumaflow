# LumaFlow Workspace Layout Refinement

## Goal

Make LumaFlow feel like a focused desktop conversion tool: keep the source queue visible on the left, keep output configuration visible on the right, and reduce the amount of introductory content that pushes the working controls below the fold.

## Approved design

- Replace the large main heading `Prepare your next conversion` with the more direct, compact heading `Convert your media`.
- Keep a short supporting sentence: `Add files, choose an output, and review the queue before processing locally.`
- Keep the interface language in English to match the existing product surface.
- Replace the current vertical sequence of intro → two cards → queue with a desktop two-pane workspace:
  - left pane: source files, drop zone, source list, and processing queue;
  - right pane: output settings, advanced settings, and the primary conversion action.
- Keep the top bar for product identity, offline status, and theme control.
- Keep the glass panels, light/dark themes, existing controls, and cross-platform-neutral wording.
- On narrow screens, stack the two panes in source-first order.

## Rationale

The supplied reference shows a useful converter pattern: a persistent source list on the left and grouped settings on the right. This is a better fit for LumaFlow than a marketing-style hero followed by a long vertical page. `Convert your media` is short enough to preserve hierarchy without consuming the working area. The reference's dark palette is not copied; LumaFlow retains its Apple-glass visual language and theme system.

## Acceptance criteria

1. The rendered heading text is exactly `Convert your media`.
2. The source pane remains visible beside the settings pane at desktop widths.
3. The advanced settings remain in the right pane and do not push the source queue below the main workspace.
4. The primary conversion action remains associated with output settings.
5. The source pane stacks before the settings pane on narrow screens without clipping.
6. Existing drag-and-drop, conversion logic, and advanced-setting controls continue to work unchanged.
7. Existing layout and frontend tests continue to pass, with focused assertions for the new heading and pane order.
