import { describe, expect, it } from "vitest";
import { AGENT_BASE_INSTRUCTIONS, AGENT_RUNTIME_FLAGS, RESERVED_RUNTIME_PROVIDER_IDS, agentCatalogEntry, approvalSummary, countDiffLines, hostedProviderId, summarizeItemChanges, userInputResponse } from "./usePipeline";

/**
 * The instruction the app hands the agent through the model catalog on every run.
 * Gap 5: asked to add priorities to a small project, a run spent most of ~6
 * minutes building its own headless-browser harness, which nothing bounded.
 */
describe("the standing instruction handed to the agent", () => {
  it("names a ceiling on self-verification", () => {
    expect(AGENT_BASE_INSTRUCTIONS).toMatch(/project already has/);
    expect(AGENT_BASE_INSTRUCTIONS).toMatch(/smallest change/);
    expect(AGENT_BASE_INSTRUCTIONS).toMatch(/unless the task asks for it/);
  });

  it("still asks for verification, so it is not a licence to skip checking", () => {
    expect(AGENT_BASE_INSTRUCTIONS).toMatch(/verify your changes/);
  });

  /**
   * Reproduced on current code: "Create stats.js … and stats.test.js … Then run
   * the tests with node" came back as a design proposal ending "reply yes and
   * I'll implement it", with nothing written — the model obeyed a host skill
   * (`superpowers:brainstorming`) whose "MUST use before any creative work" reads
   * as a gate. Without a precedence line there is nothing to weigh against it.
   */
  it("makes a concrete instruction the assignment, ahead of a plan-and-wait skill", () => {
    expect(AGENT_BASE_INSTRUCTIONS).toMatch(/concrete instruction is the assignment/);
    expect(AGENT_BASE_INSTRUCTIONS).toMatch(/not a gate on starting it/);
  });

  /**
   * The panel answers questions only through the structured tool
   * (`features.default_mode_request_user_input`). A question written as prose
   * ends the turn and leaves the user with nothing to click, which is the other
   * half of the same reproduced run.
   */
  it("routes a needed decision to the structured question tool, not prose", () => {
    expect(AGENT_BASE_INSTRUCTIONS).toMatch(/request_user_input/);
    expect(AGENT_BASE_INSTRUCTIONS).toMatch(/written as plain text ends the turn/);
  });
});

/**
 * The flags the app writes into the runtime's config.toml. These are the app's
 * only lever on the runtime's own behaviour, and writing the wrong thing here is
 * invisible except as wasted time or a confusing line in OUTPUT — which is
 * exactly how the ~45s of doomed OpenAI plugin syncing went unnoticed.
 */
describe("the runtime flags", () => {
  it("does not let the runtime chase OpenAI's plugin marketplace", () => {
    // Measured on a real run without it: a 401 against chatgpt.com, a `git fetch`
    // that timed out after 30s, and a GitHub 429 — retried for ~45s of a ~75s
    // run, on a marketplace a third-party provider can never reach.
    expect(AGENT_RUNTIME_FLAGS).toContain("features.plugins = false");
  });

  it("asks the runtime to stop warning about a feature this app switched on", () => {
    // Turning on `default_mode_request_user_input` makes the runtime announce an
    // under-development feature on every start, which the user sees as an error.
    expect(AGENT_RUNTIME_FLAGS).toContain("suppress_unstable_features_warning = true");
  });

  it("keeps the structured question available to the agent", () => {
    expect(AGENT_RUNTIME_FLAGS).toContain("features.default_mode_request_user_input = true");
  });

  it("does not suppress host skills", () => {
    // The tempting fix for `superpowers:brainstorming` pausing a run was to stop
    // host skill discovery. Two runs wrote nothing that way, and the transcript
    // still read like a report. The app plays the other half of that
    // conversation instead; this stops the bad fix being reintroduced.
    expect(AGENT_RUNTIME_FLAGS.join("\n")).not.toMatch(/skip_host_skill_discovery/);
  });
});

/**
 * The answer half of `request_user_input`.
 *
 * This shape is not a guess: it was read out of the runtime's own protocol
 * schema, generated with `codex app-server generate-json-schema` —
 * `ToolRequestUserInputResponse` is `{"answers": {"<questionId>":
 * ToolRequestUserInputAnswer}}`, and each answer is `{"answers": ["<string>"]}`.
 *
 * The one live request we captured matches it: questions arrive with an `id`, and
 * with `header`, `question`, `isOther`, `isSecret` and `options[{label,description}]`.
 *
 * Worth pinning because the runtime *holds the turn* until it can deserialise
 * this. The approval path already has a scar from exactly that: an earlier
 * `{decision: "approved"}` was not in the runtime's vocabulary, so the reply was
 * unreadable and the turn waited forever.
 */
describe("answering a request_user_input question", () => {
  it("builds the shape the schema requires", () => {
    expect(userInputResponse({ approval: ["Approve — build it (Recommended)"] })).toEqual({
      answers: { approval: { answers: ["Approve — build it (Recommended)"] } },
    });
  });

  it("carries every question, and drops empty answers", () => {
    expect(userInputResponse({ a: ["one"], b: ["", "   "], c: ["two", "three"] })).toEqual({
      answers: { a: { answers: ["one"] }, b: { answers: [] }, c: { answers: ["two", "three"] } },
    });
  });

  it("handles no answers at all without inventing one", () => {
    expect(userInputResponse({})).toEqual({ answers: {} });
  });
});

/**
 * An approval has to say what it is for.
 *
 * The card used to render `pendingApproval.command`, which defaulted to the
 * *method name* — so a file-change approval read "$ item/fileChange/requestApproval"
 * and asked the user to approve something invisible. Only a command approval
 * carries a command; the rest get a sentence.
 */
