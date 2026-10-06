/**
 * monacoProjectFiles.ts — give Monaco's TypeScript worker a filesystem.
 *
 * The worker runs in a Web Worker, so it has no filesystem: an import can only
 * resolve to a file it has been handed. That is the whole reason this exists. The
 * old answer was to suppress the two "cannot find module" diagnostics, which hid a
 * misspelled import along with the noise, and it is not an answer at all for
 * anything a user compares against another editor.
 *
 * `addExtraLib(content, uri)` is the hook Monaco provides for exactly this, and it
 * is a real filesystem in the only sense that matters here: once a file is in the
 * program, TypeScript's own resolver does the work — relative paths, extension
 * substitution (`./x.js` → `x.ts`), `index` files, `paths` aliases, and bare
 * specifiers resolved up into `node_modules`.
 *
 * What gets handed over, in order of how much it buys:
 *
 *  1. The project's own source files. This is what makes in-project imports work.
 *  2. The type entry of every package the project declares, plus `@types/<name>`.
 *     The dependency graph behind those is not mirrored — `skipLibCheck` means a
 *     `.d.ts` that cannot resolve its own imports reports nothing — so one file per
 *     declared package is enough for `import 'expo-router'` to resolve.
 *  3. The project's tsconfig, so `paths` and `moduleResolution` are the project's
 *     and not our guess.
 *
 * Everything here is best-effort and silent on failure. A filesystem that cannot
 * be built must leave the editor exactly as it was, never half-configured.
 */

import { readTextFile } from "./fileAccess";
import { typescriptFeature } from "./monacoTsConfig";
import { extendsPath, parseTsconfig, toMonacoCompilerOptions } from "./projectTsconfig";
import type { FileNode } from "../components/FileTree";

/** Extensions the worker can use. `.json` because `resolveJsonModule` is common. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** Bounds. A big project is normal; mirroring it must not cost more than reading it. */
const MAX_FILES = 1500;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DEPENDENCIES = 250;
/** One package can declare dozens of subpaths; the first dozen cover real use. */
const MAX_SUBPATHS_PER_PACKAGE = 12;
const READ_CONCURRENCY = 24;

export interface SyncResult {
  /** Files handed to the worker, cumulative for this project. */
  files: number;
  /** True when the budget stopped the mirror short. */
  truncated: boolean;
  /** Whether the project's tsconfig was applied. */
  tsconfig: boolean;
}

/**
 * Where the sync gets its files.
 *
 * Injected rather than imported at the call site so the whole chain — tsconfig,
 * project sources, dependency types, the decision to stop suppressing — can be
 * driven from a test with a handful of files instead of a real project on disk.
 * The desktop host below is the only one the app uses.
 */
export interface SyncHost {
  read(path: string): Promise<string>;
  tree(): Promise<FileNode[]>;
}

function desktopHost(projectRoot: string): SyncHost {
  return {
    read: (path) => readTextFile(path, projectRoot),
    tree: async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<FileNode[]>("list_project_files", { projectPath: projectRoot });
    },
  };
}

/**
 * uri → the stamp its content was registered at, so a re-sync skips unchanged
 * files. Size alone would miss an edit that kept the same length.
 */
const registered = new Map<string, string>();
let trees = new Map<string, FileNode[]>();
const inFlight = new Map<string, Promise<SyncResult>>();

function stamp(node: FileNode): string {
  return `${node.size_bytes}:${node.modified_ms ?? 0}`;
}

/**
 * Drop what the next sync would reuse.
 *
 * With a project root this only forgets the cached tree, so the next sync walks
 * again and re-reads just the files whose stamp changed. Called when the workspace
 * changes — a file created by an agent run has to be visible to the import that
 * resolves next — and deliberately keeps the per-file registry, which is what makes
 * that cheap.
 */
export function invalidateProjectFiles(projectRoot?: string): void {
  if (projectRoot === undefined) {
    registered.clear();
    trees = new Map();
    return;
  }
  trees.delete(projectRoot);
}

/** Every source file in the tree, absolute, cheapest-first within the budget. */
export function collectProjectSources(nodes: FileNode[]): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  let bytes = 0;
  let truncated = false;

  const visit = (list: FileNode[]) => {
    for (const node of list) {
      if (paths.length >= MAX_FILES || bytes >= MAX_TOTAL_BYTES) {
        truncated = true;
        return;
      }
      if (node.is_dir) {
        if (node.children) visit(node.children);
        continue;
      }
      const lower = node.path.toLowerCase();
      if (!SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension))) continue;
      if (node.size_bytes > MAX_FILE_BYTES) continue;
      paths.push(node.path);
      bytes += node.size_bytes;
    }
  };

  visit(nodes);
  return { paths, truncated };
}

