/**
 * aiModelManager.ts — Multi-Model AI Management & Configuration Service
 *
 * Provides:
 * 1. Multi-provider configuration management (persisted in localStorage).
 * 2. Local-first defaults (Deterministic AST / Ollama).
 * 3. Default model selection and switching.
 * 4. Model inventory for inline prompt model picker.
 */

import type { AIProviderConfig, AIProviderId } from "../types/workbench";
import { appStore, type StoredProvider } from "./appStore";

const STORAGE_KEY = "acsa_code_ai_providers_v4";
const DEFAULT_PROVIDER_KEY = "acsa_code_default_provider_v4";
const PREV_STORAGE_KEY_V3 = "acsa_code_ai_providers_v3";
const LEGACY_STORAGE_KEY = "autonomous_ide_ai_providers_v2";

export const INITIAL_PROVIDERS: Record<AIProviderId, AIProviderConfig> = {
  ollama: {
    id: "ollama",
    name: "Ollama (Local)",
    category: "local",
    isConnected: true,
    isDefault: true,
    apiKey: "",
    baseUrl: "http://127.0.0.1:11434",
    selectedModel: "qwen2.5-coder:7b",
    availableModels: ["qwen2.5-coder:7b"],
    speedBadge: "Fast",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    category: "cloud",
    isConnected: false,
    isDefault: false,
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    selectedModel: "gpt-5.3-codex",
    // The starting list, for a provider whose key has just been entered and no
    // fetch has run yet. It used to be `gpt-4o / o3 / o1 / o1-pro` — generation-old
    // names that made a fresh install look stale before its first fetch, which is
    // exactly when a user judges the app. These are the coding models the live
    // `/v1/models` returns and `curateProviderModels` ranks to the top of it; the
    // fetch replaces this list with whatever is current, so it only has to be
    // honest, not exhaustive.
    availableModels: [
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex",
      "gpt-5-pro",
      "o4-mini",
    ],
    speedBadge: "Fast",
  },
  groq: {
    id: "groq",
    name: "Groq",
    category: "cloud",
    isConnected: false,
    isDefault: false,
    apiKey: "",
    baseUrl: "https://api.groq.com/openai/v1",
    selectedModel: "deepseek-r1-distill-llama-70b",
    availableModels: ["deepseek-r1-distill-llama-70b", "llama-3.3-70b-versatile"],
    speedBadge: "Fast",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    category: "cloud",
    isConnected: false,
    isDefault: false,
    apiKey: "",
    baseUrl: "https://api.deepseek.com/v1",
    // Flash-first: the cheap/fast tier is the default for everyday work and for
    // editor AI; the frontier tier stays available in the picker.
    selectedModel: "deepseek-flash",
    availableModels: ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    speedBadge: "Thinking",
  },
  xai: {
    id: "xai",
    name: "xAI",
    category: "cloud",
    isConnected: false,
    isDefault: false,
    apiKey: "",
    baseUrl: "https://api.x.ai/v1",
    selectedModel: "grok-2-latest",
    availableModels: ["grok-2-latest", "grok-2-vision-1212", "grok-beta"],
    speedBadge: "Fast",
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    category: "cloud",
    isConnected: false,
    isDefault: false,
    apiKey: "",
    // `integrate.api.nvidia.com` is the public NIM endpoint that the free tier
    // uses. It is OpenAI-compatible *chat completions* and nothing else: measured
    // with a probe, `POST /v1/responses` answers `404 page not found` while
    // `/chat/completions` answers 403 without a key (present, needs auth), and
    // `GET /v1/models` is open and lists 82 models. So NIM cannot front the agent
    // runtime directly — the runtime only speaks Responses — and it is reached
    // through the tool adapter like every other chat-completions provider. See
    // `needsToolAdapter` in `agentApproval.ts`.
    baseUrl: "https://integrate.api.nvidia.com/v1",
    selectedModel: "deepseek-ai/deepseek-v4.1-flash",
    // A short, coding-first list rather than all 82. Every id here was read back
    // from the live `/v1/models` catalog, because a model this app offers has to
    // be one the provider actually serves — an advertised-but-absent model is the
    // failure mode this whole provider path keeps getting bitten by.
    availableModels: [
      "deepseek-ai/deepseek-v4.1-flash",
      "z-ai/glm-5.3",
      "moonshotai/kimi-k3",
      "mistralai/codestral-22b-instruct-v0.1",
      "openai/gpt-oss-20b",
    ],
    speedBadge: "Fast",
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot AI",
    category: "cloud",
    isConnected: false,
    isDefault: false,
    apiKey: "",
    baseUrl: "https://api.moonshot.cn/v1",
    selectedModel: "moonshot-v1-128k",
    availableModels: ["moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"],
    speedBadge: "Medium",
  },
  cohere: {
    id: "cohere",
    name: "Cohere",
    category: "cloud",
    isConnected: false,
    isDefault: false,
    apiKey: "",
    baseUrl: "https://api.cohere.ai/v1",
    selectedModel: "command-r-plus",
    availableModels: ["command-r-plus", "command-r", "c4ai-aya-expanse-32b"],
    speedBadge: "Medium",
  },
  together: {
    id: "together",
    name: "Together AI",
    category: "cloud",
    isConnected: false,
    isDefault: false,
    apiKey: "",
    baseUrl: "https://api.together.xyz/v1",
    selectedModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    availableModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen2.5-Coder-32B-Instruct"],
    speedBadge: "Fast",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    category: "cloud",
    isConnected: false,
    isDefault: false,
    apiKey: "",
    baseUrl: "https://openrouter.ai/api/v1",
    selectedModel: "anthropic/claude-3.7-sonnet",
    availableModels: ["anthropic/claude-3.7-sonnet", "anthropic/claude-3.5-sonnet", "openai/gpt-4o", "google/gemini-2.0-flash-001", "deepseek/deepseek-r1"],
    speedBadge: "Medium",
  },
};

