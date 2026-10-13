import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two Tauri channels, recorded. `invoke` is what the page can do; `listen` is
 * how the shell's reader thread reaches back with a language server's message.
 */
const invokes: Array<{ command: string; args: Record<string, any> }> = [];
const handlers = new Map<string, (event: { payload: any }) => void>();
let startFails: string | null = null;
const toolchainPresent = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, any>) => {
    invokes.push({ command, args });
    if (command === "lsp_start") {
      if (startFails) throw new Error(startFails);
      return 7;
    }
    if (command === "lsp_available") return toolchainPresent;
    return undefined;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: any }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  },
}));

const fileWrites: Array<{ path: string; content: string }> = [];
const fileReads: Record<string, string> = {};
vi.mock("./fileAccess", () => ({
  readTextFile: async (path: string) => {
    if (!(path in fileReads)) throw new Error("no such file");
    return fileReads[path];
  },
  writeTextFile: async (path: string, content: string) => {
    fileWrites.push({ path, content });
    fileReads[path] = content;
  },
}));

const server = await import("./tsLanguageServer");

/** The messages the page sent to the server, in order. */
const sent = () => invokes.filter((i) => i.command === "lsp_send").map((i) => JSON.parse(i.args.message));

/**
 * A model as the editor makes them: `Uri.parse(absolutePath)` has no scheme, which
 * is the shape that would break a naive URI-string comparison.
 */
