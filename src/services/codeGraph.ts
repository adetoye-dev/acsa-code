/**
 * codeGraph.ts — File-level dependency graph derived from indexed imports
 *
 * The engine's index graph only carries `file → its own symbols` and
 * `file → external package` edges, so it cannot answer "who imports this
 * file?". Each indexed file does carry its raw module specifiers, so we
 * resolve the project-local ones here and build a real file→file graph.
 *
 * Resolution is intentionally strict: a specifier only becomes an edge when it
 * resolves to a file that is actually in the index. That drops external
 * packages and the indexer's occasional string-literal noise.
 */

import type { IndexFileEntry } from "./agentHarness";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";

export interface CodeGraph {
  /** file → files it imports (project-local only). */
  importsOf: Map<string, string[]>;
  /** file → files that import it. */
  dependentsOf: Map<string, string[]>;
  /** Total resolved file→file edges. */
  edgeCount: number;
  /** Files other files depend on, most depended-on first. */
  hubs: Array<{ path: string; dependents: number; imports: number }>;
}

const JS_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];
const OTHER_EXTENSIONS = [".json", ".css", ".scss", ".vue", ".svelte", ".md", ".py"];
const ALL_EXTENSIONS = [...JS_EXTENSIONS, ...OTHER_EXTENSIONS];

