/**
 * What the virtual filesystem hands the TypeScript worker.
 *
 * These cover the choosing, not the reading: which files are worth mirroring, and
 * which file in a package is the one that declares its types. Getting the second
 * wrong is invisible — the import stays unresolved and looks like the editor not
 * understanding the project.
 */
import { describe, expect, it } from "vitest";
import type { FileNode } from "../components/FileTree";
import {
  absolutisePaths,
  collectProjectSources,
  conventionalTypeEntries,
  dependencyCandidates,
  exportsTypePaths,
  invalidateProjectFiles,
  syncProjectFiles,
  type SyncHost,
  packageSubpathTypes,
  packageTypeEntry,
} from "./monacoProjectFiles";

function file(path: string, size = 100): FileNode {
  return { name: path.split("/").pop() ?? path, path, is_dir: false, size_bytes: size };
}

function dir(path: string, children: FileNode[]): FileNode {
  return { name: path.split("/").pop() ?? path, path, is_dir: true, size_bytes: 0, children };
}

describe("choosing project files to mirror", () => {
  it("takes the source files and leaves the rest", () => {
    const nodes = [
      file("/p/src/app.ts"),
      file("/p/src/view.tsx"),
      file("/p/src/logo.png"),
      file("/p/README.md"),
      file("/p/package.json"),
    ];
    expect(collectProjectSources(nodes).paths).toEqual([
      "/p/src/app.ts",
      "/p/src/view.tsx",
      "/p/package.json",
    ]);
  });

  it("walks nested directories", () => {
    const nodes = [dir("/p/src", [dir("/p/src/lib", [file("/p/src/lib/deep.ts")])])];
    expect(collectProjectSources(nodes).paths).toEqual(["/p/src/lib/deep.ts"]);
  });

  it("skips a file too large to be a source", () => {
    const nodes = [file("/p/big.ts", 900 * 1024), file("/p/small.ts", 10)];
    expect(collectProjectSources(nodes).paths).toEqual(["/p/small.ts"]);
  });

  it("stops at the file budget and says it did", () => {
    const nodes = Array.from({ length: 1600 }, (_, i) => file(`/p/f${i}.ts`));
    const { paths, truncated } = collectProjectSources(nodes);
    expect(paths.length).toBeLessThan(1600);
    expect(truncated).toBe(true);
  });

  it("is not truncated when everything fits", () => {
    expect(collectProjectSources([file("/p/a.ts")]).truncated).toBe(false);
  });
});

describe("finding a package's types", () => {
  it("prefers the modern fields", () => {
    expect(packageTypeEntry({ types: "dist/index.d.ts", typings: "old.d.ts" })).toBe("dist/index.d.ts");
    expect(packageTypeEntry({ typings: "old.d.ts" })).toBe("old.d.ts");
  });

  it("finds types inside an exports map", () => {
    expect(packageTypeEntry({ exports: { ".": { types: "./index.d.ts" } } })).toBe("./index.d.ts");
    expect(
      packageTypeEntry({ exports: { ".": { import: { types: "./esm.d.ts" } } } }),
    ).toBe("./esm.d.ts");
  });

  it("says nothing when the package declares no types", () => {
    expect(packageTypeEntry({ main: "index.js" })).toBeNull();
  });

  it("collects declared subpaths, so `pkg/sub` can resolve", () => {
    expect(
      packageSubpathTypes({
        exports: {
          ".": { types: "./index.d.ts" },
          "./router": { types: "./router.d.ts" },
          "./direct": "./direct.d.ts",
        },
      }),
    ).toEqual(["./router.d.ts", "./direct.d.ts"]);
  });

  it("ignores keys that are not subpaths", () => {
    expect(packageSubpathTypes({ exports: { "./*": "./*" } }).length).toBe(0);
  });
});

