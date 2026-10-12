/**
 * tsLanguageServer.ts — TypeScript from the project, not from a mirror.
 *
 * The editor used to answer "is this code correct?" with Monaco's TypeScript
 * compiled into a Web Worker, fed a hand-built mirror of the project
 * (`monacoProjectFiles.ts`). A worker has no filesystem, so every case the mirror
 * did not cover arrived as a diagnostic no other editor showed — path aliases,
 * `.d.mts`, the JSX runtime, package imports — and this repository passed
 * `tsc --noEmit` while the editor painted errors on files VS Code called clean.
 *
 * This talks to a real language server instead: `typescript-language-server` over
 * LSP, running on the project's *own* TypeScript (it resolves the workspace copy by
 * itself, and says so in its log). The shell owns the process — the page cannot
 * spawn one — so messages travel over two commands and one event, and the framing
 * is parsed there rather than here.
 *
 * What this module owns: the JSON-RPC conversation, keeping the server in step with
 * Monaco's models including unsaved edits, and turning published diagnostics into
 * markers. Nothing here interprets TypeScript.
 */

import type * as MonacoType from "monaco-editor";
import { setWorkerFeaturesEnabled } from "./monacoTsConfig";

export type LanguageServerStatus = "off" | "starting" | "running" | "unavailable" | "failed";

export interface LanguageServerState {
  status: LanguageServerStatus;
  /** What the server reported it is running on, e.g. `5.9.3 (workspace)`. */
  typescript: string;
  /** Why it is not running, in the words of whatever stopped it. */
  detail: string;
}

/** Markers from this module, and the ones the worker writes, which it replaces. */
const MARKER_OWNER = "acsa-typescript";
const WORKER_MARKER_OWNERS = ["typescript", "javascript"];

/** How long typing settles before the server is told. Its own debounce is ~250ms. */
const SYNC_DEBOUNCE_MS = 250;

let state: LanguageServerState = { status: "off", typescript: "", detail: "" };
const listeners = new Set<(state: LanguageServerState) => void>();

function setState(next: Partial<LanguageServerState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener(state);
}

export function languageServerState(): LanguageServerState {
  return state;
}

