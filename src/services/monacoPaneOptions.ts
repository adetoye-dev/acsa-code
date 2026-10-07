/**
 * The Monaco options that exist because the editor lives in a *pane*, not a window.
 *
 * Both are load-bearing here and neither is observable from a unit test, so they
 * live in one place with one test rather than as two lines copied into two
 * components and quietly dropped from one of them.
 *
 * - `automaticLayout` re-measures the editor when its pane is resized. Without it
 *   the editor keeps the width it was created at, and everything it positions —
 *   the cursor, the minimap, the scrollbar — is drawn for a pane that is no
 *   longer there. The chat dock opening is exactly that resize.
 *
 * - `fixedOverflowWidgets` renders hover, suggest and parameter-hint widgets in a
 *   viewport-anchored layer instead of inside the editor. They are absolutely
 *   positioned, and every one of these panes carries `overflow: hidden`, so
 *   without it a widget that reaches past the pane's right edge is clipped there
 *   and its text is cut mid-word. Measured in a browser at this app's pane width:
 *   a hover ran from 599px to 1351px, the pane ended at 955px, and the tooltip
 *   read "…: Reco" — the truncated hovers in the editor screenshots. With the
 *   option the same hover escapes the clip and the whole signature is readable.
 */
export const PANE_EDITOR_OPTIONS = {
  automaticLayout: true,
  fixedOverflowWidgets: true,
} as const;
