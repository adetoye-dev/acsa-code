/**
 * monacoSetup.ts — point @monaco-editor/react at our locally bundled Monaco.
 *
 * By default @monaco-editor/loader fetches Monaco from
 * `https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs` at runtime. That
 * makes the editor — the core surface of this app — depend on the public
 * internet, so an offline or packaged desktop build shows an empty editor.
 * Register the `monaco-editor` package we ship instead, and take the web
 * workers from the same bundle so there is no second CDN fetch.
 *
 * Imported from the lazily-loaded editor components, so Monaco stays out of the
 * initial bundle and is only paid for once a file is actually opened.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
// Paths follow monaco-editor's `exports` map (`"./*": "./esm/vs/*.js"`), so the
// `esm/vs/` prefix must be omitted here.
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      default:
        // No TypeScript worker. Its 6.7 MB is not bundled any more, and nothing asks
        // for one: Monaco's own TypeScript providers are declined below, and the
        // editor's type checking, completions and hover come from the language
        // server instead (`services/tsLanguageServer.ts`).
        return new editorWorker();
    }
  },
};

/**
 * Decline Monaco's own TypeScript language features.
 *
 * The app's TypeScript comes from a language server — `tsserver` running on the
 * project's own compiler, over LSP — so the worker's providers must never register.
 * They would answer beside it: two hovers for one symbol, one from each compiler,
 * disagreeing (`JSX.Element` beside `React.JSX.Element`).
 *
 * This has to happen here, at module load, and not while an editor mounts. Monaco's
 * `tsMode.js` reads this configuration *once*, when the first TypeScript model
 * appears:
 *
 *   function registerProviders() {
 *     const { modeConfiguration } = defaults;
 *     ... registers whatever the configuration allows ...
 *   }
 *   registerProviders();      // at setup — and there is no onDidChange listener
 *
 * so anything set afterwards is stored and ignored. Loading this module is the
 * earliest point the app touches Monaco, and it precedes every editor and every
 * model — including the diff view, which never mounts through the editor component.
 *
 * `monaco.typescript` and `monaco.languages.typescript` are both tried: Monaco 0.57
 * moved the feature from the latter to the former, and reading the wrong one is
 * `undefined` — which would silently leave every feature on.
 */
const ALL_WORKER_FEATURES_OFF = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  signatureHelp: false,
  onTypeFormattingEdits: false,
  codeActions: false,
  inlayHints: false,
};

const typescriptFeature =
  (monaco as unknown as { typescript?: unknown }).typescript ??
  (monaco as unknown as { languages?: { typescript?: unknown } }).languages?.typescript ??
  null;

if (typescriptFeature) {
  (typescriptFeature as any).typescriptDefaults?.setModeConfiguration?.(ALL_WORKER_FEATURES_OFF);
  (typescriptFeature as any).javascriptDefaults?.setModeConfiguration?.(ALL_WORKER_FEATURES_OFF);
} else {
  // Loud, because the failure is invisible: the worker would answer beside the
  // language server and the reader would see every hover twice.
  console.warn(
    "Monaco's TypeScript feature was not found while declining its providers, so it " +
      "may answer alongside the language server. Check the export the monaco-editor " +
      "version in use provides.",
  );
}

loader.config({ monaco });

export { monaco };
