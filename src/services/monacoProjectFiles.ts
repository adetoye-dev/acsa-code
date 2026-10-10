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

import { readTextFileForTypes } from "./fileAccess";
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
  /** Names in one directory. Only `node_modules/@types` needs this. */
  list(path: string): Promise<Array<{ name: string; is_dir: boolean }>>;
}

function desktopHost(projectRoot: string): SyncHost {
  return {
    // The mirror's reader, not the editor's: a declaration file over 2 MB is
    // normal and has to arrive anyway.
    read: (path) => readTextFileForTypes(path, projectRoot),
    tree: async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<FileNode[]>("list_project_files", { projectPath: projectRoot });
    },
    list: async (path) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<Array<{ name: string; is_dir: boolean }>>("list_directory", {
        path,
        projectRoot,
      });
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
    if (typeof value === "string" && isDeclarationFile(value)) {
      found.push(value);
      continue;
    }
    const entry = packageTypeEntry(value as Record<string, unknown>);
    if (entry) found.push(entry);
  }
  return found;
}

/**
 * Every `types` path an `exports` map names, at any depth.
 *
 * Which one TypeScript picks depends on the conditions it is resolving under —
 * `@prisma/adapter-pg` maps `require` to one declaration and `import` to another,
 * and the top-level `types` points at neither. Registering them all is what the
 * reader has in every other editor; guessing the condition is what left this
 * package unresolved while its `.d.ts` was sitting in the worker.
 */
export function exportsTypePaths(manifest: Record<string, unknown>): string[] {
  const found: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || !value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "types" || key === "typings") {
        if (typeof entry === "string" && isDeclarationFile(entry)) found.push(entry);
        continue;
      }
      walk(entry, depth + 1);
    }
  };
  walk(manifest.exports, 0);
  return [...new Set(found)];
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

/**
 * Where a package's types are when its manifest does not say.
 *
 * TypeScript resolves a bare import through `types`/`typings`, then `exports`,
 * then `main` — and a manifest that declares none of them falls back to
 * `index.d.ts` beside `index.js`. `@nestjs/testing` publishes exactly that: no
 * `main`, no `types`, no `exports`, just the two files. Reading only the declared
 * fields left ten of the sixty-three packages in the project this was reported
 * from invisible, and every one of them was an import the editor could not find.
 */
export function conventionalTypeEntries(manifest: Record<string, unknown>): string[] {
  const entries = ["index.d.ts", "index.d.mts", "index.d.cts", "index.ts", "index.tsx"];
  for (const field of ["main", "module", "browser"]) {
    const value = manifest[field];
    if (typeof value !== "string" || !value) continue;
    if (/\.(c|m)?jsx?$/.test(value)) {
      entries.push(value.replace(/\.(c|m)?jsx?$/, ".d.ts")); // dist/index.js → dist/index.d.ts
    } else if (/\.(c|m)?tsx?$/.test(value)) {
      entries.push(value); // a workspace package that ships its source
    }
  }
  return [...new Set(entries)];
}

/**
 * The relative paths one declaration file pulls in.
 *
 * `next` is the reason this exists: its `index.d.ts` is nineteen lines of
 * `/// <reference path="./app.d.ts" />` and `export * from './types'`. Registering
 * the entry alone produces a module that exists and has almost no members, which
 * is what "Module 'next' has no exported member 'MetadataRoute'" is.
 */
const DECLARATION_REFERENCE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*)["']([^"']+)["']|reference\s+path=["']([^"']+)["']/g;

/**
 * A path with its `.` and `..` segments resolved.
 *
 * Not cosmetic. TypeScript asks for `…/next/dist/types.d.ts`; a registration
 * under `…/next/./dist/types.d.ts` is a different file to the worker, which
 * answers `fileExists` by name, so the whole chase would be registered and
 * unreachable at the same time.
 */
function normalisePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

/** Where a relative specifier could point, most likely first. */
function referenceCandidates(directory: string, specifier: string): string[] {
  const base = specifier.startsWith("/") ? specifier : `${directory}/${specifier}`;
  const normalised = normalisePath(base);
  if (/\.(d\.ts|d\.mts|d\.cts|ts|tsx|mts|cts)$/.test(normalised)) return [normalised];
  return [
    `${normalised}.d.ts`,
    `${normalised}.d.mts`,
    `${normalised}.d.cts`,
    `${normalised}.ts`,
    `${normalised}.tsx`,
    `${normalised}.mts`,
    `${normalised}/index.d.ts`,
    `${normalised}/index.d.mts`,
    `${normalised}/index.ts`,
  ];
}

