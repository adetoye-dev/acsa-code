import { beforeEach, describe, expect, it, vi } from "vitest";

/** A localStorage stand-in: the real one does not exist under the node runner. */
class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

let nextCheck: () => Promise<any> = async () => null;

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: async () => nextCheck(),
}));

const updater = await import("./appUpdater");

/** An install that fails with `message`, the way the plugin reports it. */
function installThatFailsWith(message: string) {
  nextCheck = async () => ({
    available: true,
    version: "0.2.26",
    downloadAndInstall: async () => {
      throw new Error(message);
    },
  });
}

describe("an install that fails", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new FakeStorage();
  });

  it("explains a read-only location instead of repeating the errno", async () => {
    // What the updater reports when the app is running from a translocated copy or
    // a mounted disk image. Users saw "Read-only file system (os error 30)", which
    // names no cause and offers no next step — and every one of them is stuck at
    // exactly that point.
    installThatFailsWith("Read-only file system (os error 30)");

    await expect(updater.installUpdate()).rejects.toThrow();

    const failed = updater.installProgress();
    expect(failed?.phase).toBe("failed");
    expect(failed?.detail).not.toMatch(/os error 30/i);
    expect(failed?.detail).toMatch(/read-only location/i);
    expect(failed?.detail).toMatch(/Applications/);
    // The sentence alone is not a way out; the remedy is what the UI offers.
    expect(failed?.remedy).toBe("manual");
  });

  it("keeps the provider's own words for anything it cannot explain", async () => {
    // The control: a mapping that swallowed every failure would pass the test above
    // and lose the detail of every other one.
    installThatFailsWith("network unreachable");

    await expect(updater.installUpdate()).rejects.toThrow();

    const failed = updater.installProgress();
    expect(failed?.detail).toBe("network unreachable");
    expect(failed?.remedy).toBeUndefined();
  });
});

describe("the check-on-launch preference", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new FakeStorage();
  });

  it("is on when nothing has been chosen", () => {
    // Default on deliberately: a security fix nobody receives is worse than a
    // version ping. It is a visible setting, not a hidden one.
    expect(updater.autoCheckEnabled()).toBe(true);
  });

  it("survives being turned off and on again", () => {
    updater.setAutoCheck(false);
    // `Boolean("0")` is true, so a truthiness check here would silently ignore
    // the setting — which is exactly the bug this asserts against.
    expect(updater.autoCheckEnabled()).toBe(false);
    updater.setAutoCheck(true);
    expect(updater.autoCheckEnabled()).toBe(true);
  });

  it("falls back to on when storage is unavailable", () => {
    delete (globalThis as any).localStorage;
    expect(updater.autoCheckEnabled()).toBe(true);
    expect(() => updater.setAutoCheck(false)).not.toThrow();
  });
});

describe("checking for an update", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new FakeStorage();
  });

  it("describes what the plugin reported", async () => {
    nextCheck = async () => ({
      available: true,
      version: "0.2.0",
      currentVersion: "0.1.0",
      body: "fixes",
      date: "2026-09-18",
    });
    const found = await updater.checkForUpdate({ force: true });
    expect(found).toEqual({
      version: "0.2.0",
      currentVersion: "0.1.0",
      notes: "fixes",
      date: "2026-09-18",
    });
    expect(updater.lastKnownUpdate()).toEqual(found);
  });

  it("reports nothing when the app is current", async () => {
    nextCheck = async () => ({ available: false, version: "0.1.0", currentVersion: "0.1.0" });
    expect(await updater.checkForUpdate({ force: true })).toBeNull();
  });

  it("treats an unreachable release page as 'nothing to say'", async () => {
    // No manifest published yet, or the network is down. A failed update check
    // must never surface as an app error — there is nothing the user can do.
    nextCheck = async () => {
      throw new Error("404");
    };
    await expect(updater.checkForUpdate({ force: true })).resolves.toBeNull();
  });
});
