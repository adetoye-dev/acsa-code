import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completionContext,
  fetchCompletion,
  registerAiInlineCompletions,
  sanitizeCompletion,
} from "./aiAutocomplete";

/**
 * The engine is the only thing this module talks to now.
 *
 * The direct requests are gone — the webview's CSP refuses a fetch to Ollama on
 * 127.0.0.1:11434, and the page never holds a cloud credential — so the transport
 * is mocked here and the payload is what these tests read. The daemon's own
 * behaviour (Ollama's FIM template, the `insert` capability, the newline an empty
 * suffix needs) is measured and pinned next to the engine that sends it, in
 * `tests/test_ai_complete.py`.
 */
const engineCalls: Array<Record<string, any>> = [];
let engineReply: { status: number; body: unknown } = { status: 200, body: { ok: true, completion: "" } };
let holdOpen = false;
const releases: Array<(res: Response) => void> = [];

vi.mock("./aiClient", () => ({
  aiFetch: async (_path: string, init?: RequestInit) => {
    engineCalls.push(init?.body ? JSON.parse(String(init.body)) : {});
    if (holdOpen) return new Promise<Response>((resolve) => releases.push(resolve));
    return new Response(JSON.stringify(engineReply.body), {
      status: engineReply.status,
      headers: { "Content-Type": "application/json" },
    });
  },
}));

/**
 * The fixture is the request that exposed the bug, not a made-up one.
 *
 * The cursor sits inside an object literal, so the answer runs into the suffix
 * rather than replacing it: the model must produce `email ` and stop, and the
 * reader's own `},\n    });\n    return user;` supplies the rest.
 */
const PREFIX =
  "export async function findUserByEmail(email: string) {\n" +
  "  const user = await prisma.user.findUnique({\n" +
  "      where: {";
const SUFFIX = " },\n    });\n    return user;";
const ANSWER = "email },\n    });\n    return user;";

describe("sanitizeCompletion", () => {
  it("passes a correct completion through untouched", () => {
    expect(sanitizeCompletion(ANSWER, PREFIX, SUFFIX)).toBe(ANSWER);
  });

  it("strips a markdown fence around the answer", () => {
    expect(sanitizeCompletion("```ts\n" + ANSWER + "\n```", PREFIX, SUFFIX)).toBe(ANSWER);
    expect(sanitizeCompletion("```typescript\n" + ANSWER, PREFIX, SUFFIX)).toBe(ANSWER);
  });

  it("drops a completion that echoes the prefix back", () => {
    // What Qwen returned: the whole prefix, fenced, with nothing new in it.
    // Inserting it writes the file into itself — the reported failure.
    expect(sanitizeCompletion("```typescript\n" + PREFIX + "\n```", PREFIX, SUFFIX)).toBe("");
  });

  it("keeps only what follows an echo when the answer continues past it", () => {
    // The echo boundary falls mid-line, so the echoed text is not at the start
    // and a prefix-only check would miss it.
    expect(sanitizeCompletion(PREFIX + ANSWER, PREFIX, SUFFIX)).toBe(ANSWER);
    expect(sanitizeCompletion("Sure, here you go:\n" + PREFIX + ANSWER, PREFIX, SUFFIX)).toBe(
      // The chatter before the echo goes with it: "here you go" is not code.
      ANSWER,
    );
  });

  it("says nothing rather than repeating what is already typed", () => {
    expect(sanitizeCompletion("where: {", PREFIX, SUFFIX)).toBe("");
    expect(sanitizeCompletion("   \n  ", PREFIX, SUFFIX)).toBe("");
    expect(sanitizeCompletion("", PREFIX, SUFFIX)).toBe("");
  });

  it("says nothing rather than repeating the suffix back", () => {
    expect(sanitizeCompletion("},\n    });\n    return user;", PREFIX, SUFFIX)).toBe("");
  });

  it("does not offer to write inside a comment the reader is already in", () => {
    expect(sanitizeCompletion(" keep going", "  // TODO:", "")).toBe("");
    expect(sanitizeCompletion(" keep going", "  /* scratch", "")).toBe("");
  });

  it("bounds the answer: a few lines, not a patch", () => {
    const many = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
    expect(sanitizeCompletion(many, "x", "").split("\n")).toHaveLength(6);
    expect(sanitizeCompletion("z".repeat(500), "x", "").length).toBe(400);
  });

  it("normalises a CRLF answer before anything is inserted", () => {
    expect(sanitizeCompletion("email },\r\n    });", PREFIX, SUFFIX)).toBe("email },\n    });");
  });
});


