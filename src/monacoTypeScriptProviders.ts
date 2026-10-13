/**
 * monacoTypeScriptProviders.ts — turn Monaco's own TypeScript features off.
 *
 * The app's TypeScript comes from a language server — `tsserver` running on the
 * project's own compiler, over LSP — so Monaco's built-in providers must never
 * register. They would answer beside it: two hovers for one symbol, one from each
 * compiler, disagreeing (`JSX.Element` beside `React.JSX.Element`). Since the worker
 * itself was retired (`services/tsLanguageServer.ts`) there is nothing left to answer
 * with at all — the providers would reach for a worker this app no longer ships.
 *
 * A function rather than a module side effect, because *when* it runs is the one
 * thing that matters and the caller has to be able to say so. Monaco's `tsMode.js`
 * reads this configuration **once**, when the first TypeScript model appears:
 *
 *   function registerProviders() {
 *     const { modeConfiguration } = defaults;
 *     ... registers whatever the configuration allows ...
 *   }
 *   registerProviders();      // at setup — and there is no onDidChange listener
 *
 * so anything set afterwards is stored and ignored. Whoever creates the first model
 * has to have called this: in the app that is `monacoSetup` at module load, and in a
 * test that drives the real Monaco it is the first line of the test.
 *
 * `monaco.typescript` and `monaco.languages.typescript` are both tried: 0.57 moved
 * the feature from the latter to the former, and reading the wrong one is `undefined`,
 * which would silently leave every feature on.
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

export function declineMonacoTypeScriptProviders(monaco: unknown): void {
  const typescriptFeature =
    (monaco as { typescript?: unknown }).typescript ??
    (monaco as { languages?: { typescript?: unknown } }).languages?.typescript ??
    null;

  if (!typescriptFeature) {
    // Loud, because the failure is invisible: the worker would answer beside the
    // language server and the reader would see every hover twice.
    console.warn(
      "Monaco's TypeScript feature was not found while declining its providers, so it " +
        "may answer alongside the language server. Check the export the monaco-editor " +
        "version in use provides.",
    );
    return;
  }

  const feature = typescriptFeature as {
    typescriptDefaults?: { setModeConfiguration?: (config: unknown) => void };
    javascriptDefaults?: { setModeConfiguration?: (config: unknown) => void };
  };
  feature.typescriptDefaults?.setModeConfiguration?.(ALL_WORKER_FEATURES_OFF);
  feature.javascriptDefaults?.setModeConfiguration?.(ALL_WORKER_FEATURES_OFF);
}
