import { describe, expect, it, vi } from "vitest";
import type { ILink, ILinkProvider } from "@xterm/xterm";
import { findTerminalUrls, registerTerminalLinks } from "./terminalLinks";

/**
 * `npm run dev` prints the dev server's address as plain characters, and clicking
 * it did nothing. These cover the two things that decide whether the click lands
 * on the right characters: which text counts as a URL, and which cells the range
 * covers.
 */
describe("finding URLs in a line of terminal output", () => {
  it("finds the dev server address Vite prints", () => {
    const line = "  ➜  Local:   http://localhost:5173/";
    expect(findTerminalUrls(line).map((url) => url.text)).toEqual([
      "http://localhost:5173/",
    ]);
  });

  it("leaves the sentence's full stop out of the URL", () => {
    const [url] = findTerminalUrls("see http://example.com/guide for more.");
    expect(url.text).toBe("http://example.com/guide");
  });

  it("keeps brackets that belong to the address", () => {
    const [url] = findTerminalUrls("http://example.com/Foo_(bar) is the page");
    expect(url.text).toBe("http://example.com/Foo_(bar)");
  });

  it("drops a closing bracket the sentence added", () => {
    const [url] = findTerminalUrls("(deployed to http://example.com/x)");
    expect(url.text).toBe("http://example.com/x");
  });

  it("offers nothing for a scheme the opener would refuse", () => {
    expect(findTerminalUrls("ftp://example.com/x")).toEqual([]);
    expect(findTerminalUrls("file:///etc/hosts")).toEqual([]);
  });

  it("offers nothing for a scheme with no host", () => {
    // `http://` parses as nothing, and a link that only ever errors is worse than
    // plain text.
    expect(findTerminalUrls("failed to reach http:// just now")).toEqual([]);
  });

  it("finds both URLs when a line prints two", () => {
    const found = findTerminalUrls("http://localhost:5173/ -> https://acsa.dev/");
    expect(found.map((url) => url.text)).toEqual([
      "http://localhost:5173/",
      "https://acsa.dev/",
    ]);
  });
});

/** One buffer cell: the character in it, and the columns it holds. */
type FakeCell = {
  chars: string;
  width: number;
  getChars(): string;
  getWidth(): number;
};

function cell(chars: string, width: number): FakeCell {
  return { chars, width, getChars: () => chars, getWidth: () => width };
}

/** Plain text, one column per character. */
function cells(text: string): FakeCell[] {
  return text.split("").map((character) => cell(character, 1));
}

/**
 * A double-width glyph, and the spacer cell xterm keeps beside it — the second
 * cell reports width 0 and holds nothing, which is the whole reason a row's
 * characters and its columns are different lists.
 */
function wide(character: string): FakeCell[] {
  return [cell(character, 2), cell("", 0)];
}

/**
 * A terminal is a lot of machinery and the provider touches two parts of it. Faking
 * exactly those keeps this about the arithmetic — columns, wrapped lines — rather
 * than about xterm.
 */
function fakeTerminal(lines: Array<{ cells: FakeCell[]; isWrapped?: boolean }>) {
  let provider: ILinkProvider | undefined;
  const term = {
    buffer: {
      active: {
        getLine: (index: number) => {
          const line = lines[index];
          if (!line) return undefined;
          const text = line.cells
            .filter((cell) => cell.width > 0)
            .map((cell) => cell.chars)
            .join("")
            .trimEnd();
          return {
            length: line.cells.length,
            isWrapped: line.isWrapped === true,
            translateToString: () => text,
            getCell: (x: number) => line.cells[x],
          };
        },
      },
    },
    registerLinkProvider: (next: ILinkProvider) => {
      provider = next;
      return { dispose: () => {} };
    },
  };
  return {
    // Only `buffer.active.getLine` and `registerLinkProvider` are read; the cast
    // stands in for the rest of IBuffer, which nothing here touches.
    register: (open: (url: string) => void) =>
      registerTerminalLinks(term as unknown as Parameters<typeof registerTerminalLinks>[0], open),
    links: (y: number) =>
      new Promise<ILink[] | undefined>((resolve) => {
        if (!provider) throw new Error("the provider was never registered");
        provider.provideLinks(y, resolve);
      }),
  };
}

describe("the link provider xterm asks for a line at a time", () => {
  it("covers exactly the URL's characters, and opens it on click", async () => {
    const lines = [{ cells: cells("  ➜  Local:   http://localhost:5173/") }];
    const open = vi.fn();
    const term = fakeTerminal(lines);
    term.register(open);

    const links = await term.links(1);
    expect(links).toHaveLength(1);

    // The invariant that catches an off-by-one: the 1-based range xterm gets back
    // must select the same characters the URL is made of. Every cell here is one
    // column, so the columns and the string indices agree.
    const range = links![0].range;
    const lineText = lines[0].cells.map((cell) => cell.chars).join("");
    expect(lineText.slice(range.start.x - 1, range.end.x)).toBe(links![0].text);
    expect(range.start.y).toBe(1);
    expect(range.end.y).toBe(1);

    links![0].activate({} as MouseEvent, links![0].text);
    expect(open).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("offers nothing for a line with no URL", async () => {
    const term = fakeTerminal([{ cells: cells("added 42 packages in 3s") }]);
    term.register(() => {});
    expect(await term.links(1)).toBeUndefined();
  });

  it("puts the range on the URL's columns, past a wide glyph", async () => {
    // `中` takes two columns and contributes one character, so everything after it
    // sits a column right of its index. `"  中 "` is columns 0,1,2-3,4 — so `http`
    // starts at column 5, while the string index of that `h` is 4. Using the index
    // would offer the cells *before* the URL.
    const term = fakeTerminal([{ cells: [...cells("  "), ...wide("中"), ...cells(" "), ...cells("http://x.test/")] }]);
    term.register(() => {});

    const links = await term.links(1);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe("http://x.test/");
    // Column 5, so a 1-based x of 6 — not the 5 the string index would give.
    expect(links![0].range.start.x).toBe(6);
    expect(links![0].range.end.x).toBe(6 + "http://x.test/".length - 1);
  });

  it("ignores the wrapped remainder of a line it already offered", async () => {
    // A continuation row is a fragment; the URL above it was offered in full.
    const term = fakeTerminal([
      { cells: cells("http://example.com/a") },
      { cells: cells("/very/long/path"), isWrapped: true },
    ]);
    term.register(() => {});
    expect(await term.links(2)).toBeUndefined();
  });

  it("refuses a URL cut off at the right margin", async () => {
    // The address continues on the next row, so the visible part is not the
    // address — opening it would go to the wrong place.
    const term = fakeTerminal([
      { cells: cells("http://example.com/very-long") },
      { cells: cells("/path-that-continued"), isWrapped: true },
    ]);
    term.register(() => {});
    expect(await term.links(1)).toBeUndefined();
  });
});