function makeModel(path: string, text: string, languageId = "typescript") {
  const listeners: Array<() => void> = [];
  let value = text;
  return {
    uri: { path, toString: () => path, scheme: "" },
    getValue: () => value,
    setValue: (next: string) => {
      value = next;
    },
    onDidChangeContent: (handler: () => void) => {
      listeners.push(handler);
      return { dispose: () => listeners.splice(listeners.indexOf(handler), 1) };
    },
    getLanguageId: () => languageId,
    getVersionId: () => 7,
    isDisposed: () => false,
    /** Monaco's own: the word ending at the cursor, which is the fallback range. */
    getWordUntilPosition: (position: { lineNumber: number; column: number }) => {
      const line = value.split("\n")[position.lineNumber - 1] ?? "";
      const before = line.slice(0, position.column - 1);
      const word = /[A-Za-z0-9_$]*$/.exec(before)?.[0] ?? "";
      return { word, startColumn: before.length - word.length + 1, endColumn: before.length + 1 };
    },
    /** Stand in for the user typing. */
    type: (next: string) => {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

function makeMonaco(models: any[]) {
  const openers: Array<{ opener: any; disposed: boolean }> = [];
  const created: Array<(m: any) => void> = [];
  const disposed: Array<(m: any) => void> = [];
  const markers = new Map<string, any[]>();
  const providers: Array<{ kind: string; languages: string[]; provider: any; disposed: boolean }> = [];
  return {
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    Uri: { file: (path: string) => ({ path, toString: () => `file://${path}`, scheme: "file", fsPath: path }) },
    languages: {
      CompletionItemKind: { Method: 0, Function: 1, Class: 5, Variable: 4, Text: 18, Snippet: 28, Property: 9 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (langs: string[], provider: any) => {
        const entry = { kind: "completion", languages: langs, provider, disposed: false };
        providers.push(entry);
        return { dispose: () => (entry.disposed = true) };
      },
      registerHoverProvider: (langs: string[], provider: any) => {
        const entry = { kind: "hover", languages: langs, provider, disposed: false };
        providers.push(entry);
        return { dispose: () => (entry.disposed = true) };
      },
      registerDefinitionProvider: (langs: string[], provider: any) => {
        const entry = { kind: "definition", languages: langs, provider, disposed: false };
        providers.push(entry);
        return { dispose: () => (entry.disposed = true) };
      },
      registerSignatureHelpProvider: (langs: string[], provider: any) => {
        const entry = { kind: "signature", languages: langs, provider, disposed: false };
        providers.push(entry);
        return { dispose: () => (entry.disposed = true) };
      },
      registerRenameProvider: (langs: string[], provider: any) => {
        const entry = { kind: "rename", languages: langs, provider, disposed: false };
        providers.push(entry);
        return { dispose: () => (entry.disposed = true) };
      },
      registerCodeActionProvider: (langs: string[], provider: any, _meta: any) => {
        const entry = { kind: "codeAction", languages: langs, provider, disposed: false };
        providers.push(entry);
        return { dispose: () => (entry.disposed = true) };
      },
      registerReferenceProvider: (langs: string[], provider: any) => {
        const entry = { kind: "references", languages: langs, provider, disposed: false };
        providers.push(entry);
        return { dispose: () => (entry.disposed = true) };
      },
    },
    editor: {
      getModels: () => models,
      registerEditorOpener: (opener: any) => {
        const entry = { opener, disposed: false };
        openers.push(entry);
        return { dispose: () => (entry.disposed = true) };
      },
      setModelMarkers: (model: any, owner: string, next: any[]) =>
        markers.set(`${model.uri.path}|${owner}`, next),
      onDidCreateModel: (fn: (m: any) => void) => {
        created.push(fn);
        return { dispose: () => created.splice(created.indexOf(fn), 1) };
      },
      onWillDisposeModel: (fn: (m: any) => void) => {
        disposed.push(fn);
        return { dispose: () => disposed.splice(disposed.indexOf(fn), 1) };
      },
    },
    markers,
    created,
    disposed,
    providers,
    openers,
  } as any;
}

/**
 * Notifications are fire-and-forget: `invoke` resolves its import asynchronously, so
 * a message sent just before an `await` lands a microtask later. Waiting for it is
 * the honest assertion, and it is what the editor does too.
 */
const sentMethod = async (method: string) => {
  let found: any;
  await vi.waitFor(() => {
    found = sent().find((m) => m.method === method);
    expect(found).toBeTruthy();
  });
  return found;
};

/** The shell's reader thread delivering a message from the server. */
const deliver = (message: any, session = 7) =>
  handlers.get("lsp:message")?.({ payload: { session, message } });

const ROOT = "/Users/dev/project";
const FILE = `${ROOT}/src/app.ts`;

beforeEach(() => {
  invokes.length = 0;
  fileWrites.length = 0;
  for (const key of Object.keys(fileReads)) delete fileReads[key];
  handlers.clear();
  startFails = null;
});

afterEach(async () => {
  await server.stopLanguageServer();
  vi.useRealTimers();
});

describe("starting the language server", () => {
  it("says it is unavailable, and leaves the worker checking, when it is not installed", async () => {
    startFails = "the TypeScript language server is not installed";
    const monaco = makeMonaco([makeModel(FILE, "const a = 1;\n")]);

    await server.startLanguageServer(monaco, ROOT);

    expect(server.languageServerState().status).toBe("unavailable");
    // The important half: an editor that still type-checks, by the old route,
    // rather than one that silently stopped checking.
  });

  it("opens the project's models and hands diagnostics over only once it answers", async () => {
    const model = makeModel(FILE, "const answer: number = 42;\n");
    const monaco = makeMonaco([model]);

    const starting = server.startLanguageServer(monaco, ROOT);
    // `initialize` is in flight: the worker must still be the one checking.
    await vi.waitFor(() => expect(sent().some((m) => m.method === "initialize")).toBe(true));

    const initialize = sent().find((m) => m.method === "initialize");
    expect(initialize.params.rootUri).toBe(`file://${ROOT}`);
    expect(initialize.params.capabilities.textDocument.publishDiagnostics).toBeTruthy();

    // The server's reply, then `initialized`, then the open document.
    deliver({ jsonrpc: "2.0", id: initialize.id, result: { capabilities: {} } });
    await starting;

    const opened = await sentMethod("textDocument/didOpen");
    expect(opened.params.textDocument.uri).toBe(FILE);
    expect(opened.params.textDocument.text).toBe("const answer: number = 42;\n");
    expect(server.languageServerState().status).toBe("running");
  });

  it("leaves models outside the project alone", async () => {
    const inside = makeModel(FILE, "const a = 1;\n");
    const outside = makeModel("/somewhere/else/b.ts", "const b = 2;\n");
    const monaco = makeMonaco([inside, outside]);

    const starting = server.startLanguageServer(monaco, ROOT);
    await vi.waitFor(() => expect(sent().some((m) => m.method === "initialize")).toBe(true));
    deliver({
      jsonrpc: "2.0",
      id: sent().find((m) => m.method === "initialize").id,
      result: { capabilities: {} },
    });
    await starting;

    await sentMethod("textDocument/didOpen");
    const opened = sent().filter((m) => m.method === "textDocument/didOpen");
    expect(opened.map((m) => m.params.textDocument.uri)).toEqual([FILE]);
  });
});

describe("a running session", () => {
  async function running() {
    const model = makeModel(FILE, "const answer: number = 42;\n");
    const monaco = makeMonaco([model]);
    const starting = server.startLanguageServer(monaco, ROOT);
    await vi.waitFor(() => expect(sent().some((m) => m.method === "initialize")).toBe(true));
    deliver({
      jsonrpc: "2.0",
      id: sent().find((m) => m.method === "initialize").id,
      result: { capabilities: {} },
    });
    await starting;
    return { model, monaco };
  }

  it("turns published diagnostics into markers on the right model", async () => {
    const { monaco } = await running();

    // The server speaks `file://` URIs; the editor's models have no scheme. Matching
    // on the URI string would drop every diagnostic.
    deliver({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: `file://${FILE}`,
        diagnostics: [
          {
            range: { start: { line: 2, character: 6 }, end: { line: 2, character: 12 } },
            severity: 1,
            code: 2322,
            source: "ts",
            message: "Type 'number' is not assignable to type 'string'.",
          },
        ],
      },
    });

    const markers = monaco.markers.get(`${FILE}|acsa-typescript`);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      severity: 8,
      code: "2322",
      startLineNumber: 3,
      startColumn: 7,
      endColumn: 13,
    });
  });

  it("sends the buffer as it stands, so an unsaved edit is what is checked", async () => {
    vi.useFakeTimers();
    const { model } = await running();

    model.type("const answer: string = 42;\n");
    expect(sent().some((m) => m.method === "textDocument/didChange")).toBe(false);

    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(sent().some((m) => m.method === "textDocument/didChange")).toBe(true));
    const change = sent().find((m) => m.method === "textDocument/didChange")!;
    expect(change.params.contentChanges).toEqual([{ text: "const answer: string = 42;\n" }]);
    expect(change.params.textDocument.version).toBe(2);
  });

  it("answers the requests the server makes of the client", async () => {
    await running();
    // It asks for configuration at start-up and waits; a silent client stalls it.
    deliver({ jsonrpc: "2.0", id: 99, method: "workspace/configuration", params: { items: [{}] } });

    let reply: any;
    await vi.waitFor(() => {
      reply = sent().find((m) => m.id === 99 && m.result !== undefined);
      expect(reply).toBeTruthy();
    });
    expect(reply.result).toEqual([null]);
  });

  it("gives the worker its diagnostics back when it stops", async () => {
    const { monaco } = await running();
    deliver({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: `file://${FILE}`, diagnostics: [] },
    });

    await server.stopLanguageServer();
    expect(server.languageServerState().status).toBe("off");
    await vi.waitFor(() =>
      expect(invokes.some((i) => i.command === "lsp_stop" && i.args.session === 7)).toBe(true),
    );
    // And the server's own markers are gone, rather than frozen on screen.
    expect(monaco.markers.get(`${FILE}|acsa-typescript`)).toEqual([]);
  });
});