export function subscribeLanguageServer(listener: (state: LanguageServerState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Absolute path from an LSP `file://` URI, and from a Monaco model's `Uri`. */
function uriToPath(uri: string): string {
  const withoutScheme = uri.replace(/^file:\/\//, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutScheme);
  } catch {
    decoded = withoutScheme;
  }
  // Windows drive paths arrive as `/C:/…` from a `file://` URI.
  return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
}

function modelPath(model: MonacoType.editor.ITextModel): string {
  // `Uri.parse(absolutePath)` — which is what the editor uses to make models — has
  // no scheme, and `.path` is the path for both that and `file://`. Percent-encoded
  // characters have to be undone for the two sides to compare equal.
  return uriToPath(model.uri.path || model.uri.toString());
}

const samePath = (a: string, b: string) =>
  a.replace(/\\/g, "/") === b.replace(/\\/g, "/");

const under = (path: string, root: string) => {
  const normalised = path.replace(/\\/g, "/");
  const base = root.replace(/\\/g, "/").replace(/\/$/, "");
  return base !== "" && (normalised === base || normalised.startsWith(`${base}/`));
};

/** The `languageId` the server expects, from the extension it will classify by. */
export function languageIdFor(path: string): string {
  const match = /\.([cm]?[jt]sx?)$/i.exec(path);
  switch (match?.[1].toLowerCase()) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "typescriptreact";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "javascriptreact";
    default:
      return "";
  }
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface Session {
  id: number;
  monaco: typeof MonacoType;
  projectRoot: string;
  nextId: number;
  pending: Map<number, Pending>;
  /** Open documents, by absolute path: what was sent as their version. */
  open: Map<string, number>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** Per-model content subscriptions, keyed the same way as `open`. */
  watchers: Map<string, { dispose(): void }>;
  /**
   * What the server sent for a completion, by the Monaco item handed back.
   *
   * `completionItem/resolve` is not a nicety here. Measured against the real
   * server: a list item is `{label, kind, sortText, data}` and nothing else, and the
   * detail, the documentation *and the auto-import edit* only arrive when that
   * `data` is sent back. Without this, accepting an unimported symbol inserts its
   * name and no import — an identifier that is not defined.
   */
  resolutions: WeakMap<object, unknown>;
  disposables: Array<{ dispose(): void }>;
  unlisten: Array<() => void>;
  logs: string[];
}

let session: Session | null = null;

/**
 * The shell's `invoke`, resolved once.
 *
 * The import is dynamic on purpose — a browser preview must not load the Tauri SDK
 * — but it used to be re-resolved for every message, and a typing session sends
 * several a second. Resolved once, then remembered.
 */
let tauriInvoke: ((command: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!tauriInvoke) {
    const module = await import("@tauri-apps/api/core");
    tauriInvoke = module.invoke;
  }
  return (await tauriInvoke(command, args)) as T;
}

function send(current: Session, message: Record<string, unknown>): Promise<void> {
  return invoke<void>("lsp_send", { session: current.id, message: JSON.stringify(message) });
}

function request(current: Session, method: string, params: unknown): Promise<any> {
  const id = current.nextId++;
  return new Promise((resolve, reject) => {
    current.pending.set(id, { resolve, reject });
    void send(current, { jsonrpc: "2.0", id, method, params }).catch(reject);
  });
}

function notify(current: Session, method: string, params: unknown): void {
  void send(current, { jsonrpc: "2.0", method, params }).catch(() => {});
}

function toMarker(monaco: typeof MonacoType, diagnostic: any) {
  const severity =
    diagnostic.severity === 1
      ? monaco.MarkerSeverity.Error
      : diagnostic.severity === 2
        ? monaco.MarkerSeverity.Warning
        : diagnostic.severity === 3
          ? monaco.MarkerSeverity.Info
          : monaco.MarkerSeverity.Hint;
  return {
    severity,
    message: String(diagnostic.message ?? ""),
    code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
    source: diagnostic.source === "ts" ? "ts" : "typescript",
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
  };
}

function modelForPath(current: Session, path: string): MonacoType.editor.ITextModel | null {
  for (const model of current.monaco.editor.getModels()) {
    if (samePath(modelPath(model), path)) return model;
  }
  return null;
}

function openDocument(current: Session, model: MonacoType.editor.ITextModel): void {
  const path = modelPath(model);
  if (current.open.has(path)) return;
  const languageId = languageIdFor(path);
  // Anything the server has no opinion about — a diff view, an image, a scratch
  // buffer — is left alone rather than handed over as a document.
  if (!languageId || !under(path, current.projectRoot)) return;

  current.open.set(path, 1);
  notify(current, "textDocument/didOpen", {
    textDocument: { uri: model.uri.toString(), languageId, version: 1, text: model.getValue() },
  });
  // `onDidChangeContent` is on the model, and it sees every edit whoever made it —
  // including an agent's apply-patch landing in a buffer that is open but not
  // focused, which a per-editor listener would miss.
  current.watchers.set(path, model.onDidChangeContent(() => changeDocument(current, model)));
}

function changeDocument(current: Session, model: MonacoType.editor.ITextModel): void {
  const path = modelPath(model);
  if (!current.open.has(path)) {
    openDocument(current, model);
    return;
  }
  const existing = current.timers.get(path);
  if (existing) clearTimeout(existing);
  current.timers.set(
    path,
    setTimeout(() => {
      current.timers.delete(path);
      if (session !== current) return;
      const version = (current.open.get(path) ?? 1) + 1;
      current.open.set(path, version);
      // Full text, declared as `TextDocumentSyncKind.Full` in the handshake: the
      // server is sent what the buffer says, unsaved or not.
      notify(current, "textDocument/didChange", {
        textDocument: { uri: model.uri.toString(), version },
        contentChanges: [{ text: model.getValue() }],
      });
    }, SYNC_DEBOUNCE_MS),
  );
}

function closeDocument(current: Session, model: MonacoType.editor.ITextModel): void {
  const path = modelPath(model);
  if (!current.open.has(path)) return;
  current.open.delete(path);
  current.watchers.get(path)?.dispose();
  current.watchers.delete(path);
  const timer = current.timers.get(path);
  if (timer) {
    clearTimeout(timer);
    current.timers.delete(path);
  }
  notify(current, "textDocument/didClose", { textDocument: { uri: model.uri.toString() } });
}

function applyDiagnostics(current: Session, params: any): void {
  const model = modelForPath(current, uriToPath(String(params.uri)));
  if (!model || model.isDisposed()) return;
  const markers = (params.diagnostics ?? []).map((d: any) => toMarker(current.monaco, d));
  current.monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
}

/** The worker wrote these; the server is authoritative now. */
function clearWorkerMarkers(monaco: typeof MonacoType): void {
  for (const model of monaco.editor.getModels()) {
    for (const owner of WORKER_MARKER_OWNERS) monaco.editor.setModelMarkers(model, owner, []);
  }
}

function clearServerMarkers(current: Session): void {
  for (const model of current.monaco.editor.getModels()) {
    current.monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  }
}

function handleMessage(current: Session, message: any): void {
  if (message.id !== undefined && current.pending.has(message.id)) {
    const pending = current.pending.get(message.id)!;
    current.pending.delete(message.id);
    if (message.error) pending.reject(new Error(String(message.error.message ?? "language server error")));
    else pending.resolve(message.result);
    return;
  }

  if (message.method === "textDocument/publishDiagnostics") {
    applyDiagnostics(current, message.params ?? {});
    return;
  }

  // A request *from* the server. Answering is not optional: it waits for these, and
  // a client that stays silent stalls the server on its own start-up.
  if (message.id !== undefined && message.method) {
    const result =
      message.method === "workspace/configuration"
        ? (message.params?.items ?? []).map(() => null)
        : null;
    void send(current, { jsonrpc: "2.0", id: message.id, result }).catch(() => {});
  }
}

/**
 * LSP's `CompletionItemKind` and Monaco's are different lists with the same names —
 * LSP starts at `Text = 1` and Monaco at `Method = 0` — so every kind has to be
 * mapped by hand. Indexing one with the other's number is the kind of bug that shows
 * up as "the icons are subtly wrong", which nobody reports.
 *
 * `Issue` and `Tool` have no LSP equivalent and are absent here on purpose.
 */
const COMPLETION_KINDS: Record<number, number> = {
  1: 18, // Text
  2: 0, // Method
  3: 1, // Function
  4: 2, // Constructor
  5: 3, // Field
  6: 4, // Variable
  7: 5, // Class
  8: 7, // Interface
  9: 8, // Module
  10: 9, // Property
  11: 12, // Unit
  12: 13, // Value
  13: 15, // Enum
  14: 17, // Keyword
  15: 28, // Snippet
  16: 19, // Color
  17: 20, // File
  18: 21, // Reference
  19: 23, // Folder
  20: 16, // EnumMember
  21: 14, // Constant
  22: 6, // Struct
  23: 10, // Event
  24: 11, // Operator
  25: 24, // TypeParameter
};

/** One LSP range as Monaco's, both 1-based on the Monaco side. */
export function toMonacoRange(range: any): any {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/** A completion's documentation, in either of the two shapes the protocol allows. */
function documentationText(documentation: any): string {
  if (!documentation) return "";
  if (typeof documentation === "string") return documentation;
  return String(documentation.value ?? "");
}

/**
 * The edit a completion applies.
 *
 * `textEdit` is the protocol's real answer and it is a *range*, not a word: an
 * auto-import rewrites the import line as well as inserting the name, and Monaco has
 * to be told the range or the name lands in the wrong place. `itemDefaults.editRange`
 * is the shared range the server may hoist out of every item, so it is the fallback
 * before the cursor's own word.
 */
function completionEdit(monaco: typeof MonacoType, item: any, defaults: any, position: any) {
  const edit = item.textEdit;
  if (edit?.newText !== undefined) {
    // `InsertReplaceEdit` carries both ranges; the replace one is the superset.
    const range = edit.range ?? edit.replace ?? edit.insert;
    if (range) return { text: String(edit.newText), range: toMonacoRange(range) };
    return { text: String(edit.newText), range: wordRange(monaco, position) };
  }
  if (defaults?.editRange) {
    const range = defaults.editRange.replace ?? defaults.editRange;
    return { text: String(item.insertText ?? labelOf(item.label)), range: toMonacoRange(range) };
  }
  return { text: String(item.insertText ?? labelOf(item.label)), range: wordRange(monaco, position) };
}

/** The word under the cursor, as the last resort for a completion's range. */
function wordRange(_monaco: typeof MonacoType, position: any): any {
  const model = position.model as MonacoType.editor.ITextModel | undefined;
  if (!model) return position.range;
  const word = model.getWordUntilPosition(position.position);
  return {
    startLineNumber: position.position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.position.lineNumber,
    endColumn: word.endColumn,
  };
}

const labelOf = (label: any): string => (typeof label === "string" ? label : String(label?.label ?? ""));

/** One completion list, as Monaco's. Exported because the mapping is the testable part. */
export function toMonacoCompletions(monaco: typeof MonacoType, result: any, position: any): any[] {
  const items: any[] = Array.isArray(result) ? result : (result?.items ?? []);
  const defaults = Array.isArray(result) ? {} : (result?.itemDefaults ?? {});
  const snippet = (item: any) =>
    (item.insertTextFormat ?? defaults.insertTextFormat) === 2;

  return items.map((item) => {
    const edit = completionEdit(monaco, item, defaults, position);
    const documentation = documentationText(item.documentation ?? item.detail);
    return {
      label: labelOf(item.label),
      kind: COMPLETION_KINDS[item.kind ?? 1] ?? monaco.languages.CompletionItemKind.Text,
      insertText: edit.text,
      range: edit.range,
      ...(snippet(item) ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
      ...(item.detail ? { detail: String(item.detail) } : {}),
      ...(documentation ? { documentation: { value: documentation } } : {}),
      ...(item.sortText ? { sortText: String(item.sortText) } : {}),
      ...(item.filterText ? { filterText: String(item.filterText) } : {}),
      ...(item.preselect ? { preselect: true } : {}),
      // Auto-imports arrive this way: the completion inserts a name *and* an import
      // at the top of the file. Dropping it inserts an undefined identifier.
      ...(item.additionalTextEdits?.length
        ? {
            additionalTextEdits: item.additionalTextEdits.map((editItem: any) => ({
              range: toMonacoRange(editItem.range),
              text: String(editItem.newText ?? ""),
            })),
          }
        : {}),
    };
  });
}

/** Hover text, in whatever shape the protocol used, as markdown. */
export function toHoverMarkdown(contents: any): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(toHoverMarkdown).filter(Boolean).join("\n\n");
  if (typeof contents.value === "string") {
    // A `MarkedString` is a fenced block with a language; `MarkupContent` is markdown
    // already, and its `kind` says which.
    return contents.language
      ? `\`\`\`${contents.language}\n${contents.value}\n\`\`\``
      : contents.value;
  }
  return "";
}

/**
 * Hand Monaco's IntelliSense to the server.
 *
 * Registered only while a session is up: with no server the worker still answers,
 * which is the whole point of the handover being reversible. Monaco merges the
 * providers it is given, so the worker's are switched off in the same breath
 * (`setWorkerFeaturesEnabled`) — two providers answering one keystroke is how a
 * completion list ends up with every symbol twice.
 */
function registerProviders(current: Session, capabilities: any): void {
  const monaco = current.monaco;
  const languages = [
    "typescript",
    "typescriptreact",
    "javascript",
    "javascriptreact",
  ];

  const documentUri = (model: any) => model.uri.toString();

  current.disposables.push(
    monaco.languages.registerCompletionItemProvider(languages, {
      triggerCharacters: capabilities?.completionProvider?.triggerCharacters ?? ["."],
      provideCompletionItems: async (model, position) => {
        const result = await request(current, "textDocument/completion", {
          textDocument: { uri: documentUri(model) },
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        });
        const suggestions = toMonacoCompletions(monaco, result, {
          model,
          position,
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
        });

        // Keep the server's own item, so `resolve` can be asked about this one
        // later. Only items that carry `data` can be resolved — that is what the
        // protocol gives the field for — and they are the ones with more to say.
        const items = Array.isArray(result) ? result : (result?.items ?? []);
        suggestions.forEach((suggestion, index) => {
          const original = items[index];
          if (original?.data !== undefined) current.resolutions.set(suggestion, original);
        });

        return { suggestions };
      },
      resolveCompletionItem: async (item) => {
        const original = current.resolutions.get(item) as Record<string, unknown> | undefined;
        if (!original) return item;

        const resolved = await request(current, "completionItem/resolve", original);
        if (!resolved) return item;

        const documentation = documentationText(resolved.documentation ?? resolved.detail);
        return {
          ...item,
          // The insert text and range are already right — resolved from the item's
          // own label and the word being replaced — so this only carries what the
          // list could not say: the signature, the docs, and the import.
          ...(resolved.detail ? { detail: String(resolved.detail) } : {}),
          ...(documentation ? { documentation: { value: documentation } } : {}),
          ...(resolved.additionalTextEdits?.length
            ? {
                additionalTextEdits: resolved.additionalTextEdits.map((edit: any) => ({
                  range: toMonacoRange(edit.range),
                  text: String(edit.newText ?? ""),
                })),
              }
            : {}),
          ...(resolved.sortText ? { sortText: String(resolved.sortText) } : {}),
        };
      },
    }),
    monaco.languages.registerHoverProvider(languages, {
      provideHover: async (model, position) => {
        const result = await request(current, "textDocument/hover", {
          textDocument: { uri: documentUri(model) },
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        });
        const value = toHoverMarkdown(result?.contents);
        if (!value) return null;
        return { contents: [{ value }], ...(result?.range ? { range: toMonacoRange(result.range) } : {}) };
      },
    }),
  );
}

/** Start a session for a project, or leave the running one alone. */
export async function startLanguageServer(
  monaco: typeof MonacoType,
  projectRoot: string,
): Promise<void> {
  if (!projectRoot) return;
  if (session && session.projectRoot === projectRoot && state.status === "running") return;
  await stopLanguageServer();

  setState({ status: "starting", typescript: "", detail: "" });

  let id: number;
  try {
    id = await invoke<number>("lsp_start", { projectRoot });
  } catch (error) {
    const detail = String((error as Error)?.message ?? error);
    // Not an error worth alarming anyone about: the toolchain is fetched per
    // machine, and the editor still has the worker until it is.
    setState({
      status: /not installed/i.test(detail) ? "unavailable" : "failed",
      detail,
    });
    return;
  }

  const current: Session = {
    id,
    monaco,
    projectRoot,
    nextId: 1,
    pending: new Map(),
    open: new Map(),
    timers: new Map(),
    watchers: new Map(),
    resolutions: new WeakMap(),
    disposables: [],
    unlisten: [],
    logs: [],
  };
  session = current;

  const { listen } = await import("@tauri-apps/api/event");
  current.unlisten.push(
    await listen<{ session: number; message: any }>("lsp:message", (event) => {
      if (event.payload?.session !== current.id) return;
      handleMessage(current, event.payload.message);
    }),
  );
  current.unlisten.push(
    await listen<{ session: number; line: string }>("lsp:log", (event) => {
      if (event.payload?.session !== current.id) return;
      current.logs.push(event.payload.line);
      // The server names the TypeScript it decided to run on, which is the whole
      // reason this arrangement was chosen over the faster native one.
      const match = /Using Typescript version \(([^)]+)\) (\S+)/.exec(event.payload.line);
      if (match) setState({ typescript: `${match[2]} (${match[1]})` });
    }),
  );

  let serverCapabilities: any = {};
  try {
    const initialized = await request(current, "initialize", {
      processId: null,
      rootUri: new URL(`file://${projectRoot}`).toString(),
      workspaceFolders: [{ uri: new URL(`file://${projectRoot}`).toString(), name: "workspace" }],
      capabilities: {
        textDocument: {
          // Full, so an unsaved buffer is sent as it stands rather than as a diff
          // the server has to reconstruct.
          synchronization: { didSave: false, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true, versionSupport: false },
        },
        workspace: { configuration: false, workspaceFolders: false },
        window: { workDoneProgress: false },
      },
      initializationOptions: {},
    });
    if (initialized?.capabilities === undefined && initialized?.error) {
      throw new Error(String(initialized.message ?? "initialize failed"));
    }
    serverCapabilities = initialized?.capabilities ?? {};
  } catch (error) {
    await stopLanguageServer();
    setState({ status: "failed", detail: String((error as Error)?.message ?? error) });
    return;
  }

  notify(current, "initialized", {});
  registerProviders(current, serverCapabilities);

  for (const model of monaco.editor.getModels()) openDocument(current, model);
  current.disposables.push(
    monaco.editor.onDidCreateModel((model) => openDocument(current, model)),
    // A model going away is a tab closing; the server should drop it too. The
    // content subscription is disposed in `closeDocument`.
    monaco.editor.onWillDisposeModel((model) => closeDocument(current, model)),
  );

  setState({ status: "running" });

  // Hand the diagnostics over. Only now, with the server answering: turning the
  // worker off before this would leave the editor with no type checking at all.
  setWorkerFeaturesEnabled(monaco, false);
  clearWorkerMarkers(monaco);
}

export async function stopLanguageServer(): Promise<void> {
  const current = session;
  if (!current) return;
  session = null;

  for (const timer of current.timers.values()) clearTimeout(timer);
  for (const watcher of current.watchers.values()) watcher.dispose();
  for (const disposable of current.disposables) disposable.dispose();
  for (const unlisten of current.unlisten) unlisten();
  clearServerMarkers(current);
  // The worker gets its diagnostics back, so a stopped server is never a silently
  // unchecked editor.
  setWorkerFeaturesEnabled(current.monaco, true);
  setState({ status: "off", typescript: "", detail: "" });

  try {
    await invoke<void>("lsp_stop", { session: current.id });
  } catch {
    // The process may already be gone; nothing to do about it here.
  }
}
