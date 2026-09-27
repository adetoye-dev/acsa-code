"""The review overlay must not swallow clicks meant for the code.

The finding cards are positioned *over* the editor at the line they belong to, and
their wrapper spans the whole editor to make that possible. With clicks enabled on
the wrapper, every click in the code landed on it instead: the caret never moved,
the editor never took focus, and the file could not be edited by hand for as long as
one finding existed — reported as "I can't even type or edit code by hand".

Two invariants keep that from coming back, and they belong together because either
one alone leaves the editor unusable:
  * the wrapper lets clicks through (`pointer-events: none`);
  * the cards themselves keep them (`pointer-events: auto`).
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = (ROOT / "src" / "index.css").read_text(encoding="utf-8")


def rule(selector: str) -> str:
    """The declarations of one rule, comments removed.

    Comments are stripped because they are prose *about* these declarations, and
    an assertion that reads them will pass on the explanation while the property
    says the opposite — which is exactly how the first version of this guard let a
    flipped `pointer-events` through.
    """
    match = re.search(rf"^\.{selector}\s*\{{(.*?)\}}", CSS, re.S | re.M)
    body = match.group(1) if match else ""
    return re.sub(r"/\*.*?\*/", "", body, flags=re.S)


class EditorOverlayTests(unittest.TestCase):
    def test_the_overlay_wrapper_lets_clicks_through(self):
        body = rule("acsa-review-card-wrap")
        self.assertTrue(body, "`.acsa-review-card-wrap` is gone; this guard needs rethinking")
        self.assertRegex(
            body,
            r"pointer-events:\s*none\s*;",
            "the finding wrapper covers the editor and would eat every click meant for "
            "the code",
        )

    def test_the_cards_themselves_stay_clickable(self):
        body = rule("acsa-review-card")
        self.assertTrue(body, "`.acsa-review-card` is gone; this guard needs rethinking")
        self.assertRegex(
            body,
            r"pointer-events:\s*auto\s*;",
            "with the wrapper transparent to clicks, the card has to claim them back "
            "or the findings become decoration",
        )


if __name__ == "__main__":
    unittest.main()
