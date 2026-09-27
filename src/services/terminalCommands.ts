/**
 * terminalCommands.ts — running a command in the terminal the user is looking at.
 *
 * Why this exists: the terminal spawns its own shell when it mounts, and
 * `terminal_spawn` kills whatever session came before it. A caller that spawned a
 * session of its own and typed into it therefore had that session killed a moment
 * later, when the panel appeared — the command died with it. That is the reported
 * symptom exactly: the button spun, the terminal stayed empty, and nothing said
 * why, because both IPC calls in that path swallowed their errors.
 *
 * So the command is handed to the terminal instead. If one is mounted and
 * connected it runs right away; otherwise it waits here and is drained the moment a
 * session is ready — which is what makes "Run dev server" work from the empty
 * state, where the same click opens the very panel that will run it.
 */

type Sender = (command: string) => void;

let sender: Sender | null = null;
const pending: string[] = [];

/** Called by the terminal once its shell is connected. Drains anything waiting. */
export function registerTerminalSender(next: Sender): void {
  sender = next;
  while (pending.length > 0) {
    const command = pending.shift();
    if (command) sender(command);
  }
}

/**
 * Called when the terminal unmounts.
 *
 * Takes the sender it is unregistering rather than clearing whatever is there: a
 * terminal that mounts during the unmount of another would otherwise have its
 * registration thrown away by the outgoing one, and commands would queue forever
 * against a session that is present and waiting.
 */
export function unregisterTerminalSender(current: Sender): void {
  if (sender === current) sender = null;
}

/** Run a command in the terminal, now or as soon as there is one. */
export function runInTerminal(command: string): void {
  const trimmed = command.trim();
  if (!trimmed) return;
  if (sender) sender(trimmed);
  else pending.push(trimmed);
}

/** For tests and for showing what is still waiting. */
export function pendingTerminalCommands(): string[] {
  return [...pending];
}

/** For tests: forget the registered terminal and anything queued. */
export function resetTerminalCommands(): void {
  sender = null;
  pending.length = 0;
}