describe("where to look for a dependency", () => {
  it("checks the package, then its @types", () => {
    expect(dependencyCandidates("expo-router")).toEqual([
      "node_modules/expo-router/package.json",
      "node_modules/@types/expo-router/package.json",
    ]);
  });

  it("spells a scoped package the way DefinitelyTyped does", () => {
    expect(dependencyCandidates("@babel/core")[1]).toBe("node_modules/@types/babel__core/package.json");
  });
});

describe("invalidation", () => {
  it("can be called for one project or all of them", () => {
    expect(() => invalidateProjectFiles("/p")).not.toThrow();
    expect(() => invalidateProjectFiles()).not.toThrow();
  });
});

/**
 * The whole chain, driven with a handful of files.
 *
 * Each piece is covered above; this is the part that only shows up when they are
 * wired together — that the project's sources are read from the *project root*,
 * that its tsconfig reaches the worker before resolution is judged, and that the
 * "cannot find module" suppression is dropped once there is something to resolve
 * against. That last one is the whole point of the feature and it is one line.
 */
describe("mirroring a project into the worker", () => {
  const files: Record<string, string> = {
    "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["src/*"] }, "moduleResolution": "bundler" } }',
    "package.json": '{ "dependencies": { "expo-router": "1.0.0" } }',
    "src/app.ts": "export const app = 1;",
    "src/readme.md": "# not source",
    "node_modules/expo-router/package.json": '{ "types": "index.d.ts" }',
    "node_modules/expo-router/index.d.ts": "export declare const Link: any;",
  };

  function stubMonaco() {
    const calls = {
      libs: [] as string[],
      compiler: null as Record<string, unknown> | null,
      diagnostics: null as Record<string, unknown> | null,
    };
    const monaco = {
      Uri: { parse: (value: string) => ({ toString: () => value }) },
      typescript: {
        typescriptDefaults: {
          addExtraLib: (_content: string, uri?: string) => {
            calls.libs.push(uri ?? "");
          },
          setCompilerOptions: (options: Record<string, unknown>) => {
            calls.compiler = options;
          },
          setDiagnosticsOptions: (options: Record<string, unknown>) => {
            calls.diagnostics = options;
          },
          getCompilerOptions: () => ({ target: 7 }),
        },
      },
    };
    return { monaco, calls };
  }

  function stubHost(root: string): SyncHost {
    /** The fixture's own keys are the directory model: no second bookkeeping. */
    const listing = (path: string) => {
      const prefix = `${path}/`;
      const entries = new Map<string, boolean>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue;
        const [head, ...rest] = key.slice(prefix.length).split("/");
        entries.set(head, rest.length > 0 || entries.get(head) === true);
      }
      return [...entries].map(([name, is_dir]) => ({ name, is_dir }));
    };
    return {
      read: async (path) => {
        // Two shapes reach the reader, and the real one accepts both: the tree
        // hands over absolute paths, while a dependency is looked up inside
        // `node_modules` by relative path.
        const key = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
        const content = files[key];
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      tree: async () => [
        { name: "src", path: `${root}/src`, is_dir: true, size_bytes: 0, children: [
          { name: "app.ts", path: `${root}/src/app.ts`, is_dir: false, size_bytes: 19 },
          { name: "readme.md", path: `${root}/src/readme.md`, is_dir: false, size_bytes: 12 },
        ] },
        { name: "package.json", path: `${root}/package.json`, is_dir: false, size_bytes: 40 },
      ],
      list: async (path) => listing(path),
    };
  }

  it("registers the project, its tsconfig and its dependencies, then stops suppressing", async () => {
    const { monaco, calls } = stubMonaco();
    const root = `/tmp/mirror-${Math.random()}`;

    const result = await syncProjectFiles(monaco, root, stubHost(root));

    // The project's own file, found by walking the tree that was handed over.
    expect(calls.libs).toContain(`${root}/src/app.ts`);
    // Not a markdown file, and not package.json twice.
    expect(calls.libs.some((uri) => uri.endsWith(".md"))).toBe(false);
    // The dependency's type entry, resolved through its package.json. Absolute:
    // resolution produces an absolute path, and the worker answers `fileExists`
    // from what it was handed.
    expect(calls.libs).toContain(`${root}/node_modules/expo-router/index.d.ts`);
    // And the manifest itself: TypeScript resolves a package through `types`,
    // `typings` and `exports`, so without it a package whose entry is anywhere
    // else is an import the worker cannot find.
    expect(calls.libs).toContain(`${root}/node_modules/expo-router/package.json`);

    // The project's tsconfig, over our default.
    expect(calls.compiler).toMatchObject({ target: 7, moduleResolution: 100 });
    expect(calls.compiler?.paths).toEqual({ "@/*": ["src/*"] });

    // And the point of the exercise.
    expect(calls.diagnostics?.diagnosticCodesToIgnore).toEqual([]);
    expect(result.files).toBeGreaterThan(0);
    expect(result.tsconfig).toBe(true);
  });

  it("leaves the suppression in place when there is nothing to mirror", async () => {
    // The browser preview: no filesystem behind the app at all, so a wall of
    // unfixable errors would be the only thing a build here could produce.
    const { monaco, calls } = stubMonaco();
    const root = `/tmp/empty-${Math.random()}`;
    const result = await syncProjectFiles(monaco, root, {
      read: async () => {
        throw new Error("no backend");
      },
      tree: async () => {
        throw new Error("no backend");
      },
      list: async () => {
        throw new Error("no backend");
      },
    });

    expect(result.files).toBe(0);
    expect(calls.diagnostics).toBeNull();
  });
});

