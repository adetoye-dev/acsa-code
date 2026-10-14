// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// jsdom implements neither of these; the transcript scrolls its tail into view on
// every append, and the send button measures nothing.
Element.prototype.scrollIntoView = () => undefined;

/**
 * The transcript renders a provider badge per assistant message. Counting those
 * renders is the signal this test uses: the badge is inside the memoised
 * transcript, so if a keystroke in the composer re-renders the transcript, the
 * count climbs — and if the memo holds, it does not. The composer renders this
 * same component for the *active* model, so the count is keyed by provider id to
 * keep the two apart.
 */
const counted = vi.hoisted(() => ({ byProvider: {} as Record<string, number> }));

vi.mock("../ui/BrandLogos", () => ({
  ProviderLogo: ({ providerId }: { providerId?: string }) => {
    const key = providerId ?? "?";
    counted.byProvider[key] = (counted.byProvider[key] ?? 0) + 1;
    return <span data-testid={`logo:${key}`} />;
  },
}));

/** A stored message, loose enough for the fields the shapes under test add. */
type SeedMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
} & Record<string, unknown>;

const SEEDED: SeedMessage[] = [
  {
    id: "m1",
    role: "user" as const,
    content: "add a health endpoint",
    timestamp: 1,
  },
  {
    id: "m2",
    role: "assistant" as const,
    content: "Done — it is on `/health`.",
    provider: "deepseek",
    model: "deepseek-flash",
    timestamp: 2,
  },
];

vi.mock("../../services/aiChatPersistence", () => ({
  loadChatHistory: () => SEEDED,
  saveChatHistory: () => undefined,
  clearChatHistory: () => undefined,
  subscribeChatHistory: () => () => undefined,
}));

/** The model in effect, and whether it is allowed to drive a tool-using run. */
const model = vi.hoisted(() => ({
  /**
   * Model name -> whether it can drive a run, defaulting to yes. Per model rather
   * than one flag, because the capability is a property of the model: a test that
   * switches from a chat-only model to a capable one needs both answers at once.
   */
  canRun: {} as Record<string, boolean>,
  /**
   * The configured model list. It has to hold the model: the component re-resolves
   * the selection on mount and drops anything the list does not contain, so an
   * empty list here would quietly test the "no model selected" path instead.
   */
  list: [] as Array<Record<string, unknown>>,
  initial: null as null | {
    providerId: string;
    providerName: string;
    model: string;
    speedBadge: string;
    isDefault: boolean;
    category: "local" | "cloud";
  },
}));

const LOCAL_CHAT_MODEL = {
  providerId: "ollama",
  providerName: "Ollama",
  model: "qwen2.5-coder:7b",
  speedBadge: "Offline",
  isDefault: true,
  category: "local" as const,
};

const CLOUD_AGENT_MODEL = {
  providerId: "openai",
  providerName: "OpenAI",
  model: "gpt-5.3-codex",
  speedBadge: "Thinking",
  isDefault: false,
  category: "cloud" as const,
};

vi.mock("../../services/aiModelManager", () => ({
  canRunAgent: (_providerId: string, name: string) => model.canRun[name] ?? true,
  getConfiguredModelsList: () => model.list,
  ensureProvidersHydrated: async () => undefined,
  resolveInitialSelectedModel: () => model.initial,
  saveActiveSelectedModel: () => undefined,
  getActiveSelectedModel: () => null,
  loadAllProviders: () => ({}),
  getAutoSelectedLocalWorker: () => "",
  isModelVisionCapable: () => false,
  findBestAvailableVisionModel: () => null,
  syncOllamaModels: () => undefined,
}));

vi.mock("../../services/fileAccess", () => ({
  readTextFile: async () => "export const x = 1;",
  writeTextFile: async () => undefined,
}));

// The chat transport, captured rather than exercised: what matters here is what
// a chat turn is *handed*, which is the half that had a file dropped from it.
vi.mock("../../services/aiChatService", () => ({
  streamChatCompletion: vi.fn(async () => undefined),
}));

vi.mock("../../services/ollamaSetup", () => ({
  openAiManagementDashboard: () => undefined,
  checkOllamaStatus: async () => ({ running: false, models: [] }),
  EVENT_START_CODING_WITH_OLLAMA: "acsa:start-coding-with-ollama",
}));

const { AiAssistantChat, effectiveWorkflowMode } = await import("./AiAssistantChat");
const { chatDraft } = await import("../../services/chatDraft");
const { streamChatCompletion } = await import("../../services/aiChatService");

const baseProps = {
  status: "idle" as const,
  activityLog: [],
  onRunPipeline: () => undefined,
  onCancelPipeline: () => undefined,
  projectRoot: "/work/acsa-code",
  isWide: true,
};

afterEach(() => {
  cleanup();
  counted.byProvider = {};
  chatDraft.clear();
  model.canRun = {};
  model.initial = null;
  model.list = [];
});

const transcriptRenders = () => counted.byProvider["deepseek"] ?? 0;

describe("the chat transcript's render boundary", () => {
  it("draws the conversation", () => {
    render(<AiAssistantChat {...baseProps} />);
    expect(screen.getByText(/Done — it is on/)).toBeTruthy();
    expect(transcriptRenders()).toBeGreaterThan(0);
  });

  it("is re-rendered when something it shows changes", () => {
    // The control: proves the counter below is actually measuring this component
    // rather than standing still for some unrelated reason.
    const { rerender } = render(<AiAssistantChat {...baseProps} />);
    const before = transcriptRenders();

    rerender(<AiAssistantChat {...baseProps} streamingAnswer="streaming…" status="running" />);

    expect(transcriptRenders()).toBeGreaterThan(before);
  });

  it("is left alone while a prompt is being typed", () => {
    // The point of the boundary. The composer's text lives outside this component
    // tree now, so typing wakes the composer and nothing else.
    let hostRenders = 0;
    function Host() {
      hostRenders += 1; // stands in for the workbench above the chat
      return <AiAssistantChat {...baseProps} />;
    }
    render(<Host />);
    const before = hostRenders;
    const transcriptBefore = transcriptRenders();

    const box = screen.getByRole("textbox");
    for (const text of ["h", "he", "hel", "hell", "hello"]) {
      fireEvent.change(box, { target: { value: text } });
    }

    expect((box as HTMLTextAreaElement).value).toBe("hello");
    expect(hostRenders).toBe(before);
    expect(transcriptRenders()).toBe(transcriptBefore);
  });

  it("keeps a half-typed prompt when the panel is closed and reopened", () => {
    // Closing the chat unmounts it, so the draft cannot live in its state — the
    // text would vanish. It lives in the store instead; this pins that.
    const first = render(<AiAssistantChat {...baseProps} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "half a thought" } });
    first.unmount();

    render(<AiAssistantChat {...baseProps} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("half a thought");
  });
});

