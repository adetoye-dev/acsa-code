/**
 * appStore.ts — the workbench's own state, backed by the app database.

 * Everything here used to live in browser `localStorage`: the provider registry
 * with API keys in it, chat history, recent projects, the active-project pointer
 * and assorted flags. That state is per-browser, invisible to the engine, and —
 * for credentials — exactly the wrong place. It now lives in one SQLite database
 * owned by `core-engine/app_db.py`, reached through the bridge.

 * Credentials are write-only across this boundary: you can set or clear a key
 * and ask whether one is configured, but the value never comes back to the page.
 */

import { desktopRequired, engineCall, hasIpc } from "./engineBridge";

export interface StoredProvider {
  baseUrl: string;
  selectedModel: string;
  availableModels: string[];
  hasApiKey: boolean;
}

export interface StoredProject {
  path: string;
  name: string;
  last_opened_at: number;
  is_active: number;
  /**
   * The database's answer to "is this folder still there?". A remembered project
   * outlives its folder, and the switcher only shows three, so dead rows have to
   * be distinguishable from live ones. See services/recentProjects.ts.
   */
  missing?: boolean;
}

export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  provider?: string | null;
  model?: string | null;
  error?: boolean;
  timestamp: number;
}

export interface UsageSummary {
  total_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  total_latency_ms: number;
  by_model: Array<{
    provider: string;
    model: string;
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number;
    latency_ms: number;
  }>;
  daily: Array<{
    date: string;
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number;
  }>;
  recent: Array<{
    ts: number;
    provider: string;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    latency_ms: number;
    cost_usd: number;
    project_path: string | null;
  }>;
}

/**
 * The dev bridge exposes this store as REST; a packaged build has no server, so
 * the same calls go to the engine over IPC. Each entry maps one onto the other —
 * this table is the entire difference between the two transports, because every
 * method below funnels through `request()`.
 */
type EngineRoute = {
  command: string;
  /**
   * Set when the route must not go through the engine at all.
   *
   * Credentials are the case: the OS keychain is the shell's to reach, and the
   * point of moving them there is that the engine never holds them. The route's
   * `payload` is passed to the Tauri command verbatim, so the two spellings have to
   * agree — the command's parameter names are the payload's keys.
   */
  tauri?: string;
  payload?: (ctx: {
    body: any;
    query: URLSearchParams;
    headers: Record<string, string>;
  }) => Record<string, unknown>;
};

