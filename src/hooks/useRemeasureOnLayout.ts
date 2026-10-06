/**
 * useRemeasureOnLayout.ts — re-measure something Monaco laid out, when Monaco
 * lays it out again.
 *
 * The editor's review cards are DOM nodes inside Monaco's own view zones, and a
 * zone is applied with a fixed height that is only correct for the width it was
 * measured at. Narrow the editor — the chat dock opens, the explorer is dragged
 * wide — and a card whose text needs another line is taller than its zone, so its
 * last line is clipped and the sentence stops mid-way. Scrolling re-measures; a
 * layout change did not, which is the case that matters here, because that is
 * what narrowing the editor is.
 *
 * Monaco lays out first and the card reflows as part of it, so the measurement
 * waits for the frame that follows rather than reading the size it is replacing.
 */
import { useEffect } from "react";

interface LayoutSource {
  onDidLayoutChange(listener: () => void): { dispose(): void };
}

export function useRemeasureOnLayout(
  editor: LayoutSource | null,
  measure: () => boolean,
  reapply: () => void,
): void {
  useEffect(() => {
    if (!editor) return;
    const subscription = editor.onDidLayoutChange(() => {
      window.requestAnimationFrame(() => {
        // Only when something actually changed: re-applying unconditionally would
        // rebuild every card's DOM node on every keystroke-sized layout change.
        if (measure()) reapply();
      });
    });
    return () => subscription.dispose();
  }, [editor, measure, reapply]);
}
