import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pendingTerminalCommands,
  registerTerminalSender,
  resetTerminalCommands,
  runInTerminal,
  unregisterTerminalSender,
} from "./terminalCommands";

/**
 * "Run dev server" spun and did nothing.
 *
 * The caller spawned its own shell and typed the command into it; the panel then
 * mounted, spawned its own shell, and `terminal_spawn` killed the first one — along
 * with the command. So the routing below is the fix, and these are the orderings it
 * has to survive.
 */
beforeEach(() => {
  resetTerminalCommands();
});

describe("running a command in the terminal", () => {
  it("sends it straight to a terminal that is already connected", () => {
    const send = vi.fn();
    registerTerminalSender(send);

    runInTerminal("npm run dev");

    expect(send).toHaveBeenCalledWith("npm run dev");
    expect(pendingTerminalCommands()).toEqual([]);
  });

  it("waits for one rather than losing the command", () => {
    // The empty state opens the panel *and* issues the command on the same click,
    // so at this moment there is no shell at all.
    runInTerminal("npm run dev");
    expect(pendingTerminalCommands()).toEqual(["npm run dev"]);

    const send = vi.fn();
    registerTerminalSender(send);

    expect(send).toHaveBeenCalledWith("npm run dev");
    expect(pendingTerminalCommands()).toEqual([]);
  });

  it("keeps the order the commands arrived in", () => {
    runInTerminal("npm install");
    runInTerminal("npm run dev");
    const sent: string[] = [];

    registerTerminalSender((command) => sent.push(command));

    expect(sent).toEqual(["npm install", "npm run dev"]);
  });

  it("ignores a blank command instead of pressing Enter at the prompt", () => {
    const send = vi.fn();
    registerTerminalSender(send);

    runInTerminal("   ");

    expect(send).not.toHaveBeenCalled();
    expect(pendingTerminalCommands()).toEqual([]);
  });

  it("does not let an outgoing terminal unregister its replacement", () => {
    // React mounts the new one before unmounting the old during a remount, so a
    // blind `sender = null` on unmount would throw away the live registration and
    // queue commands against a terminal that is right there.
    const outgoing = vi.fn();
    const incoming = vi.fn();
    registerTerminalSender(outgoing);
    registerTerminalSender(incoming);

    unregisterTerminalSender(outgoing);
    runInTerminal("npm test");

    expect(incoming).toHaveBeenCalledWith("npm test");
  });
});
