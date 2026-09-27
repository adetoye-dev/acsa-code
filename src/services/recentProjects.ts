/**
 * recentProjects.ts — which remembered projects the switcher offers.
 *
 * The list the user sees is deliberately short (three), and it is filled from
 * the app database, which remembers every project ever opened. Those two facts
 * together have a failure mode: a project folder that is deleted, moved or
 * renamed leaves its row behind, and enough dead rows crowd every real project
 * out of the menu. That is exactly what happened — eight deleted test projects
 * sat above the two real ones, so "my recent projects don't appear in the
 * switcher" was literally true.
 *
 * So this is a pure function rather than a few lines inside an effect: the rule
 * (skip what is gone, never drop the active project, keep the order) is worth
 * being able to test.
 */

export interface RememberedProject {
  path: string;
  name: string;
  /** Set by the database: the folder is not on disk any more. */
  missing?: boolean;
}

export interface RecentProject {
  path: string;
  name: string;
}

/** Trailing separators make two spellings of one folder look like two folders. */
export function normalizeProjectPath(path?: string): string {
  const value = (path || "").trim();
  if (value === "/" || /^[A-Za-z]:[\\/]?$/.test(value)) {
    return value.endsWith("/") || value.endsWith("\\") ? value.slice(0, 3) : value;
  }
  return value.replace(/[/\\]+$/, "");
}

/** A path that identifies no folder at all. */
export function isPlaceholderPath(path: string): boolean {
  return !path || path === "." || path === "./";
}

/**
 * The projects to offer, in order: the active one first (it is the one the user
 * is in), then the most recently opened that still exist on disk.
 */
export function selectRecentProjects(
  activeProject: { path: string; name: string },
  stored: readonly RememberedProject[],
  limit = 3
): RecentProject[] {
  const seen = new Set<string>();
  const chosen: RecentProject[] = [];

  const activePath = normalizeProjectPath(activeProject?.path);
  if (activeProject?.name && !isPlaceholderPath(activePath)) {
    seen.add(activePath);
    chosen.push({ name: activeProject.name, path: activePath });
  }

  // `stored` arrives from the engine over IPC. The type says it is a list; the
  // runtime says nothing of the kind, and iterating a non-list throws inside a
  // component that sits in the titlebar — which takes the whole shell down with
  // it. An empty page is the right failure here.
  for (const item of Array.isArray(stored) ? stored : []) {
    const path = normalizeProjectPath(item.path);
    if (isPlaceholderPath(path) || seen.has(path)) continue;
    // Gone from disk: keep the row in the database (a folder can come back, and
    // this is not the place to destroy the user's history) but never spend one of
    // the few menu slots on it.
    if (item.missing) continue;
    seen.add(path);
    chosen.push({ name: item.name, path });
    if (chosen.length >= limit) break;
  }

  return chosen.slice(0, limit);
}
