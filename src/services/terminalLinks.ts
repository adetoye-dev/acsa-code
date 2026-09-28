/**
 * terminalLinks — make a URL the terminal prints clickable.
 *
 * xterm resolves *OSC 8* hyperlinks — the escape sequence a program emits when it
 * already knows it is printing a link — but not bare text, which is how almost
 * everything prints one. `npm run dev` writes `http://localhost:5173/` as plain
 * characters, so the line was inert: the one thing a user most wants to click in a
 * dev-server terminal was the one thing that did nothing.
 *
 * Written against the core link API rather than pulled in as
 * `@xterm/addon-web-links` for a reason that matters here: this decides what is
 * clickable using the same rule the opener applies before it opens anything
 * (http/https only). A link that exists only to be refused is worse than no link.
 */
import type { IBufferLine, IDisposable, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

/** Punctuation that sits *around* a URL in a sentence, not inside it. */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

/** The only schemes the opener will accept, so the only ones worth offering. */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0
    );
  } catch {
    // `new URL("http://")` throws, which is the point: no host, no link.
    return false;
  }
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Trim what a sentence adds to a URL: the full stop after it, and a closing
 * bracket that closes nothing.
 *
 * `)`/`]`/`}` are kept when they are balanced inside the URL, because they are
 * genuinely part of some addresses (`…/Foo_(bar)`) — the unbalanced one is the
 * sentence's.
 */
function trimTrailingPunctuation(raw: string): string {
  let url = raw.replace(TRAILING_PUNCTUATION, "");
  while (url.length > 0) {
    const last = url[url.length - 1];
    const open = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : "";
    if (!open || countOf(url, last) <= countOf(url, open)) break;
    url = url.slice(0, -1);
  }
  return url;
}

/** A URL found in one line of terminal text, as a 0-based, end-exclusive span. */
export interface TerminalUrlMatch {
  text: string;
  start: number;
  end: number;
}

/**
 * Read a buffer row as text, plus the column each of its characters came from.
 *
 * The two lists are not the same, and that is the trap: a double-width glyph takes
 * two columns and contributes one character, so every index after one sits to the
 * left of the column the character actually occupies. A URL printed after such a
 * glyph would be offered the cells *before* it — the click would land beside the
 * link, or on the tail of the line before it.
 *
 * So the mapping is read off the cells rather than assumed. `getWidth()` is what
 * separates the two columns of a wide glyph — the second cell reports width 0 and
 * holds no character — and each character is recorded under the column it was
 * found in. Walking the cells also stops of its own accord at the last character
 * `translateToString(true)` kept, so the trailing padding needs no separate trim.
 *
 * (`translateToString` has an undocumented fourth argument that reports this same
 * mapping, and it is the tidier way to ask — but the shipped build does not fill
 * it, so it cannot be leant on.)
 */
function readLine(line: IBufferLine): { text: string; columnOf: number[] } {
  const text = line.translateToString(true);
  const columnOf: number[] = [];
  for (let x = 0; x < line.length && columnOf.length < text.length; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    // The second cell of a double-width glyph: no character of its own.
    if (cell.getWidth() === 0) continue;
    // A blank cell's character is a space; the docs for `getChars` leave it empty.
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) columnOf.push(x);
  }
  if (columnOf.length !== text.length) {
    // Cells and text disagreeing is a build this cannot map. The character's own
    // index is then the best available answer, and it is only wrong for a line with
    // a wide glyph on it — better than a range that is confidently elsewhere.
    return { text, columnOf: text.split("").map((_character, index) => index) };
  }
  return { text, columnOf };
}

/**
 * Every `http(s)` URL in a line of text.
 *
 * Export pure so it can be tested without a terminal: what actually breaks is the
 * boundary handling — a URL followed by a sentence's full stop, or wrapped in
 * brackets — not the xterm plumbing around it.
 */
export function findTerminalUrls(line: string): TerminalUrlMatch[] {
  const found: TerminalUrlMatch[] = [];
  // Deliberately not `\b`-anchored at the end: the point is to over-match and let
  // the trim and the parse decide, rather than to guess where a URL stops.
  const pattern = /https?:\/\/[^\s<>"'`]+/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const url = trimTrailingPunctuation(match[0]);
    if (!isHttpUrl(url)) continue;
    found.push({ text: url, start: match.index, end: match.index + url.length });
  }
  return found;
}

/**
 * The provider xterm asks, one row at a time, which of its cells are links.
 *
 * `y` arrives **1-based** — the built-in OSC 8 provider subtracts one to index the
 * buffer, so the range handed back is 1-based too: a 0-based column `c` becomes
 * `x: c + 1`.
 *
 * Split from the registration so it can be driven directly against a real
 * terminal in a test; `registerTerminalLinks` is the one line that mounts it.
 */
export function createTerminalLinkProvider(
  term: Pick<Terminal, "buffer">,
  open: (url: string) => void
): ILinkProvider {
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const buffer = term.buffer.active;
      const line = buffer.getLine(y - 1);
      // A wrap continuation is the tail of the line above; the URL it belongs to
      // was offered there, in full, or not at all.
      if (!line || line.isWrapped) {
        callback(undefined);
        return;
      }
      // `true` trims the trailing blanks, so column indices match the columns a
      // user can actually click rather than the padded width of the buffer line.
      const { text, columnOf } = readLine(line);
      const wrappedBelow = buffer.getLine(y)?.isWrapped ?? false;
      const urls = findTerminalUrls(text).filter(
        // A URL cut off at the right margin is not a URL yet. Offering the
        // truncated form would open the wrong address, which is worse than
        // offering nothing.
        (url) => !(wrappedBelow && url.end >= text.length)
      );
      if (urls.length === 0) {
        callback(undefined);
        return;
      }
      callback(
        urls.map(
          (url): ILink => {
            const startColumn = columnOf[url.start];
            const endColumn = columnOf[url.end - 1];
            return {
              text: url.text,
              range: {
                start: { x: startColumn + 1, y },
                end: { x: endColumn + 1, y },
              },
              activate: () => open(url.text),
            };
          }
        )
      );
    },
  };
  return provider;
}

/** Mount the provider on a terminal, and hand back the way to unmount it. */
export function registerTerminalLinks(
  term: Pick<Terminal, "buffer" | "registerLinkProvider">,
  open: (url: string) => void
): IDisposable {
  return term.registerLinkProvider(createTerminalLinkProvider(term, open));
}
