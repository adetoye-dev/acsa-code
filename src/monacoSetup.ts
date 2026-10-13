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
import { declineMonacoTypeScriptProviders } from "./monacoTypeScriptProviders";

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
 * At module load, and not while an editor mounts: this module is the earliest point
 * the app touches Monaco, so it precedes every editor and every model — including the
 * diff view, which never mounts through the editor component. Why the timing matters,
 * and what exactly is being declined, is in `monacoTypeScriptProviders.ts`.
 */
declineMonacoTypeScriptProviders(monaco);

loader.config({ monaco });

export { monaco };