/** Joins a relative specifier onto `dir`, collapsing `.` and `..` segments. */
function normalizeJoin(dir: string, spec: string): string {
  const parts = dir ? dir.split("/") : [];
  for (const segment of spec.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/**
 * Resolves a module specifier from `fromFile` to a known project file path,
 * or null when it points outside the project / at a third-party package.
 */
export function resolveImportSpecifier(
  spec: string,
  fromFile: string,
  known: Set<string>
): string | null {
  if (!spec) return null;
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";

  if (spec.startsWith(".")) {
    const base = normalizeJoin(dir, spec);
    // TS/ESM writes `./foo.js` to mean `./foo.ts`, so try the extensionless
    // form too.
    const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
    const bases = stripped !== base ? [base, stripped] : [base];
    const candidates: string[] = [];
    for (const b of bases) {
      for (const ext of ALL_EXTENSIONS) candidates.push(`${b}${ext}`);
    }
    for (const b of bases) {
      for (const ext of ALL_EXTENSIONS) candidates.push(`${b}/index${ext}`);
    }
    for (const candidate of candidates) {
      if (known.has(candidate)) return candidate;
    }
    return null;
  }

  // Python bare module: `project_indexer`, `mcp_client`.
  if (/^[A-Za-z_][\w.]*$/.test(spec)) {
    const modPath = spec.replace(/\./g, "/");
    const candidates = [
      dir ? `${dir}/${modPath}.py` : `${modPath}.py`,
      `${modPath}.py`,
      dir ? `${dir}/${modPath}/__init__.py` : `${modPath}/__init__.py`,
    ];
    for (const candidate of candidates) {
      if (known.has(candidate)) return candidate;
    }
  }

  return null;
}

export function buildCodeGraph(files: IndexFileEntry[]): CodeGraph {
  const known = new Set(files.map((f) => f.path));
  const importsOf = new Map<string, Set<string>>();
  const dependentsOf = new Map<string, Set<string>>();
  let edgeCount = 0;

  for (const file of files) {
    for (const spec of file.importSpecifiers || []) {
      const target = resolveImportSpecifier(spec, file.path, known);
      if (!target || target === file.path) continue;
      edgeCount += 1;
      if (!importsOf.has(file.path)) importsOf.set(file.path, new Set());
      importsOf.get(file.path)!.add(target);
      if (!dependentsOf.has(target)) dependentsOf.set(target, new Set());
      dependentsOf.get(target)!.add(file.path);
    }
  }

  const toSortedArray = (m: Map<string, Set<string>>) => {
    const out = new Map<string, string[]>();
    m.forEach((set, key) => out.set(key, [...set].sort()));
    return out;
  };

  const hubs = files
    .map((f) => ({
      path: f.path,
      dependents: dependentsOf.get(f.path)?.size || 0,
      imports: importsOf.get(f.path)?.size || 0,
    }))
    .filter((f) => f.dependents > 0)
    .sort((a, b) => b.dependents - a.dependents || b.imports - a.imports || a.path.localeCompare(b.path));

  return {
    importsOf: toSortedArray(importsOf),
    dependentsOf: toSortedArray(dependentsOf),
    edgeCount,
    hubs,
  };
}

// ── Architecture graph (interactive view) ───────────────────────────────────

/** Community colours, chosen to stay distinguishable on a dark canvas. */
export const COMMUNITY_PALETTE = [
  "#5b8def",
  "#e8833a",
  "#e05c6e",
  "#4fb3a5",
  "#8f6ce0",
  "#d9b64a",
  "#b06ac9",
  "#e0785f",
  "#4aa3df",
  "#7bbf5a",
  "#c96a9b",
  "#7f8f9c",
  "#c2a35a",
  "#5fb0c9",
];

export interface ArchNode {
  id: string;
  path: string;
  /** Short display name (basename). */
  label: string;
  language: string;
  lines: number;
  symbols: number;
  imports: number;
  dependents: number;
  community: number;
  color: string;
  isEntrypoint: boolean;
  /** Rendered node size. */
  val: number;
  index: number;
}

export interface ArchLink {
  source: string;
  target: string;
}

export interface ArchCommunity {
  id: number;
  label: string;
  count: number;
  color: string;
}

export interface ArchitectureGraph {
  nodes: ArchNode[];
  links: ArchLink[];
  communities: ArchCommunity[];
}

/**
 * Human label for a cluster: the directory most of its members live in (full
 * path, so "src/components/dashboards" beats a generic "src/components").
 */
function clusterLabel(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "(root)";
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  let best = "(root)";
  let bestCount = -1;
  counts.forEach((count, dir) => {
    // Most members wins; ties go to the shallower (more general) directory.
    if (
      count > bestCount ||
      (count === bestCount && dir.split("/").length < best.split("/").length)
    ) {
      best = dir;
      bestCount = count;
    }
  });
  return best;
}

/**
 * Shapes the resolved file graph into a renderable architecture map: nodes
 * sized by weight/consequence, coloured by dependency community (Louvain), and
 * links carrying the resolved imports.
 */
export function buildArchitectureGraph(
  files: IndexFileEntry[],
  graph: CodeGraph,
  entrypoints: string[] = []
): ArchitectureGraph {
  const communityOf = new Map<string, number>();
  const nodeGraph = new Graph({ type: "undirected", multi: false });

  for (const file of files) {
    if (!nodeGraph.hasNode(file.path)) nodeGraph.addNode(file.path);
  }
  const links: ArchLink[] = [];
  graph.importsOf.forEach((targets, source) => {
    for (const target of targets) {
      if (source === target) continue;
      if (!nodeGraph.hasNode(source) || !nodeGraph.hasNode(target)) continue;
      if (nodeGraph.hasEdge(source, target)) continue;
      try {
        nodeGraph.addEdge(source, target);
        links.push({ source, target });
      } catch {
        /* duplicate / invalid edge — the adjacency already covers it */
      }
    }
  });

  try {
    // A low resolution merges micro-clusters into recognisable subsystems,
    // which is what makes the map readable rather than confetti.
    // Louvain is randomised, so it gets a fixed seed — otherwise the clusters
    // (and their colours and labels) reshuffle on every reload.
    let seed = 20240915;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const mapping = louvain(nodeGraph, { resolution: 0.6, rng });
    Object.entries(mapping).forEach(([node, community]) => {
      communityOf.set(node, community as number);
    });
  } catch {
    // Dendrogram too large / disconnected: fall back to directory clustering.
  }

  // Louvain cannot cluster a file that has no edges — it would become a
  // one-file "community" and flood the legend. Group those by directory, which
  // is the only signal left, and keep them in the same id space.
  const isolatedByDirectory = new Map<string, number>();
  let nextCommunityId =
    communityOf.size > 0 ? Math.max(...communityOf.values()) + 1 : 0;
  for (const file of files) {
    if (nodeGraph.degree(file.path) > 0) continue;
    const parts = file.path.split("/");
    // Directory only — never let the filename become the cluster key.
    const dir =
      parts.length > 1
        ? parts.slice(0, Math.min(3, parts.length - 1)).join("/")
        : "(root)";
    if (!isolatedByDirectory.has(dir)) {
      isolatedByDirectory.set(dir, nextCommunityId++);
    }
    communityOf.set(file.path, isolatedByDirectory.get(dir)!);
  }

  const entrySet = new Set(entrypoints);
  const membersByCommunity = new Map<number, string[]>();
  // Stable directory-keyed fallback when Louvain cannot run.
  const dirCommunities = new Map<string, number>();
  const communityForDirectory = (path: string): number => {
    const dir = path.includes("/") ? path.split("/").slice(0, 2).join("/") : "(root)";
    if (!dirCommunities.has(dir)) dirCommunities.set(dir, dirCommunities.size);
    return dirCommunities.get(dir)!;
  };
  const nodes: ArchNode[] = files.map((file, index) => {
    const community = communityOf.get(file.path) ?? communityForDirectory(file.path);
    if (!membersByCommunity.has(community)) membersByCommunity.set(community, []);
    membersByCommunity.get(community)!.push(file.path);

    const imports = graph.importsOf.get(file.path)?.length || 0;
    const dependents = graph.dependentsOf.get(file.path)?.length || 0;
    return {
      id: file.path,
      path: file.path,
      label: file.path.split("/").pop() || file.path,
      language: file.language,
      lines: file.lines,
      symbols: file.symbolCount,
      imports,
      dependents,
      community,
      color: COMMUNITY_PALETTE[community % COMMUNITY_PALETTE.length],
      isEntrypoint: entrySet.has(file.path),
      val: Math.sqrt(Math.max(2, file.lines)) * 0.55 + Math.min(dependents, 30) * 0.5 + 2,
      index,
    };
  });

  const communities: ArchCommunity[] = [...membersByCommunity.entries()]
    .map(([id, members]) => ({
      id,
      label: clusterLabel(members),
      count: members.length,
      color: COMMUNITY_PALETTE[id % COMMUNITY_PALETTE.length],
    }))
    .sort((a, b) => b.count - a.count);

  // A basename stops identifying anything when several files share it — `index.ts` in
  // every folder, which is what most TypeScript projects look like, so the map drew five
  // nodes with the same name and the tooltip was the only way to tell them apart. The
  // parent folder is the shortest thing that distinguishes them, so only the ambiguous
  // ones pay for it; a name that is already unique stays as short as it was.
  const nameCount = new Map<string, number>();
  for (const node of nodes) nameCount.set(node.label, (nameCount.get(node.label) || 0) + 1);
  for (const node of nodes) {
    if ((nameCount.get(node.label) || 0) > 1) {
      const parent = node.path.split("/").slice(-2, -1)[0];
      node.label = parent ? `${parent}/${node.label}` : node.path;
    }
  }
  // Two folders can still collide (`a/notes/index.ts`, `b/notes/index.ts`); the path is
  // the only thing left that is unique, so those fall back to it.
  const stillAmbiguous = new Map<string, number>();
  for (const node of nodes) stillAmbiguous.set(node.label, (stillAmbiguous.get(node.label) || 0) + 1);
  for (const node of nodes) {
    if ((stillAmbiguous.get(node.label) || 0) > 1) node.label = node.path;
  }

  // Two clusters can share a directory (a big folder split in two), which makes
  // the legend ambiguous — disambiguate with a stable ordinal.
  const labelSeen = new Map<string, number>();
  for (const community of communities) {
    const seen = (labelSeen.get(community.label) || 0) + 1;
    labelSeen.set(community.label, seen);
    if (seen > 1) community.label = `${community.label} (${seen})`;
  }

  return { nodes, links, communities };
}

/**
 * A precise, instant description of a file's role, derived only from indexed
 * facts (no model call): what imports it, what it imports, what it defines.
 * Returns short bullets ready to render.
 */
export function describeFileRole(
  file: IndexFileEntry,
  graph: CodeGraph,
  entrypoints: string[] = []
): string[] {
  const imports = graph.importsOf.get(file.path)?.length || 0;
  const dependents = graph.dependentsOf.get(file.path)?.length || 0;
  const lines: string[] = [];

  if (entrypoints.includes(file.path)) {
    lines.push("Application entry point — the app boots from here.");
  }

  if (dependents >= 10) {
    lines.push(`Widely shared module — ${dependents} files import it, so changes ripple widely.`);
  } else if (dependents >= 3) {
    lines.push(`Shared building block — ${dependents} files import it.`);
  } else if (dependents > 0) {
    lines.push(`Used by ${dependents} file${dependents === 1 ? "" : "s"}.`);
  }

  if (dependents === 0 && imports === 0) {
    lines.push("Self-contained — nothing imports it and it imports nothing.");
  } else if (dependents === 0 && imports >= 3) {
    lines.push(`Leaf module — pulls in ${imports} files and nothing imports it.`);
  } else if (imports === 0 && dependents > 0) {
    lines.push("Foundation module — it imports nothing but others depend on it.");
  }

  if (file.symbolCount === 0) {
    lines.push("Holds no top-level symbols (configuration, styles or assets).");
  } else {
    lines.push(`Defines ${file.symbolCount} top-level symbol${file.symbolCount === 1 ? "" : "s"}.`);
  }

  const language = file.language || "unknown";
  lines.push(`${language} · ${file.lines} lines`);
  return lines;
}
