/**
 * agentTurnLimit.ts — the ceiling on one agent turn.
 *
 * A run that quietly triples its own length looks exactly like a run that is
 * stuck. The measured case: asked to add priorities to a small project, the agent
 * spent most of a ~6 minute turn writing its own headless-browser harness. The
 * instruction it now gets (see `AGENT_BASE_INSTRUCTIONS`) sets the expectation;
 * this is the enforcement, for when the expectation is not enough.
 *
 * A wall-clock limit was chosen deliberately over a token budget: the symptom is a
 * turn that never ends, and the user cannot see tokens. That reasoning does not
 * extend to *steps*, which is the number the UI puts in front of them — `29/30
 * steps`, `Step 30: Edit Files` — and the measured case that prompted this file was
 * 3m15s of work for a task whose plan said five things. Wall-clock would never have
 * caught it. So there are two bounds now: the clock for a turn that hangs, and a
 * step ceiling for a turn that is busy.
 */

/** What a turn gets before the app stops it. Zero means no limit. */
export const DEFAULT_TURN_LIMIT_MINUTES = 20;

/**
 * What a turn gets before the app stops it, in steps. Zero means no limit.
 *
 * Set from what legitimate runs actually cost here: the runs on this machine have
 * been 5, 16, 25, 27 and 30 steps, so 60 is roughly double the worst real one and
 * only a runaway should ever reach it. It is not a target to spend.
 */
export const DEFAULT_TURN_STEP_LIMIT = 60;

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
export function stopReason(input: {
  elapsedMs: number;
  limitMinutes?: number | null;
  /** Steps the turn has taken, when the caller counts them. */
  steps?: number | null;
  limitSteps?: number | null;
  blockedOnUser: boolean;
}): "time" | "steps" | null {
  // A turn waiting on the user is not burning anything — the agent is idle and the
  // wait is theirs — so neither bound counts it. Same flag as before.
  if (input.blockedOnUser) return null;

  const limit = turnLimitMs(input.limitMinutes);
  if (Number.isFinite(limit) && input.elapsedMs >= limit) return "time";

  const stepLimit =
    typeof input.limitSteps === "number" && Number.isFinite(input.limitSteps)
      ? input.limitSteps
      : DEFAULT_TURN_STEP_LIMIT;
  if (stepLimit > 0 && typeof input.steps === "number" && input.steps >= stepLimit) return "steps";

  return null;
}

/** Kept as the boolean the callers already ask, over `stopReason`. */
export function shouldStopTurn(input: {
  elapsedMs: number;
  limitMinutes?: number | null;
  steps?: number | null;
  limitSteps?: number | null;
  blockedOnUser: boolean;
}): boolean {
  return stopReason(input) !== null;
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

/** The same, for a turn stopped for taking too many steps rather than too long. */
export function turnStepLimitNotice(steps: number): string {
  return `Stopped after ${steps} steps. The task may want splitting, or the plan is larger than it looked — send a follow-up to carry on from here.`;
}

/** The sentence a stopped turn leaves behind, so it never just disappears. */
export function turnLimitNotice(minutes: number): string {
  return `Stopped after the ${minutes} minute turn limit. Raise it in Settings → Agent, or send a follow-up to carry on where it left off.`;
}
