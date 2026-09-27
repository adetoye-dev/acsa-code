import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The provider registry hydrates from the database, so the store is mocked with
 * one shape of rows per test. Everything else in the module is the real thing —
 * these tests are aimed at the reconciliation the picker depends on.
 */
const rows: Record<string, any> = {};
const settings: Record<string, any> = {};
const upserts: Array<{ id: string; availableModels?: string[] }> = [];

vi.mock("./appStore", () => ({
  appStore: {
    getProviders: async () => rows,
    getSettings: async () => settings,
    setSetting: async () => undefined,
    upsertProvider: async (row: any) => {
      upserts.push({ id: row.id, availableModels: row.availableModels });
      rows[row.id] = { ...(rows[row.id] ?? {}), ...row };
    },
    setSecret: async () => undefined,
    clearSecret: async () => undefined,
  },
}));

const models = await import("./aiModelManager");

function reset() {
  for (const key of Object.keys(rows)) delete rows[key];
  for (const key of Object.keys(settings)) delete settings[key];
  upserts.length = 0;
  rows.ollama = {
    baseUrl: "http://127.0.0.1:11434",
    selectedModel: "qwen2.5-coder:7b",
    availableModels: ["qwen2.5-coder:7b"],
    hasApiKey: false,
  };
  rows.deepseek = {
    baseUrl: "https://api.deepseek.com",
    selectedModel: "deepseek-flash",
    availableModels: ["deepseek-flash"],
    hasApiKey: true,
  };
}

describe("the model list the picker shows", () => {
  beforeEach(async () => {
    reset();
    await models.hydrateProviders();
  });

  it("puts cloud first and local after", () => {
    // The registry lists `ollama` first, so without an explicit order the menu
    // opens on a row of small on-disk models and buries the hosted ones.
    const list = models.getConfiguredModelsList(true);
    const categories = list.map((m) => m.category);
    expect(categories).toContain("local");
    expect(categories).toContain("cloud");
    expect(categories.indexOf("cloud")).toBeLessThan(categories.lastIndexOf("local"));
  });

  it("hides local models when only cloud is asked for", () => {
    const list = models.getConfiguredModelsList(false);
    expect(list.every((m) => m.category === "cloud")).toBe(true);
  });

  it("prefers a cloud model when nothing has been chosen yet", () => {
    // `ollama` carries `isDefault: true` in the seed, so a user who had
    // configured a cloud key would otherwise start running their agent on
    // whatever happened to be on disk.
    const item = models.resolveInitialSelectedModel();
    expect(item?.category).toBe("cloud");
  });

  it("drops a local model that is no longer installed", () => {
    // The reported bug: models deleted outside the app stayed in the picker for
    // ever, because the registry only ever grew.
    expect(
      models.getConfiguredModelsList(true).filter((m) => m.category === "local"),
    ).toHaveLength(1);

    models.syncOllamaModels(["qwen3.5:9b", "deepseek-coder:6.7b"]);

    const local = models.getConfiguredModelsList(true).filter((m) => m.category === "local");
    expect(local.map((m) => m.model).sort()).toEqual(["deepseek-coder:6.7b", "qwen3.5:9b"]);
    expect(local.some((m) => m.model === "qwen2.5-coder:7b")).toBe(false);
  });

  it("writes the reconciled list through to the store, not just memory", () => {
    // The first version mutated the clone `loadAllProviders` returns and wrote
    // localStorage, so the next read put the deleted models back.
    models.syncOllamaModels(["qwen3.5:9b"]);
    expect(upserts.some((u) => u.id === "ollama" && u.availableModels?.length === 1)).toBe(true);
  });

  it("drops a saved selection that names a model which is gone", () => {
    // The agent resolves its model from this setting, so a deleted model would
    // otherwise be handed straight to the runtime.
    settings.selected_model = { providerId: "ollama", model: "qwen2.5-coder:7b" };
    models.saveActiveSelectedModel("ollama" as any, "qwen2.5-coder:7b");
    expect(models.getActiveSelectedModel()).toEqual({
      providerId: "ollama",
      model: "qwen2.5-coder:7b",
    });

    models.syncOllamaModels(["qwen3.5:9b"]);
    expect(models.getActiveSelectedModel()).toBeNull();
  });
});