export const NON_CODE_OR_UTILITY_TERMS = [
  "embed",
  "whisper",
  "transcribe",
  "tts",
  "audio",
  "voice",
  "dall-e",
  "moderation",
  "realtime",
  "guard",
  "sora",
  "video",
  "babbage",
  "davinci",
  "ft:",
  "flux",
  "midjourney",
];

export function isCodingChatModel(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  const l = id.toLowerCase().trim();

  // 1. Block non-code utilities, speech, media generation, embeddings, and moderation guards
  if (NON_CODE_OR_UTILITY_TERMS.some((term) => l.includes(term))) return false;

  // 2. Block obsolete / retired legacy models
  if (l.startsWith("gpt-3.5")) return false;
  if (l === "gpt-4" || l.startsWith("gpt-4-0") || l === "gpt-4-32k") return false;
  if (l.startsWith("gpt-4.1")) return false;
  if (l.includes("o1-mini") || l.includes("o3-mini")) return false; // Retired / scheduled for late 2026 retirement
  if (l.startsWith("claude-2") || l.startsWith("claude-1") || l.includes("instant")) return false;
  if (l.includes("bison") || l.includes("palm") || l.includes("aqa") || l.includes("imagen")) return false;
  if (l === "mistral-tiny" || l.includes("embed")) return false;

  // 3. Block dated snapshot aliases (-YYYY-MM-DD, -YYYYMMDD, -MMDD)
  if (/-\d{4}-\d{2}-\d{2}$/.test(l) || /-\d{8}$/.test(l) || /-\d{6}$/.test(l) || /-\d{4}$/.test(l)) {
    return false;
  }

  return true;
}

/**
 * Dynamically scores a model for coding and complex tasks based on its capabilities,
 * architecture tier, and version, rather than rigid name hardcoding.
 */
export function scoreModelForCoding(_providerId: string, modelName: string): number {
  if (!modelName || typeof modelName !== "string") return 0;
  const m = modelName.toLowerCase();
  let score = 0;

  // Coding specialization (Codex, Coder, Dev, Synthesizer)
  if (m.includes("codex") || m.includes("coder") || m.includes("code") || m.includes("dev")) {
    score += 100;
  }
  // Deep reasoning architectures (o3, o1, o4, DeepSeek-R1, Reasoner, Thinking)
  if (m.includes("reason") || m.includes("thinking") || /^o\d/i.test(m) || m.includes("-r1")) {
    score += 90;
  }
  // Flagship / Frontier tiers
  if (m.includes("sonnet") || m.includes("pro") || m.includes("large") || m.includes("ultra") || m.includes("astra")) {
    score += 80;
  } else if (m.includes("plus") || m.includes("turbo") || m.includes("max")) {
    score += 70;
  } else if (m.includes("flash") || m.includes("haiku") || m.includes("mini") || m.includes("small") || m.includes("lite")) {
    score += 65;
  }

  // Version extraction: higher numerical versions automatically outrank older versions (e.g. 3.7 > 3.5 > 2.0 > 1.5)
  const vMatch = m.match(/(?:v|gpt-|claude-|gemini-)?(\d+(?:\.\d+)?)/);
  if (vMatch && vMatch[1]) {
    const v = parseFloat(vMatch[1]);
    if (!isNaN(v) && v < 20) {
      score += v * 5;
    }
  }

  // Snapshot penalization: prefer stable base names over timestamped releases
  if (/-\d{4}-\d{2}-\d{2}$/.test(m) || /-\d{8}$/.test(m) || /-\d{6}$/.test(m) || /-\d{4}$/.test(m)) {
    score -= 30;
  }

  return score;
}

/**
 * Curates models for a provider using dynamic capability and tier scoring,
 * ensuring high-performing models (including all future releases) are ranked at the top.
 */
