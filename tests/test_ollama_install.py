"""Setting Ollama up for the user, in the app, with no password prompt.

The wizard used to hand the user a link to ollama.com and an error, which reads
as the app refusing to do its own job. These tests pin the replacement: pick the
right build for this machine, unpack it into a directory we own, and report a
terminal frame either way. Nothing here touches the network.
"""

import importlib
import io
import json
import os
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core-engine"))
ollama_cli = importlib.import_module("ollama_cli")


def frames(function, *args):
    """Run a streaming command and return its NDJSON frames."""
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        function(*args)
    return [json.loads(line) for line in buffer.getvalue().splitlines() if line.strip()]


class ArtifactChoiceTests(unittest.TestCase):
    def test_macos_gets_the_app_bundle_build(self):
        original = sys.platform
        sys.platform = "darwin"
        try:
            self.assertEqual(
                ollama_cli._artifact_url(), "https://ollama.com/download/Ollama-darwin.zip"
            )
        finally:
            sys.platform = original

    def test_windows_gets_the_build_for_its_chip(self):
        original_platform, original_name = sys.platform, os.name
        original_machine = ollama_cli.platform.machine
        sys.platform, os.name = "win32", "nt"
        try:
            ollama_cli.platform.machine = lambda: "ARM64"
            self.assertIn("arm64", ollama_cli._artifact_url())
            ollama_cli.platform.machine = lambda: "AMD64"
            self.assertIn("amd64", ollama_cli._artifact_url())
        finally:
            sys.platform, os.name = original_platform, original_name
            ollama_cli.platform.machine = original_machine

    def test_a_platform_we_have_no_build_for_says_so(self):
        original, original_binary = sys.platform, ollama_cli._binary
        sys.platform = "linux"
        ollama_cli._binary = lambda: None
        try:
            self.assertIsNone(ollama_cli._artifact_url())
            (frame,) = frames(ollama_cli.install)
            self.assertTrue(frame["done"])
            # The message has to leave the user somewhere to go.
            self.assertIn("ollama.com", frame["error"])
        finally:
            sys.platform = original
            ollama_cli._binary = original_binary


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="acsa-ollama-install-")
        self.addCleanup(self._cleanup)
        self._old_home = os.environ.get("ACSA_OLLAMA_HOME")
        os.environ["ACSA_OLLAMA_HOME"] = self.home
        # Nothing is on PATH and nothing is installed yet.
        self._old_which, self._old_binary = ollama_cli.shutil.which, ollama_cli._binary
        ollama_cli.shutil.which = lambda _name: None

    def _cleanup(self):
        if self._old_home is None:
            os.environ.pop("ACSA_OLLAMA_HOME", None)
        else:
            os.environ["ACSA_OLLAMA_HOME"] = self._old_home
        ollama_cli.shutil.which = self._old_which
        ollama_cli._binary = self._old_binary
        import shutil as _shutil

        _shutil.rmtree(self.home, ignore_errors=True)

    def _archive(self, members):
        """A local zip standing in for Ollama's download."""
        path = Path(self.home).parent / "fake-ollama.zip"
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        with zipfile.ZipFile(path, "w") as bundle:
            for name in members:
                bundle.writestr(name, b"#!/bin/sh\necho fake ollama\n")
        return path.as_uri()

    def test_an_existing_engine_is_reused_rather_than_replaced(self):
        ollama_cli._binary = lambda: "/usr/local/bin/ollama"
        (frame,) = frames(ollama_cli.install)
        self.assertTrue(frame["done"])
        self.assertTrue(frame["alreadyInstalled"])
        self.assertEqual(frame["binaryPath"], "/usr/local/bin/ollama")

    def test_the_build_is_unpacked_into_our_own_folder(self):
        original = sys.platform
        sys.platform = "darwin"
        try:
            ollama_cli._binary = lambda: None
            ollama_cli._artifact_url = lambda: self._archive(
                ["Ollama.app/Contents/Resources/ollama", "Ollama.app/Contents/Info.plist"]
            )
            seen = frames(ollama_cli.install)

            terminal = seen[-1]
            self.assertTrue(terminal["done"], terminal)
            binary = Path(terminal["binaryPath"])
            self.assertEqual(binary, Path(self.home) / "Ollama.app/Contents/Resources/ollama")
            self.assertTrue(binary.is_file())
            self.assertTrue(os.access(binary, os.X_OK), "the engine must be executable")
            # Progress has to be reported, not just the finished state.
            self.assertTrue(any("percent" in frame for frame in seen))
        finally:
            sys.platform = original

    def test_a_broken_download_leaves_nothing_that_looks_installed(self):
        original = sys.platform
        sys.platform = "darwin"
        try:
            ollama_cli._binary = lambda: None
            # A zip without the engine in it: unpack succeeds, the result is useless.
            ollama_cli._artifact_url = lambda: self._archive(["Ollama.app/README.txt"])

            terminal = frames(ollama_cli.install)[-1]
            self.assertTrue(terminal["done"])
            self.assertIn("error", terminal)
            self.assertFalse((Path(self.home) / "Ollama.app/Contents/Resources/ollama").exists())
            # And the app is not left claiming an engine it does not have.
            self.assertIsNone(ollama_cli._installed_binary())
        finally:
            sys.platform = original


if __name__ == "__main__":
    unittest.main()
