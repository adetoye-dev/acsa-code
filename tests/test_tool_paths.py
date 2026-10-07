"""The lookup a Dock-launched app needs and `shutil.which` cannot do.

A macOS app started from Finder is given launchd's PATH, not the one from the
user's shell profile, so Homebrew's `/opt/homebrew/bin` is not in it. `which` then
answers "not installed" for a tool that is installed and working in the user's
terminal. These pin the parts of the answer that can be wrong: which wins when the
tool is on PATH, the install directories are the fallback, and a file that is not
executable is not the tool.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core-engine"))

import tool_paths  # noqa: E402


class InstallDirsTests(unittest.TestCase):
    def test_macos_searches_homebrew_before_the_system_prefixes(self):
        with mock.patch.object(sys, "platform", "darwin"):
            dirs = tool_paths.install_dirs()
        self.assertIn("/opt/homebrew/bin", dirs)
        self.assertIn("/usr/local/bin", dirs)
        # Order is the point: the user's package manager is a better guess than
        # the system prefix they almost certainly did not install into.
        self.assertLess(dirs.index("/opt/homebrew/bin"), dirs.index("/usr/bin"))

    def test_linux_does_not_claim_homebrew(self):
        with mock.patch.object(sys, "platform", "linux"):
            dirs = tool_paths.install_dirs()
        self.assertIn("/usr/local/bin", dirs)
        self.assertNotIn("/opt/homebrew/bin", dirs)


class FindTests(unittest.TestCase):
    def _executable(self, directory: str, name: str) -> Path:
        path = Path(directory) / name
        path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        path.chmod(0o755)
        return path

    def test_what_is_on_path_is_still_what_is_chosen(self):
        with tempfile.TemporaryDirectory() as tmp:
            found = self._executable(tmp, "gh")
            with mock.patch.object(tool_paths.shutil, "which", return_value=str(found)), mock.patch.object(
                tool_paths, "install_dirs", return_value=("/definitely/not/here",)
            ):
                self.assertEqual(tool_paths.find("gh"), str(found))

    def test_it_falls_back_to_the_install_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            found = self._executable(tmp, "gh")
            with mock.patch.object(tool_paths.shutil, "which", return_value=None), mock.patch.object(
                tool_paths, "install_dirs", return_value=(tmp,)
            ):
                self.assertEqual(tool_paths.find("gh"), str(found))

    def test_an_extra_path_is_tried_before_the_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            ours = self._executable(tmp, "gh")
            with mock.patch.object(tool_paths.shutil, "which", return_value=None), mock.patch.object(
                tool_paths, "install_dirs", return_value=("/definitely/not/here",)
            ):
                self.assertEqual(tool_paths.find("gh", extra_paths=[str(ours)]), str(ours))

    def test_a_file_that_cannot_be_run_is_not_the_tool(self):
        if os.name == "nt":
            self.skipTest("Windows has no executable bit to test")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gh"
            path.write_text("not a program", encoding="utf-8")
            path.chmod(0o644)
            with mock.patch.object(tool_paths.shutil, "which", return_value=None), mock.patch.object(
                tool_paths, "install_dirs", return_value=(tmp,)
            ):
                self.assertIsNone(tool_paths.find("gh"))

    def test_nothing_anywhere_is_none(self):
        with mock.patch.object(tool_paths.shutil, "which", return_value=None), mock.patch.object(
            tool_paths, "install_dirs", return_value=("/definitely/not/here",)
        ):
            self.assertIsNone(tool_paths.find("gh"))


if __name__ == "__main__":
    unittest.main()