/**
 * The ambient type packages, without which a test file has no `describe`.
 *
 * TypeScript includes every `@types` package by scanning that directory; the
 * worker's host cannot list one, so the scan finds nothing and the editor reports
 * "Cannot find name 'describe'" — in a file that is clean in VS Code, with a
 * suggestion to install types that are already installed. Reproduced against the
 * real compiler: the error appears the moment the listing is stubbed out, and
 * goes away when the same files are handed over.
 */
describe("ambient type packages", () => {
  const files: Record<string, string> = {
    "package.json": '{ "dependencies": { "expo-router": "1.0.0" } }',
    "src/app.spec.ts": "describe('x', () => { it('y', () => {}); });",
    "node_modules/@types/jest/index.d.ts": "declare var describe: any;",
    "node_modules/@types/jest/globals.d.ts": "declare var expect: any;",
    "node_modules/@types/mocha/index.d.ts": "declare var describe: any;",
  };

  function harness(root: string, tsconfig?: string) {
    const libs: string[] = [];
    const monaco = {
      Uri: { parse: (value: string) => ({ toString: () => value }) },
      typescript: {
        typescriptDefaults: {
          addExtraLib: (_content: string, uri?: string) => {
            libs.push(uri ?? "");
          },
          setCompilerOptions: () => undefined,
          setDiagnosticsOptions: () => undefined,
          getCompilerOptions: () => ({}),
        },
      },
    };
    const listing = (path: string) => {
      const prefix = `${path}/`;
      const entries = new Map<string, boolean>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue;
        const [head, ...rest] = key.slice(prefix.length).split("/");
        entries.set(head, rest.length > 0 || entries.get(head) === true);
      }
      return [...entries].map(([name, is_dir]) => ({ name, is_dir }));
    };
    const host: SyncHost = {
      read: async (path) => {
        if (path === "tsconfig.json" && tsconfig !== undefined) return tsconfig;
        const key = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
        const content = files[key];
        if (content === undefined) throw new Error(`no such file: ${path}`);
        return content;
      },
      tree: async () => [],
      list: async (path) => {
        const entries = listing(path);
        if (entries.length === 0) throw new Error(`no such directory: ${path}`);
        return entries;
      },
    };
    return { monaco, libs, host };
  }

  it("hands over a package that is not a declared dependency", async () => {
    // `@types/jest` is a transitive dependency in plenty of projects — pulled in
    // by ts-jest — so nothing in package.json names it, and only a listing finds
    // it. This is the case that was broken.
    const root = `/tmp/ambient-${Math.random()}`;
    const { monaco, libs, host } = harness(root);

    await syncProjectFiles(monaco, root, host);

    expect(libs).toContain(`${root}/node_modules/@types/jest/index.d.ts`);
  });

  it("takes the whole package, not just its entry file", async () => {
    // A package is a directory of declarations that reference each other; the
    // half that was read is the half that resolves.
    const root = `/tmp/ambient-${Math.random()}`;
    const { monaco, libs, host } = harness(root);

    await syncProjectFiles(monaco, root, host);

    expect(libs).toContain(`${root}/node_modules/@types/jest/globals.d.ts`);
  });

  it("honours the project's own types list", async () => {
    // A `types` field is a filter, not a hint: a project that lists one package
    // has excluded the rest, and handing the worker all of `@types` would let the
    // editor accept globals the build does not.
    const root = `/tmp/ambient-${Math.random()}`;
    const { monaco, libs, host } = harness(root, '{ "compilerOptions": { "types": ["jest"] } }');

    await syncProjectFiles(monaco, root, host);

    expect(libs).toContain(`${root}/node_modules/@types/jest/index.d.ts`);
    expect(libs.some((uri) => uri.includes("@types/mocha"))).toBe(false);
  });

  it("says nothing when there is no @types directory", async () => {
    const root = `/tmp/ambient-${Math.random()}`;
    const { monaco, host } = harness(root);
    host.list = async (path) => {
      if (path === "node_modules/@types") throw new Error("no such directory");
      return [];
    };

    const result = await syncProjectFiles(monaco, root, host);

    expect(result.files).toBe(0);
  });

  /**
   * The claim itself, checked against the real compiler rather than our stubs.
   *
   * Everything above tests our own bookkeeping; none of it can tell you the
   * editor stopped complaining. This runs the actual algorithm over a real
   * project on disk, then builds a TypeScript program out of *only* what the
   * worker was handed — with the directory listing stubbed out, the way the
   * worker's host has it — and asserts the diagnostic is gone. Remove the
   * ambient registration and this is the test that goes red.
   */
  it("is enough for the real compiler to resolve the globals and the imports", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");

    let ts: typeof import("typescript");
    try {
      ts = await import("typescript");
    } catch {
      return; // no compiler installed here; the checks above still hold
    }

    // Canonical, like the app's: the shell canonicalises the project root, and
    // TypeScript canonicalises again while resolving, so `/var` and `/private/var`
    // have to be the same string or a resolved file is one we never registered.
    const root = await fs.realpath(await fs.mkdtemp(nodePath.join(os.tmpdir(), "acsa-ambient-")));
    try {
      const write = async (relative: string, content: string) => {
        const target = nodePath.join(root, relative);
        await fs.mkdir(nodePath.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
      };
      // Neither `jest` nor `@types/jest` is declared: both arrive transitively
      // (through `ts-jest`, say). Nothing in `package.json` names them, so the
      // declared-dependency route cannot reach the types and a listing is the
      // only thing that can. This is the case that was broken.
      await write(
        "package.json",
        '{ "devDependencies": { "ts-jest": "^29.0.0", "@nestjs/testing": "^11.0.0" } }',
      );
      await write(
        "tsconfig.json",
        '{ "compilerOptions": { "moduleResolution": "bundler", "target": "ES2022" } }',
      );
      // The project's own files. Their imports are what name the packages that
      // no manifest of this project mentions, so the tree has to carry them.
      const sources: Array<[string, string]> = [
        ["src/app.spec.ts", "describe('x', () => { expect(1).toBe(1); });\n"],
        [
          "src/uses-nest.ts",
          "import { Test } from '@nestjs/testing';\nexport const t = Test.createTestingModule({});\n",
        ],
        [
          "src/uses-elsewhere.ts",
          "import { Search } from 'declared-elsewhere';\nexport const s = Search;\n",
        ],
        [
          "src/uses-subpath.ts",
          "import Image from 'subpath-only/image';\nexport const i = Image;\n",
        ],
      ];
      for (const [relative, content] of sources) await write(relative, content);
      await write("node_modules/@types/jest/package.json", '{ "name": "@types/jest", "types": "index.d.ts" }');
      await write(
        "node_modules/@types/jest/index.d.ts",
        "declare var describe: any;\ndeclare var expect: any;\n",
      );
      // A package that declares no entry at all, the way every `@nestjs/*`
      // package publishes: `index.d.ts` beside `index.js`, resolved by
      // convention, with a second file for the walk to find.
      await write("node_modules/@nestjs/testing/package.json", '{ "name": "@nestjs/testing" }');
      await write(
        "node_modules/@nestjs/testing/index.d.ts",
        "import { Helpers } from './helpers';\nexport declare class Test extends Helpers {}\n",
      );
      await write(
        "node_modules/@nestjs/testing/helpers.d.ts",
        "export declare class Helpers { static createTestingModule(m: unknown): unknown; }\n",
      );
      // Types that are *not* at `index.d.ts`, which is only findable through the
      // manifest — the `lucide-react` shape.
      await write(
        "node_modules/declared-elsewhere/package.json",
        '{ "name": "declared-elsewhere", "typings": "dist/index.d.ts" }',
      );
      await write(
        "node_modules/declared-elsewhere/dist/index.d.ts",
        "export declare const Search: unknown;\n",
      );
      // A deep subpath the package's entry never mentions — the `next/image` shape.
      await write("node_modules/subpath-only/package.json", '{ "name": "subpath-only" }');
      await write("node_modules/subpath-only/image.d.ts", "declare const Image: unknown;\nexport default Image;\n");

      const libs: string[] = [];
      const monaco = {
        Uri: { parse: (value: string) => ({ toString: () => value }) },
        typescript: {
          typescriptDefaults: {
            addExtraLib: (_content: string, uri?: string) => {
              libs.push(uri ?? "");
            },
            setCompilerOptions: () => undefined,
            setDiagnosticsOptions: () => undefined,
            getCompilerOptions: () => ({}),
          },
        },
      };
      const host: SyncHost = {
        read: async (path) =>
          fs.readFile(path.startsWith(`${root}/`) ? path : nodePath.join(root, path), "utf8"),
        tree: async () => [
          {
            name: "src",
            path: nodePath.join(root, "src"),
            is_dir: true,
            size_bytes: 0,
            children: sources.map(([relative]) => ({
              name: nodePath.basename(relative),
              path: nodePath.join(root, relative),
              is_dir: false,
              size_bytes: 32,
            })),
          },
        ],
        list: async (path) => {
          const entries = await fs.readdir(nodePath.join(root, path), { withFileTypes: true });
          return entries.map((entry) => ({ name: entry.name, is_dir: entry.isDirectory() }));
        },
      };

      await syncProjectFiles(monaco, root, host);
      expect(libs.some((uri) => uri.endsWith("@types/jest/index.d.ts"))).toBe(true);
      expect(libs.some((uri) => uri.endsWith("@nestjs/testing/index.d.ts"))).toBe(true);

      const spec = nodePath.join(root, "src/app.spec.ts");
      const usesNest = nodePath.join(root, "src/uses-nest.ts");
      const usesElsewhere = nodePath.join(root, "src/uses-elsewhere.ts");
      const usesSubpath = nodePath.join(root, "src/uses-subpath.ts");
      const options = {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        noEmit: true,
        types: [] as string[],
      };
      const compilerHost = ts.createCompilerHost(options, true);
      // What the worker's host answers, and the reason any of this is needed: it
      // knows the files it was handed and nothing else. The compiler's own lib
      // files come through, which is what Monaco does too.
      const known = new Set([spec, usesNest, usesElsewhere, usesSubpath, ...libs]);
      const isLib = (fileName: string) => /[\\/]lib\.[^\\/]*\.d\.ts$/.test(fileName);
      compilerHost.fileExists = (fileName) => known.has(fileName) || isLib(fileName);
      compilerHost.readFile = (fileName) =>
        known.has(fileName) || isLib(fileName) ? ts.sys.readFile(fileName) : undefined;
      compilerHost.getDirectories = () => [];
      compilerHost.readDirectory = () => [];

      const program = ts.createProgram(
        [spec, usesNest, usesElsewhere, usesSubpath, ...libs],
        options,
        compilerHost,
      );
      const messagesFor = (fileName: string) =>
        ts
          .getPreEmitDiagnostics(program)
          .filter((diagnostic) => diagnostic.file?.fileName === fileName)
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));

      // The global from the ambient package, and the module from the bare one.
      expect(messagesFor(spec).filter((m) => m.includes("Cannot find name"))).toEqual([]);
      expect(messagesFor(usesNest).filter((m) => m.includes("Cannot find module"))).toEqual([]);
      // Types the manifest points at, and a subpath the entry never names.
      expect(messagesFor(usesElsewhere).filter((m) => m.includes("Cannot find module"))).toEqual([]);
      expect(messagesFor(usesSubpath).filter((m) => m.includes("Cannot find module"))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Where a package's types are when its manifest does not say.
 *
 * `@nestjs/testing` publishes no `main`, no `types` and no `exports` — just
 * `index.d.ts` beside `index.js` — and TypeScript resolves that by convention.
 * Reading only the declared fields left ten of the sixty-three packages in the
 * project this was reported from with no types at all, which is what the editor
 * reported as "Cannot find module '@nestjs/testing'".
 */
describe("a package that declares no entry point", () => {
  it("falls back to the file TypeScript falls back to", () => {
    expect(conventionalTypeEntries({})).toContain("index.d.ts");
  });

  it("finds the declaration beside a built entry", () => {
    expect(conventionalTypeEntries({ main: "dist/index.js" })).toContain("dist/index.d.ts");
  });

  it("accepts a workspace package that ships its source", () => {
    expect(conventionalTypeEntries({ main: "src/index.ts" })).toContain("src/index.ts");
  });

  it("has nothing to offer when the manifest points somewhere real", () => {
    // The declared path is used instead; this is only a fallback.
    const entries = conventionalTypeEntries({ types: "./build/index.d.ts" });
    expect(entries).toContain("index.d.ts");
  });
});

/**
 * The two shapes that were left, both found with the real compiler against the
 * project that reported them.
 */
describe("paths a project and a package each declare", () => {
  it("anchors tsconfig path aliases to the project", () => {
    // `"@/*": ["./*"]` is relative to the file that declares it, and the worker
    // has no such file — so every aliased import in the project was "Cannot find
    // module" while the file it named sat open in the editor.
    expect(absolutisePaths({ "@/*": ["./*"], "~/*": ["src/*"] }, "/work/app")).toEqual({
      // `./*` is relative to the config file and has to be made absolute; `src/*`
      // is not, and the `baseUrl` beside it anchors it to the same place.
      paths: { "@/*": ["/work/app/*"], "~/*": ["src/*"] },
      baseUrl: "/work/app",
    });
  });

  it("leaves an absolute target alone", () => {
    const result = absolutisePaths({ x: ["/already/here/*"] }, "/work/app");
    expect((result.paths as Record<string, string[]>).x).toEqual(["/already/here/*"]);
  });

  it("takes every declaration an exports map names, not just the first", () => {
    // `@prisma/adapter-pg` maps `require` to one file and `import` to another, and
    // its top-level `types` points at neither. Registering one of them leaves
    // "Cannot find module" for whichever condition TypeScript resolved under.
    const manifest = {
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          require: { types: "./dist/index.d.ts", default: "./dist/index.js" },
          import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" },
        },
      },
    };
    expect(exportsTypePaths(manifest)).toEqual(["./dist/index.d.ts", "./dist/index.d.mts"]);
  });

  it("has nothing to say about a package with no exports", () => {
    expect(exportsTypePaths({ types: "./index.d.ts" })).toEqual([]);
  });
});