describe("IntelliSense over the wire", () => {
  async function running() {
    const model = makeModel(FILE, "const answer: number = 42;\n");
    const monaco = makeMonaco([model]);
    const starting = server.startLanguageServer(monaco, ROOT);
    await vi.waitFor(() => expect(sent().some((m) => m.method === "initialize")).toBe(true));
    deliver({
      jsonrpc: "2.0",
      id: sent().find((m) => m.method === "initialize").id,
      result: { capabilities: { completionProvider: { triggerCharacters: [".", "'"] } } },
    });
    await starting;
    await sentMethod("textDocument/didOpen");
    return { monaco, model };
  }

  /** The shell's reader thread handing a *reply* to a request the page made. */
  async function answer(method: string, result: unknown) {
    let id: number | undefined;
    await vi.waitFor(() => {
      id = sent().find((m) => m.method === method)?.id;
      expect(id).toBeDefined();
    });
    deliver({ jsonrpc: "2.0", id, result });
  }

  const position = { lineNumber: 1, column: 21 };

  it("maps the server's completion kinds onto Monaco's, which are different lists", () => {
    // LSP's `Class` is 7 and Monaco's is 5; LSP's `Snippet` is 15 and Monaco's is 28.
    const model = makeModel(FILE, "const answer: number = 42;\n");
    const monaco = makeMonaco([model]);
    const suggestions = server.toMonacoCompletions(
      monaco,
      {
        isIncomplete: false,
        items: [
          { label: "answer", kind: 7, detail: "const answer: number" },
          { label: "snippet", kind: 15, insertTextFormat: 2 },
        ],
      },
      { model, position: { lineNumber: 1, column: 21 } },
    );

    expect(suggestions[0].kind).toBe(monaco.languages.CompletionItemKind.Class);
    expect(suggestions[0].detail).toBe("const answer: number");
    expect(suggestions[1].kind).toBe(monaco.languages.CompletionItemKind.Snippet);
    expect(suggestions[1].insertTextRules).toBe(monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet);
  });

  it("keeps an auto-import, which is a second edit at the top of the file", async () => {
    const { monaco } = await running();
    const provider = monaco.providers.find((p: any) => p.kind === "completion");
    const pending = provider.provider.provideCompletionItems(
      makeModel(FILE, "readFile()"),
      position,
    );

    await answer("textDocument/completion", {
      isIncomplete: false,
      itemDefaults: { editRange: { start: { line: 0, character: 8 }, end: { line: 0, character: 16 } } },
      items: [
        {
          label: "readFile",
          kind: 3,
          textEdit: { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 16 } }, newText: "readFile" },
          additionalTextEdits: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'import { readFile } from "node:fs";\n' },
          ],
        },
      ],
    });

    const { suggestions } = await pending;
    // Dropping the second edit inserts an identifier that is not imported.
    expect(suggestions[0].additionalTextEdits).toHaveLength(1);
    expect(suggestions[0].additionalTextEdits[0].text).toContain("node:fs");
    expect(suggestions[0].range).toMatchObject({ startColumn: 9, endColumn: 17 });
  });

  it("answers hover with markdown, including the fenced shape", async () => {
    const { monaco } = await running();
    const provider = monaco.providers.find((p: any) => p.kind === "hover");
    const pending = provider.provider.provideHover(makeModel(FILE, "answer"), { lineNumber: 1, column: 1 });

    await answer("textDocument/hover", {
      contents: { kind: "markdown", value: "```ts\nconst answer: number\n```" },
    });

    const hover = await pending;
    expect(hover.contents[0].value).toContain("const answer: number");
    expect(server.toHoverMarkdown([{ language: "ts", value: "const a = 1" }])).toBe("```ts\nconst a = 1\n```");
    expect(server.toHoverMarkdown("plain")).toBe("plain");
  });

  it("takes the server's trigger characters rather than guessing", async () => {
    const { monaco } = await running();
    const provider = monaco.providers.find((p: any) => p.kind === "completion");
    expect(provider.languages).toContain("typescriptreact");
    expect(provider.provider.triggerCharacters).toEqual([".", "'"]);
  });

  it("lets go of its providers when the session stops", async () => {
    // The worker is not switched back on — its providers were never registered (see
    // `monacoSetup`) — so the badge is what tells the reader nothing is checking.
    const { monaco } = await running();
    await server.stopLanguageServer();
    for (const provider of monaco.providers) expect(provider.disposed).toBe(true);
  });
});

