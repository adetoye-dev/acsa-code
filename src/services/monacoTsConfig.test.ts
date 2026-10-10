// @vitest-environment jsdom
/**
 * The TypeScript configuration has to reach a namespace Monaco actually exposes.
 *
 * It did not: 0.57 moved the feature from `languages.typescript` to `typescript`,
 * and reading the old location made every setting in `monacoTsConfig` a silent
 * no-op. A shipped build then showed `Cannot find module './pagination.js' … (2792)`
 * on a plain `.ts` file and underlined a whole `.tsx` file for want of a `--jsx`
 * flag — the two errors that module exists to prevent. Nothing failed; it just
 * quietly did nothing.
 *
 * So the first test asks the installed package, not a stub. A stub would pass
 * whichever shape it was written for, which is exactly how this survived.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as monaco from "monaco-editor";
import { configureMonacoTypeScript } from "./monacoTsConfig";

/** A stand-in for one shape of the feature namespace. */
function featureStub(calls: Record<string, unknown>) {
  return {
    ScriptTarget: { ES2020: 7 },
    ModuleKind: { ESNext: 99 },
    ModuleResolutionKind: { Classic: 1, NodeJs: 2 },
    JsxEmit: { ReactJSX: 4 },
    typescriptDefaults: {
      setCompilerOptions: (o: unknown) => (calls.compiler = o),
      setDiagnosticsOptions: (o: unknown) => (calls.diagnostics = o),
      setEagerModelSync: (v: boolean) => (calls.eager = v),
      addExtraLib: (content: string, uri?: string) => {
        const libs = (calls.libs ??= []) as Array<{ content: string; uri?: string }>;
        libs.push({ content, uri });
      },
    },
    javascriptDefaults: {
      setCompilerOptions: () => undefined,
      setDiagnosticsOptions: () => undefined,
    },
  };
}

const roots = ["/proj/a", "/proj/b"];

describe("the Monaco TypeScript API this code depends on", () => {
  it("is reachable on the installed monaco-editor", () => {
    const feature =
      (monaco as unknown as { typescript?: unknown }).typescript ??
      (monaco as unknown as { languages?: { typescript?: unknown } }).languages?.typescript;
    expect(feature).toBeTruthy();
  });

  it("is read from the installed package by the real configure call", () => {
    // Would throw (or warn about a missing feature) if the lookup missed.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    configureMonacoTypeScript(monaco, "/proj/installed");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("applying the configuration", () => {
  beforeEach(() => {
    roots.push("/proj/" + Math.random());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the feature wherever the version exposes it", () => {
    const calls: Record<string, unknown> = {};
    configureMonacoTypeScript({ typescript: featureStub(calls) }, "/proj/a");

    const diagnostics = calls.diagnostics as { diagnosticCodesToIgnore?: number[] };
    expect(diagnostics?.diagnosticCodesToIgnore).toEqual([2307, 2792]);
    const compiler = calls.compiler as { jsx?: number; moduleResolution?: number };
    expect(compiler?.jsx).toBe(4);
    // Monaco's enum does not name Bundler; the number is what TypeScript reads.
    expect(compiler?.moduleResolution).toBe(100);
  });

  it("does not declare the JSX runtime for the project", () => {
    // It used to, and React 19 made that fatal. The runtime's types live in
    // `@types/react/jsx-runtime.d.ts`, which is where `namespace JSX` and
    // `IntrinsicElements` are declared now — an ambient `declare module` for the
    // same specifier wins over that file, so the shim replaced the JSX namespace
    // with nothing and every element in every `.tsx` became `any`
    // (7026, ninety-two times in one page of the project this came from).
    const calls: Record<string, unknown> = {};
    configureMonacoTypeScript({ typescript: featureStub(calls) }, "/proj/jsx");

    const libs = (calls.libs ?? []) as Array<{ content: string }>;
    const declaresRuntime = libs.filter(
      (lib) =>
        lib.content.includes('module "react/jsx-runtime"') ||
        lib.content.includes("module 'react/jsx-runtime'"),
    );
    expect(declaresRuntime).toEqual([]);
  });

  it("still works on the older location, so a version bump either way is safe", () => {
    const calls: Record<string, unknown> = {};
    configureMonacoTypeScript({ languages: { typescript: featureStub(calls) } }, "/proj/b");
    expect(calls.diagnostics).toBeTruthy();
  });

  it("re-applies for a different project instead of keeping the first one's typings", () => {
    const first: Record<string, unknown> = {};
    configureMonacoTypeScript({ typescript: featureStub(first) }, "/proj/one");
    const second: Record<string, unknown> = {};
    // Same monaco, a new project: the ambient libs are read per root.
    configureMonacoTypeScript({ typescript: featureStub(second) }, "/proj/two");
    expect(second.diagnostics).toBeTruthy();
  });

  it("says so when the feature cannot be found, rather than doing nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    configureMonacoTypeScript({ editor: {} }, "/proj/three");
    expect(warn).toHaveBeenCalledTimes(1);
    // Once per session, not once per editor mount.
    configureMonacoTypeScript({ editor: {} }, "/proj/four");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