export function curateProviderModels(providerId: string, rawModels: string[]): string[] {
  if (!Array.isArray(rawModels)) return [];
  const valid = Array.from(new Set(rawModels.filter(Boolean).filter(isCodingChatModel)));

  if (valid.length === 0) {
    // If strict filter removed everything, fallback to raw chat-capable models
    const fallback = rawModels
      .filter(Boolean)
      .filter((m) => !NON_CODE_OR_UTILITY_TERMS.some((term) => m.toLowerCase().includes(term)));
    return fallback.slice(0, 10);
  }

  // Score and sort models dynamically without hardcoded model lists
  const scored = valid.map((m) => ({ model: m, score: scoreModelForCoding(providerId, m) }));
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, 12).map((s) => s.model);
}

/** In-memory mirror of the registry so `loadAllProviders()` can stay synchronous. */
let providerCache: Record<AIProviderId, AIProviderConfig> | null = null;

/** Selected chat model, mirrored for synchronous reads. */
let selectedModelCache: StoredSelectedModel | null | undefined;

function cloneInitialProviders(): Record<AIProviderId, AIProviderConfig> {
  return Object.fromEntries(
    Object.entries(INITIAL_PROVIDERS).map(([id, provider]) => [
      id,
      { ...provider, availableModels: [...provider.availableModels] },
    ])
  ) as Record<AIProviderId, AIProviderConfig>;
}

/**
 * The provider registry, for synchronous callers.
 *
 * Returns the cache hydrated by `hydrateProviders()`; before that completes it
 * returns the built-in defaults, so an early render shows sensible values rather
 * than nothing.
 */
export function loadAllProviders(): Record<AIProviderId, AIProviderConfig> {
  const base = providerCache ?? cloneInitialProviders();
  const clone = Object.fromEntries(
    Object.entries(base).map(([id, provider]) => [
      id,
      { ...provider, availableModels: [...provider.availableModels] },
    ])
  ) as Record<AIProviderId, AIProviderConfig>;
  delete (clone as any).deterministic;
  return clone;
}

/**
 * Load the registry from the app database into the cache. Call once at startup.
 *
 * This is also the one-time migration off `localStorage`. Older builds kept the
 * whole registry — cloud API keys included — in the browser; that blob is read
 * here, written into the database (configuration as provider rows, credentials
 * as secrets) and then deleted. Until it is deleted the key is still sitting in
 * the browser, so the removal is the point of the exercise, not a tidy-up.
 */
let hydration: Promise<void> | null = null;

/**
 * Await the registry being hydrated, running it at most once.
 *
 * Both the workbench and the startup model probe need a hydrated registry, and
 * calling `hydrateProviders()` directly from each raced the one-time
 * localStorage migration. Everything that needs the registry should await this.
 */
export function ensureProvidersHydrated(): Promise<void> {
  if (!hydration) hydration = hydrateProviders();
  return hydration;
}

export async function hydrateProviders(): Promise<void> {
  const merged = cloneInitialProviders();
  delete (merged as any).deterministic;

  let legacy: Record<string, any> | null = null;
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ||
      localStorage.getItem(PREV_STORAGE_KEY_V3) ||
      localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) legacy = JSON.parse(raw);
  } catch {
    legacy = null;
  }

  let stored: Record<string, StoredProvider> = {};
  let defaultId: AIProviderId = "ollama";
  let selected: StoredSelectedModel | null = null;
  try {
    stored = await appStore.getProviders();
    const settings = await appStore.getSettings();
    defaultId = (settings["default_provider"] as AIProviderId) || "ollama";
    selected = (settings["selected_model"] as StoredSelectedModel) || null;
  } catch {
    // Database unavailable (first run, or a packaged build without the bridge):
    // fall back to defaults rather than leaving the UI empty.
  }

  // The chat model selection used to live in `localStorage` too. Carry it into
  // the database on upgrade, or the user's chosen cloud model silently reverts
  // to the local default when the old key is removed below.
  if (!selected) {
    try {
      const legacySelection =
        localStorage.getItem(SELECTED_MODEL_KEY) || localStorage.getItem(DEFAULT_PROVIDER_KEY);
      if (legacySelection) {
        const parsed = JSON.parse(legacySelection);
        if (parsed?.providerId && parsed?.model) {
          selected = { providerId: parsed.providerId, model: parsed.model };
          await appStore.setSetting("selected_model", selected);
        }
      }
    } catch {
      /* storage disabled or unparseable */
    }
  }

  const nothingStoredYet = Object.keys(stored).length === 0;
  if (legacy && nothingStoredYet) {
    for (const [id, entry] of Object.entries(legacy)) {
      if (!merged[id as AIProviderId]) continue;
      try {
        await appStore.upsertProvider({
          id,
          baseUrl: entry?.baseUrl,
          selectedModel: entry?.selectedModel,
          availableModels: Array.isArray(entry?.availableModels) ? entry.availableModels : undefined,
        });
        const key = typeof entry?.apiKey === "string" ? entry.apiKey.trim() : "";
        if (key) await appStore.setSecret(`${id}_api_key`, key);
      } catch {
        // Keep migrating the rest; a partial migration beats a hard failure.
      }
    }
    try {
      stored = await appStore.getProviders();
    } catch {
      /* keep whatever we have */
    }
  }

  // Unconditional, and deliberately outside the migration branch above: once the
  // database exists, a registry left in the browser is superseded whether or not
  // we just migrated it. Leaving it behind would mean credentials still sitting
  // in localStorage, which is the whole thing this change is meant to stop.
  if (legacy) {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(PREV_STORAGE_KEY_V3);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      localStorage.removeItem(DEFAULT_PROVIDER_KEY);
      localStorage.removeItem(SELECTED_MODEL_KEY);
    } catch {
      /* storage disabled */
    }
  }

  for (const [id, config] of Object.entries(merged) as [AIProviderId, AIProviderConfig][]) {
    const row = stored[id];
    if (row) {
      if (row.baseUrl) config.baseUrl = row.baseUrl;
      if (Array.isArray(row.availableModels) && row.availableModels.length > 0) {
        config.availableModels = row.availableModels;
      }
      if (row.selectedModel) config.selectedModel = row.selectedModel;
      // Cloud credentials live in the database; the page never receives them,
      // so "connected" is reported from whether a secret is configured.
      if (config.category === "cloud") config.isConnected = Boolean(row.hasApiKey);
    }
    config.isDefault = id === defaultId;
  }

  providerCache = merged;
  selectedModelCache = selected;
  notifyModelsUpdated();
}