const ENGINE_ROUTES: Record<string, EngineRoute> = {
  "GET /api/app/settings": { command: "settings.get" },
  "POST /api/app/settings": {
    command: "settings.set",
    payload: ({ body }) => ({ key: body.key, value: body.value }),
  },
  "GET /api/app/providers": { command: "providers.get" },
  "POST /api/app/providers": {
    command: "providers.upsert",
    payload: ({ body }) => ({
      id: body.id,
      baseUrl: body.baseUrl,
      selectedModel: body.selectedModel,
      availableModels: body.availableModels,
    }),
  },
  // Credentials do not go through the engine any more. They are the OS keychain's,
  // reached from the shell, so these three are the only routes with a `tauri`
  // target — and the only ones whose value never reaches the engine's own storage.
  "GET /api/app/secrets": { command: "secrets.list", tauri: "secrets_list" },
  "POST /api/app/secrets": {
    command: "secrets.set",
    tauri: "secrets_set",
    payload: ({ body }) => ({ name: body.name, value: body.value ?? "" }),
  },
  "DELETE /api/app/secrets": {
    command: "secrets.delete",
    tauri: "secrets_delete",
    payload: ({ query }) => ({ name: query.get("name") }),
  },
  "GET /api/app/projects": {
    command: "projects.list",
    payload: ({ query }) => ({ limit: Number(query.get("limit")) || 10 }),
  },
  "POST /api/app/projects": {
    command: "projects.touch",
    payload: ({ body }) => ({ path: body.path, name: body.name }),
  },
  "POST /api/app/projects/forget": {
    command: "projects.forget",
    payload: ({ body }) => ({ path: body.path }),
  },
  "GET /api/app/projects/active": { command: "projects.active" },
  "GET /api/app/chat": {
    command: "chat.load",
    payload: ({ query }) => ({ projectPath: query.get("projectRoot") || "" }),
  },
  "POST /api/app/chat": {
    command: "chat.save",
    payload: ({ body }) => ({ projectPath: body.projectRoot, messages: body.messages }),
  },
  "POST /api/app/chat/clear": {
    command: "chat.clear",
    payload: ({ body }) => ({ projectPath: body.projectRoot }),
  },
  "GET /api/app/usage": {
    command: "usage.summary",
    payload: ({ query }) => ({
      projectPath: query.get("projectRoot") || undefined,
      sinceTs: Number(query.get("sinceTs")) || 0,
    }),
  },
};

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || "GET").toUpperCase();
  const [rawPath, search] = path.split("?");
  const query = new URLSearchParams(search || "");

  // IPC whenever it exists — the packaged app and `tauri dev` both take this
  // path, so the transport that ships is the one under test.
  if (hasIpc()) {
    const route = ENGINE_ROUTES[`${method} ${rawPath}`];
    if (!route) throw new Error(`no engine route for ${method} ${rawPath}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const payload = route.payload
      ? route.payload({ body, query, headers: normalizeHeaders(init?.headers) })
      : {};
    // A route with a Tauri target never reaches the engine. That is the whole
    // point for credentials: the engine has no keychain and must not be the store.
    if (route.tauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<T>(route.tauri, payload);
    }
    return engineCall<T>("db", [route.command, JSON.stringify(payload)]);
  }

  // No desktop shell: the database lives behind the engine and there is no other
  // route to it. Nothing here pretends to work in a browser.
  throw desktopRequired("App settings and history");
}

export const appStore = {
  /** True only inside the desktop shell, where the engine is reachable. */
  available: hasIpc(),

  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings: () => request<Record<string, unknown>>("/api/app/settings"),
  setSetting: (key: string, value: unknown) =>
    request<{ ok: true }>("/api/app/settings", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    }),

  // ── Providers (never includes credentials) ────────────────────────────────
  getProviders: () => request<Record<string, StoredProvider>>("/api/app/providers"),
  upsertProvider: (provider: {
    id: string;
    baseUrl?: string;
    selectedModel?: string;
    availableModels?: string[];
  }) => request<{ ok: true }>("/api/app/providers", { method: "POST", body: JSON.stringify(provider) }),

  // ── Credentials (write-only) ──────────────────────────────────────────────
  listSecretNames: () => request<string[]>("/api/app/secrets"),
  /**
   * `stored` says which store took it, and that is not a detail: `keychain` means
   * the OS is holding it encrypted, `file` means the keychain was not usable here
   * and it went to the `0600` database as it always did. Callers may ignore it;
   * nothing pretends the second case is the first.
   */
  setSecret: (name: string, value: string) =>
    request<{ stored: "keychain" | "file" | "removed"; reason?: string }>("/api/app/secrets", {
      method: "POST",
      body: JSON.stringify({ name, value }),
    }),
  /** Resolves to nothing: the command has no payload worth reporting. */
  clearSecret: (name: string) =>
    request<void>(`/api/app/secrets?name=${encodeURIComponent(name)}`, { method: "DELETE" }),

  // ── Projects ──────────────────────────────────────────────────────────────
  listProjects: (limit = 10) => request<StoredProject[]>(`/api/app/projects?limit=${limit}`),
  touchProject: (path: string, name: string) =>
    request<{ ok: true }>("/api/app/projects", { method: "POST", body: JSON.stringify({ path, name }) }),
  forgetProject: (path: string) =>
    request<{ ok: true }>("/api/app/projects/forget", { method: "POST", body: JSON.stringify({ path }) }),
  getActiveProject: () =>
    request<{ path: string; name: string } | null>("/api/app/projects/active"),

  // ── Chat history ──────────────────────────────────────────────────────────
  loadChat: (projectRoot: string) =>
    request<StoredMessage[]>(`/api/app/chat?projectRoot=${encodeURIComponent(projectRoot)}`),
  saveChat: (projectRoot: string, messages: StoredMessage[]) =>
    request<{ ok: true }>("/api/app/chat", {
      method: "POST",
      body: JSON.stringify({ projectRoot, messages }),
    }),
  clearChat: (projectRoot: string) =>
    request<{ ok: true }>("/api/app/chat/clear", {
      method: "POST",
      body: JSON.stringify({ projectRoot }),
    }),

  // ── Usage ─────────────────────────────────────────────────────────────────
  usageSummary: (projectRoot?: string) =>
    request<UsageSummary>(
      `/api/app/usage${projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ""}`
    ),

  // Accounts and sessions used to live here: register, login, logout, me, and a
  // session token in sessionStorage. Nothing ever called any of them — there is
  // no sign-in screen — so the engine commands and tables are gone too rather
  // than shipping a feature the app does not have. A local-first workbench has
  // no server to authenticate against; multi-device sync is where this belongs,
  // and it is in git history if that lands.
};

export default appStore;
