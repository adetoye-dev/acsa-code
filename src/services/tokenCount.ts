/**
 * tokenCount.ts — what a run cost, in a shape a header can hold.
 *
 * The transcript's own header says this per message, where the duration used to
 * be: both are true of the same turn, and saying how long it worked for is the
 * flow row's job — so the header spends itself on the half that is nowhere else
 * on screen, and the half people are most often surprised by. Context is re-sent
 * on every step of a turn, so input tokens dwarf output: one real run measured
 * here was 197,625 in against 16,339 out, and a reader has no way to see that
 * coming from a spinner.
 */

/**
 * `942`, `12.4k`, `1.2M` — three or four characters, because this sits in a line
 * of 11px metadata beside a model name.
 *
 * Rounded rather than truncated: 1,999 tokens reading as "1.9k" understates by
 * less than it looks, and a run that just crossed a thousand reading "1k" is the
 * number a reader would rather have seen a step earlier.
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) {
    const thousands = count / 1000;
    return `${thousands < 100 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k`;
  }
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
