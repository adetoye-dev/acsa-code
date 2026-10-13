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

describe("one install at a time", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new FakeStorage();
  });

  /**
   * Reported from use as "Download glitching", with two screenshots 43 seconds
   * apart: 59%, then 58%. A single download cannot count backwards — `received`
   * only grows and the total comes from one `Content-Length` — so the number was
   * showing two installs at once, each downloading the 155 MB and each writing
   * this one progress value, overtaking each other by a percent.
   */
  it("downloads once when it is asked for twice, and never counts backwards", async () => {
    const percents: number[] = [];
    const releases: Array<() => void> = [];
    let downloads = 0;

    // Two scripted streams, so the test would *show* the backwards number if a
    // second download were ever allowed to start: the first reports 59%, the
    // second 58%.
    const script = [590, 580];

    nextCheck = async () => ({
      available: true,
      version: "0.2.40",
      downloadAndInstall: (onEvent: (event: any) => void) =>
        new Promise<void>((resolve) => {
          const index = downloads;
          downloads += 1;
          const emit = (event: any) => {
            onEvent(event);
            const now = updater.installProgress();
            if (now?.phase === "downloading") percents.push(now.percent);
          };
          emit({ event: "Started", data: { contentLength: 1000 } });
          emit({ event: "Progress", data: { chunkLength: script[index] ?? 0 } });
          releases.push(() => {
            emit({ event: "Finished" });
            resolve();
          });
        }),
    });

    const first = updater.installUpdate();
    // The second click lands once the download is visibly underway — which is the
    // real sequence: the button keeps showing progress, so it stays clickable.
    await vi.waitFor(() => expect(releases.length).toBe(1));
    const second = updater.installUpdate();
    // Long enough for a second download to have announced itself, so this is a
    // statement about what happened rather than about timing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(downloads).toBe(1);

    releases.forEach((release) => release());
    await Promise.all([first, second]);

    expect(downloads).toBe(1);
    // The number the user watches never goes down. Zeroes are the start of an
    // attempt and are not progress, so they are not part of the comparison.
    const reported = percents.filter((percent) => percent > 0);
    expect(reported).toEqual([...reported].sort((a, b) => a - b));
    expect(reported.length).toBeGreaterThan(0);
  });

  it("leaves a failed attempt retryable rather than joining the promise that failed", async () => {
    // The join has to be about the install *in flight*, not "an install has ever
    // been attempted" — otherwise one failure would wedge the updater for the rest
    // of the session, which is a worse bug than the one being fixed.
    let attempts = 0;
    nextCheck = async () => ({
      available: true,
      version: "0.2.40",
      downloadAndInstall: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("network unreachable");
      },
    });

    await expect(updater.installUpdate()).rejects.toThrow();
    await expect(updater.installUpdate()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
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