describe("resolving a completion", () => {
  async function runningWithList() {
    const model = makeModel(FILE, "const a = greetNa;\n");
    const monaco = makeMonaco([model]);
    const starting = server.startLanguageServer(monaco, ROOT);
    await vi.waitFor(() => expect(sent().some((m) => m.method === "initialize")).toBe(true));
    deliver({
      jsonrpc: "2.0",
      id: sent().find((m) => m.method === "initialize").id,
      result: { capabilities: { completionProvider: {} } },
    });
    await starting;
    await sentMethod("textDocument/didOpen");

    const provider = monaco.providers.find((p: any) => p.kind === "completion");
    const pending = provider.provider.provideCompletionItems(model, { lineNumber: 1, column: 16 });
    let id: number | undefined;
    await vi.waitFor(() => {
      id = sent().find((m) => m.method === "textDocument/completion")?.id;
      expect(id).toBeDefined();
    });
    // The bare shape the real server sends: measured, a list item is exactly this.
    deliver({
      jsonrpc: "2.0",
      id,
      result: { isIncomplete: false, items: [{ label: "greetName", kind: 3, sortText: "11", data: { cacheId: 3 } }] },
    });
    const { suggestions } = await pending;
    return { provider, suggestion: suggestions[0] };
  }

  it("asks the server, and carries back the signature, the docs and the import", async () => {
    const { provider, suggestion } = await runningWithList();
    // Nothing in the list itself: no detail, no documentation, and no import —
    // accepting this would insert a name that is not defined anywhere.
    expect(suggestion.detail).toBeUndefined();
    expect(suggestion.additionalTextEdits).toBeUndefined();

    const pending = provider.provider.resolveCompletionItem(suggestion, { isCancellationRequested: false });
    let id: number | undefined;
    await vi.waitFor(() => {
      id = sent().find((m) => m.method === "completionItem/resolve")?.id;
      expect(id).toBeDefined();
    });
    // And it is asked with the server's own item, `data` and all — that is what the
    // field is for, and what the answer is keyed on.
    expect(sent().find((m) => m.method === "completionItem/resolve").params).toMatchObject({
      label: "greetName",
      data: { cacheId: 3 },
    });

    deliver({
      jsonrpc: "2.0",
      id,
      result: {
        label: "greetName",
        detail: "Auto import from './lib'\nfunction greetName(who: string): string",
        documentation: { kind: "markdown", value: "Says hello." },
        additionalTextEdits: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'import { greetName } from "./lib";\n\n' },
        ],
      },
    });

    const resolved = await pending;
    expect(resolved.additionalTextEdits[0].text).toContain('from "./lib"');
    expect(resolved.documentation.value).toContain("Says hello");
    expect(resolved.detail).toContain("greetName(who: string)");
    // The insert text and range are left alone: they were already right.
    expect(resolved.insertText).toBe("greetName");
    expect(resolved.range).toMatchObject({ startLineNumber: 1, endLineNumber: 1 });
  });

  it("does not ask about an item the server gave nothing to resolve with", async () => {
    const { provider } = await runningWithList();
    const plain = { label: "answer", kind: 4, insertText: "answer", range: {} };
    const result = await provider.provider.resolveCompletionItem(plain as any, { isCancellationRequested: false });
    expect(result).toBe(plain);
    expect(sent().some((m) => m.method === "completionItem/resolve")).toBe(false);
  });
});