const ask = (settings: Record<string, unknown> = {}) =>
  fetchCompletion({
    prefix: PREFIX,
    suffix: SUFFIX,
    settings: { provider: "ollama", model: "qwen2.5-coder:7b", apiKey: "", baseUrl: "", ...settings } as any,
    signal: new AbortController().signal,
  });

describe("fetchCompletion", () => {
  beforeEach(() => {
    engineCalls.length = 0;
    releases.length = 0;
    holdOpen = false;
    engineReply = { status: 200, body: { ok: true, completion: "email }," } };
  });

  it("sends the text either side of the cursor to the engine", async () => {
    expect(await ask()).toBe("email },");
    expect(engineCalls).toHaveLength(1);
    expect(engineCalls[0]).toMatchObject({
      provider: "ollama",
      model: "qwen2.5-coder:7b",
      prefix: PREFIX,
      suffix: SUFFIX,
    });
  });

  it("passes an empty suffix through rather than inventing one", async () => {
    // An empty suffix is what the end of a file looks like. The newline it needs is
    // the engine's business — that is the side that sends the request.
    await fetchCompletion({
      prefix: PREFIX,
      suffix: "",
      settings: { provider: "ollama", model: "qwen2.5-coder:7b", apiKey: "", baseUrl: "" },
      signal: new AbortController().signal,
    });
    expect(engineCalls[0].suffix).toBe("");
  });

  it("takes the engine's silence as silence, not as an invitation to invent", async () => {
    // "def handler():" is a prefix the old offline synthesizer answered with a
    // docstring stub — a deterministic completion wearing the model's clothes.
    engineReply = { status: 200, body: { ok: true, completion: "" } };
    expect(await fetchCompletion({
      prefix: "def handler():",
      suffix: "",
      settings: { provider: "ollama", model: "qwen2.5-coder:7b", apiKey: "", baseUrl: "" },
      signal: new AbortController().signal,
    })).toBe("");
  });

  it("offers nothing when there is no backend to ask", async () => {
    // What a plain browser gets: the desktop-required answer, and a keystroke is no
    // place to raise it.
    engineReply = { status: 501, body: { ok: false, error: "needs the desktop app" } };
    expect(await ask()).toBe("");
  });

  it("offers nothing when the engine reports a failure", async () => {
    engineReply = { status: 200, body: { ok: false, completion: "", reason: "no API key" } };
    expect(await ask({ provider: "groq", model: "openai/gpt-oss-120b" })).toBe("");
  });

  it("does not start a second request behind one that is still out", async () => {
    // Each engine call is a process. An answer that arrives for text which has
    // since moved is worse than no answer, so the second request gets nothing.
    holdOpen = true;
    const first = ask();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = ask();
    holdOpen = false;
    releases[0](new Response(JSON.stringify({ ok: true, completion: "email }," }), { status: 200 }));

    expect(await first).toBe("email },");
    expect(await second).toBe("");
    expect(engineCalls).toHaveLength(1);
  });
});

/**
 * A text model that answers ranges the way Monaco does, so the stitched prefix can
 * be read back as lines rather than guessed at.
 */
function textModel(text: string) {
  const lines = text.split("\n");
  return {
    getLineCount: () => lines.length,
    getLineMaxColumn: (n: number) => (lines[n - 1] ?? "").length + 1,
    getValueInRange: ({
      startLineNumber,
      startColumn,
      endLineNumber,
      endColumn,
    }: {
      startLineNumber: number;
      startColumn: number;
      endLineNumber: number;
      endColumn: number;
    }) => {
      if (startLineNumber === endLineNumber) {
        return (lines[startLineNumber - 1] ?? "").slice(startColumn - 1, endColumn - 1);
      }
      const out = [(lines[startLineNumber - 1] ?? "").slice(startColumn - 1)];
      for (let i = startLineNumber; i < endLineNumber - 1; i++) out.push(lines[i] ?? "");
      out.push((lines[endLineNumber - 1] ?? "").slice(0, endColumn - 1));
      return out.join("\n");
    },
  } as any;
}

/**
 * An interface near the top, then enough unrelated work that it falls outside the
 * window above the cursor — which is the case that was measured, and the one where
 * the model invented fields it had never been shown.
 */