/**
 * The declaration files reachable from an entry, breadth-first.
 *
 * Follows what the types actually reference rather than mirroring the whole
 * package: `next` ships 1490 declaration files and needs a fraction of them,
 * and reading all of it through IPC would cost seconds per project. Bounded on
 * both axes, because a generated bundle of types can reference anything.
 */
async function chaseDeclarations(
  host: SyncHost,
  entries: string[],
  maxFiles: number,
  maxBytes: number,
  /** Where a bare specifier meets the filesystem, for self-references. */
  projectRoot = "",
): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  const queue = [...entries];
  // An entry is never dropped for its size. `lucide-react` ships one declaration
  // file of ten megabytes, and a budget that refuses it turns a package that used
  // to resolve into "Cannot find module" — the budget is for the *chase*, not for
  // the thing the import actually names.
  const pinned = new Set(entries);
  let bytes = 0;

  while (queue.length > 0 && found.length < maxFiles && bytes < maxBytes) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    let content: string;
    try {
      content = await host.read(path);
    } catch {
      continue; // a candidate that does not exist; the next one may
    }
    if (bytes + content.length > maxBytes && !pinned.has(path)) continue;
    bytes += content.length;
    found.push(path);

    const directory = path.slice(0, path.lastIndexOf("/"));
    for (const match of content.matchAll(DECLARATION_REFERENCE)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      // `next/font/google` is `export * from 'next/dist/compiled/…'` — a bare
      // reference to its own package, which nothing relative can reach.
      const bare = !specifier.startsWith(".") && !specifier.startsWith("/");
      if (bare && (!projectRoot || specifier.startsWith("node:"))) continue;
      const from = bare ? `${projectRoot}/node_modules` : directory;
      for (const candidate of referenceCandidates(from, specifier)) queue.push(candidate);
    }
    // A queue built from every candidate of every specifier is bounded by what
    // it can still do with the budget that is left.
    if (queue.length > maxFiles * 6) queue.length = maxFiles * 6;
  }
  return found;
}

/** Every `.d.ts` under a directory, bounded and symlink-following. */
/**
 * Is this a declaration file?
 *
 * `.d.mts` and `.d.cts` are declarations too, and that is not a detail: a package
 * whose `exports` maps `import` to `./esm/index.mjs` has its types in
 * `index.d.mts`, and TypeScript resolves to exactly that under `bundler` or
 * `nodenext`. `pg` and `@prisma/adapter-pg` both do this, and a mirror that only
 * knows `.d.ts` reports them as "Cannot find module" while every other editor is
 * happy.
 */
function isDeclarationFile(name: string): boolean {
  return /\.d\.(ts|mts|cts)$/.test(name);
}

/** Every declaration under a directory, bounded and symlink-following. */
async function collectDeclarations(
  host: SyncHost,
  directory: string,
  maxFiles: number,
  maxDepth: number,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries: Array<{ name: string; is_dir: boolean }>;
    try {
      entries = await host.list(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      // A package's own dependencies are separate packages with their own
      // registration; walking into them would read the whole tree.
      if (entry.name === "node_modules") continue;
      const path = `${current}/${entry.name}`;
      if (entry.is_dir) await walk(path, depth + 1);
      else if (isDeclarationFile(entry.name)) found.push(path);
    }
  };
  await walk(directory, 0);
  return found;
}

async function registerFile(
  typescript: { typescriptDefaults: { addExtraLib(content: string, uri?: string): unknown } },
  monaco: { Uri: { parse(value: string): { toString(): string } } },
  path: string,
  host: SyncHost,
  stampValue: string,
  /** Already-read content, when the caller has it. Saves a second read. */
  content?: string,
  /** Called with the file's text, for a caller collecting something from it. */
  onContent?: (content: string) => void,
): Promise<boolean> {
  // The URI has to be exactly what the model's is, or the file is a different
  // file to the worker: `@monaco-editor/react` builds models with
  // `Uri.parse(path)`, and our paths are absolute with no scheme.
  const uri = monaco.Uri.parse(path).toString();
  if (registered.get(uri) === stampValue) return false;
  const text = content ?? (await host.read(path));
  onContent?.(text);
  typescript.typescriptDefaults.addExtraLib(text, uri);
  registered.set(uri, stampValue);
  return true;
}

