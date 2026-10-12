/**
 * aiClient.ts — the AI transport.
 *
 * Every `/api/ai/*` route the UI uses is listed here with the engine action
 * that serves it. Under the desktop shell the call goes over IPC, which is the
 * only channel a packaged build has; the dev bridge is the fallback for a plain
 * browser. `chat` is absent because it streams: it uses `chat_stream` and the
 * `ai:frame` events instead.
 */

import { desktopRequiredResponse, engineCall, hasIpc } from "./engineBridge";

/** Bridge action → engine subcommand action. Empty means "not migrated yet". */
const MIGRATED: Record<string, string> = {
  "test-connection": "test-connection",
  "review-file": "review-file",
  "inline-edit": "inline-edit",
  "complete": "complete",
  "usage": "usage",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function aiFetch(path: string, init?: RequestInit): Promise<Response> {
  const [route, query] = path.replace(/^\/api\/ai\//, "").split("?");
  const action = route;
  // No desktop shell, or a route with no engine action yet. There is no
  // second implementation to fall back to any more, so say so.
  if (!hasIpc() || !MIGRATED[action]) return desktopRequiredResponse("AI requests");

  let payload: Record<string, unknown> = {};
  // GET routes carry their arguments in the query string.
  for (const [key, value] of new URLSearchParams(query || "")) {
    payload[key] = value;
  }
  if (init?.body) {
    try {
      payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }

  try {
    return jsonResponse(await engineCall<unknown>("ai", [MIGRATED[action], JSON.stringify(payload)]));
  } catch (error) {
    const message = String((error as Error)?.message || error);
    return jsonResponse({ ok: false, success: false, latencyMs: 0, error: message }, 500);
  }
}
