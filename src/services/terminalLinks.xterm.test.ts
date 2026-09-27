/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import type { ILink } from "@xterm/xterm";
import { createTerminalLinkProvider } from "./terminalLinks";

/**
 * The unit tests beside this one use a fake row, because they are about the
 * arithmetic. This one uses the real xterm, because the assumption underneath that
 * arithmetic is xterm's: a row's text and its columns are not the same list once a
 * double-width glyph is on it. If any of that stops being true — a glyph's width, the
 * spacer cell reporting 0, `getCell` reaching the whole row — these fail rather than
 * the click quietly drifting off the link.
 *
 * The `➜` Vite prints is *not* double-width in xterm's tables (it is one column),
 * so it is covered as the ordinary case it is; the CJK case is what exercises the
 * split.
 *
 * xterm reaches for a canvas as it refreshes, and jsdom has none, so this file also
 * logs "HTMLCanvasElement's getContext() is not implemented" once. It is jsdom's
 * note, not a failing assertion, and the buffer is all this reads.
 */
async function write(term: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => term.write(data, resolve));
}

function linksFor(term: Terminal, y: number): Promise<ILink[] | undefined> {
  const provider = createTerminalLinkProvider(term, () => {});
  return new Promise((resolve) => provider.provideLinks(y, resolve));
}

/** What a click would actually select: the cells under the 1-based range. */
function cellsUnder(term: Terminal, y: number, link: ILink): string {
  const line = term.buffer.active.getLine(y - 1)!;
  let cells = "";
  for (let x = link.range.start.x; x <= link.range.end.x; x++) {
    cells += line.getCell(x - 1)?.getChars() ?? "";
  }
  return cells;
}

describe("the link provider against a real xterm buffer", () => {
  it("covers the dev server address, past the arrow Vite prints", async () => {
    const term = new Terminal({ cols: 80, rows: 4 });
    await write(term, "  ➜  Local:   http://localhost:5173/\r\n");

    const links = await linksFor(term, 1);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe("http://localhost:5173/");
    expect(cellsUnder(term, 1, links![0])).toBe("http://localhost:5173/");

    term.dispose();
  });

  it("covers it past a genuinely double-width glyph", async () => {
    // `➜` turns out to be one column wide in xterm's tables, so the case above
    // does not exercise the text/column split at all. A CJK character does: it
    // holds two columns and one character, putting the URL three columns right of
    // where its string index says it is.
    const term = new Terminal({ cols: 80, rows: 4 });
    const url = "http://localhost:5173/";
    const text = `启动中  ${url}`;
    await write(term, `${text}\r\n`);

    const [link] = (await linksFor(term, 1)) ?? [];
    expect(link?.text).toBe(url);

    // What a click selects has to be the URL's own cells…
    expect(cellsUnder(term, 1, link!)).toBe(url);

    // …and this is the falsification: treating the string index as a column — the
    // obvious implementation, and the one that was there first — selects the wrong
    // cells, so the assertions above are testing something real.
    const naiveStart = text.indexOf(url);
    const naive = cellsUnder(term, 1, {
      ...link!,
      range: {
        start: { x: naiveStart + 1, y: 1 },
        end: { x: naiveStart + url.length, y: 1 },
      },
    });
    expect(naive).not.toBe(url);

    term.dispose();
  });
});