/**
 * The card the turn is blocked on.
 *
 * It was pinned above the composer, so it could be seen — but it carried no role
 * and nothing moved focus, which is why a run parked for six minutes was
 * diagnosed by reading the accessibility tree. These pin the two properties that
 * make it a prompt rather than a decoration: it is announced as the blocking
 * dialog it is, and the keyboard lands on it when it appears.
 */
describe("the card that blocks the turn", () => {
  const approval = {
    id: "appr-1",
    method: "item/commandExecution/requestApproval",
    reason: "The agent wants to run a command.",
    command: "rm -rf build",
  };

  it("is announced as a dialog, not an anonymous box on screen", () => {
    render(<AiAssistantChat {...baseProps} pendingApproval={approval} />);
    const card = screen.getByRole("alertdialog");
    expect(card.getAttribute("aria-labelledby")).toBe("agent-approval-heading");
    // `aria-modal="false"` on purpose: it does not take over the screen, it sits
    // where the input is, and claiming modality it does not have is worse than
    // claiming none.
    expect(card.getAttribute("aria-modal")).toBe("false");
    expect(screen.getByText("Approval needed")).toBeTruthy();
  });

  it("takes the keyboard when it appears", () => {
    // `status: "running"` is the real state here: a turn blocked on an approval is
    // still a running turn, and that is also what makes the composer render at all.
    render(<AiAssistantChat {...baseProps} status="running" pendingApproval={approval} />);
    const card = screen.getByRole("alertdialog");
    expect(document.activeElement).toBe(card);
  });

  it("announces a question as a dialog too, and names it as one", () => {
    render(
      <AiAssistantChat
        {...baseProps}
        pendingQuestion={{
          id: "q1",
          questions: [{ id: "approval", header: "Design", question: "Which one?", options: [] }],
        }}
      />,
    );
    const card = screen.getByRole("alertdialog");
    expect(card.getAttribute("aria-labelledby")).toBe("agent-question-heading");
    expect(screen.getByText("The agent is asking")).toBeTruthy();
  });

  it("does not exist when nothing is pending", () => {
    render(<AiAssistantChat {...baseProps} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

/**
 * Steering: a message sent while a turn is running goes *into* that turn.
 *
 * The composer used to offer only Stop while running, and `handleSend` returned
 * early on `status === "running"` — so pressing Enter mid-run did nothing and
 * said nothing. The runtime takes `turn/steer`; these pin that the app uses it,
 * and that a refusal does not swallow the message.
 */
describe("steering a running turn", () => {
  const steerButton = () => screen.getByRole("button", { name: /steer the running turn/i });

  it("sends the message into the running turn instead of starting another", async () => {
    const steer = vi.fn().mockResolvedValue(null);
    const run = vi.fn();
    render(
      <AiAssistantChat
        {...baseProps}
        status="running"
        onRunPipeline={run}
        onSteerPipeline={steer}
      />,
    );
    act(() => chatDraft.set("use tabs instead"));
    fireEvent.click(steerButton());

    await waitFor(() => expect(steer).toHaveBeenCalledWith("use tabs instead"));
    // Not a second turn, and the composer is cleared only because it sent.
    expect(run).not.toHaveBeenCalled();
    expect(chatDraft.get()).toBe("");
  });

  it("keeps the text and says why when the turn refuses to be steered", async () => {
    // The runtime's own refusal for `/review` and manual `/compact`.
    const refusal = "This turn cannot be steered — a review or a compaction is running. Wait for it to finish.";
    const steer = vi.fn().mockResolvedValue(refusal);
    render(<AiAssistantChat {...baseProps} status="running" onSteerPipeline={steer} />);
    act(() => chatDraft.set("change of plan"));
    fireEvent.click(steerButton());

    await waitFor(() => expect(screen.getByTestId("steer-error")).toBeTruthy());
    expect(screen.getByText(refusal)).toBeTruthy();
    // The message is still there to resend: a failed send must not look like one
    // that worked, and must not cost the user their typing.
    expect(chatDraft.get()).toBe("change of plan");
  });

  it("offers no steer control when nothing is running", () => {
    render(<AiAssistantChat {...baseProps} onSteerPipeline={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /steer the running turn/i })).toBeNull();
  });
});

/**
 * Undo. The change log described what a turn changed and offered no way back, and
 * the runtime cannot do it either — both of its history primitives say they do not
 * revert local file changes. The engine snapshots the pre-turn state; this is the
 * affordance for it.
 */
describe("undoing the last turn", () => {
  const CHANGES = [{ path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new\n" }];

  // Undo is offered *on the message it belongs to* — it moved out of the composer,
  // so the transcript has to have a reply for the control to hang off.
  const withATurn = {
    chatMessages: [{ id: "turn-1", role: "assistant" as const, content: "Edited src/a.ts" }],
  };

  it("offers to undo the turn that just finished", async () => {
    const undo = vi.fn().mockResolvedValue(null);
    render(<AiAssistantChat {...baseProps} {...withATurn} turnChanges={CHANGES} onUndoLastTurn={undo} />);

    fireEvent.click(screen.getByTestId("undo-last-turn"));
    await waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
    // The outcome is stated, not just implied by the row disappearing.
    await waitFor(() => expect(screen.getByTestId("undo-notice").textContent).toMatch(/Undone/));
  });

  it("says why when it cannot undo, rather than failing silently", async () => {
    const undo = vi.fn().mockResolvedValue("that turn's snapshot is incomplete");
    render(<AiAssistantChat {...baseProps} {...withATurn} turnChanges={CHANGES} onUndoLastTurn={undo} />);

    fireEvent.click(screen.getByTestId("undo-last-turn"));
    await waitFor(() =>
      expect(screen.getByTestId("undo-notice").textContent).toMatch(/incomplete/),
    );
  });

  it("does not offer undo while the turn is still running", () => {
    render(
      <AiAssistantChat
        {...baseProps}
        status="running"
        turnChanges={CHANGES}
        onUndoLastTurn={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("undo-last-turn")).toBeNull();
  });

  it("does not offer undo when nothing changed", () => {
    render(<AiAssistantChat {...baseProps} turnChanges={[]} onUndoLastTurn={vi.fn()} />);
    expect(screen.queryByTestId("undo-last-turn")).toBeNull();
  });
});

/**
 * What a failed run says.
 *
 * The transcript used to fall through to "The task needs attention. Review Problems
 * or Output for details." — true, and useless. The runtime does print the cause; it
 * just buries it under one retry notice per attempt. This is the piece the checklist
 * called "a dead provider still reads as a generic needs attention".
 */
describe("a failed run with a dead provider", () => {
  /** Copied from a run of the bundled runtime against a deliberately bad key. */
  const DEAD_PROVIDER = [
    {
      line_number: 1,
      content:
        "ERROR: unexpected status 401 Unauthorized: Authentication Fails, Your api key: " +
        "****0000 is invalid (request_id: 3aba3fb8), url: https://api.deepseek.com/v1/responses",
      stream: "stderr" as const,
      is_json: false,
    },
    { line_number: 2, content: "ERROR: Reconnecting... 5/5", stream: "stderr" as const, is_json: false },
  ];

  it("says which provider rejected the key, not that something needs attention", async () => {
    const { rerender } = render(<AiAssistantChat {...baseProps} status="running" />);
    // The message is built on the running -> terminal transition.
    rerender(<AiAssistantChat {...baseProps} status="failed" activityLog={DEAD_PROVIDER} />);

    await waitFor(() =>
      expect(screen.getAllByText(/rejected the API key/).length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText(/api\.deepseek\.com/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/needs attention/)).toHaveLength(0);
  });

  it("keeps the generic sentence when the output explains nothing", async () => {
    // The classifier returns nothing rather than guessing, and this is what that
    // protects: an unrecognised failure must not acquire a confident wrong cause.
    const { rerender } = render(<AiAssistantChat {...baseProps} status="running" />);
    rerender(
      <AiAssistantChat
        {...baseProps}
        status="failed"
        activityLog={[
          { line_number: 1, content: "ERROR: something we have never seen", stream: "stderr", is_json: false },
        ]}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByText(/needs attention/).length).toBeGreaterThan(0),
    );
  });
});

/**
 * Dropping an image, which is how people attach a screenshot in practice —
 * pasting works and the file picker works, but the gesture everyone reaches for
 * is to drag the file onto the box. It takes the same route as paste
 * (`handleImageFiles`), so what arrives is identical either way.
 */
describe("dropping an image on the composer", () => {
  const imageFile = () =>
    new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });

  it("attaches it", async () => {
    render(<AiAssistantChat {...baseProps} />);
    const box = screen.getByRole("textbox");
    const file = imageFile();

    // `dragover` has to preventDefault or the browser never fires `drop`; passing
    // both events through is what proves the handler is really wired.
    fireEvent.dragOver(box, { dataTransfer: { types: ["Files"], files: [file] } });
    fireEvent.drop(box, { dataTransfer: { types: ["Files"], files: [file] } });

    expect(await screen.findByAltText("Attachment")).toBeTruthy();
  });

  it("ignores a drop that is not an image", async () => {
    // A stray text file should not become an attachment the model is asked about.
    render(<AiAssistantChat {...baseProps} />);
    const box = screen.getByRole("textbox");
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });

    fireEvent.drop(box, { dataTransfer: { types: ["Files"], files: [file] } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByAltText("Attachment")).toBeNull();
  });
});

/**
 * Dragging a file out of the explorer and onto the composer.
 *
 * A drop from inside the app carries no `File` — a webview cannot hand one a
 * path — so the row puts its path on the clipboard instead. What attaches is
 * the file the reader was pointing at, and anything that is not a path (text
 * they happened to have selected) is left alone rather than folded into the
 * prompt.
 */
describe("dropping a file from the explorer onto the composer", () => {
  const dragPath = (path: string) => ({ types: ["text/plain"], files: [], getData: () => path });

  it("attaches the file the dragged row was pointing at", async () => {
    render(<AiAssistantChat {...baseProps} />);
    const box = screen.getByRole("textbox");

    fireEvent.drop(box, { dataTransfer: dragPath("/work/acsa-code/src/index.tsx") });

    const chip = await screen.findByTestId("attached-file");
    expect(chip.getAttribute("title")).toBe("/work/acsa-code/src/index.tsx");
  });

  it("ignores dragged text that is not an absolute path", async () => {
    render(<AiAssistantChat {...baseProps} />);
    const box = screen.getByRole("textbox");

    fireEvent.drop(box, { dataTransfer: dragPath("just some selected words") });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByTestId("attached-file")).toBeNull();
  });
});

/**
 * Opening a chat lands on the newest message.
 *
 * The follow-tail effect deliberately refuses to scroll when the reader is not at
 * the bottom — which is the state a freshly opened transcript is in, at the top of
 * the whole history. So nothing scrolled, and the reply someone opened the app to
 * read was a manual scroll away.
 *
 * jsdom reports every element as zero-height, and the reveal refuses to scroll a
 * container it cannot measure, so these tests state the layout they are pretending
 * to have. That is not a convenience: it is the difference the real bug turned on
 * (a panel sized after mount), and a test that skipped it would pass while the app
 * opened on the first message of the history on every launch — which is exactly
 * what happened.
 */
describe("where an opened chat starts", () => {
  /**
   * Report these box metrics from every element, so the reveal's "did it land?"
   * check can be driven. jsdom computes no layout at all, so without this every
   * element measures 0×0 and the question is unanswerable.
   */
  function stubBoxMetrics(metrics: { clientHeight: number; scrollHeight: number }): () => void {
    const previous: Array<[string, PropertyDescriptor | undefined]> = Object.entries(metrics).map(
      ([name]) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)],
    );
    for (const [name, value] of Object.entries(metrics)) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
    }
    return () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    };
  }

  /** The reveal's own jump, told apart from the follow-tail effect's. */
  const endJumps = (spy: ReturnType<typeof vi.fn>) =>
    spy.mock.calls.filter(([options]) => (options as { block?: string } | undefined)?.block === "end")
      .length;

  it("scrolls to the newest message", async () => {
    const spy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    // A transcript that fills the panel and is already at its end, which is where
    // a successful reveal leaves it: one jump, and not a retry.
    const restore = stubBoxMetrics({ clientHeight: 640, scrollHeight: 640 });
    try {
      render(<AiAssistantChat {...baseProps} />);
      // `block: "end"`, which is this jump and not the follow-tail effect: that
      // one passes only `behavior`, and in jsdom it fires too, so asserting a bare
      // call would pass without the fix. Confirmed by removing the effect and
      // watching the assertion below still fail on the count.
      await waitFor(() => expect(endJumps(spy)).toBeGreaterThan(0));
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ block: "end", behavior: "auto" }));
    } finally {
      Element.prototype.scrollIntoView = original;
      restore();
    }
  });

  it("keeps trying while the transcript reports it is not at the end", async () => {
    // The reproduced failure, in one assertion. The transcript is taller than the
    // panel and `scrollIntoView` did not land it at the end (in the app because
    // the height was still changing; here because jsdom does not move `scrollTop`).
    // One attempt and a "done" flag is what left a relaunched app showing the
    // first message of the history for the rest of the session — the effect
    // returns early once that flag is set, and the follow-tail effect will not
    // fill in, because a container at the top is not following the bottom.
    const spy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    const restore = stubBoxMetrics({ clientHeight: 400, scrollHeight: 5_000 });
    try {
      render(<AiAssistantChat {...baseProps} />);
      await waitFor(() => expect(endJumps(spy)).toBeGreaterThan(1));
    } finally {
      Element.prototype.scrollIntoView = original;
      restore();
    }
  });
});

