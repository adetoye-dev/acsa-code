"""Every place the app's version is written has to agree.

Two drifts were found by hand during one release: `package-lock.json` sat at
0.2.1 while `package.json` went on to 0.2.4, and `.tauri/Cargo.toml` stayed at
0.2.4 when everything else moved to 0.2.5. Nothing checked, and the release
checklist names only two of the four carriers — so the one it does not name is
the one that drifts.

This is deliberately a *release* concern rather than a test of product behaviour:
it cannot tell you the version is right, only that the four places agree about it,
which is the failure that actually happened.
"""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def json_version(relative: str) -> str:
    data = json.loads((ROOT / relative).read_text(encoding="utf-8"))
    return str(data.get("version", ""))


def cargo_version(relative: str) -> str:
    text = (ROOT / relative).read_text(encoding="utf-8")
    match = re.search(r'(?m)^version = "([^"]+)"', text)
    return match.group(1) if match else ""


class VersionCarrierTests(unittest.TestCase):
    def carriers(self) -> dict[str, str]:
        return {
            "package.json": json_version("package.json"),
            "package-lock.json": json_version("package-lock.json"),
            ".tauri/tauri.conf.json": json_version(".tauri/tauri.conf.json"),
            ".tauri/Cargo.toml": cargo_version(".tauri/Cargo.toml"),
        }

    def test_every_carrier_agrees(self):
        carriers = self.carriers()
        self.assertEqual(
            len(set(carriers.values())),
            1,
            f"the version carriers disagree: {carriers}",
        )

    def test_the_version_actually_parsed(self):
        # Guards the check above from passing for the wrong reason: four empty
        # strings are equal, and would report agreement between two files that
        # both failed to parse.
        for name, value in self.carriers().items():
            self.assertRegex(value, r"^\d+\.\d+\.\d+", f"{name} did not yield a version")


if __name__ == "__main__":
    unittest.main()