/** Hand the worker the project's source files. Resolves with how many landed. */
async function registerProjectSources(
  typescript: any,
  monaco: any,
  nodes: FileNode[],
  host: SyncHost,
): Promise<{ files: number; truncated: boolean; specifiers: Set<string> }> {
  const { paths, truncated } = collectProjectSources(nodes);
  const stamps = stampsByPath(nodes);
  const specifiers = new Set<string>();
  let files = 0;

  for (let index = 0; index < paths.length; index += READ_CONCURRENCY) {
    const batch = paths.slice(index, index + READ_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (path) => {
        try {
          return await registerFile(typescript, monaco, path, host, stamps.get(path) ?? "", undefined, (content) =>
            collectBareSpecifiers(content, specifiers),
          );
        } catch {
          // Unreadable: binary that slipped through, permissions, a file deleted
          // between the walk and the read. Not a reason to abandon the rest.
          return false;
        }
      }),
    );
    files += results.filter(Boolean).length;
  }

  return { files, truncated, specifiers };
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

/**
 * The type entry of every package the project declares.
 *
 * Absolute paths, like the project's own files. The worker resolves a bare
 * import to an absolute path — `<project>/node_modules/@nestjs/testing/…` — and
 * answers `fileExists` from the files it was handed, so a registration under a
 * relative name is a file it cannot find: the import stays "Cannot find module".
 */