/** Persist registry configuration (never credentials) for one provider. */
export async function persistProviderConfig(config: AIProviderConfig): Promise<void> {
  await appStore.upsertProvider({
    id: config.id,
    baseUrl: config.baseUrl,
    selectedModel: config.selectedModel,
    availableModels: config.availableModels,
  });
}

/**
 * Store a cloud credential. An empty value is ignored — use clearProviderApiKey.
 *
 * Returns which store took it, because "stored" is not a detail: `keychain` means
 * the operating system is holding it encrypted, `file` means it went to the plain
 * `0600` database instead — and until this was returned, a build whose keychain
 * could not be reached looked identical to one whose could.
 */
export async function setProviderApiKey(
  providerId: AIProviderId,
  apiKey: string,
): Promise<{ stored: "keychain" | "file" | "removed"; reason?: string } | null> {
  const trimmed = (apiKey || "").trim();
  if (!trimmed) return null;
  const result = await appStore.setSecret(`${providerId}_api_key`, trimmed);
  if (providerCache?.[providerId]) providerCache[providerId].isConnected = true;
  notifyModelsUpdated();
  return result;
}

/** Remove a stored cloud credential. */
export async function clearProviderApiKey(providerId: AIProviderId): Promise<void> {
  await appStore.clearSecret(`${providerId}_api_key`);
  if (providerCache?.[providerId]) providerCache[providerId].isConnected = false;
  notifyModelsUpdated();
}

function notifyModelsUpdated(): void {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("acsa:models-updated"));
    }
  } catch {
    /* no window (tests) */
  }
}

export function saveProviderConfig(config: AIProviderConfig): Record<AIProviderId, AIProviderConfig> {
  const all = loadAllProviders();
  delete (all as any).deterministic;
  all[config.id] = { ...config };
  if (providerCache) providerCache[config.id] = { ...config };

  // Write through to the database. Configuration becomes a provider row; a
  // credential becomes a secret and is never part of the registry payload.
  void persistProviderConfig(config).catch(() => {});
  // An empty apiKey means "unchanged" here — clearing a key is explicit, via
  // clearProviderApiKey — otherwise saving a config would silently wipe it.
  if (config.category === "cloud" && (config.apiKey || "").trim()) {
    void setProviderApiKey(config.id, config.apiKey).catch(() => {});
  }
  notifyModelsUpdated();
  return all;
}

export function setDefaultProvider(providerId: AIProviderId): Record<AIProviderId, AIProviderConfig> {
  const all = loadAllProviders();
  delete (all as any).deterministic;
  const targetId = providerId === ("deterministic" as AIProviderId) ? "ollama" : providerId;
  for (const id of Object.keys(all) as AIProviderId[]) {
    if (all[id]) {
      all[id].isDefault = id === targetId;
    }
  }
  try {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, targetId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {}
  return all;
}

export function getDefaultProvider(): AIProviderConfig {
  const all = loadAllProviders();
  const defaultId = (localStorage.getItem(DEFAULT_PROVIDER_KEY) || "ollama") as AIProviderId;
  return all[defaultId] || all.ollama;
}

export interface EditorAiConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** Where the config came from — surfaced so a local fallback is never silent. */
  source: "selected" | "configured" | "settings" | "local";
}

