"""Guards on the browser harness's own source.

`scripts/editor-app-check.mjs` injects its Tauri stub and its focus logger as
*template literals*, so a backtick anywhere inside either one ends the literal and
the file stops parsing. The symptom is a `SyntaxError: Unexpected identifier` on a
line that looks perfectly fine — three separate times in one session it was a
backtick inside a **comment**, and each time the message named a word from a
comment rather than the template that had been cut short.

A nested template literal is the other form of the same mistake: with its
backticks stripped it leaves a bare `${...}` in the injected JavaScript, which
parses and then dies at runtime with an undefined name.

Both are cheap to rule out from outside, which is what this does — plus the whole
file through `node --check`, since that is the check that actually runs.
"""

from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parent.parent / "scripts" / "editor-app-check.mjs"


def _injected_source(name: str) -> str:
    """The body of one `const <name> = \\`...\\`;` template literal."""
    text = HARNESS.read_text(encoding="utf-8")
    opener = f"const {name} = `"
    start = text.index(opener) + len(opener)
    # The literal ends at the first backtick followed by a semicolon.
    end = text.index("`;", start)
    return text[start:end]


class InjectedSourceTests(unittest.TestCase):
    def test_the_stub_holds_no_backticks(self):
        body = _injected_source("TAURI_STUB")
        offenders = [line for line in body.splitlines() if "`" in line]
        self.assertEqual(
            offenders,
            [],
            "a backtick inside the stub ends the template literal that holds it, "
            "and the file stops parsing:\n" + "\n".join(offenders),
        )

    def test_the_stub_has_no_bare_interpolation(self):
        # `${...}` with no backticks around it is what a stripped nested template
        # leaves behind: it parses, then throws at runtime in the page.
        body = _injected_source("TAURI_STUB")
        offenders = [line for line in body.splitlines() if "${" in line]
        self.assertEqual(offenders, [], "bare interpolation inside the stub:\n" + "\n".join(offenders))

    def test_the_focus_logger_holds_no_backticks(self):
        body = _injected_source("FOCUS_LOGGER")
        self.assertEqual([line for line in body.splitlines() if "`" in line], [])

    def test_the_harness_parses(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed, so the file cannot be parsed here")
        result = subprocess.run(
            [node, "--check", str(HARNESS)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr.strip())

    def test_the_injected_source_is_valid_javascript(self):
        """The strongest form of the check above: parse what the page receives.

        The two tests above work on the file's text, and a `\n` written inside one of
        the stub's strings passes them both while being wrong — the template literal
        turns it into a real newline, which lands *inside a string literal* in the
        injected script and stops it compiling. That failure looks like the harness
        being broken ("the stub never installed") with no mention of escaping, so it
        is worth catching here instead.

        This evaluates the template literal the way the browser does and then parses
        the result the way the page does, which is the only check that sees the
        difference between `\n` and `\\n`.
        """
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed, so the source cannot be parsed here")
        program = (
            "const fs = require('node:fs');"
            f"const source = fs.readFileSync({str(HARNESS)!r}, 'utf8');"
            "const body = (name) => {"
            "  const open = 'const ' + name + ' = ' + String.fromCharCode(96);"
            "  const start = source.indexOf(open) + open.length;"
            "  const end = source.indexOf(String.fromCharCode(96) + ';', start);"
            "  return source.slice(start, end);"
            "};"
            "for (const name of ['TAURI_STUB', 'FOCUS_LOGGER']) {"
            "  const injected = eval(String.fromCharCode(96) + body(name) + String.fromCharCode(96));"
            "  new Function(injected);"
            "  console.log(name + ': ' + injected.length + ' chars parse');"
            "}"
        )
        result = subprocess.run(
            [node, "-e", program], capture_output=True, text=True, timeout=60
        )
        self.assertEqual(result.returncode, 0, result.stderr.strip())
        self.assertIn("TAURI_STUB", result.stdout)


if __name__ == "__main__":
    unittest.main()