/**
 * The mode a run uses, when the model cannot do what the mode asks.
 *
 * This used to be handled by moving the reader's mode: picking a model the daemon
 * reports as having no tool support switched the chip to ask mode. The reader
 * could then switch that off — landing them back in a mode the model cannot run at
 * all — and a control that appears on its own is one they will cancel. The
 * downgrade is internal now, so the chip is only ever the reader's own choice.
 */
describe("the mode a run actually uses", () => {
  it("is the reader's own when the model can run it", () => {
    expect(effectiveWorkflowMode("agent", true)).toBe("agent");
    expect(effectiveWorkflowMode("plan", true)).toBe("plan");
    expect(effectiveWorkflowMode("chat", true)).toBe("chat");
  });

  it("is a chat when the model cannot call tools, whatever the chip says", () => {
    // Agent and plan both go through the runtime, which needs a model that calls
    // tools. Running them anyway is the failure this exists to prevent.
    expect(effectiveWorkflowMode("agent", false)).toBe("chat");
    expect(effectiveWorkflowMode("plan", false)).toBe("chat");
    expect(effectiveWorkflowMode("chat", false)).toBe("chat");
  });
});

describe("a model that can only chat", () => {
  const onlyChat = () => {
    model.canRun = { [LOCAL_CHAT_MODEL.model]: false };
    model.initial = LOCAL_CHAT_MODEL;
    model.list = [LOCAL_CHAT_MODEL, CLOUD_AGENT_MODEL];
    render(<AiAssistantChat {...baseProps} />);
  };
  const openModelMenu = () => fireEvent.click(screen.getByTitle(/runs on this machine/));

  it("leaves the mode chip alone, because the reader never turned it on", () => {
    onlyChat();

    expect(screen.queryByTitle("Turn ask mode off")).toBeNull();
    expect(screen.queryByTitle(/does not call tools/)).toBeNull();
    // And the composer still says agent, because agent is what they picked.
    expect(screen.getByTitle("Run Agent (Enter)")).toBeTruthy();
  });

  it("lists every model, with nothing hidden", async () => {
    onlyChat();

    await waitFor(() => expect(screen.getByTitle(/runs on this machine/)).toBeTruthy());
    openModelMenu();

    expect(await screen.findByText("2 models")).toBeTruthy();
    expect(screen.queryByText(/hidden/)).toBeNull();
    expect(screen.getByText(CLOUD_AGENT_MODEL.model)).toBeTruthy();
  });

  it("says what the turn will do rather than asking them to pick another model", async () => {
    onlyChat();

    await waitFor(() => expect(screen.getByTitle(/runs on this machine/)).toBeTruthy());
    openModelMenu();

    expect(await screen.findByText(/answers in the chat instead of editing files/)).toBeTruthy();
    // The old menu pushed them at a different model. Choosing is theirs; this only
    // says what the turn will do.
    expect(screen.queryByRole("button", { name: /Use .* instead/ })).toBeNull();
  });
});