/**
 * Editor AI runs on every hover-free interaction (review, inline edit, explain),
 * so it defaults to the provider's cheap/fast tier when one exists — "flash",
 * "mini", "haiku", … — instead of the flagship. Falls back to the caller's
 * choice, then the first listed model.
 */
export function pickFastVariant(models: string[], fallback = ""): string {
  const list = (models || []).filter(Boolean);
  const swift = list.find((m) => /(flash|mini|small|lite|fast|haiku|turbo|instant|nano)/i.test(m));
  return swift || fallback || list[0] || "";
}

/**
 * Resolves the model that editor AI features (review, inline edit, Code Map
 * explanations) should use.
 *
 * They used to take `aiSettings`, a legacy blob persisted under different keys
 * from the provider registry, so it frequently carried provider "ollama" with
 * no key while the user's real cloud key sat in the registry — silently
 * degrading every editor AI call to a small local worker. Resolution now walks
 * the same sources the chat uses before falling back to a local model.
 */
export function resolveEditorAiConfig(
  settings?: { provider?: string; model?: string; apiKey?: string; baseUrl?: string } | null
): EditorAiConfig {
  const s = settings || {};
  const all = loadAllProviders() as Record<string, AIProviderConfig>;
  const hasUsableKey = (key?: string) => Boolean(key && key.trim().length > 3);

  // 1. The model the user explicitly picked for chat/agent work.
  const active = getActiveSelectedModel();
  if (active) {
    const cfg = all[active.providerId as string];
    if (hasUsableKey(cfg?.apiKey)) {
      return {
        provider: active.providerId,
        model: pickFastVariant(cfg.availableModels || [], active.model),
        apiKey: cfg.apiKey || "",
        baseUrl: cfg.baseUrl || "",
        source: "selected",
      };
    }
  }

  // 2. Any configured cloud provider with a usable key (default first).
  const preferred = getDefaultProvider();
  const candidates = [preferred, ...Object.values(all)];
  for (const cfg of candidates) {
    if (cfg && cfg.category === "cloud" && hasUsableKey(cfg.apiKey)) {
      return {
        provider: cfg.id,
        model: pickFastVariant(cfg.availableModels || [], cfg.selectedModel || ""),
        apiKey: cfg.apiKey || "",
        baseUrl: cfg.baseUrl || "",
        source: "configured",
      };
    }
  }

  // 3. The legacy settings blob, when it actually carries a key.
  if (hasUsableKey(s.apiKey)) {
    return {
      provider: s.provider || "ollama",
      model: s.model || "",
      apiKey: s.apiKey || "",
      baseUrl: s.baseUrl || "",
      source: "settings",
    };
  }

  // 4. Local worker — the honest fallback, and the UI says so.
  return {
    provider: "ollama",
    model: getAutoSelectedLocalWorker(),
    apiKey: "",
    baseUrl: "",
    source: "local",
  };
}

export const LOCAL_WORKER_KEY = "acsa_local_worker_model";

/**
 * Dynamically scores a local model tag for code synthesis and worker tasks.
 * Evaluates coding tokens, architecture family, version number, and parameter count.
 */
export function scoreLocalModel(modelName: string): number {
  if (!modelName || typeof modelName !== "string") return 0;
  const name = modelName.toLowerCase();
  let score = 0;

  // Coding specialization bonus
  if (name.includes("coder") || name.includes("code") || name.includes("dev") || name.includes("synthes")) {
    score += 50;
  }
  // Reasoning bonus
  if (name.includes("reason") || name.includes("deepseek-r1") || name.includes("thinking")) {
    score += 30;
  }
  // Proven local code architectures
  if (name.includes("qwen")) {
    score += 25;
  } else if (name.includes("deepseek")) {
    score += 24;
  } else if (name.includes("codestral") || name.includes("mistral")) {
    score += 22;
  } else if (name.includes("llama")) {
    score += 20;
  } else if (name.includes("starcoder")) {
    score += 18;
  }

  // Version number bonus (e.g. 3.3 > 3.1 > 2.5 > 2)
  const versionMatch = name.match(/(?:v|version)?(\d+(?:\.\d+)?)/);
  if (versionMatch && versionMatch[1]) {
    const v = parseFloat(versionMatch[1]);
    if (!isNaN(v) && v < 50) {
      score += v * 2;
    }
  }

  // Parameter size bonus (e.g. 32b > 14b > 7b > 3b)
  const sizeMatch = name.match(/(\d+)b/);
  if (sizeMatch && sizeMatch[1]) {
    const size = parseFloat(sizeMatch[1]);
    if (!isNaN(size)) {
      score += Math.min(size, 70) * 0.5;
    }
  }

  return score;
}

