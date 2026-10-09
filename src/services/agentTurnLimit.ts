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
 * 3m15s of work for a task whose plan said five things.
 *
 * A total step count is a blunt instrument, though, and this file's first attempt
 * at it shows why: 60 was set to double the worst legitimate run, which means it
 * cannot catch the case it was written for. Counting *activity* is the mistake —
 * reading ten files before one careful edit is the flow we ask for, not a symptom.
 *
 * So the mechanism is **repetition**: the same action taken over and over is a loop,
 * whatever the total. The total stays as a backstop for a turn that is merely
 * enormous.
 *
 * A "no progress" bound was considered and rejected. The measured counter-example
 * is a plan run: thirty steps, zero file changes, entirely legitimate — a read-only
 * turn makes no changes by definition, so any signal keyed on the workspace would
 * fire on exactly the work planning mode exists to do.
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

/**
 * How many times one action may repeat before the turn is treated as a loop.
 *
 * Five is deliberately low: the same command five times inside one turn is already
 * a loop, and no legitimate run here has done it. The signature is whatever the
 * caller can normalise the action to — the command, not its output.
 */
export const DEFAULT_REPEAT_LIMIT = 5;

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
/**
 * The action that has repeated too often, or null.
 *
 * Signatures are compared whole and counted across the window given — the run so
 * far — rather than consecutively, because a loop that alternates two commands is
 * still a loop. Normalising is the caller's job and matters more than it sounds:
 * `cat src/a.ts` and `cat src/b.ts` are different actions, and a normaliser that
 * strips the path would call them a loop.
 */
/**
 * The identity of one step, for repeat detection.
 *
 * Built from what the step list actually holds: a command's text is its `detail`,
 * and an edit's is the set of files it touched — so the same command twice is the
 * same signature and editing `Home.js` then `App.js` is not. Whitespace is
 * collapsed because the detail arrives as one truncated string that may wrap.
 */
export function actionSignature(step: { name?: string; detail?: string } | null | undefined): string {
  const name = String(step?.name ?? "").trim();
  const detail = String(step?.detail ?? "").replace(/\s+/g, " ").trim();
  return `${name} ${detail}`.trim();
}

export function repeatedAction(
  signatures: readonly string[] | null | undefined,
  limit: number = DEFAULT_REPEAT_LIMIT
): { signature: string; count: number } | null {
  if (!signatures || signatures.length === 0 || limit <= 0) return null;
  const counts = new Map<string, number>();
  for (const signature of signatures) {
    const key = signature.trim();
    if (!key) continue;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count >= limit) return { signature: key, count };
  }
  return null;
}

export function stopReason(input: {
  elapsedMs: number;
  limitMinutes?: number | null;
  /** Steps the turn has taken, when the caller counts them. Backstop only. */
  steps?: number | null;
  limitSteps?: number | null;
  /** What the turn has done, newest last, when the caller can normalise it. */
  signatures?: readonly string[] | null;
  repeatLimit?: number | null;
  blockedOnUser: boolean;
}): "time" | "steps" | "repeats" | null {
  // A turn waiting on the user is not burning anything — the agent is idle and the
  // wait is theirs — so neither bound counts it. Same flag as before.
  if (input.blockedOnUser) return null;

  const limit = turnLimitMs(input.limitMinutes);
  if (Number.isFinite(limit) && input.elapsedMs >= limit) return "time";

  // The loop check comes before the backstop: a turn repeating one command is worth
  // stopping at five, not at sixty.
  const repeatLimit =
    typeof input.repeatLimit === "number" && Number.isFinite(input.repeatLimit)
      ? input.repeatLimit
      : DEFAULT_REPEAT_LIMIT;
  if (repeatedAction(input.signatures, repeatLimit)) return "repeats";

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
  signatures?: readonly string[] | null;
  repeatLimit?: number | null;
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

/** The sentence for a loop, which names the action so it is actionable. */
export function turnRepeatNotice(signature: string, count: number): string {
  return `Stopped after the same step ran ${count} times (${signature}). That is a loop rather than progress — send a follow-up to carry on, or rephrase the task.`;
}

/** The same, for a turn stopped by the backstop rather than by a loop or the clock. */
export function turnStepLimitNotice(steps: number): string {
  return `Stopped after ${steps} steps. That is the backstop, not a loop — the task may want splitting. Send a follow-up to carry on from here.`;
}

/** The sentence a stopped turn leaves behind, so it never just disappears. */
export function turnLimitNotice(minutes: number): string {
  return `Stopped after the ${minutes} minute turn limit. Raise it in Settings → Agent, or send a follow-up to carry on where it left off.`;
}
