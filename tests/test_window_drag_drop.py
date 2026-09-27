"""The window has to let the webview see drag and drop.

Tauri hands file drops to its own native handler by default, and while that is on
the webview never receives an HTML5 `drop` event — so the composer's drag-and-drop
handlers simply never ran in the packaged app, while the jsdom test for them passed
happily. The crate says so itself, on `drag_drop_enabled`:

    Whether the drag and drop is enabled or not on the webview. By default it is
    enabled. Disabling it is required to use HTML5 drag and drop on the frontend.

Nothing in this app uses the native drop events (`onDragDropEvent` appears nowhere),
so disabling them costs nothing and is what makes attaching an image by dragging it
onto the composer work at all.

This asserts the setting rather than the behaviour on purpose: a regression here is
a one-word config edit that no test in the suite can otherwise see, and the symptom
is a feature that silently does nothing.
"""

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class WindowDragDropTests(unittest.TestCase):
    def windows(self) -> list[dict]:
        config = json.loads((ROOT / ".tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
        return config.get("app", {}).get("windows", [])

    def test_the_webview_owns_drag_and_drop(self):
        windows = self.windows()
        self.assertTrue(windows, "no windows configured")
        for window in windows:
            self.assertIs(
                window.get("dragDropEnabled"),
                False,
                f"window {window.get('label')!r} lets Tauri consume file drops, so "
                "HTML5 drop events never reach the composer. Set "
                '`"dragDropEnabled": false`.',
            )

    def test_nothing_relies_on_the_native_drop_events(self):
        # If someone starts using Tauri's own drag-drop events, disabling them here
        # would break that instead — so the guard names the assumption it rests on.
        sources = []
        for folder in ("src", ".tauri/src"):
            sources += [
                path.read_text(encoding="utf-8", errors="ignore")
                for path in (ROOT / folder).rglob("*")
                if path.suffix in {".ts", ".tsx", ".rs"}
            ]
        joined = "\n".join(sources)
        self.assertNotIn(
            "onDragDropEvent",
            joined,
            "the native drop events are now used; this guard needs rethinking rather "
            "than deleting",
        )


if __name__ == "__main__":
    unittest.main()