/**
 * What "Test Connection" does to the model list.
 *
 * It replaces the registry's curated entries with the best of whatever the
 * provider reports, capped at twelve. That is the intent — a provider's catalog
 * is 80-odd models and nobody wants all of them — but it silently dropped the
 * models the registry curates *deliberately*, which is how NVIDIA NIM's list lost
 * `deepseek-ai/deepseek-v4.1-flash`: the scorer ranks by size and version words,
 * and an older 70B model outscores a current cheap "flash" tier.
 */
describe("curating a provider's fetched catalog", () => {
  /** NIM's own catalog, exactly as the provider reports it (82 ids). */
  const NVIDIA_CATALOG = [
    "01-ai/yi-large",
    "adept/fuyu-8b",
    "ai21labs/jamba-1.5-large-instruct",
    "aisingapore/sea-lion-7b-instruct",
    "bigcode/starcoder2-15b",
    "deepseek-ai/deepseek-coder-6.7b-instruct",
    "deepseek-ai/deepseek-v4.1-flash",
    "google/codegemma-7b",
    "google/codegemma-1.1-7b",
    "ibm-granite/granite-8b-code-instruct",
    "ibm-granite/granite-34b-code-instruct",
    "meta/codellama-70b",
    "mistralai/codestral-22b-instruct-v0.1",
    "mistralai/mistral-nemo-minitron-8b-8k-instruct",
    "moonshotai/kimi-k3",
    "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    "openai/gpt-oss-20b",
    "z-ai/glm-5.3",
  ];

  it("keeps the entries the registry curates on purpose", () => {
    const curated = models.INITIAL_PROVIDERS.nvidia.availableModels;
    expect(curated.length).toBeGreaterThan(0);
    const fetched = models.curateProviderModels("nvidia", NVIDIA_CATALOG);
    for (const id of curated) {
      expect(fetched, `${id} was dropped by a fetch`).toContain(id);
    }
  });

  it("still does not hand over the whole catalog", () => {
    const fetched = models.curateProviderModels("nvidia", NVIDIA_CATALOG);
    expect(fetched.length).toBeLessThan(NVIDIA_CATALOG.length);
    expect(fetched.length).toBeLessThanOrEqual(16);
  });

  it("keeps an owner prefix, which is part of the id", () => {
    // `deepseek-v4.1-flash` is not a model NIM has; `deepseek-ai/deepseek-v4.1-flash` is.
    expect(models.isCodingChatModel("deepseek-ai/deepseek-v4.1-flash")).toBe(true);
    expect(models.curateProviderModels("nvidia", NVIDIA_CATALOG)).toContain(
      "deepseek-ai/deepseek-v4.1-flash",
    );
  });

  it("leaves a local engine's list exactly as the engine reported it", () => {
    // A local engine reports what is *installed*, which is the user's set, not a
    // catalog to curate. The coding-model filter would hide a model they
    // deliberately pulled — an embedding or vision one — and the twelve cap would
    // truncate an install that has more than twelve.
    const installed = [
      "qwen2.5-coder:7b",
      "qwen3.5:9b",
      "deepseek-coder:6.7b",
      "nomic-embed-text:latest",
      "llava:13b",
      "codellama:7b",
      "gemma2:9b",
      "llama3.2:3b",
      "llama3.2:1b",
      "phi4:14b",
      "mistral:7b",
      "starcoder2:7b",
      "solar:10.7b",
    ];
    expect(models.curateProviderModels("ollama", installed)).toEqual(installed);
  });
});