/** TS's `types` entry for a package.json, including the modern `exports` shape. */
export function packageTypeEntry(manifest: Record<string, unknown>): string | null {
  for (const key of ["types", "typings"]) {
    if (typeof manifest[key] === "string") return manifest[key] as string;
  }
  const exports = manifest.exports as Record<string, unknown> | undefined;
  if (!exports) return null;
  const dot = exports["."] ?? exports;
  const seen: unknown[] = [dot, (dot as Record<string, unknown>)?.import, (dot as Record<string, unknown>)?.require];
  for (const entry of seen) {
    if (entry && typeof entry === "object") {
      const types = (entry as Record<string, unknown>).types;
      if (typeof types === "string") return types;
    }
  }
  return null;
}

/** Subpath type entries declared by a package, so `pkg/sub` can resolve. */
export function packageSubpathTypes(manifest: Record<string, unknown>): string[] {
  const exports = manifest.exports as Record<string, unknown> | undefined;
  if (!exports || typeof exports !== "object") return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(exports)) {
    if (found.length >= MAX_SUBPATHS_PER_PACKAGE) break;
    if (key === "." || key.startsWith("..")) continue;
    if (typeof value === "string" && value.endsWith(".d.ts")) {
      found.push(value);
      continue;
    }
    const entry = packageTypeEntry(value as Record<string, unknown>);
    if (entry) found.push(entry);
  }
  return found;
}

/** `<name>` → the `@types` package that carries it, scoped names included. */
function typesPackageFor(name: string): string {
  return `@types/${name.replace(/^@/, "").replace(/\//, "__")}`;
}

/** The relative reads that would make up a package's types, best candidate first. */
export function dependencyCandidates(name: string): string[] {
  return [
    `node_modules/${name}/package.json`,
    `node_modules/${typesPackageFor(name)}/package.json`,
  ];
}

async function registerFile(
  typescript: { typescriptDefaults: { addExtraLib(content: string, uri?: string): unknown } },
  monaco: { Uri: { parse(value: string): { toString(): string } } },
  path: string,
  host: SyncHost,
  stampValue: string,
): Promise<boolean> {
  // The URI has to be exactly what the model's is, or the file is a different
  // file to the worker: `@monaco-editor/react` builds models with
  // `Uri.parse(path)`, and our paths are absolute with no scheme.
  const uri = monaco.Uri.parse(path).toString();
  if (registered.get(uri) === stampValue) return false;
  const content = await host.read(path);
  typescript.typescriptDefaults.addExtraLib(content, uri);
  registered.set(uri, stampValue);
  return true;
}

/** Hand the worker the project's source files. Resolves with how many landed. */
async function registerProjectSources(
  typescript: any,
  monaco: any,
  nodes: FileNode[],
  host: SyncHost,
): Promise<{ files: number; truncated: boolean }> {
  const { paths, truncated } = collectProjectSources(nodes);
  const stamps = stampsByPath(nodes);
  let files = 0;

  for (let index = 0; index < paths.length; index += READ_CONCURRENCY) {
    const batch = paths.slice(index, index + READ_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (path) => {
        try {
          return await registerFile(typescript, monaco, path, host, stamps.get(path) ?? "");
        } catch {
          // Unreadable: binary that slipped through, permissions, a file deleted
          // between the walk and the read. Not a reason to abandon the rest.
          return false;
        }
      }),
    );
    files += results.filter(Boolean).length;
  }

  return { files, truncated };
}

/** Stamps by path, so a re-sync can skip what has not changed. Built once. */
function stampsByPath(nodes: FileNode[]): Map<string, string> {
  const stamps = new Map<string, string>();
  const visit = (list: FileNode[]) => {
    for (const node of list) {
      if (node.is_dir) {
        if (node.children) visit(node.children);
      } else {
        stamps.set(node.path, stamp(node));
      }
    }
  };
  visit(nodes);
  return stamps;
}

/** The type entry of every package the project declares. */
async function registerDependencyTypes(
  typescript: any,
  monaco: any,
  host: SyncHost,
): Promise<{ files: number; packages: number; declared: number }> {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await host.read("package.json")) as Record<string, unknown>;
  } catch {
    return { files: 0, packages: 0, declared: 0 };
  }

  const declared = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const group = manifest[field];
    if (group && typeof group === "object") {
      for (const name of Object.keys(group)) declared.add(name);
    }
  }

  let registeredCount = 0;
  let resolved = 0;
  const names = [...declared].slice(0, MAX_DEPENDENCIES);
  const declaredCount = names.length;

  for (let index = 0; index < names.length; index += READ_CONCURRENCY) {
    const batch = names.slice(index, index + READ_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (name) => {
        for (const candidate of dependencyCandidates(name)) {
          let packageManifest: Record<string, unknown>;
          try {
            packageManifest = JSON.parse(await host.read(candidate)) as Record<string, unknown>;
          } catch {
            continue;
          }
          const directory = candidate.replace(/\/package\.json$/, "");
          const entries = [packageTypeEntry(packageManifest), ...packageSubpathTypes(packageManifest)]
            .filter((entry): entry is string => Boolean(entry))
            .map((entry) => `${directory}/${entry.replace(/^\.\//, "")}`);
          let added = 0;
          for (const entry of entries) {
            try {
              // A dependency's stamp is its register-once marker: these files are
              // not in the tree, so there is no metadata to compare, and a changed
              // `node_modules` is a changed install rather than an edit.
              if (await registerFile(typescript, monaco, entry, host, "dep")) added += 1;
            } catch {
              /* no entry file at that path; the next candidate may have one */
            }
          }
          if (added > 0) return added;
        }
        return 0;
      }),
    );
    for (const value of results) {
      registeredCount += value;
      if (value > 0) resolved += 1;
    }
  }

  return { files: registeredCount, packages: resolved, declared: declaredCount };
}

