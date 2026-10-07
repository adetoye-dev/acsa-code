/**
 * fileSearch.ts — the project's files, flattened and filtered, for a picker.
 *
 * The explorer's tree is the source of truth for what a project contains, and two
 * surfaces want it as a list: the command palette and the chat's file picker.
 * Matching is deliberately simple — every term has to appear somewhere in the path,
 * case-insensitively — because a picker a reader types into is not a ranking
 * problem, and a wrong near-miss costs more than a missing one.
 */
import type { FileNode } from "../components/FileTree";

export function flattenFiles(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = [];
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) out.push(...flattenFiles(node.children));
    } else {
      out.push(node);
    }
  }
  return out;
}

export function filterFiles(files: FileNode[], query: string, limit = 50): FileNode[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches =
    terms.length === 0
      ? files
      : files.filter((file) => {
          const path = file.path.toLowerCase();
          return terms.every((term) => path.includes(term));
        });
  return matches.slice(0, limit);
}
