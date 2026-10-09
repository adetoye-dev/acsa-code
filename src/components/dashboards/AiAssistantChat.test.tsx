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

const SEEDED = [
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