/** Apply the project's own compiler options over our defaults. */
async function applyProjectCompilerOptions(
  typescript: any,
  host: SyncHost,
): Promise<boolean> {
  const read = async (relative: string) => {
    try {
      return parseTsconfig(await host.read(relative));
    } catch {
      return null;
    }
  };

  // Walk the `extends` chain outward. Collected child-first so it can be applied
  // parent-first: an extending file's options are the ones that win, and
  // `Object.assign` in the wrong order would let a shared base overwrite them.
  const layers: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let relative: string | null = "tsconfig.json";
  let found = false;

  // Four is deeper than any layout seen here, and a cycle must not become an
  // infinite read.
  while (relative && !visited.has(relative) && visited.size < 4) {
    visited.add(relative);
    const document = await read(relative);
    if (!document) break;
    found = true;
    layers.push(toMonacoCompilerOptions(document.compilerOptions));
    const directory: string = relative.includes("/")
      ? relative.slice(0, relative.lastIndexOf("/"))
      : "";
    relative = document.extends ? extendsPath(directory, document.extends) : null;
  }

  if (!found) return false;

  const merged: Record<string, unknown> = {};
  for (const layer of layers.reverse()) Object.assign(merged, layer);

  const defaults = typescript.typescriptDefaults.getCompilerOptions?.() ?? {};
  typescript.typescriptDefaults.setCompilerOptions({ ...defaults, ...merged });
  return true;
}

async function projectTree(projectRoot: string, host: SyncHost): Promise<FileNode[]> {
  const cached = trees.get(projectRoot);
  if (cached) return cached;
  const nodes = await host.tree();
  trees.set(projectRoot, nodes);
  return nodes;
}

/**
 * Mirror the project into the TypeScript worker.
 *
 * Idempotent and cheap to call on every editor mount: unchanged files are skipped
 * by size, and a call already running for this project is returned rather than
 * started again.
 */
export async function syncProjectFiles(
  monaco: unknown,
  projectRoot: string,
  /** Tests pass their own; the app never does. */
  overrideHost?: SyncHost,
): Promise<SyncResult> {
  const empty: SyncResult = { files: 0, truncated: false, tsconfig: false };
  if (!monaco || !projectRoot) return empty;

  const running = inFlight.get(projectRoot);
  if (running) return running;

  const host = overrideHost ?? desktopHost(projectRoot);
  const attempt = (async (): Promise<SyncResult> => {
    const typescript = typescriptFeature(monaco);
    if (!typescript) return empty;
    try {
      const nodes = await projectTree(projectRoot, host);
      const tsconfig = await applyProjectCompilerOptions(typescript, host);
      const { files, truncated } = await registerProjectSources(
        typescript,
        monaco,
        nodes,
        host,
      );
      const dependencies = await registerDependencyTypes(typescript, monaco, host);
      const mirrored = files + dependencies.files;

      // Turn real module errors on only once the worker has enough to judge them.
      //
      // Two conditions, and the second is the one that matters: a project that
      // declares dependencies but yielded none of them is a project whose
      // `node_modules` we could not read at all — a pnpm monorepo opened at a
      // sub-package, where the links resolve above the project root and the
      // reader refuses to leave it. Reporting every import as missing there would
      // be our failure, dressed up as the user's code.
      const canJudgeImports =
        files > 0 && (dependencies.declared === 0 || dependencies.packages > 0);

      if (canJudgeImports) {
        typescript.typescriptDefaults.setDiagnosticsOptions({
          noSemanticValidation: false,
          noSyntaxValidation: false,
          diagnosticCodesToIgnore: [],
        });
      }

      return { files: mirrored, truncated, tsconfig };
    } catch (error) {
      // Best effort by design: the editor is still usable without this, and a
      // half-mirrored project is better than a broken one.
      console.warn("Could not mirror the project into the TypeScript worker:", error);
      return empty;
    }
  })();

  inFlight.set(projectRoot, attempt);
  try {
    return await attempt;
  } finally {
    inFlight.delete(projectRoot);
  }
}
