/**
 * Whether a language server will be there — asked once, answered synchronously.
 *
 * **Why this is separate from `tsLanguageServer`, and why it is asked early.**
 * Monaco's TypeScript worker registers its own completion, hover, definition and
 * diagnostic providers once, inside `tsMode.js`:
 *
 *   function registerProviders() {
 *     const { modeConfiguration } = defaults;
 *     ... registers whatever the configuration allows ...
 *   }
 *   registerProviders();      // at setup, and there is no listener
 *
 * It runs when the first TypeScript model appears, reads the mode configuration
 * *then*, and never looks again — so `setModeConfiguration` afterwards changes a
 * stored value and nothing else. Declining the worker later therefore declined
 * nothing, and both compilers went on answering: the reader saw every hover line
 * twice, one from each (`JSX.Element` beside `React.JSX.Element`, `any` beside
 * `string`).
 *
 * The decision has to be made before that first model exists, and the editor asks
 * it synchronously while mounting — an `invoke` cannot answer synchronously — so it
 * is probed once at startup and cached here. Kept in its own module so that
 * `monacoTsConfig` can read it without importing `tsLanguageServer`, which imports
 * `monacoTsConfig`.
 */

/** Optimistic: the app ships the toolchain, and the worker is only the fallback. */
let toolchainAvailable = true;
let probed = false;

export function languageServerWillRun(): boolean {
  return toolchainAvailable;
}

export async function probeToolchainAvailability(): Promise<boolean> {
  if (probed) return toolchainAvailable;
  probed = true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // Coerced: a shell without this command answers nothing, and "unknown" must not
    // read as "yes".
    toolchainAvailable = Boolean(await invoke<boolean>("lsp_available", {}));
  } catch {
    // No desktop shell — a browser preview, where the worker is all there is.
    toolchainAvailable = false;
  }
  return toolchainAvailable;
}