export function autoSelectBestLocalWorker(installedModels: string[]): string | null {
  if (!installedModels || installedModels.length === 0) return null;
  const clean = installedModels.filter(Boolean);
  if (clean.length === 0) return null;

  const scored = clean.map((m) => ({ model: m, score: scoreLocalModel(m) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.model || clean[0];
}

export function getAutoSelectedLocalWorker(): string {
  try {
    const stored = localStorage.getItem(LOCAL_WORKER_KEY);
    if (stored) return stored;
  } catch {}
  const all = loadAllProviders();
  if (all.ollama && all.ollama.availableModels && all.ollama.availableModels.length > 0) {
    const best = autoSelectBestLocalWorker(all.ollama.availableModels);
    if (best) return best;
  }
  return "qwen2.5-coder:7b";
}

export function setAutoSelectedLocalWorker(modelName: string): void {
  try {
    localStorage.setItem(LOCAL_WORKER_KEY, modelName);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("acsa:local-worker-updated", { detail: { model: modelName } })
      );
    }
  } catch {}
}

export function addCustomModelToProvider(
  providerId: AIProviderId,
  customModel: string
): Record<AIProviderId, AIProviderConfig> {
  const all = loadAllProviders();
  const trimmed = customModel.trim();
  if (!trimmed || !all[providerId]) return all;

  if (!all[providerId].availableModels.includes(trimmed)) {
    all[providerId].availableModels = [trimmed, ...all[providerId].availableModels];
  }
  all[providerId].selectedModel = trimmed;
  const updated = saveProviderConfig(all[providerId]);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("acsa:models-updated"));
  }
  return updated;
}

/**
 * Dynamically synchronizes locally installed Ollama models with the active AI configuration.
 * - Stores ONLY genuinely installed models in availableModels.
 * - Auto-selects the optimal local code worker based on capability ranking.
 * - Dispatches 'acsa:models-updated' event to notify UI components.
 */
/** Whether a model name and an installed tag refer to the same model. */
function modelMatches(installed: string, wanted: string): boolean {
  if (!installed || !wanted) return false;
  return (
    installed === wanted ||
    installed === `${wanted}:latest` ||
    wanted === `${installed}:latest` ||
    installed.startsWith(`${wanted}:`) ||
    wanted.startsWith(`${installed}:`)
  );
}

/** Forget the saved chat model. Used when the model it names no longer exists. */
export function clearActiveSelectedModel(): void {
  selectedModelCache = null;
  void appStore.setSetting("selected_model", null).catch(() => {});
  notifyModelsUpdated();
}

/**
 * Reconcile the Ollama provider with what is actually installed.
 *
 * The list is the daemon's, not ours: models get deleted outside the app, and a
 * registry that only ever grew showed them forever — which is exactly what was
 * reported. Everything else here follows from the new list: `selectedModel`
 * cannot name something that is gone, and a *saved* chat selection pointing at a
 * deleted model is cleared, because the agent resolves its model from that and
 * would otherwise hand a missing model to the runtime.
 *
 * Written through `saveProviderConfig`, which updates the in-memory registry and
 * the provider row. The previous version mutated the clone `loadAllProviders`
 * returns and wrote localStorage, so the next read put the deleted models back.
 */
export function syncOllamaModels(
  installedModels: string[],
  activeModel?: string
): Record<AIProviderId, AIProviderConfig> {
  const all = loadAllProviders();
  if (!all.ollama) return all;

  const cleanInstalled = Array.from(new Set(installedModels.filter(Boolean)));
  const current = all.ollama.selectedModel || "";
  const bestWorker = autoSelectBestLocalWorker(cleanInstalled);

  let selectedModel = current;
  if (activeModel && cleanInstalled.some((m) => modelMatches(m, activeModel))) {
    selectedModel = activeModel;
  } else if (cleanInstalled.some((m) => modelMatches(m, current))) {
    selectedModel = current;
  } else if (bestWorker) {
    selectedModel = bestWorker;
  } else if (cleanInstalled.length > 0) {
    selectedModel = cleanInstalled[0];
  }

  if (bestWorker) setAutoSelectedLocalWorker(bestWorker);

  const saved = getActiveSelectedModel();
  if (
    saved &&
    saved.providerId === "ollama" &&
    !cleanInstalled.some((m) => modelMatches(m, saved.model))
  ) {
    clearActiveSelectedModel();
  }

  return saveProviderConfig({
    ...all.ollama,
    availableModels: cleanInstalled,
    isConnected: cleanInstalled.length > 0,
    selectedModel,
  });
}

export interface ConfiguredModelItem {
  providerId: AIProviderId;
  providerName: string;
  model: string;
  speedBadge: "Fast" | "Medium" | "Thinking" | "Offline";
  isDefault: boolean;
  category: "local" | "cloud";
}

