/**
 * The editor's pane-only options.
 *
 * Neither can be observed from a unit test: jsdom has no layout, so a hover
 * cannot be made to overflow a pane and `automaticLayout` has nothing to
 * re-measure. What can be pinned is the decision itself, because the failure is
 * silent — drop either option and everything still works until a tooltip near the
 * pane's edge arrives cut mid-word, which is not a thing any test would see.
 *
 * The second half is the part that actually catches a regression: the constant is
 * useless if an editor stops spreading it, and that is a one-line edit nobody
 * would notice.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PANE_EDITOR_OPTIONS } from "./monacoPaneOptions";

const editorSource = (name: string) =>
  readFileSync(new URL(`../components/editor/${name}`, import.meta.url), "utf8");

describe("the options the editor pane needs", () => {
  it("re-measures when the pane is resized", () => {
    expect(PANE_EDITOR_OPTIONS.automaticLayout).toBe(true);
  });

  it("lets overflow widgets out of the pane, or a hover is clipped at its edge", () => {
    expect(PANE_EDITOR_OPTIONS.fixedOverflowWidgets).toBe(true);
  });

  it("is what both editors hand to Monaco", () => {
    for (const name of ["MonacoEditorContainer.tsx", "MonacoDiffContainer.tsx"]) {
      expect(editorSource(name), `${name} does not spread PANE_EDITOR_OPTIONS`).toContain(
        "...PANE_EDITOR_OPTIONS",
      );
    }
  });
});
