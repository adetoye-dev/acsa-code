// @vitest-environment jsdom
/**
 * What the setup wizard says about the model it picked.
 *
 * The pull step arrives with a model already chosen for the machine — for a
 * user who has never run a local model, that is the whole point of it. It used
 * to be headed "Select Local Model to Download" above a dropdown that was
 * already filled in, which reads as a decision the user has to make and does not
 * explain why the box is full. These tests pin the honest version.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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
  pullOllamaModel: async () => "qwen2.5-coder:7b",
  startOllamaServer: async () => true,
  markSetupComplete: () => undefined,
  openAiManagementDashboard: () => undefined,
  startCodingWithOllama: () => undefined,
}));

const { OllamaSetupWizard } = await import("./OllamaSetupWizard");

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

  it("says that a model was chosen for this machine, and that it can be changed", async () => {
    await renderPullStep();

    expect(screen.getByText(/ACSA Code picked/i)).toBeTruthy();
    expect(screen.getByText(/16 GB/)).toBeTruthy();
    expect(screen.getByText(/Pick a different one if you'd rather/i)).toBeTruthy();
  });

  it("offers the recommendation as the chosen option", async () => {
    await renderPullStep();

    const select = screen.getByLabelText(/Model to download/i) as HTMLSelectElement;
    expect(select.value).toBe("qwen2.5-coder:7b");
  });
});
