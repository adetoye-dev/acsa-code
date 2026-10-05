// @vitest-environment jsdom
/**
 * What the setup wizard says about the model it picked for this machine.
 *
 * The pull step arrives with a model already chosen for the machine — for a
 * user who has never run a local model, that is the whole point of it. Two ways
 * to get it wrong, and both were live at some point: heading it "Select Local
 * Model to Download" above a dropdown that is already filled in (reads as a
 * decision the user has to work out), and stripping it back to a bare "Model to
 * download" (throws away the finding and the reasoning that justify the pick).
 * These tests pin the version that states its conclusion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/** What the engine was asked to pull, and whether to hold the reply open. */
const pull = vi.hoisted(() => ({
  asked: [] as string[],
  hold: false,
  release: null as null | (() => void),
}));

vi.mock("../../services/openExternal", () => ({
  openExternal: async () => true,
  isOpenableUrl: () => true,
}));

vi.mock("../../services/aiModelManager", () => ({
  setDefaultProvider: () => ({}),
  syncOllamaModels: () => ({}),
}));

vi.mock("../../services/ollamaSetup", () => ({
  // Installed and answering, but with no models on disk yet — the exact state
  // the pull step exists for.
  checkOllamaStatus: async () => ({
    installed: true,
    running: true,
    models: [],
    modelsDetails: [],
    recommendedModel: "qwen2.5-coder:7b",
    totalRamGb: 16,
    binaryPath: "/tmp/ollama",
    error: null,
  }),
  installOllama: async () => "/tmp/ollama",
  pullOllamaModel: (model: string) => {
    pull.asked.push(model);
    if (!pull.hold) return Promise.resolve(model);
    return new Promise<string>((resolve) => {
      pull.release = () => resolve(model);
    });
  },
  startOllamaServer: async () => true,
  markSetupComplete: () => undefined,
  openAiManagementDashboard: () => undefined,
  startCodingWithOllama: () => undefined,
}));

const { OllamaSetupWizard } = await import("./OllamaSetupWizard");

beforeEach(() => {
  pull.asked = [];
  pull.hold = false;
  pull.release = null;
});

afterEach(cleanup);

async function renderPullStep() {
  render(<OllamaSetupWizard onClose={() => undefined} />);
  // The mount probe advances the wizard to "pull" when the engine is up with no
  // models downloaded.
  await waitFor(() => expect(screen.getByText(/Model to download/i)).toBeTruthy());
}

describe("the pull step", () => {
  it("does not tell the user to select a model we already selected", async () => {
    await renderPullStep();

    expect(screen.queryByText(/Select Local Model to Download/i)).toBeNull();
  });

  it("states the recommendation, the spec it came from, and what it buys", async () => {
    await renderPullStep();

    // The conclusion has to be visible, not implied by a filled-in box.
    expect(screen.getByText(/Recommended for your PC/i)).toBeTruthy();
    // And it has to show its working: the detected spec, not just a verdict.
    expect(screen.getByText(/We detected/i)).toBeTruthy();
    expect(screen.getByText(/16 GB/)).toBeTruthy();
    expect(screen.getByText(/best balance of capability and speed/i)).toBeTruthy();
    // Still a choice, not an instruction.
    expect(screen.getByText(/Prefer another\?/i)).toBeTruthy();
  });

  it("offers the recommendation as the chosen option", async () => {
    await renderPullStep();

    const select = screen.getByLabelText(/Model to download/i) as HTMLSelectElement;
    expect(select.value).toBe("qwen2.5-coder:7b");
  });
});

describe("the model field", () => {
  it("is editable, and the choice is what actually gets downloaded", async () => {
    await renderPullStep();
    const select = screen.getByLabelText(/Model to download/i) as HTMLSelectElement;

    // A dropdown that cannot be changed has no business being one.
    expect(select.disabled).toBe(false);
    fireEvent.change(select, { target: { value: "llama3.2" } });
    expect(select.value).toBe("llama3.2");

    // And the change has to reach the action, not just the box.
    const pullButton = screen.getByRole("button", { name: /Pull llama3\.2/ });
    expect(pullButton).toBeTruthy();
    pullButton.click();

    await waitFor(() => expect(pull.asked).toEqual(["llama3.2"]));
  });

  it("locks only while a download is running", async () => {
    await renderPullStep();
    const select = screen.getByLabelText(/Model to download/i) as HTMLSelectElement;
    expect(select.disabled).toBe(false);

    pull.hold = true;
    screen.getByRole("button", { name: /Pull qwen2\.5-coder:7b/ }).click();

    await waitFor(() => expect(select.disabled).toBe(true));
    pull.release?.();
  });
});
