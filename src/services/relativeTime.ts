/**
 * relativeTime.ts — how old something is, and how long it took.
 *
 * `relativeDate` was private to the commit graph until the repository's landing
 * state needed it too. Two copies of "3h ago" would drift (the thresholds are the
 * only interesting part of it), so it lives here and both read it.
 */

/**
 * A timestamp as the shortest thing a person reads at a glance: `3h ago`.
 *
 * Unit-halving rather than a table of thresholds, because the units have to line
 * up with each other: 60 seconds, 60 minutes, 24 hours, then the approximations
 * everybody uses for weeks and months.
 */
export function relativeDate(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  const steps: [number, string][] = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [4.35, "w"],
    [12, "mo"],
  ];
  let value = seconds;
  let unit = "s";
  for (const [size, name] of steps) {
    if (value < size) {
      unit = name;
      break;
    }
    value /= size;
    unit = name;
  }
  if (unit === "s" && seconds < 45) return "just now";
  return `${Math.floor(value)}${unit} ago`;
}

/**
 * A length of time as `8m 7s`, for a run that has finished.
 *
 * A null is an unknown length, not a zero one — a run still going, or a pair of
 * timestamps that did not parse — and it says so by rendering nothing rather than
 * `0s`.
 */
export function durationLabel(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  const spareMinutes = minutes % 60;
  return spareMinutes === 0 ? `${hours}h` : `${hours}h ${spareMinutes}m`;
}