/**
 * Every model the user can run the agent on — cloud, plus local when asked.
 *
 * Local models used to be hidden here on the theory that they were "workers"
 * driven by a background orchestrator. That orchestrator is gone, and on its own
 * a local model cannot run tools at all: Ollama's Responses API drops tool
 * definitions, so the run would read and reply and never act. That is fixed by
 * `core-engine/responses_adapter.py`, which is why they belong in this list.
 */
export function getConfiguredModelsList(includeLocal: boolean = true): ConfiguredModelItem[] {
  const all = loadAllProviders();
  const list: ConfiguredModelItem[] = [];

  for (const p of Object.values(all)) {
    // Exclude deterministic AST engine: it is a code-gate compiler, not an LLM chat model
    if ((p.id as string) === "deterministic") continue;

    if (p.category === "cloud") {
      // "Has a key" is `isConnected`, which the registry derives server-side from
      // whether a key exists. It is NOT `apiKey`: credentials are write-only across
      // the API, so that field is always empty by design and gating on it hid every
      // configured cloud model — which is why chat refused to start with "no local AI
      // model is installed or selected" while the dashboard showed DeepSeek connected.
      if (p.isConnected) {
        const rawModels = p.availableModels && p.availableModels.length > 0
          ? p.availableModels
          : [p.selectedModel];
        const cleanModels = curateProviderModels(p.id, rawModels);
        const models = cleanModels.length > 0 ? cleanModels : rawModels;
        for (const m of models) {
          if (!m) continue;
          list.push({
            providerId: p.id,
            providerName: p.name,
            model: m,
            speedBadge: p.speedBadge || "Medium",
            isDefault: p.isDefault && p.selectedModel === m,
            category: p.category,
          });
        }
      }
    } else if (includeLocal) {
      if (p.id === "ollama") {
        if (p.availableModels && p.availableModels.length > 0) {
          for (const m of p.availableModels) {
            list.push({
              providerId: p.id,
              providerName: "Ollama (on this machine)",
              model: m,
              speedBadge: p.speedBadge || "Fast",
              isDefault: p.isDefault && p.selectedModel === m,
              category: p.category,
            });
          }
        }
      }
    }
  }

  // Cloud first, then local. The registry lists `ollama` first, so without this
  // the menu opens on a row of small local models and buries the hosted ones.
  // `sort` is stable, so the order inside each group is the registry's.
  return list.sort((a, b) => (a.category === b.category ? 0 : a.category === "cloud" ? -1 : 1));
}

export const SELECTED_MODEL_KEY = "acsa_active_selected_model_v2";

export interface StoredSelectedModel {
  providerId: AIProviderId;
  model: string;
}

/**
 * Persists the user's explicitly selected model across reloads, panel opens and
 * sessions.
 *
 * A local model is allowed here. It used to be refused — "background workers must
 * never be saved as the chat model" — but the background orchestrator that
 * managed them no longer exists, and the tool adapter makes a local model a real
 * agent: it edits files and runs commands. Refusing it left the cheap path
 * unreachable from the UI.
 */
export function saveActiveSelectedModel(providerId: AIProviderId, model: string): void {
  if (!providerId || !model) return;
  const all = loadAllProviders();
  selectedModelCache = { providerId, model };
  void appStore.setSetting("selected_model", { providerId, model }).catch(() => {});
  if (all[providerId]) {
    saveProviderConfig({ ...all[providerId], selectedModel: model });
  }
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("acsa:selected-model-changed", { detail: { providerId, model } })
      );
    }
  } catch {
    /* no window */
  }
}

/**
 * Retrieves the user's previously selected model from persistent storage.
 */
export function getActiveSelectedModel(): StoredSelectedModel | null {
  const parsed = selectedModelCache ?? null;
  if (!parsed || !parsed.providerId || !parsed.model) return null;
  // A stored local model used to be erased here — and written back as `null`, so
  // the choice could not survive a relaunch. That was the other half of the guard
  // that kept local models out of the agent; see `saveActiveSelectedModel`.
  return parsed;
}

/**
 * Resolves the active model item, so a user's pick survives a page reload.
 * Local models count by default; see `getConfiguredModelsList`.
 */
export function resolveInitialSelectedModel(includeLocal: boolean = true): ConfiguredModelItem | null {
  const list = getConfiguredModelsList(includeLocal);
  const saved = getActiveSelectedModel();

  if (saved) {
    // 1. Try finding in current configured list
    const exact = list.find((m) => m.providerId === saved.providerId && m.model === saved.model);
    if (exact) return exact;

    // 2. Fallback to model name match in configured list
    const byName = list.find((m) => m.model === saved.model);
    if (byName) return byName;
  }

  // 3. Nothing chosen yet: prefer a cloud default, then any cloud model, and only
  // then a local one. Without this the local provider wins by accident — it is
  // first in the registry and carries `isDefault: true` — so a user who had
  // configured DeepSeek would silently start running their agent on a small model
  // that happens to be on disk. Local stays a deliberate choice, and the fallback
  // for a machine with nothing else, which is where it was before.
  const cloudDefault = list.find((m) => m.isDefault && m.category === "cloud");
  if (cloudDefault) return cloudDefault;
  const anyCloud = list.find((m) => m.category === "cloud");
  if (anyCloud) return anyCloud;

  // 4. No cloud model at all: a local model is the only model.
  return list.find((m) => m.isDefault) || list[0] || null;
}

