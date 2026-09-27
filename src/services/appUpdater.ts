/**
 * appUpdater.ts — checking for, and installing, a newer build.
 *
 * The policy, stated once so the UI can be dumb:
 *
 *  - **Checking is on by default, and visible.** A security fix nobody receives
 *    is worse than a version ping, but this app's pitch is that nothing leaves
 *    the machine, so the ping is a setting the user can see and turn off rather
 *    than something that happens quietly.
 *  - **Installing always waits for a click.** This app runs long-lived work —
 *    agent turns, terminal sessions, a tool adapter — and restarting under
 *    someone mid-task loses it. Nothing here installs on its own.
 *  - **Only the OS release is offered.** Tauri verifies the artifact against the
 *    public key in `tauri.conf.json`, so a tampered manifest is rejected before
 *    anything touches the disk.
 */

const AUTO_CHECK_KEY = "acsa_update_check_on_launch";
/** Don't re-check more than this often within one session. */
const CHECK_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * The version already on disk, waiting for a restart.
 *
 * Without this, quitting after an install and relaunching shows the *old* build
 * offering the download it just completed — the update looks like it failed, and
 * clicking again re-downloads it. Tauri's updater keeps no readable "installed,
 * pending restart" state (the install replaces files on disk), so we record it
 * ourselves and clear it once the running version catches up.
 */
const PENDING_RESTART_KEY = "acsa_update_pending_restart";

/** Numeric part-wise comparison: "0.2.10" is newer than "0.2.9". */
function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split(/[.+-]/).map((piece) => Number.parseInt(piece, 10));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = Number.isFinite(left[i]) ? left[i] : -1;
    const r = Number.isFinite(right[i]) ? right[i] : -1;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string;
  date?: string;
  /**
   * This version is already downloaded and waiting for a restart, rather than
   * merely published. The two need different offers — one is "download", the
   * other is "restart" — and only the caller knows which it is showing.
   */
  pendingRestart?: boolean;
}

let cached: AvailableUpdate | null = null;
let lastCheckAt = 0;
let progress: InstallProgress | null = null;

/** The live install state, for a surface that has just mounted. */
export function installProgress(): InstallProgress | null {
  return progress;
}

function setProgress(next: InstallProgress | null): void {
  progress = next;
  announce({ kind: "install", progress: next });
}

/**
 * What a check concludes, announced rather than held.
 *
 * `cached` is module state and a component cannot see it change, which is how the
 * About pane could find an update while the titlebar button stayed hidden until
 * the next launch — the pane said "the button is in the titlebar" and there was no
 * button. Every surface that shows update state listens here instead, so finding
 * one anywhere makes it appear everywhere.
 */
export type UpdateAnnouncement =
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "none" }
  | { kind: "install"; progress: InstallProgress | null };

/**
 * An install in flight, or one that has finished and is waiting for a restart.
 *
 * This lives in the service rather than in a component because it outlives the
 * surface that started it. Downloading from Settings → About and then closing the
 * modal left the download running but the *only* indication of it unmounted with
 * the pane — so it looked cancelled, and the titlebar had nothing to show until
 * the whole thing finished. Both surfaces read this one value now, so the
 * progress follows the user out of the dialog and into the banner.
 */
export type InstallPhase = "downloading" | "installing" | "ready" | "failed";

export interface InstallProgress {
  version: string;
  phase: InstallPhase;
  percent: number;
  detail?: string;
}

export const UPDATE_ANNOUNCEMENT = "acsa:update";

function announce(announcement: UpdateAnnouncement): void {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(UPDATE_ANNOUNCEMENT, { detail: announcement }));
    }
  } catch {
    /* no window (tests, or a non-DOM host): the returned outcome still carries it */
  }
}

/** Whether the app may look for updates without being asked. */
export function autoCheckEnabled(): boolean {
  try {
    const stored = localStorage.getItem(AUTO_CHECK_KEY);
    // Default on. Compared explicitly rather than truthy, because "0" is a
    // perfectly good stored value and `Boolean("0")` is true.
    return stored === null ? true : stored === "1";
  } catch {
    return true;
  }
}

export function setAutoCheck(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_CHECK_KEY, enabled ? "1" : "0");
  } catch {
    /* storage unavailable; the default stands */
  }
}

export function lastKnownUpdate(): AvailableUpdate | null {
  return cached;
}

/**
 * The three things a check can actually conclude.
 *
 * "Failed" is separate from "current" on purpose. Collapsing them is the one
 * outcome that is actively misleading: a manifest that 404s, a permission that
 * was not granted, and a genuinely up-to-date app all used to render as "You are
 * up to date", so a broken update path looked like a healthy one. That is how
 * the label on this very feature was reported as fine while nothing worked.
 */
