/**
 * turnSnapshot.ts — the file half of "undo this turn".
 *
 * The runtime will not do this, and its schemas say so: `thread/rollback`
 * ("does not revert local file changes that have been made by the agent. Clients
 * are responsible for reverting these changes") and `thread/revert` ("It does not
 * revert local file changes"). So the app captures the pre-turn state itself —
 * `snapshot_cli.py` on the engine side — and this is the thin client for it.
 *
 * Taking a snapshot is best effort on purpose. It is a safety net, not a
 * precondition: a project that is not a git repository, or an engine that cannot
 * write, must not stop the user's turn from running. Undo then reports that it has
 * nothing to undo, which is honest, rather than the turn having refused to start.
 */
import { engineCall } from "./engineBridge";

export interface TurnSnapshot {
  turnId: string;
  /** False when a file was too large to capture; undo refuses rather than guessing. */
  complete: boolean;
  files: number;
  bytes: number;
  skipped: Array<{ path: string; reason: string }>;
}

/** Capture the user's uncommitted work before a turn runs over it. */
export async function takeTurnSnapshot(
  projectRoot: string,
  turnId: string,
): Promise<TurnSnapshot | null> {
  if (!projectRoot) return null;
  try {
    return await engineCall<TurnSnapshot>("snapshot", [
      "take",
      JSON.stringify({ projectRoot, turnId }),
    ]);
  } catch {
    return null;
  }
}

/**
 * Put the named paths back to how they were before that turn.
 *
 * Throws with the engine's own sentence when it refuses — a missing snapshot, or
 * an incomplete one — because "could not undo" and "undid nothing" must not look
 * the same to the caller.
 */
export async function restoreTurnSnapshot(
  projectRoot: string,
  turnId: string,
  paths: string[],
): Promise<{ restored: string[]; removed: string[] }> {
  return engineCall<{ restored: string[]; removed: string[] }>("snapshot", [
    "restore",
    JSON.stringify({ projectRoot, turnId, paths }),
  ]);
}

/** Forget a turn's snapshot once its undo window has passed. */
export async function discardTurnSnapshot(turnId: string): Promise<void> {
  try {
    await engineCall("snapshot", ["discard", JSON.stringify({ turnId })]);
  } catch {
    /* pruned on the engine side regardless */
  }
}
