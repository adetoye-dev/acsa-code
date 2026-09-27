// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ ipc: true, invoked: [] as Array<{ command: string; args: unknown }> }));

vi.mock("./engineBridge", () => ({ hasIpc: () => bridge.ipc }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    bridge.invoked.push({ command, args });
    return undefined;
  },
}));

const { isOpenableUrl, openExternal } = await import("./openExternal");

afterEach(() => {
  bridge.ipc = true;
  bridge.invoked = [];
  vi.restoreAllMocks();
});

describe("opening a link", () => {
  it("refuses anything that is not http(s)", () => {
    // The page's string goes to the OS opener; the check is the guard.
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "-R /Applications", "", "  ", "https://a b.com"]) {
      expect(isOpenableUrl(bad)).toBe(false);
    }
    expect(isOpenableUrl("https://github.com/modelcontextprotocol/servers")).toBe(true);
  });

  it("goes through the shell command in the desktop app", async () => {
    expect(await openExternal("https://example.com/docs")).toBe(true);
    expect(bridge.invoked).toEqual([
      { command: "open_external", args: { url: "https://example.com/docs" } },
    ]);
  });

  it("falls back to a tab in the preview, and never opens a bad url", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    bridge.ipc = false;

    expect(await openExternal("https://example.com")).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);

    expect(await openExternal("file:///etc/passwd")).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(bridge.invoked).toEqual([]);
  });
});