/**
 * Files as chat context.
 *
 * The picker replaced a "Mentions" entry that typed an "@" nothing handled, so
 * the first thing to pin is that the thing a reader attaches is the thing the
 * composer says is attached — and that they can take it back off.
 */
describe("attaching a file to a message", () => {
  const TREE = [
    {
      name: "src",
      path: "/work/acsa-code/src",
      is_dir: true,
      size_bytes: 0,
      children: [
        { name: "index.tsx", path: "/work/acsa-code/src/index.tsx", is_dir: false, size_bytes: 12 },
        { name: "routes.ts", path: "/work/acsa-code/src/routes.ts", is_dir: false, size_bytes: 12 },
      ],
    },
  ];

  const renderWithFiles = () =>
    render(<AiAssistantChat {...baseProps} projectFiles={TREE as never} />);

  /** Open the picker and choose a file by name — the chip is a button too, so a
   *  role query alone would match the thing already attached. */
  const choose = async (name: string) => {
    fireEvent.click(screen.getByTitle(/Add Context/));
    fireEvent.click(screen.getByTestId("add-context-files"));
    const options = await screen.findAllByTestId("file-option");
    const option = options.find((node) => node.textContent?.includes(name));
    if (!option) throw new Error(`no file option for ${name}`);
    fireEvent.click(option);
  };

  it("offers the project's files and shows what was attached", async () => {
    renderWithFiles();

    await choose("index.tsx");

    const chip = await screen.findByTestId("attached-file");
    expect(chip.textContent).toContain("index.tsx");
    // The path is what the prompt will carry, so it is what the chip promises.
    expect(chip.getAttribute("title")).toBe("/work/acsa-code/src/index.tsx");
  });

  it("takes it back off when the reader removes it", async () => {
    renderWithFiles();

    await choose("index.tsx");
    await screen.findByTestId("attached-file");

    fireEvent.click(screen.getByTitle(/Remove index\.tsx/));
    await waitFor(() => expect(screen.queryByTestId("attached-file")).toBeNull());
  });

  it("does not attach the same file twice", async () => {
    renderWithFiles();

    for (const _ of [0, 1]) await choose("index.tsx");

    expect(screen.getAllByTestId("attached-file")).toHaveLength(1);
  });
});

/**
 * A file attached to a *chat* turn has to reach the model.
 *
 * It did not. `promptToSend` — the prompt with the file's text folded into it —
 * was built on both paths, but only the agent path used it; the chat path sent
 * the transcript's own copy, which deliberately holds no file text. So a dragged
 * file was a chip the assistant could not see, and it answered "since no specific
 * file has been mentioned", which is exactly what it had been handed. The send
 * path had no test at all, which is how that survived.
 */
