"""ACSA Skill Loader & Catalog Management.

Supports 3-tier skill discovery:
1. Built-in Skills: `core-engine/skills/*.md`
2. Project-Specific Skills: `<project_root>/.acsa/skills/*.md`
3. Global User Skills: `~/.acsa/skills/*.md`

Implements progressive disclosure:
- Compact catalog in the system prompt for token-efficient awareness.
- Full instruction injection when a slash command or trigger intent is matched.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

# One shared setup: the same JSON line to stdout and to a rotating file in the
# data directory, with the component taken from the logger name rather than
# written into a format string per module. See core-engine/log_setup.py.
from log_setup import configure

logger = configure("acsa.skills")


@dataclass
class Skill:
    name: str
    description: str
    triggers: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    source: str = "builtin"  # "builtin" | "project" | "user"
    path: str = ""
    body: str = ""
    raw: str = ""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "triggers": self.triggers,
            "tools": self.tools,
            "source": self.source,
            "path": self.path,
            "body": self.body,
        }


def _parse_frontmatter_and_body(content: str, fallback_name: str) -> tuple[dict, str]:
    """Parse YAML-style frontmatter without third-party dependencies."""
    metadata = {}
    body = content

    fm_match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
    if fm_match:
        fm_raw, body = fm_match.groups()
        for line in fm_raw.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                key, val = line.split(":", 1)
                key = key.strip().lower()
                val = val.strip()
                if val.startswith("[") and val.endswith("]"):
                    items = [x.strip(" '\"") for x in val[1:-1].split(",") if x.strip()]
                    metadata[key] = items
                else:
                    metadata[key] = val.strip("'\"")

    if "name" not in metadata:
        metadata["name"] = fallback_name

    if "description" not in metadata or not metadata["description"]:
        for line in body.splitlines():
            s = line.strip()
            if s and not s.startswith("#") and not s.startswith("---"):
                metadata["description"] = s
                break
        if "description" not in metadata:
            metadata["description"] = f"Custom skill: {fallback_name}"

    if "triggers" not in metadata:
        metadata["triggers"] = [f"/{fallback_name}", fallback_name]
    elif isinstance(metadata["triggers"], str):
        metadata["triggers"] = [t.strip() for t in metadata["triggers"].split(",")]

    if "tools" not in metadata:
        metadata["tools"] = []
    elif isinstance(metadata["tools"], str):
        metadata["tools"] = [t.strip() for t in metadata["tools"].split(",")]

    return metadata, body.strip()


def get_skill_directories(project_root: Optional[str] = None) -> list[tuple[str, Path]]:
    """Return ordered list of (tier_name, directory_path) to scan."""
    dirs: list[tuple[str, Path]] = []

    # 1. Project-level (.acsa/skills) takes highest precedence
    if project_root:
        proj_dir = Path(project_root).resolve() / ".acsa" / "skills"
        dirs.append(("project", proj_dir))

    # 2. User-level (~/.acsa/skills)
    user_dir = Path.home() / ".acsa" / "skills"
    dirs.append(("user", user_dir))

    # 3. Built-in (core-engine/skills)
    builtin_dir = Path(__file__).resolve().parent
    dirs.append(("builtin", builtin_dir))

    return dirs


def list_skills(project_root: Optional[str] = None) -> list[Skill]:
    """Discover all available skills across project, user, and built-in tiers."""
    skills_map: dict[str, Skill] = {}

    for source_tier, directory in get_skill_directories(project_root):
        if not directory.exists() or not directory.is_dir():
            continue

        for file_path in directory.glob("*.md"):
            fallback_name = file_path.stem
            try:
                content = file_path.read_text(encoding="utf-8", errors="replace")
                meta, body = _parse_frontmatter_and_body(content, fallback_name)
                name = meta["name"]

                # Higher precedence tiers (project > user > builtin) win
                if name not in skills_map:
                    skills_map[name] = Skill(
                        name=name,
                        description=meta["description"],
                        triggers=meta.get("triggers", []),
                        tools=meta.get("tools", []),
                        source=source_tier,
                        path=str(file_path),
                        body=body,
                        raw=content,
                    )
            except Exception as exc:
                logger.warning("Failed to load skill file %s: %s", file_path, exc)

    return list(skills_map.values())


def load_skill(name: str, project_root: Optional[str] = None) -> Optional[Skill]:
    """Retrieve a single skill by name."""
    clean_name = name.lstrip("/").lower()
    for skill in list_skills(project_root):
        if skill.name.lower() == clean_name:
            return skill
    return None


def match_skills_for_prompt(prompt: str, project_root: Optional[str] = None) -> list[Skill]:
    """Match skills triggered explicitly (e.g. /plan) or via keyword triggers."""
    skills = list_skills(project_root)
    matched: list[Skill] = []
    prompt_lower = prompt.lower()
    tokens = set(re.findall(r"/[a-z0-9_-]+|[a-z0-9_-]+", prompt_lower))

    for skill in skills:
        hit = False
        for trigger in skill.triggers:
            trig_lower = trigger.lower()
            if trig_lower.startswith("/") and trig_lower in tokens:
                matched.append(skill)
                hit = True
                break
            elif len(trig_lower) > 3 and re.search(rf"(?<![a-z0-9_-]){re.escape(trig_lower)}(?![a-z0-9_-])", prompt_lower):
                matched.append(skill)
                hit = True
                break

        if not hit and skill.name.lower() in tokens:
            matched.append(skill)

    return matched


def get_skill_catalog_prompt(project_root: Optional[str] = None) -> str:
    """Format a token-efficient summary catalog of all available skills for the agent."""
    skills = list_skills(project_root)
    if not skills:
        return ""

    lines = ["## Available Skill Catalog:"]
    for s in skills:
        trig_str = f" [triggers: {', '.join(s.triggers[:3])}]" if s.triggers else ""
        lines.append(f"- **{s.name}** ({s.source}): {s.description}{trig_str}")
    return "\n".join(lines)


def import_skill(
    name: str,
    content: str,
    scope: str = "project",
    project_root: Optional[str] = None,
    description: str = "",
) -> Skill:
    """Save a user or project imported skill markdown file."""
    clean_name = re.sub(r"[^a-zA-Z0-9_-]", "-", name).strip("-").lower()
    if not clean_name:
        raise ValueError("Invalid skill name")

    if scope not in {"project", "user"}:
        raise ValueError(f"Unsupported skill scope: {scope}. Use 'project' or 'user'.")
    if scope == "project":
        if not project_root:
            raise ValueError("project_root is required for project-scoped skill")
        target_dir = Path(project_root).resolve() / ".acsa" / "skills"
    else:
        target_dir = Path.home() / ".acsa" / "skills"

    target_dir.mkdir(parents=True, exist_ok=True)
    target_file = target_dir / f"{clean_name}.md"

    if not content.startswith("---"):
        # The caller's description if it has one. A marketplace entry knows what it
        # is for, and the runtime shows the description to the model to decide
        # whether to read the skill at all — a placeholder there makes every
        # installed skill look equally vague.
        summary = (description or "").strip() or f"Imported skill {clean_name}"
        header = (
            f"---\n"
            f"name: {clean_name}\n"
            f"description: {summary}\n"
            f"triggers: [\"/{clean_name}\", \"{clean_name}\"]\n"
            f"---\n\n"
        )
        content = header + content

    target_file.write_text(content, encoding="utf-8")
    meta, body = _parse_frontmatter_and_body(content, clean_name)

    return Skill(
        name=meta["name"],
        description=meta["description"],
        triggers=meta.get("triggers", []),
        tools=meta.get("tools", []),
        source=scope,
        path=str(target_file),
        body=body,
        raw=content,
    )
