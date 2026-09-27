// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

/**
 * Two records describe the active model: `selected_model`, which the picker
 * writes and the agent reads, and a copy inside `ai_settings`, which the editor
 * chat reads. Nothing kept them in step, and the real database had them
 * disagreeing — `ai_settings.provider` was `ollama` on a 7B local model while the
 * selection was `deepseek` / `deepseek-flash`.
 */
const state = vi.hoisted(() => ({
  providers: {} as Record<string, unknown>,
  selected: null as { providerId: string; model: string } | null,
}));

vi.mock("../services/aiModelManager", () => ({
  loadAllProviders: () => state.providers,
  getActiveSelectedModel: () => state.selected,
}));

const { hydrateAiSettings } = await import("./usePipeline");

const OLLAMA = {
  id: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "qwen2.5-coder:7b",
  apiKey: "not-needed",
};
const DEEPSEEK = {
  id: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  selectedModel: "deepseek-flash",
  apiKey: "sk-configured",
};

/** The drifted record, copied from the real database. */
const drifted = {
  provider: "ollama",
  model: "qwen2.5-coder:7b",
  apiKey: "",
  baseUrl: "http://127.0.0.1:11434",
};

describe("hydrating the editor's AI settings", () => {
  it("follows the selection, so the chat and the agent cannot point at different models", () => {
    state.providers = { ollama: OLLAMA, deepseek: DEEPSEEK };
    state.selected = { providerId: "deepseek", model: "deepseek-flash" };

    const hydrated = hydrateAiSettings(drifted);
    expect(hydrated.provider).toBe("deepseek");
    expect(hydrated.model).toBe("deepseek-flash");
    expect(hydrated.baseUrl).toBe("https://api.deepseek.com/v1");
    // And the credential the user actually configured comes with it.
    expect(hydrated.apiKey).toBe("sk-configured");
  });

  it("keeps the stored provider while nothing has been selected yet", () => {
    state.providers = { ollama: OLLAMA, deepseek: DEEPSEEK };
    state.selected = null;
    expect(hydrateAiSettings(drifted).provider).toBe("ollama");
  });

  it("leaves settings alone for a provider the registry does not know", () => {
    state.providers = { ollama: OLLAMA };
    state.selected = { providerId: "deepseek", model: "deepseek-flash" };
    expect(hydrateAiSettings(drifted).provider).toBe("ollama");
  });
});