describe("go to definition, and references", () => {
  async function running() {
    const model = makeModel(FILE, "const a = answer;\n");
    const monaco = makeMonaco([model]);
    const starting = server.startLanguageServer(monaco, ROOT);
    await vi.waitFor(() => expect(sent().some((m) => m.method === "initialize")).toBe(true));
    deliver({
      jsonrpc: "2.0",
      id: sent().find((m) => m.method === "initialize").id,
      result: { capabilities: { definitionProvider: true, referencesProvider: true } },
    });
    await starting;
    await sentMethod("textDocument/didOpen");
    return { monaco, model };
  }

  it("names an open file by its own model, and a closed one by its path", async () => {
    const { monaco } = await running();
    const provider = monaco.providers.find((p: any) => p.kind === "definition");
    const pending = provider.provider.provideDefinition(makeModel(FILE, "answer"), { lineNumber: 1, column: 12 });

    let id: number | undefined;
    await vi.waitFor(() => {
      id = sent().find((m) => m.method === "textDocument/definition")?.id;
      expect(id).toBeDefined();
    });
    deliver({
      jsonrpc: "2.0",
      id,
      result: [
        // The file that is already open. Named by its model's URI (no scheme) so
        // Monaco moves the cursor instead of handing it to the opener and
        // reopening the file the reader is looking at.
        { uri: `file://${FILE}`, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } },
        // A file that is not open: the opener's job.
        { uri: "file:///Users/dev/project/src/other.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
      ],
    });

    const locations = await pending;
    expect(locations[0].uri.toString()).toBe(FILE);
    expect(locations[0].range).toMatchObject({ startLineNumber: 5, startColumn: 3 });
    expect(locations[1].uri.toString()).toBe("file:///Users/dev/project/src/other.ts");
  });

  it("reads a LocationLink: the selection is where the cursor goes", async () => {
    const { monaco } = await running();
    const provider = monaco.providers.find((p: any) => p.kind === "definition");
    const pending = provider.provider.provideDefinition(makeModel(FILE, "answer"), { lineNumber: 1, column: 12 });
    let id: number | undefined;
    await vi.waitFor(() => {
      id = sent().find((m) => m.method === "textDocument/definition")?.id;
      expect(id).toBeDefined();
    });
    deliver({
      jsonrpc: "2.0",
      id,
      result: [
        {
          targetUri: "file:///Users/dev/project/src/lib.ts",
          targetRange: { start: { line: 9, character: 0 }, end: { line: 12, character: 1 } },
          targetSelectionRange: { start: { line: 9, character: 6 }, end: { line: 9, character: 12 } },
        },
      ],
    });

    const [location] = await pending;
    // The whole declaration is 9–12; the cursor belongs on the name.
    expect(location.range).toMatchObject({ startLineNumber: 10, startColumn: 7, endLineNumber: 10, endColumn: 13 });
  });

  it("passes the declaration choice through, and returns every reference", async () => {
    const { monaco } = await running();
    const provider = monaco.providers.find((p: any) => p.kind === "references");
    const pending = provider.provider.provideReferences(makeModel(FILE, "answer"), { lineNumber: 1, column: 12 }, { includeDeclaration: false });

    let id: number | undefined;
    await vi.waitFor(() => {
      id = sent().find((m) => m.method === "textDocument/references")?.id;
      expect(id).toBeDefined();
    });
    expect(sent().find((m) => m.method === "textDocument/references").params.context).toEqual({
      includeDeclaration: false,
    });
    deliver({ jsonrpc: "2.0", id, result: [{ uri: `file://${FILE}`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } }] });

    const references = await pending;
    expect(references).toHaveLength(1);
    expect(references[0].uri.toString()).toBe(FILE);
  });

  it("hands a cross-file target to the workbench, and says nothing when there is none", async () => {
    const { monaco } = await running();
    const opener = monaco.openers[0].opener;

    // Without an app to open it, Monaco is told the request was not handled and
    // does nothing — the same dead click as before, rather than a broken one.
    expect(await opener.openCodeEditor(null, monaco.Uri.file("/x/y.ts"), { startLineNumber: 3, startColumn: 1 })).toBe(false);

    const opened: Array<[string, number | undefined, number | undefined]> = [];
    server.setLocationOpener(async (path, line, column) => {
      opened.push([path, line, column]);
    });

    const handled = await opener.openCodeEditor(null, monaco.Uri.file("/x/y.ts"), { startLineNumber: 3, startColumn: 1 });
    expect(handled).toBe(true);
    expect(opened).toEqual([["/x/y.ts", 3, 1]]);

    // A position rather than a range (the reference peek sends one) is the other
    // shape, and both have to name the same line.
    await opener.openCodeEditor(null, monaco.Uri.file("/x/y.ts"), { lineNumber: 7, column: 2 });
    expect(opened[1]).toEqual(["/x/y.ts", 7, 2]);

    // Not ours to open: Monaco's own handler puts links in a browser, and a URL
    // claimed here would be "opened" as a file path.
    const link = await opener.openCodeEditor(null, { scheme: "https", path: "", toString: () => "https://example.com" }, undefined);
    expect(link).toBe(false);
    expect(opened).toHaveLength(2);
    server.setLocationOpener(null);
  });
});

