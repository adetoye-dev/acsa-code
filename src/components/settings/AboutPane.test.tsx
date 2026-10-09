// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

type Outcome = { kind: "available"; update: any } | { kind: "current" } | { kind: "failed"; detail: string };
let outcome: Outcome = { kind: "current" };

const RELEASE_URL = "https://github.com/adetoye-dev/acsa-code/releases/latest";

const opened = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("../../services/openExternal", () => ({
  openExternal: async (url: string) => {
    opened.urls.push(url);
    return true;
  },
  isOpenableUrl: () => true,
}));

vi.mock("../../services/appUpdater", () => ({
  autoCheckEnabled: () => true,
  setAutoCheck: vi.fn(),
  currentVersion: async () => "0.2.0",
  RELEASE_PAGE_URL: "https://github.com/adetoye-dev/acsa-code/releases/latest",
  checkForUpdateDetailed: async () => outcome,
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
  UPDATE_ANNOUNCEMENT: "acsa:update",
  installProgress: () => null,
}));

const { AboutPane } = await import("./AboutPane");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  opened.urls = [];
});

describe("an update that cannot replace the copy that is running", () => {
  it("says why and offers the way out, in that order", async () => {
    // What the read-only failure looked like to users: "Read-only file system (os
    // error 30)", with no cause and no next step. That user is not going to debug
    // an errno, so the sentence has to explain the copy they are running and the
    // link has to exist — it is the only action that can still work.
    render(<AboutPane />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("acsa:update", {
          detail: {
            kind: "install",
            progress: {
              version: "0.2.26",
              phase: "failed",
              percent: 0,
              detail: "ACSA Code is running from a read-only location, so it cannot replace itself.",
              remedy: "manual",
            },
          },
        }),
      );
    });

    expect(screen.getByText(/read-only location/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /open the download page/i }));
    expect(opened.urls).toEqual([RELEASE_URL]);
  });

  it("does not offer a download page for a failure that can just be retried", async () => {
    // The control: the link is tied to the remedy, not to failure in general.
    render(<AboutPane />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("acsa:update", {
          detail: {
            kind: "install",
            progress: { version: "0.2.26", phase: "failed", percent: 0, detail: "network unreachable" },
          },
        }),
      );
    });

    expect(screen.getByText(/network unreachable/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open the download page/i })).toBeNull();
  });
});

describe("the About pane", () => {
  it("shows the running version", async () => {
    render(<AboutPane />);
    expect(await screen.findByText("0.2.0")).toBeTruthy();
  });

  it("says up to date only when the check actually said so", async () => {
    outcome = { kind: "current" };
    render(<AboutPane />);
    fireEvent.click(screen.getByRole("button", { name: /check now/i }));
    expect(await screen.findByText(/you are up to date/i)).toBeTruthy();
  });

  it("says why when the check fails, instead of claiming everything is fine", async () => {
    // This is the bug worth pinning: "up to date", "no manifest published" and
    // "the request failed" all used to render as "You are up to date", so a
    // broken update path looked like a healthy one.
    outcome = { kind: "failed", detail: "404 not found" };
    render(<AboutPane />);
    fireEvent.click(screen.getByRole("button", { name: /check now/i }));
    expect(await screen.findByText(/404 not found/)).toBeTruthy();
    expect(screen.queryByText(/you are up to date/i)).toBeNull();
  });
});

describe("acting on the update from this pane", () => {
  it("offers the install button here, rather than pointing at the titlebar", async () => {
    // Reported: "it says update available and instead of giving me an update
    // button, it's referring me back to the home page button which also doesn't
    // come up until the app is restarted." Finding an update is the moment the
    // user wants to act on it, and this is where they are standing.
    outcome = { kind: "available", update: { version: "0.2.9", currentVersion: "0.2.7", notes: "" } };
    render(<AboutPane />);
    fireEvent.click(screen.getByRole("button", { name: /check now/i }));

    const install = await screen.findByRole("button", { name: /download & install 0\.2\.9/i });
    expect(install).toBeTruthy();

    fireEvent.click(install);
    // And once it is on disk, the last step is still the user's to take.
    expect(await screen.findByRole("button", { name: /restart to finish/i })).toBeTruthy();
  });
});

describe("an update that is already downloaded", () => {
  it("offers the restart instead of downloading it a second time", async () => {
    // The quit-after-install case: the running build is still the old one, so the
    // manifest offers the version already on disk. Offering "Download & install"
    // here reads as "the update failed" and re-downloads the whole app.
    outcome = {
      kind: "available",
      update: { version: "0.2.10", currentVersion: "0.2.9", notes: "", pendingRestart: true },
    };
    render(<AboutPane />);
    fireEvent.click(screen.getByRole("button", { name: /check now/i }));

    expect(await screen.findByText(/installed and waiting for a restart/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /restart to finish/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /download & install/i })).toBeNull();
  });
});
