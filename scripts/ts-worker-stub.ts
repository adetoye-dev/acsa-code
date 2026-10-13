/**
 * A stand-in for Monaco's TypeScript worker, so the real 6.7 MB file is not built.
 *
 * Nothing constructs this worker any more: the app declines Monaco's own TypeScript
 * language features at load (`monacoSetup`) and gets its types, completions and hover
 * from a language server instead. But Monaco's `workerManager.js` still *references*
 * the worker:
 *
 *   new Worker(new URL('ts.worker.js', import.meta.url), { type: "module" })
 *
 * and Vite bundles every `new URL(…, import.meta.url)` it can see, whether or not the
 * branch that creates it ever runs. So the file was emitted into every build — a
 * 6.7 MB chunk of a compiler that was configured never to answer. `vite.config.ts`
 * resolves that reference here.
 *
 * Reached only if something starts a worker anyway, in which case saying so is more
 * use than a compiler quietly answering beside the language server.
 */
const scope = self as unknown as { postMessage: (message: unknown) => void };

scope.postMessage({
  error:
    "This build has no TypeScript worker: the editor's TypeScript comes from a " +
    "language server. See src/monacoSetup.ts.",
});
