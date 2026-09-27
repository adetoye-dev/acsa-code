// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkbenchNav, type ScreenId } from "./WorkbenchNav";

function setup(overrides: Partial<React.ComponentProps<typeof WorkbenchNav>> = {}) {
  const handlers = {
    onSelectScreen: vi.fn<(screen: ScreenId) => void>(),
    onPinnedChange: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  const props = {
    screen: "editor" as ScreenId,
    pinned: false,
    ...handlers,
    ...overrides,
  };
  const view = render(<WorkbenchNav {...props} />);
  const setProps = (next: Partial<React.ComponentProps<typeof WorkbenchNav>>) =>
    view.rerender(<WorkbenchNav {...props} {...next} />);
  return { ...handlers, setProps };
}

const nav = () => screen.getByTestId("workbench-nav");
/** Expanded and collapsed are a width, so that is what the test reads. */
const width = () => Number.parseInt(nav().style.width, 10);
const brandName = () => screen.getByText("ACSA Code");

/** Pointing at the sidebar opens it — after the hover intent, so it is awaited. */
const hover = () => fireEvent.mouseOver(nav());
const leave = () => fireEvent.mouseOut(nav());
const expandedWidth = () => waitFor(() => expect(width()).toBeGreaterThan(100));

afterEach(cleanup);

describe("the workbench sidebar", () => {
  it("is one element, collapsed, with the icon showing and the name not", () => {
    setup();
    expect(screen.getAllByTestId("workbench-nav")).toHaveLength(1);
    expect(width()).toBeLessThan(100);
    // The brand mark is always there; the name is hidden from the tree while
    // there is no room for it.
    expect(brandName().getAttribute("aria-hidden")).toBe("true");
  });

  it("expands in place on hover and collapses when the pointer leaves", async () => {
    setup();
    const collapsed = width();
    hover();
    await expandedWidth();
    expect(brandName().getAttribute("aria-hidden")).toBe("false");

    leave();
    expect(width()).toBe(collapsed);
  });

  it("does not open for a cursor that is only passing through", async () => {
    // A pointer crossing the sidebar on its way somewhere else must not shove
    // the editor across and back.
    setup();
    hover();
    expect(width()).toBeLessThan(100);
    leave();
    await new Promise((r) => setTimeout(r, 250));
    expect(width()).toBeLessThan(100);
  });

  it("lists every screen, as one row each", async () => {
    // Flat on purpose: the rows keep their height and rhythm in both states, and
    // a single label per row is what makes that possible.
    setup();
    hover();
    await expandedWidth();
    for (const label of ["Editor", "Repository", "Code map", "Models", "Marketplace", "Performance"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // No section headings: those are what broke the rhythm.
    expect(screen.queryByText("Workspace")).toBeNull();
  });

  it("closes itself once something has been chosen", async () => {
    const { onSelectScreen } = setup();
    hover();
    await expandedWidth();
    fireEvent.click(screen.getByTestId("nav-item-git"));
    expect(onSelectScreen).toHaveBeenCalledWith("git");
    // The pointer is still on it; it still gets out of the way.
    expect(width()).toBeLessThan(100);
  });

  it("stays open when it is pinned, including after a choice", () => {
    const { onSelectScreen } = setup({ pinned: true });
    expect(width()).toBeGreaterThan(100);
    fireEvent.click(screen.getByTestId("nav-item-marketplace"));
    expect(onSelectScreen).toHaveBeenCalledWith("marketplace");
    expect(width()).toBeGreaterThan(100);
  });

  it("marks the current screen as the page", async () => {
    setup({ screen: "codeMap" });
    hover();
    await expandedWidth();
    expect(screen.getByTestId("nav-item-codeMap").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("nav-item-git").getAttribute("aria-current")).toBeNull();
  });

  it("lets the pin be changed from the mark and from the pin", async () => {
    const { onPinnedChange } = setup();
    fireEvent.click(screen.getByTestId("nav-brand"));
    expect(onPinnedChange).toHaveBeenCalledWith(true);

    hover();
    await expandedWidth();
    fireEvent.click(screen.getByTestId("nav-pin"));
    expect(onPinnedChange).toHaveBeenCalledWith(true);
  });

  it("closes — and unpins — on Escape", () => {
    const { onPinnedChange } = setup({ pinned: true });
    fireEvent.keyDown(nav(), { key: "Escape" });
    expect(onPinnedChange).toHaveBeenCalledWith(false);
  });

  it("opens for the keyboard when a row takes focus", async () => {
    setup();
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.focus(screen.getByTestId("nav-item-git"));
    await expandedWidth();
  });

  it("does not reopen for a click that focused the row", async () => {
    // Clicking a row focuses it. That is not a request to keep the sidebar open,
    // and treating it as one meant a mouse choice reopened it as soon as the
    // pointer left.
    const { onSelectScreen } = setup();
    fireEvent.pointerDown(window);
    fireEvent.mouseOver(nav());
    await expandedWidth();
    const row = screen.getByTestId("nav-item-git");
    fireEvent.focus(row);
    fireEvent.click(row);
    expect(onSelectScreen).toHaveBeenCalledWith("git");

    // The pointer leaves; focus is still on the row; it must stay closed.
    fireEvent.mouseOut(nav());
    await new Promise((r) => setTimeout(r, 250));
    expect(width()).toBeLessThan(100);
  });

  it("offers screens and settings, and nothing else", () => {
    // Chat is a panel toggle, not a screen, so it belongs to the titlebar and ⌘L
    // — it had been offered twice in here. Search was the palette's job too, and
    // the omnibar already does it, so that row is gone rather than repeated.
    const { onOpenSettings } = setup();
    expect(screen.queryByText("Chat")).toBeNull();
    expect(screen.queryByText(/Search/)).toBeNull();
    fireEvent.click(screen.getByTestId("nav-settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
