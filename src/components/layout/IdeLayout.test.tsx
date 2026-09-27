// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UsePipelineReturn } from "../../hooks/usePipeline";

// jsdom has neither of these; the shell's grid and its scroll containers want them.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
Element.prototype.scrollIntoView = () => undefined;

// The shell is what is under test, so the surfaces it hosts are stubs — each has
// its own suite. Everything that talks to the machine is stubbed too.
vi.mock("../panels/BottomPanel", () => ({
  BottomPanel: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="terminal" /> : null),
}));
vi.mock("../dashboards/AiAssistantChat", () => ({ AiAssistantChat: () => <div data-testid="chat-dock" /> }));
vi.mock("../sidebar/MarketplaceSidebar", () => ({
  MarketplaceSidebar: () => <div data-testid="marketplace-page" />,
}));
vi.mock("./UpdateButton", () => ({ UpdateButton: () => null }));
vi.mock("../../services/engineBridge", () => ({
  DESKTOP_REQUIRED_MESSAGE: "the desktop app is required",
  hasIpc: () => true,
  engineCall: async () => ({}),
}));
vi.mock("../../services/projectSetup", () => ({
  fetchProjectStatus: async () => null,
  runInProjectTerminal: async () => undefined,
}));
vi.mock("../../services/themeManager", () => ({
  applyAccent: () => undefined,
  applyGlobalWorkbenchTheme: () => undefined,
  DEFAULT_ACCENT: "indigo",
}));
vi.mock("../../services/systemMetricsService", () => ({
  systemMetricsService: {
    subscribe: () => () => undefined,
    getMetrics: () => null,
    fetchMetrics: async () => null,
    isHealthy: () => false,
  },
}));
vi.mock("../../services/ollamaSetup", () => ({
  openOllamaSetupWizard: () => undefined,
  openAiManagementDashboard: () => undefined,
  checkOllamaStatus: async () => ({ running: false, models: [] }),
  syncOllamaModels: () => undefined,
  EVENT_OPEN_AI_MANAGEMENT: "acsa:open-ai-management",
  EVENT_START_CODING_WITH_OLLAMA: "acsa:start-coding-with-ollama",
}));
vi.mock("../../services/aiModelManager", () => ({
  getDefaultProvider: () => ({ id: "ollama", selectedModel: "m", apiKey: "", baseUrl: "" }),
}));
vi.mock("../../services/gitClient", () => ({
  gitFetch: async () =>
    new Response(
      JSON.stringify({ isGit: true, branch: "feature/nav", ahead: 0, behind: 0, staged: [], unstaged: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ),
}));

const { IdeLayout } = await import("./IdeLayout");

/** Only the fields the shell touches; the pipeline has its own suites. */
function pipeline(): UsePipelineReturn {
  const noop = () => undefined;
  return {
    activeProject: { name: "acsa-code", path: "/work/acsa-code" },
    projectFiles: [],
    openTabs: [],
    activeTabPath: null,
    currentDiff: "",
    setCurrentDiff: noop,
    applyPatchToTab: noop,
    touchedPaths: [],
    turnChanges: [],
    openDiff: async () => undefined,
    reviewDiff: null,
    clearReviewDiff: noop,
    isProjectModalOpen: false,
    setIsProjectModalOpen: noop,
    isSettingsModalOpen: false,
    setIsSettingsModalOpen: noop,
    aiSettings: {},
    setAiSettings: noop,
    pickFolder: async () => null,
    openFolder: async () => undefined,
    openFile: async () => undefined,
    closeTab: noop,
    selectTab: noop,
    updateTabContent: noop,
    saveFile: async () => undefined,
    createFileOrFolder: async () => undefined,
    deleteFile: async () => undefined,
    createProject: async () => undefined,
    refreshProjectFiles: async () => [],
    indexStatus: { indexed: false, totalSymbols: 0, profile: null },
    isIndexing: false,
    syncIndex: async () => undefined,
    noFileChanges: false,
    waitingForUser: "",
    prompt: "",
    setPrompt: noop,
    status: "idle",
    activityLog: [],
    runPipeline: noop,
    cancelPipeline: async () => undefined,
    clearLog: noop,
    isTauriAvailable: true,
    streamingAnswer: "",
    streamingThought: "",
    agentSteps: [],
    failureDetail: "",
    pendingApproval: null,
    pendingQuestion: null,
    respondToQuestion: async () => undefined,
    respondToApproval: async () => undefined,
  } as unknown as UsePipelineReturn;
}

afterEach(cleanup);

const renderShell = () => render(<IdeLayout {...pipeline()} />);

describe("the workbench shell", () => {
  it("paints the sidebar, the editor with its tree, and the chat — not the terminal", async () => {
    renderShell();
    expect(screen.getByTestId("workbench-nav")).toBeTruthy();
    // The explorer is part of the editor screen now, not the whole workbench:
    // its own empty state is on screen.
    expect(screen.getByText("No files in directory.")).toBeTruthy();
    expect(screen.getByTestId("chat-dock")).toBeTruthy();
    // The terminal is a tool you reach for, not half the canvas on launch.
    expect(screen.queryByTestId("terminal")).toBeNull();
    fireEvent.click(screen.getByTitle("Toggle Bottom Panel (Cmd+J / Ctrl+`)"));
    expect(await screen.findByTestId("terminal")).toBeTruthy();
  });

  it("gives the canvas to a page, and puts the editor's dock back on the way home", async () => {
    renderShell();

    // Open the terminal first, so "the dock stepped aside" means something.
    fireEvent.click(screen.getByTitle("Toggle Bottom Panel (Cmd+J / Ctrl+`)"));
    await screen.findByTestId("terminal");

    // Choose Repository from the panel.
    fireEvent.mouseOver(screen.getByTestId("workbench-nav"));
    fireEvent.click(screen.getByTestId("nav-item-git"));

    // The page is up — its commit box is the anchor, since the branch also shows
    // in the titlebar — and the editor's furniture has stepped aside for it.
    expect(await screen.findByTestId("git-commit-message")).toBeTruthy();
    // The page's own header, and the way back out of it.
    expect(screen.getByLabelText("Back to the editor")).toBeTruthy();
    expect(screen.queryByTestId("terminal")).toBeNull();
    expect(screen.queryByTestId("chat-dock")).toBeNull();

    // Escape is the way back, and the dock returns with it.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("terminal")).toBeTruthy());
    expect(screen.getByTestId("chat-dock")).toBeTruthy();
  });

  it("pins the sidebar with Cmd+B, so it stops hiding", async () => {
    renderShell();
    const width = () => Number.parseInt(screen.getByTestId("workbench-nav").style.width, 10);
    expect(width()).toBeLessThan(100);

    fireEvent.keyDown(window, { key: "b", metaKey: true });
    await waitFor(() => expect(width()).toBeGreaterThan(100));

    // And the choice sticks: moving the pointer away does not close it.
    fireEvent.mouseOut(screen.getByTestId("workbench-nav"));
    expect(width()).toBeGreaterThan(100);
  });

  it("treats the file tree as part of the editor screen, not a panel", async () => {
    renderShell();
    // It is there on the editor screen, with nothing to dismiss it.
    expect(screen.getByText("No files in directory.")).toBeTruthy();
    // (The resize handle still carries a title; what is gone is a *toggle*.)
    expect(screen.queryByTitle(/Toggle File Tree/)).toBeNull();

    // A page has no terminal toggle and no tree; coming back brings the tree.
    fireEvent.mouseOver(screen.getByTestId("workbench-nav"));
    fireEvent.click(screen.getByTestId("nav-item-marketplace"));
    await waitFor(() => expect(screen.getByTestId("marketplace-page")).toBeTruthy());
    expect(screen.queryByTitle("Toggle Bottom Panel (Cmd+J / Ctrl+`)")).toBeNull();
    expect(screen.queryByText("No files in directory.")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByText("No files in directory.")).toBeTruthy());
  });
});

/**
 * The other half of the "blocked run is invisible" problem.
 *
 * The status bar now says *that* the agent is waiting. This is the control that
 * says *where* to answer, and it matters most when the chat panel is closed — the
 * case the status bar cannot cover on its own.
 */
describe("the chat toggle, while the agent is blocked on the user", () => {
  const renderBlocked = () =>
    render(<IdeLayout {...{ ...pipeline(), waitingForUser: "waitingOnApproval" }} />);

  it("is quiet while the panel that holds the card is open", () => {
    // The panel defaults open, so the card is on screen and a second signal would
    // be noise.
    renderBlocked();
    expect(screen.queryByTestId("chat-needs-you")).toBeNull();
  });

  it("marks the toggle once the panel is closed, and names what it wants", () => {
    renderBlocked();
    fireEvent.click(screen.getByRole("button", { name: /^chat$/i }));

    expect(screen.getByTestId("chat-needs-you")).toBeTruthy();
    // The accessible name carries the state, not only the colour.
    const toggle = screen.getByRole("button", { name: /waiting for your approval/i });
    expect(toggle).toBeTruthy();
  });

  it("stays quiet when nothing is waiting, even with the panel closed", () => {
    render(<IdeLayout {...pipeline()} />);
    fireEvent.click(screen.getByRole("button", { name: /^chat$/i }));
    expect(screen.queryByTestId("chat-needs-you")).toBeNull();
  });
});
