/**
 * monacoTsConfig.ts — Make Monaco's TypeScript worker behave like the project.
 *
 * Monaco runs its own TypeScript language service inside a web worker. That
 * worker knows nothing about the project's tsconfig.json, node_modules, or files
 * that are not currently open, so left unconfigured it reports a wall of bogus,
 * unfixable errors on every .tsx file:
 *
 *   - "Cannot use JSX unless the '--jsx' flag is provided. (17004)"
 *   - "Cannot find module 'react'. Did you mean to set 'moduleResolution'... (2792)"
 *
 * So we hand the worker a compiler configuration that matches what a modern
 * project expects, load the ambient declarations Monaco cannot discover on its
 * own, and suppress the module-resolution diagnostics a browser worker can never
 * satisfy — it has no filesystem, so a package under `node_modules` is
 * unreachable no matter how the options are set. Authoritative type checking
 * remains `npm run typecheck`; this is about not putting a wall of red on code
 * that is correct.
 *
 * What this deliberately does *not* do is read the project's own tsconfig.json or
 * register the project's files, so an import of a *sibling file* is suppressed
 * rather than resolved. Doing it properly means feeding the worker every file the
 * open file imports and taking `moduleResolution`/`paths` from the project — a
 * larger change than the one this comment is attached to, and worth doing
 * together rather than half.
 */

import { readTextFile } from "./fileAccess";
import { languageServerWillRun } from "./languageServerAvailability";

/** Declaration files Monaco cannot discover but that real code depends on. */
const EXTRA_LIBS = [
  "node_modules/vite/client.d.ts",
  "node_modules/@types/react/index.d.ts",
  "node_modules/@types/react/jsx-runtime.d.ts",
  "node_modules/@types/react/jsx-dev-runtime.d.ts",
  "node_modules/@types/react-dom/index.d.ts",
  "node_modules/@types/react-dom/client.d.ts",
  "node_modules/@types/node/index.d.ts",
];

/**
 * 2307 = cannot find module; 2792 = cannot find module (did you mean ...).
 *
 * A fallback, and only for the worker. With a language server running these codes
 * are the server's to report, and it reports them accurately — a misspelled import
 * is visible again, which it was not while the mirror existed and this list hid it
 * along with the noise. They remain here for the case the worker is all there is:
 * a source checkout that has not fetched the toolchain, or a browser preview with
 * no filesystem behind it at all, where a wall of unfixable red is not a useful way
 * to say so.
 */
const DIAGNOSTIC_CODES_TO_IGNORE = [2307, 2792];

/** The project the current configuration was built for. */
let configuredFor: string | null = null;

/** One warning per session: this failing silently is how it went unnoticed. */
let warnedMissingFeature = false;

/**
 * Monaco's TypeScript feature namespace.
 *
 * Monaco 0.57 exports it as `typescript`, beside `editor` and `languages` —
 * `languages.typescript` is gone. Reading the old location made *every* call
 * below a no-op, and silently: "the feature has not loaded yet" and "the feature
 * moved" are the same `undefined` from here. The result was a TypeScript worker
 * running on its own defaults, which is precisely the wall of unfixable errors
 * this module exists to remove — reported against a shipped build as
 * `Cannot find module './pagination.js' … (2792)` and a whole `.tsx` file
 * underlined for want of a `--jsx` flag.
 *
 * Both shapes are accepted so a version bump in either direction cannot disable
 * this again, and a missing one is loud rather than silent.
 */
export function typescriptFeature(monaco: unknown): any | null {
  const candidate = monaco as
    | { typescript?: unknown; languages?: { typescript?: unknown } }
    | null
    | undefined;
  return candidate?.typescript ?? candidate?.languages?.typescript ?? null;
}