export type CheckOutcome =
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "current" }
  | { kind: "failed"; detail: string };

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The detailed answer, for a surface that has room to explain itself. */
export async function checkForUpdateDetailed(
  options: { force?: boolean } = {},
): Promise<CheckOutcome> {
  if (!options.force && Date.now() - lastCheckAt < CHECK_COOLDOWN_MS) {
    return cached ? { kind: "available", update: cached } : { kind: "current" };
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    lastCheckAt = Date.now();
    if (!update?.available) {
      cached = null;
      announce({ kind: "none" });
      return { kind: "current" };
    }
    cached = {
      version: String(update.version),
      currentVersion: String(update.currentVersion),
      notes: String(update.body ?? "").slice(0, 2000),
      date: update.date ? String(update.date) : undefined,
    };
    // Already downloaded for this very version: the honest answer is not
    // "available", it is "restart". `check()` cannot tell the difference because
    // it only reads the manifest.
    const pending = await pendingRestart();
    if (pending && compareVersions(pending, String(update.version)) >= 0) {
      cached = { ...cached, pendingRestart: true };
      // The same channel the install itself reports on, so a surface that shows
      // "restart to finish" does not care whether it watched the download.
      setProgress({ version: pending, phase: "ready", percent: 100 });
      return { kind: "available", update: cached };
    }
    announce({ kind: "available", update: cached });
    return { kind: "available", update: cached };
  } catch (error) {
    lastCheckAt = Date.now();
    return { kind: "failed", detail: describe(error) };
  }
}

/**
 * The same question, for the titlebar: an update or nothing.
 *
 * A failure returns `null` here, because a button cannot explain itself — the
 * About pane is where the reason is shown.
 */
export async function checkForUpdate(
  options: { force?: boolean } = {},
): Promise<AvailableUpdate | null> {
  const outcome = await checkForUpdateDetailed(options);
  return outcome.kind === "available" ? outcome.update : null;
}

/**
 * Download and install the update. Resolves when it is on disk and waiting for a
 * restart — this never restarts the app itself.
 */
export async function installUpdate(onProgress?: (percent: number) => void): Promise<void> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update?.available) throw new Error("no update is available");

  const version = String(update.version);
  setProgress({ version, phase: "downloading", percent: 0 });

  let total = 0;
  let received = 0;
  try {
    await update.downloadAndInstall((event: any) => {
      if (event?.event === "Started") {
        total = Number(event.data?.contentLength ?? 0);
        setProgress({ version, phase: "downloading", percent: 0 });
        onProgress?.(0);
      } else if (event?.event === "Progress") {
        received += Number(event.data?.chunkLength ?? 0);
        const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 50;
        setProgress({ version, phase: "downloading", percent });
        onProgress?.(percent);
      } else if (event?.event === "Finished") {
        setProgress({ version, phase: "installing", percent: 100 });
        onProgress?.(100);
      }
    });
  } catch (error) {
    // Reported, not swallowed: a failed install has to be visible wherever the
    // user is standing, which is the point of holding this here.
    setProgress({ version, phase: "failed", percent: 0, detail: describe(error) });
    throw error;
  }

  // Recorded before it is announced, so the record survives the quit-then-launch
  // that motivated it: the next start is still the old build, and it has to know.
  recordPendingRestart(version);
  setProgress({ version, phase: "ready", percent: 100 });
  cached = null;
}

/** Remember that a version is installed and waiting for a restart. */
export function recordPendingRestart(version: string): void {
  try {
    localStorage.setItem(PENDING_RESTART_KEY, version);
  } catch {
    /* storage unavailable; this session still knows via the announcement */
  }
}

/**
 * The installed-but-not-yet-running version, or null.
 *
 * Clears itself once the running build is that version or newer, which is the
 * only reliable signal that the restart happened — nothing rewrites this record
 * when the new build starts.
 */
export async function pendingRestart(): Promise<string | null> {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(PENDING_RESTART_KEY);
  } catch {
    return null;
  }
  if (!stored) return null;
  const running = await currentVersion();
  // "unknown" is not evidence that the restart happened — a browser preview and a
  // failed version read both land here — so the record is kept rather than
  // dropped, at the cost of one stale Restart button in those cases.
  if (running !== "unknown" && compareVersions(running, stored) >= 0) {
    try {
      localStorage.removeItem(PENDING_RESTART_KEY);
    } catch {
      /* nothing to do */
    }
    return null;
  }
  return stored;
}

/** Relaunch into the new build. */
export async function restartApp(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("app_restart");
}

/** The running version, for the About row. */
export async function currentVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "unknown";
  }
}
