// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * "Fix with AI is failing", and the toast said only `Inline edit request failed
 * (200)`.
 *
 * The request had succeeded: the engine reports its refusals in the body, under
 * `error`, while the page read only `reason` (which the sanitizer path fills). So a
 * missing key, a provider 402 and a model that answered with no code all arrived as
 * a status code. `aiReview` reads `error` and always did; this was the one path
 * that did not.
 *
 * jsdom because the function uses `window.setTimeout` for its own ceiling.
 */
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, replacement: "x" } };
const sent: Array<Record<string, unknown>> = [];

vi.mock("./aiClient", () => ({
  aiFetch: async (_path: string, init?: RequestInit) => {
    sent.push(init?.body ? JSON.parse(String(init.body)) : {});
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  },
}));

const { executeInlineEdit } = await import("./aiAutocomplete");

const settings = { provider: "deepseek", model: "deepseek-flash", apiKey: "", baseUrl: "" };
const edit = () =>
  executeInlineEdit({
    instruction: "Add aria-pressed to the toggle.",
    selectedCode: '<button onClick={toggleTheme}>',
    surroundingPrefix: "function App() {\n",
    surroundingSuffix: "\n}\n",
    settings,
  });

afterEach(() => {
  sent.length = 0;
});

describe("an inline edit the engine refused", () => {
  it("says what the engine said, not the status code", async () => {
    reply = { status: 200, body: { ok: false, error: "An API key is required for provider 'deepseek'.", replacement: "" } };

    const result = await edit();

    expect(result).toEqual({
      ok: false,
      reason: "An API key is required for provider 'deepseek'.",
    });
    // The sentence that used to be all anyone got.
    expect(result.reason).not.toMatch(/\(200\)/);
  });

  it("keeps a sanitizer refusal, which arrives as `reason`", async () => {
    // The one refusal path that always read correctly — kept so the new `error`
    // fallback cannot quietly take its place.
    reply = {
      status: 200,
      body: { ok: false, reason: "The model returned the code unchanged.", replacement: "" },
    };

    expect((await edit()).reason).toBe("The model returned the code unchanged.");
  });

  it("names the empty answer for what it is", async () => {
    // `ok` with nothing in it does not happen from the engine, but a future caller
    // could produce it, and "returned nothing (200)" would repeat the old mistake.
    reply = { status: 200, body: { ok: true, replacement: "   " } };

    const result = await edit();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/returned no code/);
    expect(result.reason).toMatch(/try again/i);
  });

  it("still fails loudly when the response says nothing at all", async () => {
    reply = { status: 200, body: { ok: false } };

    const result = await edit();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/returned nothing/);
    expect(result.reason).toMatch(/200/);
  });

  it("applies a usable replacement", async () => {
    reply = { status: 200, body: { ok: true, replacement: '<button aria-pressed={theme === "dark"}>' } };

    const result = await edit();
    expect(result).toEqual({ ok: true, replacement: '<button aria-pressed={theme === "dark"}>' });
    // And the instruction reaches the engine, rather than being rebuilt here.
    expect(sent[0]).toMatchObject({ provider: "deepseek", model: "deepseek-flash" });
  });
});
