/**
 * chatAttachments.ts — files a reader attached to a message.
 *
 * A file's text is folded into the prompt, the same way the editor's selection
 * already is, so every mode gets it without teaching each one about attachments.
 *
 * The budget is the honest part. A prompt has a size, and a file that does not fit
 * has to arrive as a *shorter file that says it was shortened* rather than as a
 * silent omission — a model that quietly never saw the end of a file answers as
 * though it did.
 */
import { readTextFile } from "./fileAccess";

export interface AttachedFile {
  path: string;
  name: string;
}

/** What one file turned into: its text, or why there is none. */
export interface AttachmentRead {
  path: string;
  name: string;
  content: string | null;
  error?: string;
}

/**
 * Total text folded into one message.
 *
 * Roughly the size of a large source file, and well inside every provider's
 * window — the point is to bound a mistake (attaching a lockfile, a bundle)
 * without making ordinary use awkward.
 */
export const MAX_ATTACHMENT_BYTES = 60 * 1024;

/** Read what was attached, one failure not taking the others with it. */
export async function readAttachments(
  files: AttachedFile[],
  read: (path: string) => Promise<string> = (path) => readTextFile(path, ""),
): Promise<AttachmentRead[]> {
  return Promise.all(
    files.map(async (file) => {
      try {
        return { path: file.path, name: file.name, content: await read(file.path) };
      } catch (error) {
        return {
          path: file.path,
          name: file.name,
          content: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/** The block appended to a prompt, or "" when nothing was attached. */
export function attachmentBlock(
  reads: AttachmentRead[],
  maxBytes: number = MAX_ATTACHMENT_BYTES,
): string {
  if (reads.length === 0) return "";

  let remaining = maxBytes;
  let budgetSpent = false;
  const sections: string[] = [];

  for (const read of reads) {
    if (read.content === null) {
      sections.push(`File: ${read.path}\n[not attached — ${read.error ?? "could not be read"}]`);
      continue;
    }
    if (budgetSpent || remaining <= 0) {
      sections.push(`File: ${read.path}\n[not attached — the message already carries ${Math.round(maxBytes / 1024)} KB of files]`);
      continue;
    }

    const text = read.content;
    if (text.length <= remaining) {
      remaining -= text.length;
      sections.push(`File: ${read.path}\n\`\`\`\n${text}\n\`\`\``);
      continue;
    }

    // The file that crosses the line is included, shortened, and labelled — a
    // half-file that does not say it is half is worse than no file at all.
    const kept = text.slice(0, Math.max(0, remaining));
    remaining = 0;
    budgetSpent = true;
    sections.push(
      `File: ${read.path} (truncated to ${Math.round(kept.length / 1024)} KB of ${Math.round(text.length / 1024)} KB)\n\`\`\`\n${kept}\n\`\`\``,
    );
  }

  return `\n\nFiles attached to this message:\n\n${sections.join("\n\n")}\n`;
}
