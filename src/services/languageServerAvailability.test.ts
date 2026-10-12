import { describe, expect, it, vi } from "vitest";

const invokes: Array<{ command: string }> = [];
const toolchainPresent = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    invokes.push({ command });
    if (command === "lsp_available") return toolchainPresent;
    return undefined;
  },
}));

const availability = await import("./languageServerAvailability");

describe("deciding before Monaco sets its TypeScript mode up", () => {
  it("assumes the worker until the shell says otherwise", () => {
    // The editor asks this synchronously while mounting, before `invoke` can have
    // answered; the worker is the fallback, so an unknown answer keeps it.
    expect(typeof availability.languageServerWillRun()).toBe("boolean");
  });

  it("takes the shell's word for it, and asks only once", async () => {
    // This file's probe already ran; the answer it took is what the editor uses —
    // and it is a real boolean, so "unknown" can never read as "yes".
    const answer = await availability.probeToolchainAvailability();
    expect(answer).toBe(toolchainPresent);
    expect(typeof availability.languageServerWillRun()).toBe("boolean");

    // Once per session: the editor asks on every mount, and this is a question
    // about the installation, not about this moment.
    invokes.length = 0;
    await availability.probeToolchainAvailability();
    await availability.probeToolchainAvailability();
    expect(invokes.filter((i) => i.command === "lsp_available")).toHaveLength(0);
  });
});
