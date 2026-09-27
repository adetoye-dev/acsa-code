// @vitest-environment jsdom
/**
 * The empty editor's actions.
 *
 * This surface used to be two menus — a project card and, under it, a separate
 * list of shortcuts — which read as two things competing for the same attention.
 * The assertions here are mostly about that *structure*: one panel, and the
 * project's commands inside it rather than beside it. Structure is what a
 * screenshot review misses and what comes back one component at a time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DockviewWatermark } from "./DockviewWatermark";
import type { ProjectStatus } from "../../services/projectSetup";

afterEach(cleanup);

const STATUS: ProjectStatus = {
  projectRoot: "/work/app",
  hasPackageJson: true,
  hasNodeModules: true,
  needsInstall: false,
  manager: "npm",
  installCommand: "npm install",
  devCommand: "npm run dev",
  buildCommand: "npm run build",
  testCommand: "npm test",
  scripts: {},
};

const panels = () => document.querySelectorAll('[data-testid="watermark-actions"]');
const rows = () => [...panels()[0].querySelectorAll("button")].map((b) => b.querySelector("span")?.textContent);
const noop = () => undefined;

describe("the empty editor's action panel", () => {
  it("is one panel, not a card plus a list", () => {
    render(<DockviewWatermark setup={{ status: STATUS, busyCommand: null, onRun: noop }} />);
    expect(panels()).toHaveLength(1);
  });

  it("offers a runnable project's own commands alongside the shortcuts", () => {
    render(<DockviewWatermark setup={{ status: STATUS, busyCommand: null, onRun: noop }} />);
    expect(rows()).toEqual(["Run dev server", "Build", "Search files", "Command palette", "Ask the assistant"]);
  });

  it("replaces run and build with the install that has to come first", () => {
    render(
      <DockviewWatermark
        setup={{ status: { ...STATUS, needsInstall: true }, busyCommand: null, onRun: noop }}
      />
    );
    const labels = rows();
    expect(labels).toContain("Install dependencies (npm)");
    expect(labels).not.toContain("Run dev server");
    expect(labels).not.toContain("Build");
  });

  it("disables the other commands while one is running, and keeps the shortcuts usable", () => {
    render(
      <DockviewWatermark
        setup={{ status: STATUS, busyCommand: "npm run build", onRun: noop }}
      />
    );
    const buttons = [...panels()[0].querySelectorAll("button")];
    const byLabel = (label: string) =>
      buttons.find((b) => (b.querySelector("span")?.textContent || "").startsWith(label));
    // The one that is running stays enabled, because its own click is the cancel
    // path; everything else that would fight it for the terminal is disabled.
    expect(byLabel("Build")?.disabled).toBe(false);
    expect(byLabel("Run dev server")?.disabled).toBe(true);
    expect(byLabel("Search files")?.disabled).toBe(false);
  });

  it("falls back to just the shortcuts when there is no project to run", () => {
    render(<DockviewWatermark />);
    expect(panels()).toHaveLength(1);
    expect(rows()).toEqual(["Search files", "Command palette", "Ask the assistant"]);
  });

  it("wires each shortcut to its handler, so the panel is not decorative", () => {
    const onOpenFile = vi.fn();
    const onOpenCommands = vi.fn();
    const onToggleAi = vi.fn();
    render(
      <DockviewWatermark
        onOpenFile={onOpenFile}
        onOpenCommands={onOpenCommands}
        onToggleAi={onToggleAi}
      />
    );
    const buttons = [...panels()[0].querySelectorAll("button")];
    buttons.forEach((button) => button.click());
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenCommands).toHaveBeenCalledTimes(1);
    expect(onToggleAi).toHaveBeenCalledTimes(1);
  });
});