describe("describing an approval", () => {
  it("names what each request is asking for", () => {
    expect(approvalSummary("item/commandExecution/requestApproval")).toBe("run a command");
    expect(approvalSummary("item/fileChange/requestApproval")).toBe("change files in this project");
    expect(approvalSummary("mcpServer/elicitation/request")).toBe("connect to an MCP server");
  });

  it("falls back to something honest for a method it does not know", () => {
    const summary = approvalSummary("item/brandNew/requestApproval");
    expect(summary).toBe("do something it needs your approval for");
    // Never the raw method: that is what made the card unreadable.
    expect(summary).not.toContain("item/");
  });
});

/**
 * A file-change approval names an item and nothing else, so the paths and the
 * diff have to come from the item the runtime announced first.
 */
describe("summarising a pending file change", () => {
  it("reads paths, kinds and diffs out of the item", () => {
    const item = {
      id: "call_1",
      type: "fileChange",
      status: "pending",
      changes: [
        { path: "/p/src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" },
        { path: "/p/src/b.ts", kind: "add", diff: "+hello" },
      ],
    };
    expect(summarizeItemChanges(item)).toEqual([
      { path: "/p/src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" },
      { path: "/p/src/b.ts", kind: "add", diff: "+hello" },
    ]);
  });

  it("returns nothing rather than inventing a change", () => {
    for (const junk of [undefined, null, {}, { changes: null }, { changes: [{}] }, "nope"]) {
      expect(summarizeItemChanges(junk)).toEqual([]);
    }
  });
});

/**
 * The change card's numbers. Counted from the runtime's own diff, so they
 * describe this turn rather than the working tree — and the `+++`/`---` file
 * headers are not changes, which is the easy way to be off by two.
 */
describe("counting a diff", () => {
  it("counts real changes and not the file headers", () => {
    const diff = [
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-gone",
      "+new",
      "+extra",
    ].join("\n");
    expect(countDiffLines(diff)).toEqual({ added: 2, removed: 1 });
  });

  it("is zero for nothing at all", () => {
    expect(countDiffLines("")).toEqual({ added: 0, removed: 0 });
    expect(countDiffLines("--- a/src/x.ts\n+++ b/src/x.ts")).toEqual({ added: 0, removed: 0 });
  });
});

/**
 * The provider id we hand the runtime, which is a config matter rather than a
 * rendering one: a reserved built-in name is a *hard error*, so the entire config
 * is refused and the run continues against the runtime's default instead. That is
 * how OpenAI models came to answer in prose and touch no files while DeepSeek
 * edited them — measured with one headless run per provider, where renaming the
 * id alone made `gpt-5.3-codex` perform 12 command calls and change the file.
 */
describe("the provider id our generated config offers the runtime", () => {
  // Every hosted provider the registry actually offers. Five were removed for
  // being unable to serve a Responses API at all (a 404 on `POST /responses`;
  // huggingface served nothing), so this list and `AIProviderId` must agree.
  const hosted = [
    "openai", "groq", "deepseek", "xai", "moonshot", "cohere", "together", "openrouter",
  ];

  it("never collides with a name the runtime reserves", () => {
    const reserved = new Set<string>(RESERVED_RUNTIME_PROVIDER_IDS);
    for (const id of hosted) {
      const emitted = hostedProviderId(id);
      expect(reserved.has(emitted), `${emitted} is reserved by the runtime`).toBe(false);
      expect(emitted).toMatch(/^acsa-/);
    }
    // The local adapter has its own id and `ollama` is reserved, which is why it
    // cannot reuse the provider's own name either.
    expect(reserved.has("acsa-local")).toBe(false);
  });

  it("lists the reserved ids for real, so an empty list cannot pass this file", () => {
    // If this list were emptied — the tempting way to make the check above pass —
    // the hazard it documents would be invisible again.
    const reserved = new Set<string>(RESERVED_RUNTIME_PROVIDER_IDS);
    expect(hosted.some((id) => reserved.has(id))).toBe(true);
    expect(reserved.has("openai")).toBe(true);
  });
});

/**
 * What the runtime is told about a model, which decides what the model is allowed
 * to do with an image.
 *
 * Reported: a run on a vision model could not use `view_image` —
 * "error=view_image is not allowed because you do not support image inputs" — and
 * fell back to hunting for the screenshot on disk and OCR-ing it with macOS
 * Vision. Every catalog entry said `input_modalities: ["text"]`, because the field
 * was hard-coded, and the runtime believes its catalog over the request.
 */
describe("the catalog entry for one model", () => {
  it("declares image input for a vision model", () => {
    const entry = agentCatalogEntry("openai", "OpenAI", "gpt-5.3-codex");
    expect(entry.input_modalities).toContain("image");
  });

  it("keeps a text-only model text-only, because a false yes is a failed run", () => {
    // Sending an image to a model that cannot read one is a 400 the runtime
    // retries five times before reporting the turn as failed.
    const entry = agentCatalogEntry("deepseek", "DeepSeek", "deepseek-flash");
    expect(entry.input_modalities).toEqual(["text"]);
  });

  it("still names the model and the provider it came through", () => {
    // The extraction that made this testable must not have dropped a field.
    const entry = agentCatalogEntry("deepseek", "DeepSeek", "deepseek-flash");
    expect(entry.slug).toBe("deepseek-flash");
    expect(entry.description).toContain("DeepSeek");
    expect(entry.base_instructions).toBe(AGENT_BASE_INSTRUCTIONS);
    expect(entry.apply_patch_tool_type).toBe("freeform");
  });
});
