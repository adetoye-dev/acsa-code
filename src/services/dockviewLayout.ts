/**
 * dockviewLayout.ts — tell Dockview when the space it lives in has changed.
 *
 * Dockview keeps its grid in pixels and watches its container, so most resizes
 * look after themselves. The one that does not is a discrete change to the shell
 * around it — opening the chat dock, closing the bottom panel, leaving the editor
 * for a page — when the container shrinks and the grid below it can be left at the
 * old size. What a reader sees then is not a wrong number but a wrong edge: the tab
 * strip loses its overflow control, the review controls sit under the chat dock
 * instead of beside it, and long lines are cut at an edge that is not the pane's.
 *
 * The cause is a minimum the header cannot go under: a group with a dozen tabs has
 * a floor of its own, and a grid that is never asked to re-measure keeps it. Asking
 * directly, on the commit that changed the layout, is deterministic in a way that
 * waiting for an observer to notice is not.
 */
export function relayoutDockview(
  host: { clientWidth: number; clientHeight: number } | null,
  api: { layout(width: number, height: number): void } | null,
): void {
  if (!host || !api) return;
  // A zero size is a host that is not on screen — a page is showing, or the dock is
  // unmounted — and laying out to nothing makes Dockview forget a real layout.
  if (host.clientWidth === 0 || host.clientHeight === 0) return;
  api.layout(host.clientWidth, host.clientHeight);
}
