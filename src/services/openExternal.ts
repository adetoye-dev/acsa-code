/**
 * openExternal — hand a link to the operating system.
 *
 * A plain anchor does nothing in a Tauri window: `target="_blank"` is a dead
 * click because the webview will not make a new window, and a same-window
 * navigation would replace the workbench with the page. Every marketplace link
 * was a plain anchor, which is exactly why they did nothing.
 *
 * The Rust side (`open_external`) is the only thing that actually opens a
 * browser, and it refuses anything that is not http(s) — this is a string from
 * the page being handed to the OS. Outside the desktop app (the Vite preview)
 * there is no IPC, so a browser tab is the fallback.
 */
import { hasIpc } from "./engineBridge";

/** Only what the command will accept, checked before the round trip. */
export function isOpenableUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  return !/[\s]/.test(trimmed);
}

export async function openExternal(url: string): Promise<boolean> {
  const target = url.trim();
  if (!isOpenableUrl(target)) return false;

  if (hasIpc()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_external", { url: target });
      return true;
    } catch (error) {
      console.warn("open_external failed; falling back to a browser tab:", error);
    }
  }

  try {
    window.open(target, "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}
