// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const available = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  notes: "fixes",
  date: "2026-09-18",
};

const shared = vi.hoisted(() => ({ progress: null as null | Record<string, unknown> }));

vi.mock("../../services/appUpdater", () => ({
  autoCheckEnabled: () => true,
  checkForUpdate: vi.fn(async () => available),
  installUpdate: vi.fn(async () => {
    // What the real service does: publish the new state and announce it. A mock
    // that merely resolves would leave both surfaces showing nothing, which is a
    // property of the mock rather than of the app.
    window.dispatchEvent(
      new CustomEvent("acsa:update", {
        detail: { kind: "install", progress: { version: "0.2.0", phase: "ready", percent: 100 } },
      }),
    );
  }),
  restartApp: vi.fn(async () => undefined),
  // The real channel name: the component subscribes to it, so the mock has to
  // carry the same string or nothing crosses the boundary in a test.
  UPDATE_ANNOUNCEMENT: "acsa:update",
  // Nothing installed in these tests unless a case says so; the component reads
  // the shared state on mount now instead of holding its own.
  installProgress: () => shared.progress,
}));

const { UpdateButton } = await import("./UpdateButton");
const updater = await import("../../services/appUpdater");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  shared.progress = null;
});

/** The check waits 2.5s after mount so it never competes with the first paint. */
const findButton = () => screen.findByRole("button", { name: /update/i }, { timeout: 5000 });

describe("the titlebar update button", () => {
  it("renders nothing at all when there is no update", async () => {
    vi.mocked(updater.checkForUpdate).mockResolvedValueOnce(null);
    const { container } = render(<UpdateButton />);
    // An up-to-date app should not carry a permanent badge.
    await new Promise((r) => setTimeout(r, 3000));
    expect(container.innerHTML).toBe("");
  });

  it("says Update, not the version number", async () => {
    // It read `0.2.0` once, which looks like *the* version rather than *a newer
    // one is waiting*. This is the assertion that keeps the label honest.
    render(<UpdateButton />);
    const button = await findButton();
    expect(button.textContent?.trim()).toBe("Update");
    expect(button.textContent).not.toContain("0.2.0");
  });

  it("shows the version transition in the panel, where there is room for it", async () => {
    render(<UpdateButton />);
    fireEvent.click(await findButton());
    expect(await screen.findByText("Update available")).toBeTruthy();
    expect(screen.getByText("0.1.0 → 0.2.0")).toBeTruthy();
    expect(screen.getByText("fixes")).toBeTruthy();
  });

  it("installs only on a click, and offers the restart separately", async () => {
    render(<UpdateButton />);
    fireEvent.click(await findButton());

    // Nothing installed until asked.
    expect(updater.installUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /download & install/i }));
    expect(await screen.findByText(/installed\. restart to finish/i)).toBeTruthy();
    expect(updater.installUpdate).toHaveBeenCalledTimes(1);

    // And the restart is its own decision: the install never restarts on its own.
    expect(updater.restartApp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /restart now/i }));
    expect(updater.restartApp).toHaveBeenCalledTimes(1);
  });
});

describe("an update found on another surface", () => {
  it("shows the button immediately, without waiting for a relaunch", async () => {
    // Reported: Settings → About said "0.2.8 is available — the button is in the
    // titlebar" while no button existed, because this component only looked at
    // mount. The announcement is what makes the two agree.
    vi.mocked(updater.checkForUpdate).mockResolvedValueOnce(null);
    const { container } = render(<UpdateButton />);
    await new Promise((r) => setTimeout(r, 3000));
    expect(container.innerHTML).toBe("");

    window.dispatchEvent(
      new CustomEvent("acsa:update", { detail: { kind: "available", update: available } }),
    );
    expect(await findButton()).toBeTruthy();
  });

  it("offers the restart, not a second download, when another surface installed it", async () => {
    render(<UpdateButton />);
    await findButton();

    window.dispatchEvent(
      new CustomEvent("acsa:update", { detail: { kind: "install", progress: { version: available.version, phase: "ready", percent: 100 } } }),
    );
    fireEvent.click(await findButton());

    expect(await screen.findByRole("button", { name: /restart now/i })).toBeTruthy();
    expect(updater.installUpdate).not.toHaveBeenCalled();
  });
});

describe("an install started somewhere else", () => {
  it("keeps reporting in the banner after the surface that started it is gone", async () => {
    // Reported: downloading from Settings → About and closing the modal looked
    // like the download had been cancelled, because the only progress indicator
    // unmounted with the pane and the banner said nothing until it finished.
    shared.progress = { version: "0.2.13", phase: "downloading", percent: 42 };
    render(<UpdateButton />);

    const button = await screen.findByRole("button", { name: /42%|update/i }, { timeout: 5000 });
    expect(button.textContent).toContain("42%");
  });
});

/**
 * Retry, after a download that failed.
 *
 * Reported from use, with a screenshot of the banner reading "Return / error
 * decoding response body": "download failed and retry does nothing. Had to quit and
 * restart the app and try the download all over again before it worked."
 *
 * The button was labelled Retry and only toggled the panel, and the panel's actions
 * rendered *only* while idle — so a failed install had no way forward at all, and a
 * fresh process (which clears the service's state) was the only escape.
 */
describe("the titlebar button after a failed install", () => {
  const failIt = () => {
    const failed = { version: "0.2.0", phase: "failed", percent: 0, detail: "The download stopped partway." };
    vi.mocked(updater.installUpdate).mockImplementationOnce(async () => {
      window.dispatchEvent(
        new CustomEvent("acsa:update", { detail: { kind: "install", progress: failed } }),
      );
      throw new Error("install failed");
    });
    return failed;
  };

  it("offers Try again in the panel, and it retries", async () => {
    failIt();
    render(<UpdateButton />);
    fireEvent.click(await findButton());

    // The first click on "Download & install" fails — as it would in the app.
    fireEvent.click(screen.getByText("Download & install"));
    expect(await screen.findByText("Try again")).toBeTruthy();
    expect(screen.getByText("The download stopped partway.")).toBeTruthy();

    fireEvent.click(screen.getByText("Try again"));
    expect(vi.mocked(updater.installUpdate)).toHaveBeenCalledTimes(2);
  });

  it("makes the button labelled Retry retry", async () => {
    // The label promised an action and delivered a panel toggle: clicking it in
    // the failed state only opened and closed the panel that had nothing in it.
    failIt();
    render(<UpdateButton />);
    fireEvent.click(await findButton());
    fireEvent.click(screen.getByText("Download & install"));
    await screen.findByText("Try again");

    // Now the titlebar button reads "Retry", and that is what it must do.
    const retry = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retry);

    expect(vi.mocked(updater.installUpdate)).toHaveBeenCalledTimes(2);
  });
});
