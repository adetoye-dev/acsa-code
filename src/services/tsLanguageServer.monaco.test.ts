/**
 * @vitest-environment jsdom
 *
 * The registration path, against the **real** `monaco-editor`.
 *
 * Every other test in this suite uses a stand-in for Monaco, which is why a
 * shipped build could sit on "TS starting…" forever: the stand-in has whatever the
 * language service asks for, and the real one does not have to. This drives the
 * same `startLanguageServer` the editor calls, with the same Monaco the editor
 * hands it, and requires the session to reach `running`.
 *
 * The fake is the right tool for the protocol; this is the right tool for "does
 * the editor actually accept what we register".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as monaco from "monaco-editor";
import { declineMonacoTypeScriptProviders } from "../monacoTypeScriptProviders";

const invokes: Array<{ command: string; args: Record<string, any> }> = [];
const handlers = new Map<string, (event: { payload: any }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, any>) => {
    invokes.push({ command, args });
    if (command === "lsp_start") return 1;
    return undefined;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: any }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  },
}));

vi.mock("./fileAccess", () => ({
  readTextFile: async () => "",
  writeTextFile: async () => undefined,
}));

// Monaco asks the browser for these; jsdom does not implement them.
if (!window.matchMedia) {
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
if (!(globalThis as any).ResizeObserver) {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// The app declines Monaco's own TypeScript providers at startup (`monacoSetup`, at
// module load), and the editor never creates a model before that has happened. A test
// that drives the real Monaco has to establish the same precondition: Monaco reads the
// mode configuration once, when the first TypeScript model appears, so a model created
// first would measure a configuration the app never runs — and the providers it left
// registered reach for a worker the app no longer ships, which is what made this file
// fail with `Worker is not defined`.
declineMonacoTypeScriptProviders(monaco);

const server = await import("./tsLanguageServer");

beforeEach(() => {
  invokes.length = 0;
  handlers.clear();
});

afterEach(async () => {
  await server.stopLanguageServer();
});

describe("registering against the real Monaco", () => {
  it("reaches running, which is what the editor's badge waits for", async () => {
    // The editor is what makes models; without one there is nothing to open, and
    // the registration is the part under test.
    monaco.editor.create(document.createElement("div"), { value: "const a = 1;\n", language: "typescript" });

    void server.startLanguageServer(monaco, "/tmp/real-monaco-project");
    await vi.waitFor(() => expect(invokes.some((i) => i.command === "lsp_start")).toBe(true));

    const sent = () =>
      invokes.filter((i) => i.command === "lsp_send").map((i) => JSON.parse(i.args.message));
    await vi.waitFor(() => expect(sent().some((m) => m.method === "initialize")).toBe(true));

    handlers.get("lsp:message")?.({
      payload: {
        session: 1,
        message: {
          jsonrpc: "2.0",
          id: sent().find((m) => m.method === "initialize").id,
          result: {
            capabilities: {
              completionProvider: { triggerCharacters: [".", "'"] },
              signatureHelpProvider: { triggerCharacters: ["(", ","] },
              codeActionProvider: true,
              renameProvider: { prepareProvider: true },
              definitionProvider: true,
              referencesProvider: true,
              hoverProvider: true,
            },
          },
        },
      },
    });

    // A throw anywhere in the registration leaves the state at "starting" and the
    // badge saying so forever, so this is the assertion that matters.
    await vi.waitFor(() => expect(server.languageServerState().status).toBe("running"), {
      timeout: 5000,
    });
  });
});
