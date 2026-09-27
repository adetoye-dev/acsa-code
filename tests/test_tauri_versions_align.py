"""A Tauri plugin's Rust crate and its npm package must share a major.minor.

Tauri refuses to bundle when they disagree:

    Found version mismatched Tauri packages. Make sure the NPM package and Rust
    crate versions are on the same major/minor releases:
    tauri-plugin-updater (v2.12.0) : @tauri-apps/plugin-updater (v2.11.0)

That is how 0.2.6's first release attempt died. Nothing before the bundle notices:
`npm run verify` passes, `cargo test` passes, the app runs in `tauri dev` — the check
only exists inside `tauri build`. And it is easy to trip without touching the plugin:
`tauri-plugin-updater = "2.11.0"` is a *caret* range, so adding any dependency can
re-resolve the lockfile and move the crate to 2.12 while the npm lock stays put.
Which is exactly what happened — a keychain dependency did it.

This is the same shape as the freeze list and the version carriers: a pair that must
agree, checked by nothing until the most expensive moment. So it is checked here,
from the two lockfiles, in a second and without cargo.
"""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# crate name -> npm package name. Only pairs that are actually installed on the npm
# side are compared; `tauri-plugin-http` and `-fs` are Rust-only here.
PAIRS = {
    "tauri": "@tauri-apps/api",
    "tauri-plugin-updater": "@tauri-apps/plugin-updater",
    "tauri-plugin-shell": "@tauri-apps/plugin-shell",
    "tauri-plugin-http": "@tauri-apps/plugin-http",
    "tauri-plugin-fs": "@tauri-apps/plugin-fs",
}


def major_minor(version: str) -> str:
    parts = version.split(".")
    return ".".join(parts[:2]) if len(parts) >= 2 else version


class TauriVersionPairTests(unittest.TestCase):
    def cargo_versions(self) -> dict[str, str]:
        lock = (ROOT / ".tauri" / "Cargo.lock").read_text(encoding="utf-8")
        found = {}
        for name, version in re.findall(r'name = "([^"]+)"\nversion = "([^"]+)"', lock):
            found[name] = version
        return found

    def npm_versions(self) -> dict[str, str]:
        lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
        packages = lock.get("packages", {})
        return {
            package: entry.get("version", "")
            for package, entry in (
                (name, packages.get(f"node_modules/{name}", {})) for name in PAIRS.values()
            )
            if entry
        }

    def test_every_installed_pair_shares_a_major_minor(self):
        cargo, npm = self.cargo_versions(), self.npm_versions()
        compared, mismatched = 0, {}
        for crate, package in PAIRS.items():
            if crate not in cargo or package not in npm:
                continue  # not a pair in this build
            compared += 1
            if major_minor(cargo[crate]) != major_minor(npm[package]):
                mismatched[package] = f"crate {cargo[crate]} vs npm {npm[package]}"
        self.assertEqual(
            mismatched,
            {},
            "Tauri will refuse to bundle these: " + json.dumps(mismatched),
        )

    def test_the_comparison_actually_compares_something(self):
        # A regex that stopped matching would leave the pairs above uncompared and
        # the test green, which is the failure this whole file exists to prevent.
        cargo, npm = self.cargo_versions(), self.npm_versions()
        self.assertIn("tauri", cargo)
        self.assertIn("@tauri-apps/api", npm)
        self.assertGreaterEqual(
            len([1 for crate, package in PAIRS.items() if crate in cargo and package in npm]),
            2,
            "expected at least the updater and shell pairs to be present",
        )


if __name__ == "__main__":
    unittest.main()
