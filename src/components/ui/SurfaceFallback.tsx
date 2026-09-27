/**
 * SurfaceFallback — what paints while a lazily-loaded surface chunk arrives.
 *
 * Monaco, the terminal and the graph stacks dominate the bundle but are not
 * needed to paint the workbench, so those surfaces are split and mounted behind
 * Suspense. This is the gap-filler they share.
 *
 * It also carries the "this is taking an unreasonable amount of time" state,
 * because Suspense on its own has none: a chunk that stalls rather than fails
 * leaves the fallback on screen indefinitely — no error, no timeout and nothing
 * for the user to click. See `LazySurface`.
 */
export const SurfaceFallback = ({
  label,
  stalled = false,
  onReload,
}: {
  label: string;
  stalled?: boolean;
  onReload?: () => void;
}) => (
  <div
    data-testid="surface-fallback"
    className="h-full w-full flex flex-col items-center justify-center gap-2 text-zinc-500 text-xs bg-[var(--vscode-editor-bg)]"
  >
    <span>Loading {label}…</span>
    {stalled && (
      <div data-testid="surface-stalled" className="flex flex-col items-center gap-1.5 px-6">
        <span className="text-amber-400">Still waiting for the {label}.</span>
        <span className="text-2xs text-zinc-500 text-center max-w-xs leading-snug">
          It may be slow, or the app may be stuck. Reloading is the way out, and it touches nothing
          on disk.
        </span>
        <span className="flex items-center gap-2">
          {onReload && (
            <button
              type="button"
              data-testid="surface-reload"
              onClick={onReload}
              className="px-2.5 py-1 rounded-md text-2xs font-medium bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/70 text-zinc-200 transition-colors"
            >
              Reload the app
            </button>
          )}
        </span>
      </div>
    )}
  </div>
);

export default SurfaceFallback;
