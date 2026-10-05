/**
 * engineBridge.ts — reach the bundled engine from a packaged build.
 *
 * In development, backend calls are served by `vite-fs-bridge.ts`, a Vite
 * dev-server middleware. `configureServer()` only runs for `npm run dev`, so none
 * of its `/api/*` endpoints exist in a packaged app — there, the only channel is
 * Tauri IPC. That difference is invisible until you run the built app, which is
 * how the provider registry, chat history, recent projects and Ollama detection
 * all silently reverted to built-in defaults in the bundle.
 *
 * `engine_call` runs the same engine the dev bridge runs, so a caller can ask for
 * an engine subcommand instead of an HTTP path and get identical data.
 */

export type EngineEnvelope<T> = { ok: boolean; data?: T; error?: string };

/**
 * True when Tauri IPC is available — which includes `tauri dev`, not just the
 * packaged app, because Tauri injects its API into whatever page it loads.
 *
 * Everything prefers this over the dev bridge, and that is deliberate: `tauri dev`
 * serves the UI from `localhost:5173`, so keying off the URL would keep quietly
 * exercising the bridge and let dev-only endpoints hide again. Preferring IPC
 * makes the normal development loop test the path that actually ships.
 */
export function hasIpc(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__)
  );
}

/** True inside the packaged app: IPC available and no dev-server URL. */
export function isPackagedBuild(): boolean {
  return (
    hasIpc() &&
    typeof window !== "undefined" &&
    !window.location.protocol.startsWith("http")
  );
}

/**
 * The app's backend is the engine, and in a browser there is no way to reach it.
 *
 * Every caller used to fall back to `fetch("/api/...")`, served by
 * `vite-fs-bridge.ts` — a Vite dev-server middleware that reimplemented the
 * whole backend in TypeScript. Two implementations meant two behaviours to keep
 * in step, and the browser one was the only one that ever got exercised during
 * UI work, so packaging consistently broke things the dev server hid. That
 * bridge is gone; this is what a browser gets instead of a silent failure.
 */
export const DESKTOP_REQUIRED_MESSAGE =
  "This needs the ACSA Code desktop app. Run `npm run dev:app` (or launch the app) — " +
  "the browser preview has no backend.";

/**
 * The same guidance without the leading sentence.
 *
 * `desktopRequired` names the feature first, so prefixing it with the whole
 * constant said "Setting up Ollama needs the desktop app. This needs the desktop
 * app." — the same sentence twice, in the one message a user sees when a
 * desktop-only action fails.
 */
const DESKTOP_REQUIRED_GUIDANCE =
  "Run `npm run dev:app` (or launch the app) — the browser preview has no backend.";

export function desktopRequired(feature: string): Error {
  return new Error(`${feature} needs the ACSA Code desktop app. ${DESKTOP_REQUIRED_GUIDANCE}`);
}

/** Same message, shaped as the JSON `Response` the client helpers return. */
export function desktopRequiredResponse(feature: string): Response {
  return new Response(
    JSON.stringify({ ok: false, success: false, error: `${feature}: ${DESKTOP_REQUIRED_MESSAGE}` }),
    { status: 501, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Run an engine subcommand over IPC and unwrap its `{ok, data}` envelope.
 *
 * Throws with the engine's own message, so a failure surfaces as a failure
 * instead of being mistaken for an empty result.
 */
export async function engineCall<T>(subcommand: string, args: string[] = []): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<string>("engine_call", { subcommand, args });

  let parsed: EngineEnvelope<T>;
  try {
    parsed = JSON.parse(raw) as EngineEnvelope<T>;
  } catch {
    throw new Error(`engine ${subcommand} returned no JSON`);
  }
  if (!parsed?.ok) throw new Error(parsed?.error || `engine ${subcommand} failed`);
  return parsed.data as T;
}