/**
 * Determines whether a model supports multimodal vision/image inputs.
 * Uses semantic capability indicators and permissive frontier defaults rather than brittle whitelists.
 */
export function isModelVisionCapable(providerId: string, modelName: string): boolean {
  const p = (providerId || "").toLowerCase();
  const m = (modelName || "").toLowerCase();

  // 1. Explicit semantic vision keywords or architecture tags across any provider
  if (
    m.includes("vision") ||
    m.includes("vl-") ||
    m.includes("-vl") ||
    m.includes("_vl") ||
    m.includes("pixtral") ||
    m.includes("llava") ||
    m.includes("minicpm") ||
    m.includes("moondream") ||
    m.includes("bakllava") ||
    m.includes("cogvlm") ||
    m.includes("internvl") ||
    m.includes("omni") ||
    m.includes("4o")
  ) {
    return true;
  }

  // 2. Explicit pure-text or non-vision utility models are never vision-capable
  if (
    m.includes("embed") ||
    m.includes("whisper") ||
    m.includes("tts") ||
    m.includes("transcribe") ||
    m.includes("moderation") ||
    m.startsWith("gpt-3.5") ||
    m.startsWith("claude-2") ||
    m.startsWith("claude-1") ||
    m === "gpt-4" ||
    m.startsWith("gpt-4-0") ||
    m === "gpt-4-32k"
  ) {
    return false;
  }

  // 3. Frontier cloud providers: multimodality is standard for modern/future generative models
  if (p === "openai" || p === "openrouter") {
    return true;
  }

  // 4. Local engines (Ollama): default to false unless explicit vision weights are indicated
  if (p === "ollama") {
    return false;
  }

  // 5. Anything else is treated as text-only.
  //
  // This used to be `return true` — "default to permissive, the runtime self-heals
  // on a 400". It does not self-heal: the attach path in `usePipeline` records
  // that the provider's 400 is retried five times and then reported as a *failed
  // turn*. So a wrong "yes" costs a broken run and a wrong "no" costs a warning
  // and an unattached image, which is not a close call. Measured: this answered
  // `true` for `deepseek-flash`, whose API is text-only, and declared image input
  // for every model in the runtime catalog as a result.
  //
  // Everything genuinely multimodal is still caught above — the keywords cover
  // `-vl`, `vision`, `omni`, `4o` and the local vision weights, and the two
  // aggregator providers are handled by name.
  return false;
}

/**
 * Finds the best active vision model available among configured providers using dynamic scoring.
 */
export function findBestAvailableVisionModel(
  providers?: Record<AIProviderId, AIProviderConfig>,
  includeLocal: boolean = false
): ConfiguredModelItem | null {
  const activeProviders = providers || loadAllProviders();
  const configuredModels = getConfiguredModelsList(includeLocal);

  // Filter only vision-capable configured models
  const visionModels = configuredModels.filter((item) =>
    isModelVisionCapable(item.providerId, item.model)
  );

  if (visionModels.length === 0) {
    // If not in configured list, check active cloud providers directly
    for (const [pId, pConfig] of Object.entries(activeProviders)) {
      if (
        pConfig &&
        (includeLocal || pConfig.category === "cloud") &&
        (pConfig.isConnected || (pConfig.apiKey && pConfig.apiKey.trim().length > 4))
      ) {
        const rawModels = pConfig.availableModels && pConfig.availableModels.length > 0
          ? pConfig.availableModels
          : [pConfig.selectedModel];
        const visionModel = rawModels.find((m) => m && isModelVisionCapable(pId as AIProviderId, m));
        if (visionModel) {
          return {
            providerId: pId as AIProviderId,
            providerName: pConfig.name,
            model: visionModel,
            speedBadge: pConfig.speedBadge || "Fast",
            isDefault: pConfig.isDefault || false,
            category: pConfig.category || "cloud",
          };
        }
      }
    }
    return null;
  }

  // Score vision models dynamically: prefer fast/cost-effective models for quick vision queries
  const scored = visionModels.map((item) => {
    let score = 0;
    const m = item.model.toLowerCase();
    if (item.speedBadge === "Fast") score += 30;
    if (m.includes("flash") || m.includes("haiku") || m.includes("mini")) score += 25;
    if (item.category === "cloud") score += 20;
    if (item.providerId === "openai") score += 15;
    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.item || visionModels[0];
}
