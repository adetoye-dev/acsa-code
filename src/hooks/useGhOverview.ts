/**
 * useGhOverview — the remote's state, held above the pane that draws it.
 *
 * That state is the repository page's landing view, and it unmounts the moment a
 * file or a commit is selected. Fetching from inside it would re-ask GitHub — three
 * `gh` calls, seconds each — every time the user came back to the landing view, so
 * the fetch lives here, one level up, where selecting something does not throw it
 * away. Freshness is not silently assumed either: the answer carries when it was
 * read, the panel prints that, and `refresh` is one click away.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ghOverview, type GhOverview } from "../services/ghClient";

export interface GhOverviewState {
  data: GhOverview | null;
  isLoading: boolean;
  /** When the answer on screen was read, in epoch milliseconds; 0 before the first. */
  checkedAt: number;
  refresh: () => void;
}

export function useGhOverview(projectCwd: string): GhOverviewState {
  const [data, setData] = useState<GhOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState(0);
  /** The newest request wins; a slow answer for the old project is dropped. */
  const seq = useRef(0);

  const load = useCallback(async () => {
    const token = ++seq.current;
    setIsLoading(true);
    const next = await ghOverview(projectCwd);
    if (token !== seq.current) return;
    setData(next);
    setCheckedAt(Date.now());
    setIsLoading(false);
  }, [projectCwd]);

  useEffect(() => {
    // Another project is another repository; keeping the old answer on screen
    // while the new one loads would label it with the wrong name.
    setData(null);
    setCheckedAt(0);
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { data, isLoading, checkedAt, refresh };
}