describe("a file attached to a chat turn", () => {
  const TREE = [
    {
      name: "src",
      path: "/work/acsa-code/src",
      is_dir: true,
      size_bytes: 0,
      children: [
        { name: "index.tsx", path: "/work/acsa-code/src/index.tsx", is_dir: false, size_bytes: 12 },
      ],
    },
  ];

  /** Attach a file, type a question, and send it — a model that cannot call tools,
   *  so the turn takes the chat path. */
  const attachAskAndSend = async () => {
    model.canRun = { [LOCAL_CHAT_MODEL.model]: false };
    model.initial = LOCAL_CHAT_MODEL;
    model.list = [LOCAL_CHAT_MODEL];
    (streamChatCompletion as unknown as { mockClear: () => void }).mockClear();

    render(<AiAssistantChat {...baseProps} projectRoot="/work/acsa-code" projectFiles={TREE as never} />);

    fireEvent.click(screen.getByTitle(/Add Context/));
    fireEvent.click(screen.getByTestId("add-context-files"));
    const options = await screen.findAllByTestId("file-option");
    const option = options.find((node) => node.textContent?.includes("index.tsx"));
    if (!option) throw new Error("no file option for index.tsx");
    fireEvent.click(option);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "explain this file" } });
    fireEvent.click(screen.getByTitle("Run Agent (Enter)"));
  };

  const sentMessages = () => {
    const calls = (streamChatCompletion as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const params = calls.at(-1)?.[0] as { messages: Array<{ content: string }> };
    return params.messages;
  };

  it("sends the file's text, not only the chip", async () => {
    await attachAskAndSend();

    await waitFor(() => expect(streamChatCompletion).toHaveBeenCalled());
    const last = sentMessages().at(-1);
    expect(last?.content).toContain("explain this file");
    expect(last?.content).toContain("export const x = 1;"); // the file's text
    expect(last?.content).toContain("index.tsx"); // and which file it is
  });

  it("keeps the file's text out of the transcript", async () => {
    // The chips above the message are what a reader should see, not a wall of the
    // file they attached.
    await attachAskAndSend();

    await waitFor(() => expect(streamChatCompletion).toHaveBeenCalled());
    expect(screen.queryByText(/export const x = 1;/)).toBeNull();
    expect(screen.getByText("explain this file")).toBeTruthy();
  });
});

/**
 * Four things a reader hit at once, in the composer and the transcript.
 */
describe("the composer and the transcript", () => {
  const dragPath = (path: string) => ({ types: ["text/plain"], files: [], getData: () => path });

  it("accepts a drop anywhere on the composer, not only on the text field", async () => {
    // A file dragged in lands wherever the reader is pointing — over the buttons,
    // over the padding. A drop target that was only the textarea made the whole
    // gesture look broken.
    render(<AiAssistantChat {...baseProps} />);

    fireEvent.drop(screen.getByTitle(/Add Context/), {
      dataTransfer: dragPath("/work/acsa-code/src/index.tsx"),
    });

    const chip = await screen.findByTestId("attached-file");
    expect(chip.getAttribute("title")).toBe("/work/acsa-code/src/index.tsx");
  });

  it("keeps files in the order they were attached", async () => {
    render(<AiAssistantChat {...baseProps} />);

    for (const path of ["/work/acsa-code/src/b.ts", "/work/acsa-code/src/a.ts"]) {
      fireEvent.drop(screen.getByTitle(/Add Context/), { dataTransfer: dragPath(path) });
    }

    const chips = screen.getAllByTestId("attached-file");
    expect(chips.map((chip) => chip.getAttribute("title"))).toEqual([
      "/work/acsa-code/src/b.ts",
      "/work/acsa-code/src/a.ts",
    ]);
  });

  it("resizes from its top edge, and remembers the height", () => {
    render(<AiAssistantChat {...baseProps} />);

    // Dragging the top edge *up* makes it taller, like every other divider here.
    fireEvent.mouseDown(screen.getByTitle("Drag to resize the composer"), { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 400 });
    fireEvent.mouseUp(window);

    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(Number.parseInt(box.style.height, 10)).toBeGreaterThan(96);
    expect(localStorage.getItem("acsa_composer_height")).toBe(box.style.height.replace("px", ""));
  });

  it("lets the reader scroll a stream, and stops following when they do", () => {
    // The follow effect fires many times a second while streaming, and the lock it
    // holds made the scroll listener ignore every scroll event — so the next token
    // pulled the view back down and the transcript could not be read.
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const { rerender } = render(
      <AiAssistantChat {...baseProps} status="running" streamingAnswer="one" />,
    );

    fireEvent.wheel(screen.getByTestId("chat-transcript"), { deltaY: -120 });
    scrollIntoView.mockClear();

    rerender(<AiAssistantChat {...baseProps} status="running" streamingAnswer="one two" />);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps a reply selectable, because a reader copies lines by hand", () => {
    // The panel turns selection off for its chrome; a stack trace, a path or half
    // a snippet is exactly what someone needs to lift out of it.
    render(<AiAssistantChat {...baseProps} />);
    expect(screen.getByTestId("chat-transcript").className).toContain("select-text");
  });
});

/**
 * How long the turn worked, in place of the time it started.
 *
 * A start time answers "when did I ask?"; after a run that took seven minutes, the
 * thing the reader wants is the seven minutes. Two different clocks feed it, and
 * both are easy to get wrong: an agent's message is built *after* the run, so its
 * own `timestamp` is the end, and a chat reply has no clock at all unless the
 * transport's callbacks record one.
 */
