import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCompletion,
  fimSuffix,
  registerAiInlineCompletions,
  sanitizeCompletion,
} from "./aiAutocomplete";
import { rememberModelCapabilities } from "./aiModelManager";

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

/** A `fetch` that answers with the bodies a real daemon would send. */
function stubFetch(handler: (url: string, body: any) => Response) {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    return handler(url, body);
  });
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ask = (settings: any) =>
  fetchCompletion({ prefix: PREFIX, suffix: SUFFIX, settings, signal: new AbortController().signal });

describe("fetchCompletion dialects", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // The flags Ollama itself reports on this machine, so the branch under test is
    // the one the daemon would actually take.
    rememberModelCapabilities("ollama", [
      { name: "qwen2.5-coder:7b", capabilities: ["completion", "tools", "insert"] },
      { name: "deepseek-coder:6.7b", capabilities: ["completion"] },
    ]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks Ollama the FIM way first, and holds the model in memory", async () => {
    const calls = stubFetch(() => json({ response: "email }," }));
    const out = await ask({ provider: "ollama", model: "qwen2.5-coder:7b", baseUrl: "", apiKey: "" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:11434/api/generate");
    expect(calls[0].body.suffix).toBe(SUFFIX);
    expect(calls[0].body.prompt).toBe(PREFIX);
    expect(calls[0].body.prompt).not.toContain("<|fim_prefix|>");
    // A cold load measured 2s against 105ms warm; unloading between keystrokes
    // is the difference between a suggestion and an interruption.
    expect(calls[0].body.keep_alive).toBe("30m");
    expect(out).toBe("email },");
  });

  it("never sends an empty suffix, which takes the model out of FIM mode", async () => {
    // Measured: with nothing after the cursor the model answered as a chat bot
    // ("It looks like you're trying to find a user…") and took ~4s. A newline
    // put it back to code in 257ms.
    expect(fimSuffix("")).toBe("\n");
    expect(fimSuffix(" },\n    });")).toBe(" },\n    });");

    const calls = stubFetch(() => json({ response: "\n  });\n}" }));
    const out = await fetchCompletion({
      prefix: PREFIX,
      suffix: "",
      settings: { provider: "ollama", model: "qwen2.5-coder:7b", apiKey: "", baseUrl: "" },
      signal: new AbortController().signal,
    });
    expect(calls[0].body.suffix).toBe("\n");
    expect(out).toBe("\n  });\n}");
  });

  it("asks a model that cannot insert nothing at all", async () => {
    // The `insert` capability is Ollama saying the template has a FIM section.
    // deepseek-coder:6.7b has none: measured, `suffix` answers HTTP 400 and the
    // hand-rolled `<|fim_prefix|>` prompt came back as a paragraph of prose that
    // would be typed into the file. Asking anyway is not free either — the daemon
    // loads the model to refuse, and a 9B took 15.9s to say no.
    const calls = stubFetch(() => json({ response: "The function you provided is a…" }));
    const out = await ask({ provider: "ollama", model: "deepseek-coder:6.7b", baseUrl: "", apiKey: "" });

    expect(calls).toHaveLength(0);
    expect(out).toBe("");
  });

  it("still asks a model whose capabilities we have not been told", async () => {
    // Guessing "cannot" would silently disable the feature for every model the
    // engine has not reported on yet.
    const calls = stubFetch(() => json({ response: "email }," }));
    const out = await ask({ provider: "ollama", model: "unreported:latest", baseUrl: "", apiKey: "" });

    expect(calls).toHaveLength(1);
    expect(out).toBe("email },");
  });

  it("speaks the OpenAI dialect for every other cloud provider", async () => {
    // Groq, DeepSeek, xAI, NVIDIA, Google, Moonshot, Together, OpenRouter all
    // serve /chat/completions from their own base URL. Naming only `openai`
    // here left completion silently dead for all of them.
    for (const provider of ["groq", "deepseek", "xai", "nvidia", "google", "moonshot", "together", "openrouter"]) {
      const calls = stubFetch(() => json({ choices: [{ message: { content: "email }," } }] }));
      const out = await ask({
        provider,
        model: "some-model",
        baseUrl: `https://${provider}.example/v1`,
        apiKey: "k-123456",
      });
      expect(calls[0].url, provider).toBe(`https://${provider}.example/v1/chat/completions`);
      expect(calls[0].body.model, provider).toBe("some-model");
      expect(out, provider).toBe("email },");
      vi.unstubAllGlobals();
    }
  });

  it("uses the Cohere dialect, which is not OpenAI-compatible", async () => {
    const calls = stubFetch(() => json({ text: "email }," }));
    const out = await ask({ provider: "cohere", model: "command-r", baseUrl: "", apiKey: "k-123456" });

    expect(calls[0].url).toBe("https://api.cohere.ai/v1/chat");
    expect(calls[0].body.preamble).toContain("ONLY the code to insert");
    expect(out).toBe("email },");
  });

  it("falls back to the offline synthesizer rather than calling out without a key", async () => {
    const calls = stubFetch(() => json({}));
    expect(await ask({ provider: "openai", model: "gpt-4o-mini", baseUrl: "", apiKey: "" })).toBe("");
    expect(calls).toHaveLength(0);
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

  async function ask(settings: any) {
    const monaco = fakeMonaco();
    registerAiInlineCompletions(monaco, () => settings);
    return monaco.provider.provideInlineCompletions(
      model("const user = await db.user.findUnique({ where: {"),
      { lineNumber: 1, column: 1 },
      {},
      { isCancellationRequested: false },
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks nobody at all when it is off", async () => {
    const calls = stubFetch(() => json({ response: "email }," }));
    const result = await ask({
      provider: "ollama",
      model: "qwen2.5-coder:7b",
      apiKey: "",
      baseUrl: "",
      inlineCompletion: false,
    });
    expect(result.items).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("offers ghost text when it is on, which is how it ships", async () => {
    vi.useFakeTimers();
    try {
      stubFetch(() => json({ response: "email }," }));
      const pending = ask({
        provider: "ollama",
        model: "qwen2.5-coder:7b",
        apiKey: "",
        baseUrl: "",
      });
      await vi.advanceTimersByTimeAsync(300);
      const result = await pending;
      expect(result.items[0].insertText).toBe("email },");
    } finally {
      vi.useRealTimers();
    }
  });
});
