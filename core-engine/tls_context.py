"""tls_context.py — an HTTPS context the engine can actually verify with.

Why this exists: the engine ships frozen (PyInstaller, `scripts/build_engine_sidecar.sh`),
and the interpreter that froze it decides whether TLS works at all. A python.org
"framework" build whose `etc/openssl/cert.pem` was never created — that file appears
only after the `Install Certificates.command` the installer asks you to run — reports
**zero** CA certificates, and PyInstaller adds none of its own. Measured on the machine
that built 0.2.6: `/Library/Frameworks/Python.framework/Versions/3.13/etc/openssl/` was
empty and that interpreter answered `0 CA certs`, while `/usr/bin/python3` answered 128.

The symptom is that every HTTPS call the app makes fails on a machine where the browser
and every other tool is fine:

    <urlopen error [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed:
     unable to get local issuer certificate (_ssl.c:1010)>

That is not only the provider test. The same code path serves chat, inline edit and
review, so a build made with a capless interpreter cannot reach any hosted model —
which is exactly what 0.2.6 did, and why "Fetch Latest Models" said only "Connection
failed. Please check endpoint or API key." while the key was valid and worked from the
source tree.

So: keep whatever the interpreter has when it has something, and otherwise load a bundle
that travels with the app (`certifi`, when the freeze collected it) or one the operating
system already keeps on disk. Nothing here implements crypto or pins a fingerprint —
these are the same roots curl, the browser and pip trust.

`acsa_engine.py selftest` asserts this context has at least one CA, so a freeze made
with a capless interpreter fails the sidecar job in CI instead of failing on a user's
machine.
"""

from __future__ import annotations

import os
import ssl
from typing import Optional

# Where each family keeps its trust store. macOS ships `/etc/ssl/cert.pem` as a real
# file (a copy of the system roots, refreshed by the OS), which is why it leads.
OS_BUNDLES = (
    "/etc/ssl/cert.pem",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
)

_context: Optional[ssl.SSLContext] = None
_source: Optional[str] = None


def _certifi_bundle() -> Optional[str]:
    """`certifi`'s bundle, when the freeze collected it. Absent in a source checkout."""
    try:
        import certifi  # noqa: PLC0415 - optional, and only the frozen build ships it
    except ImportError:
        return None
    try:
        path = certifi.where()
    except Exception:  # noqa: BLE001 - a broken certifi is not worth a crash
        return None
    return path if os.path.isfile(path) else None


def _candidates() -> list[str]:
    """Bundle paths to try, best first. Split out so tests can replace it."""
    bundle = _certifi_bundle()
    return [bundle, *OS_BUNDLES] if bundle else list(OS_BUNDLES)


def _ca_count(context: ssl.SSLContext) -> int:
    return int(context.cert_store_stats().get("x509_ca", 0))


def https_context() -> ssl.SSLContext:
    """The context every outbound HTTPS call uses. Cached: loading is not free."""
    global _context, _source
    if _context is not None:
        return _context

    context = ssl.create_default_context()
    source: Optional[str] = "interpreter" if _ca_count(context) else None

    if source is None:
        for candidate in _candidates():
            if not candidate or not os.path.isfile(candidate):
                continue
            try:
                context.load_verify_locations(cafile=candidate)
            except (OSError, ssl.SSLError):
                continue
            if _ca_count(context):
                source = candidate
                break

    _context, _source = context, source
    return context


def describe() -> dict[str, object]:
    """What the engine can verify with, for the self-test and for support logs."""
    context = https_context()
    return {
        "certificates": _ca_count(context),
        "source": _source or "none",
        "paths": {
            "openssl": list(ssl.get_default_verify_paths()),
            "env": os.environ.get("SSL_CERT_FILE") or None,
        },
    }


def reset_cache() -> None:
    """Drop the cached context. For tests; production loads it once per process."""
    global _context, _source
    _context, _source = None, None
