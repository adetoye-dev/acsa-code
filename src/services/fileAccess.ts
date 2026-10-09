/**
 * fileAccess.ts — read and write project files through whichever transport exists.
 *
 * The portable rule for this codebase: prefer the desktop shell, fall back to
 * the dev bridge for a plain browser. Call sites that skip it look fine under
 * `npm run dev` and silently do nothing in a packaged build — which is how the
 * asset preview, the TypeScript ambient libs and the code map's file summaries
 * all stopped working once the app was bundled.
 */

import { desktopRequired, hasIpc } from "./engineBridge";

async function invokeTauri<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** Read a text file from the project. Throws when the file cannot be read. */
export async function readTextFile(filePath: string, projectRoot: string): Promise<string> {
  if (hasIpc()) {
    return invokeTauri<string>("read_file_content", { filePath, projectRoot });
  }
  throw desktopRequired("Reading project files");
}

/**
 * Read a file the TypeScript mirror wants, which is not the editor's reader.
 *
 * `readTextFile` refuses anything over 2 MB, because loading a huge file into an
 * editor is a hazard worth refusing. A declaration file is not edited, and
 * refusing one is not neutral: `lucide-react` ships a 2.18 MB
 * `lucide-react.d.ts`, and a reader that will not hand it over turns a package
 * that resolves in every other editor into "Cannot find module".
 */
export async function readTextFileForTypes(
  filePath: string,
  projectRoot: string,
): Promise<string> {
  if (hasIpc()) {
    return invokeTauri<string>("read_file_for_types", { filePath, projectRoot });
  }
  throw desktopRequired("Reading project files");
}

/** Read any file as a `data:` URL, for previewing images, video and audio. */
export async function readFileAsDataUrl(filePath: string, projectRoot: string): Promise<string> {
  if (hasIpc()) {
    return invokeTauri<string>("read_file_base64", { filePath, projectRoot });
  }
  throw desktopRequired("Previewing files");
}

export async function writeTextFile(
  filePath: string,
  content: string,
  projectRoot: string,
): Promise<void> {
  if (hasIpc()) {
    await invokeTauri<void>("write_file_content", { filePath, content, projectRoot });
    return;
  }
  throw desktopRequired("Saving files");
}
