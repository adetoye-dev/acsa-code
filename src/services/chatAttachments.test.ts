/**
 * What an attached file becomes in the prompt.
 *
 * The budget is the part worth pinning: a file that does not fit has to arrive as
 * a *shorter file that says it was shortened*. A model that quietly never saw the
 * end of a file answers as though it did, and the reader has no way to notice.
 */
import { describe, expect, it, vi } from "vitest";
import { attachmentBlock, readAttachments, type AttachmentRead } from "./chatAttachments";

const read = (name: string, content: string | null, error?: string): AttachmentRead => ({
  path: `src/${name}`,
  name,
  content,
  error,
});

describe("reading attachments", () => {
  it("keeps a failed read from taking the others with it", async () => {
    const reader = vi.fn(async (path: string) => {
      if (path.endsWith("bad.ts")) throw new Error("not found");
      return "export const x = 1;";
    });

    const reads = await readAttachments(
      [
        { path: "src/good.ts", name: "good.ts" },
        { path: "src/bad.ts", name: "bad.ts" },
      ],
      reader,
    );

    expect(reads[0].content).toBe("export const x = 1;");
    expect(reads[1].content).toBeNull();
    expect(reads[1].error).toBe("not found");
  });
});

describe("the block appended to a prompt", () => {
  it("is nothing at all when nothing was attached", () => {
    expect(attachmentBlock([])).toBe("");
  });

  it("names each file and fences its text", () => {
    const block = attachmentBlock([read("a.ts", "export const x = 1;")]);
    expect(block).toContain("Files attached to this message:");
    expect(block).toContain("File: src/a.ts");
    expect(block).toContain("```\nexport const x = 1;\n```");
  });

  it("says so when a file could not be read, rather than leaving a gap", () => {
    const block = attachmentBlock([read("gone.ts", null, "not found")]);
    expect(block).toContain("File: src/gone.ts");
    expect(block).toContain("[not attached — not found]");
    expect(block).not.toContain("```");
  });

  it("truncates the file that crosses the budget, and labels it", () => {
    const block = attachmentBlock([read("big.ts", "a".repeat(300))], 100);
    expect(block).toContain("(truncated to 0 KB of 0 KB)");
    expect(block).toContain("a".repeat(100));
    expect(block).not.toContain("a".repeat(101));
  });

  it("refuses the files after the budget rather than dropping them silently", () => {
    // Two files that each fit, then one that cannot: the reader has to be able to
    // see which of their attachments the model was actually given.
    const block = attachmentBlock(
      [read("a.ts", "a".repeat(80)), read("b.ts", "b".repeat(80)), read("c.ts", "c".repeat(10))],
      100,
    );
    expect(block).toContain("File: src/a.ts");
    expect(block).toContain("File: src/b.ts (truncated to 0 KB of 0 KB)");
    expect(block).toContain("File: src/c.ts");
    expect(block).toContain("[not attached — the message already carries 0 KB of files]");
    expect(block).not.toContain("cccccccccc");
  });
});