describe("how long a turn worked for", () => {
  const SEVEN_MINUTES = 7 * 60 * 1000 + 29 * 1000;

  it("dates an agent's finished message by its work, not by when the answer appeared", async () => {
    // `turnElapsedMs` is the pipeline's own counter — it stops while the turn waits
    // on a person, so it is the work done rather than the wall clock.
    const { rerender } = render(
      <AiAssistantChat {...baseProps} status="running" turnElapsedMs={SEVEN_MINUTES} />,
    );
    rerender(
      <AiAssistantChat
        {...baseProps}
        status="success"
        turnElapsedMs={SEVEN_MINUTES}
        streamingAnswer="Done."
      />,
    );

    await waitFor(() => expect(screen.getByText(/worked for 7m 29s/)).toBeTruthy());
    // The start time is not discarded — it moves into the tooltip.
    expect(screen.getByText(/worked for 7m 29s/).getAttribute("title")).toMatch(/^Started /);
  });

  it("measures a chat reply from the prompt to the last token", async () => {
    model.canRun = { [LOCAL_CHAT_MODEL.model]: false };
    model.initial = LOCAL_CHAT_MODEL;
    model.list = [LOCAL_CHAT_MODEL];

    let transport: { onDone: (metadata?: unknown) => void } | null = null;
    const mock = streamChatCompletion as unknown as {
      mockImplementation: (fn: unknown) => void;
      mockClear: () => void;
    };
    mock.mockClear();
    mock.mockImplementation(async (params: unknown) => {
      transport = params as never;
    });

    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000);
      render(<AiAssistantChat {...baseProps} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });
      fireEvent.click(screen.getByTitle("Run Agent (Enter)"));
      await waitFor(() => expect(streamChatCompletion).toHaveBeenCalled());

      now.mockReturnValue(1_000 + 12_000);
      await act(async () => {
        transport?.onDone();
      });

      await waitFor(() => expect(screen.getByText(/worked for 12s/)).toBeTruthy());
    } finally {
      now.mockRestore();
      mock.mockImplementation(async () => undefined);
    }
  });

  it("still shows the start time when no duration was recorded", () => {
    // The control for the two above: a transcript saved before this existed, or a
    // message still streaming, must not acquire a duration it never measured.
    render(<AiAssistantChat {...baseProps} />);
    expect(screen.getByText(/Done — it is on/)).toBeTruthy();
    expect(screen.queryByText(/worked for/)).toBeNull();
  });
});

/**
 * A turn with nothing to show yet, and one that will never have anything to show.
 *
 * Reported from use: an empty bubble while a local model was still working through
 * the prompt — "the users can feel it's stuck which is bad for ux". A blank rounded
 * box is also what a turn that ended empty leaves behind, and from the outside the
 * two are the same picture: nothing there. So neither is blank now — one says it is
 * thinking, with the seconds it has been, and the other says no text came back.
 */
describe("a turn that has not produced text", () => {
  const streamed = (extra: Record<string, unknown>) => {
    SEEDED.push({
      id: `seed-${SEEDED.length}`,
      role: "assistant" as const,
      content: "",
      provider: "ollama",
      model: "qwen2.5-coder:7b",
      timestamp: Date.now(),
      ...extra,
    });
    return () => {
      SEEDED.length = 2;
    };
  };

  it("shows that it is thinking instead of an empty bubble", () => {
    const reset = streamed({ isStreaming: true });
    try {
      render(<AiAssistantChat {...baseProps} />);
      const indicator = screen.getByTestId("reasoning-indicator");
      expect(indicator.textContent).toMatch(/Thinking/);
      // The bubble has something in it — the failure was a bubble with nothing.
      expect(indicator.textContent?.trim().length).toBeGreaterThan("Thinking…".length - 1);
    } finally {
      reset();
    }
  });

  it("counts the seconds once it has been waiting long enough to wonder", async () => {
    const reset = streamed({ isStreaming: true, timestamp: Date.now() - 6_000 });
    try {
      render(<AiAssistantChat {...baseProps} />);
      await waitFor(() => expect(screen.getByTestId("reasoning-indicator").textContent).toMatch(/[3-9]s/));
    } finally {
      reset();
    }
  });

  it("says no text came back when the turn ended empty", () => {
    const reset = streamed({});
    try {
      render(<AiAssistantChat {...baseProps} />);
      expect(screen.getByTestId("empty-reply-note").textContent).toMatch(/No text came back/);
      expect(screen.queryByTestId("reasoning-indicator")).toBeNull();
    } finally {
      reset();
    }
  });
});

/**
 * The running turn's clock, which is the only clock on screen.
 *
 * It said "Working 1m 29s of 20m". The ceiling is real — a run stops itself — but
 * stating it beside the elapsed time gives the reader two numbers and no way to
 * tell what the second one is measured from: "there's no context for what 20
 * minutes we're measuring for". The counter stands alone now, and the ceiling moved
 * into the tooltip, which can say what it is and where to change it.
 */
describe("the running agent's clock", () => {
  it("counts without naming a ceiling it cannot explain", () => {
    render(
      <AiAssistantChat
        {...baseProps}
        status="running"
        turnElapsedMs={89_000}
        turnLimitMinutes={20}
      />,
    );

    expect(screen.getByText("Working 1m 29s")).toBeTruthy();
    expect(screen.queryByText(/of 20m/)).toBeNull();
    // The ceiling is not thrown away — it answers a hover, and names the setting.
    expect(screen.getByText("Working 1m 29s").getAttribute("title")).toMatch(/Settings → Agent/);
  });
});

/**
 * The flow: what the model said it was doing, next to what it did.
 *
 * Reported from use, against Copilot's agent panel — "it shows the reasoning that
 * goes on to help make those decisions", collapsed when the turn ends into one
 * line and opened again in place. The reasoning arrives as entries in the same
 * ordered list as the actions (`kind: "reasoning"`), so this is the assertion that
 * the transcript keeps that order rather than showing a steps block and a thoughts
 * dump side by side.
 */