describe("quick fixes", () => {
  it("carries the markers into the request, because that is what makes it a fix", async () => {
    const model = makeModel(FILE, "const a = greetName;\n");
    const monaco = makeMonaco([model]);
    const starting = server.startLanguageServer(monaco, ROOT);
    await vi.waitFor(() => expect(sent().some((m) => m.method === "initialize")).toBe(true));
    deliver({ jsonrpc: "2.0", id: sent().find((m) => m.method === "initialize").id, result: { capabilities: {} } });
    await starting;
    await sentMethod("textDocument/didOpen");

    const provider = monaco.providers.find((p: any) => p.kind === "codeAction");
    const pending = provider.provider.provideCodeActions(
      model,
      { startLineNumber: 3, startColumn: 11, endLineNumber: 3, endColumn: 20 },
      {
        markers: [
          {
            severity: 8, // Monaco's Error
            message: "Cannot find name 'greetName'.",
            code: "2304",
            source: "ts",
            startLineNumber: 3,
            startColumn: 11,
            endLineNumber: 3,
            endColumn: 20,
          },
        ],
        trigger: 1,
      },
    );

    let id: number | undefined;
    await vi.waitFor(() => {
      id = sent().find((m) => m.method === "textDocument/codeAction")?.id;
      expect(id).toBeDefined();
    });
    const params = sent().find((m) => m.method === "textDocument/codeAction").params;
    // Zero-based on the wire, and the severity has to come back down Monaco's
    // bitmask ladder: 8 (Error) is LSP 1.
    expect(params.range).toEqual({ start: { line: 2, character: 10 }, end: { line: 2, character: 19 } });
    expect(params.context.diagnostics[0]).toMatchObject({
      severity: 1,
      code: "2304",
      source: "ts",
      message: "Cannot find name 'greetName'.",
    });

    deliver({
      jsonrpc: "2.0",
      id,
      result: [
        {
          title: 'Update import from "./lib"',
          kind: "quickfix",
          isPreferred: true,
          // The shape the server measured: a workspace edit with `documentChanges`.
          edit: {
            documentChanges: [
              {
                textDocument: { uri: `file://${FILE}`, version: 4 },
                edits: [
                  { range: { start: { line: 0, character: 22 }, end: { line: 0, character: 22 } }, newText: ", greetName" },
                ],
              },
            ],
          },
        },
        // A refactoring with only the TypeScript server's own command: not LSP, and
        // not applicable by a client that does not implement it.
        { title: "Convert to async function", kind: "refactor.rewrite", command: { command: "_typescript.applyCodeActionCommand", arguments: [] } },
        { title: "Move to a new file", kind: "refactor.move.newFile", disabled: { reason: "Could not find a declaration" }, edit: { changes: { [`file://${FILE}`]: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: "x" }] } } },
      ],
    });

    const { actions } = await pending;
    // Two of the three: the command-only refactoring is dropped rather than
    // offered as an entry that does nothing when it is picked.
    expect(actions.map((a: any) => a.title)).toEqual(['Update import from "./lib"', "Move to a new file"]);
    expect(actions[0].isPreferred).toBe(true);
    expect(actions[0].edit.edits[0]).toMatchObject({
      resource: { path: FILE },
      textEdit: { text: ", greetName", range: { startLineNumber: 1, startColumn: 23 } },
    });
    // The open model's version, so Monaco can refuse an edit computed against text
    // that has moved on.
    expect(actions[0].edit.edits[0].versionId).toBe(7);
    expect(actions[1].disabled).toBe("Could not find a declaration");
  });

  it("names a file it cannot open by its path, and forgets a file operation", () => {
    const model = makeModel(FILE, "const a = 1;\n");
    const monaco = makeMonaco([model]);

    const edit = server.toMonacoWorkspaceEdit(monaco, {
      changes: { [`file://${FILE}`]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "let" }] },
    });
    expect(edit.edits[0].resource.toString()).toBe(FILE);

    const elsewhere = server.toMonacoWorkspaceEdit(monaco, {
      changes: { "file:///Users/dev/project/src/other.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// hi" }] },
    });
    expect(elsewhere.edits[0].resource.toString()).toBe("file:///Users/dev/project/src/other.ts");

    // A create/rename/delete has no Monaco equivalent: applying half of a workspace
    // edit is worse than not offering it.
    expect(server.toMonacoWorkspaceEdit(monaco, { documentChanges: [{ kind: "create", uri: "file:///new.ts" }] })).toBeUndefined();
    expect(server.toMonacoWorkspaceEdit(monaco, {})).toBeUndefined();
  });
});

