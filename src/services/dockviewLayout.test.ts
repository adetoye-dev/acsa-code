/**
 * The shell tells Dockview when the editor's space changed. Getting this wrong is
 * invisible until a reader opens the chat dock and finds the right-hand edge of
 * their editor is not where it should be.
 */
import { describe, expect, it, vi } from "vitest";
import { relayoutDockview } from "./dockviewLayout";

describe("relaying a new size to Dockview", () => {
  it("passes the host's size through", () => {
    const api = { layout: vi.fn() };
    relayoutDockview({ clientWidth: 840, clientHeight: 600 }, api);
    expect(api.layout).toHaveBeenCalledWith(840, 600);
  });

  it("does nothing without a host or an api", () => {
    const api = { layout: vi.fn() };
    relayoutDockview(null, api);
    relayoutDockview({ clientWidth: 840, clientHeight: 600 }, null);
    expect(api.layout).not.toHaveBeenCalled();
  });

  it("does not lay out to nothing when the dock is off screen", () => {
    // A page is showing: the dock is unmounted, and laying out to 0 tells Dockview
    // a size it will then have to be told again.
    const api = { layout: vi.fn() };
    relayoutDockview({ clientWidth: 0, clientHeight: 0 }, api);
    expect(api.layout).not.toHaveBeenCalled();
  });
});