describe("the agent's reasoning, in the flow", () => {
  const FLOW = [
    {
      id: "r1",
      kind: "reasoning" as const,
      name: "Reasoning",
      text: "Tracing the payout reset first.",
      status: "done" as const,
    },
    { id: "c1", name: "Run Command", detail: "git log -1 --format=%H", status: "done" as const },
    {
      id: "r2",
      kind: "reasoning" as const,
      name: "Reasoning",
      text: "The commit is stale, so the refund path is the real fix.",
      status: "done" as const,
    },
    { id: "a1", name: "Edit Files", detail: "payments.service.ts", status: "done" as const },
  ];

  const seed = (extra: Record<string, unknown>) => {
    SEEDED.push({
      id: "flow-1",
      role: "assistant" as const,
      content: "Fixed the payout reset.",
      provider: "openai",
      model: "gpt-5.3-codex",
      timestamp: 1,
      durationMs: 119_000,
      steps: FLOW,
      ...extra,
    });
    return () => {
      SEEDED.length = 2;
    };
  };

  const flowOrder = () =>
    [...screen.getByTestId("chat-transcript").querySelectorAll('[data-testid="agent-reasoning"], [data-testid="agent-step"]')].map(
      (node) => `${node.getAttribute("data-testid")}:${node.textContent || ""}`,
    );

  it("collapses a finished turn into one line, and opens in place", () => {
    const reset = seed({});
    try {
      render(<AiAssistantChat {...baseProps} />);

      // One line, the same shape Copilot shows: how much work, and how long it took.
      const header = screen.getByText("2 steps · worked for 1m 59s");
      expect(header).toBeTruthy();
      // Two actions, not four entries — the reasoning is not a step.
      expect(screen.queryByText(/4 steps/)).toBeNull();
      // Collapsed: the flow is not in the document until it is asked for.
      expect(screen.queryByTestId("agent-reasoning")).toBeNull();

      fireEvent.click(header);
      expect(screen.getByText("Tracing the payout reset first.")).toBeTruthy();
    } finally {
      reset();
    }
  });

  it("keeps the reasoning between the actions it explains", () => {
    const reset = seed({});
    try {
      render(<AiAssistantChat {...baseProps} />);
      fireEvent.click(screen.getByText("2 steps · worked for 1m 59s"));

      const flow = flowOrder();
      expect(flow.map((entry) => entry.split(":")[0])).toEqual([
        "agent-reasoning",
        "agent-step",
        "agent-reasoning",
        "agent-step",
      ]);
      expect(flow[0]).toContain("Tracing the payout reset");
      expect(flow[1]).toContain("Run Command");
      expect(flow[2]).toContain("refund path");
    } finally {
      reset();
    }
  });

  it("opens a step's own output in place, and closes it again", () => {
    // "the steps are interactive" — a step that only names the command leaves the
    // reader to run it again to find out what it said.
    const reset = seed({
      steps: [
        {
          id: "c1",
          name: "Run Command",
          detail: "npm test",
          status: "failed",
          output: "3 failed, 41 passed\n  at payments.spec.ts:88",
        },
      ],
    });
    try {
      render(<AiAssistantChat {...baseProps} />);
      fireEvent.click(screen.getByTestId("agent-flow-summary"));

      const step = screen.getByTestId("agent-step");
      expect(step.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByTestId("agent-step-output")).toBeNull();

      fireEvent.click(step);
      const printed = screen.getByTestId("agent-step-output");
      expect(printed.textContent).toContain("3 failed, 41 passed");
      expect(step.getAttribute("aria-expanded")).toBe("true");

      fireEvent.click(step);
      expect(screen.queryByTestId("agent-step-output")).toBeNull();
    } finally {
      reset();
    }
  });

  it("opens a file step straight into its diff", () => {
    // One file, so the row can do the obvious thing: a step that says it edited
    // payments.service.ts is a way through to payments.service.ts, not a label.
    const opened: string[] = [];
    const reset = seed({
      steps: [
        {
          id: "e1",
          name: "Edit Files",
          detail: "payments.service.ts",
          status: "done",
          paths: ["src/payments.service.ts"],
        },
      ],
    });
    try {
      render(
        <AiAssistantChat
          {...baseProps}
          onReviewFile={async (path) => {
            opened.push(path);
          }}
        />,
      );
      fireEvent.click(screen.getByTestId("agent-flow-summary"));

      const step = screen.getByTestId("agent-step");
      expect(step.getAttribute("title")).toBe("Open the diff for src/payments.service.ts");
      fireEvent.click(step);
      expect(opened).toEqual(["src/payments.service.ts"]);
      // It opened a file; it did not also open a list.
      expect(screen.queryByTestId("agent-step-files")).toBeNull();
    } finally {
      reset();
    }
  });

  it("lists several files in place rather than opening one of them", () => {
    // Choosing which of six files the reader meant is not a decision to make for
    // them — the row opens the list and each file opens its own diff.
    const opened: string[] = [];
    const reset = seed({
      steps: [
        {
          id: "e2",
          name: "Edit Files",
          detail: "a.ts, b.ts",
          status: "done",
          paths: ["src/a.ts", "src/b.ts"],
        },
      ],
    });
    try {
      render(
        <AiAssistantChat
          {...baseProps}
          onReviewFile={async (path) => {
            opened.push(path);
          }}
        />,
      );
      fireEvent.click(screen.getByTestId("agent-flow-summary"));
      fireEvent.click(screen.getByTestId("agent-step"));
      expect(opened).toEqual([]);

      const rows = [...screen.getByTestId("agent-step-files").querySelectorAll("button")];
      expect(rows.map((row) => row.textContent)).toEqual(["src/a.ts", "src/b.ts"]);
      fireEvent.click(rows[1]);
      expect(opened).toEqual(["src/b.ts"]);
    } finally {
      reset();
    }
  });

  it("reports what the run cost instead of repeating how long it worked for", () => {
    // Reported from use: "we now have a potential duplicate above chat we have
    // 'worked for 1m 59s' then inside the chat we have 'completed 2 steps in 1m
    // 59s' on our dropdown". The flow row keeps the duration; the header takes the
    // number that was nowhere else — what the provider counted.
    const reset = seed({
      tokens: { input: 197_625, output: 16_339, cached: 189_824, reasoning: 4_094, total: 213_964 },
    });
    try {
      render(<AiAssistantChat {...baseProps} />);
      const spend = screen.getByText("214k tokens");
      expect(spend.getAttribute("title")).toContain("197,625 input");
      expect(spend.getAttribute("title")).toContain("4,094 reasoning");
      // Once, and not in the header: the flow row above the answer is the only
      // place the duration appears.
      expect(screen.getAllByText(/worked for 1m 59s/)).toHaveLength(1);
      expect(screen.getByText("2 steps · worked for 1m 59s")).toBeTruthy();
    } finally {
      reset();
    }
  });

  it("keeps the duration in the header when there is no flow to carry it", () => {
    // The other half of the rule: a turn with no steps on record has no row to put
    // it on, and losing the duration entirely would be worse than showing it once
    // in the place that is left.
    const reset = seed({ steps: undefined });
    try {
      render(<AiAssistantChat {...baseProps} />);
      expect(screen.getByText(/worked for 1m 59s/)).toBeTruthy();
    } finally {
      reset();
    }
  });

  it("closes the flow as soon as the summary starts arriving", () => {
    // Asked for directly: "after a task is done and the summary starts writing we
    // auto-close the dropdown so that the user is able to focus on the summary."
    const steps = [
      { id: "r1", kind: "reasoning" as const, name: "Reasoning", text: "Checking the driver.", status: "running" as const },
      { id: "c1", name: "Run Command", detail: "rg driver", status: "running" as const },
    ];
    const { rerender } = render(
      <AiAssistantChat {...baseProps} status="running" agentSteps={steps} turnElapsedMs={5_000} />,
    );

    // Open while it works: the flow is what there is to read.
    expect(screen.getByText("Checking the driver.")).toBeTruthy();

    rerender(
      <AiAssistantChat
        {...baseProps}
        status="running"
        agentSteps={steps}
        turnElapsedMs={12_000}
        streamingAnswer="Here is what I found:"
      />,
    );

    // The answer is on screen and the flow has stepped aside.
    expect(screen.getByText(/Here is what I found/)).toBeTruthy();
    expect(screen.queryByText("Checking the driver.")).toBeNull();
  });

  /**
   * A stopped turn is a turn.
   *
   * Reported from use, from a screen recording: at ≈43s the whole run vanished —
   * the steps, the reasoning and the files it had already changed — leaving the
   * user's message and nothing else. The cause was that the transcript only ever
   * recorded `success | failed | error`, and every way of stopping a run (Stop, the
   * loop backstop, the step backstop, the time limit) goes to `idle` instead.
   */
  it("keeps a stopped turn's steps, reasoning and changes, and says what stopped it", () => {
    const steps = [
      { id: "r1", kind: "reasoning" as const, name: "Reasoning", text: "Checking the build hash.", status: "done" as const },
      { id: "c1", name: "Run Command", detail: "ls -la frontend/build", status: "done" as const, output: "main.4df65ef.js" },
    ];
    // The live shape: a pending change carries the diff, and the counts are derived.
    const changes = [{ path: "frontend/src/App.js", diff: "+added\n-removed\n" }];

    const { rerender } = render(
      <AiAssistantChat
        {...baseProps}
        status="running"
        agentSteps={steps}
        turnChanges={changes as never}
        turnElapsedMs={190_000}
      />,
    );
    // While it runs, the flow is open and readable.
    expect(screen.getByText("Checking the build hash.")).toBeTruthy();

    // The backstop stopped it: status goes to idle, which used to record nothing.
    rerender(
      <AiAssistantChat
        {...baseProps}
        status="idle"
        agentSteps={steps}
        turnChanges={changes as never}
        turnElapsedMs={190_000}
        streamingAnswer="The build output confirms"
        stoppedNotice="Stopped after the same step ran 5 times (Run Command ls -la frontend/build)."
      />,
    );

    // The answer it had written, and the reason it ended — on the record, in the
    // transcript, where the user is looking.
    const transcript = screen.getByTestId("chat-transcript");
    expect(transcript.textContent).toContain("The build output confirms");
    expect(transcript.textContent).toContain("Stopped after the same step ran 5 times");
    // One step, and the time it worked — the run's record, collapsed as usual.
    expect(screen.getByText("1 step · worked for 3m 10s")).toBeTruthy();

    // And the flow is still all there behind the row: the reasoning, the command
    // with its output, and the file it had changed.
    expect(screen.getByText("1 step · worked for 3m 10s")).toBeTruthy();

    // And the flow is still all there behind the row: the reasoning, the command
    // with its output, and the file it had changed.
    fireEvent.click(screen.getByText("1 step · worked for 3m 10s"));
    fireEvent.click(screen.getByTestId("agent-step"));
    expect(screen.getByTestId("agent-step-output").textContent).toContain("main.4df65ef.js");
    const flow = screen.getByTestId("agent-flow");
    expect(flow.textContent).toContain("App.js");
  });

  it("says the user ended it when no backstop fired", () => {
    // The absence of a notice is how the Stop button is told apart from a bound
    // firing, and the two need different sentences.
    const steps = [{ id: "c1", name: "Run Command", detail: "npm test", status: "done" as const }];
    const { rerender } = render(
      <AiAssistantChat {...baseProps} status="running" agentSteps={steps} turnElapsedMs={30_000} />,
    );
    rerender(<AiAssistantChat {...baseProps} status="idle" agentSteps={steps} turnElapsedMs={30_000} />);

    expect(screen.getByTestId("chat-transcript").textContent).toContain("You ended this turn");
  });

  it("names the step once, and the clock once", () => {
    // Reported from use: "two thinking text and spinners". The bubble's own line
    // says "Working …" with its pulse; the row under it must not repeat that in its
    // own words — it says the thing the line cannot, which is where the run is.
    render(
      <AiAssistantChat
        {...baseProps}
        status="running"
        agentSteps={[
          { id: "c1", name: "Run Command", detail: "npm test", status: "running" },
        ]}
        turnElapsedMs={89_000}
      />,
    );

    const flow = screen.getByTestId("agent-flow");
    expect(flow.textContent).toContain("Step 1: Run Command");
    // Neither clock appears twice, and the finished wording appears not at all.
    expect((flow.textContent?.match(/Working/g) || []).length).toBe(0);
    expect(flow.textContent).not.toContain("worked for");
    expect(flow.textContent).not.toMatch(/Thinking \(/);
  });

  it("does not switch to the finished wording while the answer is still streaming", () => {
    // The same rule at the moment it is easiest to break: the answer has started, so
    // the drawer closes — but the turn has not finished, and the row must not start
    // claiming a completed duration.
    const steps = [{ id: "c1", name: "Run Command", detail: "npm test", status: "done" as const }];
    render(
      <AiAssistantChat
        {...baseProps}
        status="running"
        agentSteps={steps}
        turnElapsedMs={120_000}
        streamingAnswer="Here is what I found"
      />,
    );

    const flow = screen.getByTestId("agent-flow");
    expect(flow.textContent).not.toContain("worked for");
    expect(flow.textContent).toContain("Step 1: Run Command");
  });

  it("offers Stop inside the run's own flow row, not a footer of its own", () => {
    // One panel: the control that ends the turn belongs to the row that describes
    // it, not to a second bordered bar underneath.
    const stopped = vi.fn();
    render(
      <AiAssistantChat
        {...baseProps}
        status="running"
        onCancelPipeline={stopped}
        agentSteps={[{ id: "c1", name: "Run Command", detail: "npm test", status: "running" }]}
        turnElapsedMs={9_000}
      />,
    );

    const flow = screen.getByTestId("agent-flow");
    const stop = screen.getByTestId("agent-flow-stop");
    expect(flow.contains(stop)).toBe(true);
    fireEvent.click(stop);
    expect(stopped).toHaveBeenCalled();
  });

  it("shows the reasoning while the turn is still running, without a click", () => {
    // The live half of the report: "actively writes it in the flow like an active
    // reasoning and workflow loop". The live accordion is open by default, so
    // narration is read as it arrives rather than after the fact.
    render(
      <AiAssistantChat
        {...baseProps}
        status="running"
        agentSteps={[
          { id: "r1", kind: "reasoning", name: "Reasoning", text: "Checking the driver assignment.", status: "running" },
          { id: "c1", name: "Run Command", detail: "rg driver", status: "running" },
        ]}
        turnElapsedMs={12_000}
      />,
    );

    expect(screen.getByText(/Checking the driver assignment/)).toBeTruthy();
    expect(screen.getByText("Run Command")).toBeTruthy();
  });
});