async function registerDependencyTypes(
  typescript: any,
  monaco: any,
  host: SyncHost,
  projectRoot: string,
  /** Package names the project's own imports name, declared or not. */
  imported: Set<string> = new Set(),
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
  const importedNames = [...imported].map(packageNameOf).filter(Boolean);
  const names = [...new Set([...declared, ...importedNames])].slice(0, MAX_DEPENDENCIES);
  const declaredCount = declared.size;

  for (let index = 0; index < names.length; index += READ_CONCURRENCY) {
    const batch = names.slice(index, index + READ_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (name) => {
        for (const candidate of dependencyCandidates(name)) {
          let packageManifest: Record<string, unknown>;
          let manifestText: string;
          try {
            manifestText = await host.read(candidate);
            packageManifest = JSON.parse(manifestText) as Record<string, unknown>;
          } catch {
            continue;
          }
          // The manifest itself, because it *is* how TypeScript resolves a
          // package: `types`, `typings`, or the `exports` map. Without it the
          // worker falls back to `<pkg>/index.d.ts`, and a package whose entry is
          // anywhere else — `lucide-react` ships `dist/lucide-react.d.ts` — is an
          // import it cannot find, in a file that is clean in VS Code. A JSON file
          // as a program root is inert: measured, no diagnostics.
          let added = 0;
          try {
            if (
              await registerFile(
                typescript,
                monaco,
                `${projectRoot}/${candidate}`,
                host,
                "manifest",
                manifestText,
              )
            ) {
              added += 1;
            }
          } catch {
            /* a manifest we read but could not register; the entry still counts */
          }
          const directory = candidate.replace(/\/package\.json$/, "");
          const declaredRelative = [
            ...new Set(
              [
                packageTypeEntry(packageManifest),
                ...packageSubpathTypes(packageManifest),
                ...exportsTypePaths(packageManifest),
              ]
                .filter((entry): entry is string => Boolean(entry))
                .map((entry) => entry.replace(/^\.\//, "")),
            ),
          ];
          const declaredEntries = declaredRelative.map((entry) => `${projectRoot}/${directory}/${entry}`);
          // A package that declares no entry is not a package without types — it
          // is one TypeScript resolves by convention, `index.d.ts` beside
          // `index.js`. Every `@nestjs/*` package is that shape, and so is a
          // hand-written workspace package: 10 of the 63 in the project this was
          // reported from, and the ones whose imports were failing.
          const entries = declaredEntries.length
            ? declaredEntries
            : conventionalTypeEntries(packageManifest).map(
                (entry) => `${projectRoot}/${directory}/${entry}`,
              );
          // The entry, plus everything it references. A package's types are a
          // graph: `next/index.d.ts` is nineteen lines of references, and a
          // convention-only package re-exports between its files, so the entry
          // alone is a module whose members are all `any`.
          const chased = await chaseDeclarations(
            host,
            entries,
            MAX_CHASE_FILES,
            MAX_CHASE_BYTES,
            projectRoot,
          );
          for (const path of chased) {
            try {
              // A dependency's stamp is its register-once marker: these files are
              // not in the tree, so there is no metadata to compare, and a changed
              // `node_modules` is a changed install rather than an edit.
              if (await registerFile(typescript, monaco, path, host, "dep")) added += 1;
            } catch {
              /* unreadable declaration; the rest still stand */
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

/** The specifiers one source file imports. */
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*)["']([^"']+)["']/g;

/**
 * Every bare specifier a source file names: `lucide-react`, `next/image`.
 *
 * Bare, not just the ones with a path. A package the project imports but does
 * not list in its manifest — hoisted by another dependency, or reached through a
 * workspace — is invisible to a pass that reads `package.json`, and the import
 * is the only thing that says it is wanted.
 */
function collectBareSpecifiers(content: string, into: Set<string>): void {
  for (const match of content.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (!specifier) continue;
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
    into.add(specifier);
  }
}

/** `@scope/pkg/sub/path` → `@scope/pkg`; `pkg/sub` → `pkg`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const MAX_SUBPATHS = 300;

/**
 * The deep imports the project actually makes.
 *
 * `next/image` and `next/font/google` are subpaths, and nothing in `next`'s entry
 * references them — so no amount of following declarations finds them, and the
 * package publishes no `exports` map to read them from either. The project's own
 * imports are the only thing that says which ones exist for this codebase, which
 * is also what keeps this bounded: a project registers the subpaths it uses, not
 * the thousands a package ships.
 */
async function registerImportedSubpaths(
  typescript: any,
  monaco: any,
  host: SyncHost,
  projectRoot: string,
  specifiers: Set<string>,
): Promise<number> {
  let added = 0;
  for (const specifier of [...specifiers].slice(0, MAX_SUBPATHS)) {
    const parts = specifier.split("/");
    const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const subpath = specifier.slice(packageName.length + 1);
    if (!subpath) continue;
    const directory = `${projectRoot}/node_modules/${packageName}`;
    const entries = [
      `${subpath}.d.ts`,
      `${subpath}.d.mts`,
      `${subpath}.d.cts`,
      `${subpath}/index.d.ts`,
      `${subpath}/index.d.mts`,
      `${subpath}.ts`,
      `${subpath}/index.ts`,
    ].map((entry) => `${directory}/${entry}`);
    const chased = await chaseDeclarations(
      host,
      entries,
      MAX_CHASE_FILES,
      MAX_CHASE_BYTES,
      projectRoot,
    );
    for (const path of chased) {
      try {
        if (await registerFile(typescript, monaco, path, host, "dep")) added += 1;
      } catch {
        /* unreadable declaration; the rest still stand */
      }
    }
  }
  return added;
}

/** Where TypeScript looks for ambient packages. */
const TYPES_DIR = "node_modules/@types";
const MAX_AMBIENT_FILES = 600;
const MAX_AMBIENT_BYTES = 6 * 1024 * 1024;
const MAX_AMBIENT_DEPTH = 3;
/** How far a package's own declaration graph is followed. */
const MAX_CHASE_FILES = 500;
const MAX_CHASE_BYTES = 4 * 1024 * 1024;

/**
 * TypeScript's "include every `@types` package" step, done here instead.
 *
 * The worker's host cannot list a directory, so TypeScript's own scan of
 * `node_modules/@types` finds nothing and none of the globals those packages
 * declare — `describe`, `expect`, `beforeEach` — exist in it. The editor then
 * reports "Cannot find name 'describe'" and suggests installing types that are
 * already installed, in a file that is clean in VS Code. Reproduced against the
 * real compiler with the listing stubbed out: the error appears with it removed
 * and disappears when the same files are handed over.
 *
 * Whole packages, not their entry file. `@types/node` is dozens of declarations
 * that reference one another, and a package read one file deep is a package the
 * worker only half sees.
 */
async function registerAmbientTypes(
  typescript: any,
  monaco: any,
  host: SyncHost,
  projectRoot: string,
  allowlist: string[] | null,
): Promise<number> {
  let packages: string[];
  try {
    packages = (await host.list(TYPES_DIR))
      .filter((entry) => entry.is_dir && (!allowlist || allowlist.includes(entry.name)))
      .map((entry) => `${TYPES_DIR}/${entry.name}`);
  } catch {
    // No `@types` at all, or a `node_modules` this reader cannot see.
    return 0;
  }

  const files: string[] = [];
  for (const directory of packages) {
    if (files.length >= MAX_AMBIENT_FILES) break;
    files.push(
      ...(await collectDeclarations(
        host,
        directory,
        MAX_AMBIENT_FILES - files.length,
        MAX_AMBIENT_DEPTH,
      )),
    );
  }

  let added = 0;
  let bytes = 0;
  for (let index = 0; index < files.length; index += READ_CONCURRENCY) {
    const batch = files.slice(index, index + READ_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (relative) => {
        try {
          const content = await host.read(relative);
          if (bytes + content.length > MAX_AMBIENT_BYTES) return false;
          bytes += content.length;
          return await registerFile(
            typescript,
            monaco,
            `${projectRoot}/${relative}`,
            host,
            "ambient",
            content,
          );
        } catch {
          return false;
        }
      }),
    );
    added += results.filter(Boolean).length;
  }
  return added;
}

/**
 * The project's own `types` list, when it has one.
 *
 * A `types` field is a filter, not a hint: a project that lists `["node"]` has
 * deliberately excluded every other ambient package, and handing the worker all
 * of `@types` would make the editor accept globals the build does not.
 */
async function projectTypesAllowlist(host: SyncHost): Promise<string[] | null> {
  try {
    const document = parseTsconfig(await host.read("tsconfig.json"));
    const types = (document.compilerOptions as Record<string, unknown> | undefined)?.types;
    if (Array.isArray(types)) {
      return types.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    /* no tsconfig, or one that cannot be read: TypeScript would include the lot */
  }
  return null;
}

/**
 * `paths` targets made absolute, with a `baseUrl` to anchor them.
 *
 * The targets are relative to the file that declares them, and the worker has no
 * such file — it has a virtual current directory — so `"@/*": ["./*"]` resolved
 * against nothing and every aliased import in the project was "Cannot find
 * module". Absolute targets and a `baseUrl` of the project root say the same
 * thing without needing to know where the config lives.
 */
export function absolutisePaths(paths: unknown, projectRoot: string): Record<string, unknown> {
  if (!paths || typeof paths !== "object") return {};
  const absolute: Record<string, string[]> = {};
  for (const [alias, targets] of Object.entries(paths as Record<string, unknown>)) {
    const list = Array.isArray(targets) ? targets : [targets];
    absolute[alias] = list
      .filter((target): target is string => typeof target === "string")
      .map((target) =>
        target.startsWith(".") ? `${projectRoot}/${target.replace(/^\.\//, "")}` : target,
      );
  }
  return { paths: absolute, baseUrl: projectRoot };
}

/** Apply the project's own compiler options over our defaults. */
async function applyProjectCompilerOptions(
  typescript: any,
  host: SyncHost,
  projectRoot: string,
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

  if (merged.paths !== undefined) Object.assign(merged, absolutisePaths(merged.paths, projectRoot));

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
      const tsconfig = await applyProjectCompilerOptions(typescript, host, projectRoot);
      const { files, truncated, specifiers } = await registerProjectSources(
        typescript,
        monaco,
        nodes,
        host,
      );
      const dependencies = await registerDependencyTypes(
        typescript,
        monaco,
        host,
        projectRoot,
        specifiers,
      );
      const subpaths = await registerImportedSubpaths(
        typescript,
        monaco,
        host,
        projectRoot,
        specifiers,
      );
      const ambient = await registerAmbientTypes(
        typescript,
        monaco,
        host,
        projectRoot,
        await projectTypesAllowlist(host),
      );
      const mirrored = files + dependencies.files + subpaths + ambient;

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
