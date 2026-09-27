/**
 * LazySurface — a Suspense boundary that admits when its surface is late.
 *
 * `Suspense` covers one failure and not the other. A chunk that *fails* to load
 * rejects its `import()`, which throws during render and is caught by the app's
 * error boundary. A chunk that *stalls* — the request neither completes nor
 * fails — leaves the fallback on screen forever, with no error, no timeout and
 * nothing to click.
 *
 * That is not hypothetical: it is what the packaged app did, sitting on "Loading
 * editor…" indefinitely, and the only clue was that the fallback never changed.
 *
 * The note does *not* replace the surface. The chunk keeps loading underneath
 * and the note disappears by itself if the surface arrives — that matters,
 * because a slow load and a stuck one look identical from here and only one of
 * them needs the user to do anything. There is deliberately no "try again": a
 * re-import cannot be forced, since the browser serves the second `import()` of
 * the same specifier from the fetch that is already pending. Reloading the
 * webview is the only thing that actually clears a stalled request.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SurfaceFallback } from "./SurfaceFallback";

/**
 * How long a surface may be late before the user is told it is late.
 *
 * Measured rather than picked: a first file open in the packaged app puts the
 * editor on screen in about a second, so eight leaves most of an order of
 * magnitude of headroom. The stall this was written for sat there for twenty
 * seconds and counting, which is not a slower version of the same thing.
 */
export const STALL_AFTER_MS = 8000;

/** Reports the moment the surface actually mounts. */
const Ready = ({ children, onReady }: { children: ReactNode; onReady: () => void }) => {
  useEffect(() => {
    onReady();
  }, [onReady]);
  return <>{children}</>;
};

export function LazySurface({
  label,
  children,
  stallAfterMs = STALL_AFTER_MS,
}: {
  label: string;
  children: ReactNode;
  stallAfterMs?: number;
}) {
  const [stalled, setStalled] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setStalled(true), stallAfterMs);
    return () => window.clearTimeout(timerRef.current);
  }, [stallAfterMs]);

  // It arrived: stop the watchdog, so a slow load is not reported as a stuck one.
  const markReady = useCallback(() => {
    window.clearTimeout(timerRef.current);
  }, []);

  const reload = useCallback(() => {
    window.location.reload();
  }, []);

  return (
    <Suspense fallback={<SurfaceFallback label={label} stalled={stalled} onReload={reload} />}>
      <Ready onReady={markReady}>{children}</Ready>
    </Suspense>
  );
}

export default LazySurface;
