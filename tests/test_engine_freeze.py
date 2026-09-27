"""The frozen engine must be able to answer every subcommand it advertises.

`acsa_engine.COMMANDS` is the dispatch table, and
`scripts/build_engine_sidecar.sh` lists the same modules for PyInstaller by hand.
The two drifted exactly once and the cost was a shipped feature: `snapshot` was
added to the dispatch and not to the freeze, so the packaged engine answered
`ModuleNotFoundError: No module named 'snapshot_cli'`. Source-mode tests cannot
see that, because source mode finds the module on `sys.path` — the only thing that
noticed was CI's "Sidecar answers each subcommand" step, on the commit *after* the
one that broke it.

This is the local half of that check: it asserts the two lists agree, so the drift
fails here rather than in a packaged build.
"""

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core-engine"))

import acsa_engine  # noqa: E402


class EngineFreezeTests(unittest.TestCase):
    def frozen_modules(self) -> set[str]:
        script = (ROOT / "scripts" / "build_engine_sidecar.sh").read_text(encoding="utf-8")
        # `--hidden-import name \` — one per line in the shell invocation.
        return set(re.findall(r"--hidden-import\s+([A-Za-z_][A-Za-z0-9_]*)", script))

    def test_every_subcommand_module_is_frozen(self):
        """The modules that must be named, and why only these.

        `acsa_engine` reaches its subcommands through `importlib`, so PyInstaller's
        static analysis cannot see them and they have to be named. Everything else
        the engine imports is a plain module-level import inside one of those, which
        PyInstaller follows by itself — the frozen sidecar's own `selftest` imports
        each subcommand, and it is what proves the transitive imports arrived. (That
        is why `tree_sitter_cfg` has never been in this list and has never broken,
        and why requiring a complete inventory here would be stricter than the
        freeze actually is.)
        """
        frozen = self.frozen_modules()
        missing = {
            name: module
            for name, (module, _func) in acsa_engine.COMMANDS.items()
            if module not in frozen
        }
        self.assertEqual(
            missing,
            {},
            "these subcommands would fail in a packaged build with "
            f"ModuleNotFoundError: {missing}. Add them to "
            "scripts/build_engine_sidecar.sh as --hidden-import.",
        )

    def allowed_engine_subcommands(self) -> set[str]:
        """The Rust IPC layer's allowlist — the third list that has to agree.

        Parsed from the source rather than imported: it is a Rust constant, and a
        test that restated it would be the same drift in a different language.
        """
        rust = (ROOT / ".tauri" / "src" / "main.rs").read_text(encoding="utf-8")
        start = rust.index("const ALLOWED_ENGINE_SUBCOMMANDS")
        block = rust[start : rust.index("];", start)]
        return set(re.findall(r'"([a-z_]+)"', block))

    def test_every_subcommand_can_be_reached_over_ipc(self):
        """A subcommand the page cannot reach is a feature that ships dead.

        `ALLOWED_ENGINE_SUBCOMMANDS` is a *security* boundary — the page picks these,
        so it is a deliberate list — and it is maintained by hand, which is the same
        shape as the freeze list above and drifts the same way. It drifted twice: `gh`
        shipped in 0.2.18 with every GitHub panel answering "engine subcommand not
        allowed: gh" (the CI card, the pull requests, the run log — all working in
        development, where the engine is source rather than the packaged sidecar), and
        `crash` has never been allowed at all, so the app's own crash reporter has
        been unable to write a crash log in any packaged build.

        `pty` and `adapter` are the deliberate exclusions, and the Rust comment says
        why: Rust spawns both with arguments Rust chose, so the page has no business
        reaching them.
        """
        allowed = self.allowed_engine_subcommands()
        unreachable = sorted(set(acsa_engine.COMMANDS) - allowed - {"pty", "adapter"})
        self.assertEqual(
            unreachable,
            [],
            "these subcommands are registered but the IPC layer refuses them, so they "
            f"are dead in a packaged app: {unreachable}. Add them to "
            "ALLOWED_ENGINE_SUBCOMMANDS in .tauri/src/main.rs, or name the exclusion "
            "in both places.",
        )

    def test_the_allowlist_was_actually_parsed(self):
        # Guards the check above against a regex that quietly stopped matching: an
        # empty set would otherwise make every subcommand look unreachable, and a
        # too-greedy one would make them all look fine.
        allowed = self.allowed_engine_subcommands()
        self.assertIn("git", allowed)
        self.assertIn("gh", allowed)
        self.assertNotIn("pty", allowed)

    def test_the_freeze_list_was_actually_parsed(self):
        # Guards the check above against a regex that quietly stopped matching: a
        # set that came back empty would fail loudly, but a set that came back
        # *small* would report a drift that is not there. `app_db` is pinned
        # because it is fundamental rather than a feature that might be removed —
        # whether `snapshot_cli` is frozen is what the check above is for.
        frozen = self.frozen_modules()
        self.assertIn("app_db", frozen)
        self.assertGreater(len(frozen), 15)


if __name__ == "__main__":
    unittest.main()
