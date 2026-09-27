/**
 * projectSetup.ts — first-run project readiness.
 *
 * A scaffolded project ships source and a manifest but no node_modules, so
 * nothing runs until dependencies are installed. Previously nothing in the UI
 * said so, and a user who had never run `npm install` had no way to find out.
 *
 * The engine answers this (`project status`), because it is the only component
 * both the dev bridge and the packaged app can reach. The exact install, dev,
 * build and test commands come back from it too, so the card does not have to
 * assume npm.
 */

import { desktopRequired, engineCall, hasIpc } from "./engineBridge";
import { runInTerminal } from "./terminalCommands";

export interface ProjectStatus {
  projectRoot: string;
  hasPackageJson: boolean;
  hasNodeModules: boolean;
  needsInstall: boolean;
  /** Lockfile-detected package manager: npm, yarn, pnpm or bun. */
  manager: string;
  installCommand: string;
  devCommand: string;
  buildCommand: string;
  testCommand: string;
  scripts: Record<string, string>;
}

export async function fetchProjectStatus(projectRoot: string): Promise<ProjectStatus | null> {
  if (!projectRoot) return null;
  try {
    if (hasIpc()) {
      return await engineCall<ProjectStatus>("project", [
        "status",
        JSON.stringify({ projectRoot }),
      ]);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run a command in the project's terminal, through the terminal itself.
 *
 * Routed through the interactive shell rather than a hidden subprocess on purpose:
 * the user watches the install or build happen, sees any error, and keeps a shell
 * afterwards to work in.
 */
export async function runInProjectTerminal(_projectRoot: string, command: string): Promise<void> {
  if (!hasIpc()) throw desktopRequired("The integrated terminal");
  // Handed to the terminal rather than typed into a session of our own: the panel
  // spawns its own shell when it mounts and `terminal_spawn` kills whatever came
  // before, so a session created here was killed moments later and the command with
  // it — the button spun, the terminal stayed empty, and both IPC calls swallowed
  // the reason. See `terminalCommands`.
  //
  // `projectRoot` is unused on purpose: the terminal already knows the project, and
  // spawning a second session to tell it so is the bug this replaces.
  runInTerminal(command);
}
