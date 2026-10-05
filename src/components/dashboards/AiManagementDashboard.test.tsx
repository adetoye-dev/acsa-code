// @vitest-environment jsdom
/**
 * The local-model gate.
 *
 * The catalogue of downloadable models used to render whenever the Ollama *tab*
 * was open, regardless of whether the daemon was installed or answering. A user
 * on a machine without Ollama saw "Pull (4.7 GB)" cards, clicked one, and only
 * then learned there was nowhere for the download to land. These tests pin the
 * gate: downloads appear only once the daemon is running, and each not-ready
 * state offers the one action that actually moves it forward.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { AIProviderConfig, AIProviderId } from "../../types/workbench";

const state = vi.hoisted(() => ({
  installed: false,
  running: false,
  models: [] as string[],
  startCalls: 0,
}));

const providers = vi.hoisted(() => {
  const ollama: AIProviderConfig = {
    id: "ollama" as AIProviderId,
    name: "Ollama (Local)",
    category: "local",
    isConnected: true,
    isDefault: true,
    apiKey: "",
    baseUrl: "http://127.0.0.1:11434",
    selectedModel: "qwen2.5-coder:7b",
    availableModels: ["qwen2.5-coder:7b"],
  };
  const openai: AIProviderConfig = {
    id: "openai" as AIProviderId,
    name: "OpenAI",
    category: "cloud",
    isConnected: false,
    isDefault: false,
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    selectedModel: "gpt-5.3-codex",
    availableModels: ["gpt-5.3-codex"],
  };
  return { ollama, openai } as unknown as Record<AIProviderId, AIProviderConfig>;
});

vi.mock("../../services/openExternal", () => ({
  openExternal: async () => true,
  isOpenableUrl: () => true,
}));

vi.mock("../../services/aiClient", () => ({
  aiFetch: async () => {
    throw new Error("network is not part of this test");
  },
}));

vi.mock("../../services/aiModelManager", () => ({
  loadAllProviders: () => ({ ...providers }),
  saveProviderConfig: () => ({ ...providers }),
  setDefaultProvider: () => ({ ...providers }),
  addCustomModelToProvider: () => ({ ...providers }),
  saveActiveSelectedModel: () => undefined,
  setProviderApiKey: () => ({ ...providers }),
  curateProviderModels: (_id: string, models: string[]) => models,
  syncOllamaModels: (models: string[]) => ({
    ...providers,
    ollama: { ...providers.ollama, isConnected: true, availableModels: models },
  }),
}));

vi.mock("../../services/ollamaSetup", () => ({
  checkOllamaStatus: async () => ({
    installed: state.installed,
    running: state.running,
    models: state.models,
    recommendedModel: "qwen2.5-coder:7b",
    totalRamGb: 16,
  }),
  startOllamaServer: async () => {
    state.startCalls += 1;
    state.running = true;
    return true;
  },
  pullOllamaModel: async () => "qwen2.5-coder:7b",
  deleteOllamaModel: async () => undefined,
  CURATED_OLLAMA_MODELS: [
    {
      tag: "qwen2.5-coder:7b",
      name: "Qwen2.5 Coder 7B",
      size: "4.7 GB",
      recommendedRam: "16 GB RAM",
      description: "A coding model.",
      category: "Coding & Agents",
    },
  ],
  resolveModelMetadata: (name: string) => ({ name, strength: "" }),
}));

const { AiManagementDashboard } = await import("./AiManagementDashboard");

const MODEL_CATALOGUE = /Download Additional Models/i;
const RUN_WIZARD = /Run Setup Wizard/i;

async function renderDashboard() {
  render(<AiManagementDashboard />);
  // The mount effect probes the daemon asynchronously.
  await waitFor(() => expect(screen.queryByText(/Checking the local engine/i)).toBeNull());
}

beforeEach(() => {
  state.installed = false;
  state.running = false;
  state.models = [];
  state.startCalls = 0;
});

afterEach(cleanup);

describe("local model gate", () => {
  it("hides the download catalogue and routes to the wizard when Ollama is absent", async () => {
    await renderDashboard();

    expect(screen.queryByText(MODEL_CATALOGUE)).toBeNull();
    expect(screen.getByText(/Ollama is not set up on this machine yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: RUN_WIZARD })).toBeTruthy();
  });

  it("offers a start button, not downloads, when Ollama is installed but stopped", async () => {
    state.installed = true;
    state.running = false;
    await renderDashboard();

    expect(screen.queryByText(MODEL_CATALOGUE)).toBeNull();
    expect(screen.getByText(/Ollama is installed, but not running/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Start Ollama Server/i })).toBeTruthy();
  });

  it("reveals the catalogue only while the daemon is running", async () => {
    state.installed = true;
    state.running = true;
    state.models = ["qwen2.5-coder:7b"];
    await renderDashboard();

    expect(screen.getByText(MODEL_CATALOGUE)).toBeTruthy();
    expect(screen.queryByText(/Checking the local engine/i)).toBeNull();
  });

  it("swaps the gate for the catalogue once the daemon is started", async () => {
    state.installed = true;
    state.running = false;
    state.models = ["qwen2.5-coder:7b"];
    await renderDashboard();

    expect(screen.queryByText(MODEL_CATALOGUE)).toBeNull();
    screen.getByRole("button", { name: /Start Ollama Server/i }).click();

    await waitFor(() => expect(screen.getByText(MODEL_CATALOGUE)).toBeTruthy());
    expect(state.startCalls).toBe(1);
  });
});
