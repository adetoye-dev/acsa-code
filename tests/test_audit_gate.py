"""Guards on the dependency-advisory gate's own decisions.

`scripts/audit_gate.mjs` replaces `npm audit --audit-level=high` with the same
level plus a short list of advisories that are *carried* on purpose. That list is
the whole risk: too strict and the gate has no fix that satisfies it, which is how
the old one ended up red on every push; too loose and it stops gating.

The script takes `--report`, so the decisions are checked against fixtures here
rather than against whatever the registry says on the day — a test that needed the
live feed would pass for the wrong reason the moment the feed changed.

What is pinned:

* a high advisory that is not carried fails, and names itself;
* the carried advisory passes;
* a carried advisory that is no longer reported fails, so the list cannot rot;
* the gate is actually wired into the workflow and the scripts.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GATE = ROOT / "scripts" / "audit_gate.mjs"

# The one advisory the gate carries, and the reason it exists at all. Duplicated
# from the script on purpose: if the script's list changes, the "passes" test
# below stops finding it, which is the reminder to change the fixtures with it.
CARRIED_URL = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm"
UNCARRIED_URL = "https://github.com/advisories/GHSA-0000-0000-0000"


def _advisory(pkg: str, severity: str, url: str) -> dict:
    return {
        "source": 1,
        "name": pkg,
        "dependency": pkg,
        "title": f"{pkg} has a problem",
        "url": url,
        "severity": severity,
        "range": "<9.9.9",
    }


def _report(*advisories: tuple[str, str, str]) -> dict:
    """A minimal `npm audit --json` v2 report carrying the given advisories."""
    vulnerabilities = {}
    for pkg, severity, url in advisories:
        vulnerabilities[pkg] = {
            "name": pkg,
            "severity": severity,
            "via": [_advisory(pkg, severity, url)],
            "effects": [],
            "range": "<9.9.9",
            "nodes": [f"node_modules/{pkg}"],
            "fixAvailable": False,
        }
    counts = {"info": 0, "low": 0, "moderate": 0, "high": 0, "critical": 0, "total": len(advisories)}
    for _, severity, _ in advisories:
        counts[severity] += 1
    return {
        "auditReportVersion": 2,
        "vulnerabilities": vulnerabilities,
        "metadata": {"vulnerabilities": counts},
    }


class AuditGateTests(unittest.TestCase):
    def setUp(self):
        self.node = shutil.which("node")
        if not self.node:
            self.skipTest("node is not installed, so the gate cannot run here")

    def _run(self, report: dict) -> subprocess.CompletedProcess:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(report, handle)
            path = Path(handle.name)
        try:
            return subprocess.run(
                [self.node, str(GATE), "--report", str(path)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=60,
            )
        finally:
            path.unlink(missing_ok=True)

    def test_an_uncarried_high_advisory_fails_and_names_itself(self):
        result = self._run(_report(("leftpad", "high", UNCARRIED_URL)))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(UNCARRIED_URL, result.stdout + result.stderr)
        self.assertIn("leftpad", result.stdout)

    def test_a_critical_advisory_is_gated_too(self):
        result = self._run(_report(("leftpad", "critical", UNCARRIED_URL)))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_a_moderate_advisory_is_reported_but_not_gated(self):
        # Below high is the floor the app already lives with, so it must not fail —
        # and the carried advisory is present here so the list is not "stale".
        result = self._run(
            _report(
                ("leftpad", "moderate", UNCARRIED_URL),
                ("braces", "high", CARRIED_URL),
            )
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("no unreviewed high or critical", result.stdout)

    def test_the_carried_advisory_passes(self):
        result = self._run(_report(("braces", "high", CARRIED_URL)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("carried", result.stdout)

    def test_a_carried_advisory_that_vanished_fails(self):
        # No advisories at all: the list has outlived its cause and must be pruned,
        # or the next real advisory under the same URL is silently allowed.
        result = self._run(_report())
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("no longer reported", result.stderr)
        self.assertIn(CARRIED_URL, result.stderr)

    def test_a_report_that_cannot_be_read_fails_closed(self):
        result = subprocess.run(
            [self.node, str(GATE), "--report", str(ROOT / "no" / "such" / "report.json")],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("could not read the report", result.stderr)

    def test_the_gate_is_wired_into_the_workflow(self):
        # The documented failure mode of the thing this replaced was that it ended up
        # unwired and ignored, so being wired is part of the contract.
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertIn("audit:check", package["scripts"])
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn("npm run audit:check", ci)
        self.assertNotIn("npm audit --audit-level=high", ci)


if __name__ == "__main__":
    unittest.main()
