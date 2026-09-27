// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateAnnouncement } from "./appUpdater";

/**
 * A check has to be *announced*, not just remembered.
 *
 * The reported bug: Settings → About said "0.2.8 is available — the button is in
 * the titlebar" while no button existed, because the titlebar only looked on
 * mount. The result lived in a module variable that no component can observe
 * changing, so finding an update in one place was invisible everywhere else.
 *
 * This is the sending end; `UpdateButton.test.tsx` is the receiving one.
 */

let nextCheck: () => Promise<any> = async () => null;

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: async () => nextCheck(),
}));

const updater = await import("./appUpdater");

function collect(): UpdateAnnouncement[] {
  const seen: UpdateAnnouncement[] = [];
  window.addEventListener(updater.UPDATE_ANNOUNCEMENT, (event) => {
    seen.push((event as CustomEvent<UpdateAnnouncement>).detail);
  });
  return seen;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("what a check tells the rest of the app", () => {
  it("announces the version when one is available", async () => {
    nextCheck = async () => ({
      available: true,
      version: "0.2.9",
      currentVersion: "0.2.7",
      body: "notes",
    });
    const seen = collect();

    const outcome = await updater.checkForUpdateDetailed({ force: true });

    expect(outcome.kind).toBe("available");
    expect(seen).toEqual([
      { kind: "available", update: { version: "0.2.9", currentVersion: "0.2.7", notes: "notes", date: undefined } },
    ]);
  });

  it("announces nothing rather than staying quiet when the app is current", async () => {
    // Silence would leave a stale button up after a release is withdrawn, so the
    // up-to-date case is announced too.
    nextCheck = async () => ({ available: false });
    const seen = collect();

    await updater.checkForUpdateDetailed({ force: true });

    expect(seen).toEqual([{ kind: "none" }]);
  });

  it("does not throw when the check fails", async () => {
    nextCheck = async () => {
      throw new Error("manifest 404");
    };
    const seen = collect();

    const outcome = await updater.checkForUpdateDetailed({ force: true });

    expect(outcome.kind).toBe("failed");
    // The pane explains the failure; there is nothing to announce about a version.
    expect(seen).toEqual([]);
  });
});

/**
 * The quit-after-install case: the install replaces files on disk, so the *next*
 * launch is still the old build reading a manifest that offers the version it
 * already has. Without a record it offers the download again, which reads as "the
 * update failed" and re-downloads ~100 MB if the user believes it.
 */
describe("an update that is installed but not running yet", () => {
  it("reports a restart rather than a download, and survives a relaunch", async () => {
    const storage = new Map<string, string>();
    // `vi.stubGlobal`, because jsdom defines `localStorage` as getter-only.
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
    // What the running app says about itself: the *old* build, because the
    // restart has not happened.
    vi.doMock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.9" }));
    nextCheck = async () => ({
      available: true,
      version: "0.2.10",
      currentVersion: "0.2.9",
      body: "notes",
    });

    updater.recordPendingRestart("0.2.10");
    const outcome = await updater.checkForUpdateDetailed({ force: true });

    expect(outcome.kind).toBe("available");
    expect(outcome.kind === "available" && outcome.update.pendingRestart).toBe(true);
    expect(await updater.pendingRestart()).toBe("0.2.10");
  });

  it("forgets the record once the new build is the one running", async () => {
    const storage = new Map<string, string>();
    // `vi.stubGlobal`, because jsdom defines `localStorage` as getter-only.
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
    // The restart happened: the running version is the installed one.
    vi.doMock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.10" }));
    updater.recordPendingRestart("0.2.10");

    expect(await updater.pendingRestart()).toBeNull();
    // And the record is gone, not merely ignored, so the next launch agrees.
    expect(storage.has("acsa_update_pending_restart")).toBe(false);
  });

  it("compares versions numerically, so 0.2.10 is newer than 0.2.9", async () => {
    // A string comparison would call 0.2.10 older and never clear the record.
    const storage = new Map<string, string>();
    // `vi.stubGlobal`, because jsdom defines `localStorage` as getter-only.
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
    vi.doMock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.9" }));
    updater.recordPendingRestart("0.2.10");

    expect(await updater.pendingRestart()).toBe("0.2.10");
  });
});