export function configureMonacoTypeScript(monaco: any, projectRoot = ""): void {
  const typescript = typescriptFeature(monaco);
  if (!typescript) {
    if (!warnedMissingFeature) {
      warnedMissingFeature = true;
      // Not a throw: the editor still works, it just reports its own defaults.
      // Saying so is the difference between a five-minute fix and a bug report
      // about TypeScript files "throwing one error or another".
      console.warn(
        "Monaco's TypeScript feature was not found on this instance, so its compiler " +
          "and diagnostic options are not being applied. Check the export the " +
          "monaco-editor version in use provides.",
      );
    }
    return;
  }
  // Keyed on the project, not a one-shot flag: the ambient libs below are read from
  // a specific project root, so the second project opened in a session used to keep
  // the first one's typings.
  if (configuredFor === projectRoot) return;
  configuredFor = projectRoot;

  const { ScriptTarget, ModuleKind, ModuleResolutionKind, JsxEmit } = typescript;
  const compilerOptions = {
    target: ScriptTarget?.ES2020 ?? 7,
    module: ModuleKind?.ESNext ?? 99,
    // Monaco's enum only names `Classic` and `NodeJs` — reading `.Bundler` off it
    // is `undefined`, so the intent silently degraded to Node10 resolution. The
    // value is forwarded to the TypeScript the worker actually runs (5.9.3), which
    // understands Bundler = 100, and that is the mode a modern ESM/TSX project
    // expects. `module: ESNext` above is what Bundler requires.
    moduleResolution: ModuleResolutionKind?.Bundler ?? 100,
    jsx: JsxEmit?.ReactJSX ?? 4,
    jsxImportSource: "react",
    allowJs: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    isolatedModules: true,
    skipLibCheck: true,
    noEmit: true,
    strict: true,
    lib: ["lib.es2020.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
  };

  typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
  typescript.javascriptDefaults.setCompilerOptions({
    ...compilerOptions,
    checkJs: false,
  });

  typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: DIAGNOSTIC_CODES_TO_IGNORE,
  });
  typescript.typescriptDefaults.setEagerModelSync(true);
  typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });

  // The JSX runtime is *not* declared here, and it used to be.
  //
  // There was an ambient `declare module "react/jsx-runtime"` for the two subpaths
  // Monaco could not resolve. It worked, until React 19's types: those live in
  // `@types/react/jsx-runtime.d.ts` and that file is where `namespace JSX` — and
  // `IntrinsicElements` — is now declared, since React 19 removed the *global*
  // `JSX` namespace that used to make the shim harmless. An ambient module
  // declaration wins over the real file, so the shim replaced the JSX namespace
  // with nothing and every element in every `.tsx` file became `any`:
  // "JSX element implicitly has type 'any' because no interface
  // 'JSX.IntrinsicElements' exists", ninety-two times in one page.
  //
  // The subpaths resolve now — the mirror registers the project's `@types` and its
  // packages — so the real declarations are what the worker sees. `EXTRA_LIBS`
  // above still names them for the case where nothing else has.

  // The worker's own providers, declined when a language server will answer. It has
  // to be decided here and not when the server comes up: Monaco registers them once,
  // when the first TypeScript model appears, and reads the mode configuration at
  // that moment only. Read `languageServerAvailability` before moving this.
  setWorkerFeaturesEnabled(monaco, !languageServerWillRun());

  void loadAmbientTypes(typescript, projectRoot);
}

/**
 * Hand everything the worker does for TypeScript over to the language server, or
 * take it back.
 *
 * The worker answers from a mirror of the project that this app used to build for
 * it (now deleted — it was 950 lines of approximation with file and package
 * budgets), and the language server answers with the project's own compiler reading
 * the project. They cannot both be on: two completion providers answering one
 * keystroke gives every symbol twice, and two sets of squiggles disagree with each
 * other on the same word.
 *
 * So the worker is switched off only once the server is *answering*, and switched
 * back on when it stops — a stopped server must never mean an editor that has
 * quietly stopped checking.
 *
 * `setModeConfiguration` is the switch that covers the rest: completion items,
 * hovers, definitions, references, highlights, symbols, rename, signature help, code
 * actions, inlay hints and formatting. It is set in full rather than field by field
 * so that a feature nobody listed here cannot stay on and duplicate the server's.
 */
const WORKER_FEATURES = [
  "completionItems",
  "hovers",
  "documentSymbols",
  "definitions",
  "references",
  "documentHighlights",
  "rename",
  "diagnostics",
  "documentRangeFormattingEdits",
  "signatureHelp",
  "onTypeFormattingEdits",
  "codeActions",
  "inlayHints",
] as const;

export function setWorkerFeaturesEnabled(monaco: any, enabled: boolean): void {
  const typescript = typescriptFeature(monaco);
  if (!typescript) return;

  typescript.typescriptDefaults?.setDiagnosticsOptions({
    noSemanticValidation: !enabled,
    noSyntaxValidation: !enabled,
    diagnosticCodesToIgnore: DIAGNOSTIC_CODES_TO_IGNORE,
  });
  // JavaScript stays unchecked by the worker either way: it never type-checked JS
  // (there was no `checkJs`), and the server reports what it can see. Syntax errors
  // in JS are still worth having from the worker when there is no server.
  typescript.javascriptDefaults?.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: !enabled,
  });

  // Written out in full in both directions, because `setModeConfiguration` stores
  // `modeConfiguration || Object.create(null)` — so passing `undefined` to mean
  // "back to how it was" sets an *empty* object, and every feature the worker has is
  // gated on a truthy flag in it. The first version of this did exactly that, which
  // would have left completions and hover permanently dead after the first time a
  // language server stopped. `WORKER_FEATURES` is the same list Monaco ships as its
  // default, so switching back on is switching back to the editor as it was.
  const mode = Object.fromEntries(WORKER_FEATURES.map((feature) => [feature, enabled]));
  typescript.typescriptDefaults?.setModeConfiguration?.(mode);
  typescript.javascriptDefaults?.setModeConfiguration?.(mode);
}

async function loadAmbientTypes(
  typescript: any,
  projectRoot: string
): Promise<void> {
  for (const libPath of EXTRA_LIBS) {
    try {
      const content = await readTextFile(libPath, projectRoot);
      if (content) {
        typescript.typescriptDefaults.addExtraLib(content, libPath);
      }
    } catch {
      // Best effort: a missing lib just means slightly less resolution.
    }
  }
}
