/**
 * agentTurnLimit.ts — the ceiling on one agent turn.
 *
 * A run that quietly triples its own length looks exactly like a run that is
 * stuck. The measured case: asked to add priorities to a small project, the agent
 * spent most of a ~6 minute turn writing its own headless-browser harness. The
 * instruction it now gets (see `AGENT_BASE_INSTRUCTIONS`) sets the expectation;
 * this is the enforcement, for when the expectation is not enough.
 *
 * Deliberately a wall-clock limit on the *turn*, not a token or step budget: the
 * symptom is a turn that never ends, and the user cannot see tokens.
 */

/** What a turn gets before the app stops it. Zero means no limit. */
export const DEFAULT_TURN_LIMIT_MINUTES = 20;

/** The choices the setting offers, in minutes. Zero is "no limit", first on
 *  purpose: it should be easy to say "this one is allowed to run long". */
export const TURN_LIMIT_CHOICES = [0, 5, 10, 20, 30, 60] as const;

/** A limit in milliseconds, or `Infinity` for "no limit". */
export function turnLimitMs(minutes: number | undefined | null): number {
  const value = typeof minutes === "number" && Number.isFinite(minutes) ? minutes : DEFAULT_TURN_LIMIT_MINUTES;
  return value > 0 ? value * 60_000 : Infinity;
}

/**
 * Should the running turn be stopped?
 *
 * `blockedOnUser` is the part that matters. A turn waiting on an approval or a
 * question is not burning time — the agent is idle and the wait is the user's —
 * so a limit that counted it would stop runs for the crime of asking a question.
 * The same flag already drives the "Waiting for …" line in the composer.
 */
export function shouldStopTurn(input: {
  elapsedMs: number;
  limitMinutes?: number | null;
  blockedOnUser: boolean;
}): boolean {
  if (input.blockedOnUser) return false;
  const limit = turnLimitMs(input.limitMinutes);
  return Number.isFinite(limit) && input.elapsedMs >= limit;
}

/** `12s`, `4m 12s`, `1h 03m` — short enough for the composer's status row. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** The sentence a stopped turn leaves behind, so it never just disappears. */
export function turnLimitNotice(minutes: number): string {
  return `Stopped after the ${minutes} minute turn limit. Raise it in Settings → Agent, or send a follow-up to carry on where it left off.`;
}