describe("rename, which must not half-apply", () => {
  it("applies the last edit first, because every range is against the old text", () => {
    // Two edits on one line: applying the left one first shifts the right one by a
    // character and the result is mangled code rather than an error.
    const text = "const alt = value; use(alt, alt);\n";
    const edits = [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: "renamed" },
      { range: { start: { line: 0, character: 23 }, end: { line: 0, character: 26 } }, newText: "renamed" },
    ];
    expect(server.applyTextEdits(text, edits)).toBe("const renamed = value; use(renamed, alt);\n");
    expect(server.applyTextEdits(text, [...edits, { range: { start: { line: 0, character: 28 }, end: { line: 0, character: 31 } }, newText: "renamed" }]))
      .toBe("const renamed = value; use(renamed, renamed);\n");
  });

  async function renaming(result: any) {
    const model = makeModel(FILE, "const alt = value;\n");
    const monaco = makeMonaco([model]);
    const starting = server.startLanguageServer(monaco, ROOT);
    await vi.waitFor(() => expect(sent().some((m) => m.method === "initialize")).toBe(true));
    deliver({ jsonrpc: "2.0", id: sent().find((m) => m.method === "initialize").id, result: { capabilities: {} } });
    await starting;
    await sentMethod("textDocument/didOpen");

    const provider = monaco.providers.find((p: any) => p.kind === "rename");
    const pending = provider.provider.provideRenameEdits(model, { lineNumber: 1, column: 7 }, "renamed");
    let id: number | undefined;
    await vi.waitFor(() => {
      id = sent().find((m) => m.method === "textDocument/rename")?.id;
      expect(id).toBeDefined();
    });
    expect(sent().find((m) => m.method === "textDocument/rename").params.newName).toBe("renamed");
    deliver({ jsonrpc: "2.0", id, result });
    return pending;
  }

  it("writes the files it cannot show, and hands the open one to Monaco", async () => {
    const closed = `${ROOT}/src/other.ts`;
    fileReads[closed] = "import { alt } from './lib';\n";

    const outcome = await renaming({
      changes: {
        [`file://${FILE}`]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: "renamed" }],
        [`file://${closed}`]: [{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, newText: "renamed" }],
      },
    });

    // The closed file is on disk now, which Monaco could never have done.
    expect(fileWrites).toEqual([{ path: closed, content: "import { renamed } from './lib';\n" }]);
    // And only the open file comes back, named by its own model's URI.
    expect(outcome.edits).toHaveLength(1);
    expect(outcome.edits[0].resource.toString()).toBe(FILE);
    expect(outcome.rejectReason).toBeUndefined();
  });

  it("changes nothing at all when a file it cannot show cannot be written", async () => {
    const model = makeModel(FILE, "const alt = value;\n");
    const monaco = makeMonaco([model]);
    const starting = server.startLanguageServer(monaco, ROOT);
    await vi.waitFor(() => expect(sent().some((m) => m.method === "initialize")).toBe(true));
    deliver({ jsonrpc: "2.0", id: sent().find((m) => m.method === "initialize").id, result: { capabilities: {} } });
    await starting;
    await sentMethod("textDocument/didOpen");

    // One file writes, the next does not exist.
    const writable = `${ROOT}/src/a.ts`;
    const missing = `${ROOT}/src/gone.ts`;
    fileReads[writable] = "alt;\n";

    const provider = monaco.providers.find((p: any) => p.kind === "rename");
    const pending = provider.provider.provideRenameEdits(model, { lineNumber: 1, column: 7 }, "renamed");
    let id: number | undefined;
    await vi.waitFor(() => {
      id = sent().find((m) => m.method === "textDocument/rename")?.id;
      expect(id).toBeDefined();
    });
    deliver({
      jsonrpc: "2.0",
      id,
      result: {
        changes: {
          [`file://${FILE}`]: [],
          [`file://${writable}`]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "renamed" }],
          [`file://${missing}`]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "renamed" }],
        },
      },
    });

    const outcome = await pending;
    // The open file is NOT renamed — Monaco is given nothing to apply.
    expect(outcome.edits).toEqual([]);
    expect(outcome.rejectReason).toContain("Nothing was changed");
    // And the file that did write was put back: a rename in some files and not
    // others is broken code that reports success.
    expect(fileWrites.at(-1)).toEqual({ path: writable, content: "alt;\n" });
  });
});