function fileWithTypeAwayFromCursor() {
  const head = ["interface UserRecord {", "  id: string;", "  email: string;", "}"];
  const padding = Array.from({ length: 120 }, (_, i) => `export const helper${i} = ${i};`);
  const tail = ["export function toRecord(raw: any): UserRecord {", "  return {", "    id: raw.id,"];
  // 127 lines: the cursor sits 50 lines in, well past the head's 40.
  return { text: [...head, ...padding, ...tail].join("\n"), cursorLine: 127 };
}

describe("completionContext", () => {
  it("carries the head of the file, not only the cursor's neighbours", () => {
    // Measured: without the interface in the prompt the model invented fields
    // ("name: raw.name", "updatedAt"), and a confident wrong field is what gets
    // inserted. The fifty lines above the cursor do not contain it.
    const { text, cursorLine } = fileWithTypeAwayFromCursor();
    // Column 16 is the end of `    id: raw.id,` — the cursor at the end of the buffer.
    const { prefix } = completionContext(textModel(text), { lineNumber: cursorLine, column: 16 });

    expect(prefix).toContain("interface UserRecord");
    expect(prefix).toContain("// …");
    expect(prefix).toContain("id: raw.id,");
    // The head's own lines, and the tail's, are both there …
    expect(prefix).toContain("helper1 = 1");
    expect(prefix).toContain("helper100 = 100");
    // … and the middle that neither window covers is skipped, not sent twice.
    expect(prefix).not.toContain("helper50 = 50");
  });

  it("reads one contiguous block when the windows would overlap", () => {
    // A short file, or a cursor near the top: the head is already inside the tail,
    // and sending it twice would be worse than either.
    const text = "const a = 1;\nconst b = 2;\nconst c = 3;";
    const { prefix } = completionContext(textModel(text), { lineNumber: 3, column: 13 });

    expect(prefix).toBe(text);
    expect(prefix).not.toContain("// …");
  });

  it("does not stitch a marker into text that is contiguous anyway", () => {
    // Lines 1..40 and 41..cursor are adjacent: a marker between them would be a
    // lie about the file's contents.
    const lines = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`);
    const { prefix } = completionContext(textModel(lines.join("\n")), { lineNumber: 91, column: 5 });

    expect(prefix).not.toContain("// …");
    expect(prefix.split("\n")).toHaveLength(91);
    expect(prefix.startsWith("const v0 = 0;")).toBe(true);
  });

  it("sends the code after the cursor, which is what closes it", () => {
    const text = "function f() {\n  return {\n  };\n}\n";
    const { suffix } = completionContext(textModel(text), { lineNumber: 2, column: 11 });
    expect(suffix).toBe("\n  };\n}\n");
  });
});

/**
 * The switch has to reach the provider, not just the settings page: it exists to
 * stop requests, and it ships on.
 */
describe("the inline completion switch", () => {
  function fakeMonaco() {
    let provider: any = null;
    return {
      languages: {
        registerInlineCompletionsProvider: (_language: string, p: any) => {
          provider = p;
          return { dispose: () => {} };
        },
      },
      Range: class {
        constructor(...args: unknown[]) {
          Object.assign(this, args);
        }
      },
      get provider() {
        return provider;
      },
    } as any;
  }

  const model = (text: string) =>
    ({
      getValueInRange: () => text,
      getLineCount: () => 1,
      getLineMaxColumn: () => text.length + 1,
    }) as any;

  async function complete(settings: Record<string, unknown>) {
    const monaco = fakeMonaco();
    registerAiInlineCompletions(monaco, () => settings as any);
    return monaco.provider.provideInlineCompletions(
      model("const user = await db.user.findUnique({ where: {"),
      { lineNumber: 1, column: 1 },
      {},
      { isCancellationRequested: false },
    );
  }

  beforeEach(() => {
    engineCalls.length = 0;
    releases.length = 0;
    holdOpen = false;
    engineReply = { status: 200, body: { ok: true, completion: "email }," } };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks nobody at all when it is off", async () => {
    const result = await complete({
      provider: "ollama",
      model: "qwen2.5-coder:7b",
      apiKey: "",
      baseUrl: "",
      inlineCompletion: false,
    });
    expect(result.items).toEqual([]);
    expect(engineCalls).toHaveLength(0);
  });

  it("offers ghost text when it is on, which is how it ships", async () => {
    vi.useFakeTimers();
    const pending = complete({ provider: "ollama", model: "qwen2.5-coder:7b", apiKey: "", baseUrl: "" });
    await vi.advanceTimersByTimeAsync(300);
    const result = await pending;
    expect(result.items[0].insertText).toBe("email },");
  });
});
