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
  collectProjectSources,
  dependencyCandidates,
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
  it("is enough for the real compiler to resolve the globals", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");

    let ts: typeof import("typescript");
    try {
      ts = await import("typescript");
    } catch {
      return; // no compiler installed here; the checks above still hold
    }

    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "acsa-ambient-"));
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
      await write("package.json", '{ "devDependencies": { "ts-jest": "^29.0.0" } }');
      await write(
        "tsconfig.json",
        '{ "compilerOptions": { "moduleResolution": "bundler", "target": "ES2022" } }',
      );
      await write("src/app.spec.ts", "describe('x', () => { expect(1).toBe(1); });\n");
      await write("node_modules/@types/jest/package.json", '{ "name": "@types/jest", "types": "index.d.ts" }');
      await write(
        "node_modules/@types/jest/index.d.ts",
        "declare var describe: any;\ndeclare var expect: any;\n",
      );

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
        tree: async () => [],
        list: async (path) => {
          const entries = await fs.readdir(nodePath.join(root, path), { withFileTypes: true });
          return entries.map((entry) => ({ name: entry.name, is_dir: entry.isDirectory() }));
        },
      };

      await syncProjectFiles(monaco, root, host);
      expect(libs.some((uri) => uri.endsWith("@types/jest/index.d.ts"))).toBe(true);

      const spec = nodePath.join(root, "src/app.spec.ts");
      const options = {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        noEmit: true,
        types: [] as string[],
      };
      const compilerHost = ts.createCompilerHost(options, true);
      // What the worker's host answers, and the reason any of this is needed.
      compilerHost.getDirectories = () => [];
      compilerHost.readDirectory = () => [];

      const program = ts.createProgram([spec, ...libs], options, compilerHost);
      const messages = ts
        .getPreEmitDiagnostics(program)
        .filter((diagnostic) => diagnostic.file?.fileName === spec)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));

      expect(messages.filter((message) => message.includes("Cannot find name"))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