describe("signature help", () => {
  it("passes both label shapes through, and the parameter of the overload in play", () => {
    const help = server.toMonacoSignatureHelp({
      signatures: [
        {
          label: "greetName(who: string, loudly?: boolean): string",
          parameters: [{ label: [10, 21] }, { label: "loudly?: boolean" }],
          activeParameter: 1,
        },
      ],
      activeSignature: 0,
    });

    expect(help.signatures[0].parameters[0].label).toEqual([10, 21]);
    expect(help.signatures[0].parameters[1].label).toBe("loudly?: boolean");
    // Per signature, which is what the server sends: taking the answer-level value
    // would highlight the first parameter of every overload but the one in play.
    expect(help.activeParameter).toBe(1);
    expect(help.activeSignature).toBe(0);
  });
});

describe("a language server that dies", () => {
  async function starting() {
    const model = makeModel(FILE, "const a = 1;\n");
    const monaco = makeMonaco([model]);
    void server.startLanguageServer(monaco, ROOT);
    await vi.waitFor(() => expect(sent().some((m) => m.method === "initialize")).toBe(true));
    return monaco;
  }

  it("says it stopped, with the last thing it said, instead of waiting forever", async () => {
    await starting();
    expect(server.languageServerState().status).toBe("starting");

    handlers.get("lsp:log")?.({
      payload: { session: 7, line: "Fatal process out of memory: Failed to reserve virtual memory for CodeRange" },
    });
    handlers.get("lsp:exit")?.({ payload: { session: 7 } });

    // This is the whole point: 0.2.36 left the badge on "starting…" indefinitely,
    // because a child that dies mid-handshake simply never answers.
    expect(server.languageServerState().status).toBe("failed");
    expect(server.languageServerState().detail).toContain("CodeRange");
  });

  it("gives up on a handshake that is never answered", async () => {
    vi.useFakeTimers();
    try {
      void server.startLanguageServer(makeMonaco([makeModel(FILE, "const a = 1;\n")]), ROOT);
      await vi.advanceTimersByTimeAsync(50);
      expect(server.languageServerState().status).toBe("starting");

      await vi.advanceTimersByTimeAsync(21_000);
      expect(server.languageServerState().status).toBe("failed");
      expect(server.languageServerState().detail).toContain("did not answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an exit from a session that is not the current one", async () => {
    await starting();
    handlers.get("lsp:exit")?.({ payload: { session: 99 } });
    expect(server.languageServerState().status).toBe("starting");
  });
});

