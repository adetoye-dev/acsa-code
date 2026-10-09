// @vitest-environment jsdom
/**
 * A card that wraps onto another line when the editor narrows has to be measured
 * again, or its last line is clipped. Monaco raises this when it has re-laid out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useRemeasureOnLayout } from "./useRemeasureOnLayout";

function Harness({
  editor,
  measure,
  reapply,
}: {
  editor: { onDidLayoutChange(listener: () => void): { dispose(): void } } | null;
  measure: () => boolean;
  reapply: () => void;
}) {
  useRemeasureOnLayout(editor, measure, reapply);
  return null;
}

function fakeEditor() {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    dispose: vi.fn(),
    editor: {
      onDidLayoutChange(listener: () => void) {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
    },
  };
}

const settle = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));

afterEach(cleanup);

describe("re-measuring after a layout change", () => {
  it("measures, and re-applies only when the measurement changed", async () => {
    const { editor, listeners } = fakeEditor();
    const measure = vi.fn(() => true);
    const reapply = vi.fn();
    render(<Harness editor={editor} measure={measure} reapply={reapply} />);

    listeners.forEach((listener) => listener());
    await settle();

    expect(measure).toHaveBeenCalledTimes(1);
    expect(reapply).toHaveBeenCalledTimes(1);
  });

  it("does not re-apply when nothing moved", async () => {
    // Every layout change would otherwise rebuild every card's DOM node — and a
    // rebuilt node is a click that lands nowhere.
    const { editor, listeners } = fakeEditor();
    const reapply = vi.fn();
    render(<Harness editor={editor} measure={() => false} reapply={reapply} />);

    listeners.forEach((listener) => listener());
    await settle();

    expect(reapply).not.toHaveBeenCalled();
  });

  it("subscribes to nothing when there is no editor yet", () => {
    const measure = vi.fn(() => true);
    const reapply = vi.fn();
    expect(() =>
      render(<Harness editor={null} measure={measure} reapply={reapply} />),
    ).not.toThrow();
    expect(measure).not.toHaveBeenCalled();
  });
});
