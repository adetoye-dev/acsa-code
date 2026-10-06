"""Every field the UI reads has to exist on the wire.

Two languages meet at the IPC boundary and neither one checks the other, so a
field name is a promise made in two places. One of them drifted:
`RunningProcessItem` serialised `cpu_percent` while the page read `cpuPercent`,
the value arrived `undefined`, and the process table rendered `%` and `MB` with no
number in front of them — the reported symptom.

The storage structs had drifted the same way and were *hidden* rather than
visible, because the page falls back to a previous value when a field is missing
and the previous value was a hardcoded example. A blank cell is a bug report; an
invented number that looks real is worse.

The comparison is two rules, and both come from the report:

  * A field the frontend declares **without** `?` is a field it believes is always
    there. The shell has to send it, or the UI reads `undefined` — which is how a
    table came to render `%` with no number in front of it.
  * A field the frontend declares **with** `?` is the type saying it may be absent,
    and every read of one has a fallback. Those are the shell's business to fill in
    or not; requiring them would be requiring a design, not a contract.

A field the shell sends and the frontend ignores is only payload.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAIN_RS = ROOT / ".tauri" / "src" / "main.rs"

# (Rust struct, TypeScript file, TypeScript interface)
PAIRS = [
    ("FileNode", "src/components/FileTree.tsx", "FileNode"),
    ("SystemMetrics", "src/types/telemetry.ts", "SystemMetrics"),
    ("PipelineOutputLine", "src/types/telemetry.ts", "PipelineOutputLine"),
    ("StorageMetrics", "src/types/workbench.ts", "StorageMetrics"),
    ("StorageCategory", "src/types/workbench.ts", "StorageCategory"),
    ("RunningProcessItem", "src/types/workbench.ts", "RunningProcessItem"),
]


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.capitalize() for part in rest)


def rust_fields(source: str, struct: str) -> tuple[set[str], bool]:
    """The struct's field names, and whether serde renames them to camelCase."""
    match = re.search(rf"^(?:#\[[^\]]*\]\s*\n)*pub struct {struct} \{{$", source, re.MULTILINE)
    assert match, f"no `pub struct {struct}` in main.rs"
    start = match.end()
    end = source.index("\n}", start)
    body = source[start:end]

    # The attribute sits between the derive and the `pub struct` line, so it is
    # inside the match, not before it.
    renamed = bool(re.search(r'#\[serde\(rename_all = "camelCase"\)\]', match.group(0)))

    fields = set(re.findall(r"^\s*pub (\w+):", body, re.MULTILINE))
    assert fields, f"{struct} parsed with no fields"
    return fields, renamed


def typescript_fields(path: Path, interface: str) -> tuple[set[str], set[str]]:
    """The required and optional field names the frontend declares."""
    source = path.read_text(encoding="utf-8")
    match = re.search(rf"^export interface {interface} \{{$", source, re.MULTILINE)
    assert match, f"no `export interface {interface}` in {path}"
    end = source.index("\n}", match.end())
    body = source[match.end() : end]
    required = set(re.findall(r"^\s*(\w+):", body, re.MULTILINE))
    optional = set(re.findall(r"^\s*(\w+)\?:", body, re.MULTILINE))
    assert required or optional, f"{interface} parsed with no fields"
    return required, optional


class WireContractTests(unittest.TestCase):
    def test_every_field_the_ui_reads_is_one_the_shell_sends(self):
        source = MAIN_RS.read_text(encoding="utf-8")
        problems = []
        for struct, relative, interface in PAIRS:
            sent, renamed = rust_fields(source, struct)
            if renamed:
                sent = {camel(name) for name in sent}
            required, _optional = typescript_fields(ROOT / relative, interface)
            missing = sorted(required - sent)
            if missing:
                problems.append(f"{interface} requires {missing}; {struct} sends {sorted(sent)}")
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_parser_actually_finds_things(self):
        # Guards the check above from passing because both sides parsed to nothing.
        source = MAIN_RS.read_text(encoding="utf-8")
        fields, _ = rust_fields(source, "RunningProcessItem")
        self.assertIn("pid", fields)
        self.assertIn("cpu_percent", fields)
        required, _ = typescript_fields(ROOT / "src/types/workbench.ts", "RunningProcessItem")
        self.assertIn("cpuPercent", required)

    def test_camel_matches_serde(self):
        self.assertEqual(camel("cpu_percent"), "cpuPercent")
        self.assertEqual(camel("cache_reclaimable_mb"), "cacheReclaimableMb")
        self.assertEqual(camel("pid"), "pid")


if __name__ == "__main__":
    unittest.main()
