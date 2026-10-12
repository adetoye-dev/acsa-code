import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two Tauri channels, recorded. `invoke` is what the page can do; `listen` is
 * how the shell's reader thread reaches back with a language server's message.
 */
const invokes: Array<{ command: string; args: Record<string, any> }> = [];
const handlers = new Map<string, (event: { payload: any }) => void>();
let startFails: string | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, any>) => {
    invokes.push({ command, args });
    if (command === "lsp_start") {
      if (startFails) throw new Error(startFails);
      return 7;
    }
    return undefined;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: any }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  },
}));

const workerDiagnostics: boolean[] = [];
vi.mock("./monacoTsConfig", () => ({
  setWorkerFeaturesEnabled: (_monaco: unknown, enabled: boolean) => workerDiagnostics.push(enabled),
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
  const created: Array<(m: any) => void> = [];
  const disposed: Array<(m: any) => void> = [];
  const markers = new Map<string, any[]>();
  const providers: Array<{ kind: string; languages: string[]; provider: any; disposed: boolean }> = [];
  return {
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
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
    },
    editor: {
      getModels: () => models,
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
  workerDiagnostics.length = 0;
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
    expect(workerDiagnostics).toEqual([]);
  });

  it("opens the project's models and hands diagnostics over only once it answers", async () => {
    const model = makeModel(FILE, "const answer: number = 42;\n");
    const monaco = makeMonaco([model]);

    const starting = server.startLanguageServer(monaco, ROOT);
    // `initialize` is in flight: the worker must still be the one checking.
    await vi.waitFor(() => expect(sent().some((m) => m.method === "initialize")).toBe(true));
    expect(workerDiagnostics).toEqual([]);

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
    expect(workerDiagnostics).toEqual([false]);
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

    expect(workerDiagnostics).toEqual([false, true]);
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

  it("puts the worker's features back when the session stops", async () => {
    const { monaco } = await running();
    expect(workerDiagnostics.at(-1)).toBe(false);
    await server.stopLanguageServer();
    expect(workerDiagnostics.at(-1)).toBe(true);
    for (const provider of monaco.providers) expect(provider.disposed).toBe(true);
  });
});
