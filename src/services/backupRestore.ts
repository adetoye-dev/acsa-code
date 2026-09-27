/**
 * backupRestore.ts — the escape hatches: move your data, or hand it over.
 *
 * There is no account and no server, so the user *is* the backup strategy. Two
 * of these are data portability (a database you can put on a new machine) and
 * two are support (a file you can paste into a bug report). All four are the
 * engine's, not the UI's: the export vacuums the database so stripped secrets
 * are gone from the bytes, and the support bundle is assembled by the code that
 * knows which columns are secrets. This module only asks for a path and reports
 * what happened — it never touches the file itself.
 */

import { engineCall, hasIpc, DESKTOP_REQUIRED_MESSAGE } from "./engineBridge";

export type ActionOutcome =
  | { kind: "done"; path: string; detail?: string }
  | { kind: "cancelled" }
  | { kind: "failed"; detail: string };

/** `acsa-backup-2026-09-18.db` — a name that sorts by when it was taken. */
export function backupFileName(now: Date = new Date()): string {
  return `acsa-backup-${now.toISOString().slice(0, 10)}.db`;
}

/** `acsa-support-2026-09-18.json` — the file you attach to an issue. */
export function supportFileName(now: Date = new Date()): string {
  return `acsa-support-${now.toISOString().slice(0, 10)}.json`;
}

async function invokeTauri<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ask for a destination and export. Returns `cancelled` when the user closes the
 * picker — a closed dialog is a decision, and reporting it as a failure trains
 * people to ignore failures.
 */
export async function exportBackup(): Promise<ActionOutcome> {
  if (!hasIpc()) return { kind: "failed", detail: DESKTOP_REQUIRED_MESSAGE };
  try {
    const target = await invokeTauri<string | null>("pick_save_file", {
      defaultName: backupFileName(),
      prompt: "Save ACSA Code backup",
    });
    if (!target) return { kind: "cancelled" };

    const result = await engineCall<{ secretsIncluded: boolean; secretsRemoved: number }>(
      "backup",
      ["export", target],
    );
    return {
      kind: "done",
      path: target,
      detail: result.secretsIncluded
        ? "Included saved API keys — keep this file somewhere private."
        : result.secretsRemoved > 0
        ? `Saved without API keys (${result.secretsRemoved} removed).`
        : // Nothing to remove, because credentials are no longer stored here at all:
          // they live in the OS keychain, which this file does not carry. Saying
          // "(0 removed)" would read as a bug, and saying nothing would leave a user
          // believing their keys were in a file that has none.
          "Saved without API keys — credentials live in your system keychain, which this file does not carry.",
    };
  } catch (error) {
    return { kind: "failed", detail: reason(error) };
  }
}

/**
 * Replace this app's data with a backup file.
 *
 * The engine keeps the database it replaced (`.before-import`), so this is not a
 * one-way door. The running app, however, still holds the old data in memory —
 * hence the restart note rather than a silent success.
 */
export async function importBackup(): Promise<ActionOutcome> {
  if (!hasIpc()) return { kind: "failed", detail: DESKTOP_REQUIRED_MESSAGE };
  try {
    const source = await invokeTauri<string | null>("pick_open_file", {
      prompt: "Choose an ACSA Code backup",
    });
    if (!source) return { kind: "cancelled" };

    await engineCall("backup", ["import", source]);
    return {
      kind: "done",
      path: source,
      detail: "Restart ACSA Code to load the restored data.",
    };
  } catch (error) {
    return { kind: "failed", detail: reason(error) };
  }
}

/**
 * Write the diagnostic bundle: versions, paths, row counts, redacted settings,
 * recent crashes. No credentials, no transcript — the engine guarantees that,
 * and this file is the only thing the user has to send us.
 */
export async function createSupportBundle(): Promise<ActionOutcome> {
  if (!hasIpc()) return { kind: "failed", detail: DESKTOP_REQUIRED_MESSAGE };
  try {
    const target = await invokeTauri<string | null>("pick_save_file", {
      defaultName: supportFileName(),
      prompt: "Save ACSA Code support bundle",
    });
    if (!target) return { kind: "cancelled" };

    await engineCall("support", ["bundle", target]);
    return {
      kind: "done",
      path: target,
      detail: "No API keys, no chat history — safe to attach to a report.",
    };
  } catch (error) {
    return { kind: "failed", detail: reason(error) };
  }
}

/** Where the database and crash log actually live, for the pane to display. */
export async function dataFolderInfo(): Promise<{ dataDir: string; dbPath: string } | null> {
  if (!hasIpc()) return null;
  try {
    return await engineCall<{ dataDir: string; dbPath: string }>("db", ["info"]);
  } catch {
    return null;
  }
}

/** Open the data directory in Finder/Explorer, or the containing folder on Linux. */
export async function revealDataFolder(): Promise<ActionOutcome> {
  if (!hasIpc()) return { kind: "failed", detail: DESKTOP_REQUIRED_MESSAGE };
  try {
    const info = await engineCall<{ dataDir: string }>("db", ["info"]);
    await invokeTauri<void>("reveal_path", { path: info.dataDir });
    return { kind: "done", path: info.dataDir };
  } catch (error) {
    return { kind: "failed", detail: reason(error) };
  }
}
