"""The engine must be able to verify a provider certificate, whatever froze it.

`tls_context` exists because 0.2.6 shipped a sidecar frozen with a python.org
framework build whose `etc/openssl/cert.pem` did not exist — that file is created
by the installer's `Install Certificates.command`, and nothing in our build asks
for it. The frozen engine then had **zero** CA certificates and answered every
hosted-model call with:

    <urlopen error [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed:
     unable to get local issuer certificate (_ssl.c:1010)>

The app reported that as "Connection failed. Please check endpoint or API key."
against a key that worked everywhere else, and the same breakage covers chat,
inline edit and review — every path that speaks HTTPS. The tests below hold both
halves of the repair: the fallback that finds a trust store anyway, and the
`selftest` assertion that turns a capless freeze into a CI failure.
"""

import importlib
import os
import ssl
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core-engine"))

tls_context = importlib.import_module("tls_context")
acsa_engine = importlib.import_module("acsa_engine")


def _capless_context(*_args, **_kwargs) -> ssl.SSLContext:
    """What a framework Python without `cert.pem` hands back: a context with no roots."""
    return ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)


class TlsContextTests(unittest.TestCase):
    def setUp(self):
        tls_context.reset_cache()
        self._real_default = ssl.create_default_context
        self._real_candidates = tls_context._candidates

    def tearDown(self):
        ssl.create_default_context = self._real_default
        tls_context._candidates = self._real_candidates
        tls_context.reset_cache()

    def test_this_environment_can_verify_something(self):
        """The invariant, on whichever interpreter is running the suite.

        This is the assertion that fails for a capless freeze — it is the same
        measurement that exposed the 0.2.6 sidecar.
        """
        described = tls_context.describe()
        self.assertGreater(
            int(described["certificates"]),
            0,
            "no CA certificates are reachable, so every HTTPS call will fail with "
            f"CERTIFICATE_VERIFY_FAILED. {described}",
        )

    def test_falls_back_to_an_os_bundle(self):
        """With an empty interpreter store, a real on-disk bundle is loaded."""
        bundle = next((p for p in tls_context.OS_BUNDLES if os.path.isfile(p)), None)
        if bundle is None:
            self.skipTest("this machine keeps no OS CA bundle at the known paths")

        ssl.create_default_context = _capless_context
        tls_context._candidates = lambda: [bundle]

        described = tls_context.describe()
        self.assertGreater(int(described["certificates"]), 0)
        self.assertEqual(described["source"], bundle)

    def test_no_bundle_anywhere_is_reported_not_raised(self):
        """Nothing to load is a fact to report, not a crash at import time."""
        ssl.create_default_context = _capless_context
        tls_context._candidates = lambda: ["/nonexistent/ca-bundle.pem"]

        described = tls_context.describe()
        self.assertEqual(described["certificates"], 0)
        self.assertEqual(described["source"], "none")

    def test_selftest_fails_a_capless_freeze(self):
        """The CI gate itself, falsified: no roots must not report `ok`."""
        ssl.create_default_context = _capless_context
        tls_context._candidates = lambda: ["/nonexistent/ca-bundle.pem"]
        tls_context.reset_cache()

        tls, failures = acsa_engine._selftest_report()
        self.assertEqual(tls["certificates"], 0)
        self.assertIn("tls", failures)
        self.assertIn("CERTIFICATE_VERIFY_FAILED", failures["tls"])

    def test_selftest_passes_when_roots_are_reachable(self):
        """And the gate is not simply always-red — the same call agrees when it can."""
        _tls, failures = acsa_engine._selftest_report()
        self.assertNotIn("tls", failures)


if __name__ == "__main__":
    unittest.main()
